import { invoke, isTauri } from "@tauri-apps/api/core";
import type { SoundFile } from "./engine";

export interface SendReport {
  /** The patch folder on the device, e.g. `/sdcard/Patches/Basic_Synth`. */
  path: string;
  /** Whether the Organelle confirmed that it is now running the patch. */
  started: boolean;
}

/**
 * Put a patch folder named `folder` on the Organelle at `address` (IP address or host
 * name) over the network, with the sound files the patch plays, and start it there.
 *
 * Rejects with `"exists"` when the device has a folder of that name which Gridelle did
 * not make and `replace` is false; any other rejection is a message for the user.
 */
export const sendPatch = (
  address: string,
  folder: string,
  files: Record<string, string>,
  sounds: SoundFile[],
  replace: boolean,
): Promise<SendReport> =>
  isTauri()
    ? invoke<SendReport>("organelle_send", { address, folder, files, samples: sounds, replace })
    : Promise.reject(new Error("Sending to the Organelle needs the desktop app."));
