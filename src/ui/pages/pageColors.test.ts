import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_PAGES } from "../../core/model/types";

const css = readFileSync(new URL("../../App.css", import.meta.url), "utf8");

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio of two #rrggbb colours. */
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const pages = [...css.matchAll(/\.page-color-(\d) \{ --page: (#[0-9a-f]{6}); --page-ink: (#[0-9a-f]{6}); \}/g)].map(
  ([, index, fill, ink]) => ({ index: Number(index), fill, ink }),
);
const variable = (name: string) => css.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))![1];

describe("knob page colours", () => {
  it("has one for every page a patch can have", () => {
    expect(pages.map((p) => p.index)).toEqual(Array.from({ length: MAX_PAGES }, (_, i) => i));
    expect(new Set(pages.map((p) => p.fill)).size).toBe(MAX_PAGES);
  });

  it.each(pages)("page $index: the knob number reads on its badge", ({ fill, ink }) => {
    expect(contrast(fill, ink)).toBeGreaterThan(4.5);
  });

  it.each(pages)("page $index: the badge stands out from a tile and from the dock", ({ fill }) => {
    expect(contrast(fill, variable("tile"))).toBeGreaterThan(3);
    expect(contrast(fill, variable("chrome"))).toBeGreaterThan(3);
  });
});
