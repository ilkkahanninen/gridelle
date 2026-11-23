import { useEffect } from "react";
import * as ops from "../../core/model/ops";
import { MAX_TAPE_SECONDS, SAMPLE_PARAM, SAMPLE_SLOTS, sampleLetter, type SampleSlot } from "../../core/model/types";
import { getModuleDef } from "../../core/modules/registry";
import { wavetableBank, wavetableGroups } from "../../core/wavetables/banks";
import {
  loadSample,
  NEW_TAPE_SECONDS,
  NEW_WAVETABLE,
  readSound,
  readTable,
  setSample,
  tableKey,
  tableSource,
  useSounds,
  type TableSource,
} from "../../state/sounds";
import { useEditor } from "../../state/store";
import "./SamplesPane.css";

/** A length in seconds, as short as it reads well: "0.25 s", "1.2 s", "12 s". */
const seconds = (value: number) => `${Number(value.toPrecision(value < 10 ? 2 : 3))} s`;

/** What one of the editor's own wavetables is called, also when this version does not have it. */
const bankName = (id: string) => wavetableBank(id)?.name ?? "Unknown wavetable";

/** What a slot holds, in a few words: for the Sample choice of a module. */
export function describeSample(sample: SampleSlot | null): string {
  if (!sample) return "empty";
  if (sample.kind === "file") return sample.name;
  return sample.kind === "tape" ? `Tape, ${seconds(sample.seconds)}` : bankName(sample.bank);
}

/** The cycle lengths a sound file can be told to be cut into, when it is read as a wavetable. */
const CYCLES = [256, 512, 1024, 2048, 4096];

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

/** What is known of the wavetable made from `source`, asking for it to be made when nothing is. */
function useTable(source: TableSource) {
  const key = tableKey(source);
  const table = useSounds((s) => s.tables[key]);
  // The key says all there is to say of the source.
  useEffect(() => readTable(source), [key]);
  return table;
}

/**
 * A wavetable's picture: some of its cycles one behind another, the first in front, each
 * a little up and to the right of the one before.
 */
function TablePicture({ source }: { source: TableSource }) {
  const table = useTable(source);
  if (table?.kind === "error") return <p className="sample-problem">{table.message}</p>;
  if (table?.kind !== "ready") return <div className="sample-picture" />;
  const cycles = table.info.picture;
  const [width, height, across, up] = [96, 44, 24, 20];
  const step = cycles.length > 1 ? 1 / (cycles.length - 1) : 0;
  return (
    <svg className="sample-picture sample-table" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {/* The last cycle first, so that the first is drawn over the others. */}
      {cycles
        .map((points, number) => {
          const depth = number * step;
          const line = points
            .map((value, i) => {
              const x = depth * across + (i / (points.length - 1)) * (width - across);
              const y = height - 11 - depth * up - value * 9;
              return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
            })
            .join("");
          return <path key={number} d={line} style={{ opacity: 1 - 0.65 * depth }} />;
        })
        .reverse()}
    </svg>
  );
}

