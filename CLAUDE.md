# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Gridelle is a Tauri 2 desktop editor (React + TypeScript front end, Rust back end) for building modular synths on a grid and exporting them as Pure Data patch folders for the Critter & Guitari Organelle M.

## Commands

Prerequisites: Node 22+, stable Rust, and a C compiler (`build.rs` compiles libpd from source).

```sh
git submodule update --init --recursive   # vendored libpd; the Rust build asserts it is present
npm install

npm run tauri dev      # the desktop app, with audio preview
npm run dev            # UI only in a browser on :1420; editing works, the engine is a silent stub
npm run build          # tsc typecheck + vite build
npx tsc --noEmit       # typecheck only (there is no linter)

npm test               # vitest: compiler, Pd file builder, model ops, registry, preview sync
npm run test:pd        # cargo test in src-tauri: real Pd (libpd), headless; plays tests/golden, measures module DSP
```

Single tests:

```sh
npx vitest run src/core/compiler/compiler.test.ts -t "is deterministic"
cd src-tauri && cargo test --test compiled_patches
cd src-tauri && cargo test --test module_dsp -- --nocapture   # prints measured pitch, levels and filter responses
cd src-tauri && cargo test --test sample_dsp                  # the sample helpers and modules, on a sample whose contents say what was read
cd src-tauri && cargo test --test engine_audio -- --ignored   # opt-in: plays through the real audio device at -40 dB; the only test of the audio callback, scopes included
cd src-tauri && ORGANELLE_ADDRESS=<ip> cargo test --test organelle_send -- --ignored --nocapture   # opt-in: writes the patch Gridelle_Test to a real Organelle and starts it
cd src-tauri && ORGANELLE_ADDRESS=<ip> ORGANELLE_PATCH=flavours cargo test --test organelle_send -- --ignored   # the same with another fixture, or the path of any patch folder
```

### Golden files tie the two test suites together

`tests/golden/<fixture>/` holds the compiled output of each document in `src/core/fixtures.ts`, as a complete Organelle patch folder. The vitest compiler test compares against it with `toMatchFileSnapshot`; the Rust `compiled_patches` test then opens each folder in libpd and checks that it is silent at rest, audible on a chord, silent after release, prints nothing to the Pd console, and (for `basic-synth`) that knob paging, soft takeover and screen text behave.

So after any change that alters compiler output or a `pd-lib/modules` abstraction:

1. `npx vitest run -u` to rewrite the golden files, and review the diff.
2. `npm run test:pd` to prove the new files actually work in Pd.

Without `-u`, `npm test` fails on a golden file that no longer matches instead of rewriting it, and running the Rust tests without regenerating tests the old patches.

A new entry in `fixtures` gets its golden folder on the next `npm test`, and the Rust test picks up every folder that contains a `main.pd`. `basicSynth` is also the document the app opens with (`src/state/store.ts`).

## Architecture

### Pipeline

```
PatchDocument ──compile()──► { "main.pd", "voice.pd", "ge-*.pd" } ──► preview engine (libpd) or export folder
 (src/core/model)  (src/core/compiler + pd-lib/modules)
```

`src/core` is pure TypeScript with no React or Tauri imports, and `compile(doc, library)` is a pure function. Both the live preview and the export run the same compile and write the same files, so what is heard in the editor is what lands on the device.

### Document model (`src/core/model`)

`PatchDocument` holds modules placed on a grid, cables (output port → input port; every cable is an audio-rate signal and an input takes one cable), and knob pages (4 knobs per page; always 8 pages, see below). All edits go through the functions in `ops.ts`, which never mutate and return the *same object* when nothing changed. The editor store relies on that identity: `apply()` skips the undo step when `next === doc`, and unsaved-changes detection is `doc !== savedDoc`.

`ops.ts` keeps a document valid while it is edited (one cable per input, no feedback loops, no overlapping tiles). `analyze.ts` checks the cable and loop rules again and reports them as diagnostics, because `parseDocument` accepts any well-shaped file, including ones with unknown module types.

A module dragged from the browser onto a port of another module is cabled in by `ops.addModuleAtPort`. `planPortDrop` decides what that means and is also what the canvas previews, so the two cannot disagree. The new module uses its first input and first output. On a free port it lands beside the port, or as near as there is room. On a cabled port it goes in between (dropped on an output, in front of everything that output feeds); when the spot beside the port is taken it takes that place in the row and `makeRoom(…, "right")` moves the tiles there along. A module with no input or no output to go in between with is cabled to the port alone.

`ops.removeModules` is the reverse: a module taken out of a chain leaves the chain patched. What fed its first input now feeds whatever its first output fed, looking through a run of removed modules; cables on its other ports go with it. Tiles are not moved back.

The patch's samples (`samples`, set with `ops.setSample`) are described under Samples below.

A new document field touches `types.ts`, the hand-written shape check in `serialize.ts` (plus `DOCUMENT_VERSION` if older builds cannot read the result), and `structureKey` if it changes the emitted patch.

A module can have a name of its own (`ModuleInstance.name`, set with `ops.renameModule` from the field at the top of the settings pane). `ops.moduleName` is what a module is called: that name, or its type's when it has none. It is what the tile shows, what names the module's settings in the Knob pages panel and on the Organelle's screen (`slotLabel`), and what diagnostics call it. The name is in `structureKey` only for a module with a setting on a knob, since nothing else of it is exported.

Module ids are `ge<n>` and must match `/^ge[0-9a-z]+$/`. The id is also the module's Pd creation argument and the prefix of its parameter receivers (`ge3-cutoff`); the `ge` prefix keeps them clear of the names the Organelle host uses (`knob1`, `notes`, `aux`, `vol`, …). Generated plumbing uses names with a hyphen straight after `ge` (`ge-page`, `ge-slot-<page>-<knob>` with a 0-based page and 1-based knob, the `ge-*` abstractions), which no module id can produce.

