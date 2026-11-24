/** Bumped whenever the saved document shape changes incompatibly. */
export const DOCUMENT_VERSION = 3;

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
  /**
   * A name of the user's own for this module, shown on its tile and wherever its settings
   * are named: the Knob pages panel and the Organelle's screen. Without one the module
   * goes by the name of its type. See `ops.moduleName`.
   */
  name?: string;
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

/** Samples a patch can have: the letters A to H in the editor, 0 to 7 in the patch. */
export const SAMPLE_SLOTS = 8;
/** The longest a module's own name may be: what its tile has room for. */
export const MAX_MODULE_NAME = 20;

/** A sample's letter in the editor. */
export const sampleLetter = (slot: number) => String.fromCharCode(65 + slot);
/** The id of the parameter that says which sample a module works on. */
export const SAMPLE_PARAM = "sample";
/** The longest blank tape, in seconds. */
export const MAX_TAPE_SECONDS = 60;

/**
 * A sound the sample modules share. A sound file is referred to where it is on this
 * computer; exporting copies it into the patch folder. A tape starts out silent, for a
 * Recorder to fill. A wavetable is one of the editor's own (`core/wavetables/banks.ts`),
 * for a Wavetable oscillator, which can also read a sound file as one: cut into cycles.
 */
export type SampleSlot =
  | {
      kind: "file";
      /** Where the sound file is. */
      path: string;
      /** Its file name, for showing. */
      name: string;
      /** Its length in samples and its sample rate, as found when it was chosen. */
      frames: number;
      sampleRate: number;
      /**
       * The length of one cycle, in samples, when the file is read as a wavetable. Without
       * it the length is what the file says of itself, or a guess from how long it is.
       */
      cycle?: number;
    }
  | { kind: "tape"; seconds: number }
  | { kind: "wavetable"; bank: string };

/** The longest cycle a sound file can be cut into as a wavetable. */
export const MAX_CYCLE = 8192;

/** A rectangle of grid cells. */
export interface Area {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Which of the held keys a mono patch plays. */
export type NotePriority = "last" | "low" | "high";
export const NOTE_PRIORITIES: readonly NotePriority[] = ["last", "low", "high"];

/** How the voice area plays notes. */
export interface Voicing {
  /** `poly`: `PatchDocument.voices` notes at once, each on a voice of its own. `mono`: one note at a time. */
  mode: "poly" | "mono";
  /** Mono: which of the held keys sounds. */
  priority: NotePriority;
  /** Mono: a key played while a note sounds changes its pitch without starting it again. */
  legato: boolean;
}

export const DEFAULT_VOICING: Voicing = { mode: "poly", priority: "last", legato: false };

/**
 * A unison group: cells whose modules run `size` times side by side, as many copies, which
 * are added up where a cable leaves the group and each get what a cable brings into it.
 * Like the voice area it has a border of cells, its top row a header. Inside the voice area
 * every voice has its own copies; outside it they run once. A Unison Index in the group
 * gives each copy its place among them.
 */
export interface UnisonGroup {
  /** A module id: groups and modules share them, and a group is selected like a module. */
  id: ModuleId;
  area: Area;
  size: number;
}

export const MIN_UNISON = 1;
export const MAX_UNISON = 16;
export const DEFAULT_UNISON = 3;

export interface PatchDocument {
  version: typeof DOCUMENT_VERSION;
  name: string;
  /** The notes that play at once, in poly mode. */
  voices: number;
  /** How the voices play notes; `DEFAULT_VOICING` when absent. */
  voicing?: Voicing;
  /** The unison groups, inside the voice area or out of it, never in each other. */
  groups?: UnisonGroup[];
  /**
   * The voice area: the modules whose tiles lie inside it run once in every voice, the
   * others once for the whole patch. Its first row is its header. See `model/area.ts`.
   */
  voiceArea: Area;
  modules: ModuleInstance[];
  cables: Cable[];
  pages: KnobPage[];
  /** The patch's samples by slot; `null` or a missing entry is an empty slot. */
  samples?: (SampleSlot | null)[];
}

export const MIN_VOICES = 1;
export const MAX_VOICES = 16;

export const voicingOf = (doc: Pick<PatchDocument, "voicing">): Voicing => doc.voicing ?? DEFAULT_VOICING;
/** How many notes sound at once, which is how many voices run. */
export const notesAtOnce = (doc: Pick<PatchDocument, "voices" | "voicing">): number =>
  voicingOf(doc).mode === "mono" ? 1 : doc.voices;

export function emptyDocument(name = "Untitled"): PatchDocument {
  return { version: DOCUMENT_VERSION, name, voices: 4, voiceArea: { x: 0, y: 0, width: 0, height: 0 }, modules: [], cables: [], pages: [] };
}
