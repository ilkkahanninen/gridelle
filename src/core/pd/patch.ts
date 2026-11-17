/**
 * Builds the text of a Pd patch file.
 *
 * Callers write box contents the way they appear in Pd (`r $1-cutoff`,
 * `1 $1, $2 $3 $1`); this class does the file-format escaping and keeps track of
 * the box indices that `#X connect` lines refer to.
 */

/** Handle to a box in a patch, for wiring. */
export interface Box {
  readonly index: number;
}

interface Connection {
  from: number;
  outlet: number;
  to: number;
  inlet: number;
}

export interface Position {
  x: number;
  y: number;
}

/** Format a number as a Pd atom: no exponent, at most 6 decimals, no trailing zeros. */
export function pdNumber(value: number): string {
  // Beyond this, toFixed switches to exponent notation and float32 has no precision left anyway.
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) {
    throw new Error(`cannot write ${value} to a Pd patch`);
  }
  const fixed = value.toFixed(6).replace(/\.?0+$/, "");
  return fixed === "-0" || fixed === "" ? "0" : fixed;
}

/**
 * Escape box text for the file: `$` gets a backslash, and `,` / `;` become
 * standalone escaped tokens. An existing backslash would be ambiguous, so it is rejected.
 */
function escapeText(text: string, allowSeparators: boolean): string {
  if (text.includes("\\")) throw new Error(`backslash is not supported in Pd box text: ${text}`);
  if (!allowSeparators && /[,;]/.test(text)) {
    throw new Error(`object boxes cannot contain , or ; : ${text}`);
  }
  return text
    .replace(/\$/g, "\\$")
    .replace(/\s*([,;])\s*/g, " \\$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

export class PdPatch {
  private boxes: string[] = [];
  private connections: Connection[] = [];
  private readonly width: number;
  private readonly height: number;

  constructor(size: { width: number; height: number } = { width: 800, height: 600 }) {
    this.width = size.width;
    this.height = size.height;
  }

  private add(kind: "obj" | "msg" | "text", text: string, at: Position, separators: boolean): Box {
    const body = escapeText(text, separators);
    if (!body) throw new Error("empty Pd box");
    this.boxes.push(`#X ${kind} ${Math.round(at.x)} ${Math.round(at.y)} ${body};`);
    return { index: this.boxes.length - 1 };
  }

  /** An object box, e.g. `obj("clone voice 4", at)`. */
  obj(text: string, at: Position): Box {
    return this.add("obj", text, at, false);
  }

  /** A message box. `,` and `;` separate messages as they do in Pd. */
  msg(text: string, at: Position): Box {
    return this.add("msg", text, at, true);
  }

  /** A comment. Comments count as boxes in Pd's connection numbering, which this handles. */
  comment(text: string, at: Position): Box {
    return this.add("text", text, at, true);
  }

  connect(from: Box, outlet: number, to: Box, inlet: number): void {
    this.connections.push({ from: from.index, outlet, to: to.index, inlet });
  }

  toString(): string {
    const lines = [`#N canvas 0 50 ${this.width} ${this.height} 12;`, ...this.boxes];
    for (const c of this.connections) {
      lines.push(`#X connect ${c.from} ${c.outlet} ${c.to} ${c.inlet};`);
    }
    return lines.join("\n") + "\n";
  }
}
