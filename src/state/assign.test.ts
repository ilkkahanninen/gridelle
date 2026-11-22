import { beforeEach, describe, expect, it } from "vitest";
import { basicSynth } from "../core/fixtures";
import * as ops from "../core/model/ops";
import { armKnob, assignToArmed, cancelAssign } from "./assign";
import { useEditor } from "./store";
import { useUi } from "./ui";

const doc = () => useEditor.getState().doc;
const armed = () => useUi.getState().assigning;
/** What is on each knob of a page, as `module.param`, with `-` for an empty one. */
const page = (index: number) => doc().pages[index].knobs.map((k) => (k ? `${k.module}.${k.param}` : "-"));

describe("assigning Organelle knobs by clicking", () => {
  // The default patch: page 0 is full (ge2 cutoff, res, mod; ge1 tune); page 1 has knob 2 empty.
  beforeEach(() => {
    useEditor.getState().load(basicSynth, null);
    useUi.setState({ assigning: null });
  });

  it("does nothing while no knob is armed", () => {
    expect(assignToArmed("ge5", "decay")).toBe(false);
    expect(doc()).toBe(basicSynth);
  });

  it("puts the clicked setting on the armed knob, and ends when the page is full", () => {
    armKnob({ page: 1, knob: 1 });
    expect(assignToArmed("ge6", "decay")).toBe(true);
    expect(page(1)).toEqual(["ge6.attack", "ge6.decay", "ge6.sustain", "ge6.release"]);
    expect(armed()).toBeNull();
  });

  it("goes on to the next empty knob of the page, one click each", () => {
    useEditor.getState().apply((d) => ops.addPage(d));
    armKnob({ page: 2, knob: 0 });
    for (const param of ["attack", "decay", "sustain"]) {
      assignToArmed("ge5", param);
    }
    expect(page(2)).toEqual(["ge5.attack", "ge5.decay", "ge5.sustain", "-"]);
    expect(armed()).toEqual({ page: 2, knob: 3 });
    assignToArmed("ge5", "release");
    expect(page(2)).toEqual(["ge5.attack", "ge5.decay", "ge5.sustain", "ge5.release"]);
    expect(armed()).toBeNull();
  });

  it("starts from the armed knob and comes round to the ones before it", () => {
    useEditor.getState().apply((d) => ops.addPage(d));
    armKnob({ page: 2, knob: 2 });
    assignToArmed("ge5", "attack");
    expect(armed()).toEqual({ page: 2, knob: 3 });
    assignToArmed("ge5", "decay");
    expect(armed()).toEqual({ page: 2, knob: 0 });
    expect(page(2)).toEqual(["-", "-", "ge5.attack", "ge5.decay"]);
  });

  it("moves a setting that was already on a knob, leaving that knob empty", () => {
    armKnob({ page: 1, knob: 1 });
    assignToArmed("ge2", "cutoff");
    expect(page(0)).toEqual(["-", "ge2.res", "ge2.mod", "ge1.tune"]);
    expect(page(1)).toEqual(["ge6.attack", "ge2.cutoff", "ge6.sustain", "ge6.release"]);
    // Page 1 is full; the knob it left on page 0 is not armed.
    expect(armed()).toBeNull();
  });

  it("arms the knob a setting left when that is on the same page", () => {
    armKnob({ page: 1, knob: 1 });
    assignToArmed("ge6", "attack");
    expect(page(1)).toEqual(["-", "ge6.attack", "ge6.sustain", "ge6.release"]);
    expect(armed()).toEqual({ page: 1, knob: 0 });
  });

  it("is one undo step for each knob", () => {
    armKnob({ page: 1, knob: 1 });
    assignToArmed("ge6", "decay");
    useEditor.getState().undo();
    expect(doc()).toBe(basicSynth);
  });

  it("gives up when the armed knob is no longer there", () => {
    armKnob({ page: 5, knob: 0 });
    expect(assignToArmed("ge6", "decay")).toBe(true);
    expect(doc()).toBe(basicSynth);
    expect(armed()).toBeNull();
  });

  it("can be cancelled", () => {
    armKnob({ page: 1, knob: 1 });
    cancelAssign();
    expect(armed()).toBeNull();
    expect(assignToArmed("ge6", "decay")).toBe(false);
  });
});
