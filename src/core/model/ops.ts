/**
 * Edits to a patch document. Every function returns a new document (or the same
 * one when nothing changed) and never mutates its input, so undo history can keep
 * old documents around cheaply.
 */

import { getModuleDef } from "../modules/registry";
import { clampParam } from "../modules/params";
import { AREA_BORDER, interior, isVoiceNotes, overlaps, placementOf, tileArea } from "./area";
import { DEFAULT_BANK, wavetableBank } from "../wavetables/banks";
import type { ModuleDef, PortDef } from "../modules/types";
import {
  KNOBS_PER_PAGE,
  MAX_CYCLE,
  MAX_MODULE_NAME,
  MAX_PAGES,
  MAX_TAPE_SECONDS,
  SAMPLE_PARAM,
  SAMPLE_SLOTS,
  type Area,
  type Cable,
  type KnobAssignment,
  type KnobPage,
  type ModuleId,
  type ModuleInstance,
  type PatchDocument,
  type PortRef,
  type SampleSlot,
} from "./types";

export interface Cell {
  x: number;
  y: number;
}

type Rect = Area;

/** The cells a module covers, at the size it currently shows (a mixer grows with its cables). */
const rectOf = tileArea;

/**
 * Whether a module of `def` may have its tile on these cells as far as the voice area goes:
 * wholly in it or wholly out of it, and out of it for a module that runs once.
 */
function allowedAt(doc: Pick<PatchDocument, "voiceArea">, def: ModuleDef, rect: Rect): boolean {
  const where = placementOf(doc.voiceArea, rect);
  return where !== "across" && !(where === "inside" && def.place === "outside");
}

/** Whether a module's tile lies in the voice area. */
const isInside = (doc: Pick<PatchDocument, "voiceArea" | "cables">, module: ModuleInstance) => {
  const rect = rectOf(doc, module);
  return !!rect && placementOf(doc.voiceArea, rect) === "inside";
};

/** True when `rect` is free of every module except those in `ignore`. */
function isFree(doc: PatchDocument, rect: Rect, ignore: ReadonlySet<ModuleId> = new Set()): boolean {
  return doc.modules.every((m) => {
    if (ignore.has(m.id)) return true;
    const other = rectOf(doc, m);
    return !other || !overlaps(rect, other);
  });
}

/** The `count` smallest unused `ge<n>` ids. */
function freeIds(doc: PatchDocument, count: number): ModuleId[] {
  const used = new Set(doc.modules.map((m) => m.id));
  const ids: ModuleId[] = [];
  for (let n = 1; ids.length < count; n++) if (!used.has(`ge${n}`)) ids.push(`ge${n}`);
  return ids;
}

/** Smallest unused `ge<n>` id. */
export function nextModuleId(doc: PatchDocument): ModuleId {
  return freeIds(doc, 1)[0];
}

/** Whether a new module of `type` fits with its top-left corner at `at`, on free cells it may be on. */
export function canPlace(doc: PatchDocument, type: string, at: Cell): boolean {
  const def = getModuleDef(type);
  if (!def) return false;
  const rect = { ...at, width: def.width, height: def.height };
  return isFree(doc, rect) && allowedAt(doc, def, rect);
}

/** The cell closest to `near` that `fits`, searching outwards in rings; `null` if none is found. */
function nearestCell(near: Cell, fits: (cell: Cell) => boolean): Cell | null {
  for (let radius = 0; radius < 200; radius++) {
    let best: Cell | null = null;
    let bestDistance = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cell = { x: near.x + dx, y: near.y + dy };
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance && fits(cell)) {
          best = cell;
          bestDistance = distance;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

/** The free spot for `type` closest to `near`. */
export function findFreeCell(doc: PatchDocument, type: string, near: Cell): Cell {
  return nearestCell(near, (cell) => canPlace(doc, type, cell)) ?? near;
}

/** Add a module at `at`. Returns the unchanged document if the type is unknown or the spot is taken. */
export function addModule(doc: PatchDocument, type: string, at: Cell): { doc: PatchDocument; id: ModuleId | null } {
  if (!canPlace(doc, type, at)) return { doc, id: null };
  const id = nextModuleId(doc);
  return { doc: place(doc, id, type, at), id };
}

function place(doc: PatchDocument, id: ModuleId, type: string, at: Cell): PatchDocument {
  const placed = { ...doc, modules: [...doc.modules, { id, type, x: at.x, y: at.y, params: {} }] };
  // A Wavetable oscillator comes with a wavetable, so that it sounds: one the patch
  // already has, or the first of the editor's own in a free slot. With neither it is
  // left on the first slot, and the compiler says what is wrong with that.
  if (getModuleDef(type)?.sample !== "wavetable") return placed;
  const slots = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => sampleAt(doc, slot));
  const has = slots.findIndex((sample) => sample?.kind === "wavetable");
  const slot = has >= 0 ? has : slots.findIndex((sample) => sample === null);
  if (slot < 0) return placed;
  const filled = has >= 0 ? placed : setSample(placed, slot, { kind: "wavetable", bank: DEFAULT_BANK });
  return setParam(filled, id, SAMPLE_PARAM, slot);
}

/**
 * Whether the modules `ids` can all shift by `delta` without landing on another module, or
 * across the edge of the voice area. A module may move into the voices or out of them.
 */
export function canMove(doc: PatchDocument, ids: ReadonlySet<ModuleId>, delta: Cell): boolean {
  return doc.modules.every((m) => {
    if (!ids.has(m.id)) return true;
    const rect = rectOf(doc, m, { x: m.x + delta.x, y: m.y + delta.y });
    const def = getModuleDef(m.type);
    return !rect || !def || (isFree(doc, rect, ids) && allowedAt(doc, def, rect));
  });
}

export function moveModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>, delta: Cell): PatchDocument {
  if ((delta.x === 0 && delta.y === 0) || ids.size === 0 || !canMove(doc, ids, delta)) return doc;
  return {
    ...doc,
    modules: doc.modules.map((m) => (ids.has(m.id) ? { ...m, x: m.x + delta.x, y: m.y + delta.y } : m)),
  };
}

