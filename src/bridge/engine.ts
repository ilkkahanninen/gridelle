import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** A Pd atom: a number or a symbol. */
export type Atom = number | string;

/** Something the running patch printed, or sent to a host name (screen lines, LED). */
export type PdEvent =
  | { kind: "print"; text: string }
  | { kind: "message"; recv: string; atoms: Atom[] };

export interface EngineStatus {
  running: boolean;
  error: string | null;
  sampleRate: number | null;
}

/** Patch files by name, e.g. `{ "main.pd": "#N canvas ..." }`. */
export type PatchFiles = Record<string, string>;

/**
 * The live preview. The editor talks to Pd only through this interface, so the
 * native libpd backend could be swapped for another runtime without touching the UI.
 */
export interface PreviewEngine {
  status(): Promise<EngineStatus>;
  /** Replace the running patch. `entry` is the main patch's file name. */
  load(files: PatchFiles, entry: string): Promise<void>;
  /** Send to a receiver in the patch: a hardware name (`knob1`, `notes`) or a parameter. */
  send(recv: string, ...atoms: Atom[]): Promise<void>;
  setVolume(volume: number): Promise<void>;
  peak(): Promise<number>;
  /** Subscribe to patch output. Resolves to an unsubscribe function. */
  onEvent(handler: (event: PdEvent) => void): Promise<() => void>;
}

const desktopEngine: PreviewEngine = {
  status: () => invoke<EngineStatus>("engine_status"),
  load: (files, entry) => invoke("engine_load", { files, entry }),
  send: (recv, ...atoms) => invoke("engine_send", { recv, atoms }),
  setVolume: (volume) => invoke("engine_set_volume", { volume }),
  peak: () => invoke<number>("engine_peak"),
  onEvent: (handler) => listen<PdEvent>("pd-event", (e) => handler(e.payload)),
};

/** Stand-in when the UI runs in a plain browser (UI development): editing works, nothing sounds. */
const silentEngine: PreviewEngine = {
  status: async () => ({ running: false, error: "The audio preview needs the desktop app.", sampleRate: null }),
  load: async () => {},
  send: async () => {},
  setVolume: async () => {},
  peak: async () => 0,
  onEvent: async () => () => {},
};

export const engine: PreviewEngine = isTauri() ? desktopEngine : silentEngine;
