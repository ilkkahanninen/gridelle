import { useEffect } from "react";
import { exportToOrganelle, newPatch, savePatch, sendToOrganelle } from "./state/actions";
import { startPresets } from "./state/presets";
import { cancelAssign } from "./state/assign";
import { copySelection, cutSelection, duplicateSelection, pasteClipboard } from "./state/clipboard";
import { startPreviewSync } from "./state/preview";
import { useEditor } from "./state/store";
import { showSidePane, useUi } from "./state/ui";
import { GridCanvas } from "./ui/canvas/GridCanvas";
import { Palette } from "./ui/palette/Palette";
import { Dock } from "./ui/shell/Dock";
import { OpenSidePane } from "./ui/shell/SidePanes";
import { TopBar } from "./ui/shell/TopBar";
import "@fontsource/barlow-semi-condensed/400.css";
import "@fontsource/barlow-semi-condensed/500.css";
import "@fontsource/barlow-semi-condensed/600.css";
import "./App.css";

const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== "range"));

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const editor = useEditor.getState();
      const command = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (command && key === "s") {
        e.preventDefault();
        void savePatch();
      } else if (command && key === "o") {
        // Opening is picking from the Presets pane.
        e.preventDefault();
        showSidePane("presets");
      } else if (command && key === "n") {
        e.preventDefault();
        void newPatch();
      } else if (command && key === "e") {
        e.preventDefault();
        // Shift sends it over Wi-Fi instead of writing a folder.
        void (e.shiftKey ? sendToOrganelle() : exportToOrganelle());
      } else if (isTextField(e.target)) {
        // Let text fields keep undo, select-all and delete for themselves.
      } else if (command && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (command && key === "a") {
        e.preventDefault();
        editor.select(editor.doc.modules.map((m) => m.id));
      } else if (command && (key === "c" || key === "x")) {
        // Text that has been selected, as in the settings pane, is what gets copied then.
        if (window.getSelection()?.isCollapsed === false) return;
        e.preventDefault();
        if (key === "c") copySelection();
        else cutSelection();
      } else if (command && key === "v") {
        e.preventDefault();
        pasteClipboard();
      } else if (command && key === "d") {
        e.preventDefault();
        duplicateSelection();
      } else if (key === "delete" || key === "backspace") {
        e.preventDefault();
        editor.deleteSelection();
      } else if (key === "escape" && useUi.getState().assigning) {
        cancelAssign();
      } else if (key === "escape" && !useUi.getState().placing && !useUi.getState().cableDrag) {
        editor.clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