/**
 * Remove modules together with their cables and knob assignments.
 *
 * A module taken out of a chain leaves the chain patched: what fed its first input now
 * feeds whatever its first output fed. That undoes `addModuleAtPort`, and it looks
 * through a run of removed modules. Cables on its other ports go with it.
 */
export function removeModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>): PatchDocument {
  if (!doc.modules.some((m) => ids.has(m.id))) return doc;

  /** The output that stays and stands in for output `ref` of a removed module, if any. */
  const standIn = (ref: PortRef, seen = new Set<ModuleId>()): PortRef | null => {
    if (!ids.has(ref.module)) return ref;
    // A document read from a file may hold a loop.
    if (seen.has(ref.module)) return null;
    seen.add(ref.module);
    const module = doc.modules.find((m) => m.id === ref.module);
    const def = module && getModuleDef(module.type);
    const input = def?.inputs[0];
    if (!input || def.outputs[0]?.id !== ref.port) return null;
    const feed = doc.cables.find((c) => c.to.module === ref.module && c.to.port === input.id);
    return feed ? standIn(feed.from, seen) : null;
  };

  return {
    ...doc,
    modules: doc.modules.filter((m) => !ids.has(m.id)),
    cables: doc.cables.flatMap((cable) => {
      if (ids.has(cable.to.module)) return [];
      if (!ids.has(cable.from.module)) return [cable];
      const from = standIn(cable.from);
      return from ? [{ from, to: cable.to }] : [];
    }),
    pages: trimPages(
      doc.pages.map((page) => ({
        ...page,
        knobs: page.knobs.map((k) => (k && ids.has(k.module) ? null : k)),
      })),
    ),
  };
}

/**
 * Modules taken from a patch to be put in again, there or in another patch. They are as
 * they were in the patch they came from, ids and places included; `pasteModules` gives
 * them new ones.
 */
export interface Clip {
  modules: ModuleInstance[];
  cables: Cable[];
}

/**
 * What a copy of the modules `ids` takes along: each module's settings, name and pre-cord
 * switches, and the cables between them. A cable to a module that is not copied stays
 * behind, and so do the Organelle knobs, since a knob holds one setting. `null` when
 * there is nothing to copy.
 */
export function copyModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>): Clip | null {
  // A module of an unknown type has no tile: it could be neither seen nor placed.
  const modules = doc.modules.filter((m) => ids.has(m.id) && getModuleDef(m.type));
  if (modules.length === 0) return null;
  const copied = new Set(modules.map((m) => m.id));
  return { modules, cables: doc.cables.filter((c) => copied.has(c.from.module) && copied.has(c.to.module)) };
}

/** A clip's tiles at the size they have once pasted (a mixer copied without its cables is a small one). */
function clipRects(clip: Clip): Rect[] {
  return clip.modules.flatMap((m) => rectOf(clip, m) ?? []);
}

function boundsOf(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}

/** How many cells a clip's modules span together. */
export function clipSize(clip: Clip): { width: number; height: number } {
  const rects = clipRects(clip);
  if (rects.length === 0) return { width: 0, height: 0 };
  const { width, height } = boundsOf(rects);
  return { width, height };
}

/**
 * Put a clip's modules into the document under new ids, cabled as they were. They stay
 * in the places they had to each other, and go as a group where there is room for all of
 * them: with the group's top-left corner at `near`, or as near to it as it fits. Returns
 * the new ids in the clip's order, and the unchanged document when the clip is empty.
 */
