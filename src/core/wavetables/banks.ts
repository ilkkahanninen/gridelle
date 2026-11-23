import list from "../../../banks/banks.json";

/**
 * A wavetable the editor comes with: a row of single cycles for a Wavetable oscillator to
 * go through. The list is `banks/banks.json`, which the Rust side reads too
 * (`src-tauri/src/banks.rs`): that is where each bank is made, when a patch uses it. The
 * first groups are made from formulas and move smoothly from one end to the other; the
 * AKWF groups are Adventure Kid Waveforms, single cycles of all kinds that are in the
 * public domain, a folder of them to a bank.
 */
export interface WavetableBank {
  /** What a patch is saved with. An id never changes, and a bank is never taken away. */
  id: string;
  name: string;
  /** The kind of bank, for the list to be read by. */
  group: string;
  /** How many cycles it has, 1 to 64. */
  frames: number;
  /** For a bank of Adventure Kid Waveforms: where it starts among them. The Rust side's to read. */
  akwf?: number;
}

export const WAVETABLE_BANKS: readonly WavetableBank[] = list;

/** The bank a new Wavetable oscillator gets. `DEFAULT_BANK` in `banks.rs` is the same. */
export const DEFAULT_BANK = "basic-shapes";

const BY_ID = new Map(WAVETABLE_BANKS.map((bank) => [bank.id, bank]));

export const wavetableBank = (id: string): WavetableBank | undefined => BY_ID.get(id);

/** The banks by group, groups and banks in the order of the list. */
export function wavetableGroups(): { group: string; banks: WavetableBank[] }[] {
  const groups: { group: string; banks: WavetableBank[] }[] = [];
  for (const bank of WAVETABLE_BANKS) {
    const last = groups[groups.length - 1];
    if (last?.group === bank.group) last.banks.push(bank);
    else groups.push({ group: bank.group, banks: [bank] });
  }
  return groups;
}
