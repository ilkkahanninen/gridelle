import { basicSynth, looper, newPatch, tapeEcho, voiceEffects } from "./fixtures";
import type { PatchDocument } from "./model/types";

/**
 * The preset a new patch is a copy of. It is a file like the others, which the user can
 * save their own base over; opening it never opens the file itself, so that saving what
 * was started from it asks before it replaces it.
 */
export const NEW_PATCH_NAME = "New patch";

/** A preset that comes with the editor: the name of its file, and the patch in it. */
export interface ExamplePreset {
  name: string;
  doc: PatchDocument;
}

/**
 * The presets that come with the editor. They are written into the presets folder the
 * first time the editor runs, each once ever, and are the user's own from then on: there
 * is no other place the editor keeps presets. They are documents the tests compile and
 * play. Those that play a sound file are left out, since that file would have to come along.
 */
export const EXAMPLE_PRESETS: ExamplePreset[] = [newPatch, basicSynth, tapeEcho, looper, voiceEffects].map((doc) => ({
  name: doc.name,
  doc,
}));

/** The longest a preset's file name may be, without its ending. */
const MAX_NAME = 80;

/**
 * The name of the file a patch is saved in, without its ending: the patch's name, less
 * what a file name cannot hold. `is_preset_name` in `src-tauri/src/presets.rs` is the
 * same rule from the other side, and refuses what this would not produce.
 */
export function presetFileName(name: string): string {
  const cleaned = name
    .normalize("NFC")
    // Control characters, and the characters that separate or mean something in a path.
    .replace(/[\u0000-\u001f\u007f-\u009f/\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    // Neither end may be a space or a full stop: hidden on one system, dropped on another.
    .replace(/^[. ]+/, "");
  return [...cleaned].slice(0, MAX_NAME).join("").replace(/[. ]+$/, "") || "Untitled";
}
