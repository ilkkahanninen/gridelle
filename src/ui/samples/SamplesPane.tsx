import { useEffect } from "react";
import * as ops from "../../core/model/ops";
import { MAX_TAPE_SECONDS, SAMPLE_SLOTS, sampleLetter, type SampleSlot } from "../../core/model/types";
import { loadSample, NEW_TAPE_SECONDS, readSound, setSample, useSounds } from "../../state/sounds";
import { useEditor } from "../../state/store";
import "./SamplesPane.css";

/** A length in seconds, as short as it reads well: "0.25 s", "1.2 s", "12 s". */
const seconds = (value: number) => `${Number(value.toPrecision(value < 10 ? 2 : 3))} s`;

/** What a slot holds, in a few words: for the Sample choice of a module. */
export function describeSample(sample: SampleSlot | null): string {
  if (!sample) return "empty";
  return sample.kind === "file" ? sample.name : `Tape, ${seconds(sample.seconds)}`;
}

/** A sound's picture: its lowest and highest sample, column by column. */
function Waveform({ peaks }: { peaks: number[] }) {
  const columns = peaks.length / 2;
  // Along the highest of each column, back along the lowest. At least a hairline, so silence shows.
  const top = Array.from({ length: columns }, (_, i) => `${i},${(1 - Math.max(peaks[i * 2 + 1], 0.01)).toFixed(3)}`);
  const bottom = Array.from({ length: columns }, (_, i) => `${columns - 1 - i},${(1 - Math.min(peaks[(columns - 1 - i) * 2], -0.01)).toFixed(3)}`);
  return (
    <svg className="sample-picture sample-wave" viewBox={`0 0 ${Math.max(columns - 1, 1)} 2`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={[...top, ...bottom].join(" ")} />
    </svg>
  );
}

/** A reel-to-reel recorder: what a tape looks like before anything is on it. */
function Reels() {
  const reel = (x: number) => (
    <g transform={`translate(${x} 17)`}>
      <circle r="13" />
      <circle r="3.5" />
      {[90, 210, 330].map((angle) => (
        <path key={angle} d="M0 -5.5V-10.5" transform={`rotate(${angle})`} />
      ))}
    </g>
  );
  return (
    <svg className="sample-picture sample-reels" viewBox="0 0 96 44" aria-hidden="true">
      {reel(24)}
      {reel(72)}
      {/* The tape, from reel to reel past the heads. */}
      <path d="M13 24.5L30 40H66L83 24.5" />
      <path d="M41 36.5H55V40H41Z" />
    </svg>
  );
}

/** A sound file's picture, or why it cannot be read. */
function SoundPicture({ sample }: { sample: Extract<SampleSlot, { kind: "file" }> }) {
  const sound = useSounds((s) => s.sounds[sample.path]);
  useEffect(() => readSound(sample.path), [sample.path]);
  if (sound?.kind === "error") return <p className="sample-problem">{sound.message}</p>;
  return sound?.kind === "ready" ? <Waveform peaks={sound.info.peaks} /> : <div className="sample-picture" />;
}

/** One of the patch's samples: its letter and name, its picture, how long it is, and a button that empties it. */
function SampleCard({ slot, sample }: { slot: number; sample: SampleSlot }) {
  const letter = sampleLetter(slot);
  return (
    <li className="sample-card">
      <div className="sample-head">
        <span className="sample-letter">{letter}</span>
        <span className="sample-name" title={sample.kind === "file" ? sample.path : undefined}>
          {sample.kind === "file" ? sample.name : "Tape"}
        </span>
        <button className="sample-delete" title={`Delete sample ${letter}`} aria-label={`Delete sample ${letter}`} onClick={() => setSample(slot, null)}>
          ×
        </button>
      </div>
      {sample.kind === "file" ? <SoundPicture sample={sample} /> : <Reels />}
      {sample.kind === "file" ? (
        <span className="sample-length">
          {seconds(sample.frames / sample.sampleRate)} · {Number((sample.sampleRate / 1000).toFixed(1))} kHz
        </span>
      ) : (
        <label className="sample-length">
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
          s of blank tape
        </label>
      )}
    </li>
  );
}

/** The next free slot, not yet a sample: load a sound into it, or make it a tape. */
function FreeSlot({ slot }: { slot: number }) {
  return (
    <li className="sample-card sample-card-free">
      <div className="sample-head">
        <span className="sample-letter">{sampleLetter(slot)}</span>
        <span className="sample-name">Empty</span>
      </div>
      <div className="sample-actions">
        <button className="button" onClick={() => void loadSample(slot)}>
          Load sample…
        </button>
        <button className="button" title="A silent sample for a Recorder to fill" onClick={() => setSample(slot, { kind: "tape", seconds: NEW_TAPE_SECONDS })}>
          New tape
        </button>
      </div>
    </li>
  );
}

/**
 * The patch's samples, for the side pane of that name: those that hold a sound file or a
 * tape, and after them the next free slot, for as long as there is one.
 */
export function SamplesPane() {
  const samples = useEditor((s) => s.doc.samples);
  const slots = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => slot);
  const free = slots.find((slot) => !ops.sampleAt({ samples }, slot));
  return (
    <ul className="sample-list category-sample">
      {slots.map((slot) => {
        const sample = ops.sampleAt({ samples }, slot);
        if (sample) return <SampleCard key={slot} slot={slot} sample={sample} />;
        return slot === free ? <FreeSlot key={slot} slot={slot} /> : null;
      })}
    </ul>
  );
}
