import { settle } from "./model/ops";
import { DOCUMENT_VERSION, type PatchDocument } from "./model/types";

/**
 * Example patches. They double as compiler test fixtures (their compiled output is
 * kept in `tests/golden` and loaded into real Pd by the Rust tests).
 *
 * `basicSynth` is the patch the app opens with, so it is laid out by hand. The others were
 * placed when tiles were smaller: `settle` moves apart what overlaps now.
 */

/** Saw into a low-pass with its own envelope, into an amp with a second envelope. */
export const basicSynth: PatchDocument = {
  version: DOCUMENT_VERSION,
  name: "Basic Synth",
  voices: 4,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "filter-lp", x: 2, y: 0, params: { cutoff: 400, res: 0.5, mod: 48 } },
    { id: "ge3", type: "amp", x: 4, y: 0, params: {} },
    { id: "ge4", type: "audio-out", x: 5, y: 0, params: {} },
    { id: "ge5", type: "env-adsr", x: 0, y: 3, params: { attack: 2, decay: 300, sustain: 0.2, release: 200 } },
    { id: "ge6", type: "env-adsr", x: 2, y: 3, params: { attack: 2, decay: 100, sustain: 0.8, release: 150 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge2", port: "mod" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge3", port: "cv" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "left" } },
  ],
  pages: [
    {
      name: "Filter",
      knobs: [
        { module: "ge2", param: "cutoff" },
        { module: "ge2", param: "res" },
        { module: "ge2", param: "mod" },
        { module: "ge1", param: "tune" },
      ],
    },
    {
      name: "Amp envelope",
      knobs: [{ module: "ge6", param: "attack" }, null, { module: "ge6", param: "sustain" }, { module: "ge6", param: "release" }],
    },
  ],
};

/** Two detuned saws per voice, with one filter shared by all voices after the voice sum. */
export const sharedFilter: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Shared Filter",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: { fine: -8 } },
    { id: "ge2", type: "osc-saw", x: 0, y: 2, params: { tune: 12, fine: 8 } },
    { id: "ge3", type: "env-adsr", x: 0, y: 4, params: { release: 400 } },
    { id: "ge4", type: "amp", x: 3, y: 0, params: { level: 0.5 } },
    { id: "ge5", type: "amp", x: 3, y: 2, params: { level: 0.5 } },
    { id: "ge6", type: "voice-sum", x: 5, y: 0, params: {} },
    { id: "ge7", type: "voice-sum", x: 5, y: 2, params: {} },
    { id: "ge8", type: "filter-lp", x: 6, y: 0, params: { cutoff: 2500 } },
    { id: "ge9", type: "audio-out", x: 8, y: 0, params: {} },
    // After the voice sum, so there is one delay for all voices.
    { id: "ge10", type: "fx-delay", x: 10, y: 0, params: { time: 150, feedback: 0.2 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "cv" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge5", port: "cv" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge10", port: "in" } },
    { from: { module: "ge10", port: "out" }, to: { module: "ge9", port: "left" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge9", port: "right" } },
  ],
  pages: [],
});

/**
 * Every oscillator and noise into a mixer, then through each filter in turn, with the
 * oscillators' Mod inputs patched in each of the three modes. Not a patch anyone would
 * play; it puts all the sources and filters in front of real Pd.
 */
