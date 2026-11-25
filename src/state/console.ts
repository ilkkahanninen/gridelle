/** A line Pd printed, as the Problems pane shows it. */
export interface ConsoleLine {
  text: string;
  /** Pd printed it as an error: the pane opens for it. */
  error: boolean;
}

/** How many lines are kept: the oldest go first. */
export const CONSOLE_LINES = 200;

/**
 * A line as libpd prints it, or `null` for one Pd's own window hides by default. libpd marks
 * the level: `error: ` before an error, `verbose(n): ` before a message posted at level n
 * (0 critical and 1 error, as in "... couldn't create"; 2 normal; 3 and up debug), and
 * nothing before a normal post or what a `[print]` prints.
 */
export function consoleLine(raw: string): ConsoleLine | null {
  const error = /^error: ?(.*)$/s.exec(raw);
  if (error) return { text: error[1], error: true };
  const level = /^verbose\((\d+)\): ?(.*)$/s.exec(raw);
  if (level) {
    const n = Number(level[1]);
    return n > 2 ? null : { text: level[2], error: n < 2 };
  }
  return { text: raw, error: false };
}

/**
 * The lines with `line` added, or the same array when an identical line is there already: a
 * patch that reloads prints its errors again, and they are not news.
 */
export function withLine(lines: ConsoleLine[], line: ConsoleLine): ConsoleLine[] {
  if (lines.some((old) => old.text === line.text && old.error === line.error)) return lines;
  return [...lines.slice(-(CONSOLE_LINES - 1)), line];
}
