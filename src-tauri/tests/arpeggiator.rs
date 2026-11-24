//! Plays the Arpeggiator in real Pd and checks the notes it gives and when: the order of
//! each mode, the octaves, Hold, the Length of a note, and that its steps fall on the very
//! sample they should, on its own Tempo and following a Clock.
//!
//! What it sends goes to two `vline~`s, which jump at the logical time of a message: the
//! left channel is the pitch of the latest note-on, the right its velocity (0 at a note-off).
//! So the samples say when each note came, to the sample, and the messages are kept too.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;

use gridelle_lib::engine::pd::{Atom, Pd, PdEvent};

const SAMPLE_RATE: f32 = 44_100.0;
/// A sixteenth at 120 beats a minute, in samples.
const SIXTEENTH: f32 = 5512.5;

fn bench() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gridelle-arpeggiator-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules");
    for entry in fs::read_dir(modules).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    dir
}

/// The Arpeggiator `t1` with notes from `t-notes`; its settings' inputs at 1, as with no
/// cable. With `clocked`, a Clock `c1` (free, 120 beats a minute in sixteenths) drives its
/// Clock input, and the left channel is the Clock's Out instead of the pitch; without, that
/// input holds -1, as the compiler gives it unpatched.
fn with_arp<T>(pd: &mut Pd, dir: &Path, clocked: bool, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let clock = if clocked { "ge-clock c1" } else { "sig~ -1" };
    let boxes = [
        "r t-notes", "ge-arpeggiator t1", clock, "sig~ 1", "unpack f f", "vline~", "vline~", "dac~ 1 2", "s t-out",
    ];
    let mut connections = vec![
        [0, 0, 1, 0], [3, 0, 1, 2], [3, 0, 1, 3], [3, 0, 1, 4], [1, 0, 4, 0], [4, 0, 5, 0], [4, 1, 6, 0], [6, 0, 7, 1],
        [1, 0, 8, 0],
    ];
    connections.push(if clocked { [2, 0, 7, 0] } else { [5, 0, 7, 0] });
    // A Clock's Phase is its second outlet; its own inputs (Run, Tempo, Width) at 1.
    connections.push(if clocked { [2, 1, 1, 1] } else { [2, 0, 1, 1] });
    if clocked {
        connections.extend([[3, 0, 2, 0], [3, 0, 2, 1], [3, 0, 2, 2]]);
    }
    let mut text = String::from("#N canvas 0 0 600 400 12;\n");
    for (i, object) in boxes.iter().enumerate() {
        text += &format!("#X obj 30 {} {object};\n", 30 + i * 30);
    }
    for [source, outlet, target, inlet] in &connections {
        text += &format!("#X connect {source} {outlet} {target} {inlet};\n");
    }
    let file = dir.join("bench.pd");
    fs::write(&file, text).unwrap();
    let patch = pd.open(&file).expect("the test patch opens");
    for (setting, value) in [("tempo", 120.0), ("length", 50.0), ("octaves", 1.0), ("division", 4.0), ("mode", 0.0), ("hold", 0.0)] {
        pd.send_float(&format!("t1-{setting}"), value);
    }
    if clocked {
        for (setting, value) in [("tempo", 120.0), ("width", 50.0), ("division", 4.0)] {
            pd.send_float(&format!("c1-{setting}"), value);
        }
    }
    let result = measure(pd);
    pd.close(patch);
    result
}

/// Render whole blocks for about `seconds`: the pitch and velocity signals.
fn render(pd: &mut Pd, seconds: f32) -> (Vec<f32>, Vec<f32>) {
    let blocks = (seconds * SAMPLE_RATE / 64.0).ceil() as usize;
    let mut out = vec![0.0f32; 64 * 2 * blocks];
    pd.process(&mut out);
    out.chunks(2).map(|frame| (frame[0], frame[1])).unzip()
}

fn keys(pd: &mut Pd, pitches: &[f32], velocity: f32) {
    for pitch in pitches {
        pd.send_list("t-notes", &[Atom::Float(*pitch), Atom::Float(velocity)]);
    }
}

