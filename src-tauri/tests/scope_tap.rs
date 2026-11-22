//! What the Scope modules tap reaches the engine: the compiled `scoped` fixture, played in
//! Pd with the extra output channels the preview gives it.
//!
//! Scope 1 is on the oscillator and scope 2 on the envelope, inside the voices, and show
//! one voice: the one that got the latest note. Scope 3 is after the Voice Sum and shows
//! what is heard.

use std::path::PathBuf;

use gridelle_lib::engine::pd::{Atom, Pd, PdEvent};
use gridelle_lib::engine::scope::SLOTS;

const SAMPLE_RATE: u32 = 44_100;
const OUTPUTS: usize = 2 + SLOTS;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Render `seconds` and return each output channel on its own.
fn render(pd: &mut Pd, seconds: f32) -> Vec<Vec<f32>> {
    let blocks = (seconds * SAMPLE_RATE as f32 / Pd::block_size() as f32).ceil() as usize;
    let mut out = vec![0.0f32; Pd::block_size() * OUTPUTS * blocks];
    pd.process(&mut out);
    (0..OUTPUTS).map(|channel| out.iter().skip(channel).step_by(OUTPUTS).cloned().collect()).collect()
}

fn peak(signal: &[f32]) -> f32 {
    signal.iter().fold(0.0, |m, s| m.max(s.abs()))
}

/// Rising zero crossings a second.
fn frequency(signal: &[f32]) -> f32 {
    signal.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f32 * SAMPLE_RATE as f32 / signal.len() as f32
}

#[test]
fn scopes_tap_the_first_voice_and_the_sum() {
    let events = Pd::init().expect("first init returns the event stream");
    let mut pd = Pd::lock();
    pd.init_audio_with_outputs(SAMPLE_RATE, OUTPUTS).unwrap();
    assert_eq!(pd.output_channels(), OUTPUTS);
    pd.dsp(true);
    events.try_iter().for_each(drop);

    let host = pd.open(&repo().join("pd-lib/host.pd")).unwrap();
    let main = pd.open(&repo().join("tests/golden/scoped/main.pd")).expect("run `npm test` to generate the fixtures");
    let (oscillator, envelope, heard) = (2, 3, 4);

    // Before any note: the first voice's oscillator runs at middle C, its envelope is at
    // zero, and nothing is heard.
    let rest = render(&mut pd, 0.5);
    assert!(peak(&rest[oscillator]) > 0.9, "scope 1 shows the idle oscillator, peak {}", peak(&rest[oscillator]));
    assert!((frequency(&rest[oscillator]) - 261.6).abs() < 4.0, "at middle C, got {} Hz", frequency(&rest[oscillator]));
    assert_eq!(peak(&rest[envelope]), 0.0, "scope 2 shows the envelope at rest");
    assert_eq!(peak(&rest[heard]), 0.0, "scope 3 shows silence");
    assert_eq!(peak(&rest[0]), 0.0, "and silence is what is heard");

    // One note after another: Pd gives each to the voice that has rested longest, so they go
    // round the voices, and the scopes follow.
    for (pitch, hertz) in [(57.0, 220.0), (64.0, 329.6), (69.0, 440.0), (45.0, 110.0)] {
        pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(100.0)]);
        let held = render(&mut pd, 0.3);
        let shown = frequency(&held[oscillator][4410..]);
        assert!((shown - hertz).abs() < 5.0, "scope 1 shows note {pitch} at {hertz} Hz, got {shown}");
        let sustain = *held[envelope].last().unwrap();
        assert!((sustain - 0.6).abs() < 0.01, "scope 2 shows that note's envelope at its sustain, got {sustain}");
        pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(0.0)]);
        let released = render(&mut pd, 0.5);
        // A key going up does not move the scopes to another voice: the release is shown.
        assert!(released[envelope][0] > 0.5, "scope 2 shows the release from its start, got {}", released[envelope][0]);
        assert_eq!(*released[envelope].last().unwrap(), 0.0, "and its end");
    }

    // A chord of three notes on three voices: the last one pressed is the one shown.
    for pitch in [57.0, 64.0, 69.0] {
        pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(100.0)]);
    }
    let playing = render(&mut pd, 0.5);
    let tail = |channel: usize| &playing[channel][11025..];
    // One voice, not three added up: a saw at 440 Hz that peaks at 1.
    assert!(peak(tail(oscillator)) < 1.05, "scope 1 shows one voice, peak {}", peak(tail(oscillator)));
    assert!((frequency(tail(oscillator)) - 440.0).abs() < 5.0, "the last note, got {} Hz", frequency(tail(oscillator)));
    // The envelope of that voice: at its sustain of 0.6.
    let sustain = *playing[envelope].last().unwrap();
    assert!((sustain - 0.6).abs() < 0.01, "scope 2 shows the envelope at its sustain, got {sustain}");
    // What is heard, before Audio Out's level: three voices at once.
    assert!(peak(tail(heard)) > 0.7, "scope 3 shows the sum of the voices, peak {}", peak(tail(heard)));
    let audible = peak(&playing[0][11025..]);
    assert!((peak(tail(heard)) * 0.25 - audible).abs() < 0.01, "which is what goes to Audio Out at its level of 0.25: {} against {audible}", peak(tail(heard)));
    // The scope channels a patch does not use stay empty.
    for unused in 5..OUTPUTS {
        assert_eq!(peak(&playing[unused]), 0.0, "output channel {} is not used", unused + 1);
    }

    for pitch in [57.0, 64.0, 69.0] {
        pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(0.0)]);
    }
    let released = render(&mut pd, 1.0);
    assert_eq!(*released[envelope].last().unwrap(), 0.0, "scope 2 shows the envelope back at zero");
    assert!(peak(&released[heard][22050..]) < 1e-3, "scope 3 shows silence again");

    pd.close(main);
    pd.close(host);
    drop(pd);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
    println!("scopes: oscillator and envelope of the latest note's voice, and the sum of the voices (peak {:.2})", peak(tail(heard)));
}