export function pasteModules(doc: PatchDocument, clip: Clip, near: Cell): { doc: PatchDocument; ids: ModuleId[] } {
  const modules = clip.modules.filter((m) => rectOf(clip, m));
  const rects = clipRects(clip);
  if (rects.length === 0) return { doc, ids: [] };
  const bounds = boundsOf(rects);
  const defs = modules.map((m) => getModuleDef(m.type)!);
  const at = nearestCell(near, (cell) =>
    rects.every((r, i) => {
      const there = { ...r, x: r.x - bounds.x + cell.x, y: r.y - bounds.y + cell.y };
      return isFree(doc, there) && allowedAt(doc, defs[i], there);
    }),
  );
  if (!at) return { doc, ids: [] };

  const ids = freeIds(doc, modules.length);
  const renamed = new Map(modules.map((m, i) => [m.id, ids[i]]));
  return {
    doc: {
      ...doc,
      modules: [
        ...doc.modules,
        ...modules.map((m, i) => ({ ...m, id: ids[i], x: m.x - bounds.x + at.x, y: m.y - bounds.y + at.y })),
      ],
      cables: [
        ...doc.cables,
        ...clip.cables.flatMap((c) => {
          const from = renamed.get(c.from.module);
          const to = renamed.get(c.to.module);
          return from && to ? [{ from: { module: from, port: c.from.port }, to: { module: to, port: c.to.port } }] : [];
        }),
      ],
    },
    ids,
  };
}

/**
 * Copy the modules `ids` and paste them straight away: right below the ones they are
 * copies of, or as near to that as there is room.
 */
export function duplicateModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>): { doc: PatchDocument; ids: ModuleId[] } {
  const clip = copyModules(doc, ids);
  if (!clip) return { doc, ids: [] };
  // Below them as they are here, where a mixer with cables from outside the copy is taller than its copy.
  const bounds = boundsOf(clip.modules.flatMap((m) => rectOf(doc, m) ?? []));
  return pasteModules(doc, clip, { x: bounds.x, y: bounds.y + bounds.height });
}

const samePort = (a: PortRef, b: PortRef) => a.module === b.module && a.port === b.port;

export const sameCable = (a: Cable, b: Cable) => samePort(a.from, b.from) && samePort(a.to, b.to);

/** A port's definition; the voice area's Notes input is a note input of no module. */
function portOf(doc: PatchDocument, ref: PortRef, side: "inputs" | "outputs"): Pick<PortDef, "kind"> | undefined {
  if (side === "inputs" && isVoiceNotes(ref)) return { kind: "notes" };
  const module = doc.modules.find((m) => m.id === ref.module);
  return module && getModuleDef(module.type)?.[side].find((p) => p.id === ref.port);
}

const hasPort = (doc: PatchDocument, ref: PortRef, side: "inputs" | "outputs") => !!portOf(doc, ref, side);

/** Whether a cable carries notes: whether it comes from a note output. */
const carriesNotes = (doc: PatchDocument, cable: Cable) => portOf(doc, cable.from, "outputs")?.kind === "notes";

/**
 * Whether `to` is reachable from `from` by following cables downstream: those of one kind,
 * signals or notes. With `node`, the modules are taken as the nodes it gives them, and a
 * cable between two modules of one node is no step at all.
 */
function reaches(doc: PatchDocument, from: string, to: string, notes: boolean, node: (id: ModuleId) => string = (id) => id): boolean {
  const seen = new Set<string>();
  const pending = [from];
  while (pending.length > 0) {
    const at = pending.pop()!;
    if (at === to) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const cable of doc.cables) {
      if (carriesNotes(doc, cable) !== notes) continue;
      const [a, b] = [node(cable.from.module), node(cable.to.module)];
      if (a === at && b !== at) pending.push(b);
    }
  }
  return false;
}

/** The node all modules in the voice area are to Pd: one `[clone]`. No module id has a hyphen there. */
const VOICES_NODE = "ge-voices";

/** Why a cable from output `from` to input `to` cannot be made, or `null` if it can. */
export function connectionProblem(doc: PatchDocument, from: PortRef, to: PortRef): string | null {
  const [output, input] = [portOf(doc, from, "outputs"), portOf(doc, to, "inputs")];
  if (!output || !input) return "That port does not exist.";
  const notes = output.kind === "notes";
  if (notes !== (input.kind === "notes")) return notes ? "Notes go to a Notes input only." : "A Notes input takes notes only.";
  if (reaches(doc, to.module, from.module, notes)) return "That would create a feedback loop, which is not supported yet.";
  // Pd runs the voice area as one object: a way out of it and back in is a loop too. Notes
  // are messages, and go into the voices without taking part in that.
  if (notes) return null;
  const inside = new Set(doc.modules.filter((m) => isInside(doc, m)).map((m) => m.id));
  const node = (id: ModuleId) => (inside.has(id) ? VOICES_NODE : id);
  const [a, b] = [node(from.module), node(to.module)];
  if (a !== b && reaches(doc, b, a, false, node)) {
    return "That would make a way out of the voice area and back into it: a feedback loop, since the voices are added up before anything outside them runs.";
  }
  return null;
}

