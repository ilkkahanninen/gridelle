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
cd src-tauri && cargo test --test engine_audio -- --ignored   # opt-in: plays through the real audio device at -40 dB
cd src-tauri && ORGANELLE_ADDRESS=<ip> cargo test --test organelle_send -- --ignored --nocapture   # opt-in: writes the patch Gridelle_Test to a real Organelle and starts it
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

`PatchDocument` holds modules placed on a grid, cables (output port → input port; every cable is an audio-rate signal and an input takes one cable), and knob pages (4 knobs per page, up to 8 pages). All edits go through the functions in `ops.ts`, which never mutate and return the *same object* when nothing changed. The editor store relies on that identity: `apply()` skips the undo step when `next === doc`, and unsaved-changes detection is `doc !== savedDoc`.

`ops.ts` keeps a document valid while it is edited (one cable per input, no feedback loops, no overlapping tiles). `analyze.ts` checks the cable and loop rules again and reports them as diagnostics, because `parseDocument` accepts any well-shaped file, including ones with unknown module types.

A module dragged from the browser onto a port of another module is cabled in by `ops.addModuleAtPort`. `planPortDrop` decides what that means and is also what the canvas previews, so the two cannot disagree. The new module uses its first input and first output. On a free port it lands beside the port, or as near as there is room. On a cabled port it goes in between (dropped on an output, in front of everything that output feeds); when the spot beside the port is taken it takes that place in the row and `makeRoom(…, "right")` moves the tiles there along. A module with no input or no output to go in between with is cabled to the port alone.

`ops.removeModules` is the reverse: a module taken out of a chain leaves the chain patched. What fed its first input now feeds whatever its first output fed, looking through a run of removed modules; cables on its other ports go with it. Tiles are not moved back.

A new document field touches `types.ts`, the hand-written shape check in `serialize.ts` (plus `DOCUMENT_VERSION` if older builds cannot read the result), and `structureKey` if it changes the emitted patch.

Module ids are `ge<n>` and must match `/^ge[0-9a-z]+$/`. The id is also the module's Pd creation argument and the prefix of its parameter receivers (`ge3-cutoff`); the `ge` prefix keeps them clear of the names the Organelle host uses (`knob1`, `notes`, `aux`, `vol`, …). Generated plumbing uses names with a hyphen straight after `ge` (`ge-page`, `ge-slot-<page>-<knob>` with a 0-based page and 1-based knob, the `ge-*` abstractions), which no module id can produce.

### Modules: a registry entry plus a hand-written Pd abstraction

A module is two things that must agree:

- a `ModuleDef` in `src/core/modules/registry.ts` (ports, params, tile size, scope);
- `pd-lib/modules/<def.pd>.pd`, a flat abstraction whose `inlet~`/`outlet~` objects match the def's inputs/outputs left to right, and which has one `[r $1-<paramId>]` per param. No control inlets or outlets.

`registry.test.ts` enforces the match by parsing the `.pd` text (`src/core/pd/inspect.ts`, flat patches only, no subpatches). It also checks that every object class used is in the allowlist in `src/core/pd/vanilla049.ts`. The preview embeds a newer Pd than the device has, so an object missing from that list could work in the editor and fail on the Organelle; extend the list only after checking it exists in Pd 0.49 vanilla.

Params are stored and sent in real units (Hz, ms, semitones). `params.ts` maps a 0–1 control position to a value (`lin`/`exp`); `knobPages.ts` emits the same mapping as Pd objects, so the two must stay equivalent.

