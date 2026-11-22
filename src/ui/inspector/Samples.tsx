import { useEffect } from "react";
import * as ops from "../../core/model/ops";
import { MAX_TAPE_SECONDS, SAMPLE_SLOTS, sampleLetter, type SampleSlot } from "../../core/model/types";
import { loadSample, NEW_TAPE_SECONDS, readSound, setSample, useSounds } from "../../state/sounds";
import { useEditor } from "../../state/store";

/** A length in seconds, as short as it reads well: "0.25 s", "1.2 s", "12 s". */
const seconds = (value: number) => `${Number(value.toPrecision(value < 10 ? 2 : 3))} s`;

/** What a slot holds, in a few words: for lists and for the Sample choice of a module. */
export function describeSample(sample: SampleSlot | null): string {
  if (!sample) return "empty";
  return sample.kind === "file" ? sample.name : `Tape, ${seconds(sample.seconds)}`;
}

/** A sound's picture: its lowest and highest sample, column by column. */
function Waveform({ peaks }: { peaks: number[] }) {
  const columns = peaks.length / 2;
  // Down the highest of each column, back along the lowest. At least a hairline, so silence shows.
  const top = Array.from({ length: columns }, (_, i) => `${i},${(1 - Math.max(peaks[i * 2 + 1], 0.01)).toFixed(3)}`);
  const bottom = Array.from({ length: columns }, (_, i) => `${columns - 1 - i},${(1 - Math.min(peaks[(columns - 1 - i) * 2], -0.01)).toFixed(3)}`);
  return (
    <svg className="sample-wave" viewBox={`0 0 ${Math.max(columns - 1, 1)} 2`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={[...top, ...bottom].join(" ")} />
    </svg>
  );
}

/** A sound file's picture and length, or why it cannot be read. */
function FileDetails({ sample }: { sample: Extract<SampleSlot, { kind: "file" }> }) {
  const sound = useSounds((s) => s.sounds[sample.path]);
  useEffect(() => readSound(sample.path), [sample.path]);
  if (sound?.kind === "error") return <p className="sample-problem">{sound.message}</p>;
  return (
    <>
      {sound?.kind === "ready" ? <Waveform peaks={sound.info.peaks} /> : <div className="sample-wave" />}
      <span className="sample-length" title={sample.path}>
        {seconds(sample.frames / sample.sampleRate)} · {Number((sample.sampleRate / 1000).toFixed(1))} kHz
      </span>
    </>
  );
}

/**
 * One of the patch's samples: what it holds, and the buttons that put a sound file or a
 * blank tape there, or empty it.
 */
export function SampleSlotEditor({ slot }: { slot: number }) {
  const sample = useEditor((s) => ops.sampleAt(s.doc, slot));
  const letter = sampleLetter(slot);
  return (
    <div className="sample-slot category-sample">
      <div className="sample-head">
        <span className="sample-letter">{letter}</span>
        <span className="sample-name" title={sample?.kind === "file" ? sample.path : undefined}>
          {sample?.kind === "tape" ? "Tape" : describeSample(sample)}
        </span>
        {sample?.kind === "tape" && (
          <label className="sample-seconds">
            <input
              type="number"
              min={0.1}
              max={MAX_TAPE_SECONDS}
              step={0.5}
              value={sample.seconds}
              aria-label={`Length of tape ${letter} in seconds`}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (next >= 0.1 && next <= MAX_TAPE_SECONDS) setSample(slot, { kind: "tape", seconds: next });
              }}
            />
            s
          </label>
        )}
      </div>
      {sample?.kind === "file" && (
        <div className="sample-details">
          <FileDetails sample={sample} />
        </div>
      )}
      <div className="sample-actions">
        <button className="button" onClick={() => void loadSample(slot)}>
          {sample?.kind === "file" ? "Replace…" : "Load…"}
        </button>
        {sample?.kind !== "tape" && (
          <button className="button" title="A silent sample for a Recorder to fill" onClick={() => setSample(slot, { kind: "tape", seconds: NEW_TAPE_SECONDS })}>
            Tape
          </button>
        )}
        {sample && (
          <button className="button button-quiet" onClick={() => setSample(slot, null)}>
            Empty
          </button>
        )}
      </div>
    </div>
  );
}

/** The patch's samples: those that hold something, and the next free one to fill. */
export function SampleList() {
  const samples = useEditor((s) => s.doc.samples);
  const used = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => slot).filter((slot) => samples?.[slot]);
  const free = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => slot).find((slot) => !samples?.[slot]);
  const shown = free === undefined ? used : [...used, free].sort((a, b) => a - b);
  return (
    <>
      {shown.map((slot) => (
        <section key={slot} className="inspector-sample">
          <SampleSlotEditor slot={slot} />
        </section>
      ))}
    </>
  );
}
