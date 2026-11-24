import {
  KNOBS_PER_PAGE,
  MAX_PAGES,
  MAX_VOICES,
  MIN_VOICES,
  SAMPLE_PARAM,
  SAMPLE_SLOTS,
  NOTE_PRIORITIES,
  sampleLetter,
  voiceCopies,
  voicingOf,
  type ModuleId,
  type ModuleInstance,
  type PatchDocument,
  type SampleSlot,
  type Voicing,
} from "../model/types";
import { isVoiceNotes, placement } from "../model/area";
import { defaultPageName, moduleName } from "../model/ops";
import { wavetableBank } from "../wavetables/banks";
import { getModuleDef, SCOPE_SLOTS } from "../modules/registry";
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
    | "misplaced"
    | "no-output"
    | "bad-knob"
    | "page-count"
    | "too-many-scopes"
    | "empty-sample"
    | "long-sample"
    | "two-recorders"
    | "not-a-wavetable"
    | "wavetable-as-sample"
    | "unknown-bank"
    | "no-recorder"
    | "missing-abstraction";
  message: string;
  module?: ModuleId;
}

export interface ResolvedModule {
  instance: ModuleInstance;
  def: ModuleDef;
  /** Where the module runs: in every voice (its tile is in the voice area), or once. */
  scope: Scope;
}

/**
 * An output whose cable crosses the edge of the voice area. Going out, it becomes an
 * `outlet~` of `voice.pd`, which `[clone]` adds up over the voices; coming in, an `inlet~`,
 * which `[clone]` gives every voice the same signal at.
 */
export interface Crossing {
  from: ModuleId;
  outlet: number;
}

/** A connection between two resolved modules, by Pd outlet/inlet index: a signal, or notes. */
export interface Wire {
  from: ModuleId;
  outlet: number;
  to: ModuleId;
  inlet: number;
  /** A note connection: messages, not a signal. */
  notes?: boolean;
}

/** An outlet or an inlet of a module, by Pd's number for it. */
export interface Plug {
  module: ModuleId;
  index: number;
}

/**
 * An input fed from the note instead of a cable: in a voice the voice's own pitch, gate
 * or velocity (`ge-voice`), outside the voices the keyboard's (`ge-keyboard`).
 */
export interface PrecordWire {
  signal: VoiceSignal;
  to: ModuleId;
  inlet: number;
}

/** An input with no cable that rests at a value other than 0 (`PortDef.unpatched`). */
export interface ConstantFeed {
  value: number;
  to: ModuleId;
  inlet: number;
}

/** A hardware knob on a page, resolved to the parameter it controls. */
export interface KnobBinding {
  module: ResolvedModule;
  param: ParamDef;
}

export interface ResolvedPage {
  /** The page's name, or "Page 3" for the third page when it has none. */
  name: string;
  /** One entry per hardware knob; `null` where the knob is unused. */
  knobs: (KnobBinding | null)[];
}

export interface Analysis {
  diagnostics: Diagnostic[];
  modules: ResolvedModule[];
  /** Cables and normalled connections. */
  wires: Wire[];
  /**
   * The note output the voices get their notes from (the voice area's Notes input), or
   * `null` for the keyboard's.
   */
  voiceNotes: Plug | null;
  /** The note inputs of modules with no cable, which get the keyboard's notes. */
  keyboardNotes: Plug[];
  /** The outputs whose cables leave the voice area, in the order of the wires. */
  outward: Crossing[];
  /** The outputs whose cables come into the voice area, in the order of the wires. */
  inward: Crossing[];
  precords: PrecordWire[];
  constants: ConstantFeed[];
  /**
   * The number of each module the editor draws the input of (`ModuleDef.tap`), from 1 in
   * the order of the document. 0 for those beyond what the editor can show.
   */
  taps: Map<ModuleId, number>;
  /**
   * The sample slots the modules use, in order, each with what the document has there
   * (`null` for an empty slot, which the patch gives a silent table).
   */
  samples: UsedSample[];
  /** The knob pages that are exported, in order: those with a knob in use. */
  pages: ResolvedPage[];
  /** How the voices play notes, and how many copies of the voice run (`[clone]`'s count). */
  voicing: Voicing;
  copies: number;
}

export interface UsedSample {
  slot: number;
  sample: SampleSlot | null;
  /**
   * The table `ge-sample-<slot>` that the sample modules read and write, when one of them
   * uses the slot: a sound file to load, or a tape of some seconds (none, where the slot
   * has nothing such a module can use).
   */
  table: { kind: "file"; path: string } | { kind: "tape"; seconds: number } | null;
  /**
   * The table `ge-wave-<slot>` that a Wavetable oscillator reads, when one uses the slot:
   * a wavetable of the editor's own, a sound file to be cut into cycles, or `silent`
   * where the slot has neither.
   */
  wave: { kind: "bank"; id: string } | { kind: "file"; path: string; cycle?: number } | "silent" | null;
}