export const sourcesAndFilters: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Sources and Filters",
  voices: 2,
  modules: [
    { id: "ge1", type: "osc-sine", x: 0, y: 0, params: {} },
    { id: "ge2", type: "osc-tri", x: 0, y: 2, params: { tune: 12, mode: 1, depth: 0.1 } },
    { id: "ge3", type: "osc-pulse", x: 0, y: 4, params: { width: 30, depth: 0.4 } },
    { id: "ge4", type: "noise", x: 0, y: 6, params: {} },
    { id: "ge5", type: "osc-saw", x: 0, y: 7, params: { fine: 7, mode: 2, depth: 1 } },
    { id: "ge6", type: "mixer", x: 3, y: 0, params: { level1: 0.5, level2: 0.5, level3: 0.4, level4: 0.1, level5: 0.4 } },
    { id: "ge7", type: "filter-hp", x: 6, y: 0, params: { cutoff: 60, res: 0 } },
    { id: "ge8", type: "filter-bp", x: 8, y: 0, params: { cutoff: 700, res: 0 } },
    { id: "ge9", type: "filter-notch", x: 10, y: 0, params: { cutoff: 3000, res: 0.3 } },
    { id: "ge10", type: "filter-lp", x: 12, y: 0, params: { cutoff: 5000, res: 0.3 } },
    { id: "ge11", type: "env-adsr", x: 8, y: 2, params: { release: 200 } },
    { id: "ge12", type: "amp", x: 14, y: 0, params: {} },
    { id: "ge13", type: "audio-out", x: 15, y: 0, params: {} },
    { id: "ge14", type: "env-adsr", x: 10, y: 2, params: { attack: 50, decay: 400, sustain: 0.5 } },
    { id: "ge15", type: "lfo", x: 18, y: 0, params: { rate: 6, shape: 1 } },
    { id: "ge16", type: "lfo-random", x: 18, y: 2, params: { rate: 20, smooth: 0.5 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge6", port: "in1" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge6", port: "in2" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge6", port: "in3" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge6", port: "in4" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in5" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge9", port: "in" } },
    { from: { module: "ge9", port: "out" }, to: { module: "ge10", port: "in" } },
    { from: { module: "ge10", port: "out" }, to: { module: "ge12", port: "in" } },
    { from: { module: "ge11", port: "out" }, to: { module: "ge12", port: "cv" } },
    { from: { module: "ge12", port: "out" }, to: { module: "ge13", port: "left" } },
    // Sine bends the triangle's pitch, the triangle shifts the pulse's frequency, the envelope lifts the saw's level.
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "mod" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "mod" } },
    { from: { module: "ge11", port: "out" }, to: { module: "ge5", port: "mod" } },
    // A second envelope sets how long the first one's release is: its knob times where the second stands at key up.
    { from: { module: "ge14", port: "out" }, to: { module: "ge11", port: "release" } },
    // An LFO sweeps the last filter, and random values move the pulse's width.
    { from: { module: "ge15", port: "out" }, to: { module: "ge10", port: "mod" } },
    { from: { module: "ge16", port: "out" }, to: { module: "ge3", port: "pwm" } },
  ],
  pages: [
    {
      name: "Mix",
      knobs: [
        { module: "ge6", param: "level1" },
        { module: "ge6", param: "level4" },
        { module: "ge3", param: "width" },
        { module: "ge8", param: "cutoff" },
      ],
    },
  ],
});

/**
 * A saw through every shaper. The Amp comes first, so the shapers are fed silence between
 * notes and have to stay silent themselves; the envelope also moves the fold and the order.
 */
export const shapers: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Shapers",
  voices: 2,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 2, params: { release: 200 } },
    { id: "ge4", type: "shaper-fold", x: 3, y: 0, params: { drive: 12, symmetry: 0.4, shape: 1 } },
    { id: "ge5", type: "shaper-cheby", x: 5, y: 0, params: { order: 3.5, drive: -3 } },
    { id: "ge6", type: "shaper-soft", x: 7, y: 0, params: { drive: 9, bias: 0.5 } },
    { id: "ge7", type: "shaper-hard", x: 9, y: 0, params: { drive: 3 } },
    { id: "ge8", type: "audio-out", x: 15, y: 0, params: {} },
    { id: "ge9", type: "shaper-rectify", x: 11, y: 0, params: { amount: 0.8 } },
    { id: "ge10", type: "shaper-crush", x: 13, y: 0, params: { rate: 4000, bits: 5 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "mod" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge5", port: "mod" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge9", port: "in" } },
    { from: { module: "ge9", port: "out" }, to: { module: "ge10", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge10", port: "mod" } },
    { from: { module: "ge10", port: "out" }, to: { module: "ge8", port: "left" } },
  ],
  pages: [
    {
      name: "Shape",
      knobs: [
        { module: "ge4", param: "drive" },
        { module: "ge4", param: "symmetry" },
        { module: "ge5", param: "order" },
        { module: "ge6", param: "drive" },
      ],
    },
  ],
});

