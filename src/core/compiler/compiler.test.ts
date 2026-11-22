import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { basicSynth, fixtures, sharedFilter } from "../fixtures";
import { DOCUMENT_VERSION, type PatchDocument } from "../model/types";
import { objectBoxes, objectClasses } from "../pd/inspect";
import { VANILLA_049_OBJECTS } from "../pd/vanilla049";
import { abstractionLibrary } from "../pdlib";
import { compile } from "./index";

/** Compiled fixtures live here as complete Organelle patch folders; Rust tests load them into Pd. */
const GOLDEN = resolve(import.meta.dirname, "../../../tests/golden");

const doc = (patch: Partial<PatchDocument>): PatchDocument => ({
  version: DOCUMENT_VERSION,
  name: "Test",
  voices: 2,
  modules: [],
  cables: [],
  pages: [],
  ...patch,
});

const codes = (d: PatchDocument) => compile(d, abstractionLibrary).diagnostics.map((x) => x.code);

describe("compile", () => {
  describe.each(Object.entries(fixtures))("fixture %s", (name, fixture) => {
    const result = compile(fixture, abstractionLibrary);

    it("compiles without diagnostics", () => {
      expect(result.diagnostics).toEqual([]);
      expect(result.ok).toBe(true);
    });

    it("matches the golden patch folder", async () => {
      for (const [file, text] of Object.entries(result.files)) {
        await expect(text).toMatchFileSnapshot(resolve(GOLDEN, name, file));
      }
    });

    it("only generates objects the Organelle's Pd has, plus its own abstractions", () => {
      const own = new Set(["voice", ...Object.keys(abstractionLibrary)]);
      for (const file of ["main.pd", "voice.pd"]) {
        const foreign = objectClasses(result.files[file]).filter((n) => !VANILLA_049_OBJECTS.has(n) && !own.has(n));
        expect(foreign, file).toEqual([]);
      }
    });

    it("has no dac~: the Organelle host owns the audio output", () => {
      for (const text of Object.values(result.files)) {
        expect(objectClasses(text)).not.toContain("dac~");
      }
    });
  });

  it("ships exactly the abstractions the patch uses, and the helpers those are built from", () => {
    const { files } = compile(basicSynth, abstractionLibrary);
    expect(Object.keys(files).sort()).toEqual([
      "ge-amp.pd",
      "ge-audio-out.pd",
      // Helper of the saw.
      "ge-blep.pd",
      "ge-env-adsr.pd",
      "ge-filter-lp.pd",
      // Helper of the filter.
      "ge-filter-poles.pd",
      "ge-knob.pd",
      "ge-osc-saw.pd",
      "ge-voice.pd",
      "main.pd",
      "voice.pd",
    ]);
    // No oscillator, no anti-aliasing helper.
    const silent = doc({ modules: [{ id: "ge1", type: "amp", x: 0, y: 0, params: {} }] });
    expect(Object.keys(compile(silent, abstractionLibrary).files)).not.toContain("ge-blep.pd");
  });

  it("reports a helper that is missing from the library", () => {
    const { "ge-blep": _missing, ...partial } = abstractionLibrary;
    const result = compile(basicSynth, partial);
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      { severity: "error", code: "missing-abstraction", message: "The module library is missing ge-blep.pd." },
    ]);
  });

  it("allocates the configured number of voices", () => {
    const main = compile({ ...basicSynth, voices: 7 }, abstractionLibrary).files["main.pd"];
    expect(main).toContain("poly 7 1;");
    expect(main).toContain("clone voice 7;");
  });

  it("keeps per-voice modules in voice.pd and everything after a Voice Sum in main.pd", () => {
    const { files } = compile(sharedFilter, abstractionLibrary);
    const inVoice = objectBoxes(files["voice.pd"]).map((b) => b.name);
    const inMain = objectBoxes(files["main.pd"]).map((b) => b.name);
    expect(inVoice).toContain("ge-osc-saw");
    expect(inVoice).not.toContain("ge-filter-lp");
    expect(inMain).toContain("ge-filter-lp");
    expect(inMain).toContain("ge-audio-out");
    // Two distinct voice outputs cross into the global section.
    expect(inVoice.filter((n) => n === "outlet~")).toHaveLength(2);
  });

  it("feeds unpatched pitch and gate inputs from the voice, unless the pre-cord is off", () => {
    const one = doc({ modules: [{ id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} }] });
    const voice = (d: PatchDocument) => compile(d, abstractionLibrary).files["voice.pd"];
    // Box 0 is the inlet, 1 is ge-voice (pitch on outlet 0), 2 is the oscillator.
    expect(voice(one)).toContain("#X connect 1 0 2 0;");
    const off = doc({ modules: [{ ...one.modules[0], precords: { pitch: false } }] });
    expect(voice(off)).not.toContain("#X connect 1 0 2 0;");
  });

  it("sends the right channel what the left gets when only left is patched", () => {
    const main = compile(basicSynth, abstractionLibrary).files["main.pd"];
    const boxes = objectBoxes(main).map((b) => b.name);
    const clone = boxes.indexOf("clone");
    const out = boxes.indexOf("ge-audio-out");
    expect(main).toContain(`#X connect ${clone} 0 ${out} 0;`);
    expect(main).toContain(`#X connect ${clone} 0 ${out} 1;`);
  });

  it("writes every parameter, using defaults and clamping to the range", () => {
    const result = compile(
      doc({ modules: [{ id: "ge1", type: "filter-lp", x: 0, y: 0, params: { cutoff: 99999 } }] }),
      abstractionLibrary,
    );
    expect(result.params).toEqual([
      { receiver: "ge1-cutoff", value: 18000 },
      { receiver: "ge1-res", value: 0.2 },
      { receiver: "ge1-mod", value: 36 },
    ]);
    expect(result.files["main.pd"]).toContain("\\; ge1-cutoff 18000 \\; ge1-res 0.2 \\; ge1-mod 36;");
  });

  it("is deterministic", () => {
    expect(compile(basicSynth, abstractionLibrary)).toEqual(compile(structuredClone(basicSynth), abstractionLibrary));
  });
});

