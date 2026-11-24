import { DOCUMENT_VERSION, KNOBS_PER_PAGE, NOTE_PRIORITIES, SAMPLE_SLOTS, type NotePriority, type PatchDocument } from "./types";

/** File extension for saved patches. */
export const FILE_EXTENSION = "gridelle";

export function serializeDocument(doc: PatchDocument): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPortRef = (v: unknown) => isRecord(v) && typeof v.module === "string" && typeof v.port === "string";
const isNumberMap = (v: unknown) => isRecord(v) && Object.values(v).every((n) => typeof n === "number" && Number.isFinite(n));

/**
 * Read a saved patch. Throws an Error with a message fit to show the user when the
 * text is not a patch this version can open. Unknown module types are kept: the
 * compiler reports them, and the file is not silently altered.
 */
export function parseDocument(text: string): PatchDocument {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("This file is not a Gridelle patch.");
  }
  if (!isRecord(data) || typeof data.version !== "number") throw new Error("This file is not a Gridelle patch.");
  if (data.version > DOCUMENT_VERSION) {
    throw new Error("This patch was saved by a newer version of Gridelle.");
  }
  if (data.version < DOCUMENT_VERSION) {
    throw new Error("This patch was saved by an older version of Gridelle, from before the voice area, and cannot be opened.");
  }

  const modulesOk =
    Array.isArray(data.modules) &&
    data.modules.every(
      (m) =>
        isRecord(m) &&
        typeof m.id === "string" &&
        typeof m.type === "string" &&
        Number.isInteger(m.x) &&
        Number.isInteger(m.y) &&
        isNumberMap(m.params) &&
        (m.name === undefined || typeof m.name === "string") &&
        (m.precords === undefined || (isRecord(m.precords) && Object.values(m.precords).every((b) => typeof b === "boolean"))),
    );
  const cablesOk = Array.isArray(data.cables) && data.cables.every((c) => isRecord(c) && isPortRef(c.from) && isPortRef(c.to));
  const pagesOk =
    Array.isArray(data.pages) &&
    data.pages.every(
      (p) =>
        isRecord(p) &&
        typeof p.name === "string" &&
        Array.isArray(p.knobs) &&
        p.knobs.length === KNOBS_PER_PAGE &&
        p.knobs.every((k) => k === null || (isRecord(k) && typeof k.module === "string" && typeof k.param === "string")),
    );
  const isText = (value: unknown) => typeof value === "string";
  const isCount = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const samplesOk =
    data.samples === undefined ||
    (Array.isArray(data.samples) &&
      data.samples.length <= SAMPLE_SLOTS &&
      data.samples.every(
        (s) =>
          s === null ||
          (isRecord(s) &&
            ((s.kind === "file" &&
              isText(s.path) &&
              isText(s.name) &&
              isCount(s.frames) &&
              isCount(s.sampleRate) &&
              (s.cycle === undefined || isCount(s.cycle))) ||
              (s.kind === "tape" && isCount(s.seconds)) ||
              (s.kind === "wavetable" && isText(s.bank)))),
      ));
  const isArea = (area: unknown) =>
    isRecord(area) &&
    Number.isInteger(area.x) &&
    Number.isInteger(area.y) &&
    Number.isInteger(area.width) &&
    Number.isInteger(area.height) &&
    (area.width as number) >= 0 &&
    (area.height as number) >= 0;
  const areaOk = isArea(data.voiceArea);
  const groupsOk =
    data.groups === undefined ||
    (Array.isArray(data.groups) && data.groups.every((g) => isRecord(g) && isText(g.id) && isArea(g.area) && typeof g.size === "number"));
  const voicing = data.voicing;
  const voicingOk =
    voicing === undefined ||
    (isRecord(voicing) &&
      (voicing.mode === "poly" || voicing.mode === "mono") &&
      NOTE_PRIORITIES.includes(voicing.priority as NotePriority) &&
      typeof voicing.legato === "boolean");
  if (
    typeof data.name !== "string" ||
    typeof data.voices !== "number" ||
    !voicingOk ||
    !areaOk ||
    !groupsOk ||
    !modulesOk ||
    !cablesOk ||
    !pagesOk ||
    !samplesOk
  ) {
    throw new Error("This patch file is damaged and cannot be opened.");
  }
  return data as unknown as PatchDocument;
}

/**
 * Folder name for an exported patch. The Organelle's installer mishandles spaces,
 * so the name is reduced to letters, digits, `-` and `_`.
 */
export function exportFolderName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 40);
  return cleaned || "Gridelle_Patch";
}
