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
npm run test:pd        # cargo test in src-tauri: loads tests/golden into real Pd (libpd), headless
```

Single tests:

```sh
npx vitest run src/core/compiler/compiler.test.ts -t "is deterministic"
cd src-tauri && cargo test --test compiled_patches
cd src-tauri && cargo test --test engine_audio -- --ignored   # opt-in: plays through the real audio device at -40 dB
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

A new document field touches `types.ts`, the hand-written shape check in `serialize.ts` (plus `DOCUMENT_VERSION` if older builds cannot read the result), and `structureKey` if it changes the emitted patch.

Module ids are `ge<n>` and must match `/^ge[0-9a-z]+$/`. The id is also the module's Pd creation argument and the prefix of its parameter receivers (`ge3-cutoff`); the `ge` prefix keeps them clear of the names the Organelle host uses (`knob1`, `notes`, `aux`, `vol`, …). Generated plumbing uses names with a hyphen straight after `ge` (`ge-page`, `ge-slot-<page>-<knob>` with a 0-based page and 1-based knob, the `ge-*` abstractions), which no module id can produce.

### Modules: a registry entry plus a hand-written Pd abstraction

A module is two things that must agree:

- a `ModuleDef` in `src/core/modules/registry.ts` (ports, params, tile size, scope);
- `pd-lib/modules/<def.pd>.pd`, a flat abstraction whose `inlet~`/`outlet~` objects match the def's inputs/outputs left to right, and which has one `[r $1-<paramId>]` per param. No control inlets or outlets.

`registry.test.ts` enforces the match by parsing the `.pd` text (`src/core/pd/inspect.ts`, flat patches only, no subpatches). It also checks that every object class used is in the allowlist in `src/core/pd/vanilla049.ts`. The preview embeds a newer Pd than the device has, so an object missing from that list could work in the editor and fail on the Organelle; extend the list only after checking it exists in Pd 0.49 vanilla.

Params are stored and sent in real units (Hz, ms, semitones). `params.ts` maps a 0–1 control position to a value (`lin`/`exp`); `knobPages.ts` emits the same mapping as Pd objects, so the two must stay equivalent.

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
- `actions.ts`: New / Open / Save / Export flows.
- `ui.ts`: transient canvas state (view, cable drag, palette placement).

Hot reload does not survive an edit to these store modules: the UI switches to a new store instance while the sync started by `App` keeps feeding the old one, so the preview looks dead (blank screen, no reloads) until the window is reloaded or `tauri dev` restarted.

### UI (`src/ui`)

- Components change the document only through `useEditor.getState().apply((doc) => ops.something(doc, …), coalesceKey?)`. Continuous gestures pass a key (`param:<module>:<param>`, `patch-name`, `page-name:<index>`) so the whole gesture is one undo step.
- `canvas/geometry.ts` is the single source of tile and port positions. Tiles and ports are placed from it and cables are drawn to the same computed points, not measured from the DOM. Dropping a cable finds its target through the ports' `data-port-*` attributes (`portUnder`).
- Styling is plain CSS per component. Colour comes from `category-<Category>` and `hint-<SignalHint>` classes that set `--category` / `--hint` in `src/App.css`, so a new category or hint needs an entry there.

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
