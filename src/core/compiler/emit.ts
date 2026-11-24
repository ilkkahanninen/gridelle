import { MAIN, VOICE, type ContainerKey } from "../model/area";
import { NOTE_PRIORITIES, sampleLetter, type ModuleId, type PatchDocument } from "../model/types";
import { KEYBOARD_ABSTRACTION, MONO_ABSTRACTION, PLACE_ABSTRACTION, VOICE_ABSTRACTION } from "../modules/registry";
import { pdNumber, PdPatch, type Box, type Position } from "../pd/patch";
import {
  argumentValues,
  containerChain,
  VOICE_OUTLET,
  VOICE_SOURCE,
  type Analysis,
  type Crossing,
  type ResolvedGroup,
} from "./analyze";
import { emitKnobPages } from "./knobPages";

/** The file a unison group's copies are made from, without `.pd`: `[clone]` names it so. */
export const groupFile = (id: ModuleId) => `ge-unison-${id}`;

/** Pd canvas spacing per editor grid cell, so exported patches mirror the editor layout. */
const CELL = { x: 130, y: 45 };
const MARGIN = { x: 30, y: 30 };

export interface ParamValue {
  /** Pd receiver name, e.g. `ge3-cutoff`. */
  receiver: string;
  value: number;
}

/** Place a box where its tile (or a group's area) sits, relative to the top-left one of its container. */
function layout(cells: { x: number; y: number }[], top: number): (cell: { x: number; y: number }) => Position {
  const minX = Math.min(...cells.map((c) => c.x));
  const minY = Math.min(...cells.map((c) => c.y));
  return (c) => ({
    x: MARGIN.x + (c.x - minX) * CELL.x,
    y: top + (c.y - minY) * CELL.y,
  });
}

