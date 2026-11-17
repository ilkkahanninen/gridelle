/**
 * Just enough reading of Pd patch text to check hand-written abstractions against
 * their module definitions and against what the Organelle's Pd can load.
 * It only understands flat patches (no subpatches), which is all `pd-lib` uses.
 */

export interface PdObjectBox {
  /** Object class, e.g. `inlet~`, `r`, `vcf~`. */
  name: string;
  /** Remaining atoms, with file escapes removed (`\$1-cutoff` → `$1-cutoff`). */
  args: string[];
  x: number;
  y: number;
}

/** Object boxes of a patch, in file order. Message boxes and comments are skipped. */
export function objectBoxes(patchText: string): PdObjectBox[] {
  if (/^#N canvas[^;]*;[\s\S]*#N canvas/m.test(patchText)) {
    throw new Error("subpatches are not supported by the pd-lib inspector");
  }
  const boxes: PdObjectBox[] = [];
  // Records end at an unescaped semicolon.
  for (const record of patchText.split(/(?<!\\);/)) {
    const atoms = record.trim().split(/\s+/);
    if (atoms[0] !== "#X" || atoms[1] !== "obj") continue;
    const [x, y, name, ...rest] = atoms.slice(2);
    if (!name) continue;
    // Drop a trailing box-width hint: `, f 12`.
    const hint = rest.indexOf(",");
    const args = (hint >= 0 ? rest.slice(0, hint) : rest).map((a) => a.replace(/\\(.)/g, "$1"));
    boxes.push({ name, args, x: Number(x), y: Number(y) });
  }
  return boxes;
}

const RECEIVE = new Set(["r", "receive"]);

export interface AbstractionInterface {
  signalInlets: number;
  signalOutlets: number;
  controlInlets: number;
  controlOutlets: number;
  /** Parameter ids: the `<id>` of every `[r $1-<id>]`. */
  params: string[];
}

export function abstractionInterface(patchText: string): AbstractionInterface {
  const boxes = objectBoxes(patchText);
  const count = (name: string) => boxes.filter((b) => b.name === name).length;
  const params = boxes
    .filter((b) => RECEIVE.has(b.name) && b.args[0]?.startsWith("$1-"))
    .map((b) => b.args[0].slice(3));
  return {
    signalInlets: count("inlet~"),
    signalOutlets: count("outlet~"),
    controlInlets: count("inlet"),
    controlOutlets: count("outlet"),
    params: [...new Set(params)],
  };
}

/** Distinct object classes a patch instantiates. */
export function objectClasses(patchText: string): string[] {
  return [...new Set(objectBoxes(patchText).map((b) => b.name))].sort();
}
