import { create } from "zustand";
import type { KnobSlot } from "../core/model/ops";
import type { Cable, PortRef } from "../core/model/types";
import type { Point, View } from "../ui/canvas/geometry";

/** A cable being dragged out of a port. */
export interface CableDrag {
  /** The port the drag started from (or, for a picked-up cable, its far end). */
  anchor: PortRef;
  anchorSide: "in" | "out";
  /** Loose end, in world coordinates. */
  cursor: Point;
  /** The existing cable this drag picked up; it is removed unless re-patched. */
  detached: Cable | null;
}

/** The panes that open at the sides of the window from the tabs of the top bar. */
export type SidePaneId = "presets" | "samples" | "organelle" | "problems";
export type PaneSide = "left" | "right";
/** Which side each pane opens on. One can be open on each side. */
export const PANE_SIDE: Record<SidePaneId, PaneSide> = { presets: "left", samples: "right", organelle: "right", problems: "right" };

interface UiState {
  view: View;
  /** Size of the canvas viewport in screen pixels. */
  viewport: { width: number; height: number };
  /** Module type being dragged in from the palette. */
  placing: string | null;
  cableDrag: CableDrag | null;
  /** The knob page shown in the Knob pages panel, 0 to 7; its knobs are ringed on the tiles. */
  knobPage: number;
  /**
   * The Organelle knob waiting for a setting: the next knob clicked on the grid goes on
   * it. See `state/assign.ts`.
   */
  assigning: KnobSlot | null;
  /** The pane that is open at each side of the window (see `ui/shell/SidePanes.tsx`), or `null`. */
  sidePanes: Record<PaneSide, SidePaneId | null>;
  setView(view: View): void;
}

export const useUi = create<UiState>((set) => ({
  view: { panX: 60, panY: 50, zoom: 1 },
  viewport: { width: 0, height: 0 },
  placing: null,
  cableDrag: null,
  knobPage: 0,
  assigning: null,
  // The editor starts with the presets to pick from.
  sidePanes: { left: "presets", right: null },
  setView: (view) => set({ view }),
}));

/**
 * Where the pointer is over the grid, in pixels from the top-left corner of the canvas,
 * or `null` while it is somewhere else. It is not in the store: it changes with every
 * move and nothing is drawn from it. Paste reads it.
 */
export const gridPointer: { at: Point | null } = { at: null };

/** Open a side pane, in place of whatever is open on its side. */
export const showSidePane = (id: SidePaneId) =>
  useUi.setState((s) => ({ sidePanes: { ...s.sidePanes, [PANE_SIDE[id]]: id } }));

