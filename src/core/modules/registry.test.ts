import { describe, expect, it } from "vitest";
import { abstractionLibrary } from "../pdlib";
import { abstractionInterface, objectClasses } from "../pd/inspect";
import { VANILLA_049_OBJECTS } from "../pd/vanilla049";
import { moduleDefs, VOICE_ABSTRACTION } from "./registry";

describe("module registry", () => {
  it("has unique types and port/param ids", () => {
    expect(new Set(moduleDefs.map((d) => d.type)).size).toBe(moduleDefs.length);
    for (const def of moduleDefs) {
      for (const ids of [def.inputs, def.outputs, def.params].map((list) => list.map((p) => p.id))) {
        expect(new Set(ids).size, `${def.type} ids ${ids}`).toBe(ids.length);
      }
    }
  });

  it("gives every parameter a usable range", () => {
    for (const def of moduleDefs) {
      for (const p of def.params) {
        const where = `${def.type}.${p.id}`;
        expect(p.min, where).toBeLessThan(p.max);
        expect(p.default, where).toBeGreaterThanOrEqual(p.min);
        expect(p.default, where).toBeLessThanOrEqual(p.max);
        if (p.curve === "exp") expect(p.min, `${where} exp needs min > 0`).toBeGreaterThan(0);
      }
    }
  });

  it.each(moduleDefs.map((def) => [def.type, def] as const))(
    "%s matches its Pd abstraction",
    (_type, def) => {
      const text = abstractionLibrary[def.pd];
      expect(text, `${def.pd}.pd exists in pd-lib/modules`).toBeDefined();
      const actual = abstractionInterface(text);
      expect(actual.signalInlets).toBe(def.inputs.length);
      expect(actual.signalOutlets).toBe(def.outputs.length);
      expect(actual.controlInlets).toBe(0);
      expect(actual.controlOutlets).toBe(0);
      expect(actual.params.sort()).toEqual(def.params.map((p) => p.id).sort());
    },
  );

  it("normalled pairs name real inputs", () => {
    for (const def of moduleDefs) {
      for (const pair of def.normalled ?? []) {
        for (const port of pair) expect(def.inputs.map((p) => p.id)).toContain(port);
      }
    }
  });

  it("has a voice abstraction with a note inlet and pitch, gate and velocity outlets", () => {
    const voice = abstractionInterface(abstractionLibrary[VOICE_ABSTRACTION]);
    expect(voice).toMatchObject({ controlInlets: 1, signalInlets: 0, signalOutlets: 3, params: [] });
  });
});

describe("pd-lib", () => {
  it.each(Object.entries(abstractionLibrary))("%s only uses objects the Organelle's Pd 0.49 has", (_name, text) => {
    // Abstractions may be built from other abstractions in the library.
    const unknown = objectClasses(text).filter(
      (name) => !VANILLA_049_OBJECTS.has(name) && !(name in abstractionLibrary),
    );
    expect(unknown).toEqual([]);
  });
});
