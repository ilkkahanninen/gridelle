import { AREA_BORDER, VOICE_NOTES } from "../../core/model/area";
import { UNISON_SHELF, VOICE_SHELF } from "../../core/modules/registry";
import type { PortDef } from "../../core/modules/types";
import * as ops from "../../core/model/ops";
import { MIN_AREA } from "../../core/model/ops";
import { MAX_UNISON, MAX_VOICES, MIN_UNISON, MIN_VOICES, voicingOf, type Area, type UnisonGroup } from "../../core/model/types";
import { useEditor } from "../../state/store";
import { CELL, PORT_INSET, ROW_PITCH, type Point } from "./geometry";
import "./VoiceArea.css";

/** Which part of a container a press took hold of: the header moves it, an edge resizes it. */
export type AreaGrip = "move" | "left" | "right" | "bottom" | "corner";

/** How far in from the area's left edge the Notes input is: clear of its rounded corner. */
const NOTES_INSET = 26;

/** Where the voices' Notes input is, on the left of the area's header, in world pixels. */
export const notesPortPoint = (area: Area): Point => ({ x: area.x * CELL + NOTES_INSET, y: area.y * CELL + CELL / 2 });

/**
 * How far a container's lines keep from the tiles, in pixels: its outline is drawn this far
 * in from its cells, and its header's bottom and its shelf's right side this far out from
 * its inside, so that none of them runs along a tile's.
 */
export const CONTAINER_PAD = 8;

/** Where output `index` of a container's shelf is, at the right edge of its left column, in world pixels. */
export const shelfPortPoint = (area: Area, index: number): Point => ({
  x: area.x * CELL + AREA_BORDER * CELL - CONTAINER_PAD - PORT_INSET,
  y: (area.y + AREA_BORDER) * CELL + ROW_PITCH / 2 + index * ROW_PITCH,
});

/** What each shelf output gives, for its tooltip. */
const SHELF_TIPS: Record<string, string> = {
  pitch: "Pitch: the voice's note, as a note number (60 is middle C).",
  gate: "Gate: 1 while the voice's key is held.",
  velocity: "Velocity: how hard the voice's key was played, from 0 to 1.",
  index: "Index: each copy's place among the copies, from -1 (the first) to 1 (the last). Into an oscillator's Fine tune, it detunes them.",
  uni: "0–1: each copy's place among the copies from 0 to 1, for inputs that multiply a knob.",
};

/** The outputs on a container's shelf, and what is cabled to them. */
interface Shelf {
  /** What a cable from them names as its module: "voices", or the group's id. */
  module: string;
  ports: readonly PortDef[];
  /** `out:<port>` for each output with a cable. */
  connected: ReadonlySet<string>;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}

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
 * touch, and is what is taken hold of: the top row, the header, moves the container, and
 * the sides, the bottom and the corner resize it. The header is drawn darkest, and the
 * left column below it, the container's shelf, between that and the rest. What is inside
 * is drawn by the canvas, not here, and presses there go through to the grid.
 */
function Frame({
  kind,
  name,
  area,
  blocked,
  selected,
  onGrip,
  shelf,
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
  /** The outputs in its left column, below the header. */
  shelf: Shelf;
  children: React.ReactNode;
}) {
  const border = AREA_BORDER * CELL;
  const pad = CONTAINER_PAD;
  // The cells it covers, and the panel drawn `pad` in from them; positions below are the panel's.
  const [width, height] = [area.width * CELL, area.height * CELL];
  const [w, h] = [width - 2 * pad, height - 2 * pad];
  // The header's height and the shelf's width: `pad` short of the inside.
  const band = border - 2 * pad;
  // Where the inside begins, from the panel's edge.
  const edge = border - pad;
  const grip = (where: AreaGrip, style: React.CSSProperties) => (
    <div className={`voice-area-grip voice-area-${where}`} style={style} onPointerDown={(e) => onGrip(e, where)} title={`Drag to resize the ${name}`} />
  );
  const classes = ["voice-area", `container-${kind}`];
  if (blocked) classes.push("voice-area-blocked");
  if (selected) classes.push("container-selected");
  return (
    <div className={classes.join(" ")} style={{ left: area.x * CELL + pad, top: area.y * CELL + pad, width: w, height: h }}>
      <div className="container-shelf" style={{ left: 0, top: band, width: band, height: h - band }} />
      {grip("left", { left: 0, top: band, width: edge, height: h - band - edge })}
      {grip("right", { left: w - edge, top: band, width: edge, height: h - band - edge })}
      {grip("bottom", { left: 0, top: h - edge, width: w - edge, height: edge })}
      {grip("corner", { left: w - edge, top: h - edge, width: edge, height: edge })}
      <div
        className="voice-area-grip voice-area-header"
        style={{ left: 0, top: 0, width: w, height: band }}
        onPointerDown={(e) => onGrip(e, "move")}
        title={`Drag to move the ${name} with what is in it`}
      >
        {children}
      </div>
      {/* The shelf's outputs, two to a cell, at its right edge, as a tile's are at its. */}
      {shelf.ports.map((port, i) => (
        <div
          key={port.id}
          className={`port port-out hint-${port.hint} container-shelf-port${shelf.connected.has(`out:${port.id}`) ? " port-cabled" : ""}`}
          style={{ top: edge + ROW_PITCH / 2 + i * ROW_PITCH, right: width - border + PORT_INSET }}
          data-port-module={shelf.module}
          data-port-id={port.id}
          data-port-side="out"
          title={SHELF_TIPS[port.id] ?? port.label}
          onPointerDown={(e) => shelf.onPortPointerDown(e, shelf.module, port.id, "out")}
        >
          <span className="port-dot" />
          <span className="port-label">{port.label}</span>
        </div>
      ))}
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
  connected,
  onGrip,
  onPortPointerDown,
}: {
  area: Area;
  blocked: boolean;
  /** A cable brings the voices their notes; without one they get the keyboard's. */
  notesCabled: boolean;
  /** The shelf's outputs with a cable, as `out:<port>`. */
  connected: ReadonlySet<string>;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}) {
  const voices = useEditor((s) => s.doc.voices);
  const { mode } = useEditor((s) => voicingOf(s.doc));
  const shelf = { module: VOICE_NOTES.module, ports: VOICE_SHELF, connected, onPortPointerDown };
  return (
    <Frame kind="voices" name="voice area" area={area} blocked={blocked} onGrip={onGrip} shelf={shelf}>
      {/* The notes the voices play: the keyboard's, or a note module's patched in here. */}
      <div
        className={`port port-in hint-notes voice-area-notes${notesCabled ? " port-cabled" : " port-precord"}`}
        style={{ top: CELL / 2 - CONTAINER_PAD, left: NOTES_INSET - CONTAINER_PAD }}
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
 * its copies are added up where a cable leaves it. Its shelf gives each copy its place
 * among them. A click on its header selects it.
 */
export function GroupArea({
  group,
  area,
  blocked,
  selected,
  connected,
  onGrip,
  onPortPointerDown,
}: {
  group: UnisonGroup;
  area: Area;
  blocked: boolean;
  selected: boolean;
  connected: ReadonlySet<string>;
  onGrip(e: React.PointerEvent, grip: AreaGrip): void;
  onPortPointerDown(e: React.PointerEvent, id: string, port: string, side: "in" | "out"): void;
}) {
  const shelf = { module: group.id, ports: UNISON_SHELF, connected, onPortPointerDown };
  return (
    <Frame kind="unison" name="unison group" area={area} blocked={blocked} selected={selected} onGrip={onGrip} shelf={shelf}>
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
