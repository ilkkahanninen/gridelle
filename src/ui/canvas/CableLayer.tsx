import { sameCable } from "../../core/model/ops";
import type { Cable, PortRef } from "../../core/model/types";
import type { SignalHint } from "../../core/modules/types";
import { useEditor } from "../../state/store";
import { useUi } from "../../state/ui";
import { cablePath, type Point } from "./geometry";
import { portUnder } from "./GridCanvas";

interface Props {
  cables: Cable[];
  portPoint(ref: PortRef, side: "in" | "out"): Point | null;
  hintOf(cable: Cable): SignalHint;
  onPortPointerDown(e: React.PointerEvent, module: string, port: string, side: "in" | "out"): void;
}

/** All cables, plus the one being dragged. Drawn above the tiles, as in a real patch bay. */
export function CableLayer({ cables, portPoint, hintOf, onPortPointerDown }: Props) {
  const selectedCable = useEditor((s) => s.selectedCable);
  const drag = useUi((s) => s.cableDrag);

  const dragFrom = drag && portPoint(drag.anchor, drag.anchorSide);
  const dragHint = drag
    ? drag.anchorSide === "out"
      ? hintOf({ from: drag.anchor, to: drag.anchor })
      : "audio"
    : null;

  return (
    <svg className="cables" width="1" height="1">
      {cables.map((cable) => {
        // The cable being re-patched is drawn by the drag preview instead.
        if (drag?.detached && sameCable(drag.detached, cable)) return null;
        const from = portPoint(cable.from, "out");
        const to = portPoint(cable.to, "in");
        if (!from || !to) return null;
        const d = cablePath(from, to);
        const selected = !!selectedCable && sameCable(selectedCable, cable);
        return (
          <g
            key={`${cable.from.module}.${cable.from.port}>${cable.to.module}.${cable.to.port}`}
            className={`cable hint-${hintOf(cable)}${selected ? " cable-selected" : ""}`}
            onPointerDown={(e) => {
              // A cable's end lies on top of its port; a press there is meant for the port.
              const port = portUnder(e.clientX, e.clientY);
              if (port) {
                onPortPointerDown(e, port.module, port.port, port.side);
                return;
              }
              e.stopPropagation();
              useEditor.getState().selectCable(cable);
            }}
          >
            <path className="cable-hit" d={d} />
            <path className="cable-shadow" d={d} />
            <path className="cable-line" d={d} />
          </g>
        );
      })}
      {drag && dragFrom && (
        <path
          className={`cable-line cable-dragging hint-${dragHint}`}
          d={drag.anchorSide === "out" ? cablePath(dragFrom, drag.cursor) : cablePath(drag.cursor, dragFrom)}
        />
      )}
    </svg>
  );
}
