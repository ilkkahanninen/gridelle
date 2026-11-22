/**
 * What a signal is meant to carry. It drives port colour and pre-cords only:
 * any output can be patched into any input.
 */
export type SignalHint = "audio" | "pitch" | "gate" | "phase" | "mod";

/** The per-voice signals a pre-cord can supply. */
export type VoiceSignal = "pitch" | "gate" | "velocity";

export interface PortDef {
  id: string;
  label: string;
  hint: SignalHint;
  /** Inputs only: fed from this voice signal while the port has no cable. */
  precord?: VoiceSignal;
}

export interface ParamDef {
  id: string;
  label: string;
  min: number;
  max: number;
  default: number;
  /** How a 0–1 control position maps onto min–max. `exp` needs min > 0. */
  curve: "lin" | "exp";
  unit?: string;
  /** Snap to multiples of this (e.g. 1 for whole semitones). */
  step?: number;
}

export type Category =
  | "io"
  | "oscillator"
  | "envelope"
  | "lfo"
  | "filter"
  | "level"
  | "pitch"
  | "shaper"
  | "random"
  | "fx";

/**
 * - `voice`: lives in every voice unless it sits downstream of a global module.
 * - `global`: always runs once, after the voices are summed (Audio Out, Voice Sum).
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
  scope: Scope;
  /**
   * Input pairs where the second is fed from the first's source when it has no
   * cable of its own (Audio Out's right channel follows the left).
   */
  normalled?: [from: string, to: string][];
  /**
   * Input *i* belongs with parameter *i* (a mixer channel and its level). The editor
   * shows only the pairs in use plus one free pair, and the tile grows downwards with
   * them; see `visibleDef`. The definition and the abstraction always have all of them,
   * and `height` is the tile's height with a single pair.
   */
  growsWithInputs?: boolean;
}