/** What `makeRoom` moves as a whole: the voice area, with the tiles in it. */
const AREA = "area";

/**
 * Move whatever module `id` overlaps to just below it (or just right of it), and whatever
 * those land on in turn. `id` itself stays where it is. Used when a tile has grown, and
 * when one is put into a row of tiles.
 *
 * Tiles in the voice area push only each other, and the area grows to hold them; to the
 * tiles outside it, the area is one big tile, which they push along with what is in it and
 * which pushes them in turn. `inside` says which `id` is (it may lie across the edge now,
 * having just grown or been put there); without it, `id` is in the voices when its top-left
 * cell is.
 */
export function makeRoom(doc: PatchDocument, id: ModuleId, direction: "down" | "right" = "down", inside?: boolean): PatchDocument {
  const rects = new Map<string, Rect>();
  const voices = new Set<string>();
  const area = { ...doc.voiceArea };
  const room = () => interior(area);
  for (const module of doc.modules) {
    const rect = rectOf(doc, module);
    if (!rect) continue;
    rects.set(module.id, { ...rect });
    const corner = { x: rect.x, y: rect.y, width: 1, height: 1 };
    const isIn =
      module.id === id ? (inside ?? placementOf(doc.voiceArea, corner) === "inside") : placementOf(doc.voiceArea, rect) === "inside";
    if (isIn) voices.add(module.id);
  }
  if (!rects.has(id)) return doc;
  // The area is a tile to the modules outside it. One with no cells is none.
  const hasArea = doc.voiceArea.width > 0 && doc.voiceArea.height > 0;
  if (hasArea) rects.set(AREA, area);

  const moved = new Set<string>();
  const shift = (key: string, x: number, y: number) => {
    const rect = rects.get(key)!;
    rect.x += x;
    rect.y += y;
    moved.add(key);
  };
  const past = (pusher: Rect, other: Rect) =>
    direction === "down" ? { x: 0, y: pusher.y + pusher.height - other.y } : { x: pusher.x + pusher.width - other.x, y: 0 };
  /** Grow the area to hold every tile in it: right and down only. Whether it grew. */
  const fit = () => {
    let grew = false;
    for (const key of voices) {
      const rect = rects.get(key)!;
      const inner = room();
      if (rect.x + rect.width > inner.x + inner.width) {
        area.width += rect.x + rect.width - (inner.x + inner.width);
        grew = true;
      }
      if (rect.y + rect.height > inner.y + inner.height) {
        area.height += rect.y + rect.height - (inner.y + inner.height);
        grew = true;
      }
    }
    if (grew) moved.add(AREA);
    return grew;
  };

  // A pushed tile ends up past its pusher and can never push it back, and the area only
  // grows the way things are pushed, so this ends.
  const pushers: string[] = [id];
  if (hasArea && voices.has(id) && fit()) pushers.push(AREA);
  while (pushers.length > 0) {
    const key = pushers.shift()!;
    const pusher = rects.get(key)!;
    const inVoices = voices.has(key);
    for (const [otherKey, other] of rects) {
      if (otherKey === id || otherKey === key || voices.has(otherKey) !== inVoices || !overlaps(pusher, other)) continue;
      const { x, y } = past(pusher, other);
      shift(otherKey, x, y);
      // The area takes its tiles with it.
      if (otherKey === AREA) for (const inner of voices) if (inner !== id) shift(inner, x, y);
      pushers.push(otherKey);
    }
    if (inVoices && hasArea && fit()) pushers.push(AREA);
  }
  if (moved.size === 0) return doc;
  return {
    ...doc,
    voiceArea: hasArea ? { x: area.x, y: area.y, width: area.width, height: area.height } : doc.voiceArea,
    modules: doc.modules.map((m) => (moved.has(m.id) ? { ...m, x: rects.get(m.id)!.x, y: rects.get(m.id)!.y } : m)),
  };
}

/** The smallest the voice area can be: its border around a single cell. */
export const MIN_AREA = { width: 2 * AREA_BORDER + 1, height: 2 * AREA_BORDER + 1 };

/**
 * Move the voice area by `delta`, with the tiles in it. Unchanged when it would land on a
 * tile outside it.
 */
export function moveArea(doc: PatchDocument, delta: Cell): PatchDocument {
  if (delta.x === 0 && delta.y === 0) return doc;
  const area = { ...doc.voiceArea, x: doc.voiceArea.x + delta.x, y: doc.voiceArea.y + delta.y };
  const inside = new Set(doc.modules.filter((m) => isInside(doc, m)).map((m) => m.id));
  const blocked = doc.modules.some((m) => {
    const rect = rectOf(doc, m);
    return !inside.has(m.id) && !!rect && overlaps(area, rect);
  });
  if (blocked) return doc;
  return {
    ...doc,
    voiceArea: area,
    modules: doc.modules.map((m) => (inside.has(m.id) ? { ...m, x: m.x + delta.x, y: m.y + delta.y } : m)),
  };
}

