import { create } from "zustand";
import { engine, type Atom, type PdEvent } from "../bridge/engine";
import { compile, type Diagnostic } from "../core/compiler";
import { SCREEN_COLUMNS } from "../core/compiler/knobPages";
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
  /** What the patch has written to the Organelle's screen (`screenLine1`–`screenLine5`), one entry per line. */
  screen: string[];
  /** The colour number the patch last sent to `led`; 0 is off. */
  led: number;
  /** Bumped every time a patch finishes loading into the engine. */
  revision: number;
  /** Lines printed by Pd, most recent last. Kept for looking at; nothing draws them. */
  log: string[];
  /** Set when the engine refused the last patch. */
  loadError: string | null;
  /** Why the patch's Audio In is silent in the preview, when its input could not be opened. */
  inputProblem: string | null;
  /** The number of each Scope module in the patch that is loaded, from 1. */
  scopes: Record<string, number>;
}

const SCREEN_LINES = 5;
const blankScreen = (): string[] => Array(SCREEN_LINES).fill("");

function atomText(atom: Atom) {
  return typeof atom === "number" ? String(Number(atom.toPrecision(6))) : atom;
}

export const usePreview = create<PreviewState>(() => ({
  engine: { kind: "starting" },
  diagnostics: [],
  screen: blankScreen(),
  led: 0,
  revision: 0,
  log: [],
  loadError: null,
  inputProblem: null,
  scopes: {},
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
        // A patch writes to the screen while it loads, so blank it before the load starts.
        usePreview.setState({ screen: blankScreen(), led: 0 });
        const inputProblem = await engine.load(result.files, result.entry, result.samples);
        if (stopped) return;
        loadedKey = key;
        // The patch sets these itself on load.
        sent = new Map(result.params.map((p) => [p.receiver, p.value]));
        usePreview.setState((s) => ({ revision: s.revision + 1, loadError: null, inputProblem, scopes: result.scopes }));
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

  // The screen and LED are kept here, not in the component that draws them: the patch only
  // writes a line when it changes, so a display that forgot its contents would stay blank.
  const onEvent = (event: PdEvent) => {
    if (event.kind === "print") {
      usePreview.setState((s) => ({ log: [...s.log.slice(-199), event.text] }));
      return;
    }
    const line = /^screenLine([1-5])$/.exec(event.recv);
    if (line) {
      const text = event.atoms.map(atomText).join(" ").slice(0, SCREEN_COLUMNS);
      usePreview.setState((s) => ({ screen: s.screen.map((old, i) => (i === Number(line[1]) - 1 ? text : old)) }));
    } else if (event.recv === "led" && typeof event.atoms[0] === "number") {
      usePreview.setState({ led: event.atoms[0] });
    }
  };
  const events = engine.onEvent(onEvent);

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
