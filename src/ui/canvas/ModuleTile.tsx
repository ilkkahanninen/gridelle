import { memo, useState } from "react";
import * as ops from "../../core/model/ops";
import type { ModuleInstance } from "../../core/model/types";
import { formatParam, fromNormalized, toNormalized } from "../../core/modules/params";
import type { ModuleDef, ParamDef, PortDef } from "../../core/modules/types";
import { useEditor } from "../../state/store";
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
  onTilePointerDown(e: React.PointerEvent, id: string): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}

const VOICE_SIGNAL_LABEL = { pitch: "the played note", gate: "the key gate", velocity: "key velocity" } as const;

function ParamKnob({ module, param, size = 30 }: { module: ModuleInstance; param: ParamDef; size?: number }) {
  const [active, setActive] = useState(false);
  const value = ops.paramValue(module, param.id);
  // Which Organelle knob (1–4) plays this parameter, or 0 for none.
  const hardwareKnob = useEditor((s) => (ops.findAssignment(s.doc, module.id, param.id)?.knob ?? -1) + 1);
  return (
    <div
      className="tile-knob"
      onPointerEnter={() => setActive(true)}
      onPointerLeave={(e) => e.buttons === 0 && setActive(false)}
      onPointerUp={(e) => !e.currentTarget.matches(":hover") && setActive(false)}
      title={`${param.label}: ${formatParam(param, value)}`}
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
        <span className="tile-knob-badge" title={`On Organelle knob ${hardwareKnob}`}>
          {hardwareKnob}
        </span>
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
  onPointerDown,
}: {
  module: ModuleInstance;
  def: ModuleDef;
  port: PortDef;
  side: "in" | "out";
  index: number;
  cabled: boolean;
  onPointerDown: TileProps["onPortPointerDown"];
}) {
  const precord = side === "in" && !cabled && port.precord && (module.precords?.[port.id] ?? true) ? port.precord : null;
  const hint = precord
    ? `${port.label}: follows ${VOICE_SIGNAL_LABEL[precord]} until you patch a cable in`
    : `${port.label} ${side === "in" ? "input" : "output"}`;
  return (
    <div
      className={`port port-${side} hint-${port.hint}${cabled ? " port-cabled" : ""}${precord ? " port-precord" : ""}`}
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
          onPointerDown={onPortPointerDown}
        />
      ))}
      {def.growsWithInputs
        ? // One row per input: its port on the left and its knob beside it.
          def.params.map((param, i) => (
            <div
              key={param.id}
              className="tile-row-knob"
              style={{ top: portOffset(def, i) }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ParamKnob module={module} param={param} size={24} />
            </div>
          ))
        : def.params.length > 0 && (
            <div className="tile-knobs" onPointerDown={(e) => e.stopPropagation()}>
              {def.params.map((param) => (
                <ParamKnob key={param.id} module={module} param={param} />
              ))}
            </div>
          )}
    </div>
  );
});
