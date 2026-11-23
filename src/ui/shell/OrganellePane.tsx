import { useEffect, useRef } from "react";
import { exportToOrganelle, sendToOrganelle } from "../../state/actions";
import { useOrganelle, type SendStatus } from "../../state/organelle";
import "./OrganellePane.css";

function statusText(status: SendStatus): string {
  if (status.kind === "idle") return "";
  if (status.kind === "sending") return "Sending…";
  return status.message;
}

/**
 * The two ways a patch gets onto the Organelle, for the side pane of that name: over
 * Wi-Fi, to an address that is remembered, or as a folder for its USB drive.
 */
export function OrganellePane() {
  const address = useOrganelle((s) => s.address);
  const status = useOrganelle((s) => s.status);
  const setAddress = useOrganelle((s) => s.setAddress);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = status.kind === "sending";

  // Without an address, that is the first thing to fill in.
  useEffect(() => {
    if (!useOrganelle.getState().address.trim()) inputRef.current?.focus();
  }, []);

  return (
    <div className="organelle-pane">
      <section>
        <h3>Send over Wi-Fi</h3>
        <p>Puts the patch on the Organelle and starts it there.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendToOrganelle();
          }}
        >
          <label htmlFor="organelle-address">Organelle address</label>
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
          <button className="button button-primary" type="submit" disabled={sending || !address.trim()} title="Send the patch and start it (⇧⌘E)">
            Send to Organelle
          </button>
        </form>
        <p className={`send-status send-status-${status.kind}`} role="status">
          {statusText(status)}
        </p>
      </section>
      <section>
        <h3>Export a folder</h3>
        <p>Writes the patch as a folder, to copy to the Patches folder of the Organelle's USB drive or SD card.</p>
        <button className="button" title="Write the patch as a folder (⌘E)" onClick={() => void exportToOrganelle()}>
          Export…
        </button>
      </section>
    </div>
  );
}
