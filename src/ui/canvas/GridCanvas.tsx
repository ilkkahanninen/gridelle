import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { containerOf, groupParent, groupsOf, isVoiceNotes, placement, VOICE } from "../../core/model/area";
import * as ops from "../../core/model/ops";
import type { Area, Cable, ModuleId, PortRef, UnisonGroup } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { visibleDef } from "../../core/modules/shape";
import { useEditor } from "../../state/store";
import { GROUP_PLACING, gridPointer, useUi } from "../../state/ui";
import { CableLayer } from "./CableLayer";
import {
  CELL,
  MAX_ZOOM,
  MIN_ZOOM,
  cellCentredOn,
  portPosition,
  screenToWorld,
  tileRect,
  type Point,
} from "./geometry";
import { ModuleTile } from "./ModuleTile";
import { GroupArea, gripped, notesPortPoint, VoiceArea, type AreaGrip } from "./VoiceArea";
import "./canvas.css";

interface TileDrag {
  start: Point;
  /** Whole cells moved so far. */
  delta: ops.Cell;
  moved: boolean;
}

/** A container (the voice area, or a unison group by its id) moved by its header or resized by an edge: where it would go. */
interface AreaDrag {
  key: string;
  grip: AreaGrip;
  area: Area;
}

interface Marquee {
  start: Point;
  current: Point;
  additive: boolean;
}

/** Pointer travel, in screen pixels, before a press counts as a drag. */
const DRAG_THRESHOLD = 4;

/** Where a module dragged in from the browser would land, and the port it would be cabled to. */
interface Ghost {
  cell: ops.Cell;
  drop: { target: ops.PortTarget; plan: ops.PortDrop } | null;
}

function portElementUnder(clientX: number, clientY: number): HTMLElement | null {
  for (const hit of document.elementsFromPoint(clientX, clientY)) {
    const el = hit.closest<HTMLElement>("[data-port-id]");
    if (el) return el;
  }
  return null;
}

const portOf = (el: HTMLElement): ops.PortTarget => ({
  module: el.dataset.portModule!,
  port: el.dataset.portId!,
  side: el.dataset.portSide as "in" | "out",
});

/** The port at a screen position, even when a cable is drawn over it. */
export function portUnder(clientX: number, clientY: number): ops.PortTarget | null {
  const el = portElementUnder(clientX, clientY);
  return el ? portOf(el) : null;
}

