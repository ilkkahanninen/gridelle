import type { Cable, ModuleInstance, PatchDocument } from "../model/types";
import { getModuleDef } from "./registry";
import type { ModuleDef } from "./types";

/**
 * How many input–parameter pairs of a growing module the editor shows: everything up
 * to the last cabled input, and one free pair after it (unless they are all in use).
 */
export function visiblePairs(def: ModuleDef, module: Pick<ModuleInstance, "id">, cables: readonly Cable[]): number {
  let lastCabled = 0;
  for (const cable of cables) {
    if (cable.to.module !== module.id) continue;
    lastCabled = Math.max(lastCabled, def.inputs.findIndex((port) => port.id === cable.to.port) + 1);
  }
  return Math.min(def.inputs.length, lastCabled + 1);
}

// One object per (type, pairs), so components that compare definitions by identity stay still.
const shapes = new Map<string, ModuleDef>();

function withPairs(def: ModuleDef, pairs: number): ModuleDef {
  const key = `${def.type}:${pairs}`;
  let shape = shapes.get(key);
  if (!shape) {
    shape = {
      ...def,
      inputs: def.inputs.slice(0, pairs),
      params: def.params.slice(0, pairs),
      // Two rows to a grid cell, under a half-cell header with the name.
      height: Math.ceil((pairs + 1) / 2),
    };
    shapes.set(key, shape);
  }
  return shape;
}

/**
 * A module's definition as the editor shows it. For most modules that is the registry
 * definition; a module that grows with its inputs (the mixer) gets only the inputs and
 * parameters in use plus one free pair, and the height that goes with them.
 *
 * The compiler never uses this: the Pd abstraction always has every input.
 */
export function visibleDef(doc: Pick<PatchDocument, "cables">, module: ModuleInstance): ModuleDef | undefined {
  const def = getModuleDef(module.type);
  if (!def?.growsWithInputs) return def;
  return withPairs(def, visiblePairs(def, module, doc.cables));
}
