import { describe, expect, it } from "vitest";
import { abstractionLibrary } from "../pdlib";
import { abstractionInterface, objectBoxes, objectClasses } from "../pd/inspect";
import { isPdObject } from "../pd/vanilla049";
import { KEYBOARD_ABSTRACTION, moduleDefs, VOICE_ABSTRACTION } from "./registry";
import type { PortDef } from "./types";

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
      // The inlets for voice signals, which are not ports, come before those of the inputs.
      // A note port is a control inlet or outlet, every other port a signal one, in the
      // order of the ports, left to right: Pd numbers them by where they are.
      const kind = (port: PortDef) => (port.kind === "notes" ? "control" : "signal");
      expect(actual.inlets).toEqual([...(def.voiceInlets ?? []).map(() => "signal"), ...def.inputs.map(kind)]);
      expect(actual.outlets).toEqual(def.outputs.map(kind));
      // Two boxes at the same place would leave Pd's order to chance.
      expect(new Set(objectBoxes(text).filter((b) => /^(in|out)let~?$/.test(b.name)).map((b) => `${b.name.slice(0, 3)}:${b.x}`)).size).toBe(
        actual.inlets.length + actual.outlets.length,
      );
      // Notes go to and from the keyboard and the voices, which are outside the voice area.
      if ([...def.inputs, ...def.outputs].some((port) => port.kind === "notes")) expect(def.place, def.type).toBe("outside");
      for (const port of [...def.inputs, ...def.outputs]) if (port.kind === "notes") expect(port.hint, def.type).toBe("notes");
      // A value that is built into the patch arrives as an argument, not at a receiver.
      expect(actual.params.sort()).toEqual(def.params.filter((p) => !p.argument).map((p) => p.id).sort());
      def.params.filter((p) => p.argument).forEach((_param, i) => expect(text, `uses its argument ${i + 2}`).toContain(`\\$${i + 2}`));
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
    // Where such an input also follows the voice, the resting value is for when that is switched off.
    for (const port of resting.filter((port) => port.precord)) expect(port.param, port.id).toBeUndefined();
    for (const def of moduleDefs) {
      for (const output of def.outputs) expect([output.param, output.unpatched, output.precord]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("gives every knob a row, and every module with knobs the rows layout", () => {
    for (const def of moduleDefs) {
      const knobs = def.params.filter((p) => !p.options).map((p) => p.id);
      if (knobs.length === 0) continue;
      expect(def.layout, def.type).toBe("rows");
      expect(def.inputs.flatMap((port) => (port.param ? [port.param] : [])).sort(), def.type).toEqual(knobs.sort());
    }
  });

  it("holds the input of a setting at 1 while nothing is patched, and a Mod input at 0", () => {
    for (const def of moduleDefs) {
      for (const port of def.inputs) {
        if (!port.param || def.growsWithInputs) continue;
        expect(port.unpatched, `${def.type}.${port.id}`).toBe(port.id === "mod" ? undefined : 1);
      }
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
    // The keyboard gives the same three, from every key, with no inlet: it listens to the notes itself.
    const keyboard = abstractionInterface(abstractionLibrary[KEYBOARD_ABSTRACTION]);
    expect(keyboard).toMatchObject({ inlets: [], outlets: ["signal", "signal", "signal"], params: [] });
  });
});

describe("pd-lib", () => {
  it.each(Object.entries(abstractionLibrary))("%s only uses objects the Organelle's Pd 0.49 has", (_name, text) => {
    // Abstractions may be built from other abstractions in the library.
    const unknown = objectClasses(text).filter(
      (name) => !isPdObject(name) && !(name in abstractionLibrary),
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
