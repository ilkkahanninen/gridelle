//! Plays the helpers behind the voices' settings in real Pd: `ge-mono`, which picks one note
//! at a time from the held keys (by priority, legato or not), `ge-voice`, which takes a
//! legato note without starting the gate again, and `ge-unison-place`, which gives a unison
//! group's copy its place among the copies, for the group's shelf.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use gridelle_lib::engine::pd::{Atom, Patch, Pd, PdEvent};

const SAMPLE_RATE: f32 = 44_100.0;

fn bench() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gridelle-voicing-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules");
    for entry in fs::read_dir(modules).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    dir
}

fn open(pd: &mut Pd, dir: &Path, boxes: &[&str], connections: &[[usize; 4]]) -> Patch {
    let mut text = String::from("#N canvas 0 0 600 400 12;\n");
    for (i, object) in boxes.iter().enumerate() {
        text += &format!("#X obj 30 {} {object};\n", 30 + i * 30);
    }
    for [source, outlet, target, inlet] in connections {
        text += &format!("#X connect {source} {outlet} {target} {inlet};\n");
    }
    let file = dir.join("bench.pd");
    fs::write(&file, text).unwrap();
    pd.open(&file).expect("the test patch opens")
}

/// The lists sent to `t-out` since last asked.
fn sent(events: &Receiver<PdEvent>) -> Vec<Vec<f32>> {
    events
        .try_iter()
        .filter_map(|event| match event {
            PdEvent::Message { recv, atoms } if recv == "t-out" => Some(
                atoms
                    .iter()
                    .map(|a| match a {
                        Atom::Float(f) => *f,
                        other => panic!("a number, got {other:?}"),
                    })
                    .collect(),
            ),
            _ => None,
        })
        .collect()
}

fn floats(values: &[f32]) -> Vec<Atom> {
    values.iter().map(|v| Atom::Float(*v)).collect()
}

/// Render whole blocks for about `seconds`: the left and right channels.
fn render(pd: &mut Pd, seconds: f32) -> (Vec<f32>, Vec<f32>) {
    let blocks = (seconds * SAMPLE_RATE / 64.0).ceil() as usize;
    let mut out = vec![0.0f32; 64 * 2 * blocks];
    pd.process(&mut out);
    out.chunks(2).map(|frame| (frame[0], frame[1])).unzip()
}

/// Each step is a key (pitch, velocity) and the notes `ge-mono` should send for it.
fn mono(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    let play = |pd: &mut Pd, name: &str, priority: u8, legato: u8, steps: &[((f32, f32), &[[f32; 3]])]| {
        let patch = open(pd, dir, &["r t-notes", &format!("ge-mono {priority} {legato}"), "s t-out"], &[[0, 0, 1, 0], [1, 0, 2, 0]]);
        sent(events);
        for ((pitch, velocity), expected) in steps {
            pd.send_list("t-notes", &floats(&[*pitch, *velocity]));
            let got = sent(events);
            let expected: Vec<Vec<f32>> = expected.iter().map(|n| n.to_vec()).collect();
            assert_eq!(got, expected, "{name}: after the key {pitch} at {velocity}");
        }
        pd.close(patch);
    };
    play(pd, "last, retriggered", 0, 0, &[
        ((60.0, 100.0), &[[60.0, 100.0, 0.0]]),
        ((64.0, 90.0), &[[64.0, 90.0, 0.0]]),
        ((67.0, 80.0), &[[67.0, 80.0, 0.0]]),
        // A key that is not sounding goes up: nothing changes.
        ((64.0, 0.0), &[]),
        // The sounding one goes up: back to the last of those still held, at its velocity.
        ((67.0, 0.0), &[[60.0, 100.0, 0.0]]),
        ((60.0, 0.0), &[[60.0, 0.0, 0.0]]),
        // A key up that was never down.
        ((60.0, 0.0), &[]),
    ]);
    play(pd, "last, legato", 0, 1, &[
        // The first note follows silence: not legato.
        ((60.0, 100.0), &[[60.0, 100.0, 0.0]]),
        ((64.0, 90.0), &[[64.0, 90.0, 1.0]]),
        ((64.0, 0.0), &[[60.0, 100.0, 1.0]]),
        ((60.0, 0.0), &[[60.0, 0.0, 0.0]]),
        ((62.0, 70.0), &[[62.0, 70.0, 0.0]]),
        ((62.0, 0.0), &[[62.0, 0.0, 0.0]]),
    ]);
    play(pd, "lowest", 1, 0, &[
        ((64.0, 100.0), &[[64.0, 100.0, 0.0]]),
        ((60.0, 90.0), &[[60.0, 90.0, 0.0]]),
        ((67.0, 80.0), &[]),
        ((60.0, 0.0), &[[64.0, 100.0, 0.0]]),
        ((64.0, 0.0), &[[67.0, 80.0, 0.0]]),
        ((67.0, 0.0), &[[67.0, 0.0, 0.0]]),
        // The ends of the keyboard.
        ((127.0, 50.0), &[[127.0, 50.0, 0.0]]),
        ((0.0, 60.0), &[[0.0, 60.0, 0.0]]),
        ((0.0, 0.0), &[[127.0, 50.0, 0.0]]),
        ((127.0, 0.0), &[[127.0, 0.0, 0.0]]),
    ]);
    play(pd, "highest, legato", 2, 1, &[
        ((60.0, 100.0), &[[60.0, 100.0, 0.0]]),
        ((67.0, 90.0), &[[67.0, 90.0, 1.0]]),
        ((64.0, 80.0), &[]),
        ((67.0, 0.0), &[[64.0, 80.0, 1.0]]),
        ((64.0, 0.0), &[[60.0, 100.0, 1.0]]),
        ((60.0, 0.0), &[[60.0, 0.0, 0.0]]),
        ((0.0, 60.0), &[[0.0, 60.0, 0.0]]),
        ((127.0, 50.0), &[[127.0, 50.0, 1.0]]),
        ((127.0, 0.0), &[[0.0, 60.0, 1.0]]),
        ((0.0, 0.0), &[[0.0, 0.0, 0.0]]),
    ]);
    println!("ge-mono: last, lowest and highest, back to a held key, legato only after a note");
}

