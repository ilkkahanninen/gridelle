import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "../../bridge/engine";
import { usePreview } from "../../state/preview";
import { Knob } from "../controls/Knob";
import { METER_TICK_MS, meterSegments, nextPeaks, SEGMENTS, SILENT, type Levels } from "./meters";
import "./VirtualOrganelle.css";

/** LED colours by the value a patch sends to `led` (same table as the device). */
const LED_COLORS = ["#2a2c30", "#ff4a3d", "#ffd23d", "#3ddc68", "#3dd6e0", "#4a7dff", "#e052e0", "#f4f4f4"];

/** The small font's I and O, as the screen has them: a byte per column, the lowest bit on top. */
const GLYPH_I = [0x00, 0x41, 0x7f, 0x41, 0x00];
const GLYPH_O = [0x3e, 0x41, 0x41, 0x41, 0x3e];

/**
 * The segments the meters show, read from the engine as often as the device reads them.
 * Nothing is read while there is no audio preview.
 */
function useMeters(): Levels {
  const ready = usePreview((s) => s.engine.kind === "ready");
  const [lit, setLit] = useState<Levels>(SILENT);
  useEffect(() => {
    if (!ready) return;
    let held = SILENT;
    let busy = false;
    const timer = window.setInterval(() => {
      if (busy) return;
      busy = true;
      engine
        .levels()
        .then((latest) => {
          held = nextPeaks(held, latest);
          const next = meterSegments(held);
          setLit((old) => (old.every((n, i) => n === next[i]) ? old : next));
        })
        .catch(() => {})
        .finally(() => (busy = false));
    }, METER_TICK_MS);
    return () => window.clearInterval(timer);
  }, [ready]);
  return lit;
}

/**
 * The top row of the screen, as the Organelle M draws it (`OledScreen::drawInfoBar`) on its
 * 128 by 64 pixels: I and the input's meter, O and the output's, each the left channel over
 * the right, eleven segments of 2 by 3 pixels with a dot where one is not lit. The battery
 * and Wi-Fi signs at its right end are the device's own and are left out.
 */
function Meters() {
  const [inL, inR, outL, outR] = useMeters();
  const pixels: React.ReactNode[] = [];
  const glyph = (columns: number[], x: number) =>
    columns.forEach((bits, i) => {
      for (let y = 0; y < 8; y++) if ((bits >> y) & 1) pixels.push(<rect key={`g${x + i}-${y}`} x={x + i} y={y} width={1} height={1} />);
    });
  const meter = (x: number, y: number, lit: number) => {
    for (let i = 0; i < SEGMENTS; i++) {
      const at = x + 3 * i;
      pixels.push(
        i < lit ? (
          <rect key={`m${at}-${y}`} x={at} y={y} width={2} height={3} />
        ) : (
          <rect key={`m${at}-${y}`} x={at + 1} y={y + 1} width={1} height={1} />
        ),
      );
    }
  };
  glyph(GLYPH_I, 0);
  meter(7, 0, inL);
  meter(7, 4, inR);
  glyph(GLYPH_O, 45);
  meter(54, 0, outL);
  meter(54, 4, outR);
  return (
    <svg
      className="oled-meters"
      viewBox="0 0 128 8"
      shapeRendering="crispEdges"
      role="img"
      aria-label={`Levels: input ${inL} and ${inR}, output ${outL} and ${outR} of ${SEGMENTS}`}
    >
      {pixels}
    </svg>
  );
}

/** The Organelle's keys play MIDI notes 60–83 at a fixed velocity. */
const FIRST_NOTE = 60;
const KEY_COUNT = 24;
const KEY_VELOCITY = 100;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** Computer keys for the first octave and a half, piano-style. */
const TYPING_KEYS = "awsedftgyhujkolp;";
const AUX_TYPING_KEY = "z";

interface Props {
  /** Bumped when a patch has loaded: the knob positions are sent, as the device does. */
  revision: number;
}

/**
 * On-screen stand-in for the Organelle's panel. It sends exactly what the device's
 * host patch sends (`notes`, `knob1`–`knob4`, `aux`) and shows what the patch sends
 * back (`screenLine1`–`screenLine5`, `led`). Above the lines the screen has the device's
 * input and output meters, which the preview measures as the device's host patch does.
 */
