import { describe, expect, it } from "vitest";
import { compile } from "./compiler";
import { abstractionLibrary } from "./pdlib";
import { EXAMPLE_PRESETS, NEW_PATCH_NAME, presetFileName } from "./presets";

describe("the presets that come with the editor", () => {
  it("include the one a new patch is a copy of, each under a name of its own", () => {
    const names = EXAMPLE_PRESETS.map((p) => p.name);
    expect(names).toContain(NEW_PATCH_NAME);
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(EXAMPLE_PRESETS.map((p) => [p.name, p] as const))("%s is saved under its patch's name, as it is", (_name, preset) => {
    // The file is named as saving the patch would name it, so that saving it again is saving that file.
    expect(preset.name).toBe(preset.doc.name);
    expect(presetFileName(preset.doc.name)).toBe(preset.name);
  });

  it.each(EXAMPLE_PRESETS.map((p) => [p.name, p.doc] as const))("%s compiles as it is, and needs no sound file", (_name, doc) => {
    const result = compile(doc, abstractionLibrary);
    expect(result.diagnostics).toEqual([]);
    expect(result.samples).toEqual([]);
  });
});

describe("a preset's file name", () => {
  it("is the patch's name where that can be a file name", () => {
    for (const name of ["Tape Echo", "Säkkijärven polkka #2!", "It's (mine) & yours, v1.2", "a"]) {
      expect(presetFileName(name)).toBe(name);
    }
  });

  it("loses what a file name cannot hold", () => {
    expect(presetFileName("Bass / Lead")).toBe("Bass Lead");
    expect(presetFileName("a\\b:c*d?e\"f<g>h|i")).toBe("a b c d e f g h i");
    expect(presetFileName("  spaced   out  ")).toBe("spaced out");
    expect(presetFileName("line\nbreak\ttab")).toBe("line break tab");
    expect(presetFileName("..hidden")).toBe("hidden");
    expect(presetFileName("ends...")).toBe("ends");
    expect(presetFileName(". . mixed . .")).toBe("mixed");
    expect(presetFileName("../../escape")).toBe("escape");
  });

  it("is Untitled when nothing is left", () => {
    for (const name of ["", "   ", "...", "///", ". / ."]) expect(presetFileName(name)).toBe("Untitled");
  });

  it("is no longer than 80 characters, and does not end in a space for being cut", () => {
    expect(presetFileName("x".repeat(200))).toBe("x".repeat(80));
    expect(presetFileName(`${"x".repeat(79)} yz`)).toBe("x".repeat(79));
    // Characters, not bytes or halves of one.
    expect([...presetFileName("🎹".repeat(100))]).toHaveLength(80);
  });

  it("is the same for a name however its accents are stored", () => {
    expect(presetFileName("Ääni")).toBe("Ääni");
  });
});
