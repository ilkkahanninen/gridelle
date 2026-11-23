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

    // An envelope after the voice sum runs once, in main.pd.
    const summed = doc({
      modules: [
        { id: "ge1", type: "noise", x: 0, y: 0, params: {} },
        { id: "ge2", type: "voice-sum", x: 2, y: 0, params: {} },
        { id: "ge3", type: "env-adsr", x: 3, y: 0, params: {} },
      ],
      cables: [
        { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
        { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "gate" } },
      ],
    });
    const files = compile(summed, abstractionLibrary).files;
    expect(names(files["voice.pd"])).not.toContain("sig~");
    const main = names(files["main.pd"]);
    const [one, envelope] = [main.indexOf("sig~"), main.indexOf("ge-env-adsr")];
    expect(one).toBeGreaterThan(-1);
    for (const inlet of [1, 2, 3, 4]) expect(files["main.pd"]).toContain(`#X connect ${one} 0 ${envelope} ${inlet};`);
  });

  it("mutes what leaves a voice unless its key is held or one of its envelopes is running", () => {
    const voice = compile(basicSynth, abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    const at = (name: string, from = 0) => names.indexOf(name, from);
    // The key gate (outlet 1 of ge-voice) and both envelopes go through max~ ...
    const first = at("max~");
    const second = at("max~", first + 1);
    const envelopes = [at("ge-env-adsr"), at("ge-env-adsr", at("ge-env-adsr") + 1)];
    expect(voice).toContain(`#X connect ${at("ge-voice")} 1 ${first} 0;`);
    expect(voice).toContain(`#X connect ${envelopes[0]} 0 ${first} 1;`);
    expect(voice).toContain(`#X connect ${first} 0 ${second} 0;`);
    expect(voice).toContain(`#X connect ${envelopes[1]} 0 ${second} 1;`);
    // ... into a switch with a short fade (the higher of two low-passes), which multiplies
    // the voice's one outlet.
    const fade = names.lastIndexOf("max~");
    expect(fade).toBeGreaterThan(second);
    expect(names.filter((name) => name === "lop~")).toHaveLength(2);
    const outlet = at("outlet~");
    const heard = names.lastIndexOf("*~");
    expect(voice).toContain(`#X connect ${at("ge-amp")} 0 ${heard} 0;`);
    expect(voice).toContain(`#X connect ${fade} 0 ${heard} 1;`);
    expect(voice).toContain(`#X connect ${heard} 0 ${outlet} 0;`);
    // Nothing else feeds the outlet.
    expect(voice.match(new RegExp(`#X connect \\d+ \\d+ ${outlet} 0;`, "g"))).toHaveLength(1);
  });

  it("uses the key gate alone for a voice without envelopes", () => {
    const voice = compile(fixtures["bare-oscillator"], abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    // The only max~ is the one that joins the two fades.
    expect(names.filter((name) => name === "max~")).toHaveLength(1);
    expect(voice).toContain(`#X connect ${names.indexOf("ge-voice")} 1 ${names.indexOf("*~")} 0;`);
    expect(names.filter((name) => name === "outlet~")).toHaveLength(1);
  });

  it("feeds a module with a tail only while the voice plays, and hears the voice until it has rung out", () => {
    // Saw -> All-pass -> Phaser -> Chorus -> Delay -> Reverb, a Sine beside them into a Mixer after the Reverb.
    const voice = compile(fixtures["voice-effects"], abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    const wires = [...voice.matchAll(/#X connect (\d+) (\d+) (\d+) (\d+);/g)].map((m) => m.slice(1).map(Number));
    const into = (box: number, inlet: number) => wires.filter((w) => w[2] === box && w[3] === inlet).map((w) => w[0]);
    const one = (name: string) => names.indexOf(name);

    // `playing` is the first fade (the key gate alone: no envelopes here), `heard` the max~ that
    // joins it with the fade of the four effects' levels.
    expect(names.filter((name) => name === "abs~")).toHaveLength(4);
    // A fade is a max~ of two low-passes that both follow the same switch, a clip~.
    const afterSwitch = (box: number) => names[box] === "lop~" && into(box, 0).every((b) => names[b] === "clip~");
    const fades = names.flatMap((name, i) => (name === "max~" && [0, 1].every((inlet) => into(i, inlet).every(afterSwitch)) ? [i] : []));
    expect(fades).toHaveLength(2);
    const [playing, ringing] = fades;
    const heard = names.findIndex((name, i) => name === "max~" && into(i, 0).includes(playing) && into(i, 1).includes(ringing));
    expect(heard).toBeGreaterThan(-1);

    // The all-pass is not part of the ringing part, so its audio enters the phaser through a gate...
    const [gate] = into(one("ge-fx-phaser"), 0);
    expect(names[gate]).toBe("*~");
    expect(into(gate, 0)).toEqual([one("ge-filter-allpass")]);
    expect(into(gate, 1)).toEqual([playing]);
    // ... and so does the sine's into the mixer, which is after the reverb.
    const [sineGate] = into(one("ge-mixer"), 1);
    expect(names[sineGate]).toBe("*~");
    expect(into(sineGate, 0)).toEqual([one("ge-osc-sine")]);
    expect(into(sineGate, 1)).toEqual([playing]);
    // Between two effects nothing is gated, or the tail of the first would be cut.
    expect(into(one("ge-fx-chorus"), 0)).toEqual([one("ge-fx-phaser")]);

    // Both things that leave the voice come from the ringing part: they are heard until it is quiet.
    const outlets = names.flatMap((name, i) => (name === "outlet~" ? [i] : []));
    expect(outlets).toHaveLength(2);
    for (const outlet of outlets) {
      const [audible] = into(outlet, 0);
      expect(into(audible, 1)).toEqual([heard]);
    }
  });

  it("treats sound that has been through a math module as sound still", () => {
    // Saw x LFO into a delay: the product has no audio port, but it is the saw all the same.
    const tremolo = doc({
      modules: [
        { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
        { id: "ge2", type: "lfo", x: 0, y: 3, params: {} },
        { id: "ge3", type: "math-multiply", x: 2, y: 0, params: {} },
        { id: "ge4", type: "math-scale", x: 2, y: 3, params: {} },
        { id: "ge5", type: "fx-delay", x: 4, y: 0, params: {} },
        { id: "ge6", type: "audio-out", x: 6, y: 0, params: {} },
      ],
      cables: [
        { from: { module: "ge1", port: "out" }, to: { module: "ge3", port: "a" } },
        { from: { module: "ge2", port: "uni" }, to: { module: "ge3", port: "b" } },
        { from: { module: "ge3", port: "out" }, to: { module: "ge5", port: "in" } },
        { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "in" } },
        { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "time" } },
        { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "left" } },
      ],
    });
    const voice = compile(tremolo, abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    const [product, scaled, delay] = ["ge-math-multiply", "ge-math-scale", "ge-fx-delay"].map((name) => names.indexOf(name));
    // The product goes into the delay through a gate; the scaled LFO goes straight into its Time.
    expect(voice).not.toContain(`#X connect ${product} 0 ${delay} 0;`);
    expect(voice).toContain(`#X connect ${scaled} 0 ${delay} 1;`);
  });

  it("lets a modulation signal into a module with a tail as it is", () => {
    const wobble = doc({
      modules: [
        { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
        { id: "ge2", type: "lfo", x: 0, y: 3, params: {} },
        { id: "ge3", type: "fx-delay", x: 2, y: 0, params: {} },
        { id: "ge4", type: "audio-out", x: 4, y: 0, params: {} },
      ],
      cables: [
        { from: { module: "ge1", port: "out" }, to: { module: "ge3", port: "in" } },
        { from: { module: "ge2", port: "uni" }, to: { module: "ge3", port: "time" } },
        { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "left" } },
      ],
    });
    const voice = compile(wobble, abstractionLibrary).files["voice.pd"];
    const names = objectBoxes(voice).map((b) => b.name);
    const [lfo, delay, saw] = ["ge-lfo", "ge-fx-delay", "ge-osc-saw"].map((name) => names.indexOf(name));
    // The LFO's second outlet goes straight into the delay's Time input; the saw does not go straight in.
    expect(voice).toContain(`#X connect ${lfo} 1 ${delay} 1;`);
    expect(voice).not.toContain(`#X connect ${saw} 0 ${delay} 0;`);
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
      expect(result.samples).toEqual([{ file: "ge-sample-a.wav", path: "tests/golden/sampler/ge-sample-a.wav" }]);
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
      const second = ops.setParam(ops.addModule(echo, "sample-recorder", { x: 0, y: 8 }).doc, "ge11", "sample", 1);
      const refused = compile(second, abstractionLibrary);
      expect(refused.ok).toBe(false);
      expect(refused.diagnostics).toEqual([
        { severity: "error", code: "two-recorders", message: "Two modules record onto sample B. A sample can have one.", module: "ge11" },
      ]);
      // On another tape it is fine, apart from that tape being empty.
      expect(compile(ops.setParam(second, "ge11", "sample", 2), abstractionLibrary).diagnostics.map((d) => d.code)).toEqual(["empty-sample"]);
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

    it("keeps a voice alive while a Sample Player plays on, by its Playing output", () => {
      // The Player's third outlet joins the key gate in what keeps the voice playing.
      const voice = result.files["voice.pd"].split("\n");
      const boxes = voice.filter((line) => line.startsWith("#X obj") || line.startsWith("#X msg"));
      const player = boxes.findIndex((line) => line.includes("ge-sample-player ge1"));
      const held = voice.filter((line) => line.startsWith(`#X connect ${player} 2 `));
      expect(held).toHaveLength(1);
      expect(boxes[Number(held[0].split(" ")[4])]).toContain("max~");
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
