import { isTauri } from "@tauri-apps/api/core";
import { Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import * as ops from "../core/model/ops";
import { runCommand, type Command } from "../state/commands";
import { useEditor } from "../state/store";
import { isTextField } from "../ui/textField";

/**
 * The desktop app's menu bar. Its items run the same commands as the keyboard shortcuts
 * (`state/commands.ts`), which keep working without it, as in a plain browser.
 *
 * Cut, Copy and Paste are the system's own, so that they work on the text in a field (a
 * page may not paste by itself); on the patch the page answers the copy, cut and paste they
 * bring (`App.tsx`). Undo, Redo and Select All are the editor's: on the patch, or on the
 * text when a text field has the focus.
 */
export function installMenu(): Promise<void> {
  // Once: React runs a start-up effect twice in development.
  installed ??= isTauri() ? build() : Promise.resolve();
  return installed;
}

let installed: Promise<void> | null = null;

async function build(): Promise<void> {
  const item = (text: string, command: Command, accelerator?: string, enabled = true) =>
    MenuItem.new({ text, accelerator, enabled, action: () => runCommand(command, "menu") });
  // In a text field, the field's own undo and select-all.
  const textOr = (text: string, command: Command, field: string, accelerator: string) =>
    MenuItem.new({
      text,
      accelerator,
      action: () => (isTextField(document.activeElement) ? document.execCommand(field) : runCommand(command, "menu")),
    });
  const separator = () => PredefinedMenuItem.new({ item: "Separator" });

  const duplicate = await item("Duplicate", "duplicate", "CmdOrCtrl+D", false);
  const remove = await item("Delete", "delete", undefined, false);
  const group = await item("Put in Unison Group", "group", "CmdOrCtrl+G", false);

  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "Gridelle",
        items: [
          await PredefinedMenuItem.new({ item: { About: null } }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Services" }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Hide" }),
          await PredefinedMenuItem.new({ item: "HideOthers" }),
          await PredefinedMenuItem.new({ item: "ShowAll" }),
          await separator(),
          await PredefinedMenuItem.new({ item: "Quit" }),
        ],
      }),
      await Submenu.new({
        text: "File",
        items: [
          await item("New Patch", "new", "CmdOrCtrl+N"),
          await item("Open…", "open", "CmdOrCtrl+O"),
          await item("Save", "save", "CmdOrCtrl+S"),
          await separator(),
          await item("Export…", "export", "CmdOrCtrl+E"),
          await item("Send to Organelle", "send", "CmdOrCtrl+Shift+E"),
          await separator(),
          await PredefinedMenuItem.new({ item: "CloseWindow" }),
        ],
      }),
      await Submenu.new({
        text: "Edit",
        items: [
          await textOr("Undo", "undo", "undo", "CmdOrCtrl+Z"),
          await textOr("Redo", "redo", "redo", "CmdOrCtrl+Shift+Z"),
          await separator(),
          await PredefinedMenuItem.new({ item: "Cut" }),
          await PredefinedMenuItem.new({ item: "Copy" }),
          await PredefinedMenuItem.new({ item: "Paste" }),
          duplicate,
          remove,
          await textOr("Select All", "selectAll", "selectAll", "CmdOrCtrl+A"),
          await separator(),
          group,
        ],
      }),
      await Submenu.new({ text: "View", items: [await PredefinedMenuItem.new({ item: "Fullscreen" })] }),
      await Submenu.new({
        text: "Window",
        items: [await PredefinedMenuItem.new({ item: "Minimize" }), await PredefinedMenuItem.new({ item: "Maximize" })],
      }),
    ],
  });
  await menu.setAsAppMenu();

  // What applies to the selection is greyed out without one, and grouping where it cannot be done.
  let shown = { any: false, groupable: false };
  const update = () => {
    const { doc, selection } = useEditor.getState();
    const now = { any: selection.size > 0, groupable: ops.wrapProblem(doc, selection) === null };
    if (now.any !== shown.any) {
      void duplicate.setEnabled(now.any);
      void remove.setEnabled(now.any);
    }
    if (now.groupable !== shown.groupable) void group.setEnabled(now.groupable);
    shown = now;
  };
  update();
  useEditor.subscribe(update);
}
