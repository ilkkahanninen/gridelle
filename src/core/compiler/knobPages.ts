import { toNormalized } from "../modules/params";
import type { ParamDef } from "../modules/types";
import { pdNumber, type Box, type PdPatch, type Position } from "../pd/patch";
import type { Analysis, KnobBinding } from "./analyze";

/** Helper abstraction: one hardware knob on one page, with soft takeover. */
export const KNOB_ABSTRACTION = "ge-knob";

/** The Organelle's screen shows 21 characters per line. */
export const SCREEN_COLUMNS = 21;

/** LED colour per page: green, cyan, blue, magenta, red, yellow, white, then repeating. */
const PAGE_LEDS = [3, 4, 5, 6, 1, 2, 7];

export interface KnobSlotValue {
  /** Receiver that sets the slot's stored knob position, e.g. `ge-slot-0-2`. */
  receiver: string;
  /** Receiver of the parameter the slot controls, e.g. `ge2-cutoff`. */
  param: string;
  /** Knob position (0–1) that corresponds to the parameter's current value. */
  position: number;
}

const paramReceiver = (b: KnobBinding) => `${b.module.instance.id}-${b.param.id}`;
const slotReceiver = (page: number, knob: number) => `ge-slot-${page}-${knob + 1}`;

function currentValue(b: KnobBinding): number {
  const value = b.module.instance.params[b.param.id] ?? b.param.default;
  return Math.min(b.param.max, Math.max(b.param.min, value));
}

/** Every knob slot with the position matching its parameter's current value. */
export function knobSlots(analysis: Analysis): KnobSlotValue[] {
  return analysis.pages.flatMap((page, p) =>
    page.knobs.flatMap((binding, k) =>
      binding
        ? [
            {
              receiver: slotReceiver(p, k),
              param: paramReceiver(binding),
              position: toNormalized(binding.param, currentValue(binding)),
            },
          ]
        : [],
    ),
  );
}

/** Reduce text to characters that are safe as plain atoms in a Pd message box. */
function screenText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9 _.:+#/()&'-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** How many decimals a value is shown with on the Organelle's screen. */
function displayDecimals(param: ParamDef): number {
  if (param.decimals !== undefined) return param.decimals;
  if (param.step && Number.isInteger(param.step)) return 0;
  const span = param.max - param.min;
  return span <= 4 ? 2 : span <= 200 ? 1 : 0;
}

/** Widest a value of this parameter gets on screen, in characters. */
function valueWidth(param: ParamDef): number {
  const decimals = displayDecimals(param);
  const widest = Math.max(pdNumber(Math.trunc(param.min)).length, pdNumber(Math.trunc(param.max)).length);
  return widest + (decimals > 0 ? decimals + 1 : 0);
}

/** `Low-pass Cutoff`, shortened so that label, value and unit fit on one screen line. */
function slotLabel(binding: KnobBinding): string {
  const unit = binding.param.unit ? ` ${binding.param.unit}` : "";
  const room = SCREEN_COLUMNS - valueWidth(binding.param) - unit.length - 1;
  const full = screenText(`${binding.module.def.name} ${binding.param.label}`);
  if (full.length <= room) return full;
  // Keep the parameter name whole and trim the module name.
  const label = screenText(binding.param.label);
  const moduleRoom = room - label.length - 1;
  return moduleRoom >= 3 ? `${full.slice(0, moduleRoom).trim()} ${label}` : label.slice(0, room);
}

function chain(patch: PdPatch, from: Box, objects: string[], at: Position): Box {
  let last = from;
  // Leave out arithmetic that does nothing, to keep the exported patch readable.
  objects = objects.filter((text) => text !== "* 1" && text !== "+ 0" && text !== "- 0" && text !== "/ 1");
  objects.forEach((text, i) => {
    const box = patch.obj(text, { x: at.x, y: at.y + i * 28 });
    patch.connect(last, 0, box, 0);
    last = box;
  });
  return last;
}

/** Objects that turn a knob position (0–1) into the parameter's value, as `fromNormalized` does. */
function scaling(param: ParamDef): string[] {
  const { min, max, step } = param;
  if (param.curve === "exp") {
    return [`* ${pdNumber(Math.log(max / min))}`, "exp", `* ${pdNumber(min)}`];
  }
  if (step) {
    return [`* ${pdNumber((max - min) / step)}`, "+ 0.5", "i", `* ${pdNumber(step)}`, `+ ${pdNumber(min)}`];
  }
  return [`* ${pdNumber(max - min)}`, `+ ${pdNumber(min)}`];
}

