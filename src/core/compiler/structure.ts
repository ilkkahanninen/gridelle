import type { PatchDocument } from "../model/types";
import { getModuleDef } from "../modules/registry";

/**
 * A string that changes exactly when the compiled patch's structure changes:
 * which modules exist, how they are cabled, how many voices there are, and what
 * the knob pages control. Parameter values, tile positions and the patch name
 * are left out, because a running patch can take new values without being reloaded.
 * The exceptions are the values that are built into the patch (`ParamDef.argument`),
 * and the samples, which are loaded when it starts.
 */
export function structureKey(doc: PatchDocument): string {
  return JSON.stringify([
    doc.voices,
    doc.modules.map((m) => [
      m.id,
      m.type,
      (getModuleDef(m.type)?.params ?? []).filter((p) => p.argument).map((p) => m.params[p.id] ?? p.default),
      Object.entries(m.precords ?? {})
        .filter(([, enabled]) => !enabled)
        .map(([port]) => port)
        .sort(),
    ]),
    doc.cables.map((c) => [c.from.module, c.from.port, c.to.module, c.to.port]),
    // The pages that are exported: those with a knob in use, each under its name or its number.
    doc.pages.flatMap((page, index) =>
      page.knobs.some(Boolean) ? [[page.name || index, page.knobs.map((k) => (k ? [k.module, k.param] : null))]] : [],
    ),
    (doc.samples ?? []).map((s) => (s ? (s.kind === "file" ? [s.path, s.frames, s.sampleRate] : [s.seconds]) : null)),
  ]);
}
