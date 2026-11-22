/**
 * The picture on a module's card in the browser, as SVG path data in a 28 x 20 box,
 * drawn as a line. Oscillators show their wave, filters their response, shapers the
 * curve they bend the signal with.
 */
export const GLYPHS: Record<string, string> = {
  "audio-out": "M4 8H8L13 4V16L8 12H4Z M17 7Q19.5 10 17 13 M20.5 4Q25 10 20.5 16",
  "voice-sum": "M20 4H8L15 10L8 16H20",
  "osc-sine": "M2 10C6 -1 10 -1 14 10S22 21 26 10",
  "osc-tri": "M2 10L8 3L20 17L26 10",
  "osc-saw": "M2 16L14 4V16L26 4V16",
  "osc-pulse": "M2 16H5V4H13V16H21V4H26",
  noise: "M2 10L4 6L6 14L8 3L10 12L12 8L14 17L16 5L18 11L20 7L22 15L24 9L26 11",
  "env-adsr": "M2 17L7 3L12 9H19L26 17",
  "filter-lp": "M2 9H12C15 9 16 4 18 4C20 4 21 12 25 17",
  "filter-hp": "M26 9H16C13 9 12 4 10 4C8 4 7 12 3 17",
  "filter-bp": "M2 17Q9 17 11 10Q14 -2 17 10Q19 17 26 17",
  "filter-notch": "M2 6H9Q12 6 13 12L14 17L15 12Q16 6 19 6H26",
  "shaper-soft": "M2 17C10 17 11 14 14 10C17 6 18 3 26 3",
  "shaper-hard": "M2 16H8L20 4H26",
  "shaper-fold": "M2 8L8 16L20 4L26 12",
  "shaper-cheby": "M2 17C4 4 7 0 10 5C12 8 16 12 18 15C21 20 24 16 26 3",
  "shaper-rectify": "M2 16Q8 -6 14 16Q20 -6 26 16",
  "shaper-crush": "M2 17H6V13H11V9H16V6H21V3H26",
  amp: "M8 3L22 10L8 17Z",
  mixer: "M2 4H8L16 10H26 M2 10H16 M2 16H8L16 10",
};
