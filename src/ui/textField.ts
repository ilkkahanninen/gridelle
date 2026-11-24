/**
 * Whether keys and edit commands belong to a text field: an input that takes text (not a
 * slider), a text area, a list, or editable text. Such a field keeps undo, select-all,
 * copy and paste for its own text.
 */
export const isTextField = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) && (target as HTMLInputElement).type !== "range"));
