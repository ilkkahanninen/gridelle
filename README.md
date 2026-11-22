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
npm run test:pd   # real Pd (libpd), headless: plays the compiled fixtures, measures each module's DSP
```

`npm test` writes the compiled example patches to `tests/golden/`; each folder there
is a complete Organelle patch. `npm run test:pd` plays them in Pd and checks the result.

The engine test against a real audio device is opt-in (it plays at -40 dB):

```sh
cd src-tauri && cargo test --test engine_audio -- --ignored
```

## Send over Wi-Fi

With the Organelle on the same network and its web server running, **Send to Organelle**
(⇧⌘E) puts the patch in the device's `Patches` folder and starts it. Enter the Organelle's
IP address or host name the first time; it is remembered.

A patch folder Gridelle made earlier is replaced without asking; a same-named folder that
it did not make asks first. Module files that the patch no longer uses are removed from the
folder; any other files in it are left alone. Works with the web servers of Organelle OS 3.x–4.x (tried on a
device running 3.2) and OS 5 (written from its source, not yet tried on a device).

To try the sending code against a device from the command line (it creates and starts a
patch named `Gridelle_Test`):

```sh
cd src-tauri && ORGANELLE_ADDRESS=<address> cargo test --test organelle_send -- --ignored --nocapture
```

## Layout

| Path | What |
|---|---|
| `src/core` | Document model, module registry, compiler, Pd file builder. Pure TypeScript. |
| `src/ui` | React UI. |
| `src/bridge` | The preview engine interface the UI talks to. |
| `src-tauri` | Rust backend: libpd wrapper, audio output, sending to the Organelle, Tauri commands. |
| `pd-lib/modules` | Pd abstractions: one per module, plus helpers they share. Pd 0.49 only: its core objects, and `bob~` and the `rev` reverbs from its `extra` folder. |
| `pd-lib/host.pd` | Preview stand-in for the Organelle's host patch. Never exported. |
| `pd-lib/spike` | Hand-written test patch for checking a device (copy it to `Patches/`). |

## Organelle target

Exports target Pd 0.49 so they run on Organelle OS 3.x, 4.x and 5.x. A few modules (Ladder,
Cavern, Room, Hall) use objects from Pd's own `extra` folder, which the Organelle's Pd
includes. Patches send audio to `throw~ outL` / `throw~ outR` and never contain `dac~`. The Audio In
module reads the Organelle's input from `inL` / `inR`; in the editor it plays the computer's
audio input instead (macOS asks for microphone access the first time). The Scope module draws
the signal patched into it in the editor, up to eight at a time; on the Organelle it does nothing.
