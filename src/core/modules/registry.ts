import type { ModuleDef, ParamDef, PortDef } from "./types";

const level = (id = "level", label = "Level", max = 2, def = 1): ParamDef => ({
  id,
  label,
  min: 0,
  max,
  default: def,
  curve: "lin",
});

/** A setting that picks one of `options`; its value is the option's index. */
const choice = (id: string, label: string, options: string[], def = 0): ParamDef => ({
  id,
  label,
  min: 0,
  max: options.length - 1,
  default: def,
  curve: "lin",
  step: 1,
  options,
});

const pitchInput: PortDef = { id: "pitch", label: "Pitch", hint: "pitch", precord: "pitch" };
const audioInput: PortDef = { id: "in", label: "In", hint: "audio" };
const audioOutput: PortDef = { id: "out", label: "Out", hint: "audio" };
/** A Mod input, with the knob that says how far it moves what it modulates. It rests at 0. */
const modInput = (amount: string): PortDef => ({ id: "mod", label: "Modulation", hint: "mod", param: amount });

/** How tall a rows tile is for this many inputs: two rows to a cell, under a half-cell header. */
const rowsHeight = (inputs: PortDef[]) => Math.ceil((inputs.length + 1) / 2);

/**
 * The input of a setting, Eurorack style: the knob scales what is patched in, and with
 * nothing patched the input rests at 1, so the knob alone sets the value.
 */
const settingInput = (param: string, label: string): PortDef => ({ id: param, label, hint: "mod", param, unpatched: 1 });

/**
 * The two outputs of a modulation source: the wave itself, between -1 and 1, and the same
 * wave between 0 and 1, for the inputs that multiply a setting.
 */
const modOutputs: PortDef[] = [
  { id: "out", label: "Out", hint: "mod" },
  { id: "uni", label: "0–1", hint: "mod" },
];

// Two decimals, or the slow end would read "0 Hz".
const lfoRate: ParamDef = { id: "rate", label: "Rate", min: 0.02, max: 50, default: 2, curve: "exp", unit: "Hz", decimals: 2 };

/** Tune and Fine, as every pitched oscillator has them. */
const tuning: ParamDef[] = [
  { id: "tune", label: "Tune", min: -36, max: 36, default: 0, curve: "lin", unit: "st", step: 1 },
  { id: "fine", label: "Fine tune", short: "Fine", min: -100, max: 100, default: 0, curve: "lin", unit: "ct" },
];

/**
 * What an oscillator does with its Mod input, in the order `ge-osc-mod` numbers them.
 * At full Depth a mod signal of 1 shifts the frequency by 8 times itself (linear),
 * bends the pitch by 48 semitones (exponential) or doubles the level (AM). Not zero by
 * default, so that a cable patched into Mod is heard straight away.
 */
const modulation: ParamDef[] = [
  { id: "depth", label: "Modulation", short: "Mod", min: 0, max: 1, default: 0.25, curve: "lin" },
  choice("mode", "Modulation mode", ["Linear FM", "Exponential FM", "AM"]),
];

/** Inputs between Fine and Mod, with their settings, are the oscillator's own (the Pulse's width). */
const oscillator = (type: string, name: string, own: { inputs: PortDef[]; params: ParamDef[] } = { inputs: [], params: [] }): ModuleDef => {
  const inputs = [pitchInput, settingInput("tune", "Tune"), settingInput("fine", "Fine tune"), ...own.inputs, modInput("depth")];
  return {
    type,
    name,
    category: "oscillator",
    width: 2,
    height: rowsHeight(inputs),
    layout: "rows",
    inputs,
    outputs: [audioOutput],
    params: [...tuning, ...own.params, ...modulation],
    pd: `ge-${type}`,
    scope: "voice",
  };
};

