import { useEffect, useRef } from "react";
import { usePreview } from "../../state/preview";
import { VirtualOrganelle } from "../organelle/VirtualOrganelle";
import { KnobPages } from "../pages/KnobPages";

/** Bottom strip: the virtual Organelle to play the patch, its knob pages, and Pd's console. */
export function Dock() {
  const revision = usePreview((s) => s.revision);
  const loadsStarted = usePreview((s) => s.loadsStarted);
  const log = usePreview((s) => s.log);
  const consoleRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <footer className="dock">
      <VirtualOrganelle loadsStarted={loadsStarted} revision={revision} />
      <KnobPages />
      <div className="dock-side">
        <p className="hint">
          Play with <kbd>A</kbd> <kbd>W</kbd> <kbd>S</kbd> <kbd>E</kbd> <kbd>D</kbd> … or the keys on the left.{" "}
          <kbd>Z</kbd> is Aux, which steps through the knob pages.
        </p>
        <pre className="console" ref={consoleRef} aria-label="Pd console">
          {log.length ? log.join("\n") : <span className="console-empty">Messages from Pd appear here.</span>}
        </pre>
      </div>
    </footer>
  );
}
