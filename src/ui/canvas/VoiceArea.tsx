import { AREA_BORDER, VOICE_NOTES } from "../../core/model/area";
import * as ops from "../../core/model/ops";
import { MIN_AREA } from "../../core/model/ops";
import { MAX_UNISON, MAX_VOICES, MIN_UNISON, MIN_VOICES, voicingOf, type Area, type UnisonGroup } from "../../core/model/types";
import { useEditor } from "../../state/store";
import { CELL, type Point } from "./geometry";
import "./VoiceArea.css";

/** Which part of a container a press took hold of: the header moves it, an edge resizes it. */
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

/** A count to step with − and +, in a container's header. */
function Stepper({ value, min, max, label, set }: { value: number; min: number; max: number; label: string; set(n: number): void }) {
  return (
    <span className="voice-area-count" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" aria-label={`${label}: one fewer`} disabled={value <= min} onClick={() => set(value - 1)}>
        −
      </button>
      <span aria-label={label}>{value}</span>
      <button type="button" aria-label={`${label}: one more`} disabled={value >= max} onClick={() => set(value + 1)}>
        +
      </button>
    </span>
  );
}

/**
 * A container on the grid: a panel with rounded corners under the modules in it. Its outer
 * ring of cells is its border, where no module goes, so that inside and outside never
 * touch; it is the same colour as the inside, and is what is taken hold of: the top row,
 * the header, moves the container, and the sides, the bottom and the corner resize it.
 * What is inside is drawn by the canvas, not here, and presses there go through to the grid.
 */
function Frame({
  kind,
  name,
  area,
  blocked,
  selected,
  onGrip,
  children,
}: {
  kind: "voices" | "unison";
  /** What it is called in the grips' tooltips. */
  name: string;
  /** Where it is drawn: where it is, or where a drag would put it. */
  area: Area;
  /** The drag would put a tile on its border, or on another. */
  blocked: boolean;
  selected?: boolean;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
  children: React.ReactNode;
}) {
  const border = AREA_BORDER * CELL;
  const [width, height] = [area.width * CELL, area.height * CELL];
  const grip = (where: AreaGrip, style: React.CSSProperties) => (
    <div className={`voice-area-grip voice-area-${where}`} style={style} onPointerDown={(e) => onGrip(e, where)} title={`Drag to resize the ${name}`} />
  );
  const classes = ["voice-area", `container-${kind}`];
  if (blocked) classes.push("voice-area-blocked");
  if (selected) classes.push("container-selected");
  return (
    <div className={classes.join(" ")} style={{ left: area.x * CELL, top: area.y * CELL, width, height }}>
      {grip("left", { left: 0, top: border, width: border, height: height - 2 * border })}
      {grip("right", { left: width - border, top: border, width: border, height: height - 2 * border })}
      {grip("bottom", { left: 0, top: height - border, width: width - border, height: border })}
      {grip("corner", { left: width - border, top: height - border, width: border, height: border })}
      <div
        className="voice-area-grip voice-area-header"
        style={{ left: 0, top: 0, width, height: border }}
        onPointerDown={(e) => onGrip(e, "move")}
        title={`Drag to move the ${name} with what is in it`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The voice area: what is in it runs in every voice. Its header has the voices' Notes
 * input, and in poly mode the number of voices; a click on it shows the voices' settings.
 */
export function VoiceArea({
  area,
  blocked,
  notesCabled,
  onGrip,
  onPortPointerDown,
}: {
  area: Area;
  blocked: boolean;
  /** A cable brings the voices their notes; without one they get the keyboard's. */
  notesCabled: boolean;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}) {
  const voices = useEditor((s) => s.doc.voices);
  const { mode } = useEditor((s) => voicingOf(s.doc));
  return (
    <Frame kind="voices" name="voice area" area={area} blocked={blocked} onGrip={onGrip}>
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
      {/* Poly: the voices, to change here. Mono: one. The rest is in the settings pane. */}
      <span className="voice-area-title">{mode === "mono" ? "Mono" : "Voices"}</span>
      {mode === "poly" && (
        <Stepper
          value={voices}
          min={MIN_VOICES}
          max={MAX_VOICES}
          label="Number of voices"
          set={(n) => useEditor.getState().apply((doc) => ops.setVoices(doc, n))}
        />
      )}
    </Frame>
  );
}

/**
 * A unison group: what is in it runs as many times side by side as its header says, and
 * its copies are added up where a cable leaves it. A click on its header selects it.
 */
export function GroupArea({
  group,
  area,
  blocked,
  selected,
  onGrip,
}: {
  group: UnisonGroup;
  area: Area;
  blocked: boolean;
  selected: boolean;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
}) {
  return (
    <Frame kind="unison" name="unison group" area={area} blocked={blocked} selected={selected} onGrip={onGrip}>
      <span className="voice-area-title">Unison</span>
      <Stepper
        value={group.size}
        min={MIN_UNISON}
        max={MAX_UNISON}
        label="Copies"
        set={(n) => useEditor.getState().apply((doc) => ops.setGroupSize(doc, group.id, n))}
      />
    </Frame>
  );
}