describe("knob pages", () => {
  const main = compile(basicSynth, abstractionLibrary).files["main.pd"];

  it("steps through the pages with Aux", () => {
    expect(main).toContain("#X obj 110 400 r aux;");
    expect(main).toContain("mod 2;");
    expect(main).toContain("s ge-page;");
  });

  it("does not listen to Aux when there is only one page", () => {
    const onePage = compile({ ...basicSynth, pages: basicSynth.pages.slice(0, 1) }, abstractionLibrary).files["main.pd"];
    expect(onePage).not.toContain("r aux;");
  });

  it("shows the page name, sets the LED and blanks unused lines on entering a page", () => {
    expect(main).toContain("\\; screenLine5 Filter 1/2 \\; led 3;");
    expect(main).toContain("\\; screenLine5 Amp envelope 2/2 \\; led 4 \\; screenLine2 -;");
  });

  it("starts each knob at the position matching its parameter", () => {
    const { knobSlots } = compile(basicSynth, abstractionLibrary);
    expect(knobSlots.map((s) => [s.receiver, s.param])).toEqual([
      ["ge-slot-0-1", "ge2-cutoff"],
      ["ge-slot-0-2", "ge2-res"],
      ["ge-slot-0-3", "ge2-mod"],
      ["ge-slot-0-4", "ge1-tune"],
      ["ge-slot-1-1", "ge6-attack"],
      ["ge-slot-1-3", "ge6-sustain"],
      ["ge-slot-1-4", "ge6-release"],
    ]);
    expect(knobSlots[1].position).toBeCloseTo(0.5);
    expect(main).toContain("ge-knob 0 2 0.5;");
    expect(main).toContain("ge-knob 1 3 0.8;");
  });

  it("keeps every screen line within the Organelle's 21 characters", () => {
    // Message boxes with a $1 are the knob lines; fill in the widest value each can show.
    const lines = main.split("\n").filter((l) => l.startsWith("#X msg") && l.includes("$1"));
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      const text = line.replace(/^#X msg \d+ \d+ /, "").replace(/;$/, "");
      const widest = text.includes("Cutoff") ? "18000" : text.includes(" R ") ? "10000" : "-36.5";
      const rendered = text.replace("\\$1", widest);
      expect(rendered.length, rendered).toBeLessThanOrEqual(21);
    }
    const long = compile({ ...basicSynth, pages: [{ name: "A very long page name indeed, yes", knobs: [null, null, null, null] }] }, abstractionLibrary);
    const header = /screenLine5 ([^\\]*) \\;/.exec(long.files["main.pd"])![1];
    expect(header.length).toBeLessThanOrEqual(21);
    expect(header.endsWith("1/1")).toBe(true);
  });

  it("drops stale assignments with a warning", () => {
    const stale = compile({ ...basicSynth, pages: [{ name: "P", knobs: [{ module: "ge99", param: "x" }, null, null, null] }] }, abstractionLibrary);
    expect(stale.ok).toBe(true);
    expect(stale.diagnostics.map((d) => d.code)).toEqual(["bad-knob"]);
    expect(stale.knobSlots).toEqual([]);
  });

  it("rejects more pages than the limit", () => {
    const page = { name: "P", knobs: [null, null, null, null] };
    expect(codes({ ...basicSynth, pages: Array(9).fill(page) })).toContain("page-count");
  });
});

