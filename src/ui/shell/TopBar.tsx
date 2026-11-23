import { newPatch, openPatch, savePatch } from "../../state/actions";
import { usePreview } from "../../state/preview";
import { hasUnsavedChanges, useEditor } from "../../state/store";
import { SidePaneTabs } from "./SidePanes";

/** What keeps the preview from playing the patch as it is. Nothing while all is well. */
function EngineStatus() {
  const engine = usePreview((s) => s.engine);
  const loadError = usePreview((s) => s.loadError);
  const errors = usePreview((s) => s.diagnostics.filter((d) => d.severity === "error").length);
  const inputProblem = usePreview((s) => s.inputProblem);

  if (engine.kind === "starting") return <span className="status">Starting audio…</span>;
  if (engine.kind === "unavailable") {
    return (
      <span className="status status-error" title={engine.message}>
        No audio preview
      </span>
    );
  }
  if (loadError) {
    return (
      <span className="status status-error" title={loadError}>
        Pd could not load the patch
      </span>
    );
  }
  if (errors > 0) {
    return <span className="status status-error">Fix {errors === 1 ? "1 problem" : `${errors} problems`} to hear changes</span>;
  }
  if (inputProblem) {
    return (
      <span className="status status-error" title={`${inputProblem} The patch plays, with silence where its Audio In is.`}>
        No audio input for Audio In
      </span>
    );
  }
  return null;
}

export function TopBar() {
  const name = useEditor((s) => s.doc.name);
  const unsaved = useEditor(hasUnsavedChanges);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const { undo, redo } = useEditor.getState();

  return (
    <header className="topbar">
      <div className="topbar-title">
        <strong>{name || "Untitled"}</strong>
        {unsaved && <span className="topbar-unsaved" title="Unsaved changes" aria-label="Unsaved changes" />}
      </div>
      <div className="topbar-group">
        <button className="button" onClick={() => void newPatch()}>New</button>
        <button className="button" onClick={() => void openPatch()}>Open…</button>
        <button className="button" onClick={() => void savePatch()}>Save</button>
      </div>
      <div className="topbar-group">
        <button className="button" onClick={undo} disabled={!canUndo}>Undo</button>
        <button className="button" onClick={redo} disabled={!canRedo}>Redo</button>
      </div>
      <div className="topbar-spacer" />
      <EngineStatus />
      <SidePaneTabs />
    </header>
  );
}
