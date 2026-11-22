/**
 * What each module does, for the settings pane: a few sentences for someone patching, by
 * module type. `docs.test.ts` fails for a module without an entry.
 *
 * These describe what is heard, so they change with the DSP. The numbers here (slopes,
 * thresholds, ranges of the outputs) are the ones `module_dsp.rs` measures.
 */
export const MODULE_DOCS: Record<string, string> = {
  // In / Out
  "audio-out":
    "Sends sound to the Organelle's output. With only Left patched, both sides get it. Level sets the volume, and a signal patched into its input multiplies it.",
  "audio-in":
    "The Organelle's audio input, left and right. It is always on, and what comes after it runs once for all voices. In the editor it is the computer's audio input.",
  keys: "The note being played, as signals: Pitch as a note number (60 is middle C), Gate at 1 while the key is down, Velocity from 0 to 1, and Key, the note number over 127: about 0.47 at middle C, for inputs that multiply a knob.",
  scope:
    "Draws the signal patched into it, in the editor only. Time is the width of the picture and Range its height. Inside the voices it shows the voice of the latest note.",
  "voice-sum":
    "Adds the voices together. Everything patched after it runs once for all voices instead of once for each, which is where a shared filter or effect goes.",

  // Samples
  "sample-player":
    "Plays its sample when Trigger goes on. Middle C plays it as recorded and other keys transpose it; with Pitch not following the note, every key does. Start and Length choose the part to play. Position says where it is, from 0 to 1, and Playing is on until it ends.",
  "sample-head":
    "The sample at the place patched into Position: 0 is its start and 1 its end, and beyond that it goes round. Sweep it with an LFO to scrub, or with an oscillator to scan it as a wave. Start moves the place; Position's knob sets how far the input reaches.",

  "sample-recorder":
    "Records In onto its sample, going round and round. Record switches recording on and off, and a gate patched into it does the same. Overdub is how much of the old sound stays under the new. Out is the tape as it passes: what was there a lap ago, so alone it is a looper. One for all voices.",
  "tape-head":
    "Plays what the Recorder of its sample wrote Delay ago. Patch Out back into that Recorder, through a filter or a shaper if you like, and it is a tape echo whose feedback is yours to shape. Wobble Delay through its input for wow and flutter. One for all voices.",

  // Oscillators
  "osc-sine":
    "A sine wave. Pitch follows the played note unless something else is patched in; Tune moves it in semitones and Fine tune in cents. A signal in the Modulation input changes the pitch or the level, as Modulation mode says, by the amount on its knob.",
  "osc-tri":
    "A triangle wave: soft, with only odd harmonics. Pitch follows the played note; Tune moves it in semitones and Fine tune in cents. A signal in the Modulation input changes the pitch or the level, as Modulation mode says, by the amount on its knob.",
  "osc-saw":
    "A sawtooth wave: bright, with every harmonic. Pitch follows the played note; Tune moves it in semitones and Fine tune in cents. A signal in the Modulation input changes the pitch or the level, as Modulation mode says, by the amount on its knob.",
  "osc-pulse":
    "A pulse wave. Width is the part of each cycle spent high: 50 % is a square, and either end is thin and nasal. Width modulation adds to Width. The other settings work as on the other oscillators.",
  noise: "White noise: every frequency at once. Each voice has its own. Filter it for wind and drums, or sample it for random values.",

  // Random
  "sample-hold":
    "Takes the value of In each time Trigger goes on, and holds it until the next time. Trigger follows the key gate, so on its own it gives one value for each note.",

  // Envelopes
  "env-adsr":
    "An envelope from 0 to 1 that starts when Gate goes on. Attack is the time to rise, Decay the time to fall to Sustain, and Release the time to fall to 0 after the key. A voice keeps sounding until it has ended. The inputs are read when a stage starts.",
  follower:
    "Follows how loud In is and gives that as a signal: about 0.7 for a full-level sine. Smooth is how slowly it follows, and Level scales the result.",

  // LFOs
  lfo: "A slow wave for moving other settings. Out swings between -1 and 1; the 0–1 output is the same wave between 0 and 1, for inputs that multiply a knob. Reset starts the wave again, and follows the key gate, so each note starts it from the beginning.",
  "lfo-random":
    "A new random value at each tick of Rate. Smooth is the part of each tick spent gliding to it: 0 steps, 1 never rests. Out is between -1 and 1 and the 0–1 output between 0 and 1. Every voice gets its own values.",

  // Pitch
  "pitch-transpose":
    "Moves a pitch by Octave and Semitones, and by the Modulation input times its knob in semitones. Patch Out into an oscillator's Pitch.",
  "pitch-glide":
    "Slides from each pitch to the next instead of jumping. Time is how long the slide takes. Patch Out into an oscillator's Pitch.",
  "pitch-quantize":
    "Moves a pitch to the nearest note of Scale, counted from Root. The Modulation input, times Range in semitones, is added first, so an LFO or a random value becomes a melody in key.",

  // Filters
  "filter-lp":
    "Lets through what is below Cutoff and removes what is above, 12 dB an octave. Resonance raises the frequencies at the cutoff. Modulation moves the cutoff, by its knob in semitones for a signal of 1.",
  "filter-hp":
    "Lets through what is above Cutoff and removes what is below, 12 dB an octave. Resonance raises the frequencies at the cutoff. Modulation moves the cutoff, by its knob in semitones for a signal of 1.",
  "filter-bp":
    "Lets through a band around Cutoff and removes the rest. Resonance makes the band narrower. Modulation moves the cutoff, by its knob in semitones for a signal of 1.",
  "filter-notch":
    "Removes a band around Cutoff and lets through the rest. Resonance makes the band narrower. Modulation moves the cutoff, by its knob in semitones for a signal of 1.",
  "filter-allpass":
    "Changes no levels, only when each frequency arrives: those around Cutoff are delayed most. Mixed with its own input it makes the notches of a phaser, so it is a piece for building effects.",
  "filter-ladder":
    "Pd's model of the Moog ladder low-pass, which grows thicker when driven and sings at full Resonance. On the Organelle's version of Pd it is gentle, 6 dB an octave, and the editor plays it the same way.",
  "filter-resonator":
    "A filter that rings at Cutoff: Resonance makes it ring longer and narrower. Band has what is around the cutoff, and Low what is below it. Resonance works a little slower here than elsewhere, about a hundred times a second.",
  "filter-soft-lp":
    "The gentlest low-pass: 6 dB an octave above Cutoff and no resonance. For taking the edge off a sound, or for smoothing a control signal.",
  "filter-soft-hp":
    "The gentlest high-pass: 6 dB an octave below Cutoff and no resonance. For thinning a sound, or for taking a steady offset out of a signal.",

  // Shapers
  "shaper-soft":
    "Rounds off the peaks, the way an overdriven amplifier does. Drive pushes the signal into the curve, Modulation adds to Drive from a signal, and Bias shifts the signal first, which makes the result lopsided and brings out even harmonics.",
  "shaper-hard":
    "Cuts the peaks off flat: harsher than Soft Clip. Drive pushes the signal into the limit, and Modulation adds to Drive from a signal.",
  "shaper-fold":
    "Folds the peaks back instead of cutting them, again and again as Fold rises, which adds bright, shifting harmonics. Symmetry shifts the signal first, and Shape chooses between sharp and round folds.",
  "shaper-cheby":
    "Turns a full-level sine into the harmonic that Harmonic names: 2 is an octave up, 3 an octave and a fifth. Between whole numbers it fades from one to the next, and Modulation moves it. Other sounds, and other levels, come out as a mix of harmonics. Drive sets the level going in.",
  "shaper-rectify":
    "Turns the lower half of the wave upwards. Amount 0 leaves the sound as it is, 0.5 removes the lower half, and 1 flips it up, which sounds an octave higher.",
  "shaper-crush":
    "Lowers the quality on purpose. Rate is how often the signal is measured: the lower, the more clanging tones that were not in the sound. Bits is how finely: few bits is gritty. Modulation moves Rate.",

  // Delay & FX
  "fx-delay":
    "Repeats the sound after Time. Feedback is how much of each repeat goes round again, and Tone darkens the repeats. Mix blends the echoes with the sound itself. Inside the voices each note has its own echoes, which ring on after the key.",
  "fx-reverb":
    "The sound of a space, in stereo. Size is how large, Decay how long it rings, and Damping how quickly the highs die away. Mix blends it with the sound itself.",
  "fx-chorus":
    "Thickens a sound with two copies whose pitch drifts, one on each side. Rate is the speed of the drift and Depth its width. Feedback turns it towards a flanger.",
  "fx-phaser":
    "Sweeps a set of notches up and down the sound. Rate is the speed of the sweep and Depth its width. Feedback makes the notches sharper.",
  "fx-cavern":
    "Pd's oldest reverb: a long, echoing tail, like a cave or a tunnel. Decay is never shorter than a couple of seconds. Mix blends it with the sound itself.",
  "fx-room":
    "Pd's lighter reverb, in stereo. Decay is how long it rings, and Damping how much faster the frequencies above Tone die away. Mix blends it with the sound itself.",
  "fx-hall":
    "Pd's richest reverb, in stereo: denser than Room, and heavier for the Organelle to run. Decay is how long it rings, and Damping how much faster the frequencies above Tone die away.",

  // Math
  "math-add": "A plus B. Adds two signals: two modulations into one input, or an offset onto a wave.",
  "math-multiply": "A times B. One signal sets the level of the other: an envelope on an LFO, or two sounds for ring modulation.",
  "math-constant":
    "A fixed value as a signal, to patch into any input. Out is Value times Range, and times whatever is patched into the Value input.",
  "math-scale": "In times Amount, plus Offset. A negative Amount turns the signal upside down.",
  "math-crossfade": "Blends two signals: A at Mix 0, B at Mix 1, and both in between. Patch a signal into Mix to move from one to the other.",
  "math-smooth":
    "Follows its input slowly: Rise is the time it takes to go up and Fall the time to come down. Turns a gate into a simple envelope, or a stepped signal into a gliding one.",
  "math-abs": "Makes everything positive: -0.5 becomes 0.5. On sound it is a full-wave rectifier; on an LFO it doubles the speed.",
  "math-min": "The lower of A and B at each moment.",
  "math-max": "The higher of A and B at each moment.",

  // Logic
  "logic-compare":
    "On (1) while A is above Threshold, otherwise off (0). With a signal in the Threshold input it compares two signals. Turns any wave into a gate.",
  "logic-and": "On (1) while both A and B are on, otherwise off (0). A signal counts as on above 0.5.",
  "logic-or": "On (1) while A or B is on, or both, otherwise off (0). A signal counts as on above 0.5.",
  "logic-not": "On (1) while the input is off, and off (0) while it is on. A signal counts as on above 0.5.",
  "logic-toggle":
    "Switches over each time its input goes on: on at the first, off at the second. The input follows the key gate, so every other note has it on.",
  "logic-divider": "Lets through the first of every Divide gates and holds back the rest. At 2, every other gate passes.",

  // Level & Mix
  amp: "Sets the level of a signal: In times Level, and times whatever is patched into the Level input. An envelope there is what gives a note its shape.",
  mixer: "Adds signals together, each at its own level. A new input appears when the last one is taken, up to eight.",
};
