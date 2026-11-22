import type { ParamDef } from "./types";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function snap(param: ParamDef, value: number): number {
  const stepped = param.step ? Math.round(value / param.step) * param.step : value;
  return Math.min(param.max, Math.max(param.min, stepped));
}

/** Control position (0–1) → value in the parameter's units, snapped to its step. */
export function fromNormalized(param: ParamDef, position: number): number {
  const t = clamp01(position);
  const value =
    param.curve === "exp"
      ? param.min * Math.pow(param.max / param.min, t)
      : param.min + (param.max - param.min) * t;
  return snap(param, value);
}

/** Value in the parameter's units → control position (0–1). */
export function toNormalized(param: ParamDef, value: number): number {
  const v = Math.min(param.max, Math.max(param.min, value));
  return clamp01(
    param.curve === "exp"
      ? Math.log(v / param.min) / Math.log(param.max / param.min)
      : (v - param.min) / (param.max - param.min),
  );
}

/** Keep a value inside the parameter's range and on its step. */
export function clampParam(param: ParamDef, value: number): number {
  return snap(param, Number.isFinite(value) ? value : param.default);
}

/** Short readout for tiles and the inspector, e.g. `1.2 kHz`, `-12 st`, `0.60`. */
export function formatParam(param: ParamDef, value: number): string {
  if (param.options) return param.options[clampParam(param, value)] ?? "";
  if (param.unit === "Hz" && value >= 1000) return `${trim(value / 1000, 2)} kHz`;
  if (param.unit === "ms" && value >= 1000) return `${trim(value / 1000, 2)} s`;
  const span = param.max - param.min;
  const digits = param.step && Number.isInteger(param.step) ? 0 : span <= 4 ? 2 : Math.abs(value) < 10 ? 1 : 0;
  const text = trim(value, digits, span <= 4);
  return param.unit ? `${text} ${param.unit}` : text;
}

function trim(value: number, digits: number, keepZeros = false): string {
  const fixed = value.toFixed(digits);
  return keepZeros ? fixed : fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