/**
 * An oscillator with nothing between it and the output: a drone. Every voice sounds all
 * the time, on middle C until it gets a note (not on pitch 0, which would tick at 8 Hz)
 * and on its last note after that.
 */
export const bareOscillator: PatchDocument = {
  version: DOCUMENT_VERSION,
  name: "Bare Oscillator",
  voices: 4,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "audio-out", x: 2, y: 0, params: {} },
  ],
  cables: [{ from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "left" } }],
  pages: [],
};

/**
 * Every effect inside the voices, behind an oscillator with no Amp: a drone through
 * effects, each voice with its own.
 */
export const voiceEffects: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Voice Effects",
  voices: 4,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "filter-allpass", x: 2, y: 0, params: { cutoff: 900 } },
    { id: "ge3", type: "fx-phaser", x: 4, y: 0, params: {} },
    { id: "ge4", type: "fx-chorus", x: 6, y: 0, params: {} },
    { id: "ge5", type: "fx-delay", x: 8, y: 0, params: { time: 120, feedback: 0.4, mix: 0.4 } },
    { id: "ge6", type: "fx-reverb", x: 10, y: 0, params: { decay: 0.4 } },
    { id: "ge7", type: "audio-out", x: 12, y: 0, params: { level: 0.15 } },
    // A second oscillator that reaches the output beside the effects, not through them.
    { id: "ge8", type: "osc-sine", x: 0, y: 4, params: { tune: 12 } },
    { id: "ge9", type: "mixer", x: 10, y: 4, params: { level2: 0.3 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "left" } },
    { from: { module: "ge6", port: "right" }, to: { module: "ge9", port: "in1" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge9", port: "in2" } },
    { from: { module: "ge9", port: "out" }, to: { module: "ge7", port: "right" } },
  ],
  pages: [],
});

/**
 * The modules that wrap objects of Pd itself: the filters in a row, the three reverbs after
 * the Amp, a Sample & Hold of noise on the Ladder's Mod and a Follower on the Soft Low-pass.
 * The Cavern is mixed in very low, because it cannot ring for less than two seconds.
 */
export const flavours: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Flavours",
  voices: 2,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "filter-ladder", x: 2, y: 0, params: { cutoff: 2000, res: 0.3, mod: 12 } },
    { id: "ge3", type: "filter-resonator", x: 4, y: 0, params: { cutoff: 800, res: 0.2 } },
    { id: "ge4", type: "filter-soft-lp", x: 6, y: 0, params: { cutoff: 6000, mod: 24 } },
    { id: "ge5", type: "filter-soft-hp", x: 8, y: 0, params: { cutoff: 80 } },
    { id: "ge6", type: "amp", x: 10, y: 0, params: {} },
    { id: "ge7", type: "env-adsr", x: 10, y: 3, params: { release: 100 } },
    { id: "ge8", type: "fx-cavern", x: 11, y: 0, params: { mix: 0.03 } },
    { id: "ge9", type: "fx-room", x: 13, y: 0, params: { decay: 0.3 } },
    { id: "ge10", type: "fx-hall", x: 15, y: 0, params: { decay: 0.3 } },
    { id: "ge11", type: "audio-out", x: 17, y: 0, params: { level: 0.2 } },
    { id: "ge12", type: "noise", x: 0, y: 4, params: {} },
    { id: "ge13", type: "sample-hold", x: 1, y: 4, params: {} },
    { id: "ge14", type: "follower", x: 4, y: 4, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge3", port: "low" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge6", port: "cv" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge9", port: "in" } },
    { from: { module: "ge9", port: "out" }, to: { module: "ge10", port: "in" } },
    { from: { module: "ge10", port: "out" }, to: { module: "ge11", port: "left" } },
    { from: { module: "ge10", port: "right" }, to: { module: "ge11", port: "right" } },
    { from: { module: "ge12", port: "out" }, to: { module: "ge13", port: "in" } },
    { from: { module: "ge13", port: "out" }, to: { module: "ge2", port: "mod" } },
    { from: { module: "ge1", port: "out" }, to: { module: "ge14", port: "in" } },
    { from: { module: "ge14", port: "out" }, to: { module: "ge4", port: "mod" } },
  ],
  pages: [],
});