export function GridCanvas() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const view = useUi((s) => s.view);
  const placing = useUi((s) => s.placing);
  const cableDrag = useUi((s) => s.cableDrag);
  const assigning = useUi((s) => s.assigning);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [tileDrag, setTileDrag] = useState<TileDrag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);
  const [panning, setPanning] = useState(false);
  const [areaDrag, setAreaDrag] = useState<AreaDrag | null>(null);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current!.getBoundingClientRect();
    return screenToWorld(useUi.getState().view, rect, clientX, clientY);
  }, []);

  // Track the viewport size so other parts of the UI can find the centre of the view.
  useEffect(() => {
    const el = viewportRef.current!;
    const observer = new ResizeObserver(() =>
      useUi.setState({ viewport: { width: el.clientWidth, height: el.clientHeight } }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Wheel pans; with Ctrl/Cmd (or a trackpad pinch) it zooms around the cursor.
  useEffect(() => {
    const el = viewportRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view, setView } = useUi.getState();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * Math.exp(-e.deltaY * 0.01)));
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const scale = zoom / view.zoom;
        setView({ zoom, panX: x - (x - view.panX) * scale, panY: y - (y - view.panY) * scale });
      } else {
        setView({ ...view, panX: view.panX - e.deltaX, panY: view.panY - e.deltaY });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const connectedByModule = useMemo(() => {
    const map = new Map<ModuleId, Set<string>>();
    const add = (id: ModuleId, key: string) => map.set(id, (map.get(id) ?? new Set()).add(key));
    for (const cable of doc.cables) {
      add(cable.from.module, `out:${cable.from.port}`);
      add(cable.to.module, `in:${cable.to.port}`);
    }
    return map;
  }, [doc.cables]);
  const NONE = useMemo(() => new Set<string>(), []);

  /** Run `onMove` / `onEnd` for the rest of the current pointer gesture. */
  const track = (onMove: (e: PointerEvent) => void, onEnd: (e: PointerEvent, cancelled: boolean) => void) => {
    const move = (e: PointerEvent) => onMove(e);
    const finish = (cancelled: boolean) => (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", cancel);
      onEnd(e as PointerEvent, cancelled);
    };
    const up = finish(false);
    const cancel = finish(true);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", cancel);
  };

  const onTilePointerDown = useCallback((e: React.PointerEvent, id: ModuleId) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const editor = useEditor.getState();
    if (e.shiftKey) {
      editor.toggleSelected(id);
      return;
    }
    if (!editor.selection.has(id)) editor.select([id]);

    const start = { x: e.clientX, y: e.clientY };
    let drag: TileDrag = { start, delta: { x: 0, y: 0 }, moved: false };
    track(
      (move) => {
        const dx = move.clientX - start.x;
        const dy = move.clientY - start.y;
        if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        const zoom = useUi.getState().view.zoom;
        drag = {
          start,
          moved: true,
          delta: { x: Math.round(dx / zoom / CELL), y: Math.round(dy / zoom / CELL) },
        };
        setTileDrag(drag);
      },
      (_up, cancelled) => {
        setTileDrag(null);
        if (cancelled || !drag.moved) return;
        const { selection, apply } = useEditor.getState();
        apply((d) => ops.moveModules(d, selection, drag.delta));
      },
    );
  }, []);

  // The header of a container moves it with what is in it; its edges resize it.
  const onAreaGrip = useCallback((e: React.PointerEvent, grip: AreaGrip, key: string = ops.VOICE_AREA) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY };
    const origin = ops.containerRect(useEditor.getState().doc, key);
    if (!origin) return;
    let drag: AreaDrag | null = null;
    track(
      (move) => {
        const dx = move.clientX - start.x;
        const dy = move.clientY - start.y;
        if (!drag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        const zoom = useUi.getState().view.zoom;
        drag = { key, grip, area: gripped(origin, grip, { x: Math.round(dx / zoom / CELL), y: Math.round(dy / zoom / CELL) }) };
        setAreaDrag(drag);
      },
      (_up, cancelled) => {
        setAreaDrag(null);
        if (cancelled) return;
        // A click on the header, with no drag, shows the container's settings in the settings
        // pane: the voices' with nothing selected, a group's with it selected.
        if (!drag) {
          if (grip !== "move") return;
          if (key === ops.VOICE_AREA) useEditor.getState().clearSelection();
          else useEditor.getState().select([key]);
          return;
        }
        const { area } = drag;
        useEditor.getState().apply((d) => {
          const from = ops.containerRect(d, key);
          if (!from) return d;
          return grip === "move" ? ops.moveContainer(d, key, { x: area.x - from.x, y: area.y - from.y }) : ops.resizeContainer(d, key, area);
        });
      },
    );
  }, []);

  const onPortPointerDown = useCallback(
    (e: React.PointerEvent, module: ModuleId, port: string, side: "in" | "out") => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      const { doc: current, apply } = useEditor.getState();
      // Grabbing a patched input picks the cable up by that end.
      const detached =
        side === "in" ? (current.cables.find((c) => c.to.module === module && c.to.port === port) ?? null) : null;
      const anchor: PortRef = detached ? detached.from : { module, port };
      const anchorSide = detached ? "out" : side;
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;

      track(
        (move) => {
          if (!moved && Math.hypot(move.clientX - start.x, move.clientY - start.y) < DRAG_THRESHOLD) return;
          moved = true;
          useUi.setState({
            cableDrag: { anchor, anchorSide, cursor: toWorld(move.clientX, move.clientY), detached },
          });
        },
        (up, cancelled) => {
          useUi.setState({ cableDrag: null });
          if (cancelled) return;
          if (!moved) {
            // A click, not a drag: an input that can follow the played note is switched over.
            if (side === "in") apply((d) => ops.togglePrecord(d, module, port));
            return;
          }
          const target = portUnder(up.clientX, up.clientY);
          const valid = target && target.side !== anchorSide;
          apply((d) => {
            const base = detached ? ops.disconnect(d, detached) : d;
            if (!valid) return base;
            const from = anchorSide === "out" ? anchor : { module: target.module, port: target.port };
            const to = anchorSide === "out" ? { module: target.module, port: target.port } : anchor;
            const patched = ops.connect(base, from, to);
            // A refused connection (feedback loop) puts a picked-up cable back.
            return patched === base && detached ? d : patched;
          });
        },
      );
    },
    [toWorld],
  );

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains("world")) return;
    const editor = useEditor.getState();

    // Middle-button drag or Alt + drag pans the view.
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      const origin = { ...useUi.getState().view };
      const start = { x: e.clientX, y: e.clientY };
      setPanning(true);
      track(
        (move) =>
          useUi.getState().setView({
            ...origin,
            panX: origin.panX + move.clientX - start.x,
            panY: origin.panY + move.clientY - start.y,
          }),
        () => setPanning(false),
      );
      return;
    }
    if (e.button !== 0) return;

    const start = toWorld(e.clientX, e.clientY);
    const additive = e.shiftKey;
    const before = new Set(editor.selection);
    let moved = false;
    track(
      (move) => {
        const current = toWorld(move.clientX, move.clientY);
        if (!moved && Math.hypot(current.x - start.x, current.y - start.y) < DRAG_THRESHOLD) return;
        moved = true;
        setMarquee({ start, current, additive });
        const left = Math.min(start.x, current.x);
        const right = Math.max(start.x, current.x);
        const top = Math.min(start.y, current.y);
        const bottom = Math.max(start.y, current.y);
        const now = useEditor.getState().doc;
        const hit = now.modules.filter((m) => {
          const def = visibleDef(now, m);
          if (!def) return false;
          const r = tileRect(m, def);
          return r.left < right && r.left + r.width > left && r.top < bottom && r.top + r.height > top;
        });
        const groups = groupsOf(now).filter(
          (g) =>
            g.area.x * CELL >= left && (g.area.x + g.area.width) * CELL <= right && g.area.y * CELL >= top && (g.area.y + g.area.height) * CELL <= bottom,
        );
        useEditor.getState().select([...(additive ? before : []), ...hit.map((m) => m.id), ...groups.map((g) => g.id)]);
      },
      () => {
        setMarquee(null);
        if (!moved && !additive) useEditor.getState().clearSelection();
      },
    );
  };

  // A module dragged in from the module browser follows the pointer as a ghost until dropped.
  useEffect(() => {
    if (!placing) {
      setGhost(null);
      return;
    }
    const overCanvas = (e: PointerEvent) => {
      const rect = viewportRef.current!.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    };
    // A unison group lands, empty, on the nearest cells it fits on; it is then selected.
    if (placing === GROUP_PLACING) {
      const size = { width: ops.NEW_GROUP.width, height: ops.NEW_GROUP.height, inputs: [], outputs: [] };
      const landing = (x: number, y: number) => ops.findGroupCell(useEditor.getState().doc, cellCentredOn(toWorld(x, y), size));
      const put = (cell: ops.Cell) => {
        const editor = useEditor.getState();
        let id: string | null = null;
        editor.apply((doc) => {
          const added = ops.addGroup(doc, cell);
          id = added.id;
          return added.doc;
        });
        if (id) editor.select([id]);
      };
      const move = (e: PointerEvent) => setGhost(overCanvas(e) ? { cell: landing(e.clientX, e.clientY), drop: null } : null);
      const up = (e: PointerEvent) => {
        useUi.setState({ placing: null });
        if (overCanvas(e)) put(landing(e.clientX, e.clientY));
        else if ((e.target as HTMLElement | null)?.closest(".palette-modules")) {
          const { viewport } = useUi.getState();
          const rect = viewportRef.current!.getBoundingClientRect();
          put(landing(rect.left + viewport.width / 2, rect.top + viewport.height / 2));
        }
      };
      const key = (e: KeyboardEvent) => e.key === "Escape" && useUi.setState({ placing: null });
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("keydown", key);
      return () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("keydown", key);
      };
    }
    const def = getModuleDef(placing);
    if (!def) return;
    // The ghost shows where the module will land: the cell under the pointer, or the nearest free one.
    const landing = (e: PointerEvent) =>
      ops.findFreeCell(useEditor.getState().doc, placing, cellCentredOn(toWorld(e.clientX, e.clientY), def));
    // The port being aimed at stays the target for as long as the pointer is where the port
    // was found: the preview may slide that port's tile aside to show the room being made.
    let held: { target: ops.PortTarget; rect: DOMRect } | null = null;
    const portAimedAt = (e: PointerEvent) => {
      const within =
        held &&
        e.clientX >= held.rect.left &&
        e.clientX <= held.rect.right &&
        e.clientY >= held.rect.top &&
        e.clientY <= held.rect.bottom;
      if (!within) {
        const el = portElementUnder(e.clientX, e.clientY);
        held = el && { target: portOf(el), rect: el.getBoundingClientRect() };
      }
      return held?.target ?? null;
    };
    // Held over a port of another module, it is cabled to that port and lands beside it.
    const aim = (e: PointerEvent): Ghost => {
      const target = portAimedAt(e);
      const plan = target && ops.planPortDrop(useEditor.getState().doc, placing, target);
      return target && plan ? { cell: plan.at, drop: { target, plan } } : { cell: landing(e), drop: null };
    };
    const move = (e: PointerEvent) => setGhost(overCanvas(e) ? aim(e) : null);
    const up = (e: PointerEvent) => {
      useUi.setState({ placing: null });
      const editor = useEditor.getState();
      if (overCanvas(e)) {
        const { cell, drop } = aim(e);
        if (drop) editor.addModuleAtPort(placing, drop.target);
        else editor.addModule(placing, cell);
      } else if ((e.target as HTMLElement | null)?.closest(".palette-modules")) {
        // Clicked in the module browser without dragging out: put it near the middle of the view.
        const { view, viewport } = useUi.getState();
        const centre = {
          x: (viewport.width / 2 - view.panX) / view.zoom,
          y: (viewport.height / 2 - view.panY) / view.zoom,
        };
        editor.addModule(placing, ops.findFreeCell(editor.doc, placing, cellCentredOn(centre, def)));
      }
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && useUi.setState({ placing: null });
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("keydown", key);
    };
  }, [placing, toWorld]);

  const dragBlocked = !!tileDrag?.moved && !ops.canMove(doc, selection, tileDrag.delta);
  const dragOffset = tileDrag?.moved ? { x: tileDrag.delta.x * CELL, y: tileDrag.delta.y * CELL } : null;

  // The modules in the voice area: they run in every voice, and go with the area when it moves.
  const inVoices = useMemo(
    () => new Set(doc.modules.filter((m) => placement(doc, m) === "inside").map((m) => m.id)),
    [doc],
  );
  // What moving or resizing a container to where it is dragged would do: it takes what is in
  // it along, and a resize pushes what is beside it. `null` while nothing is dragged, the
  // document itself when the drag would be refused.
  const dragFrom = areaDrag ? ops.containerRect(doc, areaDrag.key) : undefined;
  const areaPreview = useMemo(() => {
    if (!areaDrag || !dragFrom) return null;
    const { key, grip, area } = areaDrag;
    return grip === "move" ? ops.moveContainer(doc, key, { x: area.x - dragFrom.x, y: area.y - dragFrom.y }) : ops.resizeContainer(doc, key, area);
    // The drag is a new object on every pointer move; its parts say whether it changed.
  }, [doc, areaDrag?.key, areaDrag?.grip, areaDrag?.area.x, areaDrag?.area.y, areaDrag?.area.width, areaDrag?.area.height]);
  const areaBlocked =
    !!areaDrag && !!dragFrom && areaPreview === doc && (["x", "y", "width", "height"] as const).some((key) => areaDrag.area[key] !== dragFrom[key]);
  // A move that would be refused still shows what is in the container going with it, in red.
  const carried = useMemo(() => {
    if (!areaDrag || areaDrag.grip !== "move") return new Set<string>();
    const key = areaDrag.key;
    return new Set(
      doc.modules
        .filter((m) => (key === ops.VOICE_AREA ? placement(doc, m) === "inside" : containerOf(doc, m) === key))
        .map((m) => m.id),
    );
  }, [doc, areaDrag?.key, areaDrag?.grip]);
  const carry = areaBlocked && areaDrag?.grip === "move" && dragFrom ? { x: (areaDrag.area.x - dragFrom.x) * CELL, y: (areaDrag.area.y - dragFrom.y) * CELL } : null;
  /** How far a tile is drawn from where it is: dragged, carried by a container, or pushed aside by a drop or a container. */
  const offsetOf = (id: ModuleId): Point | null =>
    (selection.has(id) ? dragOffset : null) ?? (carry && carried.has(id) ? carry : null) ?? shifts.get(id) ?? null;
  // Where the containers are drawn: as the drag would leave them.
  const shown = areaPreview && areaPreview !== doc ? areaPreview : doc;
  const shownArea = areaDrag?.key === ops.VOICE_AREA ? areaDrag.area : shown.voiceArea;
  const groupShownAt = (group: UnisonGroup): Area => {
    if (areaDrag?.key === group.id) return areaDrag.area;
    // The voices moving where they may not go take their groups along all the same.
    if (carry && areaDrag?.key === ops.VOICE_AREA && groupParent(doc, group) === VOICE) {
      return { ...group.area, x: group.area.x + carry.x / CELL, y: group.area.y + carry.y / CELL };
    }
    return shown.groups?.find((g) => g.id === group.id)?.area ?? group.area;
  };

  const ghostDef = placing && placing !== GROUP_PLACING ? getModuleDef(placing) : undefined;
  const drop = (ghostDef && ghost?.drop) || null;

  // A drop that needs room, or a container resized onto tiles beside it, moves tiles aside.
  // Show them where they would go, in pixels from where they are.
  const pushOn = drop?.plan.push ? drop.target : null;
  const shifts = useMemo(() => {
    const moved = new Map<ModuleId, Point>();
    const after = (areaPreview !== doc ? areaPreview : null) ?? (placing && pushOn ? ops.addModuleAtPort(doc, placing, pushOn).doc : null);
    if (!after) return moved;
    for (const module of doc.modules) {
      const then = after.modules.find((m) => m.id === module.id);
      if (then && (then.x !== module.x || then.y !== module.y)) {
        moved.set(module.id, { x: (then.x - module.x) * CELL, y: (then.y - module.y) * CELL });
      }
    }
    return moved;
    // The target is a new object on every pointer move; its parts say whether it changed.
  }, [doc, areaPreview, placing, pushOn?.module, pushOn?.port, pushOn?.side]);

  /** Port position including the offset of tiles being dragged or pushed aside, so cables follow. */
  const portPoint = useCallback(
    (ref: PortRef, side: "in" | "out"): Point | null => {
      if (side === "in" && isVoiceNotes(ref)) return notesPortPoint(shownArea);
      const module = doc.modules.find((m) => m.id === ref.module);
      const def = module && visibleDef(doc, module);
      if (!module || !def) return null;
      const index = (side === "in" ? def.inputs : def.outputs).findIndex((p) => p.id === ref.port);
      if (index < 0) return null;
      const point = portPosition(module, def, side, index);
      const offset = offsetOf(module.id);
      return offset ? { x: point.x + offset.x, y: point.y + offset.y } : point;
    },
    [doc, selection, dragOffset?.x, dragOffset?.y, shifts, carried, carry?.x, carry?.y, shownArea],
  );

  const hintOf = useCallback(
    (cable: Cable) => {
      const module = doc.modules.find((m) => m.id === cable.from.module);
      return getModuleDef(module?.type ?? "")?.outputs.find((p) => p.id === cable.from.port)?.hint ?? "audio";
    },
    [doc.modules],
  );

  // The cables a drop on the port under the pointer would patch, between the ghost and the tiles.
  const preview = useMemo(() => {
    if (!ghost || !drop || !ghostDef) return [];
    const isNew = (ref: PortRef) => !doc.modules.some((m) => m.id === ref.module);
    const end = (ref: PortRef, side: "in" | "out") =>
      isNew(ref) ? portPosition(ghost.cell, ghostDef, side, 0) : portPoint(ref, side);
    return drop.plan.cables.flatMap((cable) => {
      const from = end(cable.from, "out");
      const to = end(cable.to, "in");
      const hint = isNew(cable.from) ? ghostDef.outputs[0].hint : hintOf(cable);
      return from && to ? [{ from, to, hint }] : [];
    });
  }, [ghost, drop, ghostDef, doc.modules, portPoint, hintOf]);

  // ...and the cables it would take out: an input holds one cable.
  const replaced = useMemo(
    () => (drop ? doc.cables.filter((c) => drop.plan.cables.some((p) => p.to.module === c.to.module && p.to.port === c.to.port)) : []),
    [drop, doc.cables],
  );

  const gridSize = CELL * view.zoom;
  const classes = ["canvas"];
  if (panning) classes.push("canvas-panning");
  if (cableDrag) classes.push(`canvas-cabling-${cableDrag.anchorSide}`);
  // A module in hand can be dropped on the ports it has something to cable to.
  if (ghostDef?.outputs.length) classes.push("canvas-plug-in");
  if (ghostDef?.inputs.length) classes.push("canvas-plug-out");
  // An Organelle knob is waiting for a setting: the tile knobs are there to be clicked, in its page's colour.
  if (assigning) classes.push("canvas-assigning", `page-color-${assigning.page}`);

  return (
    <div
      ref={viewportRef}
      className={classes.join(" ")}
      style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.panX}px ${view.panY}px` }}
      onPointerDown={onBackgroundPointerDown}
      onPointerMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        gridPointer.at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      }}
      onPointerLeave={() => (gridPointer.at = null)}
    >
      <div className="world" style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }}>
        {doc.voiceArea.width > 0 && doc.voiceArea.height > 0 && (
          <VoiceArea
            area={shownArea}
            blocked={areaBlocked && areaDrag?.key === ops.VOICE_AREA}
            notesCabled={doc.cables.some((c) => isVoiceNotes(c.to))}
            onGrip={onAreaGrip}
            onPortPointerDown={onPortPointerDown}
          />
        )}
        {groupsOf(doc).map((group) => (
          <GroupArea
            key={group.id}
            group={group}
            area={groupShownAt(group)}
            blocked={areaBlocked && areaDrag?.key === group.id}
            selected={selection.has(group.id)}
            onGrip={(e, grip) => onAreaGrip(e, grip, group.id)}
          />
        ))}
        {doc.modules.map((module) => {
          const def = visibleDef(doc, module);
          if (!def) return null;
          const selected = selection.has(module.id);
          return (
            <ModuleTile
              key={module.id}
              module={module}
              def={def}
              selected={selected}
              offset={offsetOf(module.id)}
              blocked={(selected && dragBlocked) || (areaBlocked && carried.has(module.id))}
              inVoices={inVoices.has(module.id)}
              connected={connectedByModule.get(module.id) ?? NONE}
              dropTarget={drop?.target.module === module.id ? `${drop.target.side}:${drop.target.port}` : null}
              onTilePointerDown={onTilePointerDown}
              onPortPointerDown={onPortPointerDown}
            />
          );
        })}

        <CableLayer
          cables={doc.cables}
          portPoint={portPoint}
          hintOf={hintOf}
          preview={preview}
          replaced={replaced}
          onPortPointerDown={onPortPointerDown}
        />

        {ghost && ghostDef && (
          <div className="tile-ghost" style={tileRect(ghost.cell, ghostDef)} />
        )}
        {ghost && placing === GROUP_PLACING && (
          <div
            className="tile-ghost group-ghost"
            style={{ left: ghost.cell.x * CELL, top: ghost.cell.y * CELL, width: ops.NEW_GROUP.width * CELL, height: ops.NEW_GROUP.height * CELL }}
          />
        )}
        {marquee && (
          <div
            className="marquee"
            style={{
              left: Math.min(marquee.start.x, marquee.current.x),
              top: Math.min(marquee.start.y, marquee.current.y),
              width: Math.abs(marquee.current.x - marquee.start.x),
              height: Math.abs(marquee.current.y - marquee.start.y),
            }}
          />
        )}
      </div>

      {doc.modules.length === 0 && (
        <p className="canvas-empty">Drag a module in from above to start a patch.</p>
      )}
    </div>
  );
}
