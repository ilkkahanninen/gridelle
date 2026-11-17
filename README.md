# Gridelle

A desktop editor for building modular synths on a grid and exporting them as
Pure Data patches for the Critter & Guitari Organelle M.

## Develop

Prerequisites: Node 22+, Rust (stable), a C compiler.

```sh
git submodule update --init --recursive   # vendored libpd
npm install
npm run tauri dev
```

## Test

```sh
npm test          # compiler, Pd file builder, module registry
npm run test:pd   # loads the compiled fixtures into real Pd (libpd), headless
```

`npm test` writes the compiled example patches to `tests/golden/`; each folder there
is a complete Organelle patch. `npm run test:pd` plays them in Pd and checks the result.

The engine test against a real audio device is opt-in (it plays at -40 dB):

```sh
cd src-tauri && cargo test --test engine_audio -- --ignored
```

## Layout

| Path | What |
|---|---|
| `src/core` | Document model, module registry, compiler, Pd file builder. Pure TypeScript. |
| `src/ui` | React UI. |
| `src/bridge` | The preview engine interface the UI talks to. |
| `src-tauri` | Rust backend: libpd wrapper, audio output, Tauri commands. |
| `pd-lib/modules` | Hand-written Pd abstractions, one per module, vanilla Pd 0.49 only. |
| `pd-lib/host.pd` | Preview stand-in for the Organelle's host patch. Never exported. |
| `pd-lib/spike` | Hand-written test patch for checking a device (copy it to `Patches/`). |

## Organelle target

Exports target Pd 0.49 vanilla so they run on Organelle OS 4.x and 5.x. Patches send
audio to `throw~ outL` / `throw~ outR` and never contain `dac~`.
