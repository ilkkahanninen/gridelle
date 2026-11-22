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

/**
 * Feed the inputs that rest at a value other than 0 while they have no cable: one
 * `[sig~ value]` for each value, placed in a row from `at`.
 */
function addConstants(patch: PdPatch, analysis: Analysis, boxes: Map<ModuleId, Box>, at: Position): void {
  const sources = new Map<number, Box>();
  for (const constant of analysis.constants) {
    const to = boxes.get(constant.to);
    if (!to) continue;
    let source = sources.get(constant.value);
    if (!source) {
      source = patch.obj(`sig~ ${pdNumber(constant.value)}`, { x: at.x + sources.size * 90, y: at.y });
      sources.set(constant.value, source);
    }
    patch.connect(source, 0, to, constant.inlet);
  }
}

/**
 * A switch with a fade: 1 while `source` is above 0.001, else 0. Two low-passes turn the
 * switch into a fade, and the higher of them is used: the quick one on the way up, so that
 * a note's attack is not softened (under a millisecond), the slow one on the way down, so
 * that a sound cut off in mid-wave does not click (about 5 ms).
 */
function addFade(patch: PdPatch, source: [box: Box, outlet: number], at: Position): Box {
  const scaled = patch.obj("*~ 1000", at);
  const open = patch.obj("clip~ 0 1", { x: at.x, y: at.y + 30 });
  const quick = patch.obj("lop~ 600", { x: at.x, y: at.y + 60 });
  const slow = patch.obj("lop~ 200", { x: at.x + 70, y: at.y + 60 });
  const fade = patch.obj("max~", { x: at.x, y: at.y + 90 });
  patch.connect(source[0], source[1], scaled, 0);
  patch.connect(scaled, 0, open, 0);
  patch.connect(open, 0, quick, 0);
  patch.connect(open, 0, slow, 0);
  patch.connect(quick, 0, fade, 0);
  patch.connect(slow, 0, fade, 1);
  return fade;
}

/** The highest of some signals, as a chain of `[max~]`. */
function addHighest(patch: PdPatch, signals: [box: Box, outlet: number][], at: Position): [box: Box, outlet: number] {
  return signals.slice(1).reduce((highest, signal, i) => {
    const either = patch.obj("max~", { x: at.x + i * 60, y: at.y });
    patch.connect(highest[0], highest[1], either, 0);
    patch.connect(signal[0], signal[1], either, 1);
    return [either, 0] as [Box, number];
  }, signals[0]);
}

/**
 * The life of a voice, as two signals that are 1 or 0 with a short fade between.
 *
 * - `playing`: the key is held, or one of the voice's envelopes (`holdsVoice`) has not
 *   finished. "Not finished" is above 0.001: the last 60 dB down of a release are faded out.
 * - `heard`: playing, or a module with a tail (a delay, a reverb) is still ringing: the
 *   level of its first output, rectified and smoothed, is above 0.001.
 *
 * What leaves the voice is multiplied by one of them (see `emitVoice`). Without this an
 * oscillator with no Amp behind it would sound for ever, and before its first note at
 * pitch 0, which is 8 Hz.
 */
function addVoiceLife(patch: PdPatch, voice: Box, modules: ResolvedModule[], boxes: Map<ModuleId, Box>, at: Position) {
  const output = (m: ResolvedModule): [Box, number] => [boxes.get(m.instance.id)!, 0];
  const holders = modules.filter((m) => m.def.holdsVoice && m.def.outputs.length > 0);
  const playing = addFade(patch, addHighest(patch, [[voice, VOICE_OUTLET.gate], ...holders.map(output)], at), { x: at.x, y: at.y + 30 });

  const ringers = modules.filter((m) => m.def.tail && m.def.outputs.length > 0);
  if (ringers.length === 0) return { playing, heard: playing };
  const right = { x: at.x + 200, y: at.y };
  const levels = ringers.map((m, i): [Box, number] => {
    const size = patch.obj("abs~", { x: right.x + i * 60, y: right.y - 60 });
    const level = patch.obj("lop~ 20", { x: right.x + i * 60, y: right.y - 30 });
    patch.connect(...output(m), size, 0);
    patch.connect(size, 0, level, 0);
    return [level, 0];
  });
  const ringing = addFade(patch, addHighest(patch, levels, right), { x: right.x, y: right.y + 30 });
  const heard = patch.obj("max~", { x: at.x + 100, y: at.y + 150 });
  patch.connect(playing, 0, heard, 0);
  patch.connect(ringing, 0, heard, 1);
  return { playing, heard };
}

