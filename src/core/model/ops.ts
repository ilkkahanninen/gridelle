/**
 * Edits to a patch document. Every function returns a new document (or the same
 * one when nothing changed) and never mutates its input, so undo history can keep
 * old documents around cheaply.
 */

import { getModuleDef } from "../modules/registry";
import { clampParam } from "../modules/params";
import { AREA_BORDER, containerAt, containerOf, contains, groupParent, groupsOf, interior, isVoiceNotes, MAIN, overlaps, tileArea } from "./area";
import { AREA, Boxes, holderOf, layoutAllowed, TOP, type Way } from "./layout";
import { DEFAULT_BANK, wavetableBank } from "../wavetables/banks";
import type { ModuleDef, PortDef } from "../modules/types";
import {
  KNOBS_PER_PAGE,
  MAX_CYCLE,
  MAX_VOICES,
  MIN_VOICES,
  NOTE_PRIORITIES,
  voicingOf,
  type Voicing,
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
  type UnisonGroup,
  DEFAULT_UNISON,
  MAX_UNISON,
  MIN_UNISON,
} from "./types";

export interface Cell {
  x: number;
  y: number;
}

type Rect = Area;

/** The cells a module covers, at the size it currently shows (a mixer grows with its cables). */
const rectOf = tileArea;

/**
 * Whether a module of `def` may have its tile on these cells as far as the containers go:
 * wholly in or wholly out of the voice area and of every unison group, and out of all of
 * them for a module that runs once.
 */
function allowedAt(doc: Pick<PatchDocument, "voiceArea" | "groups">, def: ModuleDef, rect: Rect): boolean {
  const at = containerAt(doc, rect);
  return at !== null && !(at !== MAIN && def.place === "outside");
}

/** True when `rect` is free of every module except those in `ignore`. Groups are not tiles: see `allowedAt`. */
function isFree(doc: PatchDocument, rect: Rect, ignore: ReadonlySet<ModuleId> = new Set()): boolean {
  return doc.modules.every((m) => {
    if (ignore.has(m.id)) return true;
    const other = rectOf(doc, m);
    return !other || !overlaps(rect, other);
  });
}

/** The `count` smallest unused `ge<n>` ids. Modules and unison groups share them. */
function freeIds(doc: PatchDocument, count: number): ModuleId[] {
  const used = new Set([...doc.modules.map((m) => m.id), ...groupsOf(doc).map((g) => g.id)]);
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
 * Whether the modules `ids` can all shift by `delta` as they are, without landing on another
 * module or across the edge of the voice area or a unison group: what `moveModules` does
 * when they may leave their containers.
 */
export function canMove(doc: PatchDocument, ids: ReadonlySet<ModuleId>, delta: Cell): boolean {
  return doc.modules.every((m) => {
    if (!ids.has(m.id)) return true;
    const rect = rectOf(doc, m, { x: m.x + delta.x, y: m.y + delta.y });
    const def = getModuleDef(m.type);
    return !rect || !def || (isFree(doc, rect, ids) && allowedAt(doc, def, rect));
  });
}

/**
 * Move the modules `ids` by `delta`.
 *
 * A module stays in its container (the voice area, a unison group) or goes into one in it:
 * where it would go past the container's edge, the container grows instead, its border
 * moving out with the module, and pushes what is beside it, which may push the border of
 * another container in turn (see `Boxes`). With `leave` the modules go wherever `delta`
 * takes them, out of their containers too, as long as none lands across an edge. Either way
 * the move is refused when a module would land on another or where it may not be.
 */
export function moveModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>, delta: Cell, leave = false): PatchDocument {
  if ((delta.x === 0 && delta.y === 0) || ids.size === 0) return doc;
  if (leave) {
    if (!canMove(doc, ids, delta)) return doc;
    return { ...doc, modules: doc.modules.map((m) => (ids.has(m.id) ? { ...m, x: m.x + delta.x, y: m.y + delta.y } : m)) };
  }
  const boxes = new Boxes(doc);
  const moving = doc.modules.filter((m) => ids.has(m.id) && boxes.rects.has(m.id));
  if (moving.length === 0) return doc;
  for (const module of moving) boxes.shift(module.id, delta);
  const grown = new Set<string>();
  for (const module of moving) {
    const rect = boxes.rects.get(module.id)!;
    const home = boxes.parentOf(module.id);
    // Into a container in its own: one whose inside now holds it.
    const deeper = boxes.childrenOf(home).find((c) => boxes.containers.has(c) && contains(interior(boxes.rects.get(c)!), rect));
    if (deeper) boxes.setParent(module.id, deeper);
    else if (home !== TOP && !contains(interior(boxes.rects.get(home)!), rect)) grown.add(home);
  }
  const starts = [...grown].map((key) => ({ key, ways: boxes.fit(key) }));
  if (!boxes.push(starts, new Set(moving.map((m) => m.id)))) return doc;
  const next = boxes.apply(doc);
  const free = moving.every((m) => {
    const rect = rectOf(next, next.modules.find((n) => n.id === m.id)!);
    return !rect || isFree(next, rect, ids);
  });
  return free && layoutAllowed(next) ? next : doc;
}

