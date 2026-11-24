//! Plays the helpers behind the voices' settings in real Pd: `ge-mono`, which picks one note
//! at a time from the held keys (by priority, legato or not), `ge-unison`, which sends a note
//! on to each of its voices, and `ge-voice`, which takes a legato note without starting the
//! gate again and detunes itself by its share of Detune.

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

fn unison(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    let patch = open(pd, dir, &["r t-in", "ge-unison 3", "s t-out"], &[[0, 0, 1, 0], [1, 0, 2, 0]]);
    sent(events);
    pd.send_list("t-in", &floats(&[1.0, 60.0, 100.0, 1.0]));
    assert_eq!(sent(events), vec![vec![3.0, 60.0, 100.0, 1.0], vec![4.0, 60.0, 100.0, 1.0], vec![5.0, 60.0, 100.0, 1.0]]);
    // A note-off of the first place, as [poly] gives it.
    pd.send_list("t-in", &floats(&[0.0, 64.0, 0.0, 0.0]));
    assert_eq!(sent(events), vec![vec![0.0, 64.0, 0.0, 0.0], vec![1.0, 64.0, 0.0, 0.0], vec![2.0, 64.0, 0.0, 0.0]]);
    pd.close(patch);
    println!("ge-unison: a note on to each of its voices");
}

fn voice(pd: &mut Pd, dir: &Path) {
    // The third of three voices of a note: the pitch on the left, the gate on the right.
    let patch = open(pd, dir, &["r t-voice", "ge-voice 2 3", "dac~ 1 2"], &[[0, 0, 1, 0], [1, 0, 2, 0], [1, 1, 2, 1]]);
    let note = |pd: &mut Pd, values: [f32; 3]| pd.send_list("t-voice", &floats(&values));
    pd.send_float("ge-detune", 30.0);
    let (pitch, _) = render(pd, 0.02);
    assert!((pitch.last().unwrap() - 60.3).abs() < 1e-4, "the outermost voice, 30 cents up: {}", pitch.last().unwrap());

    note(pd, [64.0, 100.0, 0.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert!((pitch[0] - 64.3).abs() < 1e-4, "the pitch at once: {}", pitch[0]);
    assert!(gate[..60].iter().all(|g| *g == 0.0) && gate[70..].iter().all(|g| *g == 1.0), "the gate on after 1.5 ms");

    note(pd, [67.0, 90.0, 1.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert!((pitch[0] - 67.3).abs() < 1e-4, "legato: the new pitch at once: {}", pitch[0]);
    assert!(gate.iter().all(|g| *g == 1.0), "legato: the gate stays on");

    note(pd, [69.0, 90.0, 0.0]);
    let (_, gate) = render(pd, 0.02);
    assert!(gate[..60].iter().all(|g| *g == 0.0) && gate[70..].iter().all(|g| *g == 1.0), "not legato: the gate starts again");

    note(pd, [69.0, 0.0, 0.0]);
    let (pitch, gate) = render(pd, 0.02);
    assert!(gate.iter().all(|g| *g == 0.0), "off");
    assert!((pitch[0] - 69.3).abs() < 1e-4, "the pitch stays after the note");
    pd.close(patch);

    // The first and the middle voice of three, and a voice with no Unison, which Detune leaves alone.
    for (args, expected) in [("0 3", 59.5), ("1 3", 60.0), ("0 1", 60.0), ("", 60.0)] {
        let patch = open(pd, dir, &[&format!("ge-voice {args}"), "dac~ 1 2"], &[[0, 0, 1, 0]]);
        pd.send_float("ge-detune", 50.0);
        let (pitch, _) = render(pd, 0.02);
        assert!((pitch.last().unwrap() - expected).abs() < 1e-4, "ge-voice {args}: {} for {expected}", pitch.last().unwrap());
        pd.close(patch);
    }
    println!("ge-voice: legato keeps the gate on; voices spread over plus and minus Detune");
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
    unison(&mut pd, &dir, &events);
    voice(&mut pd, &dir);

    pd.unbind(out);
    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
