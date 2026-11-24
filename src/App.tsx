import { useEffect } from "react";
import { startPresets } from "./state/presets";
import { cancelAssign } from "./state/assign";
import { installMenu } from "./bridge/menu";
import { runCommand, type Command } from "./state/commands";
import { startPreviewSync } from "./state/preview";
import { useEditor } from "./state/store";
import { useUi } from "./state/ui";
import { isTextField } from "./ui/textField";
import { GridCanvas } from "./ui/canvas/GridCanvas";
import { Palette } from "./ui/palette/Palette";
import { Dock } from "./ui/shell/Dock";
import { OpenSidePane } from "./ui/shell/SidePanes";
import { TopBar } from "./ui/shell/TopBar";
import "@fontsource/barlow-semi-condensed/400.css";
import "@fontsource/barlow-semi-condensed/500.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "./App.css";

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const command = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const run = (name: Command) => {
        e.preventDefault();
        runCommand(name, "key");
      };

      if (command && key === "s") {
        run("save");
      } else if (command && key === "o") {
        run("open");
      } else if (command && key === "n") {
        run("new");
      } else if (command && key === "e") {
        // Shift sends it over Wi-Fi instead of writing a folder.
        run(e.shiftKey ? "send" : "export");
      } else if (isTextField(e.target)) {
        // Let text fields keep undo, select-all and delete for themselves.
      } else if (command && key === "z") {
        run(e.shiftKey ? "redo" : "undo");
      } else if (command && key === "a") {
        run("selectAll");
      } else if (command && (key === "c" || key === "x")) {
        // Text that has been selected, as in the settings pane, is what gets copied then.
        if (window.getSelection()?.isCollapsed === false) return;
        run(key === "c" ? "copy" : "cut");
      } else if (command && key === "v") {
        run("paste");
      } else if (command && key === "d") {
        run("duplicate");
      } else if (command && key === "g") {
        run("group");
      } else if (key === "delete" || key === "backspace") {
        run("delete");
      } else if (key === "escape" && useUi.getState().assigning) {
        cancelAssign();
      } else if (key === "escape" && !useUi.getState().placing && !useUi.getState().cableDrag) {
        useEditor.getState().clearSelection();
      }
    };
    // The menu bar's Cut, Copy and Paste are the system's, for text; on the patch they arrive
    // as these events, which a key the page handled above never brings.
    const onClipboard = (e: ClipboardEvent) => {
      if (isTextField(e.target) || isTextField(document.activeElement) || window.getSelection()?.isCollapsed === false) return;
      e.preventDefault();
      runCommand(e.type as "cut" | "copy" | "paste", "menu");
    };
    window.addEventListener("keydown", onKey);
    for (const type of ["cut", "copy", "paste"] as const) document.addEventListener(type, onClipboard);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const type of ["cut", "copy", "paste"] as const) document.removeEventListener(type, onClipboard);
    };
  }, []);
}

/**
 * Assigning an Organelle knob ends with a press anywhere but on a knob of the grid, which
 * takes the assignment, or on an unassigned knob of the Knob pages panel, which arms that
 * one. The press still does whatever it would otherwise do.
 */
function useAssignCancel() {
  const assigning = useUi((s) => !!s.assigning);
  useEffect(() => {
    if (!assigning) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.(".tile-knob, .pages-knob-free")) cancelAssign();
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [assigning]);
}

function App() {
  useEffect(() => startPreviewSync(), []);
  // The presets that come with the editor are files in the presets folder from its first run on.
  useEffect(() => void startPresets(), []);
  // The desktop app's menu bar; nothing in a plain browser.
  useEffect(() => void installMenu(), []);
  useShortcuts();
  useAssignCancel();

  return (
    <div className="app">
      <TopBar />
      <div className="middle">
        <OpenSidePane side="left" />
        <div className="main">
          <Palette />
          <div className="workspace">
            <GridCanvas />
          </div>
        </div>
        <OpenSidePane side="right" />
      </div>
      <Dock />
    </div>
  );
}

export default App;
