import { useRef, type ReactNode } from "react";
import "./Knob.css";

interface KnobProps {
  /** Normalised position, 0–1. */
  value: number;
  onChange: (value: number) => void;
  /** Position restored on double-click. */
  defaultValue?: number;
  /** Shown under the dial: text, or a field that stands in its place. */
  label?: ReactNode;
  /** A double-click on the label; without it the label takes none. */
  onLabelDoubleClick?: () => void;
  /** Accessible name, when it should differ from the visible label. */
  ariaLabel?: string;
  size?: number;
}

const SWEEP = 270;
const START = -135;

function polar(cx: number, cy: number, r: number, degrees: number) {
  const rad = ((degrees - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
}

function arc(r: number, from: number, to: number) {
  const [x0, y0] = polar(16, 16, r, from);
  const [x1, y1] = polar(16, 16, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

/** Rotary control: drag vertically, hold Shift for fine steps, double-click to reset. */
export function Knob({ value, onChange, defaultValue = 0.5, label, onLabelDoubleClick, ariaLabel, size = 44 }: KnobProps) {
  const drag = useRef<{ y: number; value: number } | null>(null);
  const angle = START + value * SWEEP;
  const [px, py] = polar(16, 16, 7, angle);

  return (
    <div className="knob">
      <svg
        className="knob-dial"
        width={size}
        height={size}
        viewBox="0 0 32 32"
        role="slider"
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(value.toFixed(3))}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, value };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const range = e.shiftKey ? 1200 : 160;
          const next = drag.current.value + (drag.current.y - e.clientY) / range;
          const clamped = Math.min(1, Math.max(0, next));
          // Re-anchor so changing Shift mid-drag does not jump.
          drag.current = { y: e.clientY, value: clamped };
          if (clamped !== value) onChange(clamped);
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={() => onChange(defaultValue)}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.002 : 0.02;
          if (e.key === "ArrowUp" || e.key === "ArrowRight") onChange(Math.min(1, value + step));
          if (e.key === "ArrowDown" || e.key === "ArrowLeft") onChange(Math.max(0, value - step));
        }}
      >
        <path className="knob-track" d={arc(13, START, START + SWEEP)} />
        {value > 0.001 && <path className="knob-value" d={arc(13, START, angle)} />}
        <circle className="knob-cap" cx={16} cy={16} r={9.5} />
        <line className="knob-pointer" x1={16} y1={16} x2={px} y2={py} />
      </svg>
      {label && (
        <span className="knob-label" onDoubleClick={onLabelDoubleClick}>
          {label}
        </span>
      )}
    </div>
  );
}
