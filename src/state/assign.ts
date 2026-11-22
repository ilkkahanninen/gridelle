/**
 * Putting settings on the Organelle's knobs by clicking: a knob of a knob page is armed
 * in the Knob pages panel, and the next knob clicked on the grid goes on it.
 */

import * as ops from "../core/model/ops";
import type { ModuleId } from "../core/model/types";
import { useEditor } from "./store";
import { useUi } from "./ui";

/** Make `slot` the knob that the next click on the grid fills. */
export function armKnob(slot: ops.KnobSlot): void {
  useUi.setState({ assigning: slot });
}

export function cancelAssign(): void {
  if (useUi.getState().assigning) useUi.setState({ assigning: null });
}

/**
 * Put a setting on the armed knob. A setting that was on another knob moves. The next
 * empty knob of the same page is armed after it, so a page is filled with one click per
 * knob; with none left, assigning ends. Returns whether a knob was armed.
 */
export function assignToArmed(module: ModuleId, param: string): boolean {
  const slot = useUi.getState().assigning;
  if (!slot) return false;
  const editor = useEditor.getState();
  const before = editor.doc;
  editor.apply((doc) => ops.assignKnob(doc, slot, { module, param }));
  const after = useEditor.getState().doc;
  // Refused, so the page or the setting is gone: there is nothing left to fill.
  const next = after === before ? null : ops.nextFreeKnob(after, slot.page, slot.knob);
  useUi.setState({ assigning: next === null ? null : { page: slot.page, knob: next } });
  return true;
}
