/**
 * What each module does, for the settings pane: one short line, by module type, and nothing
 * the grid already shows. `docs.test.ts` fails for a module without an entry.
 */
export const MODULE_DOCS: Record<string, string> = {
  // In / Out
  "audio-out": "Sends sound to the Organelle's output.",
  "audio-in": "The Organelle's audio input, left and right.",
  keys: "The note being played, as signals.",
  scope: "Draws the signal patched into it.",

  "osc-wavetable": "Plays the cycles of a wavetable, fading between them by Position.",

  // Sequence
  clock: "A steady tick at a tempo.",
  arpeggiator: "Plays the held keys one at a time, in a pattern.",
  sequencer: "Steps through a tune, one step for each tick of Clock.",

  // Samples
  "sample-player": "Plays its sample on each trigger, transposed by the keys.",
  "sample-head": "Plays its sample at the place patched into Position.",

  "sample-recorder": "Records into its sample, round and round like a tape loop.",
  "tape-head": "Plays what the Recorder of its sample wrote a while ago.",

  "sample-grains": "A cloud of short grains from its sample.",

  // Oscillators
  "osc-sine": "A sine wave.",
  "osc-tri": "A triangle wave: soft, with only odd harmonics.",
  "osc-saw": "A sawtooth wave: bright, with every harmonic.",
  "osc-pulse": "A pulse wave, from square to thin as Width moves.",
  noise: "White noise: every frequency at once.",

  // Random
  "sample-hold": "Holds the value of In each time Trigger goes on.",

  // Envelopes
  "env-adsr": "An envelope with attack, decay, sustain and release.",
  "env-ar": "An envelope that rises while Gate is on and falls after.",
  "env-ad": "A one-shot envelope that rises and falls on each trigger.",
  follower: "Follows how loud a signal is.",

  // LFOs
  lfo: "A slow wave for moving other settings.",
  "lfo-random": "A new random value at each tick, stepped or gliding.",

  // Pitch
  "pitch-transpose": "Moves a pitch by octaves and semitones.",
  "pitch-glide": "Slides from each pitch to the next.",
  "pitch-quantize": "Moves a pitch to the nearest note of a scale.",

  // Filters
  "filter-lp": "Removes what is above the cutoff, 12 dB an octave.",
  "filter-hp": "Removes what is below the cutoff, 12 dB an octave.",
  "filter-bp": "Lets through a band around the cutoff.",
  "filter-notch": "Removes a band around the cutoff.",
  "filter-allpass": "Delays the frequencies around the cutoff, for building phasers.",
  "filter-ladder": "Pd's ladder low-pass, after the Moog, 6 dB an octave on the Organelle.",
  "filter-resonator": "A filter that rings at the cutoff.",
  "filter-soft-lp": "A gentle low-pass, 6 dB an octave.",
  "filter-soft-hp": "A gentle high-pass, 6 dB an octave.",

  // Shapers
  "shaper-soft": "Rounds off the peaks, like an overdriven amplifier.",
  "shaper-hard": "Cuts the peaks off flat.",
  "shaper-fold": "Folds the peaks back, for bright, shifting harmonics.",
  "shaper-cheby": "Turns a sine into one of its harmonics.",
  "shaper-rectify": "Turns the lower half of the wave upwards.",
  "shaper-crush": "Lowers the sample rate and the bits, for grit.",

  // Delay & FX
  "fx-delay": "Repeats the sound after a time.",
  "fx-reverb": "The sound of a space, in stereo.",
  "fx-chorus": "Thickens a sound with two drifting copies.",
  "fx-phaser": "Sweeps notches up and down the sound.",
  "fx-cavern": "Pd's oldest reverb: a long, echoing tail.",
  "fx-room": "Pd's lighter reverb, in stereo.",
  "fx-hall": "Pd's richest reverb, in stereo.",

  // Math
  "math-add": "Adds two signals.",
  "math-multiply": "Multiplies two signals.",
  "math-constant": "A fixed value as a signal.",
  "math-scale": "In times Amount, plus Offset.",
  "math-crossfade": "Blends from A to B as Mix moves.",
  "math-smooth": "Follows its input slowly, rising and falling at times of their own.",
  "math-abs": "Makes a signal positive.",
  "math-min": "The lower of A and B.",
  "math-max": "The higher of A and B.",

  // Logic
  "logic-compare": "On while A is above Threshold.",
  "logic-and": "On while both A and B are on.",
  "logic-or": "On while A or B is on.",
  "logic-not": "On while the input is off.",
  "logic-toggle": "Switches on and off each time its input goes on.",
  "logic-divider": "Lets through one gate in every Divide.",

  // Level & Mix
  amp: "Sets the level of a signal.",
  compressor: "Evens out the loud and the quiet.",
  limiter: "Keeps the sound under Ceiling.",
  attenuator: "Turns a signal down by a fixed amount.",
  mixer: "Adds signals together, each at its own level.",
};
