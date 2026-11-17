import type { Cell } from "../../core/model/ops";
import type { ModuleInstance } from "../../core/model/types";
import type { ModuleDef } from "../../core/modules/types";

/** One grid cell, in canvas pixels at zoom 1. */
export const CELL = 76;
/** Space between a tile and the edge of its cells. */
export const TILE_INSET = 2;
/** Centre of the first port below the top of a tile. */
export const PORT_TOP = 36;
export const PORT_GAP = 20;
/** Port centre, measured in from the tile's left or right edge. */
export const PORT_INSET = 11;

export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2;

export interface Point {
  x: number;
  y: number;
}

export interface View {
  /** Canvas-space offset of the world origin, in screen pixels. */
  panX: number;
  panY: number;
  zoom: number;
}

export function tileRect(module: Pick<ModuleInstance, "x" | "y">, def: Pick<ModuleDef, "width" | "height">) {
  return {
    left: module.x * CELL + TILE_INSET,
    top: module.y * CELL + TILE_INSET,
    width: def.width * CELL - TILE_INSET * 2,
    height: def.height * CELL - TILE_INSET * 2,
  };
}

/** World position of a port's centre. */
export function portPosition(
  module: Pick<ModuleInstance, "x" | "y">,
  def: ModuleDef,
  side: "in" | "out",
  index: number,
): Point {
  const rect = tileRect(module, def);
  return {
    x: side === "in" ? rect.left + PORT_INSET : rect.left + rect.width - PORT_INSET,
    y: rect.top + PORT_TOP + index * PORT_GAP,
  };
}

export function screenToWorld(view: View, viewport: DOMRect, clientX: number, clientY: number): Point {
  return {
    x: (clientX - viewport.left - view.panX) / view.zoom,
    y: (clientY - viewport.top - view.panY) / view.zoom,
  };
}

export function worldToCell(point: Point): Cell {
  return { x: Math.floor(point.x / CELL), y: Math.floor(point.y / CELL) };
}

/** Top-left cell that centres a `def`-sized tile on `point`. */
export function cellCentredOn(point: Point, def: Pick<ModuleDef, "width" | "height">): Cell {
  return {
    x: Math.round(point.x / CELL - def.width / 2),
    y: Math.round(point.y / CELL - def.height / 2),
  };
}

/** A cable's curve: leaves the output heading right, arrives at the input from the left. */
export function cablePath(from: Point, to: Point): string {
  const reach = Math.max(28, Math.min(160, Math.abs(to.x - from.x) * 0.5 + Math.abs(to.y - from.y) * 0.15));
  return `M ${from.x} ${from.y} C ${from.x + reach} ${from.y}, ${to.x - reach} ${to.y}, ${to.x} ${to.y}`;
}
