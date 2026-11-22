/**
 * Edits to a patch document. Every function returns a new document (or the same
 * one when nothing changed) and never mutates its input, so undo history can keep
 * old documents around cheaply.
 */

import { getModuleDef } from "../modules/registry";
import { clampParam } from "../modules/params";
import { visibleDef } from "../modules/shape";
import {
  KNOBS_PER_PAGE,
  MAX_PAGES,
  type Cable,
  type KnobAssignment,
  type ModuleId,
  type ModuleInstance,
  type PatchDocument,
  type PortRef,
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
function rectOf(doc: PatchDocument, module: ModuleInstance, at: Cell = module): Rect | null {
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

/** Smallest unused `ge<n>` id. */
export function nextModuleId(doc: PatchDocument): ModuleId {
  const used = new Set(doc.modules.map((m) => m.id));
  for (let n = 1; ; n++) if (!used.has(`ge${n}`)) return `ge${n}`;
}

/** Whether a new module of `type` fits with its top-left corner at `at`. */
export function canPlace(doc: PatchDocument, type: string, at: Cell): boolean {
  const def = getModuleDef(type);
  return !!def && isFree(doc, { ...at, width: def.width, height: def.height });
}

/** The free spot for `type` closest to `near`, searching outwards in rings. */
export function findFreeCell(doc: PatchDocument, type: string, near: Cell): Cell {
  for (let radius = 0; radius < 200; radius++) {
    let best: Cell | null = null;
    let bestDistance = Infinity;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cell = { x: near.x + dx, y: near.y + dy };
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance && canPlace(doc, type, cell)) {
          best = cell;
          bestDistance = distance;
        }
      }
    }
    if (best) return best;
  }
  return near;
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
    pages: doc.pages.map((page) => ({
      ...page,
      knobs: page.knobs.map((k) => (k && ids.has(k.module) ? null : k)),
    })),
  };
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

/** Current value of a parameter, falling back to its default. */
export function paramValue(module: ModuleInstance, param: string): number {
  const def = getModuleDef(module.type)?.params.find((p) => p.id === param);
  return module.params[param] ?? def?.default ?? 0;
}

/** Add an empty knob page at the end. Does nothing once the page limit is reached. */
export function addPage(doc: PatchDocument, name = `Page ${doc.pages.length + 1}`): PatchDocument {
  if (doc.pages.length >= MAX_PAGES) return doc;
  return { ...doc, pages: [...doc.pages, { name, knobs: Array(KNOBS_PER_PAGE).fill(null) }] };
}

export function removePage(doc: PatchDocument, index: number): PatchDocument {
  if (!doc.pages[index]) return doc;
  return { ...doc, pages: doc.pages.filter((_, i) => i !== index) };
}

export function renamePage(doc: PatchDocument, index: number, name: string): PatchDocument {
  if (!doc.pages[index] || doc.pages[index].name === name) return doc;
  return { ...doc, pages: doc.pages.map((page, i) => (i === index ? { ...page, name } : page)) };
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
  const page = doc.pages[slot.page];
  if (!page || slot.knob < 0 || slot.knob >= KNOBS_PER_PAGE) return doc;
  if (assignment) {
    const module = doc.modules.find((m) => m.id === assignment.module);
    if (!module || !getModuleDef(module.type)?.params.some((p) => p.id === assignment.param)) return doc;
  }
  const current = page.knobs[slot.knob];
  if (current?.module === assignment?.module && current?.param === assignment?.param) return doc;
  const isMoved = (k: KnobAssignment | null) =>
    !!k && !!assignment && k.module === assignment.module && k.param === assignment.param;
  return {
    ...doc,
    pages: doc.pages.map((p, pageIndex) => ({
      ...p,
      knobs: p.knobs.map((k, knobIndex) =>
        pageIndex === slot.page && knobIndex === slot.knob ? assignment : isMoved(k) ? null : k,
      ),
    })),
  };
}

/** Put a parameter on the first free knob, adding a page if every knob is taken. */
export function assignToFreeKnob(doc: PatchDocument, assignment: KnobAssignment): PatchDocument {
  for (const [page, { knobs }] of doc.pages.entries()) {
    const knob = knobs.indexOf(null);
    if (knob >= 0) return assignKnob(doc, { page, knob }, assignment);
  }
  const withPage = addPage(doc);
  if (withPage === doc) return doc;
  return assignKnob(withPage, { page: withPage.pages.length - 1, knob: 0 }, assignment);
}

/** Take a parameter off whatever knob it is on. */
export function unassign(doc: PatchDocument, module: ModuleId, param: string): PatchDocument {
  const slot = findAssignment(doc, module, param);
  return slot ? assignKnob(doc, slot, null) : doc;
}