/**
 * The audio input through a filter, mixed with a synth voice. The input and what follows
 * it run once, after the voices.
 */
export const audioInput: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Audio Input",
  voices: 2,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 3, params: { release: 100 } },
    { id: "ge4", type: "audio-in", x: 3, y: 3, params: {} },
    { id: "ge5", type: "filter-lp", x: 4, y: 3, params: { cutoff: 8000, res: 0 } },
    { id: "ge6", type: "mixer", x: 7, y: 0, params: { level3: 0.5 } },
    { id: "ge7", type: "audio-out", x: 9, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge6", port: "in1" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in2" } },
    { from: { module: "ge4", port: "right" }, to: { module: "ge6", port: "in3" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "left" } },
  ],
  pages: [],
});

/**
 * The pitch modules in a row in front of an oscillator: the played note from Keys, glided,
 * transposed, then snapped to A minor with random steps added. Velocity sets how loud the
 * envelope's sustain is.
 */
export const pitches: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Pitches",
  voices: 3,
  modules: [
    { id: "ge1", type: "keys", x: 0, y: 0, params: {} },
    { id: "ge2", type: "pitch-glide", x: 2, y: 0, params: { time: 30 } },
    { id: "ge3", type: "pitch-transpose", x: 4, y: 0, params: { octave: -1, semi: 7 } },
    { id: "ge4", type: "pitch-quantize", x: 6, y: 0, params: { root: 9, scale: 2 } },
    { id: "ge5", type: "lfo-random", x: 6, y: 3, params: { rate: 8 } },
    { id: "ge6", type: "osc-saw", x: 8, y: 0, params: {} },
    { id: "ge7", type: "amp", x: 10, y: 0, params: {} },
    { id: "ge8", type: "env-adsr", x: 8, y: 3, params: { release: 100 } },
    { id: "ge9", type: "audio-out", x: 11, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "pitch" }, to: { module: "ge2", port: "pitch" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "pitch" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "pitch" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge4", port: "mod" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge6", port: "pitch" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge1", port: "gate" }, to: { module: "ge8", port: "gate" } },
    { from: { module: "ge1", port: "velocity" }, to: { module: "ge8", port: "sustain" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge7", port: "cv" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge9", port: "left" } },
  ],
  pages: [],
});

/**
 * Every math and logic module in one patch. A saw and a sine are crossfaded (a Toggle on
 * the key gate picks which) and multiplied by a scaled LFO for a tremolo. The rest work on
 * the LFO beside that and end at inputs where they change nothing audible.
 */
