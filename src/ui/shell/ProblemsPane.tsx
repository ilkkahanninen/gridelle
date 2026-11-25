import { dismissConsole, usePreview } from "../../state/preview";
import "./ProblemsPane.css";

/** What Pd printed while it ran the patch, errors marked, with a button that clears it. */
export function ProblemsPane() {
  const lines = usePreview((s) => s.console);
  return (
    <div className="problems-pane">
      <header>
        <h3>Pd console</h3>
        <button className="button" onClick={dismissConsole}>
          Dismiss
        </button>
      </header>
      <ul aria-label="Pd console">
        {lines.map((line, i) => (
          <li key={i} className={line.error ? "console-error" : undefined}>
            {line.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
