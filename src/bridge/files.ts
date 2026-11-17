import { invoke } from "@tauri-apps/api/core";
import { ask, message, open, save } from "@tauri-apps/plugin-dialog";
import { FILE_EXTENSION } from "../core/model/serialize";

const FILTERS = [{ name: "Gridelle patch", extensions: [FILE_EXTENSION] }];

/** Ask where to open a patch from. Resolves to `null` if the user cancels. */
export async function pickPatchToOpen(): Promise<string | null> {
  const path = await open({ multiple: false, directory: false, filters: FILTERS });
  return typeof path === "string" ? path : null;
}

/** Ask where to save a patch. Resolves to `null` if the user cancels. */
export async function pickPatchSavePath(suggestedName: string): Promise<string | null> {
  return save({ defaultPath: `${suggestedName}.${FILE_EXTENSION}`, filters: FILTERS });
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
export const writeTextFile = (path: string, contents: string) => invoke<void>("write_text_file", { path, contents });

/**
 * Write a patch folder named `folder` inside `parent`. Resolves to the folder's path.
 * Rejects with `"exists"` when the folder is already there and `overwrite` is false.
 */
export const exportPatch = (parent: string, folder: string, files: Record<string, string>, overwrite: boolean) =>
  invoke<string>("export_patch", { parent, folder, files, overwrite });

export const confirm = (text: string, okLabel: string) =>
  ask(text, { title: "Gridelle", kind: "warning", okLabel, cancelLabel: "Cancel" });

export const showError = (text: string) => message(text, { title: "Gridelle", kind: "error" });
export const showInfo = (text: string) => message(text, { title: "Gridelle", kind: "info" });