/** Beyond this many seconds a position signal is too coarse to play a sample smoothly at other speeds. */
const LONG_SAMPLE_SECONDS = 20;

/** The values a module's abstraction gets as creation arguments after its id (`ParamDef.argument`). */
export function argumentValues({ instance, def }: Pick<ResolvedModule, "instance" | "def">): number[] {
  return def.params
    .filter((param) => param.argument)
    .map((param) => Math.min(param.max, Math.max(param.min, Math.round(instance.params[param.id] ?? param.default))));
}

/** What a module goes by in a message: its own name, or its type's. */
const called = ({ instance, def }: Pick<ResolvedModule, "instance" | "def">) => moduleName(instance, def);

/** Ids become Pd symbols and receiver prefixes, so keep them to a safe alphabet. */
const ID_PATTERN = /^ge[0-9a-z]+$/;

export function analyze(doc: PatchDocument): Analysis {
  const diagnostics: Diagnostic[] = [];
  const error = (code: Diagnostic["code"], message: string, module?: ModuleId) =>
    diagnostics.push({ severity: "error", code, message, module });

  const voicing = voicingOf(doc);
  if (!Number.isInteger(doc.voices) || doc.voices < MIN_VOICES || doc.voices > MAX_VOICES) {
    error("voice-count", `Voice count must be a whole number from ${MIN_VOICES} to ${MAX_VOICES}.`);
  } else if (
    !Number.isInteger(voicing.unison) ||
    voicing.unison < 1 ||
    !Number.isFinite(voicing.detune) ||
    !NOTE_PRIORITIES.includes(voicing.priority)
  ) {
    error("voice-count", "Unison must be a whole number from 1, and Detune a number of cents.");
  } else if (voiceCopies(doc) > MAX_VOICES) {
    error("voice-count", `A patch runs at most ${MAX_VOICES} voices: these settings take ${voiceCopies(doc)}.`);
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
      const where = placement(doc, instance);
      byId.set(instance.id, { instance, def, scope: where === "inside" ? "voice" : "global" });
      if (where === "across") {
        error("misplaced", `${moduleName(instance, def)} lies across the edge of the voice area: move it into the voices or out of them.`, instance.id);
      } else if (where === "inside" && def.place === "outside") {
        error("misplaced", `${moduleName(instance, def)} runs once for the whole patch: move it out of the voice area.`, instance.id);
      }
    }
  }

  const wires: Wire[] = [];
  const fed = new Set<string>();
  const inputKey = (module: ModuleId, inlet: number) => `${module}:${inlet}`;
  // The inlets of a module's inputs come after those it takes voice signals at.
  const firstInlet = (def: ModuleDef) => def.voiceInlets?.length ?? 0;
  const inletOf = (def: ModuleDef, port: string) => {
    const index = def.inputs.findIndex((p) => p.id === port);
    return index < 0 ? -1 : firstInlet(def) + index;
  };

  let voiceNotes: Plug | null = null;
  const missing = (cable: (typeof doc.cables)[number]) =>
    error(
      "bad-cable",
      `A cable refers to a missing module or port (${cable.from.module}.${cable.from.port} → ${cable.to.module}.${cable.to.port}).`,
    );
  for (const cable of doc.cables) {
    const from = byId.get(cable.from.module);
    const outlet = from?.def.outputs.findIndex((p) => p.id === cable.from.port) ?? -1;
    const notesOut = !!from && from.def.outputs[outlet]?.kind === "notes";
    // Into the voices' own Notes input.
    if (isVoiceNotes(cable.to)) {
      if (!from || outlet < 0) missing(cable);
      else if (!notesOut) error("bad-cable", `${called(from)} sends a signal, not notes, to the voices' Notes input.`, from.instance.id);
      else if (voiceNotes) error("input-in-use", "The voices' Notes input has more than one cable.");
      else voiceNotes = { module: from.instance.id, index: outlet };
      continue;
    }
    const to = byId.get(cable.to.module);
    const inlet = to ? inletOf(to.def, cable.to.port) : -1;
    if (!from || !to || outlet < 0 || inlet < 0) {
      missing(cable);
      continue;
    }
    const notesIn = to.def.inputs[inlet - firstInlet(to.def)].kind === "notes";
    if (notesIn !== notesOut) {
      error(
        "bad-cable",
        notesOut
          ? `${called(from)} sends notes to ${called(to)}'s ${to.def.inputs[inlet - firstInlet(to.def)].label}, which takes a signal.`
          : `${called(from)} sends a signal to ${called(to)}'s ${to.def.inputs[inlet - firstInlet(to.def)].label}, which takes notes.`,
        to.instance.id,
      );
      continue;
    }
    const key = inputKey(to.instance.id, inlet);
    if (fed.has(key)) {
      error(
        "input-in-use",
        `${called(to)} input "${to.def.inputs[inlet - firstInlet(to.def)].label}" has more than one cable.`,
        to.instance.id,
      );
      continue;
    }
    fed.add(key);
    wires.push({ from: from.instance.id, outlet, to: to.instance.id, inlet, ...(notesIn ? { notes: true } : {}) });
  }
  // A note input with no cable gets the keyboard's notes.
  const keyboardNotes: Plug[] = [];
  for (const { instance, def } of byId.values()) {
    def.inputs.forEach((port, index) => {
      const inlet = firstInlet(def) + index;
      if (port.kind === "notes" && !fed.has(inputKey(instance.id, inlet))) keyboardNotes.push({ module: instance.id, index: inlet });
    });
  }

  // Normalled inputs follow their partner's source when left unpatched.
  for (const { instance, def } of byId.values()) {
    for (const [fromPort, toPort] of def.normalled ?? []) {
      const fromInlet = inletOf(def, fromPort);
      const toInlet = inletOf(def, toPort);
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
    const names = [...inLoop].map((id) => called(byId.get(id)!)).join(" → ");
    error("feedback-loop", `These modules form a feedback loop, which is not supported yet: ${names}.`, [...inLoop][0]);
  }

  // Pd runs the voices as one object, [clone], so a path that leaves the voice area and
  // comes back into it is a loop to Pd, though no module feeds itself.
  if (inLoop.size === 0) {
    const scopeOf = (id: ModuleId) => byId.get(id)!.scope;
    const via = new Map<ModuleId, ModuleId | null>();
    const queue: ModuleId[] = [];
    for (const wire of wires) {
      if (wire.notes) continue;
      if (scopeOf(wire.from) === "voice" && scopeOf(wire.to) === "global" && !via.has(wire.to)) {
        via.set(wire.to, null);
        queue.push(wire.to);
      }
    }
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      const back = wires.find((w) => w.from === id && !w.notes && scopeOf(w.to) === "voice");
      if (back) {
        const path: ModuleId[] = [];
        for (let at: ModuleId | null = id; at; at = via.get(at) ?? null) path.unshift(at);
        const names = path.map((at) => called(byId.get(at)!)).join(" → ");
        error(
          "feedback-loop",
          `A path leaves the voice area and comes back into it, which is a feedback loop: the voices are added up before anything outside them runs (${names}).`,
          path[0],
        );
        break;
      }
      for (const next of wires.filter((w) => w.from === id && !w.notes).map((w) => w.to)) {
        if (scopeOf(next) === "global" && !via.has(next)) {
          via.set(next, id);
          queue.push(next);
        }
      }
    }
  }

  // Cables across the edge of the voice area: one crossing for each output, whatever it feeds.
  // Notes never cross it: only modules outside it have note ports.
  const outward: Crossing[] = [];
  const inward: Crossing[] = [];
  for (const wire of wires) {
    if (wire.notes) continue;
    const [from, to] = [byId.get(wire.from)!.scope, byId.get(wire.to)!.scope];
    if (from === to) continue;
    const crossings = from === "voice" ? outward : inward;
    if (!crossings.some((c) => c.from === wire.from && c.outlet === wire.outlet)) crossings.push({ from: wire.from, outlet: wire.outlet });
  }

  // Pre-cords follow the voice's note in the voice area, and the keyboard outside it.
  const precords: PrecordWire[] = [];
  for (const { instance, def } of byId.values()) {
    def.voiceInlets?.forEach((signal, inlet) => precords.push({ signal, to: instance.id, inlet }));
    def.inputs.forEach((port, index) => {
      const inlet = firstInlet(def) + index;
      const enabled = instance.precords?.[port.id] ?? true;
      if (port.precord && enabled && !fed.has(inputKey(instance.id, inlet))) {
        precords.push({ signal: port.precord, to: instance.id, inlet });
        // An input that follows the voice does not also rest at its `unpatched` value.
        fed.add(inputKey(instance.id, inlet));
      }
    });
  }

  const constants: ConstantFeed[] = [];
  for (const { instance, def } of byId.values()) {
    def.inputs.forEach((port, index) => {
      const inlet = firstInlet(def) + index;
      if (port.unpatched !== undefined && !fed.has(inputKey(instance.id, inlet))) {
        constants.push({ value: port.unpatched, to: instance.id, inlet });
      }
    });
  }

  // The samples the modules work on. An empty one is worth a word: the module is silent.
  const usedSlots = new Map<number, ResolvedModule[]>();
  for (const module of byId.values()) {
    const index = module.def.params.filter((p) => p.argument).findIndex((p) => p.id === SAMPLE_PARAM);
    if (index < 0) continue;
    const slot = argumentValues(module)[index];
    if (slot >= 0 && slot < SAMPLE_SLOTS) usedSlots.set(slot, [...(usedSlots.get(slot) ?? []), module]);
  }
  const samples: UsedSample[] = [...usedSlots.keys()].sort((a, b) => a - b).map((slot) => {
    const sample = doc.samples?.[slot] ?? null;
    const users = usedSlots.get(slot)!;
    // A Wavetable oscillator reads another table of the slot than the sample modules do.
    const scanners = users.filter((m) => m.def.sample === "wavetable");
    const players = users.filter((m) => m.def.sample !== "wavetable");
    const warn = (code: Diagnostic["code"], message: string, module: ResolvedModule) =>
      diagnostics.push({ severity: "warning", code, message, module: module.instance.id });

    let table: UsedSample["table"] = null;
    if (players.length > 0) {
      if (sample?.kind === "file") table = { kind: "file", path: sample.path };
      else if (sample?.kind === "tape") table = { kind: "tape", seconds: sample.seconds };
      else table = { kind: "tape", seconds: 0 };
      if (sample?.kind === "wavetable") {
        warn("wavetable-as-sample", `${called(players[0])} uses sample ${sampleLetter(slot)}, which is a wavetable: only a Wavetable oscillator plays one.`, players[0]);
      }
    }

    let wave: UsedSample["wave"] = null;
    if (scanners.length > 0) {
      wave = "silent";
      if (sample?.kind === "wavetable") {
        if (wavetableBank(sample.bank)) wave = { kind: "bank", id: sample.bank };
        else warn("unknown-bank", `Sample ${sampleLetter(slot)} is a wavetable this version of Gridelle does not have.`, scanners[0]);
      } else if (sample?.kind === "file") {
        wave = { kind: "file", path: sample.path, ...(sample.cycle ? { cycle: sample.cycle } : {}) };
      } else if (sample?.kind === "tape") {
        warn("not-a-wavetable", `${called(scanners[0])} uses sample ${sampleLetter(slot)}, which is a tape: it plays a wavetable or a sound file.`, scanners[0]);
      }
    }
    return { slot, sample, table, wave };
  });
  for (const { slot, sample, table } of samples) {
    const users = usedSlots.get(slot)!;
    // One module may record onto a sample: two would write over each other at every sample.
    const writers = users.filter((m) => m.def.sample === "writes");
    if (writers.length > 1) {
      error("two-recorders", `Two modules record onto sample ${sampleLetter(slot)}. A sample can have one.`, writers[1].instance.id);
    }
    const follower = users.find((m) => m.def.sample === "follows");
    if (follower && writers.length === 0) {
      diagnostics.push({
        severity: "warning",
        code: "no-recorder",
        message: `${called(follower)} plays behind the recording of sample ${sampleLetter(slot)}, which nothing records.`,
        module: follower.instance.id,
      });
    }
    if (!sample) {
      diagnostics.push({
        severity: "warning",
        code: "empty-sample",
        message: `${called(users[0])} uses sample ${sampleLetter(slot)}, which is empty.`,
        module: users[0].instance.id,
      });
    } else if (table?.kind === "file" && sample.kind === "file" && sample.sampleRate > 0 && sample.frames / sample.sampleRate > LONG_SAMPLE_SECONDS) {
      diagnostics.push({
        severity: "warning",
        code: "long-sample",
        message: `Sample ${sampleLetter(slot)} is longer than ${LONG_SAMPLE_SECONDS} seconds: it plays, but grows grainy at other speeds than its own.`,
      });
    }
  }

  const taps = new Map<ModuleId, number>();
  for (const { instance, def } of byId.values()) {
    if (def.tap) taps.set(instance.id, taps.size < SCOPE_SLOTS ? taps.size + 1 : 0);
  }
  if ([...taps.values()].includes(0)) {
    diagnostics.push({
      severity: "warning",
      code: "too-many-scopes",
      message: `Only the first ${SCOPE_SLOTS} Scopes are drawn; the others stay empty.`,
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
  const resolved: ResolvedPage[] = doc.pages.map((page, index) => ({
    name: page.name || defaultPageName(index),
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
          message: `Knob ${i + 1} on page “${page.name || defaultPageName(index)}” is assigned to something that no longer exists, so it is ignored.`,
        });
        return null;
      }
      assigned.add(key);
      return { module, param };
    }),
  }));
  // A page with no knob in use is not exported: the Organelle steps through those that have one.
  const pages = resolved.filter((page) => page.knobs.some(Boolean));

  return {
    diagnostics,
    modules: [...byId.values()],
    wires,
    voiceNotes,
    keyboardNotes,
    outward,
    inward,
    precords,
    constants,
    taps,
    samples,
    pages,
    voicing,
    copies: voiceCopies(doc),
  };
}