type Way = "left" | "right" | "up" | "down";

/** How far `rect` has to move `way` to be clear of `by`. */
function clearOf(by: Rect, rect: Rect, way: Way): Cell {
  switch (way) {
    case "left":
      return { x: by.x - (rect.x + rect.width), y: 0 };
    case "right":
      return { x: by.x + by.width - rect.x, y: 0 };
    case "up":
      return { x: 0, y: by.y - (rect.y + rect.height) };
    case "down":
      return { x: 0, y: by.y + by.height - rect.y };
  }
}

/**
 * Give the voice area other edges. The tiles outside it that the new edges reach are pushed
 * along with the border, each the shortest of the ways the area grew, and each pushes what
 * it lands on the same way. Unchanged when a tile in the voices would come onto the border
 * or out of the area, or when the area would be smaller than `MIN_AREA`.
 */
export function resizeArea(doc: PatchDocument, area: Area): PatchDocument {
  const old = doc.voiceArea;
  const next = { x: area.x, y: area.y, width: area.width, height: area.height };
  const same = (["x", "y", "width", "height"] as const).every((key) => next[key] === old[key]);
  if (same || next.width < MIN_AREA.width || next.height < MIN_AREA.height) return doc;
  const outside = new Map<ModuleId, Rect>();
  for (const module of doc.modules) {
    const rect = rectOf(doc, module);
    if (!rect) continue;
    if (placementOf(old, rect) !== "inside") outside.set(module.id, { ...rect });
    else if (placementOf(next, rect) !== "inside") return doc;
  }
  const ways: Way[] = [];
  if (next.x < old.x) ways.push("left");
  if (next.x + next.width > old.x + old.width) ways.push("right");
  if (next.y < old.y) ways.push("up");
  if (next.y + next.height > old.y + old.height) ways.push("down");

  const moved = new Set<ModuleId>();
  const pushers: { id: ModuleId; way: Way }[] = [];
  const shift = (id: ModuleId, by: Cell, way: Way) => {
    const rect = outside.get(id)!;
    rect.x += by.x;
    rect.y += by.y;
    moved.add(id);
    pushers.push({ id, way });
  };
  const size = (by: Cell) => Math.abs(by.x) + Math.abs(by.y);
  for (const [id, rect] of outside) {
    if (!overlaps(next, rect)) continue;
    const way = ways.reduce<Way | null>((best, w) => (best && size(clearOf(next, rect, best)) <= size(clearOf(next, rect, w)) ? best : w), null);
    if (!way) return doc;
    shift(id, clearOf(next, rect, way), way);
  }
  // A pushed tile ends up past its pusher, away from the area. Two ways at once (the corner)
  // could in principle push in a circle, so the steps are counted.
  for (let steps = 0; pushers.length > 0; steps++) {
    if (steps > 64 * outside.size) return doc;
    const { id, way } = pushers.shift()!;
    const pusher = outside.get(id)!;
    for (const [other, rect] of outside) {
      if (other !== id && overlaps(pusher, rect)) shift(other, clearOf(pusher, rect, way), way);
    }
  }
  for (const rect of outside.values()) if (placementOf(next, rect) !== "outside") return doc;
  return {
    ...doc,
    voiceArea: next,
    modules: doc.modules.map((m) => (moved.has(m.id) ? { ...m, x: outside.get(m.id)!.x, y: outside.get(m.id)!.y } : m)),
  };
}

/**
 * Move apart the tiles that lie on top of each other, each one pushing down what it
 * covers. A document from an older build can have them, when a module's tile has since
 * changed shape. The same document comes back when nothing overlaps.
 */
export function settle(doc: PatchDocument): PatchDocument {
  return doc.modules.reduce((settled, module) => makeRoom(settled, module.id), doc);
}

/**
 * Patch a cable from an output to an input. An input holds one cable, so any
 * existing cable into `to` is replaced. Invalid connections leave the document unchanged.
 *
 * Cabling the last free input of a module that grows with its inputs makes its tile
 * taller; modules in the way are pushed down as part of the same edit.
 */
export function connect(doc: PatchDocument, from: PortRef, to: PortRef): PatchDocument {
  if (connectionProblem(doc, from, to)) return doc;
  const cable = { from, to };
  if (doc.cables.some((c) => sameCable(c, cable))) return doc;
  const patched = { ...doc, cables: [...doc.cables.filter((c) => !samePort(c.to, to)), cable] };
  const target = doc.modules.find((m) => m.id === to.module);
  return target && getModuleDef(target.type)?.growsWithInputs ? makeRoom(patched, to.module) : patched;
}