fn voice(pd: &mut Pd, dir: &Path) {
    // A voice: the pitch on the left, the gate on the right.
    let patch = open(pd, dir, &["r t-voice", "ge-voice", "dac~ 1 2"], &[[0, 0, 1, 0], [1, 0, 2, 0], [1, 1, 2, 1]]);
    let note = |pd: &mut Pd, values: [f32; 3]| pd.send_list("t-voice", &floats(&values));
    let (pitch, _) = render(pd, 0.02);
    assert_eq!(*pitch.last().unwrap(), 60.0, "60 until the first note");

    note(pd, [64.0, 100.0, 0.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert_eq!(pitch[0], 64.0, "the pitch at once");
    assert!(gate[..60].iter().all(|g| *g == 0.0) && gate[70..].iter().all(|g| *g == 1.0), "the gate on after 1.5 ms");

    note(pd, [67.0, 90.0, 1.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert_eq!(pitch[0], 67.0, "legato: the new pitch at once");
    assert!(gate.iter().all(|g| *g == 1.0), "legato: the gate stays on");

    note(pd, [69.0, 90.0, 0.0]);
    let (_, gate) = render(pd, 0.02);
    assert!(gate[..60].iter().all(|g| *g == 0.0) && gate[70..].iter().all(|g| *g == 1.0), "not legato: the gate starts again");

    note(pd, [69.0, 0.0, 0.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert!(gate.iter().all(|g| *g == 0.0), "off");
    assert_eq!(pitch[0], 69.0, "the pitch stays after the note");
    pd.close(patch);
    println!("ge-voice: legato keeps the gate on, and anything else starts the note again");
}

/// A unison group's copy's place among the copies (`ge-unison-place`, from the copy's number
/// and their count), what the group's shelf gives: from -1 to 1 on the left, 0 to 1 on the right.
fn place(pd: &mut Pd, dir: &Path) {
    for (args, expected) in [("0 3", -1.0), ("1 3", 0.0), ("2 3", 1.0), ("1 4", -1.0 / 3.0), ("3 4", 1.0), ("0 1", 0.0), ("", 0.0)] {
        let patch = open(pd, dir, &[&format!("ge-unison-place {args}"), "dac~ 1 2"], &[[0, 0, 1, 0], [0, 1, 1, 1]]);
        let (place, unipolar) = render(pd, 0.02);
        let (place, unipolar) = (*place.last().unwrap(), *unipolar.last().unwrap());
        assert!((place - expected).abs() < 1e-6, "ge-unison-place {args}: {place} for {expected}");
        assert!((unipolar - (expected + 1.0) / 2.0).abs() < 1e-6, "ge-unison-place {args}: 0-1 gives {unipolar}");
        pd.close(patch);
    }
    println!("ge-unison-place: the copies evenly from -1 to 1, one alone in the middle");
}

#[test]
fn the_voices_play_notes_as_they_are_set_to() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = bench();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE as u32).unwrap();
    pd.dsp(true);
    let out = pd.bind("t-out");
    events.try_iter().for_each(drop);

    mono(&mut pd, &dir, &events);
    voice(&mut pd, &dir);
    place(&mut pd, &dir);

    pd.unbind(out);
    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
