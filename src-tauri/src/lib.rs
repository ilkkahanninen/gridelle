pub mod engine;
pub mod banks;
pub mod samples;
pub mod wavetable;
pub mod organelle;
pub mod presets;

use std::collections::HashMap;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use engine::audio::Engine;
use engine::pd::{Atom, PdEvent};
use samples::{SampleFile, SampleInfo, Source, WavetableInfo};

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

/// What the editor shows of a wavetable: how many cycles it has, and a picture of some.
#[tauri::command(async)]
fn wavetable_info(source: Source) -> Result<WavetableInfo, String> {
    crate::samples::wavetable_info(&source)
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
fn engine_levels(state: State<EngineState>) -> Result<[f32; 4], String> {
    Ok(state.get()?.levels())
}

#[tauri::command(async)]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Where the user's presets are kept: a Gridelle folder in their Documents.
fn presets_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let documents = app.path().document_dir().map_err(|e| format!("The Documents folder could not be found ({e})."))?;
    Ok(documents.join("Gridelle"))
}

/// The saved presets, and the directory they are in.
#[tauri::command(async)]
fn presets_list(app: AppHandle) -> Result<presets::Presets, String> {
    presets::list(&presets_dir(&app)?)
}

/// Save a preset under `name` and answer its path. Fails with "exists" when there is one
/// of that name already, unless `overwrite` is set.
#[tauri::command(async)]
fn preset_save(app: AppHandle, name: String, contents: String, overwrite: bool) -> Result<String, String> {
    presets::save(&presets_dir(&app)?, &name, &contents, overwrite)
}

/// Write the presets that come with the editor into the presets directory: each once ever.
#[tauri::command(async)]
fn presets_seed(app: AppHandle, examples: Vec<presets::Example>) -> Result<(), String> {
    presets::seed(&presets_dir(&app)?, &examples)
}

/// The presets directory, made if it is not there: for showing it in the file manager.
#[tauri::command(async)]
fn presets_folder(app: AppHandle) -> Result<String, String> {
    let dir = presets_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("The folder {} could not be made ({e}).", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command(async)]
fn preset_delete(app: AppHandle, path: String) -> Result<(), String> {
    presets::delete(&presets_dir(&app)?, &path)
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
            engine_levels,
            engine_scope,
            sample_info,
            wavetable_info,
            presets_list,
            preset_save,
            preset_delete,
            presets_folder,
            presets_seed,
            read_text_file,
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