export const mathAndLogic: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Math and Logic",
  voices: 2,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "osc-sine", x: 0, y: 3, params: { tune: 7 } },
    { id: "ge3", type: "math-crossfade", x: 2, y: 0, params: {} },
    { id: "ge4", type: "math-multiply", x: 4, y: 0, params: {} },
    { id: "ge5", type: "math-scale", x: 2, y: 3, params: { amount: 0.3, offset: 0.7 } },
    { id: "ge6", type: "lfo", x: 0, y: 6, params: { rate: 5 } },
    { id: "ge7", type: "amp", x: 5, y: 0, params: {} },
    { id: "ge8", type: "env-adsr", x: 5, y: 3, params: { release: 100 } },
    { id: "ge9", type: "audio-out", x: 6, y: 0, params: {} },
    { id: "ge10", type: "logic-toggle", x: 2, y: 6, params: {} },
    { id: "ge11", type: "math-constant", x: 8, y: 0, params: { value: 0.5 } },
    { id: "ge12", type: "math-add", x: 10, y: 0, params: {} },
    { id: "ge13", type: "math-max", x: 11, y: 0, params: {} },
    { id: "ge14", type: "math-abs", x: 10, y: 1, params: {} },
    { id: "ge15", type: "math-min", x: 12, y: 0, params: {} },
    { id: "ge16", type: "math-smooth", x: 13, y: 0, params: { rise: 20, fall: 200 } },
    { id: "ge17", type: "logic-compare", x: 8, y: 3, params: { threshold: 0 } },
    { id: "ge18", type: "logic-and", x: 11, y: 3, params: {} },
    { id: "ge19", type: "logic-not", x: 10, y: 3, params: {} },
    { id: "ge20", type: "logic-or", x: 12, y: 3, params: {} },
    { id: "ge21", type: "logic-divider", x: 13, y: 3, params: { divide: 3 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge3", port: "a" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "b" } },
    { from: { module: "ge10", port: "out" }, to: { module: "ge3", port: "mix" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "a" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge4", port: "b" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge7", port: "cv" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge9", port: "left" } },
    { from: { module: "ge11", port: "out" }, to: { module: "ge12", port: "a" } },
    { from: { module: "ge6", port: "uni" }, to: { module: "ge12", port: "b" } },
    { from: { module: "ge12", port: "out" }, to: { module: "ge13", port: "a" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge14", port: "in" } },
    { from: { module: "ge14", port: "out" }, to: { module: "ge13", port: "b" } },
    { from: { module: "ge13", port: "out" }, to: { module: "ge15", port: "a" } },
    { from: { module: "ge11", port: "out" }, to: { module: "ge15", port: "b" } },
    { from: { module: "ge15", port: "out" }, to: { module: "ge16", port: "in" } },
    { from: { module: "ge16", port: "out" }, to: { module: "ge1", port: "fine" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge17", port: "a" } },
    { from: { module: "ge17", port: "out" }, to: { module: "ge18", port: "a" } },
    { from: { module: "ge17", port: "out" }, to: { module: "ge19", port: "in" } },
    { from: { module: "ge19", port: "out" }, to: { module: "ge18", port: "b" } },
    { from: { module: "ge18", port: "out" }, to: { module: "ge20", port: "a" } },
    { from: { module: "ge19", port: "out" }, to: { module: "ge20", port: "b" } },
    { from: { module: "ge20", port: "out" }, to: { module: "ge21", port: "in" } },
    { from: { module: "ge21", port: "out" }, to: { module: "ge2", port: "fine" } },
  ],
  pages: [],
});

/**
 * Three Scopes on a plain synth voice: one on the oscillator and one on the envelope,
 * inside the voices, and one after the Voice Sum, on what is heard.
 */
export const scoped: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Scoped",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 3, params: { release: 100 } },
    { id: "ge4", type: "voice-sum", x: 3, y: 0, params: {} },
    { id: "ge5", type: "audio-out", x: 4, y: 0, params: {} },
    { id: "ge6", type: "scope", x: 6, y: 0, params: {} },
    { id: "ge7", type: "scope", x: 6, y: 2, params: { time: 3 } },
    { id: "ge8", type: "scope", x: 6, y: 4, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "left" } },
    { from: { module: "ge1", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge8", port: "in" } },
  ],
  pages: [],
});

/**
 * A sound file played from the keys, mixed with the same sound scanned by an LFO through a
 * Play Head, which an Amp lets through while the Player plays (its Playing output), since
 * nothing else would stop it. A second Play Head reads a blank tape, so both kinds of
 * sample are loaded.
 * The file is the tone in the fixture's golden folder: a quarter of a second of 441 Hz.
 */
export const sampler: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Sampler",
  voices: 3,
  modules: [
    { id: "ge1", type: "sample-player", x: 0, y: 0, params: { sample: 0 } },
    { id: "ge2", type: "lfo", x: 0, y: 3, params: { rate: 3, shape: 2 } },
    { id: "ge3", type: "sample-head", x: 2, y: 3, params: { sample: 0 } },
    { id: "ge4", type: "mixer", x: 4, y: 0, params: { level2: 0.5 } },
    { id: "ge5", type: "voice-sum", x: 6, y: 0, params: {} },
    { id: "ge6", type: "audio-out", x: 7, y: 0, params: {} },
    { id: "ge7", type: "sample-head", x: 4, y: 3, params: { sample: 1 } },
    { id: "ge8", type: "amp", x: 4, y: 5, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge4", port: "in1" } },
    { from: { module: "ge2", port: "uni" }, to: { module: "ge3", port: "position" } },
    // The Play Head never stops by itself: the Amp lets it through while the Player plays.
    { from: { module: "ge3", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge1", port: "playing" }, to: { module: "ge8", port: "cv" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge4", port: "in2" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "left" } },
  ],
  pages: [],
  samples: [
    { kind: "file", path: "tests/golden/sampler/ge-sample-a.wav", name: "tone.wav", frames: 11025, sampleRate: 44100 },
    { kind: "tape", seconds: 0.5 },
  ],
});

/**
 * A looper: a synth voice is recorded onto half a second of tape while a key is held (the
 * key gates of all voices, added up, are the Recorder's Record input), on top of what is
 * there. The tape is heard with the synth, and goes on playing with no key held.
 */
export const looper: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Looper",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 3, params: { release: 60 } },
    { id: "ge4", type: "keys", x: 2, y: 3, params: {} },
    { id: "ge5", type: "voice-sum", x: 3, y: 0, params: {} },
    { id: "ge6", type: "sample-recorder", x: 4, y: 0, params: { sample: 0, overdub: 1 } },
    { id: "ge7", type: "mixer", x: 7, y: 0, params: { level1: 0.5, level2: 0.5 } },
    { id: "ge8", type: "audio-out", x: 9, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge4", port: "gate" }, to: { module: "ge6", port: "record" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge7", port: "in1" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge7", port: "in2" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge8", port: "left" } },
  ],
  pages: [],
  samples: [{ kind: "tape", seconds: 0.5 }],
});