A param with `options` is a choice (an oscillator's Mod mode). Its value is the option's index, so it is stored, clamped and sent like any other number, and changing it is a live update, not a reload. The inspector draws it as a list; it gets no knob on the tile, and so cannot be put on an Organelle knob, whose screen line would show the bare index.

**Helper abstractions.** `pd-lib/modules` also holds abstractions that are not modules (`ge-voice`, `ge-knob`, `ge-blep`, `ge-osc-mod`, `ge-filter-poles`, `ge-drive`). `compile()` ships a module's file together with everything it is built from, transitively (`withHelpers` in `compiler/index.ts`): any object class in an abstraction that is not on the Pd 0.49 allowlist is taken to be another abstraction, and is a `missing-abstraction` error if the library lacks it. Parameter receivers (`[r $1-<id>]`) must stay in the module's own file, because that is where the registry test looks for them.

**Measured, not assumed.** `src-tauri/tests/module_dsp.rs` loads each abstraction in real Pd and checks what it does: oscillator pitch, level, DC and aliasing, and each Mod mode (including the side bands of linear FM); each filter's gain at several frequencies against the response it is designed to have; each shaper's output against its curve, sample by sample; the mixer's sum; the envelope's stages with each input at several values. Change the DSP of a module and this is the test to extend. (It found that the first Low-pass, built on `vcf~`, went silent when opened fully.)

**Oscillator modulation.** Every oscillator ends its pitch chain (note + Tune + Fine) in `ge-osc-mod`, which takes the Mod input, Depth and Mod mode and returns the frequency in Hz and an output gain. Only the selected mode's amount is non-zero, each behind a 20 ms ramp: linear FM is `frequency * (1 + mod * 8 * depth²)`, exponential FM adds `mod * 48 * depth²` semitones before `mtof~`, AM is a gain of `1 + mod * depth`. The mode numbers in the registry's option list must match the `[== n]` objects there. Linear FM can take the frequency below zero, where `phasor~` and `osc~` run backwards; `ge-blep` therefore takes the absolute frequency.

**Filters** are the standard "cookbook" (RBJ) biquads, built so the cutoff can move at audio rate: `ge-filter-poles` makes the pole pair from two `cpole~` with signal-rate coefficients and outputs the gain each filter type needs; the module adds its zeros with `rzero~` (Notch is the input minus the band-pass). Coefficients come from the sine and cosine of *half* the angle, because Pd's cosine table is too coarse to take `1 - cos w` from near zero. `Res` maps to Q 0.7–15, and Low-pass and High-pass are turned down by `sqrt(0.7/Q)`.

**Shapers** have an In and a Mod input. Soft Clip, Hard Clip and Wavefolder share `ge-drive`: Drive in dB before the shaping, plus Mod dB per unit of the mod signal.

- Soft Clip is `tanh` written with `exp~`, with a Bias that shifts the signal first.
- Wavefolder reads a triangle with the signal (`wrap~`, `abs~`) or, with Shape set to Sine, a sine (`cos~`); Symmetry is its shift.
- Rectifier multiplies the negative half by `1 - 2 * amount` (0 clean, 0.5 half-wave, 1 full-wave).
- Bitcrusher holds samples with `samphold~` clocked by a `phasor~` at Rate, then rounds to `2^(bits - 1)` steps per side (`x + 0.5` minus its `wrap~`).
- Chebyshev builds T1–T8 with the recurrence `T(n+1) = 2x T(n) - T(n-1)` on an input clipped to ±1; Order (moved by Mod) fades between neighbouring polynomials.

A shaper must give exactly 0 for silence, or every idle voice puts DC or a thump on the output. So whatever a shift (Bias, Symmetry) alone would produce is subtracted after the curve, and the even polynomials are moved to be 0 at 0. The `hip~ 5` that ends the lopsided ones only removes the DC that appears while a signal is present; the DSP test runs the same filter over its expected curve. None of the shapers is oversampled, so hard driving aliases.

A bare `;` in a Pd comment ends the box, and Pd then tries to deliver the rest as a message on load ("no such object"). `registry.test.ts` checks every abstraction for it.

**Setting inputs (the Eurorack direction).** A setting can have an input of its own: `PortDef.param` ties an input to a parameter, and the module multiplies the two, so the knob scales what is patched in. `PortDef.unpatched` is the signal such an input holds with no cable (1, so that the knob alone gives the value and older patches sound the same). A Pd abstraction cannot tell whether an `inlet~` is connected, so the compiler supplies it: `analyze` lists the unpatched inputs as `constants`, and `emit` adds one `[sig~ <value>]` per value to `voice.pd` or `main.pd` and connects it. The ADSR is the first module built this way; the others still have their separate Mod/CV inputs and amount knobs.

The ADSR reads its inputs when a stage starts: `snapshot~` takes A, D and S at gate on and R at gate off, times the knob values, into the one `vline~` it always had (which is what keeps a retrigger from clicking). A change during a stage waits for the next one, and a negative product counts as 0.

**Rows layout.** `layout: "rows"` (ADSR, Mixer) lists a module's inputs as rows, two to a grid cell under a half-cell header: the port on the left edge and, where the input has a `param`, that knob beside it. `height` must be `ceil((rows + 1) / 2)`; `registry.test.ts` checks it. `portOffset` in `ui/canvas/geometry.ts` places both the ports and the knobs.

When a module's tile changes shape, older documents can have tiles on top of each other. `ops.settle` pushes them apart, and `actions.openPatch` runs it on every opened patch.

**Modules that grow.** A def with `growsWithInputs` (the Mixer) pairs input *i* with param *i*. Its abstraction and registry def always have all eight, so the compiler and saved documents know nothing about growing. Only the editor does: `visibleDef(doc, module)` in `modules/shape.ts` returns the def cut down to the pairs in use plus one free pair, with the matching tile height, and everything about size or visible ports (`ops.ts` placement and moves, the canvas, the inspector) must use it instead of `getModuleDef`. `ops.connect` calls `makeRoom` when such a tile grows, pushing the modules below it down within the same edit. It uses the rows layout, so the height rule in `shape.ts` has to agree with `portOffset`.

`pd-lib/modules/*.pd` is bundled into the front end with `import.meta.glob(..., "?raw")` in `src/core/pdlib.ts`. `pd-lib/host.pd` is embedded in the Rust binary with `include_str!`.

### Compiler (`src/core/compiler`)

- `analyze.ts` resolves the document against the registry and produces diagnostics (stable `code`s), wires as outlet/inlet indices, normalled connections, pre-cords and knob bindings. Any `error` diagnostic makes `compile` return `ok: false` with no files; warnings still compile.
- **Scope**: modules are per-voice unless they are `global` (Audio Out, Voice Sum) or downstream of a global module, in which case they run once after the voices are summed. Voice-scope modules go into `voice.pd`, global ones into `main.pd`. A voice output feeding a global module becomes an `outlet~` of `voice.pd`, and `[clone voice N]` in `main.pd` sums it across voices.
- **Pre-cords**: an unpatched input with a `precord` is fed from `ge-voice`'s pitch/gate/velocity outlets, unless switched off per instance.
- `emit.ts` writes `main.pd` (`[r notes]` → `[poly]` → `[clone voice N]`, global modules, a loadbang message box that sends every parameter value) and `voice.pd`. Box positions mirror the editor grid so exports are readable in Pd.
- `knobPages.ts` adds the knob-page section: Aux steps pages, each assigned knob is a `ge-knob` (soft takeover) scaled to its param and echoed to `screenLine1`–`4`, with the page name on `screenLine5`. Screen lines are limited to 21 characters.
- `structure.ts`'s `structureKey(doc)` is the string that decides reload vs. live update. It must cover everything that changes the emitted patch *structure* and exclude param values, positions and the name.
- `src/core/pd/patch.ts` (`PdPatch`) is the only place that writes Pd file syntax; callers pass box text as it appears in Pd and it handles `$` / `,` / `;` escaping and connection indices.

### State (`src/state`, zustand)

- `store.ts`: the document, undo/redo history (with coalescing for continuous gestures such as knob drags), selection, file path.
- `preview.ts`: `startPreviewSync()` subscribes to the store. A structural change (different `structureKey`) recompiles and reloads the patch after a short debounce; a value-only change sends each changed param to its receiver and nudges the matching `ge-slot-<page>-<knob>` so the on-device knob state and screen follow. It also keeps what the patch sends back (screen lines, LED, Pd console) in the `usePreview` store; the components only draw it.
- `actions.ts`: New / Open / Save / Export / Send flows.
- `organelle.ts`: the Organelle's network address (kept in `localStorage`) and the state of the Send panel.
- `ui.ts`: transient canvas state (view, cable drag, palette placement), the knob page on show and the Organelle knob being assigned.
- `assign.ts`: assigning Organelle knobs by clicking (below).

Hot reload does not survive an edit to these store modules: the UI switches to a new store instance while the sync started by `App` keeps feeding the old one, so the preview looks dead (blank screen, no reloads) until the window is reloaded or `tauri dev` restarted.

### UI (`src/ui`)

- Components change the document only through `useEditor.getState().apply((doc) => ops.something(doc, …), coalesceKey?)`. Continuous gestures pass a key (`param:<module>:<param>`, `patch-name`, `page-name:<index>`) so the whole gesture is one undo step.
- `canvas/geometry.ts` is the single source of tile and port positions. Tiles and ports are placed from it and cables are drawn to the same computed points, not measured from the DOM. Dropping a cable finds its target through the ports' `data-port-*` attributes (`portUnder`).
- `palette/Palette.tsx` is the module browser, a strip above the grid: the categories that have modules on the left, the chosen category's modules as a row of cards on the right. A card is pressed and dragged onto the grid (`useUi.placing`; `GridCanvas` draws the ghost and adds the module) or clicked to land near the centre. Each card's picture is a path in `palette/glyphs.ts`, keyed by module type; `glyphs.test.ts` fails for a module without one.
- While a module from the browser is held over a port, `GridCanvas` shows the `planPortDrop` plan: the ghost at the landing cell, the planned cables dashed (the cables they replace hidden), and the tiles a push would move already slid aside. Sliding a tile takes its port out from under the pointer, so the aimed-at port is held for as long as the pointer stays where the port was found.
- A setting goes on an Organelle knob in two clicks: an unassigned knob in the Knob pages panel, which arms it (`useUi.assigning`, `state/assign.ts`), then a knob on a tile. `ParamKnob` takes that press in the capture phase, so the dial does not turn, and `assignToArmed` arms the page's next empty knob or ends the mode. Any other press ends it (`useAssignCancel` in `App.tsx`), as do Escape and the armed knob becoming taken or gone (an effect in `KnobPages`). While armed, cables ignore the pointer, since one may lie over a knob.
- Styling is plain CSS per component. Colour comes from `category-<Category>` and `hint-<SignalHint>` classes that set `--category` / `--hint` in `src/App.css`, so a new category or hint needs an entry there.
- A knob page has a colour by its position (`page-color-<index>` in `src/App.css`, setting `--page` and `--page-ink`): the badge on a tile knob, the page's tab and the knob numbers in the Knob pages panel. Clicking a badge shows its page in the panel. The eight colours are a colour-blind-safe set (Okabe-Ito) in a deliberate order; the comment there has the measured separations, and `pageColors.test.ts` checks contrast. Change a colour only with a simulation at hand: colour is backed up by the knob number, the tooltip and a ring on the badges of the page the panel shows (`useUi.knobPage`), because the sixth colour is close to the fourth for deuteranopes.

### Bridge and Rust back end

The UI reaches Pd only through the `PreviewEngine` interface in `src/bridge/engine.ts` (Tauri commands `engine_*` plus the `pd-event` event); in a plain browser it is replaced by a silent stub. File dialogs and disk access are in `src/bridge/files.ts`. The Tauri commands are in `src-tauri/src/lib.rs`. The capability file grants only `core`, `opener` and `dialog`: reading, saving and exporting go through the custom commands there (`read_text_file`, `write_text_file`, `export_patch`), not a Tauri fs plugin.

- `build.rs` compiles libpd's C sources straight from the `vendor/libpd` submodule with `cc`: single precision, and without the `extra` externals (`bob~`, `sigmund~`, …) on purpose, since they may be missing on the device.
- `engine/pd.rs` is the safe wrapper. libpd is global state, so there is one `Pd` behind a mutex and every libpd call holds it. `Pd::init()` returns the event receiver only on its first call in a process, which is why each file in `src-tauri/tests` has a single `#[test]`.
- `engine/audio.rs` runs Pd inside the cpal callback (`try_lock`, never blocking), applies queued messages from a lock-free ring buffer at the start of each callback, and swaps patches by fading out, taking the lock, closing the old patch and opening the new one from a per-revision temp directory.

### The Organelle contract

Exported patches must run on the device's stock Pd (0.49 vanilla on OS 4.x, no externals) under the Organelle's own host patch:

- Input from the host: `notes` (pitch velocity), `knob1`–`knob4` (0–1), `aux`.
- Output to the host: `throw~ outL` / `throw~ outR`, `screenLine1`–`screenLine5`, `led`.
- Exports never contain `dac~`. In the preview and in the Rust tests `pd-lib/host.pd` stands in for the host (catch → clip → `dac~`), and `src/ui/organelle/VirtualOrganelle.tsx` sends and displays exactly the messages above.
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

`src-tauri/tests/organelle_send.rs` holds a fake device that reproduces both servers and these quirks. The OS 5 path has only ever run against that fake.