describe("diagnostics", () => {
  const saw = { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} };
  const out = { id: "ge2", type: "audio-out", x: 3, y: 0, params: {} };
  const cable = (from: string, fromPort: string, to: string, toPort: string) => ({
    from: { module: from, port: fromPort },
    to: { module: to, port: toPort },
  });
  const wired = doc({ modules: [saw, out], cables: [cable("ge1", "out", "ge2", "left")] });

  it("accepts a minimal wired patch", () => {
    expect(codes(wired)).toEqual([]);
  });

  it("warns, but still compiles, when nothing reaches an Audio Out", () => {
    const result = compile(doc({ modules: [saw, out] }), abstractionLibrary);
    expect(result.diagnostics.map((d) => [d.severity, d.code])).toEqual([["warning", "no-output"]]);
    expect(result.ok).toBe(true);
  });

  const broken: [string, PatchDocument][] = [
    ["unknown-module", doc({ modules: [{ ...saw, type: "nope" }] })],
    ["bad-id", doc({ modules: [{ ...saw, id: "knob1" }] })],
    ["duplicate-id", doc({ modules: [saw, { ...out, id: "ge1" }] })],
    ["bad-cable", { ...wired, cables: [cable("ge1", "out", "ge2", "middle")] }],
    ["bad-cable", { ...wired, cables: [cable("ge9", "out", "ge2", "left")] }],
    ["input-in-use", { ...wired, cables: [...wired.cables, cable("ge1", "out", "ge2", "left")] }],
    ["voice-count", { ...wired, voices: 0 }],
    ["voice-count", { ...wired, voices: 2.5 }],
    ["voice-count", { ...wired, voices: 17 }],
  ];
  it.each(broken)("reports %s and produces no files", (code, bad) => {
    const result = compile(bad, abstractionLibrary);
    expect(result.diagnostics.map((d) => d.code)).toContain(code);
    expect(result.ok).toBe(false);
    expect(result.files).toEqual({});
  });

  it("reports feedback loops by module name", () => {
    const loop = doc({
      modules: [
        { id: "ge1", type: "filter-lp", x: 0, y: 0, params: {} },
        { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
      ],
      cables: [cable("ge1", "out", "ge2", "in"), cable("ge2", "out", "ge1", "in")],
    });
    const result = compile(loop, abstractionLibrary);
    const found = result.diagnostics.find((d) => d.code === "feedback-loop");
    expect(found?.message).toMatch(/Low-pass → Amp/);
    expect(result.ok).toBe(false);
  });

  it("reports a missing abstraction instead of exporting a broken folder", () => {
    const { "ge-osc-saw": _missing, ...partial } = abstractionLibrary;
    expect(compile(wired, partial).diagnostics.map((d) => d.code)).toEqual(["missing-abstraction"]);
  });
});