### Modules: a registry entry plus a hand-written Pd abstraction

A module is two things that must agree:

- a `ModuleDef` in `src/core/modules/registry.ts` (ports, params, tile size, scope);
- `pd-lib/modules/<def.pd>.pd`, a flat abstraction whose `inlet~`/`outlet~` objects match the def's inputs/outputs left to right, and which has one `[r $1-<paramId>]` per param. No control inlets or outlets.

`registry.test.ts` enforces the match by parsing the `.pd` text (`src/core/pd/inspect.ts`, flat patches only, no subpatches). It also checks that every object class used is one the device has: the allowlist of Pd 0.49's core in `src/core/pd/vanilla049.ts`, or `PD_EXTRA_049` there, the few objects from Pd's `extra` folder that modules wrap (see below). The preview embeds a newer Pd than the device has, so an object missing from those lists could work in the editor and fail on the Organelle; extend them only after checking the object exists in Pd 0.49.

Labels are whole words (Resonance, Modulation, Attack): they name the rows of a tile and are read in the settings pane's texts. `ParamDef.short` is the name for the Organelle's screen where the label does not fit on a line with the module's name and the value (`Low-pass Res 0.5`); `slotLabel` in `knobPages.ts` tries the label, then the short name, then trims the module's name. Ids keep their old short forms (`res`, `mod`, `depth`, `cv`), since saved patches and the abstractions' receivers use them.

Params are stored and sent in real units (Hz, ms, semitones). `ParamDef.decimals` fixes how many decimals a value is shown with, in the editor and on the Organelle's screen, where the default (fewer for a wider range) would hide the low end, as with an LFO's 0.02 Hz. `params.ts` maps a 0–1 control position to a value (`lin`/`exp`); `knobPages.ts` emits the same mapping as Pd objects, so the two must stay equivalent.

