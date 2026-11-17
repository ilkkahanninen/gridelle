import { create } from "zustand";
import { engine } from "../bridge/engine";
import { compile, type Diagnostic } from "../core/compiler";
import { structureKey } from "../core/compiler/structure";
import type { PatchDocument } from "../core/model/types";
import { abstractionLibrary } from "../core/pdlib";
import { useEditor } from "./store";

type EngineState =
  | { kind: "starting" }
  | { kind: "ready"; sampleRate: number }
  | { kind: "unavailable"; message: string };

interface PreviewState {
  engine: EngineState;
  /** Problems with the current patch, from the compiler. */
  diagnostics: Diagnostic[];
  /** Bumped just before a patch is handed to the engine, so displays can be cleared first. */
  loadsStarted: number;
  /** Bumped every time a patch finishes loading into the engine. */
  revision: number;
  /** Lines printed by Pd, most recent last. */
  log: string[];
  /** Set when the engine refused the last patch. */
  loadError: string | null;
}

export const usePreview = create<PreviewState>(() => ({
  engine: { kind: "starting" },
  diagnostics: [],
  loadsStarted: 0,
  revision: 0,
  log: [],
  loadError: null,
}));

/** Structural edits come in bursts (dragging a cable across ports); wait for them to settle. */
const RELOAD_DELAY_MS = 120;

/**
 * Keep the engine playing what the editor shows.
 *
 * Changing the patch's structure (modules, cables, voice count) recompiles and
 * reloads it. Changing only parameter values sends each new value to its
 * receiver, with no reload. Returns a function that stops the sync.
 */
export function startPreviewSync(): () => void {
  let stopped = false;
  let loadedKey: string | null = null;
  let sent = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let loading = false;
  let pending = false;

  const sendChangedParams = (doc: PatchDocument) => {
    const result = compile(doc, abstractionLibrary);
    if (!result.ok) return;
    for (const { receiver, value } of result.params) {
      if (sent.get(receiver) !== value) {
        sent.set(receiver, value);
        void engine.send(receiver, value);
        // Keep the knob that controls this parameter, and its screen line, in step.
        const slot = result.knobSlots.find((s) => s.param === receiver);
        if (slot) void engine.send(slot.receiver, slot.position);
      }
    }
  };

  const reload = async () => {
    if (loading) {
      pending = true;
      return;
    }
    loading = true;
    try {
      const doc = useEditor.getState().doc;
      const key = structureKey(doc);
      const result = compile(doc, abstractionLibrary);
      usePreview.setState({ diagnostics: result.diagnostics });
      if (result.ok && usePreview.getState().engine.kind === "ready") {
        // A patch writes to the screen while it loads, so announce the load before it starts.
        usePreview.setState((s) => ({ loadsStarted: s.loadsStarted + 1 }));
        await engine.load(result.files, result.entry);
        if (stopped) return;
        loadedKey = key;
        // The patch sets these itself on load.
        sent = new Map(result.params.map((p) => [p.receiver, p.value]));
        usePreview.setState((s) => ({ revision: s.revision + 1, loadError: null }));
        // Values may have moved while the patch was loading.
        const now = useEditor.getState().doc;
        if (structureKey(now) === key) sendChangedParams(now);
      }
    } catch (e) {
      usePreview.setState({ loadError: e instanceof Error ? e.message : String(e) });
    } finally {
      loading = false;
      if (pending && !stopped) {
        pending = false;
        void reload();
      }
    }
  };

  const onDocument = (doc: PatchDocument) => {
    if (structureKey(doc) === loadedKey) {
      sendChangedParams(doc);
    } else {
      clearTimeout(timer);
      timer = setTimeout(() => void reload(), RELOAD_DELAY_MS);
    }
  };

  const unsubscribe = useEditor.subscribe((state, previous) => {
    if (state.doc !== previous.doc) onDocument(state.doc);
  });

  const events = engine.onEvent((event) => {
    if (event.kind === "print") usePreview.setState((s) => ({ log: [...s.log.slice(-199), event.text] }));
  });

  void engine
    .status()
    .then((status) => {
      if (stopped) return;
      usePreview.setState({
        engine: status.running
          ? { kind: "ready", sampleRate: status.sampleRate ?? 0 }
          : { kind: "unavailable", message: status.error ?? "The audio engine did not start." },
      });
      void reload();
    })
    .catch((e) => {
      // Outside the desktop app (plain browser) there is no engine; the editor still works.
      usePreview.setState({ engine: { kind: "unavailable", message: e instanceof Error ? e.message : String(e) } });
      void reload();
    });

  return () => {
    stopped = true;
    clearTimeout(timer);
    unsubscribe();
    void events.then((off) => off()).catch(() => {});
  };
}
