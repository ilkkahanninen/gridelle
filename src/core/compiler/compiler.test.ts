import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { basicSynth, fixtures, sharedFilter } from "../fixtures";
import * as ops from "../model/ops";
import { DOCUMENT_VERSION, type PatchDocument } from "../model/types";
import { objectBoxes, objectClasses } from "../pd/inspect";
import { PD_EXTRA_049, VANILLA_049_OBJECTS } from "../pd/vanilla049";
import { abstractionLibrary } from "../pdlib";
import { compile } from "./index";
import { structureKey } from "./structure";

/** Compiled fixtures live here as complete Organelle patch folders; Rust tests load them into Pd. */
const GOLDEN = resolve(import.meta.dirname, "../../../tests/golden");

/**
 * A patch whose modules are in the voices, unless it says otherwise: the area's inside is
 * the cells from the top-left one to x 98 and y 98, and x 100 is outside it.
 */
const doc = (patch: Partial<PatchDocument>): PatchDocument => ({
  version: DOCUMENT_VERSION,
  name: "Test",
  voices: 2,
  voiceArea: { x: -1, y: -1, width: 101, height: 101 },
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
      // The sounds are not text: what each is made from is written beside the patch, and
      // the Rust test that plays the folder makes them from that.
      if (result.samples.length > 0) {
        await expect(JSON.stringify(result.samples, null, 2) + "\n").toMatchFileSnapshot(resolve(GOLDEN, name, "samples.json"));
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
      // Helper of every oscillator: its Mod input.
      "ge-osc-mod.pd",
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

  it("gives every voice the same signal from a cable that comes into the voice area", () => {
    const { files } = compile(fixtures["shared-lfo"], abstractionLibrary);
    const main = objectBoxes(files["main.pd"]);
    const voice = objectBoxes(files["voice.pd"]);
    // The LFO runs once, in main.pd; in voice.pd the note comes in first, then the LFO.
    expect(main.map((b) => b.name)).toContain("ge-lfo");
    expect(voice.map((b) => b.name)).not.toContain("ge-lfo");
    const inlets = voice.filter((b) => b.name === "inlet" || b.name === "inlet~").sort((a, b) => a.x - b.x);
    expect(inlets.map((b) => b.name)).toEqual(["inlet", "inlet~"]);
    const lfo = main.findIndex((b) => b.name === "ge-lfo");
    const clone = main.findIndex((b) => b.name === "clone");
    // Its 0–1 output (outlet 1) into the clone's first signal inlet, after the note's.
    expect(files["main.pd"]).toContain(`#X connect ${lfo} 1 ${clone} 1;`);
    const amp = voice.findIndex((b) => b.name === "ge-amp" && b.args[0] === "ge5");
    expect(files["voice.pd"]).toContain(`#X connect ${voice.indexOf(inlets[1])} 0 ${amp} 1;`);
  });

  it("feeds a pre-cord outside the voice area from the keyboard", () => {
    const files = compile(fixtures["shared-lfo"], abstractionLibrary).files;
    const main = objectBoxes(files["main.pd"]);
    const keyboard = main.findIndex((b) => b.name === "ge-keyboard");
    const lfo = main.findIndex((b) => b.name === "ge-lfo");
    expect(keyboard).toBeGreaterThan(-1);
    // Its gate (outlet 1) is the LFO's Reset (inlet 0).
    expect(files["main.pd"]).toContain(`#X connect ${keyboard} 1 ${lfo} 0;`);
    expect(Object.keys(files)).toContain("ge-keyboard.pd");
    // A patch with nothing outside that follows the note has no keyboard.
    expect(compile(basicSynth, abstractionLibrary).files["ge-keyboard.pd"]).toBeUndefined();
    // Keys outside the voices is the keyboard too, at its three voice inlets.
    const outside = compile(doc({ modules: [{ id: "ge1", type: "keys", x: 100, y: 0, params: {} }] }), abstractionLibrary).files;
    for (const inlet of [0, 1, 2]) expect(outside["main.pd"]).toMatch(new RegExp(`#X connect \\d+ ${inlet} \\d+ ${inlet};`));
    expect(objectBoxes(outside["main.pd"]).map((b) => b.name)).toEqual(expect.arrayContaining(["ge-keyboard", "ge-keys"]));
  });

  it("reloads when a module moves into the voice area or out of it, not when it moves within", () => {
    const key = structureKey(fixtures["shared-lfo"]);
    expect(structureKey(ops.moveModules(fixtures["shared-lfo"], new Set(["ge6"]), { x: 1, y: 0 }))).toBe(key);
    // Wide enough to take the Audio Out in.
    const moved = { ...fixtures["shared-lfo"], voiceArea: { ...fixtures["shared-lfo"].voiceArea, width: 8 } };
    expect(structureKey(moved)).not.toBe(key);
  });

  it("allocates the configured number of voices", () => {
    const main = compile({ ...basicSynth, voices: 7 }, abstractionLibrary).files["main.pd"];
    expect(main).toContain("poly 7 1;");
    expect(main).toContain("clone voice 7;");
  });

  it("keeps the modules of the voice area in voice.pd and the others in main.pd", () => {
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

  it("holds the inputs of settings at 1 while they have no cable", () => {
    const envelopes = doc({
      modules: [
        { id: "ge1", type: "env-adsr", x: 0, y: 0, params: {} },
        { id: "ge2", type: "env-adsr", x: 2, y: 0, params: {} },
      ],
      cables: [{ from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "sustain" } }],
    });
    const voice = compile(envelopes, abstractionLibrary).files["voice.pd"];
    const boxes = objectBoxes(voice).map((b) => b.name);
    // One source serves every such input of the voice.
    expect(boxes.filter((name) => name === "sig~")).toHaveLength(1);
    expect(voice).toContain("#X obj 290 70 sig~ 1;");
    const [one, first, second] = [boxes.indexOf("sig~"), boxes.indexOf("ge-env-adsr"), boxes.lastIndexOf("ge-env-adsr")];
    // Inlets: gate, A, D, S, R. The first envelope has none of its settings cabled.
    for (const inlet of [1, 2, 3, 4]) expect(voice).toContain(`#X connect ${one} 0 ${first} ${inlet};`);
    // The second has its S fed by the first, so the constant stays out of it.
    for (const inlet of [1, 2, 4]) expect(voice).toContain(`#X connect ${one} 0 ${second} ${inlet};`);
    expect(voice).not.toContain(`#X connect ${one} 0 ${second} 3;`);
    expect(voice).toContain(`#X connect ${first} 0 ${second} 3;`);
  });

  it("adds no constant to a patch whose inputs all rest at zero, and feeds a global module in main", () => {
    const plain = doc({ modules: [{ id: "ge1", type: "noise", x: 0, y: 0, params: {} }] });
    const names = (text: string) => objectBoxes(text).map((b) => b.name);
    expect(names(compile(plain, abstractionLibrary).files["voice.pd"])).not.toContain("sig~");

    // An envelope outside the voice area runs once, in main.pd.
    const summed = doc({
      modules: [
        { id: "ge1", type: "noise", x: 0, y: 0, params: {} },
        { id: "ge3", type: "env-adsr", x: 100, y: 0, params: {} },
      ],
      cables: [{ from: { module: "ge1", port: "out" }, to: { module: "ge3", port: "gate" } }],
    });
    const files = compile(summed, abstractionLibrary).files;
    expect(names(files["voice.pd"])).not.toContain("sig~");
    const main = names(files["main.pd"]);
    const [one, envelope] = [main.indexOf("sig~"), main.indexOf("ge-env-adsr")];
    expect(one).toBeGreaterThan(-1);
    for (const inlet of [1, 2, 3, 4]) expect(files["main.pd"]).toContain(`#X connect ${one} 0 ${envelope} ${inlet};`);
  });

  it("never mutes a voice: what its modules make is what leaves it", () => {
    // A synth voice, an oscillator alone, and a row of effects behind an oscillator.
    for (const fixture of [basicSynth, fixtures["bare-oscillator"], fixtures["voice-effects"]]) {
      const voice = compile(fixture, abstractionLibrary).files["voice.pd"];
      const names = objectBoxes(voice).map((b) => b.name);
      const wires = [...voice.matchAll(/#X connect (\d+) (\d+) (\d+) (\d+);/g)].map((m) => m.slice(1).map(Number));
      // Nothing is in a voice but its note handling, its modules and the values that
      // unpatched inputs rest at: no switch, no fade, nothing that listens for silence.
      const others = names.filter((name) => !name.startsWith("ge-") && !["inlet", "outlet~", "sig~"].includes(name));
      expect(others, fixture.name).toEqual([]);
      // Each outlet is fed by one module, directly.
      const outlets = names.flatMap((name, box) => (name === "outlet~" ? [box] : []));
      expect(outlets.length, fixture.name).toBeGreaterThan(0);
      for (const outlet of outlets) {
        const feeding = wires.filter((w) => w[2] === outlet);
        expect(feeding).toHaveLength(1);
        expect(names[feeding[0][0]]).toMatch(/^ge-(?!voice$)/);
      }
    }
    // The oscillator alone goes straight out; one effect goes straight into the next.
    const bare = compile(fixtures["bare-oscillator"], abstractionLibrary).files["voice.pd"];
    const bareNames = objectBoxes(bare).map((b) => b.name);
    expect(bare).toContain(`#X connect ${bareNames.indexOf("ge-osc-saw")} 0 ${bareNames.indexOf("outlet~")} 0;`);
    const effects = compile(fixtures["voice-effects"], abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(effects).map((b) => b.name);
    expect(effects).toContain(`#X connect ${names.indexOf("ge-filter-allpass")} 0 ${names.indexOf("ge-fx-phaser")} 0;`);
    expect(effects).toContain(`#X connect ${names.indexOf("ge-osc-sine")} 0 ${names.indexOf("ge-mixer")} 1;`);
  });

  it("names the objects from Pd's extra folder without shipping them", () => {
    const result = compile(fixtures.flavours, abstractionLibrary);
    expect(result.diagnostics).toEqual([]);
    // The wrappers use them ...
    const used = new Set(Object.values(result.files).flatMap((text) => objectClasses(text)));
    for (const name of PD_EXTRA_049) expect(used, name).toContain(name);
    // ... but the folder holds only Gridelle's own files: the device's Pd has the rest.
    expect(Object.keys(result.files).filter((file) => !/^(main|voice|ge-[a-z-]+)\.pd$/.test(file))).toEqual([]);
    // Nothing in the core list is also in the extra list.
    for (const name of PD_EXTRA_049) expect(VANILLA_049_OBJECTS.has(name), name).toBe(false);
  });

  it("runs the audio input, and what is patched after it, once", () => {
    const files = compile(fixtures["audio-input"], abstractionLibrary).files;
    const inVoice = objectBoxes(files["voice.pd"]).map((b) => b.name);
    const inMain = objectBoxes(files["main.pd"]).map((b) => b.name);
    for (const name of ["ge-audio-in", "ge-filter-lp", "ge-mixer"]) {
      expect(inMain, name).toContain(name);
      expect(inVoice, name).not.toContain(name);
    }
    // The synth voice stays a voice, and reaches the mixer through the sum of the voices.
    expect(inVoice).toContain("ge-osc-saw");
    expect(inVoice.filter((name) => name === "outlet~")).toHaveLength(1);
    // The input comes from the host: the patch itself has no adc~.
    for (const text of Object.values(files)) expect(objectClasses(text)).not.toContain("adc~");
    expect(objectClasses(files["ge-audio-in.pd"])).toContain("r~");
  });

  it("hands the Keys module the played note, at inlets that are not ports", () => {
    const voice = compile(fixtures.pitches, abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    const [note, keys, glide, envelope] = ["ge-voice", "ge-keys", "ge-pitch-glide", "ge-env-adsr"].map((name) => names.indexOf(name));
    // Pitch, gate and velocity from the voice into the module's three inlets.
    for (const signal of [0, 1, 2]) expect(voice).toContain(`#X connect ${note} ${signal} ${keys} ${signal};`);
    // Its outputs are ordinary: pitch into the glide, gate and velocity into the envelope.
    expect(voice).toContain(`#X connect ${keys} 0 ${glide} 0;`);
    expect(voice).toContain(`#X connect ${keys} 1 ${envelope} 0;`);
    expect(voice).toContain(`#X connect ${keys} 2 ${envelope} 3;`);
    // The glide's own pitch input is cabled, so the voice does not feed it as well.
    expect(voice).not.toContain(`#X connect ${note} 0 ${glide} 0;`);
  });

  describe("samples", () => {
    const result = compile(fixtures.sampler, abstractionLibrary);

    it("builds the sample a module works on into its abstraction, and sends it no value", () => {
      expect(result.files["voice.pd"]).toContain("ge-sample-player ge1 0;");
      expect(result.files["voice.pd"]).toContain("ge-sample-head ge3 0;");
      expect(result.files["voice.pd"]).toContain("ge-sample-head ge7 1;");
      expect(result.params.map((p) => p.receiver).filter((r) => r.endsWith("-sample"))).toEqual([]);
      expect(result.params.map((p) => p.receiver)).toContain("ge1-mode");
    });

    it("gives each sample in use a table: a sound file to load, or a tape", () => {
      expect(result.files["main.pd"]).toContain("ge-sample-file 0 ge-sample-a.wav;");
      expect(result.files["main.pd"]).toContain("ge-sample-tape 1 0.5;");
      expect(Object.keys(result.files)).toEqual(expect.arrayContaining(["ge-sample-file.pd", "ge-sample-tape.pd"]));
      // The folder is complete with the sound file, which the compiler names but does not read.
      expect(result.samples).toEqual([{ file: "ge-sample-a.wav", source: { kind: "sound", path: "tests/golden/sampler/ge-sample-a.wav" } }]);
    });

    it("leaves out a sample no module uses, and a patch without sample modules has none", () => {
      const unused = compile(ops.removeModules(fixtures.sampler, new Set(["ge7"])), abstractionLibrary);
      expect(unused.files["main.pd"]).not.toContain("ge-sample-tape");
      expect(unused.files["ge-sample-tape.pd"]).toBeUndefined();
      const none = compile({ ...basicSynth, samples: fixtures.sampler.samples }, abstractionLibrary);
      expect(none.samples).toEqual([]);
      expect(none.files["main.pd"]).not.toContain("ge-sample");
    });

    it("gives a module on an empty sample a silent table, and says so", () => {
      const empty = compile(ops.setParam(fixtures.sampler, "ge1", "sample", 5), abstractionLibrary);
      expect(empty.ok).toBe(true);
      expect(empty.diagnostics).toEqual([
        { severity: "warning", code: "empty-sample", message: "Sample Player uses sample F, which is empty.", module: "ge1" },
      ]);
      expect(empty.files["voice.pd"]).toContain("ge-sample-player ge1 5;");
      expect(empty.files["main.pd"]).toContain("ge-sample-tape 5 0;");
    });

    describe("wavetables", () => {
      const table = fixtures.wavetable;
      const built = compile(table, abstractionLibrary);
      const file = { kind: "file", path: "/tables/growl.wav", name: "growl.wav", frames: 44100 * 30, sampleRate: 44100 } as const;
      const codes = (doc: PatchDocument) => compile(doc, abstractionLibrary).diagnostics.map((d) => [d.code, d.module]);

      it("has a wavetable loaded for each slot an oscillator reads, and names what to make it from", () => {
        expect(built.files["voice.pd"]).toContain("ge-osc-wavetable ge1 0;");
        expect(built.files["voice.pd"]).toContain("ge-osc-wavetable ge2 1;");
        expect(built.files["main.pd"]).toContain("ge-wave-file 0 ge-wave-a.wav;");
        expect(built.files["main.pd"]).toContain("ge-wave-file 1 ge-wave-b.wav;");
        expect(built.files["main.pd"]).not.toContain("ge-sample-");
        expect(Object.keys(built.files)).toEqual(expect.arrayContaining(["ge-wave-file.pd", "ge-osc-wavetable.pd", "ge-osc-mod.pd"]));
        expect(built.samples).toEqual([
          { file: "ge-wave-a.wav", source: { kind: "bank", id: "resonance" } },
          { file: "ge-wave-b.wav", source: { kind: "bank", id: "vowels" } },
        ]);
        expect(built.params.map((p) => p.receiver)).toContain("ge1-position");
        expect(built.params.map((p) => p.receiver).filter((r) => r.endsWith("-sample"))).toEqual([]);
      });

      it("reads a sound file as a wavetable, in cycles of the length the slot says", () => {
        const onFile = compile(ops.setSample(table, 0, file), abstractionLibrary);
        // Long as it is, no warning: a wavetable is not played at a speed.
        expect(onFile.diagnostics).toEqual([]);
        expect(onFile.samples[0]).toEqual({ file: "ge-wave-a.wav", source: { kind: "wavetable", path: "/tables/growl.wav" } });
        const cut = compile(ops.setSample(table, 0, { ...file, cycle: 1024 }), abstractionLibrary);
        expect(cut.samples[0]).toEqual({ file: "ge-wave-a.wav", source: { kind: "wavetable", path: "/tables/growl.wav", cycle: 1024 } });
      });

      it("makes both tables of a sound file that is played and read as a wavetable", () => {
        const both = ops.setParam(ops.addModule(ops.setSample(table, 0, file), "sample-head", { x: 12, y: 0 }).doc, "ge8", "sample", 0);
        const result = compile(both, abstractionLibrary);
        expect(result.files["main.pd"]).toContain("ge-sample-file 0 ge-sample-a.wav;");
        expect(result.files["main.pd"]).toContain("ge-wave-file 0 ge-wave-a.wav;");
        expect(result.samples.map((s) => [s.file, s.source.kind])).toEqual([
          ["ge-sample-a.wav", "sound"],
          ["ge-wave-a.wav", "wavetable"],
          ["ge-wave-b.wav", "bank"],
        ]);
        // Now its length is worth a word: the Play Head plays it.
        expect(result.diagnostics.map((d) => d.code)).toEqual(["long-sample"]);
      });

      it("gives an oscillator a silent table where its slot has no wavetable, and says why", () => {
        const onTape = ops.setSample(table, 0, { kind: "tape", seconds: 2 });
        expect(codes(onTape)).toEqual([["not-a-wavetable", "ge1"]]);
        const result = compile(onTape, abstractionLibrary);
        expect(result.files["main.pd"]).toContain("#X obj 810 30 table ge-wave-0 64;");
        expect(result.files["main.pd"]).not.toContain("ge-sample-tape");
        expect(result.samples.map((s) => s.file)).toEqual(["ge-wave-b.wav"]);

        expect(codes(ops.setSample(table, 0, null))).toEqual([["empty-sample", "ge1"]]);
        expect(compile(ops.setSample(table, 0, null), abstractionLibrary).files["main.pd"]).toContain("table ge-wave-0 64;");

        const unknown = ops.setSample(table, 1, { kind: "wavetable", bank: "from-the-future" });
        expect(codes(unknown)).toEqual([["unknown-bank", "ge2"]]);
        expect(compile(unknown, abstractionLibrary).samples.map((s) => s.file)).toEqual(["ge-wave-a.wav"]);
      });

      it("gives a sample module on a wavetable an empty tape, and says why", () => {
        const head = ops.setParam(ops.addModule(table, "sample-head", { x: 12, y: 0 }).doc, "ge8", "sample", 1);
        const result = compile(head, abstractionLibrary);
        expect(result.diagnostics).toEqual([
          { severity: "warning", code: "wavetable-as-sample", message: "Play Head uses sample B, which is a wavetable: only a Wavetable oscillator plays one.", module: "ge8" },
        ]);
        expect(result.files["main.pd"]).toContain("ge-sample-tape 1 0;");
        expect(result.files["main.pd"]).toContain("ge-wave-file 1 ge-wave-b.wav;");
      });

      it("reloads when a wavetable is changed for another, or a sound's cycles for others", () => {
        const key = structureKey(table);
        expect(structureKey(ops.setSample(table, 0, { kind: "wavetable", bank: "glass" }))).not.toBe(key);
        expect(structureKey(ops.setWavetable(table, "ge1", "vowels"))).not.toBe(key);
        expect(structureKey(ops.setParam(table, "ge1", "position", 0.9))).toBe(key);
        const onFile = ops.setSample(table, 0, file);
        expect(structureKey(ops.setSample(onFile, 0, { ...file, cycle: 1024 }))).not.toBe(structureKey(onFile));
      });
    });

    it("warns about a sound too long to play smoothly at other speeds", () => {
      const long = ops.setSample(fixtures.sampler, 0, { kind: "file", path: "/sounds/long.wav", name: "long.wav", frames: 44100 * 30, sampleRate: 44100 });
      expect(compile(long, abstractionLibrary).diagnostics.map((d) => d.code)).toEqual(["long-sample"]);
    });

    it("feeds the Pitch input the played note, or middle C when that is switched off", () => {
      const followsNote = result.files["voice.pd"];
      expect(followsNote).not.toContain("sig~ 60;");
      const fixed = compile(ops.setPrecord(fixtures.sampler, "ge1", "pitch", false), abstractionLibrary).files["voice.pd"];
      expect(fixed).toContain("sig~ 60;");
      // One or the other, never both: the pitch outlet of the voice no longer reaches the player.
      const connections = (text: string) => text.split("\n").filter((line) => line.startsWith("#X connect")).length;
      expect(connections(fixed)).toBe(connections(followsNote));
    });

    it("reloads when a module is given another sample or a sample changes, and not for other choices", () => {
      const key = structureKey(fixtures.sampler);
      expect(structureKey(ops.setParam(fixtures.sampler, "ge1", "sample", 1))).not.toBe(key);
      expect(structureKey(ops.setSample(fixtures.sampler, 1, { kind: "tape", seconds: 2 }))).not.toBe(key);
      expect(structureKey(ops.setSample(fixtures.sampler, 0, null))).not.toBe(key);
      expect(structureKey(ops.setParam(fixtures.sampler, "ge1", "mode", 1))).toBe(key);
      expect(structureKey(ops.setParam(fixtures.sampler, "ge1", "tune", 7))).toBe(key);
    });

    it("lets one module record onto a sample, and wants one for a module that plays behind the recording", () => {
      const echo = fixtures["tape-echo"];
      expect(compile(echo, abstractionLibrary).diagnostics).toEqual([]);
      // A second Recorder on the same tape.
      const added = ops.addModule(echo, "sample-recorder", { x: 40, y: 0 });
      const id = added.id!;
      const second = ops.setParam(added.doc, id, "sample", 1);
      const refused = compile(second, abstractionLibrary);
      expect(refused.ok).toBe(false);
      expect(refused.diagnostics).toEqual([
        { severity: "error", code: "two-recorders", message: "Two modules record onto sample B. A sample can have one.", module: id },
      ]);
      // On another tape it is fine, apart from that tape being empty.
      expect(compile(ops.setParam(second, id, "sample", 2), abstractionLibrary).diagnostics.map((d) => d.code)).toEqual(["empty-sample"]);
      // The Tape Head without its Recorder.
      const alone = compile(ops.removeModules(echo, new Set(["ge6"])), abstractionLibrary);
      expect(alone.ok).toBe(true);
      expect(alone.diagnostics).toEqual([
        { severity: "warning", code: "no-recorder", message: "Tape Head plays behind the recording of sample B, which nothing records.", module: "ge7" },
      ]);
    });

    it("runs the Recorder and the Tape Head once for all voices, with the echo's path back through the tape", () => {
      const echo = compile(fixtures["tape-echo"], abstractionLibrary);
      // Both are in main.pd, with everything patched after them; the voices hold the synth.
      for (const box of ["ge-sample-recorder ge6 1;", "ge-tape-head ge7 1;", "ge-filter-lp ge8;", "ge-shaper-soft ge9;", "ge-mixer ge5;", "ge-sample-tape 1 1;"]) {
        expect(echo.files["main.pd"]).toContain(box);
      }
      expect(echo.files["voice.pd"]).not.toContain("ge-tape-head");
      expect(echo.files["voice.pd"]).toContain("ge-osc-saw ge1;");
    });

    it("ships the grain stream that Grains is made of, and builds its sample into both", () => {
      const cloud = compile(fixtures.grains, abstractionLibrary);
      expect(cloud.diagnostics).toEqual([]);
      expect(cloud.files["voice.pd"]).toContain("ge-sample-grains ge1 0;");
      expect(Object.keys(cloud.files)).toEqual(expect.arrayContaining(["ge-sample-grains.pd", "ge-grain.pd", "ge-sample-file.pd"]));
      // The module passes its sample on to its four streams.
      expect(cloud.files["ge-sample-grains.pd"].match(/ge-grain \\\$2 /g)).toHaveLength(4);
      // Where its Position counts from is a choice like any other: no reload.
      expect(structureKey(ops.setParam(fixtures.grains, "ge1", "from", 1))).toBe(structureKey(fixtures.grains));
      expect(cloud.params.map((p) => p.receiver)).toContain("ge1-from");
    });
  });

  it("numbers the Scopes and tells each which voice it is in", () => {
    const result = compile(fixtures.scoped, abstractionLibrary);
    expect(result.scopes).toEqual({ ge6: 1, ge7: 2, ge8: 3 });
    // Inside the voices the voice number is what [clone] passes as $1; after the Voice Sum it is -1.
    expect(result.files["voice.pd"]).toContain("ge-scope ge6 1 \\$1;");
    expect(result.files["voice.pd"]).toContain("ge-scope ge7 2 \\$1;");
    expect(result.files["main.pd"]).toContain("ge-scope ge8 3 -1;");
    // The Scopes in the voices are told which voice got the latest note.
    expect(result.files["main.pd"]).toContain("s ge-scope-voice;");
    // A patch with none there is not.
    const after = compile(ops.removeModules(fixtures.scoped, new Set(["ge6", "ge7"])), abstractionLibrary);
    expect(after.scopes).toEqual({ ge8: 1 });
    expect(after.files["main.pd"]).not.toContain("ge-scope-voice");
    expect(compile(fixtures["basic-synth"], abstractionLibrary).files["main.pd"]).not.toContain("ge-scope-voice");
    // Other modules keep their one argument.
    expect(result.files["voice.pd"]).toContain("ge-osc-saw ge1;");
  });

  it("draws the first eight Scopes only, and says so", () => {
    const many = doc({
      modules: Array.from({ length: 10 }, (_, i) => ({ id: `ge${i + 1}`, type: "scope", x: i * 3, y: 0, params: {} })),
    });
    const result = compile(many, abstractionLibrary);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ["warning", "too-many-scopes"],
      ["warning", "no-output"],
    ]);
    expect(Object.keys(result.scopes)).toHaveLength(8);
    expect(result.scopes).toMatchObject({ ge1: 1, ge8: 8 });
    // The ninth and tenth tap a bus nothing listens to.
    expect(result.files["voice.pd"]).toContain("ge-scope ge9 0 \\$1;");
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

  it("exports the pages that have a knob in use, and steps through those", () => {
    const res = { module: "ge2", param: "res" };
    const tune = { module: "ge1", param: "tune" };
    const none = [null, null, null, null];
    // Of eight pages, the second and the sixth have a knob. The fourth has only a name.
    const sparse = {
      ...basicSynth,
      pages: [
        { name: "", knobs: none },
        { name: "", knobs: [null, res, null, null] },
        { name: "", knobs: none },
        { name: "Named only", knobs: none },
        { name: "", knobs: none },
        { name: "Tuning", knobs: [tune, null, null, null] },
      ],
    };
    const result = compile(sparse, abstractionLibrary);
    const text = result.files["main.pd"];
    // Two pages on the Organelle, numbered as it steps through them. One without a name
    // goes by its number in the editor.
    expect(text).toContain("mod 2;");
    expect(text).toContain("screenLine5 Page 2 1/2");
    expect(text).toContain("screenLine5 Tuning 2/2");
    expect(text).not.toContain("Named only");
    expect(text).toContain("ge-knob 0 2 ");
    expect(text).toContain("ge-knob 1 1 ");
    expect(result.knobSlots.map((slot) => [slot.receiver, slot.param])).toEqual([
      ["ge-slot-0-2", "ge2-res"],
      ["ge-slot-1-1", "ge1-tune"],
    ]);

    // What is not exported does not reload the preview: a name on an unused page, or its place.
    const key = structureKey(sparse);
    const renamed = { ...sparse, pages: sparse.pages.map((page, i) => (i === 3 ? { ...page, name: "Another name" } : page)) };
    expect(structureKey(renamed)).toBe(key);
    expect(structureKey({ ...sparse, pages: [...sparse.pages, { name: "Eighth", knobs: none }] })).toBe(key);
    // What is exported does: a used page's name, and for one without a name, the number it goes by.
    expect(structureKey({ ...sparse, pages: sparse.pages.map((page, i) => (i === 5 ? { ...page, name: "Pitch" } : page)) })).not.toBe(key);
    expect(structureKey({ ...sparse, pages: sparse.pages.slice(1) })).not.toBe(key);

    // A patch with no knob in use has no knob pages at all on the Organelle.
    const unused = compile({ ...basicSynth, pages: [{ name: "Named only", knobs: none }] }, abstractionLibrary);
    expect(unused.files["main.pd"]).not.toContain("ge-page");
    expect(unused.files["ge-knob.pd"]).toBeUndefined();
    expect(unused.knobSlots).toEqual([]);
  });

  it("names a setting on the Organelle's screen by the module's own name, where it has one", () => {
    // basic-synth has the Low-pass (ge2) on the first page and the ADSRs on the second.
    const named = ops.renameModule(basicSynth, "ge2", "Bass filter");
    const text = compile(named, abstractionLibrary).files["main.pd"];
    // The name is cut to what the line has room for, as the type's name is.
    expect(text).toContain("Bass Cutoff \\$1 Hz;");
    expect(text).toContain("Bass filter Res \\$1;");
    expect(text).toContain("Bass fil Mod \\$1 st;");
    expect(text).not.toContain("Low-p");
    expect(main).toContain("Low-p Cutoff \\$1 Hz;");
    // Other modules keep the names of their types.
    expect(text).toContain("Saw Tune \\$1 st;");
    // A name nothing of which the screen can show falls back to the type's.
    expect(compile(ops.renameModule(basicSynth, "ge2", "§§"), abstractionLibrary).files["main.pd"]).toContain("Low-p Cutoff");

    // The patch reloads for a new name of a module with a setting on a knob, and for no other.
    const key = structureKey(basicSynth);
    expect(structureKey(named)).not.toBe(key);
    expect(structureKey(ops.renameModule(basicSynth, "ge2", "  "))).toBe(key);
    const off = ops.assignKnob(basicSynth, { page: 0, knob: 3 }, null);
    expect(ops.findAssignment(off, "ge1", "tune")).toBeNull();
    expect(structureKey(ops.renameModule(off, "ge1", "Lead"))).toBe(structureKey(off));
  });

  it("says which module a problem is in by its own name", () => {
    const empty = ops.renameModule(ops.setParam(fixtures.sampler, "ge1", "sample", 5), "ge1", "Kick");
    expect(compile(empty, abstractionLibrary).diagnostics.map((d) => d.message)).toEqual(["Kick uses sample F, which is empty."]);
  });

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
    const long = compile(
      { ...basicSynth, pages: [{ name: "A very long page name indeed, yes", knobs: [{ module: "ge2", param: "res" }, null, null, null] }] },
      abstractionLibrary,
    );
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
  // Outside the voice area, whose border is at x 99.
  const out = { id: "ge2", type: "audio-out", x: 100, y: 0, params: {} };
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

  it("says where a module may not be: across the edge of the voice area, or in it when it runs once", () => {
    const across = compile({ ...wired, voiceArea: { x: 0, y: -1, width: 100, height: 101 } }, abstractionLibrary);
    expect(across.ok).toBe(false);
    expect(across.diagnostics).toEqual([
      {
        severity: "error",
        code: "misplaced",
        message: "Saw lies across the edge of the voice area: move it into the voices or out of them.",
        module: "ge1",
      },
    ]);
    // Its header is its border too: a tile may not reach into it.
    const header = compile({ ...wired, voiceArea: { x: -1, y: 0, width: 101, height: 101 } }, abstractionLibrary);
    expect(header.diagnostics.map((d) => [d.code, d.module])).toEqual([["misplaced", "ge1"]]);
    const inside = compile(doc({ modules: [saw, { ...out, x: 3 }], cables: wired.cables }), abstractionLibrary);
    expect(inside.diagnostics).toEqual([
      { severity: "error", code: "misplaced", message: "Audio Out runs once for the whole patch: move it out of the voice area.", module: "ge2" },
    ]);
  });

  it("refuses a path that leaves the voice area and comes back into it", () => {
    // A saw in the voices into a mixer outside, and the mixer into a filter in the voices.
    const loop = doc({
      modules: [
        saw,
        { id: "ge3", type: "mixer", x: 100, y: 4, params: {} },
        { id: "ge4", type: "filter-lp", x: 4, y: 0, params: {} },
        out,
      ],
      cables: [cable("ge1", "out", "ge3", "in1"), cable("ge3", "out", "ge4", "mod"), cable("ge4", "out", "ge2", "left")],
    });
    const result = compile(loop, abstractionLibrary);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => [d.code, d.module])).toEqual([["feedback-loop", "ge3"]]);
    expect(result.diagnostics[0].message).toContain("(Mixer)");
  });

  it("reports a missing abstraction instead of exporting a broken folder", () => {
    const { "ge-osc-saw": _missing, ...partial } = abstractionLibrary;
    expect(compile(wired, partial).diagnostics.map((d) => d.code)).toEqual(["missing-abstraction"]);
  });
});
