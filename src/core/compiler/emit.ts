import type { ModuleId, PatchDocument } from "../model/types";
import { VOICE_ABSTRACTION } from "../modules/registry";
import type { VoiceSignal } from "../modules/types";
import { pdNumber, PdPatch, type Box, type Position } from "../pd/patch";
import type { Analysis, ResolvedModule } from "./analyze";
import { emitKnobPages } from "./knobPages";

/** Outlet of `ge-voice` that carries each voice signal. */
const VOICE_OUTLET: Record<VoiceSignal, number> = { pitch: 0, gate: 1, velocity: 2 };

/** Pd canvas spacing per editor grid cell, so exported patches mirror the editor layout. */
const CELL = { x: 130, y: 45 };
const MARGIN = { x: 30, y: 30 };

export interface ParamValue {
  /** Pd receiver name, e.g. `ge3-cutoff`. */
  receiver: string;
  value: number;
}

/** A voice output that feeds the global section; it becomes an `outlet~` of `voice.pd`. */
interface Crossing {
  from: ModuleId;
  outlet: number;
}

function crossings(analysis: Analysis): Crossing[] {
  const scope = new Map(analysis.modules.map((m) => [m.instance.id, m.scope]));
  const found: Crossing[] = [];
  for (const wire of analysis.wires) {
    if (scope.get(wire.from) !== "voice" || scope.get(wire.to) !== "global") continue;
    if (!found.some((c) => c.from === wire.from && c.outlet === wire.outlet)) {
      found.push({ from: wire.from, outlet: wire.outlet });
    }
  }
  return found;
}

/** Place a module's box where its tile sits, relative to the top-left tile of its section. */
function layout(modules: ResolvedModule[], top: number): (module: ResolvedModule) => Position {
  const minX = Math.min(...modules.map((m) => m.instance.x));
  const minY = Math.min(...modules.map((m) => m.instance.y));
  return (m) => ({
    x: MARGIN.x + (m.instance.x - minX) * CELL.x,
    y: top + (m.instance.y - minY) * CELL.y,
  });
}

function bottom(modules: ResolvedModule[], top: number): number {
  if (modules.length === 0) return top;
  const ys = modules.map((m) => m.instance.y);
  return top + (Math.max(...ys) - Math.min(...ys) + 1) * CELL.y;
}

function addModules(patch: PdPatch, modules: ResolvedModule[], top: number): Map<ModuleId, Box> {
  const at = layout(modules, top);
  return new Map(modules.map((m) => [m.instance.id, patch.obj(`${m.def.pd} ${m.instance.id}`, at(m))]));
}

/** One voice: the per-voice modules, fed by `ge-voice`, with an `outlet~` per crossing. */
export function emitVoice(analysis: Analysis): string {
  const modules = analysis.modules.filter((m) => m.scope === "voice");
  const patch = new PdPatch();

  const inlet = patch.obj("inlet", { x: MARGIN.x, y: MARGIN.y });
  const voice = patch.obj(VOICE_ABSTRACTION, { x: MARGIN.x, y: MARGIN.y + 40 });
  patch.connect(inlet, 0, voice, 0);

  const top = MARGIN.y + 110;
  const boxes = addModules(patch, modules, top);

  for (const wire of analysis.wires) {
    const from = boxes.get(wire.from);
    const to = boxes.get(wire.to);
    if (from && to) patch.connect(from, wire.outlet, to, wire.inlet);
  }
  for (const precord of analysis.precords) {
    patch.connect(voice, VOICE_OUTLET[precord.signal], boxes.get(precord.to)!, precord.inlet);
  }

  // Pd numbers outlets by horizontal position, so lay them out left to right in order.
  const outletY = bottom(modules, top) + 40;
  crossings(analysis).forEach((crossing, i) => {
    const outlet = patch.obj("outlet~", { x: MARGIN.x + i * CELL.x, y: outletY });
    patch.connect(boxes.get(crossing.from)!, crossing.outlet, outlet, 0);
  });

  return patch.toString();
}

/** Current value of every parameter of every module, clamped to its range. */
export function paramValues(analysis: Analysis): ParamValue[] {
  return analysis.modules.flatMap(({ instance, def }) =>
    def.params.map((param) => ({
      receiver: `${instance.id}-${param.id}`,
      value: Math.min(param.max, Math.max(param.min, instance.params[param.id] ?? param.default)),
    })),
  );
}

/**
 * The patch the Organelle opens: note handling and voice allocation, the modules
 * that run once after the voices are summed, and the parameter values.
 */
export function emitMain(doc: PatchDocument, analysis: Analysis): string {
  const modules = analysis.modules.filter((m) => m.scope === "global");
  const patch = new PdPatch();
  const column = (row: number): Position => ({ x: MARGIN.x, y: MARGIN.y + row * 35 });

  // Keys and MIDI arrive as "pitch velocity"; [poly] picks a voice, [clone] hosts them.
  const notes = patch.obj("r notes", column(0));
  const unpack = patch.obj("unpack f f", column(1));
  const poly = patch.obj(`poly ${doc.voices} 1`, column(2));
  // [poly] numbers voices from 1, [clone] from 0.
  const zeroBased = patch.obj("- 1", column(3));
  const pack = patch.obj("pack f f f", column(4));
  const clone = patch.obj(`clone voice ${doc.voices}`, column(5));
  patch.connect(notes, 0, unpack, 0);
  patch.connect(unpack, 0, poly, 0);
  patch.connect(unpack, 1, poly, 1);
  patch.connect(poly, 0, zeroBased, 0);
  patch.connect(zeroBased, 0, pack, 0);
  patch.connect(poly, 1, pack, 1);
  patch.connect(poly, 2, pack, 2);
  patch.connect(pack, 0, clone, 0);

  const top = column(7).y;
  const boxes = addModules(patch, modules, top);
  const voiceOutlets = crossings(analysis);

  for (const wire of analysis.wires) {
    const to = boxes.get(wire.to);
    if (!to) continue;
    const from = boxes.get(wire.from);
    if (from) {
      patch.connect(from, wire.outlet, to, wire.inlet);
    } else {
      // The source lives in the voices: take the summed signal from [clone].
      const outlet = voiceOutlets.findIndex((c) => c.from === wire.from && c.outlet === wire.outlet);
      patch.connect(clone, outlet, to, wire.inlet);
    }
  }

  const params = paramValues(analysis);
  if (params.length > 0) {
    const right = { x: MARGIN.x + 4 * CELL.x };
    const loadbang = patch.obj("loadbang", { ...right, y: MARGIN.y });
    const values = patch.msg(
      params.map((p) => `; ${p.receiver} ${pdNumber(p.value)}`).join(" "),
      { ...right, y: MARGIN.y + 35 },
    );
    patch.connect(loadbang, 0, values, 0);
  }

  emitKnobPages(patch, analysis, { x: MARGIN.x, y: bottom(modules, top) + 80 });

  return patch.toString();
}
