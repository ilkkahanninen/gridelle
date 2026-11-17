import * as files from "../bridge/files";
import { compile } from "../core/compiler";
import { exportFolderName, parseDocument, serializeDocument } from "../core/model/serialize";
import { emptyDocument } from "../core/model/types";
import { abstractionLibrary } from "../core/pdlib";
import { hasUnsavedChanges, useEditor } from "./store";

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** True when it is fine to replace the current patch (nothing unsaved, or the user agreed). */
async function mayDiscard(): Promise<boolean> {
  const state = useEditor.getState();
  if (!hasUnsavedChanges(state)) return true;
  return files.confirm(`“${state.doc.name}” has unsaved changes. Discard them?`, "Discard changes");
}

export async function newPatch(): Promise<void> {
  if (await mayDiscard()) useEditor.getState().load(emptyDocument(), null);
}

export async function openPatch(): Promise<void> {
  if (!(await mayDiscard())) return;
  const path = await files.pickPatchToOpen();
  if (!path) return;
  try {
    useEditor.getState().load(parseDocument(await files.readTextFile(path)), path);
  } catch (e) {
    await files.showError(`Could not open the patch. ${text(e)}`);
  }
}

export async function savePatch(saveAs = false): Promise<void> {
  const { doc, filePath, markSaved } = useEditor.getState();
  const path = (!saveAs && filePath) || (await files.pickPatchSavePath(exportFolderName(doc.name)));
  if (!path) return;
  try {
    await files.writeTextFile(path, serializeDocument(doc));
    // Only mark saved if the document did not change while the file was being written.
    if (useEditor.getState().doc === doc) markSaved(path);
    else useEditor.setState({ filePath: path, savedDoc: doc });
  } catch (e) {
    await files.showError(`Could not save the patch. ${text(e)}`);
  }
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
      written = await files.exportPatch(parent, folder, result.files, false);
    } catch (e) {
      if (text(e) !== "exists") throw e;
      const replace = await files.confirm(
        `A folder named “${folder}” is already there. Replace the patch files in it?`,
        "Replace",
      );
      if (!replace) return;
      written = await files.exportPatch(parent, folder, result.files, true);
    }
    await files.showInfo(`Exported to ${written}`);
  } catch (e) {
    await files.showError(`Could not export the patch. ${text(e)}`);
  }
}
