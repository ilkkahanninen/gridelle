import { useEffect, useRef } from "react";
import { sendToOrganelle } from "../../state/actions";
import { useOrganelle, type SendStatus } from "../../state/organelle";
import "./SendPanel.css";

function statusText(status: SendStatus): string {
  if (status.kind === "idle") return "Sends the patch over Wi-Fi and starts it on the Organelle.";
  if (status.kind === "sending") return "Sending…";
  return status.message;
}

/** The Send button and its panel: where the Organelle is, and how the last send went. */
export function SendToOrganelle() {
  const address = useOrganelle((s) => s.address);
  const open = useOrganelle((s) => s.panelOpen);
  const status = useOrganelle((s) => s.status);
  const setAddress = useOrganelle((s) => s.setAddress);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = status.kind === "sending";

  // A press anywhere else, or Escape, puts the panel away.
  useEffect(() => {
    if (!open) return;
    const close = () => useOrganelle.setState({ panelOpen: false });
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Capture phase: the canvas stops pointer events from bubbling.
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Without an address there is only one thing to do in the panel.
  useEffect(() => {
    if (open && !useOrganelle.getState().address.trim()) inputRef.current?.focus();
  }, [open]);

  return (
    <div className="send" ref={rootRef}>
      <div className="send-buttons">
        <button
          className="button button-primary"
          disabled={sending}
          title="Send the patch over Wi-Fi and start it (⇧⌘E)"
          onClick={() => void sendToOrganelle()}
        >
          Send to Organelle
        </button>
        <button
          className="button button-primary send-toggle"
          aria-label="Organelle address"
          aria-expanded={open}
          title="Organelle address"
          onClick={() => useOrganelle.setState({ panelOpen: !open })}
        >
          ▾
        </button>
      </div>

      {open && (
        <div className="send-panel" role="dialog" aria-label="Send to Organelle">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void sendToOrganelle();
            }}
          >
            <label htmlFor="organelle-address">Organelle address</label>
            <div className="send-row">
              <input
                id="organelle-address"
                ref={inputRef}
                type="text"
                value={address}
                placeholder="IP address or host name"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                onChange={(e) => setAddress(e.target.value)}
              />
              <button className="button" type="submit" disabled={sending || !address.trim()}>
                Send
              </button>
            </div>
          </form>
          <p className={`send-status send-status-${status.kind}`} role="status">
            {statusText(status)}
          </p>
        </div>
      )}
    </div>
  );
}