function bottom(cells: { y: number }[], top: number): number {
  if (cells.length === 0) return top;
  const ys = cells.map((c) => c.y);
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

/**
 * What a container's file holds, for its cables to be wired to: its own modules, the
 * `[clone]`s of the containers in it, an `inlet~` for each crossing coming in, the source of
 * the voice's signals (`ge-voice` in a voice, `ge-keyboard` outside the voices) and a unison
 * group's copy's place (`ge-unison-place`).
 */
interface Contents {
  key: ContainerKey;
  patch: PdPatch;
  boxes: Map<ModuleId, Box>;
  clones: Map<ContainerKey, Box>;
  inlets: Box[];
  voiceSource: Box | null;
  place: Box | null;
}

/** The first inlet of a container's `[clone]` that takes a signal: the voices' takes the notes first. */
const firstSignalInlet = (key: ContainerKey) => (key === VOICE ? 1 : 0);

/**
 * A box for each module of the container, where its tile sits, and a `[clone]` for each
 * unison group in it, where the group sits. `voice` is the number of the voice: `$1` in a
 * voice, `$2` in a group's copy, -1 outside the voices.
 */
function addModules(
  patch: PdPatch,
  analysis: Analysis,
  key: ContainerKey,
  top: number,
  voice: string,
): { boxes: Map<ModuleId, Box>; clones: Map<ContainerKey, Box>; cells: { x: number; y: number }[] } {
  const modules = analysis.modules.filter((m) => m.container === key);
  const groups = analysis.groups.filter((g) => g.parent === key);
  const cells = [...modules.map((m) => m.instance), ...groups.map((g) => g.group.area)];
  const at = layout(cells, top);
  const boxes = new Map(
    modules.map((m) => {
      // After the id: the values that are built into the patch, then a tap's numbers.
      const built = argumentValues(m).map((value) => ` ${value}`).join("");
      const tap = m.def.tap ? ` ${analysis.taps.get(m.instance.id) ?? 0} ${voice}` : "";
      return [m.instance.id, patch.obj(`${m.def.pd} ${m.instance.id}${built}${tap}`, at(m.instance))];
    }),
  );
  // A group's copies get their number first ($1, from [clone]) and the voice after it ($2).
  const clones = new Map(
    groups.map((g) => [g.group.id, patch.obj(`clone ${groupFile(g.group.id)} ${g.group.size} ${voice}`, at(g.group.area))]),
  );
  return { boxes, clones, cells };
}

const crossingIndex = (list: Crossing[], from: string, outlet: number) => list.findIndex((c) => c.from === from && c.outlet === outlet);

/**
 * How a container's cables are wired, in its own file. A cable is wired in the innermost
 * container that holds both its ends, from the source (a module, the `[clone]` of a
 * container it is in, or the `inlet~` it comes in at) to the input (a module, or the
 * `[clone]` of the container it is in); each container on the way passes it on at its edge.
 * Pd would add up a connection made twice, so each is made once.
 */
function wiring(analysis: Analysis, c: Contents) {
  const byId = new Map(analysis.modules.map((m) => [m.instance.id, m]));
  const owner = (id: ModuleId) => byId.get(id)!.container;
  const crossings = (key: ContainerKey): Pick<Analysis, "inward" | "outward"> =>
    key === VOICE ? analysis : analysis.groups.find((g) => g.group.id === key)!;
  // The container in this one that `key` is in, or is; `null` for this one, or one outside it.
  const childToward = (key: ContainerKey) => {
    const chain = containerChain(analysis.groups, key);
    const at = chain.indexOf(c.key);
    return at > 0 ? chain[at - 1] : null;
  };
  const holds = (key: ContainerKey) => containerChain(analysis.groups, key).includes(c.key);
  const source = (from: string, outlet: number): [Box, number] => {
    if (from === VOICE_SOURCE && c.voiceSource) return [c.voiceSource, outlet];
    if (from !== VOICE_SOURCE) {
      const at = owner(from);
      if (at === c.key) return [c.boxes.get(from)!, outlet];
      const child = childToward(at);
      if (child) return [c.clones.get(child)!, crossingIndex(crossings(child).outward, from, outlet)];
    }
    return [c.inlets[crossingIndex(crossings(c.key).inward, from, outlet)], 0];
  };
  const made = new Set<string>();
  const connect = ([from, outlet]: [Box, number], to: Box, inlet: number) => {
    const key = `${from.index} ${outlet} ${to.index} ${inlet}`;
    if (made.has(key)) return;
    made.add(key);
    c.patch.connect(from, outlet, to, inlet);
  };
  /** Wire `from` to an input in this container, or to the edge of the container in it that holds the input. */
  const feed = (from: string, outlet: number, to: ModuleId, inlet: number) => {
    const at = owner(to);
    if (!holds(at)) return;
    const child = childToward(at);
    if (!child) return connect(source(from, outlet), c.boxes.get(to)!, inlet);
    // Both ends in the same container in this one: it is wired there.
    if (from !== VOICE_SOURCE && childToward(owner(from)) === child) return;
    const index = crossingIndex(crossings(child).inward, from, outlet);
    if (index >= 0) connect(source(from, outlet), c.clones.get(child)!, firstSignalInlet(child) + index);
  };
  return {
    cables() {
      for (const wire of analysis.wires) feed(wire.from, wire.outlet, wire.to, wire.inlet);
    },
    /**
     * The inputs that follow the note: from the voice's signals here, or passed into a
     * group at its edge. The voices have their own, from `ge-voice`. A Unison Index gets
     * its copy's place in a group, and nothing (0) elsewhere.
     */
    precords() {
      for (const precord of analysis.precords) {
        const at = owner(precord.to);
        if (precord.signal === "unison") {
          if (at === c.key && c.place) connect([c.place, 0], c.boxes.get(precord.to)!, precord.inlet);
          continue;
        }
        if (childToward(at) === VOICE) continue;
        feed(VOICE_SOURCE, VOICE_OUTLET[precord.signal], precord.to, precord.inlet);
      }
    },
    /** What leaves the container: each crossing going out to its `outlet~`. */
    outlets(outlets: Box[]) {
      crossings(c.key).outward.forEach((crossing, i) => connect(source(crossing.from, crossing.outlet), outlets[i], 0));
    },
  };
}

/** The `outlet~`s of a container, in the order of its crossings going out: Pd numbers them by position. */
const addOutlets = (patch: PdPatch, count: number, y: number) =>
  Array.from({ length: count }, (_, i) => patch.obj("outlet~", { x: MARGIN.x + i * CELL.x, y }));

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
  const patch = new PdPatch();

  // Pd numbers inlets by horizontal position: the note first, then the signals coming in.
  const inlet = patch.obj("inlet", { x: MARGIN.x, y: MARGIN.y });
  const voice = patch.obj(VOICE_ABSTRACTION, { x: MARGIN.x, y: MARGIN.y + 40 });
  patch.connect(inlet, 0, voice, 0);
  const inlets = analysis.inward.map((_, i) => patch.obj("inlet~", { x: MARGIN.x + (i + 1) * CELL.x, y: MARGIN.y }));

  const top = MARGIN.y + 110;
  const { boxes, clones, cells } = addModules(patch, analysis, VOICE, top, "$1");
  const wire = wiring(analysis, { key: VOICE, patch, boxes, clones, inlets, voiceSource: voice, place: null });
  wire.cables();
  wire.precords();
  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: MARGIN.y + 40 });
  wire.outlets(addOutlets(patch, analysis.outward.length, bottom(cells, top) + 100));

  return patch.toString();
}

/**
 * One copy of a unison group: its modules, with an `inlet~` for each crossing that comes
 * into the group (including the voice's signals its pre-cords follow) and an `outlet~` for
 * each that leaves it. `$1` is the copy's number and `$2` the voice's.
 */
