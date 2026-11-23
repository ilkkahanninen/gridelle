import type { ComponentType } from "react";
import { PANE_SIDE, useUi, type PaneSide, type SidePaneId } from "../../state/ui";
import { SamplesPane } from "../samples/SamplesPane";
import { OrganellePane } from "./OrganellePane";
import { PresetsPane } from "./PresetsPane";

/**
 * A pane that opens at one side of the window, from a tab in the top bar above it. To add
 * one: an id and its side (`SidePaneId` and `PANE_SIDE` in `state/ui.ts`), its tab's name,
 * and the component that fills the pane.
 */
interface SidePane {
  id: SidePaneId;
  label: string;
  Pane: ComponentType;
}

export const SIDE_PANES: SidePane[] = [
  { id: "presets", label: "Presets", Pane: PresetsPane },
  { id: "samples", label: "Samples", Pane: SamplesPane },
  { id: "organelle", label: "Organelle", Pane: OrganellePane },
];

const on = (side: PaneSide) => SIDE_PANES.filter((pane) => PANE_SIDE[pane.id] === side);

function Tab({ pane, side }: { pane: SidePane; side: PaneSide }) {
  const open = useUi((s) => s.sidePanes[side] === pane.id);
  return (
    <button
      className={`pane-tab${open ? " pane-tab-open" : ""}`}
      aria-expanded={open}
      aria-controls={open ? `side-pane-${side}` : undefined}
      onClick={() => useUi.setState((s) => ({ sidePanes: { ...s.sidePanes, [side]: open ? null : pane.id } }))}
    >
      {pane.label}
    </button>
  );
}

/** The tabs of one side's panes, at that end of the top bar. A click on the open one closes it. */
export function SidePaneTabs({ side }: { side: PaneSide }) {
  return (
    <div className="pane-tabs" role="group" aria-label={side === "left" ? "Panes on the left" : "Panes on the right"}>
      {on(side).map((pane) => (
        <Tab key={pane.id} pane={pane} side={side} />
      ))}
    </div>
  );
}

/**
 * The pane that is open on one side, under its tab: it takes its width from the module
 * browser and the grid, which move over. Nothing when none is open there.
 */
export function OpenSidePane({ side }: { side: PaneSide }) {
  const pane = useUi((s) => on(side).find((p) => p.id === s.sidePanes[side]));
  if (!pane) return null;
  return (
    <aside className={`side-pane side-pane-${side}`} id={`side-pane-${side}`} aria-label={pane.label}>
      <pane.Pane />
    </aside>
  );
}