/**
 * One voice: the per-voice modules, fed by `ge-voice`, with an `outlet~` per crossing.
 *
 * A voice that is not playing must not be heard (`addVoiceLife`), so each crossing is
 * multiplied by `playing`. Modules with a tail complicate that: their echoes should ring
 * on after the key is up, but an oscillator that never stops must not go on feeding them.
 * So the modules with a tail and everything after them in the voice form the ringing part:
 * audio entering it from the rest of the voice is multiplied by `playing`, and what leaves
 * the voice from it by `heard`.
 */
export function emitVoice(analysis: Analysis): string {
  const modules = analysis.modules.filter((m) => m.scope === "voice");
  const patch = new PdPatch();

  const inlet = patch.obj("inlet", { x: MARGIN.x, y: MARGIN.y });
  const voice = patch.obj(VOICE_ABSTRACTION, { x: MARGIN.x, y: MARGIN.y + 40 });
  patch.connect(inlet, 0, voice, 0);

  const top = MARGIN.y + 110;
  const boxes = addModules(patch, modules, top);
  const inside = analysis.wires.filter((wire) => boxes.has(wire.from) && boxes.has(wire.to));
  const leaving = crossings(analysis);

  // The ringing part: modules with a tail, and whatever they feed.
  const ringing = new Set(modules.filter((m) => m.def.tail).map((m) => m.instance.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const wire of inside) {
      if (ringing.has(wire.from) && !ringing.has(wire.to)) {
        ringing.add(wire.to);
        grew = true;
      }
    }
  }
  const carriesAudio = (id: ModuleId, outlet: number) =>
    modules.find((m) => m.instance.id === id)?.def.outputs[outlet]?.hint === "audio";

  const lifeY = bottom(modules, top) + 100;
  const life =
    leaving.length > 0 || ringing.size > 0
      ? addVoiceLife(patch, voice, modules, boxes, { x: MARGIN.x + (leaving.length + 1) * CELL.x, y: lifeY })
      : null;

  // One multiplier for each output that feeds the ringing part from outside it.
  const gated = new Map<string, Box>();
  const whilePlaying = (from: ModuleId, outlet: number): [Box, number] => {
    const key = `${from}:${outlet}`;
    let gate = gated.get(key);
    if (!gate) {
      gate = patch.obj("*~", { x: MARGIN.x + (leaving.length + 4 + gated.size) * CELL.x, y: lifeY });
      patch.connect(boxes.get(from)!, outlet, gate, 0);
      patch.connect(life!.playing, 0, gate, 1);
      gated.set(key, gate);
    }
    return [gate, 0];
  };

  for (const wire of inside) {
    const entersRinging = ringing.has(wire.to) && !ringing.has(wire.from) && carriesAudio(wire.from, wire.outlet);
    const [source, outlet] = entersRinging ? whilePlaying(wire.from, wire.outlet) : [boxes.get(wire.from)!, wire.outlet];
    patch.connect(source, outlet, boxes.get(wire.to)!, wire.inlet);
  }
  for (const precord of analysis.precords) {
    patch.connect(voice, VOICE_OUTLET[precord.signal], boxes.get(precord.to)!, precord.inlet);
  }
  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: MARGIN.y + 40 });

  // Pd numbers outlets by horizontal position, so lay them out left to right in order.
  leaving.forEach((crossing, i) => {
    const x = MARGIN.x + i * CELL.x;
    const audible = patch.obj("*~", { x, y: lifeY + 190 });
    const outlet = patch.obj("outlet~", { x, y: lifeY + 230 });
    patch.connect(boxes.get(crossing.from)!, crossing.outlet, audible, 0);
    patch.connect(ringing.has(crossing.from) ? life!.heard : life!.playing, 0, audible, 1);
    patch.connect(audible, 0, outlet, 0);
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

  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: column(5).y });

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
