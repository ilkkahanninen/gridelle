import { useEffect } from "react";
import { exportToOrganelle, newPatch, openPatch, savePatch } from "./state/actions";
import { startPreviewSync } from "./state/preview";
import { useEditor } from "./state/store";
import { useUi } from "./state/ui";
import { GridCanvas } from "./ui/canvas/GridCanvas";
import { Inspector } from "./ui/inspector/Inspector";
import { Palette } from "./ui/palette/Palette";
import { Dock } from "./ui/shell/Dock";
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
        void savePatch(e.shiftKey);
      } else if (command && key === "o") {
        e.preventDefault();
        void openPatch();
      } else if (command && key === "n") {
        e.preventDefault();
        void newPatch();
      } else if (command && key === "e") {
        e.preventDefault();
        void exportToOrganelle();
      } else if (isTextField(e.target)) {
        // Let text fields keep undo, select-all and delete for themselves.
      } else if (command && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (command && key === "a") {
        e.preventDefault();
        editor.select(editor.doc.modules.map((m) => m.id));
      } else if (key === "delete" || key === "backspace") {
        e.preventDefault();
        editor.deleteSelection();
      } else if (key === "escape" && !useUi.getState().placing && !useUi.getState().cableDrag) {
        editor.clearSelection();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function App() {
  useEffect(() => startPreviewSync(), []);
  useShortcuts();

  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <Palette />
        <GridCanvas />
        <Inspector />
      </div>
      <Dock />
    </div>
  );
}

export default App;
