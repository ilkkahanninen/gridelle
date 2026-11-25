import { useMemo } from "react";
import { structureKey } from "../../core/compiler/structure";
import { CPU_HIGH, CPU_OVER, estimateCpu } from "../../core/cost";
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

/**
 * About how much of the Organelle's CPU the patch takes (`core/cost.ts`), as a bar and a
 * figure: the bar amber from `CPU_HIGH` and red from `CPU_OVER`, where a tick on it stands,
 * and full beyond 100 %; the tooltip names the costliest modules. It depends only on the
 * patch's structure, so it is worked out again only when that changes.
 */
function CpuMeter() {
  const key = useEditor((s) => structureKey(s.doc));
  const estimate = useMemo(() => estimateCpu(useEditor.getState().doc), [key]);
  const percent = Math.round(estimate.percent);
  const level = percent >= CPU_OVER ? " cpu-over" : percent >= CPU_HIGH ? " cpu-high" : "";
  const costliest = estimate.parts
    .filter((part) => part.percent >= 0.5)
    .slice(0, 3)
    .map((part) => `${part.name}${part.copies > 1 ? ` × ${part.copies}` : ""}: ${Math.round(part.percent)} %`);
  const title = [
    `About ${percent} % of the Organelle's CPU${percent >= CPU_OVER ? ": it will crackle there" : ""}. From about ${CPU_OVER} % it does.`,
    ...(costliest.length > 0 ? [`Costliest: ${costliest.join(", ")}.`] : []),
    "Estimated from measurements on an Organelle M.",
  ].join(" ");
  return (
    <span
      className={`cpu-meter${level}`}
      title={title}
      role="meter"
      aria-label="Organelle CPU"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(percent, 100)}
      aria-valuetext={`About ${percent} %`}
    >
      <span className="cpu-meter-label">CPU</span>
      <span className="cpu-meter-track">
        <span className="cpu-meter-fill" style={{ width: `${Math.min(percent, 100)}%` }} />
        <span className="cpu-meter-limit" style={{ left: `${CPU_OVER}%` }} />
      </span>
      <span className="cpu-meter-figure">{percent} %</span>
    </span>
  );
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
        <CpuMeter />
        <SidePaneTabs side="right" />
      </div>
    </header>
  );
}
