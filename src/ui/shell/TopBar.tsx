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
  const apply = useEditor((s) => s.apply);

  return (
    <header className="topbar">
      <div className="topbar-side">
        <SidePaneTabs side="left" />
      </div>
      <div className="topbar-title" data-text={name || "Untitled"}>
        <input
          className="heading-field"
          type="text"
          aria-label="Patch name"
          value={name}
          placeholder="Untitled"
          size={1}
          maxLength={40}
          spellCheck={false}
          onChange={(e) => apply((doc) => ({ ...doc, name: e.target.value }), "patch-name")}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
          }}
        />
        {unsaved && <span className="topbar-unsaved" title="Unsaved changes" aria-label="Unsaved changes" />}
      </div>
      <div className="topbar-side topbar-side-right">
        <EngineStatus />
        <SidePaneTabs side="right" />
      </div>
    </header>
  );
}
