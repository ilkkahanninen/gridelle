import { describe, expect, it } from "vitest";
import { basicSynth } from "../fixtures";
import { getModuleDef } from "../modules/registry";
import { visibleDef } from "../modules/shape";
import { useEditor } from "../../state/store";
import { formatParam, fromNormalized, toNormalized } from "../modules/params";
import {
  addModule,
  settle,
  addModuleAtPort,
  assignKnob,
  findAssignment,
  pageAt,
  pageInUse,
  renamePage,
  canMove,
  canPlace,
  connect,
  connectionProblem,
  copyModules,
  clipSize,
  disconnect,
  duplicateModules,
  pasteModules,
  findFreeCell,
  makeRoom,
  moduleName,
  moveModules,
  nextFreeKnob,
  nextModuleId,
  paramValue,
  planPortDrop,
  type PortTarget,
  removeModules,
  renameModule,
  sampleAt,
  setParam,
  setSample,
  setWavetable,
  setPrecord,
  togglePrecord,
} from "./ops";
import { exportFolderName, parseDocument, serializeDocument } from "./serialize";
import { emptyDocument, type PatchDocument } from "./types";

const port = (module: string, p: string) => ({ module, port: p });

function build(...types: [string, number, number][]): PatchDocument {
  return types.reduce((doc, [type, x, y]) => addModule(doc, type, { x, y }).doc, emptyDocument());
}

describe("placing modules", () => {
  it("assigns the smallest free id", () => {
    const doc = build(["osc-saw", 0, 0], ["amp", 2, 0]);
    expect(doc.modules.map((m) => m.id)).toEqual(["ge1", "ge2"]);
    expect(nextModuleId(removeModules(doc, new Set(["ge1"])))).toBe("ge1");
  });

  it("refuses a spot that overlaps another module", () => {
    const doc = build(["osc-saw", 0, 0]); // 2 × 2 cells
    expect(canPlace(doc, "amp", { x: 1, y: 1 })).toBe(false);
    expect(canPlace(doc, "amp", { x: 2, y: 0 })).toBe(true);
    expect(canPlace(doc, "amp", { x: -1, y: 0 })).toBe(true);
    const result = addModule(doc, "amp", { x: 1, y: 0 });
    expect(result).toEqual({ doc, id: null });
  });

  it("refuses unknown module types", () => {
    expect(addModule(emptyDocument(), "nope", { x: 0, y: 0 }).id).toBeNull();
  });

  it("finds the nearest free cell", () => {
    const doc = build(["osc-saw", 0, 0]);
    expect(findFreeCell(emptyDocument(), "amp", { x: 3, y: 3 })).toEqual({ x: 3, y: 3 });
    const cell = findFreeCell(doc, "osc-saw", { x: 0, y: 0 });
    expect(canPlace(doc, "osc-saw", cell)).toBe(true);
    expect(Math.abs(cell.x) + Math.abs(cell.y)).toBe(2);
  });
});

describe("moving modules", () => {
  const doc = build(["osc-saw", 0, 0], ["amp", 2, 0], ["amp", 5, 0]);

  it("moves a group together, even through each other's old cells", () => {
    const moved = moveModules(doc, new Set(["ge1", "ge2"]), { x: 1, y: 0 });
    expect(moved.modules.map((m) => m.x)).toEqual([1, 3, 5]);
  });

  it("refuses a move onto a module outside the group", () => {
    expect(canMove(doc, new Set(["ge2"]), { x: 3, y: 0 })).toBe(false);
    expect(moveModules(doc, new Set(["ge2"]), { x: 3, y: 0 })).toBe(doc);
    expect(moveModules(doc, new Set(["ge2"]), { x: 0, y: 0 })).toBe(doc);
  });
});

describe("cables", () => {
  const doc = build(["osc-saw", 0, 0], ["filter-lp", 2, 0], ["amp", 4, 0]);

  it("connects an output to an input", () => {
    const wired = connect(doc, port("ge1", "out"), port("ge2", "in"));
    expect(wired.cables).toEqual([{ from: port("ge1", "out"), to: port("ge2", "in") }]);
    expect(connect(wired, port("ge1", "out"), port("ge2", "in"))).toBe(wired);
  });

  it("replaces the cable already in an input", () => {
    const first = connect(doc, port("ge1", "out"), port("ge3", "in"));
    const second = connect(first, port("ge2", "out"), port("ge3", "in"));
    expect(second.cables).toEqual([{ from: port("ge2", "out"), to: port("ge3", "in") }]);
  });

  it("lets one output feed several inputs", () => {
    const wired = connect(connect(doc, port("ge1", "out"), port("ge2", "in")), port("ge1", "out"), port("ge3", "in"));
    expect(wired.cables).toHaveLength(2);
  });

  it("refuses ports that do not exist and feedback loops", () => {
    expect(connect(doc, port("ge1", "nope"), port("ge2", "in"))).toBe(doc);
    expect(connect(doc, port("ge1", "out"), port("ge2", "out"))).toBe(doc);
    const chain = connect(connect(doc, port("ge2", "out"), port("ge3", "in")), port("ge3", "out"), port("ge2", "mod"));
    expect(chain.cables).toHaveLength(1);
    expect(connectionProblem(doc, port("ge2", "out"), port("ge2", "in"))).toMatch(/feedback/);
  });

  it("removes a cable, and a module's cables with the module", () => {
    const wired = connect(connect(doc, port("ge1", "out"), port("ge2", "in")), port("ge2", "out"), port("ge3", "in"));
    expect(disconnect(wired, wired.cables[0]).cables).toHaveLength(1);
    expect(removeModules(wired, new Set(["ge1"])).cables).toEqual([wired.cables[1]]);
    expect(removeModules(wired, new Set(["ge1", "ge3"])).cables).toEqual([]);
  });

  it("clears knob assignments of removed modules", () => {
    const withPage: PatchDocument = {
      ...doc,
      pages: [{ name: "Main", knobs: [{ module: "ge2", param: "cutoff" }, { module: "ge3", param: "level" }, null, null] }],
    };
    expect(removeModules(withPage, new Set(["ge2"])).pages[0].knobs).toEqual([
      null,
      { module: "ge3", param: "level" },
      null,
      null,
    ]);
  });
});

