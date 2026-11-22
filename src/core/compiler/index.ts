import type { ModuleId, PatchDocument } from "../model/types";
import { VOICE_ABSTRACTION } from "../modules/registry";
import { objectClasses } from "../pd/inspect";
import { isPdObject } from "../pd/vanilla049";
import { analyze, type Diagnostic } from "./analyze";
import { emitMain, emitVoice, paramValues, type ParamValue } from "./emit";
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
    [VOICE_ABSTRACTION, ...analysis.modules.map((m) => m.def.pd), ...(usesKnobs(analysis) ? [KNOB_ABSTRACTION] : [])],
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
    return { ok: false, diagnostics, files: {}, entry: ENTRY_FILE, params: [], knobSlots: [], scopes: {} };
  }

  const files: Record<string, string> = {
    [ENTRY_FILE]: emitMain(doc, analysis),
    [VOICE_FILE]: emitVoice(analysis),
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
  };
}
