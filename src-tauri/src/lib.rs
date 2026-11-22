pub mod engine;
pub mod samples;
pub mod organelle;

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use engine::audio::Engine;
use engine::pd::{Atom, PdEvent};
use samples::{SampleFile, SampleInfo};

/// Event name for everything the running patch prints or sends to the host.
const PD_EVENT: &str = "pd-event";

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum PdEventPayload {
    Print { text: String },
    Message { recv: String, atoms: Vec<Atom> },
}

/// The engine, or the reason it could not start (for example no audio device).
struct EngineState(Result<Engine, String>);

impl EngineState {
    fn get(&self) -> Result<&Engine, String> {
        self.0.as_ref().map_err(Clone::clone)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    running: bool,
    error: Option<String>,
    sample_rate: Option<u32>,
}

#[tauri::command]
fn engine_status(state: State<EngineState>) -> EngineStatus {
    match &state.0 {
        Ok(engine) => {
            EngineStatus { running: true, error: None, sample_rate: Some(engine.sample_rate()) }
        }
        Err(e) => EngineStatus { running: false, error: Some(e.clone()), sample_rate: None },
    }
}

/// Load a patch into the preview. The answer is `null`, or why a patch that uses the audio
/// input has to do without it.
#[tauri::command(async)]
fn engine_load(
    state: State<EngineState>,
    files: HashMap<String, String>,
    entry: String,
    samples: Vec<SampleFile>,
) -> Result<Option<String>, String> {
    state.get()?.load(&files, &entry, &samples)
}

/// What the editor shows of a sound file: its name, length, rate and a picture of it.
#[tauri::command(async)]
fn sample_info(path: String) -> Result<SampleInfo, String> {
    crate::samples::info(&path)
}

#[tauri::command]
fn engine_send(state: State<EngineState>, recv: String, atoms: Vec<Atom>) -> Result<(), String> {
    state.get()?.send(&recv, atoms)
}

#[tauri::command]
fn engine_set_volume(state: State<EngineState>, volume: f32) -> Result<(), String> {
    state.get()?.set_volume(volume);
    Ok(())
}

/// What the Scope module on `slot` shows: see `Engine::scope`.
#[tauri::command]
fn engine_scope(state: State<EngineState>, slot: usize, length: usize, columns: usize, trigger: bool) -> Result<Vec<f32>, String> {
    Ok(state.get()?.scope(slot, length, columns.min(4096), trigger))
}

#[tauri::command]
fn engine_peak(state: State<EngineState>) -> Result<f32, String> {
    Ok(state.get()?.peak())
}

#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// A single path component made only of characters that are safe in a patch folder.
fn is_plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~'))
}

/// Write an Organelle patch folder `folder` inside `parent`, with the patch's sound files
/// `samples`, and return its path. Fails with "exists" if the folder is already there,
/// unless `overwrite` is set; overwriting replaces same-named files and leaves anything
/// else in the folder alone.
#[tauri::command(async)]
fn export_patch(
    parent: String,
    folder: String,
    files: HashMap<String, String>,
    samples: Vec<SampleFile>,
    overwrite: bool,
) -> Result<String, String> {
    if !is_plain_name(&folder) || files.keys().any(|name| !is_plain_name(name)) {
        return Err("invalid patch or file name".into());
    }
    let dir = std::path::Path::new(&parent).join(&folder);
    if dir.exists() && !overwrite {
        return Err("exists".into());
    }
    // Read the sound files first: a patch folder without its sounds is no use.
    let sounds = crate::samples::convert_all(&samples)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for (name, sound) in &sounds {
        std::fs::write(dir.join(name), &sound.wav).map_err(|e| e.to_string())?;
    }
    for (name, text) in &files {
        std::fs::write(dir.join(name), text).map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Send a patch folder to an Organelle on the network and start it there.
/// Fails with "exists" under the same rule as [`organelle::send_patch`].
#[tauri::command(async)]
fn organelle_send(
    address: String,
    folder: String,
    files: HashMap<String, String>,
    samples: Vec<SampleFile>,
    replace: bool,
) -> Result<organelle::SendReport, String> {
    if !is_plain_name(&folder) || files.keys().any(|name| !is_plain_name(name)) {
        return Err("invalid patch or file name".into());
    }
    organelle::send_patch(&address, &folder, &files, &samples, replace)
}

fn start_engine(app: &AppHandle) -> EngineState {
    let handle = app.clone();
    EngineState(Engine::start(move |event| {
        let payload = match event {
            PdEvent::Print(text) => PdEventPayload::Print { text },
            PdEvent::Message { recv, atoms } => PdEventPayload::Message { recv, atoms },
        };
        let _ = handle.emit(PD_EVENT, payload);
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = start_engine(app.handle());
            if let Err(e) = &state.0 {
                eprintln!("preview engine did not start: {e}");
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_status,
            engine_load,
            engine_send,
            engine_set_volume,
            engine_peak,
            engine_scope,
            sample_info,
            read_text_file,
            write_text_file,
            export_patch,
            organelle_send
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                engine::audio::remove_preview_files();
            }
        });
}