describe("parameters", () => {
  const doc = build(["filter-lp", 0, 0], ["osc-saw", 2, 0]);

  it("clamps to the range and snaps to the step", () => {
    expect(setParam(doc, "ge1", "cutoff", 1e9).modules[0].params.cutoff).toBe(18000);
    expect(setParam(doc, "ge2", "tune", 6.6).modules[1].params.tune).toBe(7);
  });

  it("keeps a choice on one of its options", () => {
    expect(setParam(doc, "ge2", "mode", 2).modules[1].params.mode).toBe(2);
    expect(setParam(doc, "ge2", "mode", 1.4).modules[1].params.mode).toBe(1);
    expect(setParam(doc, "ge2", "mode", 7).modules[1].params.mode).toBe(2);
    expect(setParam(doc, "ge2", "mode", 0)).toBe(doc); // the default
  });

  it("ignores unknown targets and no-op changes", () => {
    expect(setParam(doc, "ge1", "nope", 1)).toBe(doc);
    expect(setParam(doc, "ge9", "cutoff", 1)).toBe(doc);
    expect(setParam(doc, "ge1", "cutoff", 1200)).toBe(doc); // the default
  });

  it("maps control position to value and back on both curves", () => {
    const cutoff = getModuleDef("filter-lp")!.params.find((p) => p.id === "cutoff")!;
    const res = getModuleDef("filter-lp")!.params.find((p) => p.id === "res")!;
    expect(fromNormalized(cutoff, 0)).toBeCloseTo(20);
    expect(fromNormalized(cutoff, 1)).toBeCloseTo(18000);
    expect(fromNormalized(cutoff, 0.5)).toBeCloseTo(Math.sqrt(20 * 18000));
    expect(fromNormalized(res, 0.25)).toBeCloseTo(0.25);
    for (const t of [0, 0.1, 0.5, 0.9, 1]) {
      expect(toNormalized(cutoff, fromNormalized(cutoff, t))).toBeCloseTo(t);
      expect(toNormalized(res, fromNormalized(res, t))).toBeCloseTo(t);
    }
  });

  it("formats values for display", () => {
    const def = (type: string, id: string) => getModuleDef(type)!.params.find((p) => p.id === id)!;
    expect(formatParam(def("filter-lp", "cutoff"), 1200)).toBe("1.2 kHz");
    expect(formatParam(def("filter-lp", "cutoff"), 440)).toBe("440 Hz");
    expect(formatParam(def("env-adsr", "release"), 2500)).toBe("2.5 s");
    expect(formatParam(def("env-adsr", "attack"), 5)).toBe("5 ms");
    // An LFO's rate keeps two decimals, so its slow end does not read as zero.
    expect(formatParam(def("lfo", "rate"), 0.02)).toBe("0.02 Hz");
    expect(formatParam(def("lfo", "rate"), 12.5)).toBe("12.5 Hz");
    expect(formatParam(def("lfo", "shape"), 3)).toBe("Ramp");
    expect(formatParam(def("osc-saw", "tune"), -12)).toBe("-12 st");
    expect(formatParam(def("env-adsr", "sustain"), 0.6)).toBe("0.60");
    expect(formatParam(def("osc-saw", "mode"), 0)).toBe("Linear FM");
    expect(formatParam(def("osc-saw", "mode"), 2)).toBe("AM");
  });

  it("toggles pre-cords only on ports that have one", () => {
    const off = setPrecord(doc, "ge2", "pitch", false);
    expect(off.modules[1].precords).toEqual({ pitch: false });
    expect(setPrecord(off, "ge2", "pitch", false)).toBe(off);
    expect(setPrecord(doc, "ge1", "in", false)).toBe(doc);
  });

  it("switches a pre-cord over, unless a cable has replaced it", () => {
    const off = togglePrecord(doc, "ge2", "pitch");
    expect(off.modules[1].precords).toEqual({ pitch: false });
    expect(togglePrecord(off, "ge2", "pitch").modules[1].precords).toEqual({ pitch: true });
    // A port without a pre-cord, a port that is not there, a module that is not there.
    expect(togglePrecord(doc, "ge1", "in")).toBe(doc);
    expect(togglePrecord(doc, "ge2", "nothing")).toBe(doc);
    expect(togglePrecord(doc, "ge99", "pitch")).toBe(doc);
    // With a cable in the port there is nothing to switch.
    const patched = connect(doc, port("ge1", "out"), port("ge2", "pitch"));
    expect(patched).not.toBe(doc);
    expect(togglePrecord(patched, "ge2", "pitch")).toBe(patched);
  });
});

describe("a module's own name", () => {
  const doc = build(["filter-lp", 0, 0], ["osc-saw", 2, 0]);
  const def = getModuleDef("filter-lp")!;

  it("is its type's name until it is given one, and again when that is taken away", () => {
    expect(doc.modules[0].name).toBeUndefined();
    expect(moduleName(doc.modules[0], def)).toBe("Low-pass");
    const named = renameModule(doc, "ge1", "Bass filter");
    expect(named.modules[0]).toEqual({ ...doc.modules[0], name: "Bass filter" });
    expect(moduleName(named.modules[0], def)).toBe("Bass filter");
    expect(named.modules[1]).toBe(doc.modules[1]);
    // No name is no field at all: the document is as it was.
    expect(renameModule(named, "ge1", "")).toEqual(doc);
  });

  it("is kept as typed, though spaces alone are no name", () => {
    // A space at the end has to survive, or the next word could not be typed.
    const typing = renameModule(doc, "ge1", "Bass ");
    expect(typing.modules[0].name).toBe("Bass ");
    expect(moduleName(typing.modules[0], def)).toBe("Bass");
    expect(moduleName(renameModule(doc, "ge1", "   ").modules[0], def)).toBe("Low-pass");
  });

  it("is no longer than a tile has room for", () => {
    expect(renameModule(doc, "ge1", "x".repeat(50)).modules[0].name).toBe("x".repeat(20));
  });

  it("changes nothing when it is the same, or the module is not there", () => {
    const named = renameModule(doc, "ge1", "Bass filter");
    expect(renameModule(named, "ge1", "Bass filter")).toBe(named);
    expect(renameModule(doc, "ge1", "")).toBe(doc);
    expect(renameModule(doc, "ge9", "Nobody")).toBe(doc);
  });

  it("is saved with the patch, and a file with a name that is not text is refused", () => {
    const named = renameModule(doc, "ge1", "Bass filter");
    expect(parseDocument(serializeDocument(named))).toEqual(named);
    const broken = { ...doc, modules: [{ ...doc.modules[0], name: 5 }] };
    expect(() => parseDocument(JSON.stringify(broken))).toThrow(/damaged/);
  });
});