/** Objects that round a value for display. Offsetting by floor(min) keeps the rounding on positive numbers. */
function rounding(param: ParamDef): string[] {
  const scale = Math.pow(10, displayDecimals(param));
  const offset = Math.floor(param.min);
  return [
    ...(offset !== 0 ? [`- ${pdNumber(offset)}`] : []),
    ...(scale !== 1 ? [`* ${scale}`] : []),
    "+ 0.5",
    "i",
    ...(scale !== 1 ? [`/ ${scale}`] : []),
    ...(offset !== 0 ? [`+ ${pdNumber(offset)}`] : []),
  ];
}

/**
 * Add the knob-page section to `main.pd`:
 *
 * - Aux steps through the pages; the current page number goes to `ge-page`.
 * - Each assigned knob is a `ge-knob` (soft takeover), scaled to its parameter's
 *   range, sent to the parameter, and shown as `Label value unit` on its screen line.
 * - Entering a page shows its name on line 5, sets the LED and blanks unused lines.
 */
export function emitKnobPages(patch: PdPatch, analysis: Analysis, origin: Position): void {
  const pages = analysis.pages;
  if (pages.length === 0) return;
  const COLUMN = 190;

  // Page selection.
  const start = patch.obj("loadbang", origin);
  const first = patch.msg("0", { x: origin.x, y: origin.y + 28 });
  const send = patch.obj("s ge-page", { x: origin.x, y: origin.y + 196 });
  patch.connect(start, 0, first, 0);
  patch.connect(first, 0, send, 0);
  if (pages.length > 1) {
    const aux = patch.obj("r aux", { x: origin.x + 80, y: origin.y });
    const press = patch.obj("sel 1", { x: origin.x + 80, y: origin.y + 28 });
    const current = patch.obj("f", { x: origin.x + 80, y: origin.y + 56 });
    const next = patch.obj("+ 1", { x: origin.x + 80, y: origin.y + 84 });
    const wrap = patch.obj(`mod ${pages.length}`, { x: origin.x + 80, y: origin.y + 112 });
    const store = patch.obj("t f f", { x: origin.x + 80, y: origin.y + 140 });
    patch.connect(aux, 0, press, 0);
    patch.connect(press, 0, current, 0);
    patch.connect(current, 0, next, 0);
    patch.connect(next, 0, wrap, 0);
    patch.connect(wrap, 0, store, 0);
    patch.connect(store, 1, current, 1);
    patch.connect(store, 0, send, 0);
  }

  // What each page shows when it becomes current.
  const pageY = origin.y + 240;
  const receive = patch.obj("r ge-page", { x: origin.x, y: pageY });
  const select = patch.obj(`sel ${pages.map((_, i) => i).join(" ")}`, { x: origin.x, y: pageY + 28 });
  patch.connect(receive, 0, select, 0);
  pages.forEach((page, p) => {
    const counter = `${p + 1}/${pages.length}`;
    const name = screenText(page.name).slice(0, SCREEN_COLUMNS - counter.length - 1) || "Page";
    const blanks = page.knobs.flatMap((binding, k) => (binding ? [] : [`; screenLine${k + 1} -`]));
    const header = patch.msg(
      [`; screenLine5 ${name} ${counter}`, `; led ${PAGE_LEDS[p % PAGE_LEDS.length]}`, ...blanks].join(" "),
      { x: origin.x + p * COLUMN, y: pageY + 62 },
    );
    patch.connect(select, p, header, 0);
  });

  // One column per assigned knob.
  let column = 0;
  pages.forEach((page, p) => {
    page.knobs.forEach((binding, k) => {
      if (!binding) return;
      const at = { x: origin.x + column++ * COLUMN, y: pageY + 120 };
      const position = toNormalized(binding.param, currentValue(binding));
      const knob = patch.obj(`${KNOB_ABSTRACTION} ${p} ${k + 1} ${pdNumber(position)}`, at);
      const value = chain(patch, knob, scaling(binding.param), { x: at.x, y: at.y + 28 });
      const below = at.y + 28 * 7;
      const param = patch.obj(`s ${paramReceiver(binding)}`, { x: at.x, y: below });
      patch.connect(value, 0, param, 0);
      const shown = chain(patch, value, rounding(binding.param), { x: at.x + 90, y: below });
      const unit = binding.param.unit ? ` ${binding.param.unit}` : "";
      const line = patch.msg(`${slotLabel(binding)} $1${unit}`, { x: at.x + 90, y: below + 28 * 7 });
      const screen = patch.obj(`s screenLine${k + 1}`, { x: at.x + 90, y: below + 28 * 8 });
      patch.connect(shown, 0, line, 0);
      patch.connect(line, 0, screen, 0);
    });
  });
}

/** Whether the patch needs the `ge-knob` abstraction. */
export function usesKnobs(analysis: Analysis): boolean {
  return analysis.pages.some((page) => page.knobs.some(Boolean));
}
