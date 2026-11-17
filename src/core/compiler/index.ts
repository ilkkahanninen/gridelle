import type { PatchDocument } from "../model/types";
import { VOICE_ABSTRACTION } from "../modules/registry";
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
}

/**
 * Turn a patch document into an Organelle patch folder. Pure: the same document
 * and library always give the same files.
 */
export function compile(doc: PatchDocument, library: AbstractionLibrary): CompileResult {
  const analysis = analyze(doc);
  const diagnostics = [...analysis.diagnostics];

  const needed = [
    VOICE_ABSTRACTION,
    ...new Set(analysis.modules.map((m) => m.def.pd)),
    ...(usesKnobs(analysis) ? [KNOB_ABSTRACTION] : []),
  ];
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
    return { ok: false, diagnostics, files: {}, entry: ENTRY_FILE, params: [], knobSlots: [] };
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
  };
}
