import { invoke, isTauri } from "@tauri-apps/api/core";
import { ask, message, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { SoundFile } from "./engine";

/** A preset the user has saved: its name, which is its file's name without the ending, and where it is. */
export interface PresetFile {
  name: string;
  path: string;
}

export interface PresetList {
  /** Where presets are kept: the Gridelle folder in the user's Documents. */
  dir: string;
  presets: PresetFile[];
}

const DESKTOP_ONLY = "Saved presets need the desktop app.";

/** The saved presets, by name. */
export const listPresets = (): Promise<PresetList> =>
  isTauri() ? invoke<PresetList>("presets_list") : Promise.reject(DESKTOP_ONLY);

/**
 * Save a preset under `name` (see `presetFileName`). Resolves to the file's path. Rejects
 * with `"exists"` when there is a preset of that name already and `overwrite` is false.
 */
export const savePreset = (name: string, contents: string, overwrite: boolean): Promise<string> =>
  isTauri() ? invoke<string>("preset_save", { name, contents, overwrite }) : Promise.reject(DESKTOP_ONLY);

export const deletePreset = (path: string) => invoke<void>("preset_delete", { path });

/**
 * Write the presets that come with the editor into the presets folder: each once ever, so
 * that one the user has deleted since stays deleted. Nothing happens outside the desktop app.
 */
export const seedPresets = (examples: { name: string; contents: string }[]): Promise<void> =>
  isTauri() ? invoke<void>("presets_seed", { examples }) : Promise.resolve();

/** Show the folder the presets are in, in the file manager. It is made if it is not there yet. */
export async function showPresetFolder(): Promise<void> {
  await revealItemInDir(await invoke<string>("presets_folder"));
}

/** Ask for the folder to export into, e.g. the `Patches` folder of the Organelle's USB drive. */
export async function pickExportFolder(): Promise<string | null> {
  const path = await open({
    directory: true,
    multiple: false,
    title: "Choose where to export, for example the Patches folder on the Organelle's USB drive",
  });
  return typeof path === "string" ? path : null;
}

export const readTextFile = (path: string) => invoke<string>("read_text_file", { path });

/**
 * Write a patch folder named `folder` inside `parent`, with the sound files the patch
 * plays. Resolves to the folder's path. Rejects with `"exists"` when the folder is already
 * there and `overwrite` is false.
 */
export const exportPatch = (
  parent: string,
  folder: string,
  files: Record<string, string>,
  sounds: SoundFile[],
  overwrite: boolean,
) => invoke<string>("export_patch", { parent, folder, files, samples: sounds, overwrite });

/** The kinds of sound file a sample can be loaded from. */
export const SOUND_EXTENSIONS = ["wav", "aif", "aiff", "flac", "mp3", "ogg"];

/** Ask for a sound file. Resolves to `null` if the user cancels. */
export async function pickSoundFile(): Promise<string | null> {
  const path = await open({ multiple: false, directory: false, filters: [{ name: "Sound", extensions: SOUND_EXTENSIONS }] });
  return typeof path === "string" ? path : null;
}

/** What the editor shows of a sound file. */
export interface SoundInfo {
  name: string;
  /** Its length in samples, and its sample rate. */
  frames: number;
  sampleRate: number;
  /** Pairs of lowest and highest sample, left to right, to draw its picture from. */
  peaks: number[];
}

/** Read a sound file's length, rate and picture. Rejects with the reason when it cannot be read. */
export const soundInfo = (path: string): Promise<SoundInfo> =>
  isTauri() ? invoke<SoundInfo>("sample_info", { path }) : Promise.reject("Sound files need the desktop app.");

export const confirm = (text: string, okLabel: string) =>
  ask(text, { title: "Gridelle", kind: "warning", okLabel, cancelLabel: "Cancel" });

export const showError = (text: string) => message(text, { title: "Gridelle", kind: "error" });
export const showInfo = (text: string) => message(text, { title: "Gridelle", kind: "info" });
