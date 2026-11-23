/**
 * Edits to a patch document. Every function returns a new document (or the same
 * one when nothing changed) and never mutates its input, so undo history can keep
 * old documents around cheaply.
 */

import { getModuleDef } from "../modules/registry";
import { clampParam } from "../modules/params";
import { visibleDef } from "../modules/shape";
import type { ModuleDef } from "../modules/types";
import {
  KNOBS_PER_PAGE,
  MAX_MODULE_NAME,
  MAX_PAGES,
  MAX_TAPE_SECONDS,
  SAMPLE_SLOTS,
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

interface Rect extends Cell {
  width: number;
  height: number;
}

/** The cells a module covers, at the size it currently shows (a mixer grows with its cables). */
function rectOf(doc: Pick<PatchDocument, "cables">, module: ModuleInstance, at: Cell = module): Rect | null {
  const def = visibleDef(doc, module);
  return def ? { x: at.x, y: at.y, width: def.width, height: def.height } : null;
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

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

/** Whether a new module of `type` fits with its top-left corner at `at`. */
export function canPlace(doc: PatchDocument, type: string, at: Cell): boolean {
  const def = getModuleDef(type);
  return !!def && isFree(doc, { ...at, width: def.width, height: def.height });
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
  return { ...doc, modules: [...doc.modules, { id, type, x: at.x, y: at.y, params: {} }] };
}

/** Whether the modules `ids` can all shift by `delta` without landing on another module. */
export function canMove(doc: PatchDocument, ids: ReadonlySet<ModuleId>, delta: Cell): boolean {
  return doc.modules.every((m) => {
    if (!ids.has(m.id)) return true;
    const rect = rectOf(doc, m, { x: m.x + delta.x, y: m.y + delta.y });
    return !rect || isFree(doc, rect, ids);
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
  const at = nearestCell(near, (cell) =>
    rects.every((r) => isFree(doc, { ...r, x: r.x - bounds.x + cell.x, y: r.y - bounds.y + cell.y })),
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

function hasPort(doc: PatchDocument, ref: PortRef, side: "inputs" | "outputs"): boolean {
  const module = doc.modules.find((m) => m.id === ref.module);
  return !!module && !!getModuleDef(module.type)?.[side].some((p) => p.id === ref.port);
}

/** Whether `to` is reachable from `from` by following cables downstream. */
function reaches(doc: PatchDocument, from: ModuleId, to: ModuleId): boolean {
  const seen = new Set<ModuleId>();
  const pending = [from];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const cable of doc.cables) if (cable.from.module === id) pending.push(cable.to.module);
  }
  return false;
}

/** Why a cable from output `from` to input `to` cannot be made, or `null` if it can. */
export function connectionProblem(doc: PatchDocument, from: PortRef, to: PortRef): string | null {
  if (!hasPort(doc, from, "outputs") || !hasPort(doc, to, "inputs")) return "That port does not exist.";
  if (reaches(doc, to.module, from.module)) return "That would create a feedback loop, which is not supported yet.";
  return null;
}

/**
 * Move whatever module `id` overlaps to just below it (or just right of it), and whatever
 * those land on in turn. `id` itself stays where it is. Used when a tile has grown, and
 * when one is put into a row of tiles.
 */
export function makeRoom(doc: PatchDocument, id: ModuleId, direction: "down" | "right" = "down"): PatchDocument {
  const rects = new Map<ModuleId, Rect>();
  for (const module of doc.modules) {
    const rect = rectOf(doc, module);
    if (rect) rects.set(module.id, rect);
  }
  if (!rects.has(id)) return doc;

  // A pushed module ends up past its pusher and can never push it back, so this ends.
  const moved = new Set<ModuleId>();
  const pushers = [id];
  while (pushers.length > 0) {
    const pusher = rects.get(pushers.shift()!)!;
    for (const [otherId, other] of rects) {
      if (otherId === id || other === pusher || !overlaps(pusher, other)) continue;
      if (direction === "down") other.y = pusher.y + pusher.height;
      else other.x = pusher.x + pusher.width;
      moved.add(otherId);
      pushers.push(otherId);
    }
  }
  if (moved.size === 0) return doc;
  return {
    ...doc,
    modules: doc.modules.map((m) => (moved.has(m.id) ? { ...m, x: rects.get(m.id)!.x, y: rects.get(m.id)!.y } : m)),
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
  // Into the row: in front of the module whose input it was dropped on, or right after the output's.
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
  if (plan.push) next = makeRoom(next, id, "right");
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
  const next: SampleSlot | null =
    sample?.kind === "tape" ? { kind: "tape", seconds: Math.min(MAX_TAPE_SECONDS, Math.max(0.1, sample.seconds || 0)) } : sample;
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
