import { describe, expect, it } from "vitest";
import { MODULE_DOCS } from "./docs";
import { moduleDefs } from "./registry";

describe("module documentation", () => {
  it("has an entry for every module, and for nothing else", () => {
    expect(Object.keys(MODULE_DOCS).sort()).toEqual(moduleDefs.map((def) => def.type).sort());
  });

  it.each(moduleDefs.map((def) => [def.name, def] as const))("%s: is a few whole sentences", (_name, def) => {
    const text = MODULE_DOCS[def.type];
    expect(text).toMatch(/^[A-Z].*\.$/);
    expect(text).toBe(text.trim());
    // The settings pane has room for a short paragraph.
    expect(text.length).toBeLessThanOrEqual(320);
  });

  it.each(moduleDefs.map((def) => [def.name, def] as const))("%s: names only ports and settings it has", (_name, def) => {
    // A capitalised word inside a sentence that is the name of a port or setting of some
    // module must be one of this module's.
    const labels = (d: (typeof moduleDefs)[number]) => [...d.inputs, ...d.outputs, ...d.params].map((p) => p.label);
    const all = new Set(moduleDefs.flatMap(labels));
    const own = new Set(labels(def));
    const text = MODULE_DOCS[def.type];
    const elsewhere = [...text.matchAll(/(?<=[a-z,;:] )[A-Z][A-Za-z]*\b/g)]
      .map((match) => match[0])
      .filter((word) => all.has(word) && !own.has(word));
    expect(elsewhere).toEqual([]);
  });
});