/**
 * Remove modules together with their cables and knob assignments.
 *
 * A module taken out of a chain leaves the chain patched: what fed its first input now
 * feeds whatever its first output fed. That undoes `addModuleAtPort`, and it looks
 * through a run of removed modules. Cables on its other ports go with it.
 */
export function removeModules(doc: PatchDocument, picked: ReadonlySet<ModuleId>): PatchDocument {
  // A unison group goes with all that is in it.
  const groups = groupsOf(doc).filter((g) => picked.has(g.id));
  const ids = new Set([...picked, ...doc.modules.filter((m) => groups.some((g) => containerOf(doc, m) === g.id)).map((m) => m.id)]);
  if (groups.length === 0 && !doc.modules.some((m) => ids.has(m.id))) return doc;

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
    ...(groups.length > 0 ? { groups: groupsOf(doc).filter((g) => !picked.has(g.id)) } : {}),
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
  /** The unison groups copied, with what was in them among the modules. */
  groups?: UnisonGroup[];
}

/**
 * What a copy of the modules `ids` takes along: each module's settings, name and pre-cord
 * switches, and the cables between them. A cable to a module that is not copied stays
 * behind, and so do the Organelle knobs, since a knob holds one setting. `null` when
 * there is nothing to copy.
 */
export function copyModules(doc: PatchDocument, ids: ReadonlySet<ModuleId>): Clip | null {
  // A unison group goes with what is in it.
  const groups = groupsOf(doc).filter((g) => ids.has(g.id));
  // A module of an unknown type has no tile: it could be neither seen nor placed.
  const modules = doc.modules.filter(
    (m) => getModuleDef(m.type) && (ids.has(m.id) || groups.some((g) => containerOf(doc, m) === g.id)),
  );
  if (modules.length === 0 && groups.length === 0) return null;
  const copied = new Set(modules.map((m) => m.id));
  return {
    modules,
    cables: doc.cables.filter((c) => copied.has(c.from.module) && copied.has(c.to.module)),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

/** A clip's tiles at the size they have once pasted (a mixer copied without its cables is a small one), and its groups. */
function clipRects(clip: Clip): Rect[] {
  return [...clip.modules.flatMap((m) => rectOf(clip, m) ?? []), ...(clip.groups ?? []).map((g) => g.area)];
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
  const clipGroups = clip.groups ?? [];
  const rects = clipRects(clip);
  if (rects.length === 0) return { doc, ids: [] };
  const bounds = boundsOf(rects);
  const defs = modules.map((m) => getModuleDef(m.type)!);
  const moved = (r: Rect, cell: Cell) => ({ ...r, x: r.x - bounds.x + cell.x, y: r.y - bounds.y + cell.y });
  const at = nearestCell(near, (cell) => {
    // The groups land on nothing, and the modules where they may be with the groups there.
    const groups = clipGroups.map((g) => ({ ...g, area: moved(g.area, cell) }));
    if (!groups.every((g) => canPlaceGroupAt(doc, g.area))) return false;
    const there = { ...doc, groups: [...groupsOf(doc), ...groups] };
    return modules.every((m, i) => {
      const rect = moved(rectOf(clip, m)!, cell);
      return isFree(doc, rect) && allowedAt(there, defs[i], rect);
    });
  });
  if (!at) return { doc, ids: [] };

  const fresh = freeIds(doc, modules.length + clipGroups.length);
  const ids = fresh.slice(0, modules.length);
  const groupIds = fresh.slice(modules.length);
  const renamed = new Map(modules.map((m, i) => [m.id, ids[i]]));
  return {
    doc: {
      ...doc,
      ...(clipGroups.length > 0
        ? { groups: [...groupsOf(doc), ...clipGroups.map((g, i) => ({ ...g, id: groupIds[i], area: moved(g.area, at) }))] }
        : {}),
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
    ids: [...ids, ...groupIds],
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
  const bounds = boundsOf([...clip.modules.flatMap((m) => rectOf(doc, m) ?? []), ...(clip.groups ?? []).map((g) => g.area)]);
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

/** The containers a module is in, from the inside out: a unison group, and the voice area. */
function containersOf(doc: PatchDocument, module: ModuleInstance): string[] {
  const at = containerOf(doc, module);
  const group = groupsOf(doc).find((g) => g.id === at);
  if (group) return groupParent(doc, group) === MAIN ? [group.id] : [group.id, VOICES_NODE];
  return at !== null && at !== MAIN ? [VOICES_NODE] : [];
}

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
  // Each unison group is one object to Pd too, in the voices or outside them.
  const within = new Map(doc.modules.map((m) => [m.id, containersOf(doc, m)]));
  for (const container of [VOICES_NODE, ...groupsOf(doc).map((g) => g.id)]) {
    const node = (id: ModuleId) => (within.get(id)?.includes(container) ? container : id);
    const [a, b] = [node(from.module), node(to.module)];
    if (a !== b && reaches(doc, b, a, false, node)) {
      return container === VOICES_NODE
        ? "That would make a way out of the voice area and back into it: a feedback loop, since the voices are added up before anything outside them runs."
        : "That would make a way out of a unison group and back into it: a feedback loop, since its copies are added up before anything outside it runs.";
    }
  }
  return null;
}

/**
 * Move whatever module `id` overlaps to just below it (or just right of it), and whatever
 * those land on in turn. `id` itself stays where it is. Used when a tile has grown, and
 * when one is put into a row of tiles.
 *
 * Tiles push only those in the same container (the patch, the voice area or a unison
 * group), and a container grows to hold them; to the tiles beside it, a container is one
 * big tile, which they push along with what is in it and which pushes them in turn (see
 * `Boxes`). `container` says which `id` is in (it may lie across an edge now, having just
 * grown or been put there); without it, the one its top-left cell is in.
 */
export function makeRoom(doc: PatchDocument, id: ModuleId, direction: "down" | "right" = "down", container?: string): PatchDocument {
  const boxes = new Boxes(doc, { id, parent: container });
  if (!boxes.rects.has(id) || !boxes.push([{ key: id, ways: [direction] }], new Set([id]))) return doc;
  return boxes.apply(doc);
}

/** The smallest the voice area or a unison group can be: its border around a single cell. */
export const MIN_AREA = { width: 2 * AREA_BORDER + 1, height: 2 * AREA_BORDER + 1 };

/** The voice area, by the key that `moveContainer` and `resizeContainer` take for it. */
export const VOICE_AREA = AREA;

/** A container's rectangle: the voice area's (`VOICE_AREA`), or a group's by its id. */
export const containerRect = (doc: PatchDocument, key: string) =>
  key === AREA ? doc.voiceArea : groupsOf(doc).find((g) => g.id === key)?.area;

/**
 * Move a container (`VOICE_AREA`, or a unison group by its id) by `delta`, with what is in
 * it. Unchanged when it would land on a tile or a group that is not in it, or put a group
 * across the edge of the voice area. A group may move into the voices or out of them.
 */
export function moveContainer(doc: PatchDocument, key: string, delta: Cell): PatchDocument {
  if (delta.x === 0 && delta.y === 0 || !containerRect(doc, key)) return doc;
  const boxes = new Boxes(doc);
  if (!boxes.rects.has(key)) return doc;
  boxes.shift(key, delta);
  const rect = boxes.rects.get(key)!;
  for (const [other, box] of boxes.rects) {
    // The voice area a group is in is checked below: the group may lie in it or outside it.
    if (!boxes.moved.has(other) && other !== AREA && overlaps(rect, box)) return doc;
  }
  const next = boxes.apply(doc);
  return key === AREA || groupParent(next, { area: rect }) !== null ? next : doc;
}

/** Move the voice area by `delta`, with what is in it: see `moveContainer`. */
export const moveArea = (doc: PatchDocument, delta: Cell) => moveContainer(doc, AREA, delta);

/**
 * Give a container (`VOICE_AREA`, or a unison group by its id) other edges. What is beside
 * it that the new edges reach is pushed along with the border, each the shortest of the
 * ways it grew, and pushes what it lands on the same way; a group in the voices that grows
 * makes the voice area grow too. Unchanged when something in it would come onto the border
 * or out, when it would be smaller than `MIN_AREA`, or when what is pushed cannot go where
 * it may be.
 */
export function resizeContainer(doc: PatchDocument, key: string, area: Area): PatchDocument {
  const old = containerRect(doc, key);
  const next = { x: area.x, y: area.y, width: area.width, height: area.height };
  if (!old) return doc;
  const same = (["x", "y", "width", "height"] as const).every((k) => next[k] === old[k]);
  if (same || next.width < MIN_AREA.width || next.height < MIN_AREA.height) return doc;
  const boxes = new Boxes(doc);
  if (!boxes.rects.has(key)) return doc;
  for (const child of boxes.childrenOf(key)) if (!contains(interior(next), boxes.rects.get(child)!)) return doc;
  const ways: Way[] = [];
  if (next.x < old.x) ways.push("left");
  if (next.x + next.width > old.x + old.width) ways.push("right");
  if (next.y < old.y) ways.push("up");
  if (next.y + next.height > old.y + old.height) ways.push("down");
  Object.assign(boxes.rects.get(key)!, next);
  boxes.moved.add(key);
  if (!boxes.push([{ key, ways }], new Set([key]))) return doc;
  const resized = boxes.apply(doc);
  return layoutAllowed(resized) ? resized : doc;
}

/** Give the voice area other edges: see `resizeContainer`. */
export const resizeArea = (doc: PatchDocument, area: Area) => resizeContainer(doc, AREA, area);

/*
 * Unison groups. A group is added empty, from the module browser, and then holds what is
 * put in it; its header holds the number of copies.
 */

/** The size a new unison group has: its border round room for one oscillator. */
export const NEW_GROUP = { width: 4, height: 5 };

/** Whether a unison group could have these cells: on no tile and no other group, and in the voices or out of them. */
function canPlaceGroupAt(doc: PatchDocument, area: Area, skip?: string): boolean {
  if (groupParent(doc, { area }) === null) return false;
  if (groupsOf(doc).some((g) => g.id !== skip && overlaps(g.area, area))) return false;
  return doc.modules.every((m) => {
    const rect = rectOf(doc, m);
    return !rect || !overlaps(rect, area);
  });
}

/** Whether a new unison group fits with its top-left corner at `at`. */
export function canPlaceGroup(doc: PatchDocument, at: Cell): boolean {
  return canPlaceGroupAt(doc, { ...at, ...NEW_GROUP });
}

/** The free spot for a new unison group closest to `near`. */
export function findGroupCell(doc: PatchDocument, near: Cell): Cell {
  return nearestCell(near, (cell) => canPlaceGroup(doc, cell)) ?? near;
}

/** Add an empty unison group at `at`. Unchanged where it does not fit. */
export function addGroup(doc: PatchDocument, at: Cell): { doc: PatchDocument; id: ModuleId | null } {
  if (!canPlaceGroup(doc, at)) return { doc, id: null };
  const id = nextModuleId(doc);
  const group: UnisonGroup = { id, area: { ...at, ...NEW_GROUP }, size: DEFAULT_UNISON };
  return { doc: { ...doc, groups: [...groupsOf(doc), group] }, id };
}

/** Set how many copies a unison group runs: a whole number from `MIN_UNISON` to `MAX_UNISON`. */
export function setGroupSize(doc: PatchDocument, id: ModuleId, size: number): PatchDocument {
  const group = groupsOf(doc).find((g) => g.id === id);
  if (!group || !Number.isFinite(size)) return doc;
  const next = Math.min(MAX_UNISON, Math.max(MIN_UNISON, Math.round(size)));
  return next === group.size ? doc : { ...doc, groups: groupsOf(doc).map((g) => (g === group ? { ...g, size: next } : g)) };
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
  // output's, in the same container as it. A module that runs once is not pushed into the
  // voices or a group: it goes as near as there is room.
  if (holderOf(doc, host) !== TOP && def.place === "outside") return { at: findFreeCell(doc, type, beside), push: false, cables };
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
  // Pushed into a row, it is in the container its neighbour is in, which grows if need be.
  const host = doc.modules.find((m) => m.id === target.module)!;
  if (plan.push) next = makeRoom(next, id, "right", holderOf(doc, host));
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

/** Set how many notes play at once: a whole number from `MIN_VOICES` to `MAX_VOICES`. */
export function setVoices(doc: PatchDocument, voices: number): PatchDocument {
  if (!Number.isFinite(voices)) return doc;
  const next = Math.min(MAX_VOICES, Math.max(MIN_VOICES, Math.round(voices)));
  return next === doc.voices ? doc : { ...doc, voices: next };
}

/** Change how the voices play notes. */
export function setVoicing(doc: PatchDocument, change: Partial<Voicing>): PatchDocument {
  const current = voicingOf(doc);
  const wanted = { ...current, ...change };
  const next: Voicing = {
    mode: wanted.mode === "mono" ? "mono" : "poly",
    priority: NOTE_PRIORITIES.includes(wanted.priority) ? wanted.priority : current.priority,
    legato: !!wanted.legato,
  };
  const same = (Object.keys(next) as (keyof Voicing)[]).every((key) => next[key] === current[key]);
  return same ? doc : { ...doc, voicing: next };
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
