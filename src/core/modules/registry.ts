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
const modInput = (amount: string): PortDef => ({ id: "mod", label: "Mod", hint: "mod", param: amount });

/** How tall a rows tile is for this many inputs: two rows to a cell, under a half-cell header. */
const rowsHeight = (inputs: PortDef[]) => Math.ceil((inputs.length + 1) / 2);

/**
 * The input of a setting, Eurorack style: the knob scales what is patched in, and with
 * nothing patched the input rests at 1, so the knob alone sets the value.
 */
const settingInput = (param: string, label: string): PortDef => ({ id: param, label, hint: "mod", param, unpatched: 1 });

/** Tune and Fine, as every pitched oscillator has them. */
const tuning: ParamDef[] = [
  { id: "tune", label: "Tune", min: -36, max: 36, default: 0, curve: "lin", unit: "st", step: 1 },
  { id: "fine", label: "Fine", min: -100, max: 100, default: 0, curve: "lin", unit: "ct" },
];

/**
 * What an oscillator does with its Mod input, in the order `ge-osc-mod` numbers them.
 * At full Depth a mod signal of 1 shifts the frequency by 8 times itself (linear),
 * bends the pitch by 48 semitones (exponential) or doubles the level (AM). Not zero by
 * default, so that a cable patched into Mod is heard straight away.
 */
const modulation: ParamDef[] = [
  { id: "depth", label: "Depth", min: 0, max: 1, default: 0.25, curve: "lin" },
  choice("mode", "Mod mode", ["Linear FM", "Exponential FM", "AM"]),
];

/** Inputs between Fine and Mod, with their settings, are the oscillator's own (the Pulse's width). */
const oscillator = (type: string, name: string, own: { inputs: PortDef[]; params: ParamDef[] } = { inputs: [], params: [] }): ModuleDef => {
  const inputs = [pitchInput, settingInput("tune", "Tune"), settingInput("fine", "Fine"), ...own.inputs, modInput("depth")];
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
const filter = (type: string, name: string): ModuleDef => ({
  type,
  name,
  category: "filter",
  width: 2,
  height: 3,
  layout: "rows",
  // The Cutoff input multiplies the frequency; Mod adds to it in semitones, by its own knob.
  inputs: [audioInput, settingInput("cutoff", "Cutoff"), settingInput("res", "Res"), modInput("mod")],
  outputs: [audioOutput],
  params: [
    { id: "cutoff", label: "Cutoff", min: 20, max: 18000, default: 1200, curve: "exp", unit: "Hz" },
    { id: "res", label: "Res", min: 0, max: 1, default: 0.2, curve: "lin" },
    // Semitones of cutoff sweep per unit of the mod input.
    { id: "mod", label: "Mod", min: -96, max: 96, default: 36, curve: "lin", unit: "st" },
  ],
  pd: `ge-${type}`,
  scope: "voice",
});

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
    { id: "mod", label: "Mod", min: -36, max: 36, default: 12, curve: "lin", unit: "dB" },
    ...extra,
  ]);

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
      { id: "left", label: "L", hint: "audio" },
      { id: "right", label: "R", hint: "audio" },
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
    inputs: [settingInput("width", "Width"), { id: "pwm", label: "PWM", hint: "mod" }],
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
      settingInput("attack", "A"),
      settingInput("decay", "D"),
      settingInput("sustain", "S"),
      settingInput("release", "R"),
    ],
    outputs: [{ id: "out", label: "Out", hint: "mod" }],
    params: [
      { id: "attack", label: "A", min: 0.5, max: 5000, default: 5, curve: "exp", unit: "ms" },
      { id: "decay", label: "D", min: 1, max: 5000, default: 200, curve: "exp", unit: "ms" },
      { id: "sustain", label: "S", min: 0, max: 1, default: 0.6, curve: "lin" },
      { id: "release", label: "R", min: 1, max: 10000, default: 300, curve: "exp", unit: "ms" },
    ],
    pd: "ge-env-adsr",
    scope: "voice",
  },
  filter("filter-lp", "Low-pass"),
  filter("filter-hp", "High-pass"),
  filter("filter-bp", "Band-pass"),
  filter("filter-notch", "Notch"),
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
    { id: "order", label: "Order", min: 1, max: 8, default: 2, curve: "lin" },
    { id: "mod", label: "Mod", min: -7, max: 7, default: 2, curve: "lin" },
    // The input is clipped at ±1 after this gain, as the polynomials run away beyond it.
    { id: "drive", label: "Drive", min: -24, max: 12, default: 0, curve: "lin", unit: "dB" },
  ]),
  // Amount turns the negative half down and then up the other way: 0 leaves the signal
  // alone, 0.5 is half-wave, 1 full-wave (an octave up for a simple wave).
  shaper("shaper-rectify", "Rectifier", [
    { id: "amount", label: "Amount", min: 0, max: 1, default: 1, curve: "lin" },
    { id: "mod", label: "Mod", min: -1, max: 1, default: 0.5, curve: "lin" },
  ]),
  // Rate is how many samples a second get through, Bits how finely each is measured.
  shaper("shaper-crush", "Bitcrusher", [
    { id: "rate", label: "Rate", min: 100, max: 18000, default: 6000, curve: "exp", unit: "Hz" },
    { id: "bits", label: "Bits", min: 1, max: 16, default: 8, curve: "lin" },
    // Semitones of Rate per unit of the mod input.
    { id: "mod", label: "Mod", min: -96, max: 96, default: 24, curve: "lin", unit: "st" },
  ]),
  {
    type: "amp",
    name: "Amp",
    category: "level",
    width: 1,
    height: 2,
    layout: "rows",
    // CV is the input of Level: with nothing patched it rests at 1 and the Amp is a volume control.
    inputs: [audioInput, { id: "cv", label: "CV", hint: "mod", param: "level", unpatched: 1 }],
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

/** Every module the editor offers, in palette order. */
export const moduleDefs: readonly ModuleDef[] = DEFS;

export function getModuleDef(type: string): ModuleDef | undefined {
  return BY_TYPE.get(type);
}

/** Abstraction every generated voice uses to turn a note into pitch/gate/velocity signals. */
export const VOICE_ABSTRACTION = "ge-voice";
