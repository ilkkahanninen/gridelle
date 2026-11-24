import { AREA_BORDER, VOICE_NOTES } from "../../core/model/area";
import * as ops from "../../core/model/ops";
import { MIN_AREA } from "../../core/model/ops";
import { MAX_VOICES, MIN_VOICES, voicingOf, type Area } from "../../core/model/types";
import { useEditor } from "../../state/store";
import { CELL, type Point } from "./geometry";
import "./VoiceArea.css";

/** Which part of the voice area a press took hold of: the header moves it, an edge resizes it. */
export type AreaGrip = "move" | "left" | "right" | "bottom" | "corner";

/** How far in from the area's left edge the Notes input is: clear of its rounded corner. */
const NOTES_INSET = 26;

/** Where the voices' Notes input is, on the left of the area's header, in world pixels. */
export const notesPortPoint = (area: Area): Point => ({ x: area.x * CELL + NOTES_INSET, y: area.y * CELL + CELL / 2 });

/** The area with its header or a side of its border moved by `cells`. Never smaller than `MIN_AREA`. */
export function gripped(area: Area, grip: AreaGrip, cells: { x: number; y: number }): Area {
  const width = (w: number) => Math.max(MIN_AREA.width, w);
  const height = (h: number) => Math.max(MIN_AREA.height, h);
  switch (grip) {
    case "move":
      return { ...area, x: area.x + cells.x, y: area.y + cells.y };
    case "left": {
      const x = Math.min(area.x + cells.x, area.x + area.width - MIN_AREA.width);
      return { ...area, x, width: area.x + area.width - x };
    }
    case "right":
      return { ...area, width: width(area.width + cells.x) };
    case "bottom":
      return { ...area, height: height(area.height + cells.y) };
    case "corner":
      return { ...area, width: width(area.width + cells.x), height: height(area.height + cells.y) };
  }
}

/**
 * The voice area on the grid: a dark panel with rounded corners under the modules that run
 * in every voice. Its outer ring of cells is its border, where no module goes, so that
 * inside and outside never touch; it is the same dark as the inside, and is what is taken
 * hold of: the top row, the header (the number of voices, the voices' Notes input), moves
 * the area, and the sides, the bottom and the corner resize it. What is inside is drawn by
 * the canvas, not here, and presses there go through to the grid.
 */
export function VoiceArea({
  area,
  blocked,
  notesCabled,
  onGrip,
  onPortPointerDown,
}: {
  /** Where the area is drawn: where it is, or where a drag would put it. */
  area: Area;
  /** The drag would put a tile on its border, or on another. */
  blocked: boolean;
  /** A cable brings the voices their notes; without one they get the keyboard's. */
  notesCabled: boolean;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}) {
  const voices = useEditor((s) => s.doc.voices);
  const { mode, unison } = useEditor((s) => voicingOf(s.doc));
  const most = Math.floor(MAX_VOICES / unison);
  const setVoices = (n: number) => useEditor.getState().apply((doc) => ops.setVoices(doc, n));
  const stop = (e: React.PointerEvent) => e.stopPropagation();
  const border = AREA_BORDER * CELL;
  const [width, height] = [area.width * CELL, area.height * CELL];
  const grip = (kind: AreaGrip, style: React.CSSProperties) => (
    <div className={`voice-area-grip voice-area-${kind}`} style={style} onPointerDown={(e) => onGrip(e, kind)} title="Drag to resize the voice area" />
  );
  return (
    <div className={`voice-area${blocked ? " voice-area-blocked" : ""}`} style={{ left: area.x * CELL, top: area.y * CELL, width, height }}>
      {grip("left", { left: 0, top: border, width: border, height: height - 2 * border })}
      {grip("right", { left: width - border, top: border, width: border, height: height - 2 * border })}
      {grip("bottom", { left: 0, top: height - border, width: width - border, height: border })}
      {grip("corner", { left: width - border, top: height - border, width: border, height: border })}
      <div
        className="voice-area-grip voice-area-header"
        style={{ left: 0, top: 0, width, height: border }}
        onPointerDown={(e) => onGrip(e, "move")}
        title="Drag to move the voice area with what is in it"
      >
        {/* The notes the voices play: the keyboard's, or a note module's patched in here. */}
        <div
          className={`port port-in hint-notes voice-area-notes${notesCabled ? " port-cabled" : " port-precord"}`}
          style={{ top: CELL / 2, left: NOTES_INSET }}
          data-port-module={VOICE_NOTES.module}
          data-port-id={VOICE_NOTES.port}
          data-port-side="in"
          title={
            notesCabled
              ? "Notes: what the voices play, one note to each voice."
              : "Notes: the voices play the keyboard's, until you patch in a note output (an arpeggiator's)."
          }
          onPointerDown={(e) => onPortPointerDown(e, VOICE_NOTES.module, VOICE_NOTES.port, "in")}
        >
          <span className="port-dot" />
          <span className="port-label">Notes</span>
        </div>
        {/* Poly: the notes at once, to change here. Mono: one note. The rest is in the settings pane. */}
        <span className="voice-area-title">{mode === "mono" ? "Mono" : "Voices"}</span>
        {mode === "poly" && (
          <span className="voice-area-count" onPointerDown={stop}>
            <button type="button" aria-label="One voice fewer" disabled={voices <= MIN_VOICES} onClick={() => setVoices(voices - 1)}>
              −
            </button>
            <span aria-label="Number of voices">{voices}</span>
            <button type="button" aria-label="One voice more" disabled={voices >= most} onClick={() => setVoices(voices + 1)}>
              +
            </button>
          </span>
        )}
        {unison > 1 && (
          <span className="voice-area-unison" title={`Unison: each note on ${unison} voices`}>
            ×{unison}
          </span>
        )}
      </div>
    </div>
  );
}
