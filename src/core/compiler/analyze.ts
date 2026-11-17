import {
  KNOBS_PER_PAGE,
  MAX_PAGES,
  MAX_VOICES,
  MIN_VOICES,
  type ModuleId,
  type ModuleInstance,
  type PatchDocument,
} from "../model/types";
import { getModuleDef } from "../modules/registry";
import type { ModuleDef, ParamDef, Scope, VoiceSignal } from "../modules/types";

export interface Diagnostic {
  severity: "error" | "warning";
  /** Stable identifier, for tests and for the UI to style or group by. */
  code:
    | "unknown-module"
    | "bad-id"
    | "duplicate-id"
    | "bad-cable"
    | "input-in-use"
    | "feedback-loop"
    | "voice-count"
    | "no-output"
    | "bad-knob"
    | "page-count"
    | "missing-abstraction";
  message: string;
  module?: ModuleId;
}

export interface ResolvedModule {
  instance: ModuleInstance;
  def: ModuleDef;
  /** Where the module ends up running: in every voice, or once after the voices are summed. */
  scope: Scope;
}

/** A signal connection between two resolved modules, by Pd outlet/inlet index. */
export interface Wire {
  from: ModuleId;
  outlet: number;
  to: ModuleId;
  inlet: number;
}

/** An input fed from the voice's own pitch/gate/velocity instead of a cable. */
export interface PrecordWire {
  signal: VoiceSignal;
  to: ModuleId;
  inlet: number;
}

/** A hardware knob on a page, resolved to the parameter it controls. */
export interface KnobBinding {
  module: ResolvedModule;
  param: ParamDef;
}

export interface ResolvedPage {
  name: string;
  /** One entry per hardware knob; `null` where the knob is unused. */
  knobs: (KnobBinding | null)[];
}

export interface Analysis {
  diagnostics: Diagnostic[];
  modules: ResolvedModule[];
  /** Cables and normalled connections. */
  wires: Wire[];
  precords: PrecordWire[];
  pages: ResolvedPage[];
}

/** Ids become Pd symbols and receiver prefixes, so keep them to a safe alphabet. */
const ID_PATTERN = /^ge[0-9a-z]+$/;

