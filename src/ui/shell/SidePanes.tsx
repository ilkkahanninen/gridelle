import type { ComponentType } from "react";
import { useUi, type SidePaneId } from "../../state/ui";
import { SamplesPane } from "../samples/SamplesPane";
import { OrganellePane } from "./OrganellePane";

/**
 * A pane that opens at the right of the window, from a tab in the top bar above it. To
 * add one: an id (`SidePaneId` in `state/ui.ts`), its tab's name, and the component that
 * fills the pane.
 */
interface SidePane {
  id: SidePaneId;
  label: string;
  Pane: ComponentType;
}

export const SIDE_PANES: SidePane[] = [
  { id: "samples", label: "Samples", Pane: SamplesPane },
  { id: "organelle", label: "Organelle", Pane: OrganellePane },
];

const PANE_ID = "side-pane";

function Tab({ pane }: { pane: SidePane }) {
  const open = useUi((s) => s.sidePane === pane.id);
  return (
    <button
      className={`pane-tab${open ? " pane-tab-open" : ""}`}
      aria-expanded={open}
      aria-controls={open ? PANE_ID : undefined}
      onClick={() => useUi.setState({ sidePane: open ? null : pane.id })}
    >
      {pane.label}
    </button>
  );
}

/** The tabs of the side panes, at the right end of the top bar. A click on the open one closes it. */
export function SidePaneTabs() {
  return (
    <div className="pane-tabs" role="group" aria-label="Panes">
      {SIDE_PANES.map((pane) => (
        <Tab key={pane.id} pane={pane} />
      ))}
    </div>
  );
}

/** The side pane that is open, under its tab and beside the module browser and the grid. Nothing when none is. */
export function OpenSidePane() {
  const pane = useUi((s) => SIDE_PANES.find((p) => p.id === s.sidePane));
  if (!pane) return null;
  return (
    <aside className="side-pane" id={PANE_ID} aria-label={pane.label}>
      <pane.Pane />
    </aside>
  );
}
