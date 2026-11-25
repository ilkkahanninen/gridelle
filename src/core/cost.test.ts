import { describe, expect, it } from "vitest";
import { basicSynth, fixtures } from "./fixtures";
import { compile } from "./compiler";
import { abstractionLibrary } from "./pdlib";
import { costBenchPlan, CPU_OVER, estimateCpu, ORGANELLE_BASE, VOICE_COST } from "./cost";
import measured from "./modules/costs.json";
import { moduleDefs } from "./modules/registry";

describe("the CPU estimate", () => {
  it("writes what to measure for every module, for module_cost.rs", async () => {
    await expect(JSON.stringify(costBenchPlan(), null, 2) + "\n").toMatchFileSnapshot("../../tests/cost/modules.json");
  });

  it("has a measured cost for every module, and for a voice", () => {
    const costs: Record<string, number> = measured.costs;
    for (const def of moduleDefs) expect(costs[def.type], `${def.type}: run module_cost.rs`).toBeGreaterThanOrEqual(0);
    expect(costs[VOICE_COST]).toBeGreaterThanOrEqual(0);
    expect(costs["osc-saw"]).toBe(1);
  });

  it("counts a module once outside the voices, once per voice in them, and times a group's size", () => {
    const one = estimateCpu({ ...basicSynth, voices: 1 });
    const four = estimateCpu({ ...basicSynth, voices: 4 });
    const saw = (e: ReturnType<typeof estimateCpu>) => e.parts.find((p) => p.module === "ge1")!;
    expect(saw(one).copies).toBe(1);
    expect(saw(four).copies).toBe(4);
    expect(saw(four).percent).toBeCloseTo(4 * saw(one).percent);
    // The Audio Out runs once, however many voices.
    expect(four.parts.find((p) => p.name === "Audio Out")!.copies).toBe(1);
    // Mono Lead: one voice, its saw in a group of three.
    const lead = estimateCpu(fixtures["mono-lead"]);
    expect(lead.parts.find((p) => p.name === "Saw")!.copies).toBe(3);
    // Nothing at all costs the base.
    expect(estimateCpu({ ...basicSynth, modules: [], cables: [], pages: [], voices: 1 }).percent).toBeGreaterThanOrEqual(ORGANELLE_BASE);
    expect(four.percent).toBeGreaterThan(one.percent);
  });

  it("warns of a patch the Organelle cannot run, naming what costs most", () => {
    // A Reverb, a Phaser and more in each of sixteen voices.
    const heavy = { ...fixtures["voice-effects"], voices: 16 };
    expect(estimateCpu(heavy).percent).toBeGreaterThan(CPU_OVER);
    const warning = compile(heavy, abstractionLibrary).diagnostics.find((d) => d.code === "cpu-load");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/Reverb \(16 copies\) costs most/);
    expect(compile(fixtures["voice-effects"], abstractionLibrary).diagnostics.map((d) => d.code)).not.toContain("cpu-load");
  });
});