A param with `options` is a choice (an oscillator's Modulation mode). Its value is the option's index, so it is stored, clamped and sent like any other number, and changing it is a live update, not a reload. The inspector draws it as a list; it gets no knob on the tile, and so cannot be put on an Organelle knob, whose screen line would show the bare index.

**Helper abstractions.** `pd-lib/modules` also holds abstractions that are not modules (`ge-voice`, `ge-knob`, `ge-blep`, `ge-osc-mod`, `ge-filter-poles`, `ge-drive`). `compile()` ships a module's file together with everything it is built from, transitively (`withHelpers` in `compiler/index.ts`): any object class in an abstraction that is not on the Pd 0.49 allowlist is taken to be another abstraction, and is a `missing-abstraction` error if the library lacks it. Parameter receivers (`[r $1-<id>]`) must stay in the module's own file, because that is where the registry test looks for them.

**Measured, not assumed.** `src-tauri/tests/module_dsp.rs` loads each abstraction in real Pd and checks what it does: oscillator pitch, level, DC and aliasing, and each modulation mode (including the side bands of linear FM); each filter's gain at several frequencies against the response it is designed to have; each shaper's output against its curve, sample by sample; the mixer's sum; the envelope's stages with each input at several values; and for every setting input, that the knob at `v` with the input at `k` gives the same samples as the knob at `v * k`. Change the DSP of a module and this is the test to extend. (It found that the first Low-pass, built on `vcf~`, went silent when opened fully.)

**Oscillator modulation.** Every oscillator ends its pitch chain (note + Tune + Fine tune) in `ge-osc-mod`, which takes the Modulation input, its knob (`depth`) and Modulation mode and returns the frequency in Hz and an output gain. Only the selected mode's amount is non-zero, each behind a 20 ms ramp: linear FM is `frequency * (1 + mod * 8 * depth²)`, exponential FM adds `mod * 48 * depth²` semitones before `mtof~`, AM is a gain of `1 + mod * depth`. The mode numbers in the registry's option list must match the `[== n]` objects there. Linear FM can take the frequency below zero, where `phasor~` and `osc~` run backwards; `ge-blep` therefore takes the absolute frequency.

**Filters** are the standard "cookbook" (RBJ) biquads, built so the cutoff can move at audio rate: `ge-filter-poles` makes the pole pair from two `cpole~` with signal-rate coefficients and outputs the gain each filter type needs; the module adds its zeros with `rzero~` (Notch is the input minus the band-pass). Coefficients come from the sine and cosine of *half* the angle, because Pd's cosine table is too coarse to take `1 - cos w` from near zero. Resonance (times its input, clipped to 0–1) maps to Q 0.7–15, and Low-pass and High-pass are turned down by `sqrt(0.7/Q)`.

**Shapers** have an In and a Modulation input, besides the inputs of their settings. Soft Clip, Hard Clip and Wavefolder share `ge-drive`: Drive in dB before the shaping, plus Modulation dB per unit of the mod signal.

- Soft Clip is `tanh` written with `exp~`, with a Bias that shifts the signal first.
- Wavefolder reads a triangle with the signal (`wrap~`, `abs~`) or, with Shape set to Sine, a sine (`cos~`); Symmetry is its shift.
- Rectifier multiplies the negative half by `1 - 2 * amount` (0 clean, 0.5 half-wave, 1 full-wave).
- Bitcrusher holds samples with `samphold~` clocked by a `phasor~` at Rate, then rounds to `2^(bits - 1)` steps per side (`x + 0.5` minus its `wrap~`).
- Chebyshev builds T1–T8 with the recurrence `T(n+1) = 2x T(n) - T(n-1)` on an input clipped to ±1; Harmonic (`order`, moved by Modulation) fades between neighbouring polynomials.

A shaper must give exactly 0 for silence, or every idle voice puts DC or a thump on the output. So whatever a shift (Bias, Symmetry) alone would produce is subtracted after the curve, and the even polynomials are moved to be 0 at 0. The `hip~ 5` that ends the lopsided ones only removes the DC that appears while a signal is present; the DSP test runs the same filter over its expected curve. None of the shapers is oversampled, so hard driving aliases.

A bare `;` in a Pd comment ends the box, and Pd then tries to deliver the rest as a message on load ("no such object"). `registry.test.ts` checks every abstraction for it.

**Setting inputs (Eurorack style).** Every setting with a knob has an input of its own: `PortDef.param` ties an input to a parameter, and the module multiplies the two, so the knob scales what is patched in. `PortDef.unpatched` is the signal such an input holds with no cable (1, so that the knob alone gives the value). A Pd abstraction cannot tell whether an `inlet~` is connected, so the compiler supplies it: `analyze` lists the unpatched inputs as `constants`, and `emit` adds one `[sig~ <value>]` per value to `voice.pd` or `main.pd` and connects it. A test patch has to do the same (`with_module` in `module_dsp.rs`), or the setting is multiplied by 0.

- The multiplication is at signal rate, on the smoothed knob value, in the unit the knob shows: a filter's Cutoff input multiplies Hz (after Modulation has been added in semitones), a shaper's Drive input multiplies dB.
- A **Modulation** input (port id `mod`) is tied to its amount knob (`depth` on the oscillators, `mod` elsewhere, both labelled Modulation) and has no `unpatched`: it rests at 0 and adds to another setting, as before. The Pulse's Width modulation (`pwm`) has no knob. The Amp's Level input has the id `cv`.
- Choices have no input.
- The ADSR is the exception to "signal rate": it reads its inputs when a stage starts. `snapshot~` takes Attack, Decay and Sustain at gate on and Release at gate off, times the knob values, into the one `vline~` it always had (which is what keeps a retrigger from clicking). A change during a stage waits for the next one, and a negative product counts as 0.
- A filter's Resonance goes through `exp~` to become Q, so Q and the level trim are signals, and `ge-filter-poles` takes Q at a signal inlet. `ge-drive` has a signal inlet that multiplies Drive.

**LFOs.** `ge-lfo` and `ge-lfo-random` are modulation sources with two outlets: the wave between -1 and 1, and the same wave between 0 and 1 for the inputs that multiply a setting. Level scales both.

- The LFO computes its five shapes from one `phasor~` and multiplies each by a 0/1 gate from the Shape choice (the option order in the registry must match the `[== n]` objects). Sine and Triangle are shifted to start at 0 going up. Reset sets the phase to 0 on a rising edge, and has the gate pre-cord, so by default each note's LFO starts from the beginning; with the pre-cord off it runs free.
- Random clocks a `samphold~` of `noise~` with a `phasor~`. A second `samphold~` behind a one-sample delay (`biquad~ 0 0 0 1 0`) keeps the previous value, and Smooth is the part of each tick spent gliding between the two. Every `noise~` has its own sequence, so each voice gets its own values.

**Effects** (`ge-fx-*`) are per-voice modules like any other; after a Voice Sum they run once. Each has `tail: true` (see voice life under the compiler).

- Delay lines are named with `$0`, which differs in every copy of an abstraction, so each voice has its own. Never name one with `$1`: that is the module id, the same in every voice.
- A delay line that feeds itself cannot be shorter than one block (64 samples, 1.5 ms): the Delay's shortest time, the Chorus's 2 ms base and the Reverb's shortest all-pass (1.7 ms) are all above it. The Phaser needs its feedback sooner than that, so it runs at `block~ 16`.
- Delay: `vd~`, fed back through a one-pole low-pass (`rpole~` with a signal coefficient) at Tone. Chorus: two `vd~` taps swept a quarter cycle apart by its own LFO, the left one fed back. Phaser: four first-order all-pass stages (`rzero_rev~` then `rpole~` with the same coefficient), swept in pitch around 784 Hz. Reverb: four fed-back delays in parallel, each with the gain that makes it fall 60 dB in Decay seconds and a low-pass at Damp, summed differently for left and right, then two Schroeder all-pass delays a side.
- All-pass (in the Filter group) is the input minus twice the band-pass, from the same `ge-filter-poles`.

**Wrappers of Pd's own objects.** Some modules are a thin patch around an object of Pd itself, for another flavour of a job Gridelle already does: Ladder (`bob~`), Resonator (`vcf~`), Soft Low-pass and Soft High-pass (`lop~`, `hip~`), Cavern, Room and Hall (`rev1~`, `rev2~`, `rev3~`), Sample & Hold (`samphold~`) and Follower (`env~`).

- `bob~` and the three reverbs live in Pd's `extra` folder. An exported patch names them and does not carry them: the Organelle's Pd has them (checked on a device with OS 3.2, where they are in `/usr/lib/puredata/extra`). The preview's Pd gets them in `Pd::init()` (`engine/pd.rs`): `bob~` is compiled in and set up there, and the reverbs' five `.pd` files are embedded from the vendored Pd, written to a temp folder and put on the search path. A new one needs `PD_EXTRA_049`, and `EXTRA_SOURCES` in `build.rs` or `EXTRA_ABSTRACTIONS` in `pd.rs`.
- `Pd::init()` also sends `pd compatibility 0.49`, so the preview behaves as the device's Pd where Pd offers the choice. Of the things that make sound that is `bob~`, which before 0.52 gave the first of its four stages: on the Organelle the Ladder falls 6 dB an octave, not 24. The DSP test measures exactly that, and a self-test patch run on the device gave the same numbers as the preview to four decimals (a sine three octaves above the cutoff comes out 17.66 dB down).
- Where Pd wants a setting as a number (the Resonator's Q, the reverbs' decay, damping and crossover, the Follower's Smooth), the knob times its input is read with `snapshot~` on a 10 ms `metro` and sent on when it has changed. Those inputs work, but not per sample.
- The soft filters are not the objects themselves: `lop~` and `hip~` take their cutoff as a number in Pd 0.49. They are rebuilt from `rpole~` and `rzero~` with the same coefficients, and the DSP test compares them with the real objects.
- Decay is in seconds on all reverbs. For Room and Hall it becomes a liveness percentage through a loop time measured in the DSP test. For the Cavern, `rev1~`'s help is wrong about its own setting: measured, it takes 216 / (100 - dB) seconds to fall 60 dB and never under 2.2 s, so that is the formula used and the range offered.

**Pitch modules** take and give a pitch the way the oscillators' Pitch input takes it: a note number as a signal (60 is middle C). Their Pitch input has the pitch pre-cord.

- Transpose adds 12 times Octave, Semitones and Modulation times its amount. Glide is a one-pole low-pass on the pitch, with the pole that covers 95 % of the way in Time. Quantizer adds Modulation times Range, splits the result into whole octaves above Root and a rest, and looks the rest up in a 13-entry table (`[table $0-scale]`, filled by the Scale choice) that maps each semitone to the nearest note of the scale, the lower one on a tie. The Scale options in the registry are in the order of `SCALES` in the generator.
- Keys (in the In / Out group) gives the played note as outputs: pitch, gate, velocity, and the pitch as 0..1. It has no inputs: `voiceInlets` on its def names the voice signals its abstraction takes at its first inlets, and `analyze` feeds them through the same list as the pre-cords. A module's own inputs come after those inlets (`inletOf`).
- An idle voice's pitch is 60, not 0 (`ge-voice`), so that a Glide starts its first note from middle C and not from the bottom of the range.

**Math and logic modules** work on any signal. Those without knobs (Add, Multiply, Min, Max, Abs, And, Or, Not, Toggle) are one-cell tiles in the plain layout; those with knobs use rows.

- Logic treats a signal as on above 0.5 and gives exactly 0 or 1. With no comparison objects on the Pd 0.49 list, a gate is a steep ramp through the threshold, clipped: `(x - 0.5) * 1000000`, `clip~ 0 1`.
- Toggle and Divider count rising edges as a signal: the gate through `rzero~ 1` and `max~ 0` is 1 at the sample it rises, and `rpole~ 1` adds those up. Toggle is whether the count is odd; Divider passes the gate while `(count - 1) / N` is a whole number.
- Smooth runs two one-pole low-passes, one at Rise and one at Fall, and takes the higher of them when Rise is the shorter time and the lower when Fall is. That is exact for a step, which is what it is for.
- Their ports have the `mod` or `gate` hint, but sound patched through one is still sound: `emitVoice` works out which modules may carry sound by following cables from every module with an audio output, and that set, not the port's hint, decides what is muted on its way into a module with a tail.

**Samples.** A patch has up to eight samples (`PatchDocument.samples`, letters A–H in the editor, slots 0–7 in the patch), each a sound file or a blank tape of some seconds. A cable is a signal and cannot carry a sample, so the sample modules each choose one, and that shared choice is what links them: no cable is needed between a module that writes a sample and one that reads it.

- The choice is `sampleChoice`, a param with `argument: true`: the value is a creation argument of the abstraction (`$2`), has no receiver, is left out of `paramValues`, and is part of `structureKey`, so changing it reloads. Names inside a sample module are therefore fixed when it is created (`tabread4~ ge-sample-$2`). `argumentValues` in `analyze.ts` gives them in order; a `tap`'s numbers come after.
- `main.pd` gets one helper per slot a module uses (`analysis.samples`): `ge-sample-file <slot> <file>` reads `ge-sample-<letter>.wav` with `soundfiler` on load, `ge-sample-tape <slot> <seconds>` resizes its table to that many seconds at Pd's rate in whole blocks. An empty slot that a module uses is a tape of 0 seconds (one block of silence) and the `empty-sample` warning, so that Pd has a table and prints nothing. Both then send the rate in Hz to `ge-sample-<slot>-rate` and the size in samples to `ge-sample-<slot>-size`, in that order, which is what the modules compute from.
- `compile` stays pure: it names the sound files (`CompileResult.samples`, the name in the folder and the path on this computer) and whoever writes the folder adds them. `src-tauri/src/samples.rs` decodes WAV, AIFF, FLAC, MP3 and Ogg Vorbis (the `symphonia` crate), mixes to one channel and writes a 16-bit WAV at the file's own rate, the one thing Pd 0.49's `soundfiler` reads without surprises (it takes a 32-bit WAV for float, refuses 8-bit and AIFC). Conversions are kept per path and modified time, since the preview reloads at every structural edit. `engine_load`, `export_patch` and `organelle_send` all convert first and fail with the file's name before touching anything.
- A sample module plays a sound at its own speed whatever rate Pd runs at, from the rate the helper sends. Positions on cables are 0–1 across the sample; that is a 32-bit signal, so beyond about 20 s a sample grows grainy at other speeds than its own (`long-sample` warning).
- **Sample Player**: a `phasor~` runs at one pass of the window (Start, Length) per cycle. A trigger takes note of the phase with `samphold~` (controlled by the gate upside down, since `samphold~` samples when its control falls), and the phase since then is the place in the window. The phase stepping back ends a pass; passes are counted (`rpole~ 1`) and the count at the trigger taken note of the same way. Middle C is the sample's own speed. `holdsVoice: "playing"` names the output that keeps the voice alive, so Once plays to the end after the key is up. Its Pitch input has both a pre-cord and `unpatched: 60`: `analyze` feeds one or the other.
- **Play Head** is `tabread4~` at Start + Position, wrapped.
- **Recorder** (global, `sample: "writes"`, one per sample or `two-recorders`). Pd 0.49 has nothing that writes at a place a signal gives, only `tabwrite~`, which writes from the start to the end and stops. So the tape always runs: a count of blocks (`bang~`) re-bangs `tabwrite~` every lap, laps are whole blocks (`floor(size / 64)`), and what is written is `in × recording + old × kept`, where `old` is `tabread~` at the same place (read before it is written, since it feeds the writer) and `kept` is 1 while not recording, an exact rewrite, and Overdub while recording. Recording is the Record knob times its input, as a gate, through `lop~ 200`: a punch-in is sample-accurate and faded, and nothing is ever started or stopped. The place is the block count × 64 plus a 64-sample `phasor~` ramp that is put back in step each lap, read at + 0.5 because `tabread~` cuts fractions off. Out is `old`, so the Recorder alone is a looper. Once: a rise of Record sets a flag that the next block tick turns into a new lap (acting on the rise directly could land either side of that tick and leave the count a block out), and only that lap records.
- **Tape Head** (global, `sample: "follows"`, `no-recorder` warning without a Recorder on its sample) plays what was written Delay ago. No cable joins it to the Recorder, so patching its output back into the Recorder is not a loop to `ops`, `analyze` or Pd: the tape is the delay. It learns where the recording is from `r~ ge-sample-<slot>-at`: the Recorder `throw~`s its place in samples, and the slot helper `catch~`es it and sends it on, so the receive always has a sender. That hop costs 0, 1 or 2 blocks, fixed for a patch, which adds to Delay. The delay in samples is split with `wrap~` into a whole number and a fraction, and two `tabread~` at whole indexes are blended: exact for any length of tape (a whole number survives a 32-bit signal, a position 0–1 does not), and with no seam where the tape goes round. Delay is kept between a block, behind which the recording is sure to have been written whatever order Pd sorts the two modules in, and the tape less four blocks.
- **Grains** (per voice, stereo) is four copies of the helper `ge-grain`, a quarter cycle apart on one `phasor~` at Density / 4, so a stream makes a grain every 4 / Density seconds and a grain lasts at most that long: four overlap. Each time a stream's phase starts again, `samphold~` (controlled by the phase itself, which falls there) holds what that grain is to be: its start (Position plus the stream's own `noise~` times half of Scatter, or that far back from `ge-sample-<slot>-at` when Position is counted from the recording), how far it reads in a cycle (the speed, as on the Sample Player), how much of the cycle it lasts, and where it is panned (other noise times Width, equal power). A change during a grain waits for the next, so a grain never jumps. The shape is a raised cosine from `cos~`; four full ones add up to 2, hence the 0.5 at the end. Overlapping grains from one fixed place add up or cancel as the pitch moves: that is the sound of it, and why the DSP test measures pitch on grains laid end to end.
- The `looper` and `tape-echo` fixtures are those two patches. `looper` is the one fixture that is meant to keep sounding with no key held, and `compiled_patches` checks that instead of silence.
- The Samples pane (`ui/samples/SamplesPane.tsx`, `state/sounds.ts`) is where samples are made and deleted. It is a side pane (below), opened from its tab. It lists the slots that hold something, a sound file by its waveform and a tape by a picture of reels with its length to set, and after them the next free slot with its two buttons, until all eight are in use. A sound's picture is read by the `sample_info` command and kept in `useSounds`, not in the patch. A sample module's Sample choice in the settings pane offers the samples the patch has, plus the one the module is on if that is empty.
- `tests/golden/sampler/ge-sample-a.wav` is committed by hand: the compiler test writes only the text files, and `compiled_patches` needs the sound beside them.

**Scope.** A Scope module draws the signal at its input on its tile. It is the one module whose point is the editor, and its two settings (Time, Range) say how the picture is drawn: they have receivers in `ge-scope` like any setting, which nothing there uses.

- The route out of Pd is extra output channels. `ge-scope` sends its input to `throw~ ge-scope-<n>`; `host.pd` catches the eight buses into `dac~` 3–10; the engine starts Pd with ten outputs (`PD_OUTPUTS` in `audio.rs`), plays the first two and writes the rest, before volume and fade, into `ScopeStore` (`engine/scope.rs`: atomics, written by the audio callback, read without a lock). The `engine_scope` command gives a window of one slot as a lowest and a highest value for each column of the picture, starting at the last rise through the middle of the signal when asked to trigger. `ScopeView` asks about thirty times a second and triggers up to 100 ms; a longer picture rolls.
- Nothing that reads a scope may take Pd's lock: the audio callback plays silence whenever it cannot get it. That rules out reading Pd arrays from a command.
- `def.tap` marks the module. `analyze` numbers the tapped modules from 1 in document order (`analysis.taps`; 0 beyond `SCOPE_SLOTS`, with the `too-many-scopes` warning), `addModules` passes the number and the voice as second and third creation arguments, and `compile` returns `scopes` (module id → number), which `preview.ts` keeps for the tiles from each load.
- Inside the voices a Scope shows one voice, the one that got the latest note: the voices added up would be a picture of none of them, and `poly` gives each note to the voice that has rested longest, so a fixed voice would show every Nth note. `main.pd` sends that voice's number to `ge-scope-voice` at each key down (only when a voice has a Scope), and `ge-scope` passes its input while the number is its own third argument, `$1` of the voice. Outside the voices the argument is -1 and the input always passes. Until the first note it is voice 0.
- An exported patch keeps its Scopes. No bus is caught on the Organelle, and a `throw~` without a `catch~` is silent and prints nothing.

**Rows layout.** `layout: "rows"` (every module with knobs) lists a module's inputs as rows, two to a grid cell under a half-cell header: the port on the left edge and, where the input has a `param`, that knob beside it. `height` must be `ceil((rows + 1) / 2)`; `registry.test.ts` checks it. `portOffset` in `ui/canvas/geometry.ts` places both the ports and the knobs. A tile one cell wide (Amp, Audio Out) shows the knobs without names. Voice Sum and Noise, with no knobs, keep the plain layout: ports down the edges.

When a module's tile changes shape, older documents can have tiles on top of each other. `ops.settle` pushes them apart, and `actions.openPatch` runs it on every opened patch.

**Modules that grow.** A def with `growsWithInputs` (the Mixer) pairs input *i* with param *i*. Its abstraction and registry def always have all eight, so the compiler and saved documents know nothing about growing. Only the editor does: `visibleDef(doc, module)` in `modules/shape.ts` returns the def cut down to the pairs in use plus one free pair, with the matching tile height, and everything about size or visible ports (`ops.ts` placement and moves, the canvas, the inspector) must use it instead of `getModuleDef`. `ops.connect` calls `makeRoom` when such a tile grows, pushing the modules below it down within the same edit. It uses the rows layout, so the height rule in `shape.ts` has to agree with `portOffset`.

`pd-lib/modules/*.pd` is bundled into the front end with `import.meta.glob(..., "?raw")` in `src/core/pdlib.ts`. `pd-lib/host.pd` is embedded in the Rust binary with `include_str!`.

### Compiler (`src/core/compiler`)

- `analyze.ts` resolves the document against the registry and produces diagnostics (stable `code`s), wires as outlet/inlet indices, normalled connections, pre-cords and knob bindings. Any `error` diagnostic makes `compile` return `ok: false` with no files; warnings still compile.
- **Scope**: modules are per-voice unless they are `global` (Audio Out, Voice Sum) or downstream of a global module, in which case they run once after the voices are summed. Voice-scope modules go into `voice.pd`, global ones into `main.pd`. A voice output feeding a global module becomes an `outlet~` of `voice.pd`, and `[clone voice N]` in `main.pd` sums it across voices. Audio In is global too: there is one input for all voices, so it and everything patched after it run once and are heard without a key held.
- **Voice life**: a voice that is not playing must not be heard, or an oscillator with no Amp behind it would sound for ever, and before its first note at pitch 0, which is 8 Hz (the `bare-oscillator` fixture catches that). `addVoiceLife` in `emit.ts` builds two signals that are 1 or 0, with a fade that is quick on the way up (so attacks keep their edge) and about 5 ms on the way down:
  - `playing`: the key gate is up, or a module with `holdsVoice` (the ADSR) still has its output above 0.001;
  - `heard`: playing, or a module with `tail` (the effects) is still ringing: the level of its first output, rectified and smoothed, is above 0.001.

  Each `outlet~` of `voice.pd` is multiplied by one of them. The modules with a tail and everything after them in the voice form the ringing part: audio entering it from the rest of the voice is multiplied by `playing`, so that an oscillator that never stops does not go on feeding an echo, and what leaves the voice from it is multiplied by `heard`, so that the echo rings out. Everything else that leaves is multiplied by `playing`. Modulation (anything that does not come, directly or through other modules, from a module with an audio output) enters the ringing part as it is. The `voice-effects` fixture exercises all of it.
- **Pre-cords**: an unpatched input with a `precord` is fed from `ge-voice`'s pitch/gate/velocity outlets, unless switched off per instance.
- `emit.ts` writes `main.pd` (`[r notes]` → `[poly]` → `[clone voice N]`, global modules, a loadbang message box that sends every parameter value) and `voice.pd`. Box positions mirror the editor grid so exports are readable in Pd.
- **Knob pages.** A patch always has eight (`MAX_PAGES`); there is nothing to add or remove. The document holds them up to the last one with a name or a knob in use (`ops.pageAt` reads one, blank where the document holds none; `renamePage` and `assignKnob` hold more as needed and let go of blank ones at the end, so two documents that say the same are the same). Only the pages with a knob in use are exported: `analysis.pages` is those, in order, and that order is the page number on the Organelle, in `ge-slot-<page>-<knob>`, in the `1/2` on its screen and for Aux. So the third page of the editor can be the second on the device. A page without a name goes by its number in the editor (`defaultPageName`, "Page 3"). `structureKey` covers the exported pages only.
- `knobPages.ts` adds the knob-page section: Aux steps pages, each assigned knob is a `ge-knob` (soft takeover) scaled to its param and echoed to `screenLine1`–`4`, with the page name on `screenLine5`. Screen lines are limited to 21 characters.
- `structure.ts`'s `structureKey(doc)` is the string that decides reload vs. live update. It must cover everything that changes the emitted patch *structure* and exclude param values, positions and the name.
- `src/core/pd/patch.ts` (`PdPatch`) is the only place that writes Pd file syntax; callers pass box text as it appears in Pd and it handles `$` / `,` / `;` escaping and connection indices.

### State (`src/state`, zustand)

- `store.ts`: the document, undo/redo history (with coalescing for continuous gestures such as knob drags), selection, file path.
- `preview.ts`: `startPreviewSync()` subscribes to the store. A structural change (different `structureKey`) recompiles and reloads the patch after a short debounce; a value-only change sends each changed param to its receiver and nudges the matching `ge-slot-<page>-<knob>` so the on-device knob state and screen follow. It also keeps what the patch sends back (screen lines, LED, Pd console) in the `usePreview` store; the components only draw it. Nothing draws the console lines (`log`) at present.
- `actions.ts`: opening and saving presets, Export and Send.
- `presets.ts`: the list of the presets the user has saved, read again when the Presets pane opens, after a save or a delete, and when the window comes back to the front.
- `organelle.ts`: the Organelle's network address (kept in `localStorage`) and how the current or last send went, which the Organelle pane shows.
- `ui.ts`: transient canvas state (view, cable drag, palette placement), the knob page on show and the Organelle knob being assigned.
- `assign.ts`: assigning Organelle knobs by clicking (below).

Hot reload does not survive an edit to these store modules: the UI switches to a new store instance while the sync started by `App` keeps feeding the old one, so the preview looks dead (blank screen, no reloads) until the window is reloaded or `tauri dev` restarted.

### UI (`src/ui`)

- Components change the document only through `useEditor.getState().apply((doc) => ops.something(doc, …), coalesceKey?)`. Continuous gestures pass a key (`param:<module>:<param>`, `patch-name`, `page-name:<index>`) so the whole gesture is one undo step.
- **Side panes** open at either side of the window, from the top bar down to the dock, from tabs at that end of the top bar (`ui/shell/SidePanes.tsx`); the module browser and the grid move over. `SIDE_PANES` lists them: an id (`SidePaneId` in `state/ui.ts`, with its side in `PANE_SIDE`), the tab's name, and the component that fills the pane. `useUi.sidePanes` has the open one of each side (the editor starts with Presets open); a click on its tab closes it, and `showSidePane` opens one from code. On the left, before the patch's name, is Presets (`shell/PresetsPane.tsx`, below). On the right are Samples, and Organelle (`shell/OrganellePane.tsx`), which holds Send over Wi-Fi with its address and outcome, and Export. `sendToOrganelle` opens the Organelle pane, so the ⇧⌘E shortcut shows what it is doing. A new pane is one more entry in the list. Besides the tabs the top bar has the patch's name, in the middle of the window, and, only when something keeps the preview from playing the patch, a status. There are no Undo and Redo buttons: `useShortcuts` in `App.tsx` handles ⌘Z and ⇧⌘Z.
- **Presets** are how patches are opened and saved: there are no file dialogs for them. They are the `.gridelle` files in the Gridelle folder of the user's Documents, and the pane lists exactly those, in one list. The editor keeps no presets anywhere else: the ones it comes with (`EXAMPLE_PRESETS` in `core/presets.ts`, which are New patch and a few of the fixtures that play no sound file) are written into that folder when the editor starts (`startPresets`), each of them once ever. A hidden file there, `.gridelle-examples`, has the names written so far, so one the user deletes stays deleted and one a later version adds is written then (`presets::seed`). A preset the user already has under such a name is not written over.
  - A click opens a preset. Save writes the patch as `<name>.gridelle`, where the name is the patch's own less what a file name cannot hold (`presetFileName`, the same rule as `is_preset_name` in `src-tauri/src/presets.rs`). It writes over the patch's own file without asking, and asks before replacing another preset of that name; a renamed patch is therefore saved as a new preset beside the old one, which is also how one is copied. Each row has a delete button.
  - "New patch" (`NEW_PATCH_NAME`) is a file like the others and the base of new patches: opening it, from the list or with ⌘N, gives a copy that is saved nowhere, so saving that under the same name asks before it replaces the base. That question is how a user makes a base of their own. Without the file, ⌘N gives the `newPatch` document.
  - Under the list are the patch's name as a field (the same `doc.name` as in the settings pane, one undo step per run of typing, Enter saves) and the Save button. ⌘S saves and ⌘O opens the pane.
- The window is the top bar, the module browser over the grid (with a side pane to their right when one is open), and the dock (`shell/Dock.tsx`): the virtual Organelle, the Knob pages panel and the settings pane (`inspector/Inspector.tsx`). The settings pane shows what a selected module does (`MODULE_DOCS` in `core/modules/docs.ts`, a short paragraph by module type; `docs.test.ts` fails for a module without one, and for a text that names a port or setting the module does not have) and what it has besides the knobs on its tile, which is its choices and its pre-cord switches, or the patch's name, voices and problems when no module is selected. A numeric setting is only on the tile.
- A click on an input that has a pre-cord, with no cable in it, switches the pre-cord over (`ops.togglePrecord`); a press that moves is a cable drag as on any port (`onPortPointerDown` in `GridCanvas`). The switch in the settings pane does the same.
- `canvas/geometry.ts` is the single source of tile and port positions. Tiles and ports are placed from it and cables are drawn to the same computed points, not measured from the DOM. Dropping a cable finds its target through the ports' `data-port-*` attributes (`portUnder`).
- `palette/Palette.tsx` is the module browser, a strip above the grid: the categories that have modules on the left, the chosen category's modules as a row of cards on the right. A card is pressed and dragged onto the grid (`useUi.placing`; `GridCanvas` draws the ghost and adds the module) or clicked to land near the centre. Each card's picture is a path in `palette/glyphs.ts`, keyed by module type; `glyphs.test.ts` fails for a module without one. The same picture is on the module's tile (`Glyph` in `ModuleTile.tsx`): left of the name, or on a tile one cell wide, which has no room there, in the middle of the tile below the name.
- While a module from the browser is held over a port, `GridCanvas` shows the `planPortDrop` plan: the ghost at the landing cell, the planned cables dashed (the cables they replace hidden), and the tiles a push would move already slid aside. Sliding a tile takes its port out from under the pointer, so the aimed-at port is held for as long as the pointer stays where the port was found.
- The Knob pages panel (`pages/KnobPages.tsx`) starts with one strip for going from page to page: previous, the page's name as a field (its number as the placeholder), a list of all eight pages (a native `select` under a caret button, which says which pages are empty), next. `useUi.knobPage` is the page on show, 0 to 7.
- A setting goes on an Organelle knob in two clicks: an unassigned knob in the Knob pages panel, which arms it (`useUi.assigning`, `state/assign.ts`), then a knob on a tile. `ParamKnob` takes that press in the capture phase, so the dial does not turn, and `assignToArmed` arms the page's next empty knob or ends the mode. Any other press ends it (`useAssignCancel` in `App.tsx`), as do Escape and the armed knob becoming taken or gone (an effect in `KnobPages`). While armed, cables ignore the pointer, since one may lie over a knob.
- Styling is plain CSS per component. Colour comes from `category-<Category>` and `hint-<SignalHint>` classes that set `--category` / `--hint` in `src/App.css`, so a new category or hint needs an entry there.
- A knob page has a colour by its position (`page-color-<index>` in `src/App.css`, setting `--page` and `--page-ink`): the badge on a tile knob, and in the Knob pages panel the edge of the page's name and the knob numbers. Clicking a badge shows its page in the panel. The eight colours are a colour-blind-safe set (Okabe-Ito) in a deliberate order; the comment there has the measured separations, and `pageColors.test.ts` checks contrast. Change a colour only with a simulation at hand: colour is backed up by the knob number, the tooltip and a ring on the badges of the page the panel shows (`useUi.knobPage`), because the sixth colour is close to the fourth for deuteranopes.

### Bridge and Rust back end

The UI reaches Pd only through the `PreviewEngine` interface in `src/bridge/engine.ts` (Tauri commands `engine_*` plus the `pd-event` event); in a plain browser it is replaced by a silent stub. File dialogs and disk access are in `src/bridge/files.ts`. The Tauri commands are in `src-tauri/src/lib.rs`. The capability file grants only `core`, `opener` and `dialog`: reading, saving and exporting go through the custom commands there (`read_text_file`, the `presets_*` and `preset_*` commands, `export_patch`), not a Tauri fs plugin. The preset commands work only in the presets folder (`presets.rs`: one plain file name, written through a temporary file, deleted only if it is a preset directly inside that folder); nothing writes a file at a path the front end chooses.

- `build.rs` compiles libpd's C sources straight from the `vendor/libpd` submodule with `cc`: single precision, and of the `extra` externals only those a module wraps (`EXTRA_SOURCES`, so far `bob~`), so that nothing else can work in the preview by accident.
- `engine/pd.rs` is the safe wrapper. libpd is global state, so there is one `Pd` behind a mutex and every libpd call holds it. `Pd::init()` returns the event receiver only on its first call in a process, which is why each file in `src-tauri/tests` has a single `#[test]`.
- `engine/audio.rs` runs Pd inside the cpal callback (`try_lock`, never blocking), with ten output channels of which the device gets two (see Scope), applies queued messages from a lock-free ring buffer at the start of each callback, and swaps patches by fading out, taking the lock, closing the old patch and opening the new one from a per-revision temp directory.
- The audio input is opened only while the loaded patch has `ge-audio-in.pd` among its files (so the microphone is not live otherwise), at the output's sample rate. Its callback writes into a ring buffer that the output callback reads a Pd block at a time, behind a cushion of about 23 ms because the two callbacks do not run in step; `host.pd` passes Pd's `adc~` on as `inL` / `inR`. When it cannot be opened, `Engine::load` returns the reason and the patch plays with silence there. `Pd::process` has silence at the input; `process_with_input` is what the callback and the tests use. The bundled app needs `NSMicrophoneUsageDescription` (`src-tauri/Info.plist`).

### The Organelle contract

Exported patches must run on the device's stock Pd (0.49 on OS 3.x and 4.x: its core objects and what its own `extra` folder holds, no other externals) under the Organelle's own host patch:

- Input from the host: `notes` (pitch velocity), `knob1`–`knob4` (0–1), `aux`, and its audio input as the signals `inL` / `inR` (read with `r~`; seen in the `mother.pd` of a device with OS 3.2).
- Output to the host: `throw~ outL` / `throw~ outR`, `screenLine1`–`screenLine5`, `led`.
- Exports never contain `dac~` or `adc~`. In the preview and in the Rust tests `pd-lib/host.pd` stands in for the host (catch → clip → `dac~`, plus the Scope buses on outputs 3–10), and `src/ui/organelle/VirtualOrganelle.tsx` sends and displays exactly the messages above.
- `pd-lib/spike` is a hand-written patch for checking a real device, not compiler output.

### Sending over Wi-Fi (`src-tauri/src/organelle.rs`)

"Send to Organelle" runs the same compile as Export and hands the files to the `organelle_send` command, which talks to the web file manager the Organelle runs while it is on Wi-Fi. There is no documentation for that server; the facts below come from the Organelle_OS source (tags v3.2, v4.4, v5.1) and from a device running OS 3.2.

| | OS 3.x–4.x ("classic") | OS 5 |
|---|---|---|
| Server | CherryPy, port 80, under `/files` | Flask, port 8080, no prefix |
| List / make folder / delete | `GET /files/fmdata?operation=get_node\|create_node\|delete_node` | same; the JSON answer is encoded twice |
| Upload | `POST /files/upload`, multipart `dst` + `files[]` | `POST /upload` |
| Read back | `GET /files/download?fpath=&cb=` (both required) | `GET /download?fpath=` |
| Refresh the patch menu | `GET /files/resync` | automatic after an upload |
| Start a patch | OSC `/loadPatch <folder name>` to UDP 4001 | `POST /reload_patch`, form `path=<folder>` |

- Uploading or creating never overwrites: a taken name becomes `main 2.pd`. A file is therefore deleted before it is uploaded.
- Every operation answers `{"ok":"ok"}` even when it failed, so each file is downloaded and compared after sending.
- The device plays from `/usbdrive/Patches` when that exists, otherwise `/sdcard/Patches`. It records the running patch as a folder name under `/tmp/curpatchname`, which is how a classic start is confirmed.
- A folder counts as Gridelle's own, and is replaced without asking, when it contains `ge-voice.pd`.
- A patch's sound files (`ge-sample-<letter>.wav`) are uploaded before its patch files, and one the device already has, byte for byte, is not sent again.
- After a send, the `ge-*.pd` and `ge-sample-*.wav` files in the folder that the patch no longer has are deleted (modules and samples removed since the last send). Nothing else in the folder is touched: it may hold the user's own files.

`src-tauri/tests/organelle_send.rs` holds a fake device that reproduces both servers and these quirks. The OS 5 path has only ever run against that fake.