export function analyze(doc: PatchDocument): Analysis {
  const diagnostics: Diagnostic[] = [];
  const error = (code: Diagnostic["code"], message: string, module?: ModuleId) =>
    diagnostics.push({ severity: "error", code, message, module });

  if (!Number.isInteger(doc.voices) || doc.voices < MIN_VOICES || doc.voices > MAX_VOICES) {
    error("voice-count", `Voice count must be a whole number from ${MIN_VOICES} to ${MAX_VOICES}.`);
  }

  const byId = new Map<ModuleId, ResolvedModule>();
  for (const instance of doc.modules) {
    const def = getModuleDef(instance.type);
    if (!def) {
      error("unknown-module", `Unknown module type "${instance.type}".`, instance.id);
    } else if (!ID_PATTERN.test(instance.id)) {
      error("bad-id", `Module id "${instance.id}" is not valid.`, instance.id);
    } else if (byId.has(instance.id)) {
      error("duplicate-id", `Two modules share the id "${instance.id}".`, instance.id);
    } else {
      byId.set(instance.id, { instance, def, scope: def.scope });
    }
  }

  const wires: Wire[] = [];
  const fed = new Set<string>();
  const inputKey = (module: ModuleId, inlet: number) => `${module}:${inlet}`;

  for (const cable of doc.cables) {
    const from = byId.get(cable.from.module);
    const to = byId.get(cable.to.module);
    const outlet = from?.def.outputs.findIndex((p) => p.id === cable.from.port) ?? -1;
    const inlet = to?.def.inputs.findIndex((p) => p.id === cable.to.port) ?? -1;
    if (!from || !to || outlet < 0 || inlet < 0) {
      error(
        "bad-cable",
        `A cable refers to a missing module or port (${cable.from.module}.${cable.from.port} → ${cable.to.module}.${cable.to.port}).`,
      );
      continue;
    }
    const key = inputKey(to.instance.id, inlet);
    if (fed.has(key)) {
      error("input-in-use", `${to.def.name} input "${to.def.inputs[inlet].label}" has more than one cable.`, to.instance.id);
      continue;
    }
    fed.add(key);
    wires.push({ from: from.instance.id, outlet, to: to.instance.id, inlet });
  }

  // Normalled inputs follow their partner's source when left unpatched.
  for (const { instance, def } of byId.values()) {
    for (const [fromPort, toPort] of def.normalled ?? []) {
      const fromInlet = def.inputs.findIndex((p) => p.id === fromPort);
      const toInlet = def.inputs.findIndex((p) => p.id === toPort);
      const source = wires.find((w) => w.to === instance.id && w.inlet === fromInlet);
      if (source && !fed.has(inputKey(instance.id, toInlet))) {
        fed.add(inputKey(instance.id, toInlet));
        wires.push({ ...source, inlet: toInlet });
      }
    }
  }

  const downstream = new Map<ModuleId, ModuleId[]>();
  for (const wire of wires) {
    downstream.set(wire.from, [...(downstream.get(wire.from) ?? []), wire.to]);
  }

  // Pd refuses to run a signal loop, so report it here in the editor's terms.
  const state = new Map<ModuleId, "visiting" | "done">();
  const inLoop = new Set<ModuleId>();
  const visit = (id: ModuleId, path: ModuleId[]) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") {
      for (const member of path.slice(path.indexOf(id))) inLoop.add(member);
      return;
    }
    state.set(id, "visiting");
    for (const next of downstream.get(id) ?? []) visit(next, [...path, id]);
    state.set(id, "done");
  };
  for (const id of byId.keys()) visit(id, []);
  if (inLoop.size > 0) {
    const names = [...inLoop].map((id) => byId.get(id)!.def.name).join(" → ");
    error("feedback-loop", `These modules form a feedback loop, which is not supported yet: ${names}.`, [...inLoop][0]);
  }

  // Everything fed by a global module runs once, after the voices are summed.
  const pending = [...byId.values()].filter((m) => m.scope === "global").map((m) => m.instance.id);
  while (pending.length > 0) {
    for (const next of downstream.get(pending.pop()!) ?? []) {
      const module = byId.get(next)!;
      if (module.scope !== "global") {
        module.scope = "global";
        pending.push(next);
      }
    }
  }
  const precords: PrecordWire[] = [];
  for (const { instance, def, scope } of byId.values()) {
    if (scope !== "voice") continue;
    def.inputs.forEach((port, inlet) => {
      const enabled = instance.precords?.[port.id] ?? true;
      if (port.precord && enabled && !fed.has(inputKey(instance.id, inlet))) {
        precords.push({ signal: port.precord, to: instance.id, inlet });
      }
    });
  }

  const outputs = [...byId.values()].filter((m) => m.def.type === "audio-out");
  if (!outputs.some((out) => wires.some((w) => w.to === out.instance.id))) {
    diagnostics.push({
      severity: "warning",
      code: "no-output",
      message: "Nothing is connected to an Audio Out, so the patch will be silent.",
    });
  }

  if (doc.pages.length > MAX_PAGES) {
    error("page-count", `A patch can have at most ${MAX_PAGES} knob pages.`);
  }
  const assigned = new Set<string>();
  const pages: ResolvedPage[] = doc.pages.map((page) => ({
    name: page.name,
    knobs: Array.from({ length: KNOBS_PER_PAGE }, (_, i) => {
      const knob = page.knobs[i];
      if (!knob) return null;
      const module = byId.get(knob.module);
      const param = module?.def.params.find((p) => p.id === knob.param);
      const key = `${knob.module}-${knob.param}`;
      // A stale or repeated assignment is dropped rather than failing the whole patch.
      if (!module || !param || assigned.has(key)) {
        diagnostics.push({
          severity: "warning",
          code: "bad-knob",
          message: `Knob ${i + 1} on page “${page.name}” is assigned to something that no longer exists, so it is ignored.`,
        });
        return null;
      }
      assigned.add(key);
      return { module, param };
    }),
  }));

  return { diagnostics, modules: [...byId.values()], wires, precords, pages };
}
