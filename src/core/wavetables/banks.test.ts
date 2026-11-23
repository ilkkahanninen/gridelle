import { describe, expect, it } from "vitest";
import { DEFAULT_BANK, WAVETABLE_BANKS, wavetableBank, wavetableGroups } from "./banks";

/**
 * Ids that patches have been saved with. A bank may be added to the list, but none of
 * these may go or change: a patch that names one would lose its wavetable.
 */
const SAVED_WITH = [
  "basic-shapes", "sine-to-saw", "sine-to-square", "pulse-width", "triangle-to-saw",
  "sync-saw", "sync-square", "sync-sine", "resonance", "reso-wave",
  "harmonics", "overtones", "odd-to-even", "octaves", "drawbars", "tilt", "primes",
  "vowels", "formant", "twin-peaks",
  "fm-1-1", "fm-1-2", "fm-1-3", "fm-3-1", "phase-distortion",
  "wavefold", "overdrive", "bit-reduction", "stepped",
  "glass", "bells", "noise-bands",
  // Adventure Kid Waveforms, a folder or a part of one each.
  "akwf-bw-blended-1", "akwf-bw-blended-2", "akwf-bw-perfectwaves", "akwf-bw-saw", "akwf-bw-sawbright", "akwf-bw-sawgap",
  "akwf-bw-sawrounded", "akwf-bw-sin", "akwf-bw-squ-1", "akwf-bw-squ-2", "akwf-bw-squrounded", "akwf-bw-tri",
  "akwf-hdrawn", "akwf-linear-1", "akwf-linear-2", "akwf-symetric", "akwf-aguitar", "akwf-altosax", "akwf-birds",
  "akwf-cello", "akwf-clarinett", "akwf-clavinet", "akwf-dbass-1", "akwf-dbass-2", "akwf-ebass-1", "akwf-ebass-2",
  "akwf-eguitar", "akwf-eorgan-1", "akwf-eorgan-2", "akwf-eorgan-3", "akwf-epiano-1", "akwf-epiano-2", "akwf-flute",
  "akwf-hvoice-1", "akwf-hvoice-2", "akwf-oboe", "akwf-piano", "akwf-stringbox", "akwf-theremin", "akwf-violin",
  "akwf-bitreduced-1", "akwf-bitreduced-2", "akwf-c604", "akwf-distorted", "akwf-fmsynth-1", "akwf-fmsynth-2",
  "akwf-granular", "akwf-oscchip-1", "akwf-oscchip-2", "akwf-oscchip-3", "akwf-overtone", "akwf-pluckalgo",
  "akwf-raw", "akwf-sinharm", "akwf-snippets", "akwf-vgame-1", "akwf-vgame-2", "akwf-vgame-3", "akwf-vgamebasic",
  "akwf-0001-1", "akwf-0001-2", "akwf-0002-1", "akwf-0002-2", "akwf-0003-1", "akwf-0003-2", "akwf-0004-1",
  "akwf-0004-2", "akwf-0005-1", "akwf-0005-2", "akwf-0006-1", "akwf-0006-2", "akwf-0007-1", "akwf-0007-2",
  "akwf-0008-1", "akwf-0008-2", "akwf-0009-1", "akwf-0009-2", "akwf-0010-1", "akwf-0010-2", "akwf-0011-1",
  "akwf-0011-2", "akwf-0012-1", "akwf-0012-2", "akwf-0013-1", "akwf-0013-2", "akwf-0014-1", "akwf-0014-2",
  "akwf-0015-1", "akwf-0015-2", "akwf-0016-1", "akwf-0016-2", "akwf-0017-1", "akwf-0017-2", "akwf-0018-1",
  "akwf-0018-2", "akwf-0019-1", "akwf-0019-2", "akwf-0020-1", "akwf-0020-2",
];

describe("the wavetables the editor comes with", () => {
  it("still has every bank a patch may name", () => {
    for (const id of SAVED_WITH) expect(wavetableBank(id), id).toBeDefined();
    expect(wavetableBank(DEFAULT_BANK)).toBeDefined();
  });

  it("gives each bank an id of its own, a name and a number of frames a table can have", () => {
    const ids = WAVETABLE_BANKS.map((bank) => bank.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = WAVETABLE_BANKS.map((bank) => bank.name);
    expect(new Set(names).size).toBe(names.length);
    for (const bank of WAVETABLE_BANKS) {
      expect(bank.id, bank.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(bank.name.trim(), bank.id).toBe(bank.name);
      expect(bank.name.length, bank.id).toBeGreaterThan(0);
      expect(bank.group.length, bank.id).toBeGreaterThan(0);
      expect(Number.isInteger(bank.frames) && bank.frames >= 1 && bank.frames <= 64, bank.id).toBe(true);
    }
  });

  it("keeps the banks of a group together", () => {
    const groups = wavetableGroups();
    expect(new Set(groups.map((g) => g.group)).size).toBe(groups.length);
    expect(groups.flatMap((g) => g.banks)).toEqual([...WAVETABLE_BANKS]);
  });
});
