import { create } from "zustand";
import * as files from "../bridge/files";
import type { SoundInfo } from "../bridge/files";
import * as ops from "../core/model/ops";
import type { SampleSlot } from "../core/model/types";
import { useEditor } from "./store";

/** What is known of a sound file: its picture, or why it could not be read. */
export type SoundState = { kind: "reading" } | { kind: "ready"; info: SoundInfo } | { kind: "error"; message: string };

interface SoundsState {
  /** By the file's path. Not part of the patch: read again when a patch is opened. */
  sounds: Record<string, SoundState>;
}

export const useSounds = create<SoundsState>(() => ({ sounds: {} }));

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
