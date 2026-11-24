import { sampleLetter, type ModuleId, type PatchDocument } from "../model/types";
import { KEYBOARD_ABSTRACTION, VOICE_ABSTRACTION } from "../modules/registry";
import type { VoiceSignal } from "../modules/types";
import { pdNumber, PdPatch, type Box, type Position } from "../pd/patch";
import { argumentValues, type Analysis, type ResolvedModule } from "./analyze";
import { emitKnobPages } from "./knobPages";

/** Outlet of `ge-voice` (and `ge-keyboard`) that carries each voice signal. */
const VOICE_OUTLET: Record<VoiceSignal, number> = { pitch: 0, gate: 1, velocity: 2 };

/** Pd canvas spacing per editor grid cell, so exported patches mirror the editor layout. */
const CELL = { x: 130, y: 45 };
const MARGIN = { x: 30, y: 30 };

export interface ParamValue {
  /** Pd receiver name, e.g. `ge3-cutoff`. */
  receiver: string;
  value: number;
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

/**
 * A box for each module: its abstraction with the module's id as argument. A module the
 * editor draws the input of also gets its scope number and `voice`, the number of the
 * voice it is in: `$1` inside a voice, which is what `[clone]` passes, -1 outside them.
 */
/** The helpers that hold a sample's table: one that loads a sound file, one that makes a tape. */
export const SAMPLE_FILE_ABSTRACTION = "ge-sample-file";
export const SAMPLE_TAPE_ABSTRACTION = "ge-sample-tape";
/** The name a slot's sound file has in the patch folder. */
export const sampleFileName = (slot: number) => `ge-sample-${sampleLetter(slot).toLowerCase()}.wav`;
/** The helper that loads a slot's wavetable, and the name that has in the patch folder. */
export const WAVE_FILE_ABSTRACTION = "ge-wave-file";
export const waveFileName = (slot: number) => `ge-wave-${sampleLetter(slot).toLowerCase()}.wav`;

/** Where `main.pd` sends the number of the voice that got the latest note, for the Scopes. */
const SCOPE_VOICE = "ge-scope-voice";

function addModules(patch: PdPatch, analysis: Analysis, modules: ResolvedModule[], top: number, voice: string): Map<ModuleId, Box> {
  const at = layout(modules, top);
  return new Map(
    modules.map((m) => {
      // After the id: the values that are built into the patch, then a tap's numbers.
      const built = argumentValues(m).map((value) => ` ${value}`).join("");
      const tap = m.def.tap ? ` ${analysis.taps.get(m.instance.id) ?? 0} ${voice}` : "";
      return [m.instance.id, patch.obj(`${m.def.pd} ${m.instance.id}${built}${tap}`, at(m))];
    }),
  );
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
 * One voice: the modules of the voice area, fed by `ge-voice`, with an `inlet~` for each
 * cable that comes into the area and an `outlet~` for each that leaves it.
 *
 * A voice is never muted. Its modules run all the time, as on a modular, and what
 * leaves it is what they make: an oscillator with no Amp behind it sounds for ever, on
 * C3 (the pitch 60, which an oscillator plays an octave down) until the voice gets its first
 * note (`ge-voice`) and on its last note after that.
 * Giving a note a beginning and an end is the patch's own business.
 */
export function emitVoice(analysis: Analysis): string {
  const modules = analysis.modules.filter((m) => m.scope === "voice");
  const patch = new PdPatch();

  // Pd numbers inlets by horizontal position: the note first, then the signals coming in.
  const inlet = patch.obj("inlet", { x: MARGIN.x, y: MARGIN.y });
  const voice = patch.obj(VOICE_ABSTRACTION, { x: MARGIN.x, y: MARGIN.y + 40 });
  patch.connect(inlet, 0, voice, 0);
  const comingIn = analysis.inward.map((_, i) => patch.obj("inlet~", { x: MARGIN.x + (i + 1) * CELL.x, y: MARGIN.y }));

  const top = MARGIN.y + 110;
  const boxes = addModules(patch, analysis, modules, top, "$1");

  for (const wire of analysis.wires) {
    const to = boxes.get(wire.to);
    if (!to) continue;
    const from = boxes.get(wire.from);
    if (from) patch.connect(from, wire.outlet, to, wire.inlet);
    else patch.connect(comingIn[analysis.inward.findIndex((c) => c.from === wire.from && c.outlet === wire.outlet)], 0, to, wire.inlet);
  }
  for (const precord of analysis.precords) {
    const to = boxes.get(precord.to);
    if (to) patch.connect(voice, VOICE_OUTLET[precord.signal], to, precord.inlet);
  }
  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: MARGIN.y + 40 });

  // Pd numbers outlets by horizontal position, so lay them out left to right in order.
  const below = bottom(modules, top) + 100;
  analysis.outward.forEach((crossing, i) => {
    const outlet = patch.obj("outlet~", { x: MARGIN.x + i * CELL.x, y: below });
    patch.connect(boxes.get(crossing.from)!, crossing.outlet, outlet, 0);
  });

  return patch.toString();
}

