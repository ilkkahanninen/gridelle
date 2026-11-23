import { describe, expect, it } from "vitest";
import { viewShowing, type View } from "./geometry";

describe("bringing a part of the grid into view", () => {
  const view: View = { panX: 0, panY: 0, zoom: 1 };
  const viewport = { width: 1000, height: 500 };
  const rect = (left: number, top: number, width = 100, height = 100) => ({ left, top, width, height });
  /** Where a rectangle is on the screen in a view: left, top, right, bottom. */
  const onScreen = (v: View, r: ReturnType<typeof rect>) => [
    r.left * v.zoom + v.panX,
    r.top * v.zoom + v.panY,
    (r.left + r.width) * v.zoom + v.panX,
    (r.top + r.height) * v.zoom + v.panY,
  ];

  it("leaves the view alone when it is on show", () => {
    expect(viewShowing(view, viewport, rect(400, 200))).toBe(view);
  });

  it("moves no further than it takes", () => {
    const below = viewShowing(view, viewport, rect(400, 600));
    expect(below.panX).toBe(0);
    expect(onScreen(below, rect(400, 600))[3]).toBe(500 - 24);
    const left = viewShowing(view, viewport, rect(-300, 200));
    expect(left.panY).toBe(0);
    expect(onScreen(left, rect(-300, 200))[0]).toBe(24);
  });

  it("counts the zoom", () => {
    const zoomed = { ...view, zoom: 2 };
    const moved = viewShowing(zoomed, viewport, rect(500, 100));
    expect(onScreen(moved, rect(500, 100))[2]).toBe(1000 - 24);
    expect(moved.zoom).toBe(2);
  });

  it("shows what does not fit from its top-left corner", () => {
    const tall = rect(400, 300, 100, 2000);
    expect(onScreen(viewShowing(view, viewport, tall), tall).slice(0, 2)).toEqual([400, 24]);
  });

  it("does nothing before the canvas has been measured", () => {
    expect(viewShowing(view, { width: 0, height: 0 }, rect(5000, 5000))).toBe(view);
  });
});