describe("knob pages", () => {
  const bare = build(["filter-lp", 0, 0], ["osc-saw", 2, 0]);
  const doc = renamePage(bare, 0, "Main");
  const cutoff = { module: "ge1", param: "cutoff" };
  const blank = { name: "", knobs: [null, null, null, null] };

  it("has eight pages whatever the document holds, blank until they are used", () => {
    expect(bare.pages).toEqual([]);
    for (const index of [0, 3, 7]) expect(pageAt(bare, index)).toEqual(blank);
    expect(pageAt(doc, 0)).toEqual({ ...blank, name: "Main" });
    expect(pageInUse(pageAt(doc, 0))).toBe(false);
  });

  it("names a page, holding the pages up to it and none after the last that is used", () => {
    expect(doc.pages).toEqual([{ ...blank, name: "Main" }]);
    // A later page: the ones before it are held blank, to keep its place.
    const fourth = renamePage(bare, 3, "Tone");
    expect(fourth.pages).toEqual([blank, blank, blank, { ...blank, name: "Tone" }]);
    // Unnamed again, nothing is held any more: the document is as it was.
    expect(renamePage(fourth, 3, "").pages).toEqual([]);
    expect(renamePage(renamePage(doc, 5, "Far"), 5, "").pages).toEqual(doc.pages);
    // No change, no new document. There are eight pages.
    expect(renamePage(doc, 0, "Main")).toBe(doc);
    expect(renamePage(bare, 2, "")).toBe(bare);
    expect(renamePage(doc, 8, "Ninth")).toBe(doc);
    expect(renamePage(doc, -1, "None")).toBe(doc);
  });

  it("puts a knob on any of the eight pages, and lets go of a page when its last knob is cleared", () => {
    const far = assignKnob(bare, { page: 7, knob: 1 }, cutoff);
    expect(far.pages).toHaveLength(8);
    expect(far.pages[7].knobs).toEqual([null, cutoff, null, null]);
    expect(pageInUse(pageAt(far, 7))).toBe(true);
    expect(pageInUse(pageAt(far, 6))).toBe(false);
    expect(assignKnob(far, { page: 7, knob: 1 }, null).pages).toEqual([]);
    // A named page stays when its knobs are cleared, and so do the pages before a used one.
    const named = assignKnob(renamePage(bare, 1, "Keep"), { page: 2, knob: 0 }, cutoff);
    expect(assignKnob(named, { page: 2, knob: 0 }, null).pages).toEqual([blank, { ...blank, name: "Keep" }]);
    // Removing the module that a page's only knob plays lets go of the page too.
    expect(removeModules(far, new Set(["ge1"])).pages).toEqual([]);
  });

  it("assigns a parameter to a knob and finds it again", () => {
    const assigned = assignKnob(doc, { page: 0, knob: 2 }, cutoff);
    expect(assigned.pages[0].knobs).toEqual([null, null, cutoff, null]);
    expect(findAssignment(assigned, "ge1", "cutoff")).toEqual({ page: 0, knob: 2 });
    expect(findAssignment(assigned, "ge1", "res")).toBeNull();
    expect(assignKnob(assigned, { page: 0, knob: 2 }, cutoff)).toBe(assigned);
  });

  it("moves a parameter rather than putting it on two knobs", () => {
    const first = assignKnob(doc, { page: 0, knob: 0 }, cutoff);
    const moved = assignKnob(first, { page: 1, knob: 3 }, cutoff);
    expect(moved.pages[0].knobs[0]).toBeNull();
    expect(moved.pages[1].knobs[3]).toEqual(cutoff);
  });

  it("refuses parameters and slots that do not exist", () => {
    expect(assignKnob(doc, { page: 0, knob: 0 }, { module: "ge1", param: "nope" })).toBe(doc);
    expect(assignKnob(doc, { page: 0, knob: 4 }, cutoff)).toBe(doc);
    expect(assignKnob(doc, { page: 8, knob: 0 }, cutoff)).toBe(doc);
    expect(assignKnob(doc, { page: -1, knob: 0 }, cutoff)).toBe(doc);
  });

  it("clears a knob", () => {
    const assigned = assignKnob(doc, { page: 0, knob: 0 }, cutoff);
    expect(assignKnob(assigned, { page: 0, knob: 0 }, null).pages[0].knobs[0]).toBeNull();
  });

  it("finds the next empty knob of a page, going round", () => {
    // Knobs 1 and 3 of the only page are taken.
    let some = assignKnob(doc, { page: 0, knob: 0 }, cutoff);
    some = assignKnob(some, { page: 0, knob: 2 }, { module: "ge1", param: "res" });
    expect(nextFreeKnob(some, 0, 0)).toBe(1);
    expect(nextFreeKnob(some, 0, 1)).toBe(3);
    expect(nextFreeKnob(some, 0, 3)).toBe(1);
    // An empty knob is its own next one only when it is the last left.
    const last = assignKnob(some, { page: 0, knob: 3 }, { module: "ge1", param: "mod" });
    expect(nextFreeKnob(last, 0, 1)).toBe(1);
    const full = assignKnob(last, { page: 0, knob: 1 }, { module: "ge2", param: "tune" });
    expect(nextFreeKnob(full, 0, 1)).toBeNull();
    // A page that has not been used yet has all its knobs free.
    expect(nextFreeKnob(full, 5, 0)).toBe(1);
    expect(nextFreeKnob(full, 8, 0)).toBeNull();
  });
});

