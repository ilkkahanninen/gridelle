import { memo, useState } from "react";
import * as ops from "../../core/model/ops";
import { KNOBS_PER_PAGE, type ModuleInstance } from "../../core/model/types";
import { formatParam, fromNormalized, toNormalized } from "../../core/modules/params";
import type { ModuleDef, ParamDef, PortDef } from "../../core/modules/types";
import { assignToArmed } from "../../state/assign";
import { useEditor } from "../../state/store";
import { shownKnobPage, useUi } from "../../state/ui";
import { Knob } from "../controls/Knob";
import { PORT_INSET, portOffset, tileRect } from "./geometry";

interface TileProps {
  module: ModuleInstance;
  def: ModuleDef;
  selected: boolean;
  /** Pixel offset while the tile is being dragged. */
  offset: { x: number; y: number } | null;
  /** The drag would land on another module. */
  blocked: boolean;
  /** Ports that currently have a cable, as `in:<id>` / `out:<id>`. */
  connected: ReadonlySet<string>;
  /** The port a module in hand would be cabled to, as `in:<id>` / `out:<id>`. */
  dropTarget: string | null;
  onTilePointerDown(e: React.PointerEvent, id: string): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}

/** Width a knob takes in a tile's row of knobs, and the space between two of them (see canvas.css). */
const KNOB_WIDTH = 44;
const KNOB_GAP = 7;

/**
 * The click that last put a setting on an Organelle knob. A second click on the same tile
 * knob straight after it is the rest of a double-click: it neither assigns again nor
 * resets the value.
 */
let lastAssigned = { knob: "", at: 0 };
const DOUBLE_CLICK_MS = 500;

const VOICE_SIGNAL_LABEL = { pitch: "the played note", gate: "the key gate", velocity: "key velocity" } as const;

function ParamKnob({ module, param, size = 30 }: { module: ModuleInstance; param: ParamDef; size?: number }) {
  const [active, setActive] = useState(false);
  const value = ops.paramValue(module, param.id);
  // The knob page and Organelle knob (0–3) that play this parameter, as one number so that
  // the selector's result compares equal from edit to edit; -1 for none.
  const slot = useEditor((s) => {
    const found = ops.findAssignment(s.doc, module.id, param.id);
    return found ? found.page * KNOBS_PER_PAGE + found.knob : -1;
  });
  const page = Math.floor(slot / KNOBS_PER_PAGE);
  const hardwareKnob = slot < 0 ? 0 : (slot % KNOBS_PER_PAGE) + 1;
  const pageName = useEditor((s) => s.doc.pages[page]?.name || `Page ${page + 1}`);
  const pageCount = useEditor((s) => s.doc.pages.length);
  const onShownPage = page === shownKnobPage(useUi((s) => s.knobPage), pageCount);
  return (
    <div
      className="tile-knob"
      // Not while something is being dragged across the tile: the label would keep showing the value.
      onPointerEnter={(e) => e.buttons === 0 && setActive(true)}
      onPointerLeave={(e) => e.buttons === 0 && setActive(false)}
      onPointerUp={(e) => !e.currentTarget.matches(":hover") && setActive(false)}
      // While an Organelle knob is armed, a click here assigns this setting instead of turning the knob.
      onPointerDownCapture={(e) => {
        if (e.button !== 0) return;
        const knob = `${module.id}:${param.id}`;
        const again = lastAssigned.knob === knob && e.timeStamp - lastAssigned.at < DOUBLE_CLICK_MS;
        if (!again && !assignToArmed(module.id, param.id)) return;
        e.stopPropagation();
        e.preventDefault();
        if (!again) lastAssigned = { knob, at: e.timeStamp };
      }}
      onDoubleClickCapture={(e) => e.timeStamp - lastAssigned.at < 2 * DOUBLE_CLICK_MS && e.stopPropagation()}
      title={`${param.label}: ${formatParam(param, value)}${hardwareKnob > 0 ? ` (${pageName}, knob ${hardwareKnob})` : ""}`}
    >
      <Knob
        size={size}
        value={toNormalized(param, value)}
        defaultValue={toNormalized(param, param.default)}
        label={active ? formatParam(param, value) : param.label}
        ariaLabel={param.label}
        onChange={(position) =>
          useEditor
            .getState()
            .apply((doc) => ops.setParam(doc, module.id, param.id, fromNormalized(param, position)), `param:${module.id}:${param.id}`)
        }
      />
      {hardwareKnob > 0 && (
        <button
          className={`tile-knob-badge page-color-${page}${onShownPage ? " tile-knob-badge-shown" : ""}`}
          title={`${pageName}, knob ${hardwareKnob}. Click to show this knob page.`}
          aria-label={`Show knob page ${pageName}`}
          onClick={() => useUi.setState({ knobPage: page })}
        >
          {hardwareKnob}
        </button>
      )}
    </div>
  );
}

