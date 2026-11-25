import { describe, expect, it } from "vitest";
import { meterSegments, nextPeaks, SEGMENTS, SILENT } from "./meters";

describe("the level meters", () => {
  it("light segments as the device does", () => {
    // Input: sqrt(peak) * 14 - 2; output: sqrt(peak) * 12; whole numbers, 0 to 11.
    expect(meterSegments([1, 0.25, 1, 0.25])).toEqual([SEGMENTS, 5, SEGMENTS, 6]);
    expect(meterSegments([0.01, 0, 0.01, 0])).toEqual([0, 0, 1, 0]);
    expect(meterSegments([4, 4, 4, 4])).toEqual([SEGMENTS, SEGMENTS, SEGMENTS, SEGMENTS]);
    expect(meterSegments(SILENT)).toEqual([0, 0, 0, 0]);
  });

  it("hold a peak and let it fall over 300 ms", () => {
    let held = nextPeaks(SILENT, [0, 0, 1, 0]);
    expect(held).toEqual([0, 0, 1, 0]);
    held = nextPeaks(held, SILENT);
    expect(held[2]).toBeCloseTo(Math.exp(-1 / 3));
    // A higher reading takes over at once.
    expect(nextPeaks(held, [0, 0, 0.9, 0.5])[2]).toBe(0.9);
    for (let i = 0; i < 30; i++) held = nextPeaks(held, SILENT);
    expect(meterSegments(held)).toEqual([0, 0, 0, 0]);
  });
});
