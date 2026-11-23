import * as ops from "../core/model/ops";
import type { ModuleId } from "../core/model/types";
import { visibleDef } from "../core/modules/shape";
import { cellCentredOn, tileRect, viewShowing } from "../ui/canvas/geometry";
import { useEditor } from "./store";
import { gridPointer, useUi } from "./ui";

/**
 * The modules last copied or cut. It is the editor's own and not the computer's
 * clipboard, and it outlasts the patch: copy, open another preset, paste.
 */
let clip: ops.Clip | null = null;

/** Move the view, if it has to, so that new modules are on show: there may be room for them only off to a side. */
function show(ids: readonly ModuleId[]): void {
  const { doc } = useEditor.getState();
  const rects = doc.modules.flatMap((m) => {
    const def = ids.includes(m.id) && visibleDef(doc, m);
    return def ? [tileRect(m, def)] : [];
  });
  if (rects.length === 0) return;
  const left = Math.min(...rects.map((r) => r.left));
  const top = Math.min(...rects.map((r) => r.top));
  const width = Math.max(...rects.map((r) => r.left + r.width)) - left;
  const height = Math.max(...rects.map((r) => r.top + r.height)) - top;
  const { view, viewport, setView } = useUi.getState();
  const next = viewShowing(view, viewport, { left, top, width, height });
  if (next !== view) setView(next);
}

/** Copy the selected modules. With none selected, what was copied before stays. */
export function copySelection(): boolean {
  const { doc, selection } = useEditor.getState();
  const copied = ops.copyModules(doc, selection);
  if (copied) clip = copied;
  return !!copied;
}

export function cutSelection(): void {
  if (copySelection()) useEditor.getState().deleteSelection();
}

/**
 * Paste what was copied with its middle under the pointer, or in the middle of the view
 * when the pointer is not over the grid; from there it goes to the nearest free cells.
 */
export function pasteClipboard(): void {
  if (!clip) return;
  const { view, viewport } = useUi.getState();
  const spot = gridPointer.at ?? { x: viewport.width / 2, y: viewport.height / 2 };
  const world = { x: (spot.x - view.panX) / view.zoom, y: (spot.y - view.panY) / view.zoom };
  show(useEditor.getState().paste(clip, cellCentredOn(world, ops.clipSize(clip))));
}

/** Copy the selected modules to right below themselves (`ops.duplicateModules`). The clipboard is left as it is. */
export function duplicateSelection(): void {
  show(useEditor.getState().duplicateSelection());
}
