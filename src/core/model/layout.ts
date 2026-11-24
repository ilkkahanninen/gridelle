import { getModuleDef } from "../modules/registry";
import { contains, containerAt, groupParent, groupsOf, interior, MAIN, overlaps, tileArea } from "./area";
import type { Area, ModuleId, ModuleInstance, PatchDocument } from "./types";

/*
 * The tiles, the unison groups and the voice area as boxes in boxes, for the edits that move
 * several of them at once: making room by pushing tiles aside, and moving or resizing a
 * container. Every box is in a container: the patch (`TOP`), the voice area (`AREA`) or a
 * unison group. A box pushes only the boxes in the same container as it; a container grows,
 * right and down, to hold what was pushed in it, and then pushes the boxes beside it in turn.
 * A box that moves takes what is in it along.
 */

/** The patch, as the container of the boxes in no other. No module or group id is this. */
export const TOP = "top";
/** The voice area, as a box. */
export const AREA = "area";

export type Way = "left" | "right" | "up" | "down";

interface Cell {
  x: number;
  y: number;
}

/** How far `rect` has to move `way` to be clear of `by`. */
export function clearOf(by: Area, rect: Area, way: Way): Cell {
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

/** The container of a box of these cells: the group or the voice area whose inside holds it, or the patch. */
function holderAt(doc: Pick<PatchDocument, "voiceArea" | "groups">, rect: Area, groups = true): string {
  if (groups) for (const group of groupsOf(doc)) if (contains(interior(group.area), rect)) return group.id;
  const area = doc.voiceArea;
  return area.width > 0 && area.height > 0 && contains(interior(area), rect) ? AREA : TOP;
}

/**
 * The box a module is in, as `makeRoom` takes it: by its top-left cell, since a tile that
 * has just grown or been put down may lie across an edge.
 */
export function holderOf(doc: PatchDocument, module: ModuleInstance): string {
  const rect = tileArea(doc, module);
  return rect ? holderAt(doc, { x: rect.x, y: rect.y, width: 1, height: 1 }) : TOP;
}

export class Boxes {
  readonly rects = new Map<string, Area>();
  readonly moved = new Set<string>();
  private readonly parents = new Map<string, string>();
  /** The boxes that are containers: the voice area and the groups. */
  readonly containers = new Set<string>();

  /** `start` is a module whose container is given (or found from its top-left cell): see `holderOf`. */
  constructor(doc: PatchDocument, start?: { id: ModuleId; parent?: string }) {
    const area = doc.voiceArea;
    if (area.width > 0 && area.height > 0) {
      this.rects.set(AREA, { ...area });
      this.parents.set(AREA, TOP);
      this.containers.add(AREA);
    }
    for (const group of groupsOf(doc)) {
      this.rects.set(group.id, { ...group.area });
      this.parents.set(group.id, holderAt(doc, group.area, false));
      this.containers.add(group.id);
    }
    for (const module of doc.modules) {
      const rect = tileArea(doc, module);
      if (!rect) continue;
      this.rects.set(module.id, { ...rect });
      const corner = { x: rect.x, y: rect.y, width: 1, height: 1 };
      this.parents.set(module.id, module.id === start?.id ? (start.parent ?? holderAt(doc, corner)) : holderAt(doc, rect));
    }
  }

  parentOf(key: string): string {
    return this.parents.get(key) ?? TOP;
  }

  childrenOf(key: string): string[] {
    return [...this.parents].flatMap(([child, parent]) => (parent === key ? [child] : []));
  }

  /** Put a box in another container, as a tile moved into a group is. */
  setParent(key: string, parent: string): void {
    this.parents.set(key, parent);
  }

  /** Move a box, and all that is in it, by `by`; never one of `fixed`. */
  shift(key: string, by: Cell, fixed: ReadonlySet<string> = new Set()): void {
    if (fixed.has(key)) return;
    const rect = this.rects.get(key)!;
    rect.x += by.x;
    rect.y += by.y;
    this.moved.add(key);
    for (const child of this.childrenOf(key)) this.shift(child, by, fixed);
  }

  /**
   * Grow a container to hold all that is in it, its border moving out on whichever side
   * something lies past it. The ways it grew.
   */
  fit(key: string): Way[] {
    const rect = this.rects.get(key)!;
    const ways = new Set<Way>();
    for (const child of this.childrenOf(key)) {
      let inner = interior(rect);
      const box = this.rects.get(child)!;
      if (box.x < inner.x) {
        rect.width += inner.x - box.x;
        rect.x -= inner.x - box.x;
        ways.add("left");
        inner = interior(rect);
      }
      if (box.y < inner.y) {
        rect.height += inner.y - box.y;
        rect.y -= inner.y - box.y;
        ways.add("up");
        inner = interior(rect);
      }
      if (box.x + box.width > inner.x + inner.width) {
        rect.width += box.x + box.width - (inner.x + inner.width);
        ways.add("right");
      }
      if (box.y + box.height > inner.y + inner.height) {
        rect.height += box.y + box.height - (inner.y + inner.height);
        ways.add("down");
      }
    }
    if (ways.size > 0) this.moved.add(key);
    return [...ways];
  }

  /**
   * Push boxes apart from `starts`: each pusher moves the boxes in its container that it lies
   * on, each the shortest of its ways, and those push on in turn; a container that grows to
   * hold what was pushed in it pushes too. `fixed` never moves. A pushed box ends up past its
   * pusher, so one way alone always ends; two at once (a corner) could in principle go round,
   * so the steps are counted, and `false` says it did not settle.
   */
  push(starts: { key: string; ways: Way[] }[], fixed: ReadonlySet<string>): boolean {
    const queue = [...starts];
    const size = (by: Cell) => Math.abs(by.x) + Math.abs(by.y);
    for (let steps = 0; queue.length > 0; steps++) {
      if (steps > 64 * (this.rects.size + 1)) return false;
      const { key, ways } = queue.shift()!;
      const pusher = this.rects.get(key)!;
      const parent = this.parentOf(key);
      if (ways.length > 0) {
        for (const other of this.childrenOf(parent)) {
          if (other === key || fixed.has(other)) continue;
          const rect = this.rects.get(other)!;
          if (!overlaps(pusher, rect)) continue;
          const way = ways.reduce((best, w) => (size(clearOf(pusher, rect, w)) < size(clearOf(pusher, rect, best)) ? w : best));
          this.shift(other, clearOf(pusher, rect, way), fixed);
          queue.push({ key: other, ways: [way] });
        }
      }
      if (parent !== TOP) {
        const grown = this.fit(parent);
        if (grown.length > 0) queue.push({ key: parent, ways: grown });
      }
    }
    return true;
  }

  /** The document with its boxes where they are now; the same one when none moved. */
  apply(doc: PatchDocument): PatchDocument {
    if (this.moved.size === 0) return doc;
    const at = (key: string) => this.rects.get(key)!;
    return {
      ...doc,
      voiceArea: this.moved.has(AREA) ? { ...at(AREA) } : doc.voiceArea,
      ...(doc.groups ? { groups: doc.groups.map((g) => (this.moved.has(g.id) ? { ...g, area: { ...at(g.id) } } : g)) } : {}),
      modules: doc.modules.map((m) => (this.moved.has(m.id) ? { ...m, x: at(m.id).x, y: at(m.id).y } : m)),
    };
  }
}

/**
 * Whether every tile and group is where it may be: a group in the voice area or out of it
 * and clear of the others, a tile clear of every border, and one that runs once outside
 * the voices and the groups.
 */
export function layoutAllowed(doc: PatchDocument): boolean {
  const groups = groupsOf(doc);
  for (const group of groups) {
    if (groupParent(doc, group) === null) return false;
    if (groups.some((other) => other !== group && overlaps(other.area, group.area))) return false;
  }
  return doc.modules.every((m) => {
    const rect = tileArea(doc, m);
    if (!rect) return true;
    const at = containerAt(doc, rect);
    return at !== null && !(at !== MAIN && getModuleDef(m.type)?.place === "outside");
  });
}
