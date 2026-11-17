import { create } from "zustand";
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
  setView(view: View): void;
}

export const useUi = create<UiState>((set) => ({
  view: { panX: 60, panY: 50, zoom: 1 },
  viewport: { width: 0, height: 0 },
  placing: null,
  cableDrag: null,
  setView: (view) => set({ view }),
}));
