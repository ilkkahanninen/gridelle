import { create } from "zustand";
import * as files from "../bridge/files";
import type { SoundInfo, WavetableInfo } from "../bridge/files";
import type { SampleSource } from "../core/compiler";
import * as ops from "../core/model/ops";
import type { SampleSlot } from "../core/model/types";
import { DEFAULT_BANK } from "../core/wavetables/banks";
import { useEditor } from "./store";

/** What is known of a sound file: its picture, or why it could not be read. */
export type SoundState = { kind: "reading" } | { kind: "ready"; info: SoundInfo } | { kind: "error"; message: string };

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What is known of a wavetable: its picture and size, or why it could not be made. */
export type TableState = { kind: "reading" } | { kind: "ready"; info: WavetableInfo } | { kind: "error"; message: string };

/** What a wavetable is made from: one of the editor's own, or a sound file cut into cycles. */
export type TableSource = Exclude<SampleSource, { kind: "sound" }>;

interface SoundsState {
  /** By the file's path. Not part of the patch: read again when a patch is opened. */
  sounds: Record<string, SoundState>;
  /** By `tableKey` of what the wavetable is made from. */
  tables: Record<string, TableState>;
}

export const useSounds = create<SoundsState>(() => ({ sounds: {}, tables: {} }));

/** What a slot's wavetable is made from, or `null` for a slot that has none to give. */
export function tableSource(sample: SampleSlot | null): TableSource | null {
  if (sample?.kind === "wavetable") return { kind: "bank", id: sample.bank };
  if (sample?.kind === "file") return { kind: "wavetable", path: sample.path, ...(sample.cycle ? { cycle: sample.cycle } : {}) };
  return null;
}

export const tableKey = (source: TableSource) =>
  source.kind === "bank" ? `bank:${source.id}` : `file:${source.cycle ?? 0}:${source.path}`;

/** Have a wavetable made for its picture, unless that has been done or is under way. */
export function readTable(source: TableSource): void {
  const key = tableKey(source);
  if (useSounds.getState().tables[key]) return;
  const keep = (state: TableState) => useSounds.setState((s) => ({ tables: { ...s.tables, [key]: state } }));
  keep({ kind: "reading" });
  files.wavetableInfo(source).then(
    (info) => keep({ kind: "ready", info }),
    (e) => keep({ kind: "error", message: text(e) }),
  );
}

/** Read a sound file's picture, unless that has been done or is under way. */
export function readSound(path: string): void {
  if (useSounds.getState().sounds[path]) return;
  const keep = (state: SoundState) => useSounds.setState((s) => ({ sounds: { ...s.sounds, [path]: state } }));
  keep({ kind: "reading" });
  files.soundInfo(path).then(
    (info) => keep({ kind: "ready", info }),
    (e) => keep({ kind: "error", message: text(e) }),
  );
}

/** The length of a tape that "Tape" makes, in seconds. */
export const NEW_TAPE_SECONDS = 4;

export const setSample = (slot: number, sample: SampleSlot | null) =>
  useEditor.getState().apply((doc) => ops.setSample(doc, slot, sample));

/** The wavetable that "Wavetable" puts in a slot, to be changed for another there. */
export const NEW_WAVETABLE: SampleSlot = { kind: "wavetable", bank: DEFAULT_BANK };

/** Ask for a sound file and put it in a sample slot. A file that cannot be read is reported and the slot left as it was. */
export async function loadSample(slot: number): Promise<void> {
  const path = await files.pickSoundFile();
  if (!path) return;
  try {
    const info = await files.soundInfo(path);
    useSounds.setState((s) => ({ sounds: { ...s.sounds, [path]: { kind: "ready", info } } }));
    setSample(slot, { kind: "file", path, name: info.name, frames: info.frames, sampleRate: info.sampleRate });
  } catch (e) {
    await files.showError(text(e));
  }
}
