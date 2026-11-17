import { useCallback, useEffect, useRef, useState } from "react";
import { engine, type Atom, type PdEvent } from "../../bridge/engine";
import { Knob } from "../controls/Knob";
import "./VirtualOrganelle.css";

/** LED colours by the value a patch sends to `led` (same table as the device). */
const LED_COLORS = ["#2a2c30", "#ff4a3d", "#ffd23d", "#3ddc68", "#3dd6e0", "#4a7dff", "#e052e0", "#f4f4f4"];

/** The Organelle's keys play MIDI notes 60–83 at a fixed velocity. */
const FIRST_NOTE = 60;
const KEY_COUNT = 24;
const KEY_VELOCITY = 100;
const BLACK = new Set([1, 3, 6, 8, 10]);

/** Computer keys for the first octave and a half, piano-style. */
const TYPING_KEYS = "awsedftgyhujkolp;";
const AUX_TYPING_KEY = "z";

const SCREEN_LINES = 5;
const SCREEN_COLUMNS = 21;

function atomText(atom: Atom) {
  return typeof atom === "number" ? String(Number(atom.toPrecision(6))) : atom;
}

interface Props {
  /** Bumped when a patch is about to load: the screen and LED start from blank. */
  loadsStarted: number;
  /** Bumped when a patch has loaded: the knob positions are sent, as the device does. */
  revision: number;
}

/**
 * On-screen stand-in for the Organelle's panel. It sends exactly what the device's
 * host patch sends (`notes`, `knob1`–`knob4`, `aux`) and shows what the patch sends
 * back (`screenLine1`–`screenLine5`, `led`).
 */
export function VirtualOrganelle({ loadsStarted, revision }: Props) {
  const [knobs, setKnobs] = useState([0.5, 0.5, 0.5, 0.5]);
  const [volume, setVolume] = useState(0.8);
  const [lines, setLines] = useState<string[]>(() => Array(SCREEN_LINES).fill(""));
  const [led, setLed] = useState(0);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const [aux, setAux] = useState(false);
  const knobsRef = useRef(knobs);
  knobsRef.current = knobs;

  useEffect(() => {
    const handle = (event: PdEvent) => {
      if (event.kind !== "message") return;
      const line = /^screenLine([1-5])$/.exec(event.recv);
      if (line) {
        const text = event.atoms.map(atomText).join(" ").slice(0, SCREEN_COLUMNS);
        setLines((prev) => prev.map((old, i) => (i === Number(line[1]) - 1 ? text : old)));
      } else if (event.recv === "led" && typeof event.atoms[0] === "number") {
        setLed(((Math.trunc(event.atoms[0]) % 8) + 8) % 8);
      }
    };
    const subscription = engine.onEvent(handle);
    return () => void subscription.then((unsubscribe) => unsubscribe());
  }, []);

  // Blank the screen before the new patch starts writing to it.
  useEffect(() => {
    setLines(Array(SCREEN_LINES).fill(""));
    setLed(0);
  }, [loadsStarted]);

  // The device reports its knob positions right after a patch loads.
  useEffect(() => {
    if (revision === 0) return;
    knobsRef.current.forEach((value, i) => void engine.send(`knob${i + 1}`, value));
  }, [revision]);

  useEffect(() => void engine.setVolume(volume), [volume]);

  const note = useCallback((index: number, down: boolean) => {
    setHeld((prev) => {
      if (prev.has(index) === down) return prev;
      void engine.send("notes", FIRST_NOTE + index, down ? KEY_VELOCITY : 0);
      const next = new Set(prev);
      if (down) next.add(index);
      else next.delete(index);
      return next;
    });
  }, []);

  const pressAux = useCallback((down: boolean) => {
    setAux((prev) => {
      if (prev !== down) void engine.send("aux", down ? 1 : 0);
      return down;
    });
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
        <div className="organelle-led" style={{ background: LED_COLORS[led] }} aria-label="LED" />
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
