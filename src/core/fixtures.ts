import { DOCUMENT_VERSION, type PatchDocument } from "./model/types";

/**
 * Example patches. They double as compiler test fixtures (their compiled output is
 * kept in `tests/golden` and loaded into real Pd by the Rust tests).
 */

/** Saw into a low-pass with its own envelope, into an amp with a second envelope. */
export const basicSynth: PatchDocument = {
  version: DOCUMENT_VERSION,
  name: "Basic Synth",
  voices: 4,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: {} },
    { id: "ge2", type: "filter-lp", x: 2, y: 0, params: { cutoff: 400, res: 0.5, mod: 48 } },
    { id: "ge3", type: "amp", x: 4, y: 0, params: {} },
    { id: "ge4", type: "audio-out", x: 5, y: 0, params: {} },
    { id: "ge5", type: "env-adsr", x: 0, y: 2, params: { attack: 2, decay: 300, sustain: 0.2, release: 200 } },
    { id: "ge6", type: "env-adsr", x: 3, y: 2, params: { attack: 2, decay: 100, sustain: 0.8, release: 150 } },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge2", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge2", port: "mod" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge3", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge3", port: "cv" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "left" } },
  ],
  pages: [
    {
      name: "Filter",
      knobs: [
        { module: "ge2", param: "cutoff" },
        { module: "ge2", param: "res" },
        { module: "ge2", param: "mod" },
        { module: "ge1", param: "tune" },
      ],
    },
    {
      name: "Amp envelope",
      knobs: [{ module: "ge6", param: "attack" }, null, { module: "ge6", param: "sustain" }, { module: "ge6", param: "release" }],
    },
  ],
};

/** Two detuned saws per voice, with one filter shared by all voices after the voice sum. */
export const sharedFilter: PatchDocument = {
  version: DOCUMENT_VERSION,
  name: "Shared Filter",
  voices: 3,
  modules: [
    { id: "ge1", type: "osc-saw", x: 0, y: 0, params: { fine: -8 } },
    { id: "ge2", type: "osc-saw", x: 0, y: 2, params: { tune: 12, fine: 8 } },
    { id: "ge3", type: "env-adsr", x: 0, y: 4, params: { release: 400 } },
    { id: "ge4", type: "amp", x: 3, y: 0, params: { level: 0.5 } },
    { id: "ge5", type: "amp", x: 3, y: 2, params: { level: 0.5 } },
    { id: "ge6", type: "voice-sum", x: 5, y: 0, params: {} },
    { id: "ge7", type: "voice-sum", x: 5, y: 2, params: {} },
    { id: "ge8", type: "filter-lp", x: 6, y: 0, params: { cutoff: 2500 } },
    { id: "ge9", type: "audio-out", x: 8, y: 0, params: {} },
  ],
  cables: [
    { from: { module: "ge1", port: "out" }, to: { module: "ge4", port: "in" } },
    { from: { module: "ge2", port: "out" }, to: { module: "ge5", port: "in" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge4", port: "cv" } },
    { from: { module: "ge3", port: "out" }, to: { module: "ge5", port: "cv" } },
    { from: { module: "ge4", port: "out" }, to: { module: "ge6", port: "in" } },
    { from: { module: "ge5", port: "out" }, to: { module: "ge7", port: "in" } },
    { from: { module: "ge6", port: "out" }, to: { module: "ge8", port: "in" } },
    { from: { module: "ge8", port: "out" }, to: { module: "ge9", port: "left" } },
    { from: { module: "ge7", port: "out" }, to: { module: "ge9", port: "right" } },
  ],
  pages: [],
};

export const fixtures = { "basic-synth": basicSynth, "shared-filter": sharedFilter } as const;
