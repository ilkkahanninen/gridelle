import { analyze, containerChain, type Analysis } from "./compiler/analyze";
import { MAIN, VOICE } from "./model/area";
import { moduleName } from "./model/ops";
import type { ModuleId, PatchDocument } from "./model/types";
import { moduleDefs, VOICE_ABSTRACTION } from "./modules/registry";
import measured from "./modules/costs.json";

/*
 * How much of the Organelle's CPU a patch takes. Every module runs all the time (voices are
 * never muted), so the cost is the sum of what each copy of each module costs: once outside
 * the voices, once per voice in them, and times the group's size in a unison group.
 *
 * What a module costs is measured, in two steps. `module_cost.rs` runs every module in real
 * Pd on the computer the editor is developed on, and writes `modules/costs.json`: each
 * module's cost as a part of a Saw's. The Organelle's own figures come from the CPU probe
 * (`pd-lib/cpu-probe`), run on an Organelle M with OS 3.2: what Pd used with nothing
 * running, and what a Saw, a Low-pass and a Reverb added per copy (1.39, 2.69 and 5.0 %).
 */

/** What the Organelle's Pd uses for itself and its host patch, with no module running: percent. */
export const ORGANELLE_BASE = 6.5;
/**
 * What one Saw costs on the Organelle, percent: the unit of `costs.json`. On the device a
 * Saw cost 1.39, a Low-pass 2.69 and a Reverb 5.0; measured here they cost 1, 1.93 and 3.96
 * Saws. 1.35 fits all three within 6 % (the geometric mean of what each says a Saw is).
 */
export const ORGANELLE_PER_SAW = 1.35;

/** From here the estimate shows amber: there is little room left. */
export const CPU_HIGH = 70;
/**
 * From here it shows red, and the patch gets a warning: it crackles on the Organelle. Pd
 * needs room besides its own work (the screen, the audio driver): Basic Synth with its saw
 * in a unison group played cleanly at 11 copies, estimated 80 %, and crackled now and then
 * at 12, estimated 86 %.
 */
export const CPU_OVER = 85;

/** The key `costs.json` has for what every voice runs besides its modules (`ge-voice`). */
export const VOICE_COST = "@voice";

const COSTS: Readonly<Record<string, number>> = measured.costs;

export interface CostPart {
  module: ModuleId;
  /** What the module is called: its own name, or its type's. */
  name: string;
  /** How many copies of it run. */
  copies: number;
  /** Percent of the Organelle's CPU, all its copies together. */
  percent: number;
}

export interface CpuEstimate {
  /** Percent of the Organelle's CPU, the base included. */
  percent: number;
  /** The modules, the costliest first. */
  parts: CostPart[];
}

/** How many copies of a module in `container` run: in the voices once per voice, in a group times its size. */
function copiesIn(analysis: Analysis, container: string): number {
  return containerChain(analysis.groups, container).reduce((copies, key) => {
    if (key === VOICE) return copies * analysis.copies;
    if (key === MAIN) return copies;
    return copies * (analysis.groups.find((g) => g.group.id === key)?.group.size ?? 1);
  }, 1);
}

/** The patch's cost on the Organelle, from its analysis. A module with no measured cost counts as nothing. */
export function estimateFromAnalysis(analysis: Analysis): CpuEstimate {
  const parts = analysis.modules
    .map(({ instance, def, container }): CostPart => {
      const copies = copiesIn(analysis, container);
      return { module: instance.id, name: moduleName(instance, def), copies, percent: copies * (COSTS[def.type] ?? 0) * ORGANELLE_PER_SAW };
    })
    .sort((a, b) => b.percent - a.percent);
  const voices = analysis.copies * (COSTS[VOICE_COST] ?? 0) * ORGANELLE_PER_SAW;
  return { percent: ORGANELLE_BASE + voices + parts.reduce((sum, part) => sum + part.percent, 0), parts };
}

export function estimateCpu(doc: PatchDocument): CpuEstimate {
  return estimateFromAnalysis(analyze(doc));
}

/**
 * What `module_cost.rs` measures, for every module: its abstraction, what feeds each of its
 * inlets (left to right, as the compiler would leave them unpatched), and its creation
 * arguments after its id. A test keeps it in `tests/cost/modules.json`.
 *
 * An inlet is `main` (a signal is fed: an `osc~`), `control` (notes: nothing), `mod` (0),
 * or a number (a `[sig~]` of it: what an unpatched setting input rests at).
 */
export interface CostBenchModule {
  type: string;
  pd: string;
  inlets: (string | number)[];
  args: string;
}

export function costBenchPlan(): CostBenchModule[] {
  const modules = moduleDefs.map((def): CostBenchModule => {
    const voice = (def.voiceInlets ?? []).map(() => "main" as const);
    const inputs = def.inputs.map((port): string | number => {
      if (port.kind === "notes") return "control";
      if (port.unpatched !== undefined) return port.unpatched;
      if (port.id === "mod" || port.id === "pwm") return "mod";
      return "main";
    });
    // The values built in (a sample slot), then a Scope's number and voice.
    const built = def.params.filter((p) => p.argument).map((p) => String(p.default));
    const tap = def.tap ? ["0", "-1"] : [];
    return { type: def.type, pd: def.pd, inlets: [...voice, ...inputs], args: [...built, ...tap].join(" ") };
  });
  return [...modules, { type: VOICE_COST, pd: VOICE_ABSTRACTION, inlets: ["control"], args: "" }];
}