/** The filters differ only in what they let through; they share inputs and settings. */
const filter = (
  type: string,
  name: string,
  { res = true, outputs = [audioOutput] }: { res?: boolean; outputs?: PortDef[] } = {},
): ModuleDef => {
  const resonance: ParamDef = { id: "res", label: "Resonance", short: "Res", min: 0, max: 1, default: 0.2, curve: "lin" };
  // The Cutoff input multiplies the frequency; Mod adds to it in semitones, by its own knob.
  const inputs = [audioInput, settingInput("cutoff", "Cutoff"), ...(res ? [settingInput("res", "Resonance")] : []), modInput("mod")];
  return {
    type,
    name,
    category: "filter",
    width: 2,
    height: rowsHeight(inputs),
    layout: "rows",
    inputs,
    outputs,
    params: [
      { id: "cutoff", label: "Cutoff", min: 20, max: 18000, default: 1200, curve: "exp", unit: "Hz" },
      ...(res ? [resonance] : []),
      // Semitones of cutoff sweep per unit of the mod input.
      { id: "mod", label: "Modulation", short: "Mod", min: -96, max: 96, default: 36, curve: "lin", unit: "st" },
    ],
    pd: `ge-${type}`,
    scope: "voice",
  };
};

/**
 * A shaper: its settings in the order of their rows. Each has an input of its own, except
 * Mod, whose input is the Mod input, and choices, which have none.
 */
const shaper = (type: string, name: string, params: ParamDef[]): ModuleDef => {
  const inputs = [
    audioInput,
    ...params.filter((p) => !p.options).map((p) => (p.id === "mod" ? modInput("mod") : settingInput(p.id, p.label))),
  ];
  return {
    type,
    name,
    category: "shaper",
    width: 2,
    height: rowsHeight(inputs),
    layout: "rows",
    inputs,
    outputs: [audioOutput],
    params,
    pd: `ge-${type}`,
    scope: "voice",
  };
};

/**
 * The shapers that are driven harder for more effect: Drive is the gain before the
 * shaping, and Mod is how many dB a mod signal of 1 adds to it (`ge-drive`).
 */
const driven = (
  type: string,
  name: string,
  drive: Pick<ParamDef, "label" | "max" | "default">,
  extra: ParamDef[] = [],
): ModuleDef =>
  shaper(type, name, [
    { id: "drive", min: 0, curve: "lin", unit: "dB", ...drive },
    { id: "mod", label: "Modulation", short: "Mod", min: -36, max: 36, default: 12, curve: "lin", unit: "dB" },
    ...extra,
  ]);

/** A module that turns one pitch into another. Its Pitch input follows the played note. */
const pitchModule = (type: string, name: string, inputs: PortDef[], params: ParamDef[]): ModuleDef => ({
  type,
  name,
  category: "pitch",
  width: 2,
  height: rowsHeight([pitchInput, ...inputs]),
  layout: "rows",
  inputs: [pitchInput, ...inputs],
  outputs: [{ id: "out", label: "Out", hint: "pitch" }],
  params,
  pd: `ge-${type}`,
  scope: "voice",
});

/** A signal of any kind going in or out of a math or logic module. */
const anyOutput: PortDef = { id: "out", label: "Out", hint: "mod" };
const anyInput = (id: string, label: string): PortDef => ({ id, label, hint: "mod" });
const gateOutput: PortDef = { id: "out", label: "Out", hint: "gate" };
const gateInput = (id: string, label: string): PortDef => ({ id, label, hint: "gate" });

/** A module with no knobs, one cell big: its ports and nothing else. */
const operator = (type: string, name: string, category: "math" | "logic", inputs: PortDef[], output: PortDef): ModuleDef => ({
  type,
  name,
  category,
  width: 1,
  height: 1,
  inputs,
  outputs: [output],
  params: [],
  pd: `ge-${type}`,
  scope: "voice",
});

