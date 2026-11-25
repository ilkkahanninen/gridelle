/*
 * The Organelle M's level meters, as its own software makes them (Organelle OS 3.2). The
 * host patch (`mother.pd`, subpatch `audioIO`) measures each channel with Critter &
 * Guitari's `pvu~ 100`: every 100 ms the highest absolute sample since the last reading, or
 * the last result times exp(-100 / 300) if that is higher. It turns that into segments, input
 * `sqrt(peak) * 14 - 2` and output `sqrt(peak) * 12`, made whole numbers on the way to the
 * screen, which shows 0 to 11 of them (`OledScreen::drawInfoBar`). The output is measured
 * after the volume, as it is heard.
 */

/** How often the device reads the levels, in ms. */
export const METER_TICK_MS = 100;
/** How long a peak takes to fall to 37 % (`pvu~`'s release time), in ms. */
const RELEASE_MS = 300;
/** How many segments each meter has. */
export const SEGMENTS = 11;

/** The four levels in the order the engine gives them: input left, right, output left, right. */
export type Levels = readonly [number, number, number, number];

export const SILENT: Levels = [0, 0, 0, 0];

/** The held peaks after one reading of `latest`, the highest since the reading before. */
export function nextPeaks(held: Levels, latest: Levels): Levels {
  const keep = Math.exp(-METER_TICK_MS / RELEASE_MS);
  return held.map((peak, i) => Math.max(peak * keep, latest[i])) as unknown as Levels;
}

const segments = (value: number) => Math.min(SEGMENTS, Math.max(0, Math.trunc(value)));

/** The segments lit on the screen for held peaks: input left, right, output left, right. */
export function meterSegments(peaks: Levels): Levels {
  return [
    segments(Math.sqrt(peaks[0]) * 14 - 2),
    segments(Math.sqrt(peaks[1]) * 14 - 2),
    segments(Math.sqrt(peaks[2]) * 12),
    segments(Math.sqrt(peaks[3]) * 12),
  ];
}
