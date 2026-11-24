import { exportToOrganelle, newPatch, savePatch, sendToOrganelle } from "./actions";
import { copySelection, cutSelection, duplicateSelection, pasteClipboard } from "./clipboard";
import { useEditor } from "./store";
import { showSidePane } from "./ui";

/** What the keyboard shortcuts and the menu bar both do. */
export type Command =
  | "new"
  | "open"
  | "save"
  | "export"
  | "send"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "duplicate"
  | "delete"
  | "selectAll"
  | "group";

const RUN: Record<Command, () => void> = {
  new: () => void newPatch(),
  // Opening is picking from the Presets pane.
  open: () => showSidePane("presets"),
  save: () => void savePatch(),
  export: () => void exportToOrganelle(),
  send: () => void sendToOrganelle(),
  undo: () => useEditor.getState().undo(),
  redo: () => useEditor.getState().redo(),
  cut: cutSelection,
  copy: copySelection,
  paste: pasteClipboard,
  duplicate: duplicateSelection,
  delete: () => useEditor.getState().deleteSelection(),
  selectAll: () => {
    const editor = useEditor.getState();
    editor.select(editor.doc.modules.map((m) => m.id));
  },
  group: () => void useEditor.getState().wrapSelection(),
};

/** Where a command came from: a key the page saw, or the menu bar (a click, or its shortcut). */
export type CommandSource = "key" | "menu";

let last: { command: Command; source: CommandSource; at: number } | null = null;

/**
 * Run a command. A menu item has the same shortcut as the page's own, and one press may
 * reach both: the second of the two, from the other source within a moment, is that press
 * again and is dropped. The same source twice (a key held down) always runs.
 */
export function runCommand(command: Command, source: CommandSource): void {
  const now = performance.now();
  if (last && last.command === command && last.source !== source && now - last.at < 250) return;
  last = { command, source, at: now };
  RUN[command]();
}