describe("saved files", () => {
  it("round-trips a document", () => {
    expect(parseDocument(serializeDocument(basicSynth))).toEqual(basicSynth);
  });

  it.each([
    ["not json", /not a Gridelle patch/],
    ['{"hello": 1}', /not a Gridelle patch/],
    [JSON.stringify({ ...basicSynth, version: 99 }), /newer version/],
    [JSON.stringify({ ...basicSynth, modules: [{ id: 1 }] }), /damaged/],
    [JSON.stringify({ ...basicSynth, cables: [{ from: "a", to: "b" }] }), /damaged/],
    [JSON.stringify({ ...basicSynth, pages: [{ name: "P", knobs: [null] }] }), /damaged/],
  ])("rejects %s", (text, message) => {
    expect(() => parseDocument(text)).toThrow(message);
  });

  it("round-trips a document with samples, and rejects a damaged list of them", () => {
    const file = { kind: "file", path: "/sounds/kick.wav", name: "kick.wav", frames: 22050, sampleRate: 44100 } as const;
    const doc = setSample(setSample(basicSynth, 0, file), 2, { kind: "tape", seconds: 4 });
    expect(doc.samples).toEqual([file, null, { kind: "tape", seconds: 4 }]);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    for (const samples of [[{ kind: "file", path: "/x.wav" }], [{ kind: "tape" }], [{ kind: "loop", seconds: 1 }], "A", Array(9).fill(null)]) {
      expect(() => parseDocument(JSON.stringify({ ...basicSynth, samples }))).toThrow(/damaged/);
    }
  });

  it("puts a sound or a tape in a sample slot, and takes it out again", () => {
    const tape = setSample(basicSynth, 1, { kind: "tape", seconds: 4 });
    expect(tape.samples).toEqual([null, { kind: "tape", seconds: 4 }]);
    expect(sampleAt(tape, 1)).toEqual({ kind: "tape", seconds: 4 });
    expect(sampleAt(tape, 0)).toBeNull();
    // The same again changes nothing; a tape's length is kept in range.
    expect(setSample(tape, 1, { kind: "tape", seconds: 4 })).toBe(tape);
    expect(sampleAt(setSample(tape, 1, { kind: "tape", seconds: 500 }), 1)).toEqual({ kind: "tape", seconds: 60 });
    expect(sampleAt(setSample(tape, 1, { kind: "tape", seconds: 0 }), 1)).toEqual({ kind: "tape", seconds: 0.1 });
    // Emptying the last slot in use leaves a document with no list of samples, as it was.
    expect(setSample(tape, 1, null)).toEqual(basicSynth);
    expect(setSample(basicSynth, 3, null)).toBe(basicSynth);
    // There are eight slots.
    expect(setSample(basicSynth, 8, { kind: "tape", seconds: 1 })).toBe(basicSynth);
    expect(setSample(basicSynth, -1, { kind: "tape", seconds: 1 })).toBe(basicSynth);
  });

  it("round-trips a wavetable and a cycle length, and opens a file of the version before", () => {
    const file = { kind: "file", path: "/tables/growl.wav", name: "growl.wav", frames: 131072, sampleRate: 44100, cycle: 2048 } as const;
    const doc = setSample(setSample(basicSynth, 0, { kind: "wavetable", bank: "vowels" }), 1, file);
    expect(parseDocument(serializeDocument(doc))).toEqual(doc);
    for (const samples of [[{ kind: "wavetable" }], [{ kind: "wavetable", bank: 3 }], [{ ...file, cycle: "long" }]]) {
      expect(() => parseDocument(JSON.stringify({ ...basicSynth, samples }))).toThrow(/damaged/);
    }
    // Version 1 had no wavetables; what it did have reads the same.
    expect(parseDocument(JSON.stringify({ ...basicSynth, version: 1 }))).toEqual(basicSynth);
    // A cycle is a whole number of samples that a cycle can have, or there is none.
    const cycleOf = (cycle: number | undefined) => sampleAt(setSample(basicSynth, 0, { ...file, cycle }), 0);
    expect(cycleOf(1024.4)).toEqual({ ...file, cycle: 1024 });
    for (const none of [undefined, 0, 1, -5, 100000]) expect(cycleOf(none)).not.toHaveProperty("cycle");
  });

  it("gives a new Wavetable oscillator a wavetable to play", () => {
    // The first gets the default one in the first free slot; the second shares it.
    const tape = setSample(emptyDocument(), 0, { kind: "tape", seconds: 1 });
    const one = addModule(tape, "osc-wavetable", { x: 0, y: 0 });
    expect(one.doc.samples).toEqual([{ kind: "tape", seconds: 1 }, { kind: "wavetable", bank: "basic-shapes" }]);
    expect(one.doc.modules[0].params).toEqual({ sample: 1 });
    const two = addModule(one.doc, "osc-wavetable", { x: 0, y: 5 });
    expect(two.doc.samples).toBe(one.doc.samples);
    expect(two.doc.modules[1].params).toEqual({ sample: 1 });
    // Dropped on a port it gets one too.
    const amp = addModule(emptyDocument(), "amp", { x: 4, y: 0 }).doc;
    const dropped = addModuleAtPort(amp, "osc-wavetable", { module: "ge1", port: "in", side: "in" }).doc;
    expect(dropped.samples).toEqual([{ kind: "wavetable", bank: "basic-shapes" }]);
    // With every slot taken by something else it is left on the first, for the compiler to speak of.
    const full = Array.from({ length: 8 }, (_, slot) => slot).reduce((d, slot) => setSample(d, slot, { kind: "tape", seconds: 1 }), emptyDocument());
    const crowded = addModule(full, "osc-wavetable", { x: 0, y: 0 }).doc;
    expect(crowded.samples).toBe(full.samples);
    expect(crowded.modules[0].params).toEqual({});
    // No other module brings a sample with it.
    expect(addModule(emptyDocument(), "sample-player", { x: 0, y: 0 }).doc.samples).toBeUndefined();
  });

  it("gives a Wavetable oscillator another of the editor's wavetables", () => {
    const one = addModule(emptyDocument(), "osc-wavetable", { x: 0, y: 0 }).doc;
    // Alone on its slot, the wavetable there is changed.
    const changed = setWavetable(one, "ge1", "vowels");
    expect(changed.samples).toEqual([{ kind: "wavetable", bank: "vowels" }]);
    expect(setWavetable(changed, "ge1", "vowels")).toBe(changed);
    // Two on a slot: the one that is given another goes to a slot of its own.
    const two = addModule(changed, "osc-wavetable", { x: 0, y: 5 }).doc;
    const apart = setWavetable(two, "ge2", "glass");
    expect(apart.samples).toEqual([{ kind: "wavetable", bank: "vowels" }, { kind: "wavetable", bank: "glass" }]);
    expect(apart.modules.map((m) => paramValue(m, "sample"))).toEqual([0, 1]);
    // Asking for one the patch has puts the module on that slot, and makes no second copy.
    const together = setWavetable(apart, "ge2", "vowels");
    expect(together.samples).toBe(apart.samples);
    expect(together.modules.map((m) => paramValue(m, "sample"))).toEqual([0, 0]);
    // On a sound file, the file is left alone and the wavetable goes in a free slot.
    const file = { kind: "file", path: "/t.wav", name: "t.wav", frames: 4096, sampleRate: 44100 } as const;
    const onFile = setWavetable(setSample(one, 0, file), "ge1", "bells");
    expect(onFile.samples).toEqual([file, { kind: "wavetable", bank: "bells" }]);
    expect(onFile.modules[0].params.sample).toBe(1);
    // Unknown wavetables, other modules and missing ones change nothing.
    expect(setWavetable(one, "ge1", "no-such-bank")).toBe(one);
    expect(setWavetable(one, "ge9", "vowels")).toBe(one);
    expect(setWavetable(addModule(one, "osc-saw", { x: 0, y: 5 }).doc, "ge2", "vowels").samples).toBe(one.samples);
  });

  it("makes export folder names the Organelle installer accepts", () => {
    expect(exportFolderName("Basic Synth")).toBe("Basic_Synth");
    expect(exportFolderName("  Säkkijärven polkka #2!  ")).toBe("Sakkijarven_polkka_2");
    expect(exportFolderName("///")).toBe("Gridelle_Patch");
  });
});