/** Current value of every parameter of every module, clamped to its range. */
export function paramValues(analysis: Analysis): ParamValue[] {
  return analysis.modules.flatMap(({ instance, def }) =>
    // A value that is built into the patch has no receiver to send to.
    def.params.filter((param) => !param.argument).map((param) => ({
      receiver: `${instance.id}-${param.id}`,
      value: Math.min(param.max, Math.max(param.min, instance.params[param.id] ?? param.default)),
    })),
  );
}

/**
 * The patch the Organelle opens: note handling and voice allocation, the modules outside
 * the voice area, which run once, and the parameter values.
 */
export function emitMain(doc: PatchDocument, analysis: Analysis): string {
  const modules = analysis.modules.filter((m) => m.scope === "global");
  const patch = new PdPatch();
  const column = (row: number): Position => ({ x: MARGIN.x, y: MARGIN.y + row * 35 });

  // Keys and MIDI arrive as "pitch velocity"; [poly] picks a voice, [clone] hosts them. The
  // voices get the keyboard's notes, or a note module's (an arpeggiator's).
  const notes = patch.obj("r notes", column(0));
  const unpack = patch.obj("unpack f f", column(1));
  const poly = patch.obj(`poly ${doc.voices} 1`, column(2));
  // [poly] numbers voices from 1, [clone] from 0.
  const zeroBased = patch.obj("- 1", column(3));
  const pack = patch.obj("pack f f f", column(4));
  const clone = patch.obj(`clone voice ${doc.voices}`, column(5));
  patch.connect(unpack, 0, poly, 0);
  patch.connect(unpack, 1, poly, 1);
  patch.connect(poly, 0, zeroBased, 0);
  patch.connect(zeroBased, 0, pack, 0);
  patch.connect(poly, 1, pack, 1);
  patch.connect(poly, 2, pack, 2);
  patch.connect(pack, 0, clone, 0);

  // A Scope inside the voices shows the voice of the latest note: tell them which that is.
  // [poly] sends the velocity before the voice, so the gate is set when the number comes.
  if (analysis.modules.some((m) => m.def.tap && m.scope === "voice")) {
    const beside = (row: number): Position => ({ x: MARGIN.x + CELL.x, y: column(row).y });
    const noteOn = patch.obj("spigot", beside(4));
    const latest = patch.obj(`s ${SCOPE_VOICE}`, beside(5));
    patch.connect(zeroBased, 0, noteOn, 0);
    patch.connect(poly, 2, noteOn, 1);
    patch.connect(noteOn, 0, latest, 0);
  }

  const top = column(7).y;
  const boxes = addModules(patch, analysis, modules, top, "-1");
  const crossing = (list: Analysis["inward"], wire: Analysis["wires"][number]) =>
    list.findIndex((c) => c.from === wire.from && c.outlet === wire.outlet);

  for (const wire of analysis.wires) {
    const [from, to] = [boxes.get(wire.from), boxes.get(wire.to)];
    if (from && to) {
      patch.connect(from, wire.outlet, to, wire.inlet);
    } else if (to) {
      // The source lives in the voices: take the summed signal from [clone].
      patch.connect(clone, crossing(analysis.outward, wire), to, wire.inlet);
    } else if (from) {
      // Into the voices: [clone] gives every voice the same signal. Its inlet 0 is the note.
      patch.connect(from, wire.outlet, clone, 1 + crossing(analysis.inward, wire));
    }
  }

  // The notes the voices are given, and those of note inputs with no cable: the keyboard's.
  if (analysis.voiceNotes) patch.connect(boxes.get(analysis.voiceNotes.module)!, analysis.voiceNotes.index, unpack, 0);
  else patch.connect(notes, 0, unpack, 0);
  for (const plug of analysis.keyboardNotes) patch.connect(notes, 0, boxes.get(plug.module)!, plug.index);

  // Outside the voices, an input that follows the note follows the keyboard.
  const keyboardFed = analysis.precords.filter((precord) => boxes.has(precord.to));
  if (keyboardFed.length > 0) {
    const keyboard = patch.obj(KEYBOARD_ABSTRACTION, { x: MARGIN.x + CELL.x, y: column(6).y });
    for (const precord of keyboardFed) patch.connect(keyboard, VOICE_OUTLET[precord.signal], boxes.get(precord.to)!, precord.inlet);
  }

  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: column(5).y });

  // The samples the modules work on: a table each, loaded or sized when the patch starts.
  // A Wavetable oscillator reads a table of its own kind, which the editor builds; where
  // the slot has none to give, a bare table keeps Pd from asking for one.
  let row = 0;
  const below = () => ({ x: MARGIN.x + 6 * CELL.x, y: MARGIN.y + row++ * 35 });
  for (const { slot, table, wave } of analysis.samples) {
    if (table?.kind === "file") patch.obj(`${SAMPLE_FILE_ABSTRACTION} ${slot} ${sampleFileName(slot)}`, below());
    else if (table) patch.obj(`${SAMPLE_TAPE_ABSTRACTION} ${slot} ${pdNumber(table.seconds)}`, below());
    if (wave === "silent") patch.obj(`table ge-wave-${slot} 64`, below());
    else if (wave) patch.obj(`${WAVE_FILE_ABSTRACTION} ${slot} ${waveFileName(slot)}`, below());
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
