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

interface UiState {
  view: View;
  /** Size of the canvas viewport in screen pixels. */
  viewport: { width: number; height: number };
  /** Module type being dragged in from the palette. */
  placing: string | null;
  cableDrag: CableDrag | null;
  /**
   * The knob page shown in the Knob pages panel; its knobs are ringed on the tiles. It may
   * point past the last page after one is removed: use `shownKnobPage`.
   */
  knobPage: number;
  /**
   * The Organelle knob waiting for a setting: the next knob clicked on the grid goes on
   * it. See `state/assign.ts`.
   */
  assigning: KnobSlot | null;
  setView(view: View): void;
}

export const useUi = create<UiState>((set) => ({
  view: { panX: 60, panY: 50, zoom: 1 },
  viewport: { width: 0, height: 0 },
  placing: null,
  cableDrag: null,
  knobPage: 0,
  assigning: null,
  setView: (view) => set({ view }),
}));

/** The index of the knob page on show, given how many pages the patch has (-1 for none). */
export const shownKnobPage = (knobPage: number, pageCount: number) => Math.min(knobPage, pageCount - 1);