export function VirtualOrganelle({ revision }: Props) {
  const [knobs, setKnobs] = useState([0.5, 0.5, 0.5, 0.5]);
  const [volume, setVolume] = useState(0.8);
  const lines = usePreview((s) => s.screen);
  const led = usePreview((s) => s.led);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [aux, setAux] = useState(false);
  const knobsRef = useRef(knobs);
  knobsRef.current = knobs;
  // What has been sent to the patch, so that a key or Aux is never pressed or released twice.
  const heldRef = useRef<ReadonlySet<number>>(new Set());
  const auxRef = useRef(false);

  // The device reports its knob positions right after a patch loads.
  useEffect(() => {
    if (revision === 0) return;
    knobsRef.current.forEach((value, i) => void engine.send(`knob${i + 1}`, value));
  }, [revision]);

  useEffect(() => void engine.setVolume(volume), [volume]);

  // Sending happens here, outside the state updaters: React may run an updater more
  // than once (it does in StrictMode), and a repeated `aux 1` would step two pages.
  const note = useCallback((index: number, down: boolean) => {
    if (heldRef.current.has(index) === down) return;
    const next = new Set(heldRef.current);
    if (down) next.add(index);
    else next.delete(index);
    heldRef.current = next;
    setHeld(next);
    void engine.send("notes", FIRST_NOTE + index, down ? KEY_VELOCITY : 0);
  }, []);

  const pressAux = useCallback((down: boolean) => {
    if (auxRef.current === down) return;
    auxRef.current = down;
    setAux(down);
    void engine.send("aux", down ? 1 : 0);
  }, []);

  useEffect(() => {
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === AUX_TYPING_KEY) pressAux(down);
      const index = TYPING_KEYS.indexOf(key);
      if (index >= 0 && key.length === 1) note(index, down);
    };
    const down = onKey(true);
    const up = onKey(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [note, pressAux]);

  const setKnob = (index: number, value: number) => {
    setKnobs((prev) => prev.map((old, i) => (i === index ? value : old)));
    void engine.send(`knob${index + 1}`, value);
  };

  const keys = Array.from({ length: KEY_COUNT }, (_, i) => i);
  const pointerHandlers = (press: (down: boolean) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      press(true);
    },
    onPointerUp: () => press(false),
    onPointerCancel: () => press(false),
  });

  return (
    <section className="organelle" aria-label="Virtual Organelle">
      <div className="organelle-top">
        <div className="oled" aria-label="Screen">
          <Meters />
          {lines.map((text, i) => (
            <div className="oled-line" key={i}>
              {text || " "}
            </div>
          ))}
        </div>
        <div className="organelle-knobs">
          {knobs.map((value, i) => (
            <Knob key={i} value={value} onChange={(v) => setKnob(i, v)} label={`Knob ${i + 1}`} />
          ))}
          <Knob value={volume} onChange={setVolume} defaultValue={0.8} label="Volume" />
        </div>
        <div className="organelle-led" style={{ background: LED_COLORS[((Math.trunc(led) % 8) + 8) % 8] }} aria-label="LED" />
      </div>

      <div className="organelle-keys">
        <button
          className={`key key-aux${aux ? " key-down" : ""}`}
          aria-label="Aux"
          title="Aux (Z)"
          {...pointerHandlers(pressAux)}
        />
        <div className="key-rows">
          <div className="key-row key-row-black">
            {keys
              .filter((i) => BLACK.has(i % 12))
              .map((i) => (
                <button
                  key={i}
                  className={`key key-black${held.has(i) ? " key-down" : ""}`}
                  style={{ gridColumnStart: whiteIndexBefore(i) * 2 + 2 }}
                  aria-label={`Key ${FIRST_NOTE + i}`}
                  {...pointerHandlers((down) => note(i, down))}
                />
              ))}
          </div>
          <div className="key-row key-row-white">
            {keys
              .filter((i) => !BLACK.has(i % 12))
              .map((i) => (
                <button
                  key={i}
                  className={`key${held.has(i) ? " key-down" : ""}`}
                  aria-label={`Key ${FIRST_NOTE + i}`}
                  {...pointerHandlers((down) => note(i, down))}
                />
              ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Number of white keys below key `index`, i.e. the white key a black key sits after, minus one. */
function whiteIndexBefore(index: number) {
  let whites = 0;
  for (let i = 0; i < index; i++) if (!BLACK.has(i % 12)) whites++;
  return whites - 1;
}
