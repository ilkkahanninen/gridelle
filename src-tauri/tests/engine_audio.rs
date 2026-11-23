//! Runs the real preview engine against the default audio device.
//! Ignored by default because it needs an output device; it plays at -40 dB.
//! Run with: cargo test --test engine_audio -- --ignored

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::Duration;

use gridelle_lib::engine::audio::Engine;
use gridelle_lib::engine::pd::{Atom, PdEvent};
use gridelle_lib::samples::SampleFile;

const VOLUME: f32 = 0.01;

#[test]
#[ignore = "needs an audio output device"]
fn engine_renders_loaded_patch_to_the_device() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    let engine = Engine::start(move |e| sink.lock().unwrap().push(e)).expect("engine starts");
    engine.set_volume(VOLUME);

    let files = HashMap::from([
        ("main.pd".to_string(), include_str!("../../pd-lib/spike/main.pd").to_string()),
        ("voice.pd".to_string(), include_str!("../../pd-lib/spike/voice.pd").to_string()),
    ]);
    let _ = engine.load(&files, "main.pd", &[]).expect("patch loads");
    sleep(Duration::from_millis(150));
    assert!(engine.peak() < 1e-5, "silent before any note, peak {}", engine.peak());

    engine.send("knob1", vec![Atom::Float(1.0)]).unwrap();
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(300));
    let playing = engine.peak();
    assert!(playing > VOLUME * 0.01, "note should reach the output, peak {playing}");
    assert!(playing <= VOLUME * 1.001, "volume caps the output, peak {playing}");

    // Reloading while a note sounds must leave a working, silent patch behind.
    let _ = engine.load(&files, "main.pd", &[]).expect("patch reloads");
    sleep(Duration::from_millis(200));
    assert!(engine.peak() < 1e-5, "fresh patch is silent, peak {}", engine.peak());
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(300));
    assert!(engine.peak() > VOLUME * 0.01, "reloaded patch plays");
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(0.0)]).unwrap();
    sleep(Duration::from_millis(200));

    // The Scope modules of a compiled patch: what they tap comes out of the engine, at the
    // level it has in the patch, whatever the volume.
    let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/golden/scoped");
    let scoped: HashMap<String, String> = std::fs::read_dir(&folder)
        .expect("run `npm test` to generate the fixtures")
        .map(|entry| entry.unwrap().path())
        .map(|path| (path.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&path).unwrap()))
        .collect();
    let _ = engine.load(&scoped, "main.pd", &[]).expect("the scoped patch loads");
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(400));
    let window = engine.sample_rate() as usize / 50;
    let range = |picture: &[f32]| picture.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
    // Scope 1, on the oscillator: 20 ms of a saw at 220 Hz, held still by its trigger.
    let saw = engine.scope(0, window, 200, true);
    assert_eq!(saw.len(), 400, "a lowest and a highest value for each of 200 columns");
    let (low, high) = range(&saw);
    assert!(low < -0.8 && high > 0.8 && high < 1.1, "scope 1 has the saw at full level, {low}..{high}");
    assert!(saw[0].abs() < 0.2, "and starts where it rises through its middle, at {}", saw[0]);
    // Scope 2, on the envelope: at its sustain. Scope 3, after the Voice Sum: the saw times that.
    let (low, high) = range(&engine.scope(1, window, 200, false));
    assert!((low - 0.6).abs() < 0.01 && (high - 0.6).abs() < 0.01, "scope 2 has the envelope, {low}..{high}");
    let (low, high) = range(&engine.scope(2, window, 200, true));
    assert!(low < -0.45 && high > 0.45 && high < 0.7, "scope 3 has what is heard, {low}..{high}");
    assert_eq!(range(&engine.scope(3, window, 200, false)), (0.0, 0.0), "a scope the patch does not have is empty");
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(0.0)]).unwrap();
    sleep(Duration::from_millis(300));

    // A patch that plays a sound file: the engine converts the file (a FLAC here) and puts
    // it beside the patch, where the patch loads it.
    let folder = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/golden/sampler");
    let sampler: HashMap<String, String> = std::fs::read_dir(&folder)
        .expect("run `npm test` to generate the fixtures")
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|e| e == "pd"))
        .map(|path| (path.file_name().unwrap().to_string_lossy().into_owned(), std::fs::read_to_string(&path).unwrap()))
        .collect();
    let sound = |path: &str| SampleFile::sound("ge-sample-a.wav", path);
    let flac = format!("{}/tests/sounds/tone.flac", env!("CARGO_MANIFEST_DIR"));
    let _ = engine.load(&sampler, "main.pd", &[sound(&flac)]).expect("the sampler loads");
    sleep(Duration::from_millis(150));
    assert!(engine.peak() < 1e-5, "the sampler is silent before a note, peak {}", engine.peak());
    engine.send("notes", vec![Atom::Float(60.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(150));
    let sampled = engine.peak();
    assert!(sampled > VOLUME * 0.02, "the sound file is heard, peak {sampled}");
    engine.send("notes", vec![Atom::Float(60.0), Atom::Float(0.0)]).unwrap();
    sleep(Duration::from_millis(400));
    // A sound file that is not there refuses the load, and the patch that was playing stays.
    let error = engine.load(&sampler, "main.pd", &[sound("/nowhere/kick.wav")]).unwrap_err();
    assert!(error.starts_with("kick.wav is not where the patch expects it"), "{error}");
    engine.send("notes", vec![Atom::Float(60.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(150));
    assert!(engine.peak() > VOLUME * 0.02, "the patch from before still plays");
    engine.send("notes", vec![Atom::Float(60.0), Atom::Float(0.0)]).unwrap();
    sleep(Duration::from_millis(300));

    let events = events.lock().unwrap();
    let errors: Vec<_> = events
        .iter()
        .filter(|e| matches!(e, PdEvent::Print(p) if p.contains("couldn't create") || p.contains("error")))
        .collect();
    assert!(errors.is_empty(), "Pd reported errors: {errors:?}");
    assert!(
        events.iter().any(|e| matches!(e, PdEvent::Message { recv, .. } if recv == "screenLine1")),
        "screen text is forwarded"
    );
    println!("sample rate {} Hz, peak while playing {playing}, while playing a sample {sampled}", engine.sample_rate());
}
