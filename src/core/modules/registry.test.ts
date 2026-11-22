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

  it("numbers the options of a choice from zero", () => {
    const choices = moduleDefs.flatMap((def) => def.params.filter((p) => p.options).map((p) => [def.type, p] as const));
    expect(choices.length).toBeGreaterThan(0);
    for (const [type, p] of choices) {
      const where = `${type}.${p.id}`;
      expect(p.options!.length, where).toBeGreaterThan(1);
      expect([p.min, p.max, p.step, p.curve], where).toEqual([0, p.options!.length - 1, 1, "lin"]);
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

  it("ties an input to a real setting, and each setting to one input at most", () => {
    for (const def of moduleDefs) {
      const tied = def.inputs.flatMap((port) => (port.param ? [port.param] : []));
      expect(new Set(tied).size, def.type).toBe(tied.length);
      for (const id of tied) expect(def.params.map((p) => p.id), def.type).toContain(id);
    }
  });

  it("rests an unpatched input at a value only where nothing else feeds it", () => {
    const resting = moduleDefs.flatMap((def) => def.inputs.filter((port) => port.unpatched !== undefined));
    expect(resting.length).toBeGreaterThan(0);
    for (const port of resting) expect(port.precord, port.id).toBeUndefined();
    for (const def of moduleDefs) {
      for (const output of def.outputs) expect([output.param, output.unpatched, output.precord]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("makes a rows tile as tall as its rows need", () => {
    const rows = moduleDefs.filter((def) => def.layout === "rows");
    expect(rows.map((def) => def.type)).toEqual(expect.arrayContaining(["env-adsr", "mixer"]));
    for (const def of rows) {
      // A module that grows starts with a single row.
      const count = def.growsWithInputs ? 1 : def.inputs.length;
      expect(def.height, def.type).toBe(Math.ceil((count + 1) / 2));
      expect(def.outputs.length, def.type).toBeLessThanOrEqual(count);
    }
    for (const def of moduleDefs) if (def.growsWithInputs) expect(def.layout, def.type).toBe("rows");
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

  it.each(Object.entries(abstractionLibrary))("%s has no stray semicolon", (_name, text) => {
    // A bare semicolon ends a box, so one inside a comment turns the rest of the comment
    // into a message that Pd tries to deliver when the file loads ("no such object").
    const records = text
      .split(/(?<!\\);/)
      .map((record) => record.trim())
      .filter(Boolean);
    expect(records.filter((record) => !/^#[NXA] /.test(record))).toEqual([]);
  });
});