/** A math or logic module with knobs: rows, each knob beside the input it belongs to. */
const calculator = (
  type: string,
  name: string,
  category: "math" | "logic",
  inputs: PortDef[],
  output: PortDef,
  params: ParamDef[],
): ModuleDef => ({
  type,
  name,
  category,
  width: 2,
  height: rowsHeight(inputs),
  layout: "rows",
  inputs,
  outputs: [output],
  params,
  pd: `ge-${type}`,
  scope: "voice",
});

/** A left and a right output. The first is `out`, as on every module with one output. */
const stereoOutputs: PortDef[] = [
  { id: "out", label: "Left", hint: "audio" },
  { id: "right", label: "Right", hint: "audio" },
];

/** An effect: its settings in the order of their rows, each with an input of its own. */
const effect = (type: string, name: string, params: ParamDef[], outputs: PortDef[] = [audioOutput]): ModuleDef => {
  const inputs = [audioInput, ...params.map((p) => settingInput(p.id, p.label))];
  return {
    type,
    name,
    category: "fx",
    width: 2,
    height: rowsHeight(inputs),
    layout: "rows",
    inputs,
    outputs,
    params,
    pd: `ge-${type}`,
    scope: "voice",
    tail: true,
  };
};

/** How long Pd's own reverbs ring: the time to fall 60 dB. */
const reverbDecay: ParamDef = { id: "decay", label: "Decay", min: 0.2, max: 20, default: 2, curve: "exp", unit: "s" };
/** The frequency above which their Damp works. */
const reverbDamping: ParamDef = { ...level("damp", "Damping", 1, 0.3), short: "Damp" };
const reverbTone: ParamDef = { id: "tone", label: "Tone", min: 500, max: 12000, default: 3000, curve: "exp", unit: "Hz" };

/** The rate of an effect's own LFO. */
const sweepRate = (def: number): ParamDef => ({ id: "rate", label: "Rate", min: 0.02, max: 20, default: def, curve: "exp", unit: "Hz", decimals: 2 });

/** The widths of a Scope's picture, in milliseconds, in the order of its Time choice. */
export const SCOPE_TIMES = [5, 20, 100, 500, 2000];
/** The heights of a Scope's picture, either side of zero, after "Auto" in its Range choice. */
export const SCOPE_RANGES = [0.1, 1, 10, 100];

/** Inputs of the mixer's abstraction; the editor shows only as many as are in use. */
export const MIXER_INPUTS = 8;
const mixerChannels = Array.from({ length: MIXER_INPUTS }, (_, i) => i + 1);