/// The notes it sent since last asked, as (pitch, velocity).
fn sent(events: &Receiver<PdEvent>) -> Vec<(f32, f32)> {
    events
        .try_iter()
        .filter_map(|event| match event {
            PdEvent::Message { recv, atoms } if recv == "t-out" => match atoms.as_slice() {
                [Atom::Float(p), Atom::Float(v)] => Some((*p, *v)),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// The pitches of the note-ons among them.
fn played(notes: &[(f32, f32)]) -> Vec<f32> {
    notes.iter().filter(|(_, v)| *v > 0.0).map(|(p, _)| *p).collect()
}

/// The samples at which the velocity rose from 0: the note-ons that followed a silence.
fn rises(velocity: &[f32]) -> Vec<usize> {
    velocity.windows(2).enumerate().filter(|(_, w)| w[0] == 0.0 && w[1] > 0.0).map(|(i, _)| i + 1).collect()
}

fn own_rate(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    with_arp(pd, dir, false, |pd| {
        render(pd, 0.05);
        sent(events);
        // A chord: the first step is at once, then one every sixteenth.
        keys(pd, &[60.0, 64.0, 67.0], 100.0);
        let (pitch, velocity) = render(pd, 1.0);
        let notes = sent(events);
        assert_eq!(played(&notes)[..8], [60.0, 64.0, 67.0, 60.0, 64.0, 67.0, 60.0, 64.0], "up: the held keys from the bottom, round again");
        assert!(notes.iter().all(|(_, v)| *v == 0.0 || *v == 100.0), "at the keys' velocity");
        let on = rises(&velocity);
        assert_eq!(velocity[0], 100.0, "the first note comes with the keys, at the first sample");
        for (n, at) in on.iter().enumerate() {
            let expected = SIXTEENTH * (n + 1) as f32;
            assert!((*at as f32 - expected).abs() <= 1.0, "step {} at sample {at}, expected {expected}", n + 1);
        }
        assert!(on.len() >= 7, "eight steps in a second, got {}", on.len() + 1);
        // Each note goes off half a step after it began.
        let offs: Vec<usize> = velocity.windows(2).enumerate().filter(|(_, w)| w[0] > 0.0 && w[1] == 0.0).map(|(i, _)| i + 1).collect();
        assert!((offs[0] as f32 - SIXTEENTH / 2.0).abs() <= 1.0, "Length 50: off after half a step, at {}", offs[0]);
        assert_eq!(pitch[(SIXTEENTH * 1.5) as usize], 64.0, "the second note is the second key");
        // Let go: it stops, the last note off.
        keys(pd, &[60.0, 64.0, 67.0], 0.0);
        render(pd, 0.3);
        let after = sent(events);
        assert!(played(&after).is_empty(), "nothing more when the keys are up: {after:?}");
        println!("ge-arpeggiator: steps a sixteenth apart at 120, to the sample; off after half of one");
    });
}

fn modes(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    let run = |pd: &mut Pd, mode: f32, octaves: f32, order: &[f32], steps: usize| {
        pd.send_float("t1-mode", mode);
        pd.send_float("t1-octaves", octaves);
        render(pd, 0.05);
        sent(events);
        keys(pd, order, 90.0);
        render(pd, steps as f32 * SIXTEENTH / SAMPLE_RATE - 0.01);
        let notes = played(&sent(events));
        keys(pd, order, 0.0);
        render(pd, 0.2);
        sent(events);
        notes
    };
    with_arp(pd, dir, false, |pd| {
        let order = [64.0, 60.0, 67.0];
        assert_eq!(run(pd, 1.0, 1.0, &order, 7), [67.0, 64.0, 60.0, 67.0, 64.0, 60.0, 67.0], "down");
        assert_eq!(run(pd, 2.0, 1.0, &order, 9), [60.0, 64.0, 67.0, 64.0, 60.0, 64.0, 67.0, 64.0, 60.0], "up and down, ends not twice");
        assert_eq!(run(pd, 3.0, 1.0, &order, 6), [64.0, 60.0, 67.0, 64.0, 60.0, 67.0], "as played");
        assert_eq!(run(pd, 0.0, 2.0, &order, 7), [60.0, 64.0, 67.0, 72.0, 76.0, 79.0, 60.0], "up over two octaves");
        assert_eq!(run(pd, 1.0, 2.0, &order, 4), [79.0, 76.0, 72.0, 67.0], "down from the top octave");
        assert_eq!(run(pd, 2.0, 1.0, &[60.0], 3), [60.0, 60.0, 60.0], "one key, up and down");
        let random = run(pd, 4.0, 1.0, &order, 40);
        assert!(random.iter().all(|p| order.contains(p)), "random: only the held keys");
        assert!(order.iter().all(|p| random.contains(p)), "random: every one of them in 40 steps");
        println!("ge-arpeggiator: up, down, up and down, as played, random and octaves in order");
    });
}

fn hold_and_changes(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    with_arp(pd, dir, false, |pd| {
        // A key let go mid-arpeggio leaves it; one pressed joins it, in its place from the bottom.
        render(pd, 0.05);
        keys(pd, &[60.0, 67.0], 100.0);
        render(pd, 2.0 * SIXTEENTH / SAMPLE_RATE);
        keys(pd, &[67.0], 0.0);
        keys(pd, &[64.0], 100.0);
        sent(events);
        render(pd, 4.0 * SIXTEENTH / SAMPLE_RATE);
        let notes = played(&sent(events));
        assert!(notes.iter().all(|p| [60.0, 64.0].contains(p)) && notes.contains(&64.0), "60 and 64 now: {notes:?}");
        keys(pd, &[60.0, 64.0], 0.0);
        render(pd, 0.2);

        // Hold: the keys stay after they are let go, until a key goes down with none down.
        pd.send_float("t1-hold", 1.0);
        keys(pd, &[60.0, 64.0], 100.0);
        keys(pd, &[60.0, 64.0], 0.0);
        sent(events);
        // Steps at 0, 1, 2 and 3 sixteenths.
        render(pd, 4.0 * SIXTEENTH / SAMPLE_RATE - 0.01);
        assert_eq!(played(&sent(events)), [60.0, 64.0, 60.0, 64.0], "held after the keys are up");
        keys(pd, &[72.0], 100.0);
        render(pd, 3.0 * SIXTEENTH / SAMPLE_RATE);
        let new = played(&sent(events));
        assert!(new.iter().all(|p| *p == 72.0) && !new.is_empty(), "a new chord replaces the held one: {new:?}");
        // Hold off with no key down lets go.
        keys(pd, &[72.0], 0.0);
        pd.send_float("t1-hold", 0.0);
        render(pd, 0.05);
        sent(events);
        render(pd, 0.3);
        assert!(played(&sent(events)).is_empty(), "Hold off with no key down: silence");
        println!("ge-arpeggiator: keys join and leave mid-arpeggio; Hold keeps them until a new chord");
    });
}

fn following_a_clock(pd: &mut Pd, dir: &Path, events: &Receiver<PdEvent>) {
    with_arp(pd, dir, true, |pd| {
        // Each step comes at the sample the Clock ticks (its Out rises), whatever block that is in.
        let steps_on_ticks = |clock: &[f32], velocity: &[f32]| {
            let ticks: Vec<usize> = clock.windows(2).enumerate().filter(|(_, w)| w[0] < 0.5 && w[1] >= 0.5).map(|(i, _)| i + 1).collect();
            let on = rises(velocity);
            let worst = on.iter().map(|at| ticks.iter().map(|t| at.abs_diff(*t)).min().unwrap_or(usize::MAX)).max().unwrap_or(0);
            (ticks.len(), on.len(), worst)
        };
        render(pd, 0.3);
        sent(events);
        keys(pd, &[60.0, 64.0], 100.0);
        let (clock, velocity) = render(pd, 1.0);
        let (ticks, steps, worst) = steps_on_ticks(&clock, &velocity);
        assert!(steps >= 6 && steps + 1 >= ticks, "a step on each of the Clock's ticks: {steps} steps, {ticks} ticks");
        assert!(worst <= 1, "every step on a tick of the Clock, to the sample: worst {worst} samples off");
        assert_eq!(played(&sent(events))[..4], [60.0, 64.0, 60.0, 64.0], "the keys in turn");
        // The Clock slower: the steps follow, a step every 11025 samples.
        pd.send_float("c1-tempo", 60.0);
        render(pd, 0.3);
        let (clock, velocity) = render(pd, 1.0);
        let (_, _, slower) = steps_on_ticks(&clock, &velocity);
        let on = rises(&velocity);
        let gaps: Vec<usize> = on.windows(2).map(|w| w[1] - w[0]).collect();
        assert!(slower <= 1 && gaps.iter().all(|g| g.abs_diff(11025) <= 1), "at 60 a step every 11025 samples: {gaps:?}");
        keys(pd, &[60.0, 64.0], 0.0);
        render(pd, 0.3);
        sent(events);
        println!("ge-arpeggiator: on a Clock's ticks, within {worst} samples; follows its tempo");
    });
}

#[test]
fn the_arpeggiator_plays_what_it_should_when_it_should() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = bench();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE as u32).unwrap();
    pd.dsp(true);
    let out = pd.bind("t-out");
    events.try_iter().for_each(drop);

    own_rate(&mut pd, &dir, &events);
    modes(&mut pd, &dir, &events);
    hold_and_changes(&mut pd, &dir, &events);
    following_a_clock(&mut pd, &dir, &events);

    pd.unbind(out);
    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
