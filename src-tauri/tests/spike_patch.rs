//! Headless check: the vendored libpd builds, loads an Organelle-style patch,
//! makes sound when a note arrives, and reports screen text.

use std::path::PathBuf;

use gridelle_lib::engine::pd::{Atom, Pd, PdEvent};

fn pd_lib() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib")
}

fn peak(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0, |m, s| m.max(s.abs()))
}

#[test]
fn spike_patch_plays_and_reports_screen() {
    let events = Pd::init().expect("first init returns the event stream");
    let mut pd = Pd::lock();
    pd.init_audio(44_100).unwrap();
    let screen = pd.bind("screenLine1");
    let led = pd.bind("led");

    let host = pd.open(&pd_lib().join("host.pd")).unwrap();
    let main = pd.open(&pd_lib().join("spike/main.pd")).unwrap();
    pd.dsp(true);

    let block = Pd::block_size() * 2;
    let mut silent = vec![0.0f32; block * 50];
    pd.process(&mut silent);
    assert!(peak(&silent) < 1e-4, "no note yet, expected silence, got {}", peak(&silent));

    pd.send_list("notes", &[Atom::Float(60.0), Atom::Float(100.0)]);
    pd.send_float("knob1", 1.0);
    pd.send_float("aux", 1.0);
    let mut playing = vec![0.0f32; block * 200];
    pd.process(&mut playing);
    assert!(peak(&playing) > 0.01, "note on should be audible, peak {}", peak(&playing));
    assert!(peak(&playing) <= 1.0, "host clips to [-1, 1]");

    pd.send_list("notes", &[Atom::Float(60.0), Atom::Float(0.0)]);
    let mut released = vec![0.0f32; block * 200];
    pd.process(&mut released);
    let tail = &released[released.len() - block * 20..];
    assert!(peak(tail) < 1e-3, "note off should decay to silence, peak {}", peak(tail));

    pd.close(main);
    pd.close(host);
    pd.unbind(screen);
    pd.unbind(led);
    drop(pd);

    let all: Vec<PdEvent> = events.try_iter().collect();
    let prints: Vec<&String> =
        all.iter().filter_map(|e| if let PdEvent::Print(s) = e { Some(s) } else { None }).collect();
    assert!(
        !prints.iter().any(|p| p.contains("couldn't create") || p.contains("error")),
        "Pd reported errors: {prints:?}"
    );
    let screen_text: Vec<String> = all
        .iter()
        .filter_map(|e| match e {
            PdEvent::Message { recv, atoms } if recv == "screenLine1" => {
                Some(atoms.iter().map(Atom::to_text).collect::<Vec<_>>().join(" "))
            }
            _ => None,
        })
        .collect();
    assert_eq!(screen_text.first().map(String::as_str), Some("Cutoff 1600 Hz"));
    assert_eq!(screen_text.last().map(String::as_str), Some("Cutoff 6100 Hz"));
    assert!(all.contains(&PdEvent::Message { recv: "led".into(), atoms: vec![Atom::Float(3.0)] }));
}