describe("a mixer grows with its inputs", () => {
  // Three saws on the left; a mixer (two cells wide) at 3,0 with two amps stacked right below it.
  const start = build(
    ["osc-saw", 0, 0],
    ["osc-saw", 0, 3],
    ["osc-saw", 0, 6],
    ["mixer", 3, 0],
    ["amp", 3, 1],
    ["amp", 3, 3],
    ["amp", 5, 1],
  );
  const [mixer, below, further, beside] = ["ge4", "ge5", "ge6", "ge7"];
  const shape = (doc: PatchDocument) => {
    const def = visibleDef(doc, doc.modules.find((m) => m.id === mixer)!)!;
    return { inputs: def.inputs.map((p) => p.id), params: def.params.map((p) => p.id), height: def.height };
  };
  const cabled = (doc: PatchDocument, source: string, input: string) => connect(doc, port(source, "out"), port(mixer, input));
  const y = (doc: PatchDocument, id: string) => doc.modules.find((m) => m.id === id)!.y;

  it("starts with one input and one knob", () => {
    expect(shape(start)).toEqual({ inputs: ["in1"], params: ["level1"], height: 1 });
  });

  it("gets another input and knob when the last one is cabled", () => {
    const one = cabled(start, "ge1", "in1");
    expect(shape(one)).toEqual({ inputs: ["in1", "in2"], params: ["level1", "level2"], height: 2 });
    const two = cabled(one, "ge2", "in2");
    expect(shape(two)).toMatchObject({ inputs: ["in1", "in2", "in3"], height: 2 });
    const three = cabled(two, "ge3", "in3");
    expect(shape(three)).toMatchObject({ inputs: ["in1", "in2", "in3", "in4"], height: 3 });
  });

  it("shrinks back when its last cables are removed, and keeps their levels", () => {
    let doc = cabled(cabled(start, "ge1", "in1"), "ge2", "in2");
    doc = setParam(doc, mixer, "level2", 0.25);
    doc = disconnect(doc, { from: port("ge2", "out"), to: port(mixer, "in2") });
    expect(shape(doc)).toMatchObject({ inputs: ["in1", "in2"], height: 2 });
    doc = disconnect(doc, { from: port("ge1", "out"), to: port(mixer, "in1") });
    expect(shape(doc)).toMatchObject({ inputs: ["in1"], height: 1 });
    expect(doc.modules.find((m) => m.id === mixer)!.params.level2).toBe(0.25);
  });

  it("keeps the inputs between two cables", () => {
    // Possible by moving a cable: the gap stays so nothing else changes place.
    const doc = disconnect(cabled(cabled(cabled(start, "ge1", "in1"), "ge2", "in2"), "ge3", "in3"), {
      from: port("ge2", "out"),
      to: port(mixer, "in2"),
    });
    expect(shape(doc)).toMatchObject({ inputs: ["in1", "in2", "in3", "in4"] });
  });

  it("stops at eight inputs", () => {
    const full = { ...start, cables: [{ from: port("ge1", "out"), to: port(mixer, "in8") }] };
    expect(shape(full)).toMatchObject({ height: 5 });
    expect(shape(full).inputs).toHaveLength(8);
    expect(getModuleDef("mixer")!.inputs).toHaveLength(8);
  });

  it("pushes the modules below it down as it grows, and those push the next", () => {
    const grown = cabled(start, "ge1", "in1");
    // The mixer now covers rows 0–1, so the amp at row 1 moves to row 2 and bumps the amp at row 3.
    expect([y(grown, mixer), y(grown, below), y(grown, further)]).toEqual([0, 2, 4]);
    // A module in another column stays put, and so does everything on the left.
    expect(y(grown, beside)).toBe(1);
    expect(grown.modules.slice(0, 3)).toEqual(start.modules.slice(0, 3));
    // Growing within the cell it already has moves nothing.
    const again = cabled(grown, "ge2", "in2");
    expect(again.modules).toEqual(grown.modules);
  });

  it("leaves modules alone when there is room", () => {
    const roomy = moveModules(start, new Set([below, further]), { x: 0, y: 5 });
    expect(cabled(roomy, "ge1", "in1").modules).toEqual(roomy.modules);
    expect(makeRoom(start, mixer)).toBe(start);
  });

  it("is undone together with the cable that caused it", () => {
    const editor = useEditor.getState();
    editor.load(start, null);
    editor.apply((doc) => cabled(doc, "ge1", "in1"));
    expect(y(useEditor.getState().doc, below)).toBe(2);
    useEditor.getState().undo();
    expect(useEditor.getState().doc).toBe(start);
  });

  it("takes up its grown size for placing and moving", () => {
    const grown = cabled(start, "ge1", "in1");
    expect(canPlace(start, "noise", { x: 4, y: 1 })).toBe(true);
    expect(canPlace(grown, "noise", { x: 4, y: 1 })).toBe(false);
    // The amp beside it can no longer slide left into the mixer's second row.
    expect(canMove(start, new Set([beside]), { x: -1, y: 0 })).toBe(true);
    expect(canMove(grown, new Set([beside]), { x: -1, y: 0 })).toBe(false);
  });
});

