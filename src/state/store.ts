import { create } from "zustand";
import { basicSynth } from "../core/fixtures";
import * as ops from "../core/model/ops";
import type { Cable, ModuleId, PatchDocument } from "../core/model/types";

const HISTORY_LIMIT = 200;
/** Edits with the same coalesce key closer together than this become one undo step. */
const COALESCE_MS = 1000;

type Edit = (doc: PatchDocument) => PatchDocument;

interface EditorState {
  doc: PatchDocument;
  past: PatchDocument[];
  future: PatchDocument[];
  coalesce: { key: string; at: number } | null;

  selection: ReadonlySet<ModuleId>;
  selectedCable: Cable | null;

  /** Where the patch was last saved or opened from. */
  filePath: string | null;
  /** The document as last saved; differs from `doc` when there are unsaved changes. */
  savedDoc: PatchDocument;

  /**
   * Apply an edit as an undo step. Pass `coalesceKey` for continuous gestures
   * (a knob drag) so the whole gesture undoes at once.
   */
  apply(edit: Edit, coalesceKey?: string): void;
  undo(): void;
  redo(): void;

  select(ids: Iterable<ModuleId>, additive?: boolean): void;
  toggleSelected(id: ModuleId): void;
  selectCable(cable: Cable | null): void;
  clearSelection(): void;

  addModule(type: string, at: ops.Cell): ModuleId | null;
  /** Add a module cabled to a port (`ops.planPortDrop`). `null` if there was nothing to cable. */
  addModuleAtPort(type: string, target: ops.PortTarget): ModuleId | null;
  deleteSelection(): void;
  /** Put a clip's modules in near a cell (`ops.pasteModules`) and select them. Returns their ids. */
  paste(clip: ops.Clip, near: ops.Cell): ModuleId[];
  /** Copy the selected modules to right below themselves, and select the copies. Returns their ids. */
  duplicateSelection(): ModuleId[];

  /** Replace the document (New, Open). Clears history and selection. */
  load(doc: PatchDocument, filePath: string | null): void;
  markSaved(filePath: string): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: basicSynth,
  past: [],
  future: [],
  coalesce: null,
  selection: new Set(),
  selectedCable: null,
  filePath: null,
  savedDoc: basicSynth,

  apply(edit, coalesceKey) {
    const { doc, past, coalesce } = get();
    const next = edit(doc);
    if (next === doc) return;
    const now = Date.now();
    const merge = !!coalesceKey && coalesce?.key === coalesceKey && now - coalesce.at < COALESCE_MS;
    set({
      doc: next,
      past: merge ? past : [...past.slice(-(HISTORY_LIMIT - 1)), doc],
      future: [],
      coalesce: coalesceKey ? { key: coalesceKey, at: now } : null,
    });
  },

  undo() {
    const { doc, past, future } = get();
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    set({ doc: previous, past: past.slice(0, -1), future: [doc, ...future], coalesce: null, ...prune(previous, get()) });
  },

  redo() {
    const { doc, past, future } = get();
    if (future.length === 0) return;
    const [next, ...rest] = future;
    set({ doc: next, past: [...past, doc], future: rest, coalesce: null, ...prune(next, get()) });
  },

  select(ids, additive = false) {
    const next = new Set(additive ? get().selection : []);
    for (const id of ids) next.add(id);
    set({ selection: next, selectedCable: null });
  },

  toggleSelected(id) {
    const next = new Set(get().selection);
    if (!next.delete(id)) next.add(id);
    set({ selection: next, selectedCable: null });
  },

  selectCable(cable) {
    set({ selectedCable: cable, selection: new Set() });
  },

  clearSelection() {
    if (get().selection.size > 0 || get().selectedCable) set({ selection: new Set(), selectedCable: null });
  },

  addModule(type, at) {
    let added: ModuleId | null = null;
    get().apply((doc) => {
      const result = ops.addModule(doc, type, at);
      added = result.id;
      return result.doc;
    });
    if (added) set({ selection: new Set([added]), selectedCable: null });
    return added;
  },

  addModuleAtPort(type, target) {
    let added: ModuleId | null = null;
    get().apply((doc) => {
      const result = ops.addModuleAtPort(doc, type, target);
      added = result.id;
      return result.doc;
    });
    if (added) set({ selection: new Set([added]), selectedCable: null });
    return added;
  },

  deleteSelection() {
    const { selection, selectedCable, apply } = get();
    if (selectedCable) apply((doc) => ops.disconnect(doc, selectedCable));
    else if (selection.size > 0) apply((doc) => ops.removeModules(doc, selection));
    set({ selection: new Set(), selectedCable: null });
  },

  paste(clip, near) {
    let added: ModuleId[] = [];
    get().apply((doc) => {
      const result = ops.pasteModules(doc, clip, near);
      added = result.ids;
      return result.doc;
    });
    if (added.length > 0) set({ selection: new Set(added), selectedCable: null });
    return added;
  },

  duplicateSelection() {
    let added: ModuleId[] = [];
    get().apply((doc) => {
      const result = ops.duplicateModules(doc, get().selection);
      added = result.ids;
      return result.doc;
    });
    if (added.length > 0) set({ selection: new Set(added), selectedCable: null });
    return added;
  },

  load(doc, filePath) {
    set({
      doc,
      past: [],
      future: [],
      coalesce: null,
      selection: new Set(),
      selectedCable: null,
      filePath,
      savedDoc: doc,
    });
  },

  markSaved(filePath) {
    set({ filePath, savedDoc: get().doc });
  },
}));

/** After undo/redo, drop selected things that no longer exist. */
function prune(doc: PatchDocument, state: EditorState) {
  const ids = new Set(doc.modules.map((m) => m.id));
  const selection = new Set([...state.selection].filter((id) => ids.has(id)));
  const cable = state.selectedCable;
  const selectedCable = cable && doc.cables.some((c) => ops.sameCable(c, cable)) ? cable : null;
  return { selection, selectedCable };
}

export const hasUnsavedChanges = (state: Pick<EditorState, "doc" | "savedDoc">) => state.doc !== state.savedDoc;