export function disconnect(doc: PatchDocument, cable: Cable): PatchDocument {
  const cables = doc.cables.filter((c) => !sameCable(c, cable));
  return cables.length === doc.cables.length ? doc : { ...doc, cables };
}

/** A port of a module in the document, and which side of the tile it is on. */
export interface PortTarget extends PortRef {
  side: "in" | "out";
}

/** What dropping a new module on a port does. */
export interface PortDrop {
  /** Where the new module lands. */
  at: Cell;
  /** That spot is taken: the tiles there are moved right to make room. */
  push: boolean;
  /** The cables to patch, in order. The new module is in them under the id it will get. */
  cables: Cable[];
}

/**
 * Work out how a new module of `type` is cabled in when it is dropped on `target`. It
 * uses its first input and first output:
 *
 * - on a free port it is cabled to that port and lands beside it (left of an input,
 *   right of an output), or as near to that as there is room;
 * - on a port that has cables it goes in between: what fed the input now feeds the new
 *   module, or what the output fed is now fed by the new module. If the spot beside the
 *   port is taken, it takes that place in the row and the tiles there move right;
 * - a module with nothing to go in between with (no input, or no output) is cabled to
 *   the port alone, replacing the cable of an input as any new cable would.
 *
 * `null` when the module has no port to cable to that side, or the port does not exist.
 */
export function planPortDrop(doc: PatchDocument, type: string, target: PortTarget): PortDrop | null {
  const def = getModuleDef(type);
  const host = doc.modules.find((m) => m.id === target.module);
  const hostRect = host && rectOf(doc, host);
  if (!def || !hostRect || !hasPort(doc, target, target.side === "in" ? "inputs" : "outputs")) return null;

  const id = nextModuleId(doc);
  const input = def.inputs[0] && { module: id, port: def.inputs[0].id };
  const output = def.outputs[0] && { module: id, port: def.outputs[0].id };
  const port = { module: target.module, port: target.port };
  let cables: Cable[];
  let between: boolean;
  let beside: Cell;
  if (target.side === "in") {
    if (!output) return null;
    const feed = input && doc.cables.find((c) => samePort(c.to, port));
    between = !!feed;
    cables = [...(feed ? [{ from: feed.from, to: input }] : []), { from: output, to: port }];
    beside = { x: hostRect.x - def.width, y: hostRect.y };
  } else {
    if (!input) return null;
    const fed = output ? doc.cables.filter((c) => samePort(c.from, port)) : [];
    between = fed.length > 0;
    cables = [{ from: port, to: input }, ...fed.map((c) => ({ from: output, to: c.to }))];
    beside = { x: hostRect.x + hostRect.width, y: hostRect.y };
  }

  if (!between) return { at: findFreeCell(doc, type, beside), push: false, cables };
  if (canPlace(doc, type, beside)) return { at: beside, push: false, cables };
  // Into the row: in front of the module whose input it was dropped on, or right after the
  // output's, on the same side of the voice area's edge as it. A module that runs once is
  // not pushed into the voices: it goes as near as there is room.
  if (isInside(doc, host) && def.place === "outside") return { at: findFreeCell(doc, type, beside), push: false, cables };
  return { at: target.side === "in" ? { x: hostRect.x, y: hostRect.y } : beside, push: true, cables };
}

/** Add a module by dropping it on a port: see `planPortDrop`. Unchanged when there is nothing to cable. */
export function addModuleAtPort(
  doc: PatchDocument,
  type: string,
  target: PortTarget,
): { doc: PatchDocument; id: ModuleId | null } {
  const plan = planPortDrop(doc, type, target);
  if (!plan) return { doc, id: null };
  const id = nextModuleId(doc);
  let next = place(doc, id, type, plan.at);
  // Pushed into a row, it is on the side of the voice area its neighbour is: the area grows if need be.
  const host = doc.modules.find((m) => m.id === target.module)!;
  if (plan.push) next = makeRoom(next, id, "right", isInside(doc, host));
  for (const cable of plan.cables) next = connect(next, cable.from, cable.to);
  return { doc: next, id };
}

/** Set a parameter, clamped to its range. Unknown modules or parameters leave the document unchanged. */
export function setParam(doc: PatchDocument, id: ModuleId, param: string, value: number): PatchDocument {
  const module = doc.modules.find((m) => m.id === id);
  const def = module && getModuleDef(module.type)?.params.find((p) => p.id === param);
  if (!module || !def) return doc;
  const clamped = clampParam(def, value);
  if ((module.params[param] ?? def.default) === clamped) return doc;
  return {
    ...doc,
    modules: doc.modules.map((m) => (m === module ? { ...m, params: { ...m.params, [param]: clamped } } : m)),
  };
}

