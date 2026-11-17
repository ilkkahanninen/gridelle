/** Bumped whenever the saved document shape changes incompatibly. */
export const DOCUMENT_VERSION = 1;

/**
 * Module instance id, e.g. `ge12`. It doubles as the prefix of the module's Pd
 * parameter receivers (`ge12-cutoff`), hence the `ge` prefix: it keeps them clear
 * of the names the Organelle host uses itself (`knob1`, `notes`, `vol`, ...).
 */
export type ModuleId = string;

export interface ModuleInstance {
  id: ModuleId;
  /** Key into the module registry, e.g. `osc-saw`. */
  type: string;
  /** Top-left grid cell. */
  x: number;
  y: number;
  /** Parameter values in real units, by parameter id. Missing entries use the default. */
  params: Record<string, number>;
  /**
   * Pre-cord overrides by input port id. A port with a pre-cord is fed from the
   * voice's pitch/gate/velocity when it has no cable, unless set to `false` here.
   */
  precords?: Record<string, boolean>;
}

export interface PortRef {
  module: ModuleId;
  port: string;
}

/** A patch cable from an output port to an input port. Every cable is an audio-rate signal. */
export interface Cable {
  from: PortRef;
  to: PortRef;
}

export interface KnobAssignment {
  module: ModuleId;
  param: string;
}

export const KNOBS_PER_PAGE = 4;
export const MAX_PAGES = 8;

export interface KnobPage {
  name: string;
  /** One slot per hardware knob; `null` leaves the knob unused on this page. */
  knobs: (KnobAssignment | null)[];
}

export interface PatchDocument {
  version: typeof DOCUMENT_VERSION;
  name: string;
  /** Number of voices the Organelle patch allocates. 1 makes it monophonic. */
  voices: number;
  modules: ModuleInstance[];
  cables: Cable[];
  pages: KnobPage[];
}

export const MIN_VOICES = 1;
export const MAX_VOICES = 16;

export function emptyDocument(name = "Untitled"): PatchDocument {
  return { version: DOCUMENT_VERSION, name, voices: 4, modules: [], cables: [], pages: [] };
}
