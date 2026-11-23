import { create } from "zustand";
import * as files from "../bridge/files";
import type { PresetFile } from "../bridge/files";
import { serializeDocument } from "../core/model/serialize";
import { EXAMPLE_PRESETS } from "../core/presets";

interface PresetsState {
  /** The presets in the presets folder, by name. */
  saved: PresetFile[];
  /** Why they could not be listed, when they could not. */
  problem: string | null;
}

export const usePresets = create<PresetsState>(() => ({ saved: [], problem: null }));

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * When the editor starts: put the presets that come with it in the presets folder, if
 * they have not been there before, and read the list. A failure shows in the Presets pane.
 */
export async function startPresets(): Promise<void> {
  try {
    await files.seedPresets(EXAMPLE_PRESETS.map(({ name, doc }) => ({ name, contents: serializeDocument(doc) })));
  } catch {
    // Listing fails for the same reason, and says why.
  }
  await refreshPresets();
}

/** Read the list of saved presets again: they are files, and files change behind the editor's back. */
export async function refreshPresets(): Promise<void> {
  try {
    const { presets } = await files.listPresets();
    usePresets.setState({ saved: presets, problem: null });
  } catch (e) {
    usePresets.setState({ saved: [], problem: text(e) });
  }
}