describe("dropping a new module on a port", () => {
  const target = (module: string, p: string, side: "in" | "out"): PortTarget => ({ module, port: p, side });
  const at = (doc: PatchDocument, id: string) => {
    const module = doc.modules.find((m) => m.id === id)!;
    return [module.x, module.y];
  };
  const cables = (doc: PatchDocument) =>
    doc.cables.map((c) => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}`).sort();

  // A saw and a low-pass with four free cells between them, without and with a cable.
  const apart = build(["osc-saw", 0, 0], ["filter-lp", 6, 0]);
  const chain = connect(apart, port("ge1", "out"), port("ge2", "in"));

  it("cables it to a free input and puts it to the left", () => {
    const { doc, id } = addModuleAtPort(apart, "env-adsr", target("ge2", "mod", "in"));
    expect(id).toBe("ge3");
    expect(cables(doc)).toEqual(["ge3.out>ge2.mod"]);
    expect(at(doc, "ge3")).toEqual([4, 0]);
  });

  it("cables it to a free output and puts it to the right", () => {
    const { doc } = addModuleAtPort(apart, "shaper-soft", target("ge1", "out", "out"));
    expect(cables(doc)).toEqual(["ge1.out>ge3.in"]);
    expect(at(doc, "ge3")).toEqual([2, 0]);
  });

  it("lands as near as it can when the spot beside a free port is taken", () => {
    const tight = build(["osc-saw", 0, 0], ["filter-lp", 2, 0]);
    const { doc } = addModuleAtPort(tight, "env-adsr", target("ge2", "mod", "in"));
    expect(cables(doc)).toEqual(["ge3.out>ge2.mod"]);
    expect(doc.modules.slice(0, 2)).toEqual(tight.modules);
    const [x, y] = at(doc, "ge3");
    expect(canPlace(tight, "env-adsr", { x, y })).toBe(true);
  });

  it("goes in between on a cabled input", () => {
    const { doc } = addModuleAtPort(chain, "shaper-soft", target("ge2", "in", "in"));
    expect(cables(doc)).toEqual(["ge1.out>ge3.in", "ge3.out>ge2.in"]);
    expect(at(doc, "ge3")).toEqual([4, 0]);
    expect(doc.modules.slice(0, 2)).toEqual(chain.modules);
  });

  it("takes its place in a row without gaps, and the rest of the row moves right", () => {
    // The default patch: Saw, Low-pass, Amp and Audio Out side by side, two envelopes in the row below.
    const { doc, id } = addModuleAtPort(basicSynth, "shaper-soft", target("ge2", "in", "in"));
    expect(id).toBe("ge7");
    expect(["ge1", "ge7", "ge2", "ge3", "ge4"].map((m) => at(doc, m))).toEqual([[0, 0], [2, 0], [4, 0], [6, 0], [7, 0]]);
    expect([at(doc, "ge5"), at(doc, "ge6")]).toEqual([[0, 3], [2, 3]]);
    expect(cables(doc)).toEqual([
      "ge1.out>ge7.in",
      "ge2.out>ge3.in",
      "ge3.out>ge4.left",
      "ge5.out>ge2.mod",
      "ge6.out>ge3.cv",
      "ge7.out>ge2.in",
    ]);
    expect(doc.pages).toBe(basicSynth.pages);
    // Dropping it on the other end of the same cable comes to the same thing.
    expect(addModuleAtPort(basicSynth, "shaper-soft", target("ge1", "out", "out")).doc).toEqual(doc);
  });

  it("goes in front of everything an output feeds", () => {
    // One envelope into a filter's Mod and an amp's CV, with a free column after the envelope.
    let start = build(["env-adsr", 0, 0], ["filter-lp", 3, 0], ["amp", 5, 0]);
    start = connect(start, port("ge1", "out"), port("ge2", "mod"));
    start = connect(start, port("ge1", "out"), port("ge3", "cv"));
    const { doc } = addModuleAtPort(start, "filter-lp", target("ge1", "out", "out"));
    expect(cables(doc)).toEqual(["ge1.out>ge4.in", "ge4.out>ge2.mod", "ge4.out>ge3.cv"]);
    // The new filter is two wide: it starts in the free column and pushes the rest along.
    expect(["ge1", "ge4", "ge2", "ge3"].map((m) => at(doc, m))).toEqual([[0, 0], [2, 0], [4, 0], [6, 0]]);
  });

  it("replaces the cable of an input when it has no input to go in between with", () => {
    const { doc } = addModuleAtPort(chain, "noise", target("ge2", "in", "in"));
    expect(cables(doc)).toEqual(["ge3.out>ge2.in"]);
    expect(at(doc, "ge3")).toEqual([5, 0]);
    expect(doc.modules.slice(0, 2)).toEqual(chain.modules);
  });

  it("adds a branch to an output when it has no output to go in between with", () => {
    const { doc } = addModuleAtPort(chain, "audio-out", target("ge1", "out", "out"));
    expect(cables(doc)).toEqual(["ge1.out>ge2.in", "ge1.out>ge3.left"]);
    expect(at(doc, "ge3")).toEqual([2, 0]);
  });

  it("is not cabled where it has nothing to plug in", () => {
    expect(planPortDrop(apart, "audio-out", target("ge2", "in", "in"))).toBeNull();
    expect(planPortDrop(apart, "noise", target("ge1", "out", "out"))).toBeNull();
    expect(planPortDrop(apart, "osc-saw", target("ge9", "in", "in"))).toBeNull();
    expect(planPortDrop(apart, "osc-saw", target("ge2", "in", "out"))).toBeNull();
    expect(planPortDrop(apart, "nope", target("ge2", "in", "in"))).toBeNull();
    const refused = addModuleAtPort(apart, "audio-out", target("ge2", "in", "in"));
    expect(refused.doc).toBe(apart);
    expect(refused.id).toBeNull();
  });

  it("does what it plans", () => {
    const cases: [PatchDocument, string, PortTarget][] = [
      [apart, "env-adsr", target("ge2", "mod", "in")],
      [chain, "shaper-fold", target("ge2", "in", "in")],
      [basicSynth, "filter-hp", target("ge2", "out", "out")],
      [basicSynth, "noise", target("ge3", "cv", "in")],
    ];
    for (const [start, type, on] of cases) {
      const plan = planPortDrop(start, type, on)!;
      const { doc, id } = addModuleAtPort(start, type, on);
      expect(id).toBe(nextModuleId(start));
      expect(at(doc, id!)).toEqual([plan.at.x, plan.at.y]);
      for (const cable of plan.cables) expect(doc.cables).toContainEqual(cable);
      // Only a push moves anything that was already there.
      if (!plan.push) expect(doc.modules.slice(0, -1)).toEqual(start.modules);
    }
  });

  it("grows a mixer it is dropped on, and uses a new mixer's first input", () => {
    const mixer = build(["mixer", 3, 0]);
    const fed = addModuleAtPort(mixer, "osc-sine", target("ge1", "in1", "in")).doc;
    expect(cables(fed)).toEqual(["ge2.out>ge1.in1"]);
    expect(at(fed, "ge2")).toEqual([1, 0]);
    expect(visibleDef(fed, fed.modules[0])!.inputs).toHaveLength(2);

    const mixed = addModuleAtPort(chain, "mixer", target("ge2", "in", "in")).doc;
    expect(cables(mixed)).toEqual(["ge1.out>ge3.in1", "ge3.out>ge2.in"]);
    expect(visibleDef(mixed, mixed.modules[2])!.inputs).toHaveLength(2);
  });

  it("makes room to the right, tile after tile", () => {
    // Two amps side by side and one in the row below; a filter put on top of the first.
    const row = build(["amp", 2, 0], ["amp", 3, 0], ["amp", 3, 2]);
    const crowded = { ...row, modules: [...row.modules, { id: "ge9", type: "filter-lp", x: 1, y: 0, params: {} }] };
    const roomy = makeRoom(crowded, "ge9", "right");
    expect(["ge9", "ge1", "ge2", "ge3"].map((m) => at(roomy, m))).toEqual([[1, 0], [3, 0], [4, 0], [3, 2]]);
    expect(makeRoom(row, "ge1", "right")).toBe(row);
  });

  it("is one undo step, and selects the new module", () => {
    useEditor.getState().load(basicSynth, null);
    const id = useEditor.getState().addModuleAtPort("shaper-soft", target("ge2", "in", "in"));
    expect(id).toBe("ge7");
    expect([...useEditor.getState().selection]).toEqual(["ge7"]);
    expect(useEditor.getState().doc.cables).toHaveLength(6);
    useEditor.getState().undo();
    expect(useEditor.getState().doc).toBe(basicSynth);
  });
});

describe("removing a module from a chain", () => {
  const cables = (doc: PatchDocument) =>
    doc.cables.map((c) => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}`).sort();
  const remove = (doc: PatchDocument, ...ids: string[]) => removeModules(doc, new Set(ids));

  it("patches what fed its first input into what its first output fed", () => {
    // The default patch without its filter: the saw goes straight into the amp.
    const doc = remove(basicSynth, "ge2");
    expect(cables(doc)).toEqual(["ge1.out>ge3.in", "ge3.out>ge4.left", "ge6.out>ge3.cv"]);
    // The envelope that was on the filter's Mod is left with nothing to feed.
    expect(doc.modules.map((m) => m.id)).toEqual(["ge1", "ge3", "ge4", "ge5", "ge6"]);
    expect(doc.pages[0].knobs).toEqual([null, null, null, { module: "ge1", param: "tune" }]);
  });

  it("keeps the cable where it was in the list, so the patch is otherwise as before", () => {
    const doc = remove(basicSynth, "ge2");
    expect(doc.cables[0]).toEqual({ from: port("ge1", "out"), to: port("ge3", "in") });
  });

  it("undoes a module dropped into a chain", () => {
    const { doc, id } = addModuleAtPort(basicSynth, "shaper-soft", { module: "ge2", port: "in", side: "in" });
    expect(cables(remove(doc, id!))).toEqual(cables(basicSynth));
    // And one dropped on an output that feeds two inputs.
    let fan = connect(basicSynth, port("ge6", "out"), port("ge1", "mod"));
    const before = cables(fan);
    const dropped = addModuleAtPort(fan, "filter-lp", { module: "ge6", port: "out", side: "out" });
    expect(cables(dropped.doc)).toContain(`${dropped.id}.out>ge1.mod`);
    fan = remove(dropped.doc, dropped.id!);
    expect(cables(fan)).toEqual(before);
  });

  it("looks through several removed modules in a row", () => {
    const doc = remove(basicSynth, "ge2", "ge3");
    expect(cables(doc)).toEqual(["ge1.out>ge4.left"]);
  });

  it("only removes the cables of a module at the end of a chain", () => {
    expect(cables(remove(basicSynth, "ge1"))).toEqual(["ge2.out>ge3.in", "ge3.out>ge4.left", "ge5.out>ge2.mod", "ge6.out>ge3.cv"]);
    expect(cables(remove(basicSynth, "ge4"))).toEqual(["ge1.out>ge2.in", "ge2.out>ge3.in", "ge5.out>ge2.mod", "ge6.out>ge3.cv"]);
  });

  it("does not pass on what was patched into another input", () => {
    // Without a cable in the filter's In, the envelope on its Mod is not sent on to the amp.
    const open = disconnect(basicSynth, basicSynth.cables[0]);
    expect(cables(remove(open, "ge2"))).toEqual(["ge3.out>ge4.left", "ge6.out>ge3.cv"]);
  });

  it("keeps a mixer's other inputs when one of its sources is taken out of a chain", () => {
    let doc = build(["osc-saw", 0, 0], ["shaper-hard", 2, 0], ["osc-sine", 0, 3], ["mixer", 5, 0]);
    doc = connect(doc, port("ge1", "out"), port("ge2", "in"));
    doc = connect(doc, port("ge2", "out"), port("ge4", "in1"));
    doc = connect(doc, port("ge3", "out"), port("ge4", "in2"));
    expect(cables(remove(doc, "ge2"))).toEqual(["ge1.out>ge4.in1", "ge3.out>ge4.in2"]);
  });

  it("gives up on a loop in a document read from a file", () => {
    const looped: PatchDocument = {
      ...build(["filter-lp", 0, 0], ["filter-hp", 2, 0], ["amp", 4, 0]),
      cables: [
        { from: port("ge1", "out"), to: port("ge2", "in") },
        { from: port("ge2", "out"), to: port("ge1", "in") },
        { from: port("ge2", "out"), to: port("ge3", "in") },
      ],
    };
    expect(remove(looped, "ge1", "ge2").cables).toEqual([]);
  });

  it("is one undo step from the editor", () => {
    useEditor.getState().load(basicSynth, null);
    useEditor.getState().select(["ge2"]);
    useEditor.getState().deleteSelection();
    expect(cables(useEditor.getState().doc)).toContain("ge1.out>ge3.in");
    useEditor.getState().undo();
    expect(useEditor.getState().doc).toBe(basicSynth);
  });
});