const DEFS: ModuleDef[] = [
  {
    type: "audio-out",
    name: "Audio Out",
    category: "io",
    width: 1,
    height: 2,
    layout: "rows",
    inputs: [
      { id: "left", label: "Left", hint: "audio" },
      { id: "right", label: "Right", hint: "audio" },
      settingInput("level", "Level"),
    ],
    outputs: [],
    // Low enough that a four-voice chord of full-level oscillators stays under the host's clip at 1.
    params: [level("level", "Level", 1, 0.25)],
    pd: "ge-audio-out",
    scope: "global",
    normalled: [["left", "right"]],
  },
  {
    // The Organelle's audio input. There is one for all voices, so it runs once, and so does
    // everything patched after it: it is heard without a key being held.
    type: "audio-in",
    name: "Audio In",
    category: "io",
    width: 1,
    height: 1,
    inputs: [],
    outputs: stereoOutputs,
    params: [],
    pd: "ge-audio-in",
    scope: "global",
  },
  {
    // The note being played, as signals to patch from: its pitch, its gate, how hard the
    // key was hit, and where it is on the keyboard (0 at the bottom, 1 at note 127).
    type: "keys",
    name: "Keys",
    category: "io",
    width: 2,
    height: 2,
    inputs: [],
    voiceInlets: ["pitch", "gate", "velocity"],
    outputs: [
      { id: "pitch", label: "Pitch", hint: "pitch" },
      { id: "gate", label: "Gate", hint: "gate" },
      { id: "velocity", label: "Velocity", hint: "mod" },
      { id: "key", label: "Key", hint: "mod" },
    ],
    params: [],
    pd: "ge-keys",
    scope: "voice",
  },
  {
    // Draws the signal patched into it, in the editor only. Inside the voices it shows
    // the voice of the latest note. Time and Range say how it is drawn.
    type: "scope",
    name: "Scope",
    category: "io",
    width: 3,
    height: 2,
    inputs: [anyInput("in", "In")],
    outputs: [],
    params: [
      choice("time", "Time", SCOPE_TIMES.map((ms) => (ms < 1000 ? `${ms} ms` : `${ms / 1000} s`)), 1),
      choice("range", "Range", ["Auto", ...SCOPE_RANGES.map((range) => `± ${range}`)]),
    ],
    pd: "ge-scope",
    scope: "voice",
    tap: true,
  },
  {
    type: "voice-sum",
    name: "Voice Sum",
    category: "io",
    width: 1,
    height: 1,
    inputs: [{ id: "in", label: "In", hint: "audio" }],
    outputs: [{ id: "out", label: "Out", hint: "audio" }],
    params: [],
    pd: "ge-voice-sum",
    scope: "global",
  },
  oscillator("osc-sine", "Sine"),
  oscillator("osc-tri", "Triangle"),
  oscillator("osc-saw", "Saw"),
  // The output has no DC, so a narrow pulse peaks above 1 (up to 1.9 at the ends of Width).
  // Width is its knob times its input; PWM then adds to it, half a cycle for a signal of 1.
  oscillator("osc-pulse", "Pulse", {
    inputs: [settingInput("width", "Width"), { id: "pwm", label: "Width modulation", hint: "mod" }],
    params: [{ id: "width", label: "Width", min: 5, max: 95, default: 50, curve: "lin", unit: "%" }],
  }),
  {
    type: "noise",
    name: "Noise",
    category: "random",
    width: 1,
    height: 1,
    inputs: [],
    outputs: [audioOutput],
    params: [],
    pd: "ge-noise",
    scope: "voice",
  },
  {
    // Takes a sample of In each time Trig rises above a half, and holds it. Trig follows the
    // key gate, so by default it holds one value for each note.
    type: "sample-hold",
    name: "Sample & Hold",
    category: "random",
    width: 2,
    height: 1,
    inputs: [
      { id: "in", label: "In", hint: "mod" },
      { id: "trig", label: "Trigger", hint: "gate", precord: "gate" },
    ],
    outputs: [{ id: "out", label: "Out", hint: "mod" }],
    params: [],
    pd: "ge-sample-hold",
    scope: "voice",
  },
  {
    // Each stage has an input that its knob scales: the time or level in use is knob x input,
    // read when the stage starts (A, D and S at key down, R at key up).
    type: "env-adsr",
    name: "ADSR",
    category: "envelope",
    width: 2,
    height: 3,
    layout: "rows",
    inputs: [
      { id: "gate", label: "Gate", hint: "gate", precord: "gate" },
      settingInput("attack", "Attack"),
      settingInput("decay", "Decay"),
      settingInput("sustain", "Sustain"),
      settingInput("release", "Release"),
    ],
    outputs: [{ id: "out", label: "Out", hint: "mod" }],
    params: [
      { id: "attack", label: "Attack", min: 0.5, max: 5000, default: 5, curve: "exp", unit: "ms" },
      { id: "decay", label: "Decay", min: 1, max: 5000, default: 200, curve: "exp", unit: "ms" },
      { id: "sustain", label: "Sustain", min: 0, max: 1, default: 0.6, curve: "lin" },
      { id: "release", label: "Release", min: 1, max: 10000, default: 300, curve: "exp", unit: "ms" },
    ],
    pd: "ge-env-adsr",
    scope: "voice",
    holdsVoice: true,
  },
  {
    // How loud its input is, as a modulation signal: the rms level, times Level. Smooth is
    // how long it takes to reach each new measurement (Pd's `env~` makes 86 a second).
    type: "follower",
    name: "Follower",
    category: "envelope",
    width: 2,
    height: 2,
    layout: "rows",
    inputs: [audioInput, settingInput("smooth", "Smooth"), settingInput("level", "Level")],
    outputs: [{ id: "out", label: "Out", hint: "mod" }],
    params: [{ id: "smooth", label: "Smooth", min: 5, max: 1000, default: 50, curve: "exp", unit: "ms" }, level("level", "Level", 4)],
    pd: "ge-follower",
    scope: "voice",
  },
  {
    // A rising edge at Reset starts the wave again. It follows the key gate, so each note's
    // LFO starts from the beginning; with that pre-cord switched off it runs free.
    type: "lfo",
    name: "LFO",
    category: "lfo",
    width: 2,
    height: 2,
    layout: "rows",
    inputs: [
      { id: "reset", label: "Reset", hint: "gate", precord: "gate" },
      settingInput("rate", "Rate"),
      settingInput("level", "Level"),
    ],
    outputs: modOutputs,
    params: [
      lfoRate,
      level("level", "Level", 1),
      // In the order `ge-lfo` numbers them. Saw rises, Ramp falls.
      choice("shape", "Shape", ["Sine", "Triangle", "Saw", "Ramp", "Square"]),
    ],
    pd: "ge-lfo",
    scope: "voice",
  },
  {
    // A new random value at every tick of Rate. Smooth is the part of a tick spent gliding
    // to it from the one before: 0 gives steps, 1 a line that never rests.
    type: "lfo-random",
    name: "Random",
    category: "lfo",
    width: 2,
    height: 2,
    layout: "rows",
    inputs: [settingInput("rate", "Rate"), settingInput("smooth", "Smooth"), settingInput("level", "Level")],
    outputs: modOutputs,
    params: [lfoRate, { id: "smooth", label: "Smooth", min: 0, max: 1, default: 0, curve: "lin" }, level("level", "Level", 1)],
    pd: "ge-lfo-random",
    scope: "voice",
  },
  // The pitch modules take and give a pitch as the oscillators do: a note number.
  pitchModule("pitch-transpose", "Transpose", [settingInput("octave", "Octave"), settingInput("semi", "Semitones"), modInput("mod")], [
    { id: "octave", label: "Octave", min: -4, max: 4, default: 0, curve: "lin", step: 1, unit: "oct" },
    { id: "semi", label: "Semitones", short: "Semi", min: -12, max: 12, default: 0, curve: "lin", step: 1, unit: "st" },
    // Semitones per unit of the mod input: an LFO here is vibrato.
    { id: "mod", label: "Modulation", short: "Mod", min: -24, max: 24, default: 1, curve: "lin", unit: "st" },
  ]),
  // Slides to each new pitch instead of jumping. Time is how long 95 % of the way takes.
  pitchModule("pitch-glide", "Glide", [settingInput("time", "Time")], [
    { id: "time", label: "Time", min: 1, max: 5000, default: 80, curve: "exp", unit: "ms" },
  ]),
  // Snaps a pitch to the nearest note of a scale. What comes in at Mod is added first,
  // Range semitones for a signal of 1, so an LFO or Random plays notes of the scale.
  pitchModule("pitch-quantize", "Quantizer", [modInput("mod")], [
    { id: "mod", label: "Range", min: -48, max: 48, default: 12, curve: "lin", unit: "st" },
    choice("root", "Root", ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]),
    // In the order of the tables in `ge-pitch-quantize`.
    choice("scale", "Scale", ["Chromatic", "Major", "Minor", "Major pentatonic", "Minor pentatonic", "Dorian", "Blues", "Whole tone"], 1),
  ]),
  filter("filter-lp", "Low-pass"),
  filter("filter-hp", "High-pass"),
  filter("filter-bp", "Band-pass"),
  filter("filter-notch", "Notch"),
  // Lets every frequency through at full level and only turns its phase, by half a cycle at
  // Cutoff. Mixed with its input it makes a notch there: the stage a phaser is built from.
  filter("filter-allpass", "All-pass"),
  // The filters below wrap objects of Pd itself, for other flavours of the same jobs.
  // Pd's `bob~`, a simulation of the Moog ladder: it saturates, and from a Res of about 0.9
  // it sings by itself at its cutoff. In Pd before 0.52, which the Organelle has, `bob~`
  // gives the first of its four stages: 6 dB an octave above the cutoff, not 24.
  filter("filter-ladder", "Ladder"),
  // Pd's `vcf~`: a filter that rings at its frequency, with a band-pass and a low-pass output.
  filter("filter-resonator", "Resonator", {
    outputs: [
      { id: "out", label: "Band", hint: "audio" },
      { id: "low", label: "Low", hint: "audio" },
    ],
  }),
  // The gentle 6 dB an octave of Pd's `lop~` and `hip~`, with no resonance.
  filter("filter-soft-lp", "Soft Low-pass", { res: false }),
  filter("filter-soft-hp", "Soft High-pass", { res: false }),
  // tanh: rounds the peaks off, more and more squarely as it is driven. Bias shifts the
  // signal first, so one side clips sooner: the even harmonics of a tube stage.
  driven("shaper-soft", "Soft Clip", { label: "Drive", max: 36, default: 6 }, [
    { id: "bias", label: "Bias", min: -1, max: 1, default: 0, curve: "lin" },
  ]),
  driven("shaper-hard", "Hard Clip", { label: "Drive", max: 36, default: 6 }),
  // Reflects what goes past ±1 back inside, with sharp corners (Triangle) or round ones (Sine).
  // Symmetry shifts the signal first, which adds even harmonics.
  driven("shaper-fold", "Wavefolder", { label: "Fold", max: 30, default: 6 }, [
    { id: "symmetry", label: "Symmetry", min: -1, max: 1, default: 0, curve: "lin" },
    choice("shape", "Shape", ["Triangle", "Sine"]),
  ]),
  // Chebyshev polynomial number Order turns a full-level sine into that harmonic; quieter
  // or richer input gives a mix. Order fades between neighbours, and Mod moves it.
  shaper("shaper-cheby", "Chebyshev", [
    { id: "order", label: "Harmonic", short: "Harm", min: 1, max: 8, default: 2, curve: "lin" },
    { id: "mod", label: "Modulation", short: "Mod", min: -7, max: 7, default: 2, curve: "lin" },
    // The input is clipped at ±1 after this gain, as the polynomials run away beyond it.
    { id: "drive", label: "Drive", min: -24, max: 12, default: 0, curve: "lin", unit: "dB" },
  ]),
  // Amount turns the negative half down and then up the other way: 0 leaves the signal
  // alone, 0.5 is half-wave, 1 full-wave (an octave up for a simple wave).
  shaper("shaper-rectify", "Rectifier", [
    { id: "amount", label: "Amount", min: 0, max: 1, default: 1, curve: "lin" },
    { id: "mod", label: "Modulation", short: "Mod", min: -1, max: 1, default: 0.5, curve: "lin" },
  ]),
  // Rate is how many samples a second get through, Bits how finely each is measured.
  shaper("shaper-crush", "Bitcrusher", [
    { id: "rate", label: "Rate", min: 100, max: 18000, default: 6000, curve: "exp", unit: "Hz" },
    { id: "bits", label: "Bits", min: 1, max: 16, default: 8, curve: "lin" },
    // Semitones of Rate per unit of the mod input.
    { id: "mod", label: "Modulation", short: "Mod", min: -96, max: 96, default: 24, curve: "lin", unit: "st" },
  ]),
  // An echo. Each repeat comes back through a low-pass at Tone, times Feedback.
  effect("fx-delay", "Delay", [
    { id: "time", label: "Time", min: 2, max: 2000, default: 300, curve: "exp", unit: "ms" },
    { id: "feedback", label: "Feedback", min: 0, max: 0.95, default: 0.4, curve: "lin" },
    { id: "tone", label: "Tone", min: 200, max: 18000, default: 6000, curve: "exp", unit: "Hz" },
    level("mix", "Mix", 1, 0.35),
  ]),
  // A room: fed-back delays whose length is Size and whose ring is Decay, darker with Damp.
  effect(
    "fx-reverb",
    "Reverb",
    [
      level("size", "Size", 1, 0.5),
      { id: "decay", label: "Decay", min: 0.1, max: 20, default: 2, curve: "exp", unit: "s" },
      { ...level("damp", "Damping", 1, 0.4), short: "Damp" },
      level("mix", "Mix", 1, 0.3),
    ],
    stereoOutputs,
  ),
  // Two taps of a short delay, swept by its own LFO a quarter cycle apart. With Depth low
  // and Feedback up it is a flanger.
  effect(
    "fx-chorus",
    "Chorus",
    [sweepRate(0.6), level("depth", "Depth", 1, 0.5), level("feedback", "Feedback", 0.9, 0), level("mix", "Mix", 1, 0.5)],
    stereoOutputs,
  ),
  // Four all-pass stages swept by its own LFO, mixed with the input: notches that move.
  effect("fx-phaser", "Phaser", [
    sweepRate(0.4),
    level("depth", "Depth", 1, 0.6),
    level("feedback", "Feedback", 0.9, 0.3),
    level("mix", "Mix", 1, 0.5),
  ]),
  // Pd's own reverbs, from its `extra` folder. Cavern (`rev1~`) is a row of all-pass delays
  // growing to a second and a half, so it echoes; Room (`rev2~`) is the light one, with four
  // delays; Hall (`rev3~`) has sixteen and is the densest and the heaviest.
  // The Cavern cannot ring for less than a couple of seconds: its delays are that long.
  effect("fx-cavern", "Cavern", [{ ...reverbDecay, min: 2.5, max: 40, default: 5 }, level("mix", "Mix", 1, 0.3)]),
  effect("fx-room", "Room", [reverbDecay, reverbDamping, reverbTone, level("mix", "Mix", 1, 0.3)], stereoOutputs),
  effect("fx-hall", "Hall", [reverbDecay, reverbDamping, reverbTone, level("mix", "Mix", 1, 0.3)], stereoOutputs),
  // Math: sums, products and the like, on any kind of signal.
  operator("math-add", "Add", "math", [anyInput("a", "A"), anyInput("b", "B")], anyOutput),
  // A ring modulator for two sounds, a VCA for a sound and a modulation.
  operator("math-multiply", "Multiply", "math", [anyInput("a", "A"), anyInput("b", "B")], anyOutput),
  // A knob as a signal, to patch a fixed value into any input. Range multiplies it.
  calculator("math-constant", "Constant", "math", [settingInput("value", "Value")], anyOutput, [
    { id: "value", label: "Value", min: -1, max: 1, default: 1, curve: "lin" },
    // In the order `ge-math-constant` numbers them.
    choice("range", "Range", ["x 1", "x 10", "x 100"]),
  ]),
  // An attenuverter with an offset: in x Amount + Offset.
  calculator("math-scale", "Scale", "math", [anyInput("in", "In"), settingInput("amount", "Amount"), settingInput("offset", "Offset")], anyOutput, [
    { id: "amount", label: "Amount", min: -2, max: 2, default: 1, curve: "lin" },
    { id: "offset", label: "Offset", min: -1, max: 1, default: 0, curve: "lin" },
  ]),
  // A at Mix 0, B at Mix 1, a straight blend between.
  calculator("math-crossfade", "Crossfade", "math", [anyInput("a", "A"), anyInput("b", "B"), settingInput("mix", "Mix")], anyOutput, [
    level("mix", "Mix", 1, 0.5),
  ]),
  // A lag: follows its input, taking Rise to go up and Fall to come down (95 % of the way).
  calculator("math-smooth", "Smooth", "math", [anyInput("in", "In"), settingInput("rise", "Rise"), settingInput("fall", "Fall")], anyOutput, [
    { id: "rise", label: "Rise", min: 0.1, max: 5000, default: 50, curve: "exp", unit: "ms" },
    { id: "fall", label: "Fall", min: 0.1, max: 5000, default: 50, curve: "exp", unit: "ms" },
  ]),
  operator("math-abs", "Abs", "math", [anyInput("in", "In")], anyOutput),
  operator("math-min", "Min", "math", [anyInput("a", "A"), anyInput("b", "B")], anyOutput),
  operator("math-max", "Max", "math", [anyInput("a", "A"), anyInput("b", "B")], anyOutput),
  // Logic: a signal is on above a half, and what comes out is 0 or 1.
  // On while A is above Threshold. Threshold's input makes it a comparison of two signals.
  calculator("logic-compare", "Compare", "logic", [anyInput("a", "A"), settingInput("threshold", "Threshold")], gateOutput, [
    { id: "threshold", label: "Threshold", min: -1, max: 1, default: 0.5, curve: "lin" },
  ]),
  operator("logic-and", "And", "logic", [gateInput("a", "A"), gateInput("b", "B")], gateOutput),
  operator("logic-or", "Or", "logic", [gateInput("a", "A"), gateInput("b", "B")], gateOutput),
  operator("logic-not", "Not", "logic", [gateInput("in", "In")], gateOutput),
  // Flips each time its input goes on: a latch. The input follows the key gate.
  operator("logic-toggle", "Toggle", "logic", [{ id: "in", label: "In", hint: "gate", precord: "gate" }], gateOutput),
  // Lets through the first of every Divide gates.
  calculator("logic-divider", "Divider", "logic", [gateInput("in", "In"), settingInput("divide", "Divide")], gateOutput, [
    { id: "divide", label: "Divide", min: 1, max: 16, default: 2, curve: "lin", step: 1 },
  ]),
  {
    type: "amp",
    name: "Amp",
    category: "level",
    width: 1,
    height: 2,
    layout: "rows",
    // CV is the input of Level: with nothing patched it rests at 1 and the Amp is a volume control.
    inputs: [audioInput, { id: "cv", label: "Level", hint: "mod", param: "level", unpatched: 1 }],
    outputs: [{ id: "out", label: "Out", hint: "audio" }],
    params: [level()],
    pd: "ge-amp",
    scope: "voice",
  },
  {
    type: "mixer",
    name: "Mixer",
    category: "level",
    width: 2,
    height: 1,
    layout: "rows",
    inputs: mixerChannels.map((n) => ({ id: `in${n}`, label: `${n}`, hint: "audio", param: `level${n}` })),
    outputs: [audioOutput],
    params: mixerChannels.map((n) => level(`level${n}`, `Level ${n}`)),
    pd: "ge-mixer",
    scope: "voice",
    growsWithInputs: true,
  },
];

const BY_TYPE = new Map(DEFS.map((def) => [def.type, def]));

/** Scope modules a patch can show at once: the channels the preview engine has for them. */
export const SCOPE_SLOTS = 8;

/** Every module the editor offers, in palette order. */
export const moduleDefs: readonly ModuleDef[] = DEFS;

export function getModuleDef(type: string): ModuleDef | undefined {
  return BY_TYPE.get(type);
}

/** Abstraction every generated voice uses to turn a note into pitch/gate/velocity signals. */
export const VOICE_ABSTRACTION = "ge-voice";
