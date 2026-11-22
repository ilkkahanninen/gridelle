import { describe, expect, it } from "vitest";
import { moduleDefs } from "../../core/modules/registry";
import { GLYPHS } from "./glyphs";

describe("module browser glyphs", () => {
  it.each(moduleDefs.map((def) => def.type))("%s has a picture on its card", (type) => {
    expect(GLYPHS[type]).toMatch(/^M/);
  });

  it("has none left over from a module that no longer exists", () => {
    const types = new Set(moduleDefs.map((def) => def.type));
    expect(Object.keys(GLYPHS).filter((type) => !types.has(type))).toEqual([]);
  });
});