export function emitGroup(analysis: Analysis, group: ResolvedGroup): string {
  const patch = new PdPatch();
  const key = group.group.id;
  const inlets = group.inward.map((_, i) => patch.obj("inlet~", { x: MARGIN.x + i * CELL.x, y: MARGIN.y }));
  const placed = analysis.modules.some((m) => m.container === key && m.def.voiceInlets?.includes("unison"));
  const place = placed
    ? patch.obj(`${PLACE_ABSTRACTION} $1 ${group.group.size}`, { x: MARGIN.x + inlets.length * CELL.x, y: MARGIN.y + 40 })
    : null;

  const top = MARGIN.y + 110;
  const { boxes, clones, cells } = addModules(patch, analysis, key, top, "$2");
  const wire = wiring(analysis, { key, patch, boxes, clones, inlets, voiceSource: null, place });
  wire.cables();
  wire.precords();
  addConstants(patch, analysis, boxes, { x: MARGIN.x + 2 * CELL.x, y: MARGIN.y + 40 });
  wire.outlets(addOutlets(patch, group.outward.length, bottom(cells, top) + 100));

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
  const patch = new PdPatch();
  const column = (row: number): Position => ({ x: MARGIN.x, y: MARGIN.y + row * 35 });

  // Keys and MIDI arrive as "pitch velocity". The voices get the keyboard's notes, or a note
  // module's (an arpeggiator's). In poly mode [poly] picks the voice, in mono [ge-mono]
  // picks the one note from the held keys, and [clone] hosts the voices. A voice takes
  // "pitch velocity legato".
  const { mode, priority, legato } = analysis.voicing;
  const notes = patch.obj("r notes", column(0));
  let entry: Box;
  let last: Box;
  let poly: Box | null = null;
  let zeroBased: Box | null = null;
  if (mode === "mono") {
    entry = patch.obj(`${MONO_ABSTRACTION} ${NOTE_PRIORITIES.indexOf(priority)} ${legato ? 1 : 0}`, column(1));
    // One note, on the one voice.
    last = patch.obj("list prepend 0", column(2));
    patch.connect(entry, 0, last, 0);
  } else {
    entry = patch.obj("unpack f f", column(1));
    poly = patch.obj(`poly ${doc.voices} 1`, column(2));
    // [poly] numbers voices from 1, [clone] from 0.
    zeroBased = patch.obj("- 1", column(3));
    last = patch.obj("pack f f f", column(4));
    patch.connect(entry, 0, poly, 0);
    patch.connect(entry, 1, poly, 1);
    patch.connect(poly, 0, zeroBased, 0);
    patch.connect(zeroBased, 0, last, 0);
    patch.connect(poly, 1, last, 1);
    patch.connect(poly, 2, last, 2);
  }
  const clone = patch.obj(`clone voice ${analysis.copies}`, column(mode === "mono" ? 3 : 5));
  patch.connect(last, 0, clone, 0);

  // A Scope inside the voices shows the voice of the latest note: tell them which that is.
  // [poly] sends the velocity before the voice, so the gate is set when the number comes.
  // In mono that is always voice 0, where the Scopes start.
  if (poly !== null && zeroBased !== null && analysis.modules.some((m) => m.def.tap && m.scope === "voice")) {
    const beside = (row: number): Position => ({ x: MARGIN.x + CELL.x, y: column(row).y });
    const noteOn = patch.obj("spigot", beside(4));
    const latest = patch.obj(`s ${SCOPE_VOICE}`, beside(5));
    patch.connect(zeroBased, 0, noteOn, 0);
    patch.connect(poly, 2, noteOn, 1);
    patch.connect(noteOn, 0, latest, 0);
  }

  const top = column(7).y;
  const { boxes, clones, cells } = addModules(patch, analysis, MAIN, top, "-1");
  clones.set(VOICE, clone);
  const contents: Contents = { key: MAIN, patch, boxes, clones, inlets: [], voiceSource: null, place: null };
  const wire = wiring(analysis, contents);
  wire.cables();

  // The notes the voices are given, and those of note inputs with no cable: the keyboard's.
  if (analysis.voiceNotes) patch.connect(boxes.get(analysis.voiceNotes.module)!, analysis.voiceNotes.index, entry, 0);
  else patch.connect(notes, 0, entry, 0);
  for (const plug of analysis.keyboardNotes) patch.connect(notes, 0, boxes.get(plug.module)!, plug.index);

  // Outside the voices, an input that follows the note follows the keyboard.
  if (analysis.keyboard) {
    contents.voiceSource = patch.obj(KEYBOARD_ABSTRACTION, { x: MARGIN.x + CELL.x, y: column(6).y });
    wire.precords();
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

  emitKnobPages(patch, analysis, { x: MARGIN.x, y: bottom(cells, top) + 80 });

  return patch.toString();
}
