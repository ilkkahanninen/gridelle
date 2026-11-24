import { visibleDef } from "../modules/shape";
import type { Area, ModuleInstance, PatchDocument, PortRef } from "./types";

/*
 * The voice area. A patch runs in two places: once for all of it, and once in every voice.
 * Which one a module runs in is where its tile lies: inside the voice area, it is copied
 * into every voice; outside, it runs once. So a patch reads from left to right as what
 * comes before the voices (an arpeggiator, an LFO they share), the voices, and what comes
 * after them (master effects, the output). A cable that crosses the edge inward gives every
 * voice the same signal; one that crosses it outward adds the voices up.
 */

/**
 * The voice area's own input, on the left of its header: the notes the voices are given,
 * one to each voice. Unpatched it gets the keyboard's; a cable from a note output (an
 * arpeggiator's) gives it those instead. `voices` is no module id, so it cannot clash.
 */
export const VOICE_NOTES: PortRef = { module: "voices", port: "notes" };

export const isVoiceNotes = (ref: PortRef) => ref.module === VOICE_NOTES.module && ref.port === VOICE_NOTES.port;

/**
 * The voice area's border: a ring of whole cells round its inside, where no tile goes, so
 * that inside and outside never touch. Its top row is the header.
 */
export const AREA_BORDER = 1;
/** Rows at the top of the voice area that are its header: the top of its border. */
export const AREA_HEADER = AREA_BORDER;

/** Where a module's tile lies: in the voice area, outside it, or across its edge. */
export type Placement = "inside" | "outside" | "across";

export const overlaps = (a: Area, b: Area) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

export const contains = (outer: Area, inner: Area) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/** The part of the voice area that tiles can lie in: all of it but its border. */
export const interior = (area: Area): Area => ({
  x: area.x + AREA_BORDER,
  y: area.y + AREA_BORDER,
  width: area.width - 2 * AREA_BORDER,
  height: area.height - 2 * AREA_BORDER,
});

/** The cells a module's tile covers, at the size it shows (a mixer grows with its cables). */
export function tileArea(doc: Pick<PatchDocument, "cables">, module: ModuleInstance, at: { x: number; y: number } = module): Area | null {
  const def = visibleDef(doc, module);
  return def ? { x: at.x, y: at.y, width: def.width, height: def.height } : null;
}

/** Where a tile of these cells would lie: `across` is on the border. */
export function placementOf(area: Area, tile: Area): Placement {
  if (contains(interior(area), tile)) return "inside";
  return overlaps(area, tile) ? "across" : "outside";
}

/** Where a module's tile lies; `null` for a module of a type that does not exist. */
export function placement(doc: Pick<PatchDocument, "cables" | "voiceArea">, module: ModuleInstance): Placement | null {
  const tile = tileArea(doc, module);
  return tile && placementOf(doc.voiceArea, tile);
}