/** How a sound file is read by the Wavetable oscillator that uses it: how many cycles, of what length, and a choice of length. */
function CycleSetting({ slot, sample }: { slot: number; sample: Extract<SampleSlot, { kind: "file" }> }) {
  const table = useTable(tableSource(sample)!);
  const found = table?.kind === "ready" ? table.info : null;
  return (
    <label className="sample-length sample-cycle">
      <span>{found ? `As a wavetable: ${found.frames} ${found.frames === 1 ? "cycle" : "cycles"} of` : "As a wavetable, in cycles of"}</span>
      <select
        value={sample.cycle ?? 0}
        aria-label={`Length of a cycle of sample ${sampleLetter(slot)}, in samples`}
        title="How many samples one cycle of the sound is. Its own: what the file says, or a guess from its length."
        onChange={(e) => setSample(slot, { ...sample, cycle: Number(e.target.value) || undefined })}
      >
        <option value={0}>{found ? `${found.cycle} (its own)` : "its own"}</option>
        {CYCLES.map((cycle) => (
          <option key={cycle} value={cycle}>
            {cycle}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One of the editor's own wavetables in a slot: which, with the others to choose from. */
function BankSetting({ slot, bank }: { slot: number; bank: string }) {
  const frames = wavetableBank(bank)?.frames;
  return (
    <label className="sample-length sample-bank">
      <select value={bank} aria-label={`Wavetable of sample ${sampleLetter(slot)}`} onChange={(e) => setSample(slot, { kind: "wavetable", bank: e.target.value })}>
        {!wavetableBank(bank) && <option value={bank}>{bankName(bank)}</option>}
        {wavetableGroups().map(({ group, banks }) => (
          <optgroup key={group} label={group}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {frames !== undefined && <span>{frames} cycles</span>}
    </label>
  );
}

/** One of the patch's samples: its letter and name, its picture, how long it is, and a button that empties it. */
function SampleCard({ slot, sample, scanned }: { slot: number; sample: SampleSlot; scanned: boolean }) {
  const letter = sampleLetter(slot);
  return (
    <li className="sample-card">
      <div className="sample-head">
        <span className="sample-letter">{letter}</span>
        <span className="sample-name" title={sample.kind === "file" ? sample.path : undefined}>
          {sample.kind === "file" ? sample.name : sample.kind === "tape" ? "Tape" : bankName(sample.bank)}
        </span>
        <button className="sample-delete" title={`Delete sample ${letter}`} aria-label={`Delete sample ${letter}`} onClick={() => setSample(slot, null)}>
          ×
        </button>
      </div>
      {sample.kind === "file" && <SoundPicture sample={sample} />}
      {sample.kind === "tape" && <Reels />}
      {sample.kind === "wavetable" && <TablePicture source={tableSource(sample)!} />}
      {sample.kind === "file" && (
        <span className="sample-length">
          {seconds(sample.frames / sample.sampleRate)} · {Number((sample.sampleRate / 1000).toFixed(1))} kHz
        </span>
      )}
      {/* A sound that a Wavetable oscillator reads is cut into cycles: how long they are is the user's to say. */}
      {sample.kind === "file" && scanned && <CycleSetting slot={slot} sample={sample} />}
      {sample.kind === "tape" && (
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
      {sample.kind === "wavetable" && <BankSetting slot={slot} bank={sample.bank} />}
    </li>
  );
}

/** The next free slot, not yet a sample: load a sound into it, make it a tape, or give it a wavetable. */
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
        <button className="button" title="One of the editor's wavetables, for a Wavetable oscillator" onClick={() => setSample(slot, NEW_WAVETABLE)}>
          Wavetable
        </button>
      </div>
    </li>
  );
}

/**
 * The patch's samples, for the side pane of that name: those that hold a sound file, a
 * tape or a wavetable, and after them the next free slot, for as long as there is one.
 */
export function SamplesPane() {
  const samples = useEditor((s) => s.doc.samples);
  const modules = useEditor((s) => s.doc.modules);
  const slots = Array.from({ length: SAMPLE_SLOTS }, (_, slot) => slot);
  const free = slots.find((slot) => !ops.sampleAt({ samples }, slot));
  // The slots a Wavetable oscillator reads.
  const scanned = new Set(modules.filter((m) => getModuleDef(m.type)?.sample === "wavetable").map((m) => ops.paramValue(m, SAMPLE_PARAM)));
  return (
    <ul className="sample-list category-sample">
      {slots.map((slot) => {
        const sample = ops.sampleAt({ samples }, slot);
        if (sample) return <SampleCard key={slot} slot={slot} sample={sample} scanned={scanned.has(slot)} />;
        return slot === free ? <FreeSlot key={slot} slot={slot} /> : null;
      })}
    </ul>
  );
}
