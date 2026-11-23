import * as files from "../bridge/files";
import type { PresetFile } from "../bridge/files";
import { sendPatch, type SendReport } from "../bridge/organelle";
import { compile } from "../core/compiler";
import { settle } from "../core/model/ops";
import { exportFolderName, parseDocument, serializeDocument } from "../core/model/serialize";
import { abstractionLibrary } from "../core/pdlib";
import { newPatch as builtInNewPatch } from "../core/fixtures";
import { NEW_PATCH_NAME, presetFileName } from "../core/presets";
import { useOrganelle } from "./organelle";
import { refreshPresets, usePresets } from "./presets";
import { hasUnsavedChanges, useEditor } from "./store";
import { showSidePane } from "./ui";

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True when it is fine to replace the current patch (nothing unsaved, or the user agreed). */
async function mayDiscard(): Promise<boolean> {
  const state = useEditor.getState();
  if (!hasUnsavedChanges(state)) return true;
  return files.confirm(`“${state.doc.name}” has unsaved changes. Discard them?`, "Discard changes");
}

/**
 * Open a preset. The one that new patches are copies of opens as such a copy, saved
 * nowhere: saving it then asks before it replaces that preset.
 */
export async function openPreset(preset: PresetFile): Promise<void> {
  if (!(await mayDiscard())) return;
  try {
    // A patch from an older build may have tiles that overlap now that some modules are larger.
    const doc = settle(parseDocument(await files.readTextFile(preset.path)));
    useEditor.getState().load(doc, preset.name === NEW_PATCH_NAME ? null : preset.path);
  } catch (e) {
    await files.showError(`Could not open the preset. ${text(e)}`);
  }
}

/**
 * Start a new patch: a copy of the "New patch" preset, or of the one the editor comes
 * with when that preset is not there or cannot be read.
 */
export async function newPatch(): Promise<void> {
  if (!(await mayDiscard())) return;
  const base = usePresets.getState().saved.find((preset) => preset.name === NEW_PATCH_NAME);
  let doc = builtInNewPatch;
  if (base) {
    try {
      doc = settle(parseDocument(await files.readTextFile(base.path)));
    } catch {
      // The built-in one, then.
    }
  }
  useEditor.getState().load(doc, null);
}

/** The name a file was saved under: the last part of its path, without the ending. */
const savedName = (path: string) =>
  path
    .slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1)
    .replace(/\.[^.]*$/, "")
    .normalize("NFC");

/**
 * Save the patch among the presets, in a file named after it. Saving the preset that is
 * open, under the name it has, just writes it. A name that another preset has asks first.
 * A patch that was renamed since it was opened is saved as a new preset beside the old.
 */
export async function savePatch(): Promise<void> {
  const { doc, filePath, markSaved } = useEditor.getState();
  const name = presetFileName(doc.name);
  const contents = serializeDocument(doc);
  try {
    let path: string;
    try {
      path = await files.savePreset(name, contents, filePath !== null && savedName(filePath) === name);
    } catch (e) {
      if (text(e) !== "exists") throw e;
      if (!(await files.confirm(`A preset named “${name}” is already saved. Replace it?`, "Replace"))) return;
      path = await files.savePreset(name, contents, true);
    }
    // Only mark saved if the document did not change while the file was being written.
    if (useEditor.getState().doc === doc) markSaved(path);
    else useEditor.setState({ filePath: path, savedDoc: doc });
    await refreshPresets();
  } catch (e) {
    await files.showError(`Could not save the preset. ${text(e)}`);
  }
}

/** Delete a saved preset, after asking. If it is the one that is open, the patch stays, saved nowhere. */
export async function deletePreset(preset: PresetFile): Promise<void> {
  if (!(await files.confirm(`Delete the preset “${preset.name}”? Its file is removed from the presets folder.`, "Delete"))) return;
  try {
    await files.deletePreset(preset.path);
    if (useEditor.getState().filePath === preset.path) useEditor.setState({ filePath: null });
  } catch (e) {
    await files.showError(text(e));
  }
  await refreshPresets();
}

/** Compile the patch and write it as an Organelle patch folder. */
export async function exportToOrganelle(): Promise<void> {
  const { doc } = useEditor.getState();
  const result = compile(doc, abstractionLibrary);
  if (!result.ok) {
    const problems = result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    await files.showError(`This patch cannot be exported yet.\n\n${problems.join("\n")}`);
    return;
  }
  const parent = await files.pickExportFolder();
  if (!parent) return;
  const folder = exportFolderName(doc.name);
  try {
    let written: string;
    try {
      written = await files.exportPatch(parent, folder, result.files, result.samples, false);
    } catch (e) {
      if (text(e) !== "exists") throw e;
      const replace = await files.confirm(
        `A folder named “${folder}” is already there. Replace the patch files in it?`,
        "Replace",
      );
      if (!replace) return;
      written = await files.exportPatch(parent, folder, result.files, result.samples, true);
    }
    await files.showInfo(`Exported to ${written}`);
  } catch (e) {
    await files.showError(`Could not export the patch. ${text(e)}`);
  }
}

/**
 * Compile the patch, put it on the Organelle over the network and start it there.
 * Progress and the outcome go to the Organelle pane, which this opens, not to dialogs.
 */
export async function sendToOrganelle(): Promise<void> {
  const { address, status } = useOrganelle.getState();
  if (status.kind === "sending") return;
  // Progress and the outcome show in the Organelle pane. Without an address it asks for one.
  showSidePane("organelle");
  if (!address.trim()) return;

  const { doc } = useEditor.getState();
  const result = compile(doc, abstractionLibrary);
  if (!result.ok) {
    const problems = result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
    useOrganelle.setState({ status: { kind: "error", message: `This patch cannot be sent yet. ${problems.join(" ")}` } });
    return;
  }

  const folder = exportFolderName(doc.name);
  useOrganelle.setState({ status: { kind: "sending" } });
  try {
    let report: SendReport;
    try {
      report = await sendPatch(address, folder, result.files, result.samples, false);
    } catch (e) {
      if (text(e) !== "exists") throw e;
      const replace = await files.confirm(
        `The Organelle already has a patch named “${folder}” that Gridelle did not make. Replace its files?`,
        "Replace",
      );
      if (!replace) {
        useOrganelle.setState({ status: { kind: "idle" } });
        return;
      }
      report = await sendPatch(address, folder, result.files, result.samples, true);
    }
    const message = report.started
      ? `${folder} is running on the Organelle.`
      : `${folder} is on the Organelle but did not start by itself. Pick it from the Organelle's menu.`;
    useOrganelle.setState({ status: { kind: "sent", message } });
  } catch (e) {
    useOrganelle.setState({ status: { kind: "error", message: text(e) } });
  }
}
