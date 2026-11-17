import { describe, expect, it } from "vitest";
import { pdNumber, PdPatch } from "./patch";

const at = { x: 10, y: 20 };

describe("PdPatch", () => {
  it("writes boxes and connections with zero-based box indices", () => {
    const patch = new PdPatch({ width: 400, height: 300 });
    const osc = patch.obj("osc~ 440", at);
    const dac = patch.obj("dac~", { x: 10.4, y: 60.6 });
    patch.connect(osc, 0, dac, 1);
    expect(patch.toString()).toBe(
      "#N canvas 0 50 400 300 12;\n#X obj 10 20 osc~ 440;\n#X obj 10 61 dac~;\n#X connect 0 0 1 1;\n",
    );
  });

  it("counts comments and message boxes when numbering connections", () => {
    const patch = new PdPatch();
    patch.comment("a note", at);
    const msg = patch.msg("1", at);
    const float = patch.obj("f", at);
    patch.connect(msg, 0, float, 0);
    expect(patch.toString()).toContain("#X connect 1 0 2 0;");
  });

  it("escapes dollar arguments in objects", () => {
    const patch = new PdPatch();
    patch.obj("r $1-cutoff", at);
    patch.obj("expr~ $v1 * 2 - 1", at);
    expect(patch.toString()).toContain("#X obj 10 20 r \\$1-cutoff;");
    expect(patch.toString()).toContain("#X obj 10 20 expr~ \\$v1 * 2 - 1;");
  });

  it("turns commas and semicolons in messages into escaped separator atoms", () => {
    const patch = new PdPatch();
    patch.msg("1 $1, $2 $3 $1", at);
    patch.msg("; ge1-tune 0; ge2-cutoff 440.5", at);
    const text = patch.toString();
    expect(text).toContain("#X msg 10 20 1 \\$1 \\, \\$2 \\$3 \\$1;");
    expect(text).toContain("#X msg 10 20 \\; ge1-tune 0 \\; ge2-cutoff 440.5;");
  });

  it("rejects text it cannot represent", () => {
    const patch = new PdPatch();
    expect(() => patch.obj("pack f, f", at)).toThrow();
    expect(() => patch.obj("a \\ b", at)).toThrow();
    expect(() => patch.obj("   ", at)).toThrow();
  });
});

describe("pdNumber", () => {
  it.each([
    [0, "0"],
    [-0, "0"],
    [1, "1"],
    [0.5, "0.5"],
    [-12.25, "-12.25"],
    [1e-7, "0"],
    [0.000001, "0.000001"],
    [1 / 3, "0.333333"],
    [18000, "18000"],
  ])("formats %s as %s", (value, text) => {
    expect(pdNumber(value)).toBe(text);
  });

  it("refuses values Pd cannot read", () => {
    expect(() => pdNumber(NaN)).toThrow();
    expect(() => pdNumber(Infinity)).toThrow();
    expect(() => pdNumber(1e21)).toThrow();
  });
});
