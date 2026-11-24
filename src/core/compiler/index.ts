import type { ModuleId, PatchDocument } from "../model/types";
import { KEYBOARD_ABSTRACTION, MONO_ABSTRACTION, PLACE_ABSTRACTION, VOICE_ABSTRACTION } from "../modules/registry";
import { objectClasses } from "../pd/inspect";
import { isPdObject } from "../pd/vanilla049";
import { analyze, type Diagnostic } from "./analyze";
import {
  emitGroup,
  emitMain,
  emitVoice,
  groupFile,
  paramValues,
  SAMPLE_FILE_ABSTRACTION,
  SAMPLE_TAPE_ABSTRACTION,
  sampleFileName,
  WAVE_FILE_ABSTRACTION,
  waveFileName,
  type ParamValue,
} from "./emit";
import { KNOB_ABSTRACTION, knobSlots, usesKnobs, type KnobSlotValue } from "./knobPages";

export type { Diagnostic } from "./analyze";
export type { ParamValue } from "./emit";
export type { KnobSlotValue } from "./knobPages";

/** Module abstractions by name without extension, e.g. `{ "ge-osc-saw": "#N canvas ..." }`. */
export type AbstractionLibrary = Readonly<Record<string, string>>;

export const ENTRY_FILE = "main.pd";
export const VOICE_FILE = "voice.pd";

export interface CompileResult {
  /** False when there are errors; `files` is then empty. */
  ok: boolean;
  diagnostics: Diagnostic[];
  /** The complete Organelle patch folder: file name → Pd text. */
  files: Record<string, string>;
  entry: typeof ENTRY_FILE;
  /** Every parameter's receiver and current value, as `main.pd` sends them on load. */
  params: ParamValue[];
  /** Every assigned knob with the position that matches its parameter's current value. */
  knobSlots: KnobSlotValue[];
  /**
   * The number of each Scope module, from 1; those beyond what the editor can draw are
   * left out. The preview engine has what scope `n` taps under slot `n - 1`.
   */
  scopes: Record<ModuleId, number>;
  /**
   * The sound files the patch plays: the name each must have in the patch folder, and
   * what it is made from. The folder is not complete without them; whoever writes it (the
   * preview, an export, a send) makes and adds them.
   */
  samples: SampleFile[];
}

/**
 * What a file of sound in a patch folder is made from: a sound file where it is now, as
 * it is (`sound`) or cut into the cycles of a wavetable (`wavetable`), or a wavetable of
 * the editor's own by its id (`bank`). `SampleFile` in `src-tauri/src/samples.rs` is the
 * same from the other side.
 */
export type SampleSource =
  | { kind: "sound"; path: string }
  | { kind: "wavetable"; path: string; cycle?: number }
  | { kind: "bank"; id: string };

export interface SampleFile {
  file: string;
  source: SampleSource;
}

/**
 * `roots` plus every abstraction they are built from, directly or through another
 * abstraction. Module abstractions share DSP through such helpers (`ge-blep`,
 * `ge-filter-poles`), which must travel with the patch. A name the library does not
 * have is returned too, for the caller to report.
 */
function withHelpers(roots: string[], library: AbstractionLibrary): string[] {
  const needed = [...new Set(roots)];
  for (let i = 0; i < needed.length; i++) {
    if (!(needed[i] in library)) continue;
    for (const name of objectClasses(library[needed[i]])) {
      // Whatever is not one of Pd's own objects has to be an abstraction.
      if (!isPdObject(name) && !needed.includes(name)) needed.push(name);
    }
  }
  return needed;
}

/**
 * Turn a patch document into an Organelle patch folder. Pure: the same document
 * and library always give the same files.
 */
export function compile(doc: PatchDocument, library: AbstractionLibrary): CompileResult {
  const analysis = analyze(doc);
  const diagnostics = [...analysis.diagnostics];

  const needed = withHelpers(
    [
      VOICE_ABSTRACTION,
      ...(analysis.voicing.mode === "mono" ? [MONO_ABSTRACTION] : []),
      ...analysis.modules.map((m) => m.def.pd),
      // A Unison Index in a group gets its copy's place from a helper.
      ...(analysis.modules.some((m) => m.def.voiceInlets?.includes("unison") && analysis.groups.some((g) => g.group.id === m.container))
        ? [PLACE_ABSTRACTION]
        : []),
      ...(usesKnobs(analysis) ? [KNOB_ABSTRACTION] : []),
      ...(analysis.keyboard ? [KEYBOARD_ABSTRACTION] : []),
      ...analysis.samples.flatMap(({ table, wave }) => [
        ...(table ? [table.kind === "file" ? SAMPLE_FILE_ABSTRACTION : SAMPLE_TAPE_ABSTRACTION] : []),
        ...(wave && wave !== "silent" ? [WAVE_FILE_ABSTRACTION] : []),
      ]),
    ],
    library,
  );
  for (const name of needed) {
    if (!(name in library)) {
      diagnostics.push({
        severity: "error",
        code: "missing-abstraction",
        message: `The module library is missing ${name}.pd.`,
      });
    }
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics, files: {}, entry: ENTRY_FILE, params: [], knobSlots: [], scopes: {}, samples: [] };
  }

  const files: Record<string, string> = {
    [ENTRY_FILE]: emitMain(doc, analysis),
    [VOICE_FILE]: emitVoice(analysis),
    // A unison group's copies, from a file of their own.
    ...Object.fromEntries(analysis.groups.map((group) => [`${groupFile(group.group.id)}.pd`, emitGroup(analysis, group)])),
  };
  for (const name of needed) files[`${name}.pd`] = library[name];

  return {
    ok: true,
    diagnostics,
    files,
    entry: ENTRY_FILE,
    params: paramValues(analysis),
    knobSlots: knobSlots(analysis),
    scopes: Object.fromEntries([...analysis.taps].filter(([, slot]) => slot > 0)),
    samples: analysis.samples.flatMap(({ slot, table, wave }): SampleFile[] => [
      ...(table?.kind === "file" ? [{ file: sampleFileName(slot), source: { kind: "sound" as const, path: table.path } }] : []),
      ...(wave && wave !== "silent"
        ? [
            {
              file: waveFileName(slot),
              source:
                wave.kind === "bank"
                  ? { kind: "bank" as const, id: wave.id }
                  : { kind: "wavetable" as const, path: wave.path, ...(wave.cycle ? { cycle: wave.cycle } : {}) },
            },
          ]
        : []),
    ]),
  };
}
