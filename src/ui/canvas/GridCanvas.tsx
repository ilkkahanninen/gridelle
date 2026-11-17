import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ops from "../../core/model/ops";
import type { Cable, ModuleId, PortRef } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { useEditor } from "../../state/store";
import { useUi } from "../../state/ui";
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
import "./canvas.css";

interface TileDrag {
  start: Point;
  /** Whole cells moved so far. */
  delta: ops.Cell;
  moved: boolean;
}

interface Marquee {
  start: Point;
  current: Point;
  additive: boolean;
}

/** Pointer travel, in screen pixels, before a press counts as a drag. */
const DRAG_THRESHOLD = 4;

/** The port at a screen position, even when a cable is drawn over it. */
export function portUnder(clientX: number, clientY: number): (PortRef & { side: "in" | "out" }) | null {
  for (const hit of document.elementsFromPoint(clientX, clientY)) {
    const el = hit.closest<HTMLElement>("[data-port-id]");
    if (el) {
      return {
        module: el.dataset.portModule!,
        port: el.dataset.portId!,
        side: el.dataset.portSide as "in" | "out",
      };
    }
  }
  return null;
}

export function GridCanvas() {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const view = useUi((s) => s.view);
  const placing = useUi((s) => s.placing);
  const cableDrag = useUi((s) => s.cableDrag);

  const viewportRef = useRef<HTMLDivElement>(null);
  const [tileDrag, setTileDrag] = useState<TileDrag | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [ghost, setGhost] = useState<ops.Cell | null>(null);
  const [panning, setPanning] = useState(false);

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
          if (cancelled || !moved) return;
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
        const hit = useEditor.getState().doc.modules.filter((m) => {
          const def = getModuleDef(m.type);
          if (!def) return false;
          const r = tileRect(m, def);
          return r.left < right && r.left + r.width > left && r.top < bottom && r.top + r.height > top;
        });
        useEditor.getState().select([...(additive ? before : []), ...hit.map((m) => m.id)]);
      },
      () => {
        setMarquee(null);
        if (!moved && !additive) useEditor.getState().clearSelection();
      },
    );
  };

  // A module dragged in from the palette follows the pointer as a ghost until dropped.
  useEffect(() => {
    if (!placing) {
      setGhost(null);
      return;
    }
    const def = getModuleDef(placing);
    if (!def) return;
    const overCanvas = (e: PointerEvent) => {
      const rect = viewportRef.current!.getBoundingClientRect();
      return e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    };
    // The ghost shows where the module will land: the cell under the pointer, or the nearest free one.
    const landing = (e: PointerEvent) =>
      ops.findFreeCell(useEditor.getState().doc, placing, cellCentredOn(toWorld(e.clientX, e.clientY), def));
    const move = (e: PointerEvent) => setGhost(overCanvas(e) ? landing(e) : null);
    const up = (e: PointerEvent) => {
      useUi.setState({ placing: null });
      const editor = useEditor.getState();
      if (overCanvas(e)) {
        editor.addModule(placing, landing(e));
      } else if ((e.target as HTMLElement | null)?.closest(".palette")) {
        // Clicked in the palette without dragging out: put it near the middle of the view.
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

  /** Port position including the offset of tiles being dragged, so cables follow. */
  const portPoint = useCallback(
    (ref: PortRef, side: "in" | "out"): Point | null => {
      const module = doc.modules.find((m) => m.id === ref.module);
      const def = module && getModuleDef(module.type);
      if (!module || !def) return null;
      const index = (side === "in" ? def.inputs : def.outputs).findIndex((p) => p.id === ref.port);
      if (index < 0) return null;
      const point = portPosition(module, def, side, index);
      return dragOffset && selection.has(module.id)
        ? { x: point.x + dragOffset.x, y: point.y + dragOffset.y }
        : point;
    },
    [doc.modules, selection, dragOffset?.x, dragOffset?.y],
  );

  const hintOf = useCallback(
    (cable: Cable) => {
      const module = doc.modules.find((m) => m.id === cable.from.module);
      return getModuleDef(module?.type ?? "")?.outputs.find((p) => p.id === cable.from.port)?.hint ?? "audio";
    },
    [doc.modules],
  );

  const ghostDef = placing ? getModuleDef(placing) : undefined;
  const gridSize = CELL * view.zoom;
  const classes = ["canvas"];
  if (panning) classes.push("canvas-panning");
  if (cableDrag) classes.push(`canvas-cabling-${cableDrag.anchorSide}`);

  return (
    <div
      ref={viewportRef}
      className={classes.join(" ")}
      style={{ backgroundSize: `${gridSize}px ${gridSize}px`, backgroundPosition: `${view.panX}px ${view.panY}px` }}
      onPointerDown={onBackgroundPointerDown}
    >
      <div className="world" style={{ transform: `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})` }}>
        {doc.modules.map((module) => {
          const def = getModuleDef(module.type);
          if (!def) return null;
          const selected = selection.has(module.id);
          return (
            <ModuleTile
              key={module.id}
              module={module}
              def={def}
              selected={selected}
              offset={selected ? dragOffset : null}
              blocked={selected && dragBlocked}
              connected={connectedByModule.get(module.id) ?? NONE}
              onTilePointerDown={onTilePointerDown}
              onPortPointerDown={onPortPointerDown}
            />
          );
        })}

        <CableLayer
          cables={doc.cables}
          portPoint={portPoint}
          hintOf={hintOf}
          onPortPointerDown={onPortPointerDown}
        />

        {ghost && ghostDef && (
          <div className="tile-ghost" style={tileRect(ghost, ghostDef)} />
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
        <p className="canvas-empty">Drag a module in from the left to start a patch.</p>
      )}
    </div>
  );
}