/**
 * A tape echo built from parts: the synth and the echoes are mixed and recorded onto a
 * second of tape, and a Tape Head plays the tape 120 ms behind, through a low-pass and a
 * soft clip, back into that mix. No cable runs from the Recorder to the Tape Head: the
 * tape is what closes the loop.
 */
export const tapeEcho: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Tape Echo",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 3, params: { release: 60 } },
    { id: "ge4", type: "voice-sum", x: 3, y: 0, params: {} },
    { id: "ge5", type: "mixer", x: 4, y: 0, params: { level2: 0.4 } },
    { id: "ge6", type: "sample-recorder", x: 6, y: 0, params: { sample: 1 } },
    { id: "ge7", type: "tape-head", x: 4, y: 3, params: { sample: 1, delay: 120 } },
    { id: "ge8", type: "filter-lp", x: 6, y: 3, params: { cutoff: 3000, res: 0, mod: 0 } },
    { id: "ge9", type: "shaper-soft", x: 8, y: 3, params: { drive: 0 } },
    { id: "ge10", type: "audio-out", x: 9, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in1" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge9", port: "in" } },
    { from: { module: "ge9", port: "out" }, to: { module: "ge5", port: "in2" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge10", port: "left" } },
  ],
  pages: [],
  samples: [null, { kind: "tape", seconds: 1 }],
});

/**
 * Grains of a sound file played from the keys, in stereo: left and right each through a
 * Voice Sum of its own. The file is the tone in the fixture's golden folder.
 */
