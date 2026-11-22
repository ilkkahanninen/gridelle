import { describe, expect, it } from "vitest";
import { basicSynth } from "../fixtures";
import { getModuleDef } from "../modules/registry";
import { visibleDef } from "../modules/shape";
import { useEditor } from "../../state/store";
import { formatParam, fromNormalized, toNormalized } from "../modules/params";
import {
  addModule,
  addPage,
  assignKnob,
  assignToFreeKnob,
  findAssignment,
  removePage,
  renamePage,
  unassign,
  canMove,
  canPlace,
  connect,
  connectionProblem,
  disconnect,
  findFreeCell,
  makeRoom,
  moveModules,
  nextModuleId,
  removeModules,
  setParam,
  setPrecord,
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
    expect(removeModules(wired, new Set(["ge2"])).cables).toEqual([]);
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
    expect(formatParam(def("osc-saw", "tune"), -12)).toBe("-12 st");
    expect(formatParam(def("env-adsr", "sustain"), 0.6)).toBe("0.60");
  });

  it("toggles pre-cords only on ports that have one", () => {
    const off = setPrecord(doc, "ge2", "pitch", false);
    expect(off.modules[1].precords).toEqual({ pitch: false });
    expect(setPrecord(off, "ge2", "pitch", false)).toBe(off);
    expect(setPrecord(doc, "ge1", "in", false)).toBe(doc);
  });
});

describe("knob pages", () => {
  const doc = addPage(build(["filter-lp", 0, 0], ["osc-saw", 2, 0]), "Main");
  const cutoff = { module: "ge1", param: "cutoff" };

  it("adds, renames and removes pages", () => {
    expect(doc.pages).toEqual([{ name: "Main", knobs: [null, null, null, null] }]);
    expect(addPage(doc).pages[1].name).toBe("Page 2");
    expect(renamePage(doc, 0, "Tone").pages[0].name).toBe("Tone");
    expect(removePage(doc, 0).pages).toEqual([]);
    expect(removePage(doc, 5)).toBe(doc);
    let full = doc;
    for (let i = 0; i < 20; i++) full = addPage(full);
    expect(full.pages).toHaveLength(8);
  });

  it("assigns a parameter to a knob and finds it again", () => {
    const assigned = assignKnob(doc, { page: 0, knob: 2 }, cutoff);
    expect(assigned.pages[0].knobs).toEqual([null, null, cutoff, null]);
    expect(findAssignment(assigned, "ge1", "cutoff")).toEqual({ page: 0, knob: 2 });
    expect(findAssignment(assigned, "ge1", "res")).toBeNull();
    expect(assignKnob(assigned, { page: 0, knob: 2 }, cutoff)).toBe(assigned);
  });

  it("moves a parameter rather than putting it on two knobs", () => {
    const first = assignKnob(addPage(doc), { page: 0, knob: 0 }, cutoff);
    const moved = assignKnob(first, { page: 1, knob: 3 }, cutoff);
    expect(moved.pages[0].knobs[0]).toBeNull();
    expect(moved.pages[1].knobs[3]).toEqual(cutoff);
  });

  it("refuses parameters and slots that do not exist", () => {
    expect(assignKnob(doc, { page: 0, knob: 0 }, { module: "ge1", param: "nope" })).toBe(doc);
    expect(assignKnob(doc, { page: 0, knob: 4 }, cutoff)).toBe(doc);
    expect(assignKnob(doc, { page: 3, knob: 0 }, cutoff)).toBe(doc);
  });

  it("clears a knob, and unassigns by parameter", () => {
    const assigned = assignKnob(doc, { page: 0, knob: 0 }, cutoff);
    expect(assignKnob(assigned, { page: 0, knob: 0 }, null).pages[0].knobs[0]).toBeNull();
    expect(unassign(assigned, "ge1", "cutoff").pages[0].knobs[0]).toBeNull();
    expect(unassign(doc, "ge1", "cutoff")).toBe(doc);
  });

  it("fills the first free knob and adds a page when all are taken", () => {
    let filled = build(["filter-lp", 0, 0], ["env-adsr", 2, 0]);
    filled = assignToFreeKnob(filled, cutoff);
    expect(filled.pages).toHaveLength(1);
    for (const param of ["res", "mod"]) filled = assignToFreeKnob(filled, { module: "ge1", param });
    filled = assignToFreeKnob(filled, { module: "ge2", param: "attack" });
    filled = assignToFreeKnob(filled, { module: "ge2", param: "decay" });
    expect(filled.pages.map((p) => p.knobs.filter(Boolean).length)).toEqual([4, 1]);
    expect(findAssignment(filled, "ge1", "res")).toEqual({ page: 0, knob: 1 });
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
    ["osc-saw", 0, 2],
    ["osc-saw", 0, 4],
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