describe("settling a document whose tiles overlap", () => {
  const at = (doc: PatchDocument, id: string) => {
    const module = doc.modules.find((m) => m.id === id)!;
    return [module.x, module.y];
  };

  it("leaves a tidy document as it is", () => {
    expect(settle(basicSynth)).toBe(basicSynth);
    expect(settle(emptyDocument())).toEqual(emptyDocument());
  });

  it("pushes down what an envelope covers now that it is three cells tall", () => {
    // Laid out when the ADSR was three wide and two tall: an amp right under it, another under that.
    const old: PatchDocument = {
      ...emptyDocument(),
      modules: [
        { id: "ge1", type: "env-adsr", x: 0, y: 0, params: {} },
        { id: "ge2", type: "amp", x: 0, y: 2, params: {} },
        { id: "ge3", type: "amp", x: 0, y: 4, params: {} },
        { id: "ge4", type: "amp", x: 2, y: 0, params: {} },
      ],
    };
    const tidy = settle(old);
    expect(["ge1", "ge2", "ge3", "ge4"].map((id) => at(tidy, id))).toEqual([[0, 0], [0, 3], [0, 5], [2, 0]]);
    expect(settle(tidy)).toBe(tidy);
  });
});

describe("copying and pasting modules", () => {
  // A saw into a low-pass into an amp, in a row, with an envelope on the amp from the row below.
  const row = build(["osc-saw", 0, 0], ["filter-lp", 2, 0], ["amp", 5, 0], ["env-adsr", 2, 4]);
  const chain = [
    (d: PatchDocument) => connect(d, port("ge1", "out"), port("ge2", "in")),
    (d: PatchDocument) => connect(d, port("ge2", "out"), port("ge3", "in")),
    (d: PatchDocument) => connect(d, port("ge4", "out"), port("ge3", "cv")),
    (d: PatchDocument) => setParam(d, "ge2", "cutoff", 440),
    (d: PatchDocument) => renameModule(d, "ge2", "Dark"),
    (d: PatchDocument) => setPrecord(d, "ge1", "pitch", false),
    (d: PatchDocument) => assignKnob(d, { page: 0, knob: 0 }, { module: "ge2", param: "cutoff" }),
  ].reduce((d, edit) => edit(d), row);
  const cables = (d: Pick<PatchDocument, "cables">) =>
    d.cables.map((c) => `${c.from.module}.${c.from.port}>${c.to.module}.${c.to.port}`);
  const at = (d: PatchDocument, id: string) => {
    const module = d.modules.find((m) => m.id === id)!;
    return [module.x, module.y];
  };
  const ids = (...list: string[]) => new Set(list);

  it("copies the modules and the cables between them", () => {
    const clip = copyModules(chain, ids("ge2", "ge3"))!;
    expect(clip.modules.map((m) => m.id)).toEqual(["ge2", "ge3"]);
    expect(cables(clip)).toEqual(["ge2.out>ge3.in"]);
    expect(copyModules(chain, ids())).toBeNull();
    expect(copyModules(chain, ids("nope"))).toBeNull();
  });

  it("pastes them under new ids, with their settings and cabled as they were", () => {
    const clip = copyModules(chain, ids("ge1", "ge2", "ge3"))!;
    const pasted = pasteModules(chain, clip, { x: 0, y: 10 });
    expect(pasted.ids).toEqual(["ge5", "ge6", "ge7"]);
    expect(cables(pasted.doc).slice(chain.cables.length)).toEqual(["ge5.out>ge6.in", "ge6.out>ge7.in"]);
    const filter = pasted.doc.modules.find((m) => m.id === "ge6")!;
    expect(filter).toMatchObject({ type: "filter-lp", name: "Dark", params: { cutoff: 440 } });
    expect(pasted.doc.modules.find((m) => m.id === "ge5")!.precords).toEqual({ pitch: false });
    // What was there is as it was, and the knob still has the setting it had.
    expect(pasted.doc.modules.slice(0, 4)).toEqual(chain.modules);
    expect(pasted.doc.pages).toBe(chain.pages);
    expect(findAssignment(pasted.doc, "ge6", "cutoff")).toBeNull();
  });

  it("keeps the group's shape and puts its corner where asked when that is free", () => {
    const clip = copyModules(chain, ids("ge2", "ge3", "ge4"))!;
    expect(clipSize(clip)).toEqual({ width: 4, height: 4 + getModuleDef("env-adsr")!.height });
    const pasted = pasteModules(chain, clip, { x: 20, y: -3 }).doc;
    expect([at(pasted, "ge5"), at(pasted, "ge6"), at(pasted, "ge7")]).toEqual([[20, -3], [23, -3], [20, 1]]);
  });

  it("goes to the nearest room for the whole group when the place is taken", () => {
    const clip = copyModules(chain, ids("ge1", "ge2", "ge3"))!;
    const pasted = pasteModules(chain, clip, { x: 1, y: 1 });
    const [x, y] = at(pasted.doc, pasted.ids[0]);
    expect(at(pasted.doc, pasted.ids[1])).toEqual([x + 2, y]);
    expect(at(pasted.doc, pasted.ids[2])).toEqual([x + 5, y]);
    // Nothing lies on anything else.
    expect(settle(pasted.doc)).toBe(pasted.doc);
    // Pasting again at the same place finds other room.
    const again = pasteModules(pasted.doc, clip, { x: 1, y: 1 });
    expect(at(again.doc, again.ids[0])).not.toEqual([x, y]);
    expect(settle(again.doc)).toBe(again.doc);
  });

  it("pastes into another patch", () => {
    const clip = copyModules(chain, ids("ge2", "ge3"))!;
    const other = build(["noise", 0, 0]);
    const pasted = pasteModules(other, clip, { x: 4, y: 0 });
    expect(pasted.ids).toEqual(["ge2", "ge3"]);
    expect(cables(pasted.doc)).toEqual(["ge2.out>ge3.in"]);
    expect(pasteModules(other, { modules: [], cables: [] }, { x: 0, y: 0 })).toEqual({ doc: other, ids: [] });
  });

  it("duplicates right below the modules, or as near to that as there is room", () => {
    const one = duplicateModules(chain, ids("ge1"));
    expect(at(one.doc, one.ids[0])).toEqual([0, getModuleDef("osc-saw")!.height]);
    // Below the low-pass is the envelope: the copy of the row goes around it.
    const three = duplicateModules(chain, ids("ge1", "ge2", "ge3"));
    expect(three.ids).toHaveLength(3);
    expect(settle(three.doc)).toBe(three.doc);
    expect(duplicateModules(chain, ids())).toEqual({ doc: chain, ids: [] });
  });

  it("copies a mixer at the size it has without the cables left behind", () => {
    const mixed = connect(build(["osc-saw", 0, 0], ["mixer", 3, 0]), port("ge1", "out"), port("ge2", "in1"));
    expect(visibleDef(mixed, mixed.modules[1])!.height).toBe(2);
    expect(clipSize(copyModules(mixed, ids("ge2"))!).height).toBe(1);
    // Its copy goes below the mixer as it is here, two cells tall.
    const copy = duplicateModules(mixed, ids("ge2"));
    expect(at(copy.doc, copy.ids[0])).toEqual([3, 2]);
    // Copied with its source, it keeps the cable and the size.
    const both = duplicateModules(mixed, ids("ge1", "ge2")).doc;
    expect(visibleDef(both, both.modules[3])!.height).toBe(2);
    expect(settle(both)).toBe(both);
  });

  it("selects what was pasted, as one undo step", () => {
    useEditor.getState().load(chain, null);
    useEditor.getState().paste(copyModules(chain, ids("ge1", "ge2"))!, { x: 0, y: 10 });
    expect([...useEditor.getState().selection]).toEqual(["ge5", "ge6"]);
    useEditor.getState().duplicateSelection();
    expect([...useEditor.getState().selection]).toEqual(["ge7", "ge8"]);
    expect(cables(useEditor.getState().doc).slice(chain.cables.length)).toEqual(["ge5.out>ge6.in", "ge7.out>ge8.in"]);
    useEditor.getState().undo();
    useEditor.getState().undo();
    expect(useEditor.getState().doc).toBe(chain);
    expect(useEditor.getState().selection.size).toBe(0);
  });
});
