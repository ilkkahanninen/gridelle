/**
 * What a signal is meant to carry. It drives port colour and pre-cords only:
 * any output can be patched into any input. `notes` is the hint of a note port.
 */
export type SignalHint = "audio" | "pitch" | "gate" | "phase" | "mod" | "notes";

/** The per-voice signals a pre-cord can supply. */
/** The voice's signals: its note's pitch, gate and velocity. */
export type VoiceSignal = "pitch" | "gate" | "velocity";

export interface PortDef {
  id: string;
  label: string;
  hint: SignalHint;
  /** Inputs only: fed from this voice signal while the port has no cable. */
  precord?: VoiceSignal;
  /**
   * Inputs only: the parameter this input belongs to. The module multiplies the two
   * (an ADSR time by its input, a mixer channel by its level), and in a `rows` layout
   * the parameter's knob sits in the input's row.
   */
  param?: string;
  /**
   * Inputs only: the signal the input holds while it has no cable, where 0 will not do.
   * A setting's input rests at 1, so that the knob alone gives the value. The compiler
   * supplies it, since a Pd abstraction cannot tell whether an inlet is connected.
   */
  unpatched?: number;
  /**
   * Inputs only: the input whose value this one moves (adds to), such as Width modulation's
   * Width. It comes right after that input, and the tile joins the two and labels this one ±.
   */
  modulates?: string;
  /**
   * `notes`: the port carries notes, not a signal: `pitch velocity` messages, at a control
   * `inlet` or `outlet` of the abstraction. A note output goes to note inputs only, and a
   * note input with no cable gets the keyboard's notes. Only modules that run once have them.
   */
  kind?: "notes";
}

export interface ParamDef {
  id: string;
  label: string;
  /**
   * A shorter name for the Organelle's screen, used where the label does not fit on a line
   * beside the module's name and the value ("Res" for Resonance).
   */
  short?: string;
  min: number;
  max: number;
  default: number;
  /** How a 0–1 control position maps onto min–max. `exp` needs min > 0. */
  curve: "lin" | "exp";
  unit?: string;
  /** Snap to multiples of this (e.g. 1 for whole semitones). */
  step?: number;
  /**
   * Decimals to show the value with, in the editor and on the Organelle's screen, where
   * the usual rule (fewer for a wider range) would hide the low end: an LFO's 0.02 Hz.
   */
  decimals?: number;
  /**
   * A choice instead of a range: the value is the index of the chosen option, so
   * `min` is 0, `max` the last index and `step` 1. Shown as a list in the inspector,
   * not as a knob.
   */
  options?: string[];
  /**
   * A number typed in the settings pane instead of turned on a knob: no knob on the tile
   * and no input of its own (the Constant's Value). The tile shows the value.
   */
  entry?: boolean;
  /**
   * The value is built into the patch instead of sent to it: it is passed to the module's
   * abstraction as a creation argument after the module's id (`$2`, then `$3` for a second
   * such parameter), there is no receiver for it, and changing it reloads the patch. For
   * what names an object needs when it is created: which sample a module plays.
   */
  argument?: boolean;
}

export type Category =
  | "io"
  | "sample"
  | "oscillator"
  | "envelope"
  | "lfo"
  | "filter"
  | "level"
  | "pitch"
  | "shaper"
  | "random"
  | "fx"
  | "math"
  | "logic"
  | "sequence";

/**
 * Where a module runs: `voice` in every voice (its tile is in the voice area), `global`
 * once for the whole patch (outside it). See `model/area.ts`.
 */
export type Scope = "voice" | "global";

export interface ModuleDef {
  /** Registry key stored in documents. */
  type: string;
  name: string;
  category: Category;
  /** Tile size in grid cells. */
  width: number;
  height: number;
  /** Order matches the abstraction's `inlet~` objects, left to right. */
  inputs: PortDef[];
  /** Order matches the abstraction's `outlet~` objects, left to right. */
  outputs: PortDef[];
  /** Each parameter is a `[r $1-<id>]` inside the abstraction. */
  params: ParamDef[];
  /** Abstraction name in `pd-lib/modules`, without `.pd`. */
  pd: string;
  /**
   * `outside`: the module can only run once for the whole patch, so its tile may not be in
   * the voice area (Audio Out, Audio In, the Recorder). Without it a module goes anywhere.
   */
  place?: "outside";
  /**
   * Voice signals the abstraction takes at its first inlets, before those of `inputs`.
   * They are not ports: the compiler always feeds them (the Keys module, which only has
   * outputs, gets the played note this way).
   */
  voiceInlets?: VoiceSignal[];
  /**
   * Input pairs where the second is fed from the first's source when it has no
   * cable of its own (Audio Out's right channel follows the left).
   */
  normalled?: [from: string, to: string][];
  /**
   * How the module uses its sample, where that matters to the patch as a whole: `writes`
   * for the one module that may record onto a sample (a Recorder), `follows` for one that
   * plays from where the recording is (a Tape Head) and so needs something to record it,
   * `wavetable` for one that reads it as a wavetable (the Wavetable oscillator), which is
   * another table of the slot: `ge-wave-<slot>`, built for it by the editor.
   */
  sample?: "writes" | "follows" | "wavetable";
  /**
   * The editor draws what comes in at this module's first input (a Scope). The compiler
   * numbers such modules and passes the abstraction that number and the voice it is in
   * (-1 outside the voices), after its id: see `ge-scope`.
   */
  tap?: boolean;
  /**
   * `rows`: the tile lists its inputs as rows, two to a grid cell under a half-cell
   * header with the name, each with its port on the left edge and, where the input has
   * a `param`, that parameter's knob beside it. `height` must be `ceil((rows + 1) / 2)`.
   * Without it, ports run down the left edge and the knobs sit in a row along the bottom.
   */
  layout?: "rows";
  /**
   * A `rows` module whose input *i* belongs with parameter *i* (a mixer channel and its level). The editor
   * shows only the pairs in use plus one free pair, and the tile grows downwards with
   * them; see `visibleDef`. The definition and the abstraction always have all of them,
   * and `height` is the tile's height with a single pair.
   */
  growsWithInputs?: boolean;
}
