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
    // A capitalised word inside a sentence is the name of something: one of this module's
    // ports or settings, or one of the few other names below. Anything else is a name
    // the module no longer has, or never had.
    const own = new Set([...def.inputs, ...def.outputs, ...def.params].flatMap((p) => p.label.split(" ")));
    const strangers = [...MODULE_DOCS[def.type].matchAll(/(?<=[a-z,;:] )[A-Z][A-Za-z]*\b/g)]
      .map((match) => match[0])
      .filter((word) => !own.has(word) && !OTHER_NAMES.has(word));
    expect(strangers).toEqual([]);
  });
});

/** Names the texts use that are not ports or settings: products, people, other modules. */
const OTHER_NAMES = new Set(["Organelle", "Pd", "Moog", "LFO", "Soft", "Clip", "Room", "Recorder", "Amp", "Sequencer", "Samples", "C"]);
