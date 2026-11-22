//! Runs the real preview engine against the default audio device.
//! Ignored by default because it needs an output device; it plays at -40 dB.
//! Run with: cargo test --test engine_audio -- --ignored

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::Duration;

use gridelle_lib::engine::audio::Engine;
use gridelle_lib::engine::pd::{Atom, PdEvent};

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
    let _ = engine.load(&files, "main.pd").expect("patch loads");
    sleep(Duration::from_millis(150));
    assert!(engine.peak() < 1e-5, "silent before any note, peak {}", engine.peak());

    engine.send("knob1", vec![Atom::Float(1.0)]).unwrap();
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(300));
    let playing = engine.peak();
    assert!(playing > VOLUME * 0.01, "note should reach the output, peak {playing}");
    assert!(playing <= VOLUME * 1.001, "volume caps the output, peak {playing}");

    // Reloading while a note sounds must leave a working, silent patch behind.
    let _ = engine.load(&files, "main.pd").expect("patch reloads");
    sleep(Duration::from_millis(200));
    assert!(engine.peak() < 1e-5, "fresh patch is silent, peak {}", engine.peak());
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(100.0)]).unwrap();
    sleep(Duration::from_millis(300));
    assert!(engine.peak() > VOLUME * 0.01, "reloaded patch plays");
    engine.send("notes", vec![Atom::Float(57.0), Atom::Float(0.0)]).unwrap();
    sleep(Duration::from_millis(200));

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
    println!("sample rate {} Hz, peak while playing {playing}", engine.sample_rate());
}