function Port({
  module,
  def,
  port,
  side,
  index,
  cabled,
  target,
  onPointerDown,
}: {
  module: ModuleInstance;
  def: ModuleDef;
  port: PortDef;
  side: "in" | "out";
  index: number;
  cabled: boolean;
  target: boolean;
  onPointerDown: TileProps["onPortPointerDown"];
}) {
  const precord = side === "in" && !cabled && port.precord && (module.precords?.[port.id] ?? true) ? port.precord : null;
  const hint = precord
    ? `${port.label}: follows ${VOICE_SIGNAL_LABEL[precord]} until you patch a cable in`
    : `${port.label} ${side === "in" ? "input" : "output"}`;
  return (
    <div
      className={`port port-${side} hint-${port.hint}${cabled ? " port-cabled" : ""}${precord ? " port-precord" : ""}${target ? " port-target" : ""}`}
      style={{ top: portOffset(def, index), [side === "in" ? "left" : "right"]: PORT_INSET }}
      data-port-module={module.id}
      data-port-id={port.id}
      data-port-side={side}
      title={hint}
      onPointerDown={(e) => onPointerDown(e, module.id, port.id, side)}
    >
      <span className="port-dot" />
      <span className="port-label">{port.label}</span>
    </div>
  );
}

export const ModuleTile = memo(function ModuleTile({
  module,
  def,
  selected,
  offset,
  blocked,
  connected,
  dropTarget,
  onTilePointerDown,
  onPortPointerDown,
}: TileProps) {
  const rect = tileRect(module, def);
  const classes = ["tile", `category-${def.category}`];
  if (selected) classes.push("tile-selected");
  if (offset) classes.push("tile-dragging");
  if (blocked) classes.push("tile-blocked");
  if (def.width === 1) classes.push("tile-narrow");
  if (def.growsWithInputs) classes.push("tile-rows");
  // Choices are made in the inspector; everything else gets a knob on the tile.
  const knobs = def.params.filter((param) => !param.options);
  const dense = knobs.length * (KNOB_WIDTH + KNOB_GAP) - KNOB_GAP > rect.width;

  return (
    <div
      className={classes.join(" ")}
      style={{
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        transform: offset ? `translate(${offset.x}px, ${offset.y}px)` : undefined,
      }}
      data-module={module.id}
      onPointerDown={(e) => onTilePointerDown(e, module.id)}
    >
      <div className="tile-name">{def.name}</div>
      {def.inputs.map((port, i) => (
        <Port
          key={port.id}
          module={module}
          def={def}
          port={port}
          side="in"
          index={i}
          cabled={connected.has(`in:${port.id}`)}
          target={dropTarget === `in:${port.id}`}
          onPointerDown={onPortPointerDown}
        />
      ))}
      {def.outputs.map((port, i) => (
        <Port
          key={port.id}
          module={module}
          def={def}
          port={port}
          side="out"
          index={i}
          cabled={connected.has(`out:${port.id}`)}
          target={dropTarget === `out:${port.id}`}
          onPointerDown={onPortPointerDown}
        />
      ))}
      {def.growsWithInputs
        ? // One row per input: its port on the left and its knob beside it.
          knobs.map((param, i) => (
            <div
              key={param.id}
              className="tile-row-knob"
              style={{ top: portOffset(def, i) }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ParamKnob module={module} param={param} size={24} />
            </div>
          ))
        : knobs.length > 0 && (
            <div className={dense ? "tile-knobs tile-knobs-dense" : "tile-knobs"} onPointerDown={(e) => e.stopPropagation()}>
              {knobs.map((param) => (
                <ParamKnob key={param.id} module={module} param={param} size={dense ? 24 : 30} />
              ))}
            </div>
          )}
    </div>
  );
});
