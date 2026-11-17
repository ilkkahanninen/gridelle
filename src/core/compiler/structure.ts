import type { PatchDocument } from "../model/types";

/**
 * A string that changes exactly when the compiled patch's structure changes:
 * which modules exist, how they are cabled, how many voices there are, and what
 * the knob pages control. Parameter values, tile positions and the patch name
 * are left out, because a running patch can take new values without being reloaded.
 */
export function structureKey(doc: PatchDocument): string {
  return JSON.stringify([
    doc.voices,
    doc.modules.map((m) => [
      m.id,
      m.type,
      Object.entries(m.precords ?? {})
        .filter(([, enabled]) => !enabled)
        .map(([port]) => port)
        .sort(),
    ]),
    doc.cables.map((c) => [c.from.module, c.from.port, c.to.module, c.to.port]),
    doc.pages.map((page) => [page.name, page.knobs.map((k) => (k ? [k.module, k.param] : null))]),
  ]);
}