export const grains: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Grains",
  voices: 3,
  modules: [
    { id: "ge1", type: "sample-grains", x: 0, y: 0, params: { sample: 0, scatter: 0.4, size: 60, density: 30, width: 1 } },
    { id: "ge2", type: "voice-sum", x: 2, y: 0, params: {} },
    { id: "ge3", type: "voice-sum", x: 2, y: 1, params: {} },
    { id: "ge4", type: "audio-out", x: 3, y: 0, params: { level: 1 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge1", port: "right" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "left" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "right" } },
  ],
  pages: [],
  samples: [{ kind: "file", path: "tests/golden/grains/ge-sample-a.wav", name: "tone.wav", frames: 11025, sampleRate: 44100 }],
});

/**
 * A Clock and a Sequencer: holding a key plays the sequence from that note, starting from
 * its first step, and letting go stops it. The clock's ticks also open the envelope, so
 * each step is a note of its own.
 */
export const sequence: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Sequence",
  voices: 2,
  modules: [
    { id: "ge1", type: "clock", x: 0, y: 0, params: { tempo: 140 } },
    { id: "ge2", type: "sequencer", x: 2, y: 0, params: { steps: 6, step5: -5 } },
    { id: "ge3", type: "osc-saw", x: 4, y: 0, params: {} },
    { id: "ge4", type: "filter-lp", x: 6, y: 0, params: { cutoff: 900, res: 0.4 } },
    { id: "ge5", type: "amp", x: 8, y: 0, params: {} },
    { id: "ge6", type: "env-adsr", x: 4, y: 3, params: { decay: 120, sustain: 0.3, release: 100 } },
    { id: "ge7", type: "audio-out", x: 9, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "clock" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "pitch" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge1", port: "out" }, to: { module: "ge6", port: "gate" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge5", port: "cv" } },
    // The step moves the filter too, a little.
    { from: { module: "ge2", port: "value" }, to: { module: "ge4", port: "mod" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge7", port: "left" } },
  ],
  pages: [
    {
      name: "Sequence",
      knobs: [
        { module: "ge1", param: "tempo" },
        { module: "ge1", param: "width" },
        { module: "ge2", param: "steps" },
        { module: "ge2", param: "step1" },
      ],
    },
  ],
});

/**
 * The two short envelopes. An AR opens the amp for as long as a key is held; an AD,
 * curved and looping while the key is down, sweeps the filter again and again.
 */
export const envelopes: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "Envelopes",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "filter-lp", x: 2, y: 0, params: { cutoff: 300, res: 0.5, mod: 48 } },
    { id: "ge3", type: "amp", x: 4, y: 0, params: {} },
    { id: "ge4", type: "env-ad", x: 2, y: 3, params: { attack: 5, decay: 120, shape: 1, loop: 1 } },
    { id: "ge5", type: "env-ar", x: 4, y: 3, params: { attack: 10, release: 120 } },
    { id: "ge6", type: "audio-out", x: 5, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge2", port: "mod" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge3", port: "cv" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge6", port: "left" } },
  ],
  pages: [],
});

/**
 * What a new patch starts as, until the user saves a base of their own over it: a saw
 * through an amp that an envelope opens, into the output. It sounds when a key is pressed,
 * and every part of it is easy to replace.
 */
export const newPatch: PatchDocument = settle({
  version: DOCUMENT_VERSION,
  name: "New patch",
  voices: 4,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "amp", x: 2, y: 0, params: {} },
    { id: "ge3", type: "env-adsr", x: 0, y: 3, params: {} },
    { id: "ge4", type: "audio-out", x: 3, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge2", port: "cv" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge4", port: "left" } },
  ],
  pages: [],
});

export const fixtures = {
  "basic-synth": basicSynth,
  "shared-filter": sharedFilter,
  "sources-and-filters": sourcesAndFilters,
  shapers,
  "bare-oscillator": bareOscillator,
  "voice-effects": voiceEffects,
  flavours,
  "audio-input": audioInput,
  pitches,
  "math-and-logic": mathAndLogic,
  scoped,
  sampler,
  looper,
  "tape-echo": tapeEcho,
  grains,
  sequence,
  envelopes,
  "new-patch": newPatch,
} as const;