/** Turn an input's pre-cord (its implicit pitch/gate connection) on or off. */
export function setPrecord(doc: PatchDocument, id: ModuleId, port: string, enabled: boolean): PatchDocument {
  const module = doc.modules.find((m) => m.id === id);
  const def = module && getModuleDef(module.type)?.inputs.find((p) => p.id === port);
  if (!module || !def?.precord || (module.precords?.[port] ?? true) === enabled) return doc;
  return {
    ...doc,
    modules: doc.modules.map((m) => (m === module ? { ...m, precords: { ...m.precords, [port]: enabled } } : m)),
  };
}

/** The sample in a slot, or `null` when the slot is empty. */
export function sampleAt(doc: Pick<PatchDocument, "samples">, slot: number): SampleSlot | null {
  return doc.samples?.[slot] ?? null;
}

/**
 * Put a sound file or a tape in a sample slot, or empty it with `null`. A tape's length
 * is kept between a tenth of a second and the longest a tape can be.
 */
export function setSample(doc: PatchDocument, slot: number, sample: SampleSlot | null): PatchDocument {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SAMPLE_SLOTS) return doc;
  let next = sample;
  if (sample?.kind === "tape") next = { kind: "tape", seconds: Math.min(MAX_TAPE_SECONDS, Math.max(0.1, sample.seconds || 0)) };
  if (sample?.kind === "file") {
    // A cycle length is a whole number of samples that a cycle can have, or it is left out.
    const { cycle, ...file } = sample;
    const whole = Math.round(cycle ?? 0);
    next = whole >= 2 && whole <= MAX_CYCLE ? { ...file, cycle: whole } : file;
  }
  const current = sampleAt(doc, slot);
  if (JSON.stringify(current) === JSON.stringify(next)) return doc;
  const samples: (SampleSlot | null)[] = Array.from({ length: SAMPLE_SLOTS }, (_, i) => sampleAt(doc, i));
  samples[slot] = next;
  // No trailing empty slots, and no list at all when every slot is empty.
  while (samples.length > 0 && samples[samples.length - 1] === null) samples.pop();
  const { samples: _dropped, ...rest } = doc;
  return samples.length > 0 ? { ...rest, samples } : rest;
}

/**
 * Give a module one of the editor's own wavetables. It goes to a slot that already has
 * that wavetable; or it takes the place of the wavetable in the module's own slot, when
 * that is one of the editor's (or empty) and no other module uses it; or it goes in the
 * first free slot. With no such slot the document is left as it is.
 */
export function setWavetable(doc: PatchDocument, id: ModuleId, bank: string): PatchDocument {
  const module = doc.modules.find((m) => m.id === id);
  if (!module || getModuleDef(module.type)?.sample !== "wavetable" || !wavetableBank(bank)) return doc;
  const slots = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => sampleAt(doc, slot));
  const same = slots.findIndex((sample) => sample?.kind === "wavetable" && sample.bank === bank);
  if (same >= 0) return setParam(doc, id, SAMPLE_PARAM, same);
  const own = paramValue(module, SAMPLE_PARAM);
  const shared = doc.modules.some((m) => m !== module && getModuleDef(m.type)?.params.some((p) => p.id === SAMPLE_PARAM) && paramValue(m, SAMPLE_PARAM) === own);
  const replaceable = slots[own] === null || slots[own]?.kind === "wavetable";
  const slot = replaceable && !shared ? own : slots.findIndex((sample) => sample === null);
  if (slot < 0) return doc;
  return setParam(setSample(doc, slot, { kind: "wavetable", bank }), id, SAMPLE_PARAM, slot);
}

/**
 * What a module is called: the name the user gave it, or the name of its type, which is
 * also what a name of nothing but spaces comes to.
 */
export function moduleName(module: Pick<ModuleInstance, "name">, def: Pick<ModuleDef, "name">): string {
  return module.name?.trim() || def.name;
}

/**
 * Give a module a name of its own, or with an empty one take it back to the name of its
 * type. The name is kept as typed, up to the longest a name may be.
 */
export function renameModule(doc: PatchDocument, id: ModuleId, name: string): PatchDocument {
  const module = doc.modules.find((m) => m.id === id);
  const next = [...name].slice(0, MAX_MODULE_NAME).join("");
  if (!module || (module.name ?? "") === next) return doc;
  const { name: _old, ...unnamed } = module;
  const renamed: ModuleInstance = next ? { ...unnamed, name: next } : unnamed;
  return { ...doc, modules: doc.modules.map((m) => (m === module ? renamed : m)) };
}

/**
 * Switch an input's pre-cord over: off when it follows the played note, on when it does
 * not. Nothing happens on a port without one, or with a cable in it, which has replaced it.
 */
export function togglePrecord(doc: PatchDocument, id: ModuleId, port: string): PatchDocument {
  if (doc.cables.some((c) => c.to.module === id && c.to.port === port)) return doc;
  const module = doc.modules.find((m) => m.id === id);
  return module ? setPrecord(doc, id, port, !(module.precords?.[port] ?? true)) : doc;
}

