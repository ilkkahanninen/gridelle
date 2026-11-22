import type { ModuleDef, ParamDef, PortDef } from "./types";

const level = (id = "level", label = "Level", max = 2, def = 1): ParamDef => ({
  id,
  label,
  min: 0,
  max,
  default: def,
  curve: "lin",
});

const pitchInput: PortDef = { id: "pitch", label: "Pitch", hint: "pitch", precord: "pitch" };
const audioOutput: PortDef = { id: "out", label: "Out", hint: "audio" };

/** Tune and Fine, as every pitched oscillator has them. */
const tuning: ParamDef[] = [
  { id: "tune", label: "Tune", min: -36, max: 36, default: 0, curve: "lin", unit: "st", step: 1 },
  { id: "fine", label: "Fine", min: -100, max: 100, default: 0, curve: "lin", unit: "ct" },
];

const oscillator = (type: string, name: string, extra: Partial<ModuleDef> = {}): ModuleDef => ({
  type,
  name,
  category: "oscillator",
  width: 2,
  height: 2,
  inputs: [pitchInput],
  outputs: [audioOutput],
  params: tuning,
  pd: `ge-${type}`,
  scope: "voice",
  ...extra,
});

/** The filters differ only in what they let through; they share inputs and settings. */
const filter = (type: string, name: string): ModuleDef => ({
  type,
  name,
  category: "filter",
  width: 2,
  height: 2,
  inputs: [
    { id: "in", label: "In", hint: "audio" },
    { id: "mod", label: "Mod", hint: "mod" },
  ],
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
    inputs: [
      { id: "left", label: "L", hint: "audio" },
      { id: "right", label: "R", hint: "audio" },
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
  oscillator("osc-pulse", "Pulse", {
    inputs: [pitchInput, { id: "pwm", label: "PWM", hint: "mod" }],
    params: [...tuning, { id: "width", label: "Width", min: 5, max: 95, default: 50, curve: "lin", unit: "%" }],
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
    type: "env-adsr",
    name: "ADSR",
    category: "envelope",
    width: 3,
    height: 2,
    inputs: [{ id: "gate", label: "Gate", hint: "gate", precord: "gate" }],
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
  {
    type: "amp",
    name: "Amp",
    category: "level",
    width: 1,
    height: 2,
    inputs: [
      { id: "in", label: "In", hint: "audio" },
      { id: "cv", label: "CV", hint: "mod" },
    ],
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
    inputs: mixerChannels.map((n) => ({ id: `in${n}`, label: `${n}`, hint: "audio" })),
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