/** Current value of a parameter, falling back to its default. */
export function paramValue(module: ModuleInstance, param: string): number {
  const def = getModuleDef(module.type)?.params.find((p) => p.id === param);
  return module.params[param] ?? def?.default ?? 0;
}

/*
 * Knob pages. A patch always has `MAX_PAGES` of them: there is nothing to add or remove.
 * The document holds them up to the last one that has a name or a knob in use, and the
 * rest are blank; `pageAt` is how to read one. A page with no knob in use is not exported.
 */

const blankPage = (): KnobPage => ({ name: "", knobs: Array(KNOBS_PER_PAGE).fill(null) });
const isBlank = (page: KnobPage) => page.name === "" && page.knobs.every((knob) => !knob);

/** `pages` without the blank ones at its end: two documents that say the same are then the same. */
function trimPages(pages: KnobPage[]): KnobPage[] {
  let length = pages.length;
  while (length > 0 && isBlank(pages[length - 1])) length--;
  return length === pages.length ? pages : pages.slice(0, length);
}

const isPage = (index: number) => Number.isInteger(index) && index >= 0 && index < MAX_PAGES;

/** The knob page at `index`, 0 to `MAX_PAGES` - 1: blank where the document holds none. */
export function pageAt(doc: Pick<PatchDocument, "pages">, index: number): KnobPage {
  return doc.pages[index] ?? blankPage();
}

/** Whether a page has a knob in use, which is what gets it exported. */
export const pageInUse = (page: KnobPage) => page.knobs.some((knob) => !!knob);

/** The name a page goes by where it has none of its own: on the Organelle's screen, and as a hint in the editor. */
export const defaultPageName = (index: number) => `Page ${index + 1}`;

/** The document's pages with page `index` replaced, which may be one it did not hold until now. */
function withPage(doc: PatchDocument, index: number, page: KnobPage): KnobPage[] {
  const pages = Array.from({ length: Math.max(doc.pages.length, index + 1) }, (_, i) => (i === index ? page : pageAt(doc, i)));
  return trimPages(pages);
}

export function renamePage(doc: PatchDocument, index: number, name: string): PatchDocument {
  const page = pageAt(doc, index);
  if (!isPage(index) || page.name === name) return doc;
  return { ...doc, pages: withPage(doc, index, { ...page, name }) };
}

export interface KnobSlot {
  page: number;
  /** 0–3 for the Organelle's knobs 1–4. */
  knob: number;
}

/** Where a parameter is assigned, if anywhere. */
export function findAssignment(doc: PatchDocument, module: ModuleId, param: string): KnobSlot | null {
  for (const [page, { knobs }] of doc.pages.entries()) {
    const knob = knobs.findIndex((k) => k?.module === module && k.param === param);
    if (knob >= 0) return { page, knob };
  }
  return null;
}

/**
 * Put a parameter on a knob, or clear the knob with `null`. A parameter lives on
 * at most one knob, so assigning it somewhere new removes it from where it was.
 */
export function assignKnob(doc: PatchDocument, slot: KnobSlot, assignment: KnobAssignment | null): PatchDocument {
  if (!isPage(slot.page) || slot.knob < 0 || slot.knob >= KNOBS_PER_PAGE) return doc;
  const page = pageAt(doc, slot.page);
  if (assignment) {
    const module = doc.modules.find((m) => m.id === assignment.module);
    if (!module || !getModuleDef(module.type)?.params.some((p) => p.id === assignment.param)) return doc;
  }
  const current = page.knobs[slot.knob];
  if (current?.module === assignment?.module && current?.param === assignment?.param) return doc;
  const isMoved = (k: KnobAssignment | null) =>
    !!k && !!assignment && k.module === assignment.module && k.param === assignment.param;
  // The page may be one the document did not hold until now.
  const pages = Array.from({ length: Math.max(doc.pages.length, slot.page + 1) }, (_, i) => pageAt(doc, i));
  return {
    ...doc,
    pages: trimPages(
      pages.map((p, pageIndex) => ({
        ...p,
        knobs: p.knobs.map((k, knobIndex) =>
          pageIndex === slot.page && knobIndex === slot.knob ? assignment : isMoved(k) ? null : k,
        ),
      })),
    ),
  };
}

/** The first empty knob of `page` after knob `after`, going round to the start; `null` if there is none. */
export function nextFreeKnob(doc: PatchDocument, page: number, after: number): number | null {
  if (!isPage(page)) return null;
  const knobs = pageAt(doc, page).knobs;
  for (let step = 1; step <= KNOBS_PER_PAGE; step++) {
    const knob = (after + step) % KNOBS_PER_PAGE;
    if (!knobs[knob]) return knob;
  }
  return null;
}
