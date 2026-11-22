//! Loads the sample helpers and modules in real Pd and checks what they do with a sample
//! whose contents are known: a ramp, so that what comes out says which place was read.

use std::fs;
use std::path::{Path, PathBuf};

use gridelle_lib::engine::pd::{Atom, Pd, PdEvent};

const SAMPLE_RATE: f32 = 44_100.0;
/// The sample the players are measured on: a tenth of a second, so one pass at its own
/// speed is ten a second.
const SIZE: usize = 4410;

/// A folder holding the abstractions, where test patches can be written next to them.
fn bench() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gridelle-sample-dsp-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules");
    for entry in fs::read_dir(modules).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    dir
}

/// Load a test patch of object boxes and `[source, outlet, target, inlet]` connections, run
/// `measure` with it open, and close it again.
fn with_patch<T>(pd: &mut Pd, dir: &Path, boxes: &[String], connections: &[[usize; 4]], measure: impl FnOnce(&mut Pd) -> T) -> T {
    let mut text = String::from("#N canvas 0 0 600 400 12;\n");
    for (i, object) in boxes.iter().enumerate() {
        text += &format!("#X obj 30 {} {object};\n", 30 + i * 30);
    }
    for [source, outlet, target, inlet] in connections {
        text += &format!("#X connect {source} {outlet} {target} {inlet};\n");
    }
    let file = dir.join("bench.pd");
    fs::write(&file, text).unwrap();
    let patch = pd.open(&file).expect("the test patch opens");
    let result = measure(pd);
    pd.close(patch);
    result
}

/// Render `samples` (rounded up to whole blocks) and return the left and right channels.
fn render(pd: &mut Pd, samples: usize) -> (Vec<f32>, Vec<f32>) {
    let blocks = samples.div_ceil(Pd::block_size());
    let mut out = vec![0.0f32; Pd::block_size() * 2 * blocks];
    pd.process(&mut out);
    out.chunks(2).map(|frame| (frame[0], frame[1])).unzip()
}

fn close(actual: f32, expected: f32, tolerance: f32, what: &str) {
    assert!((actual - expected).abs() <= tolerance, "{what}: expected {expected} within {tolerance}, got {actual}");
}

fn set(pd: &mut Pd, settings: &[(&str, f32)]) {
    for (name, value) in settings {
        pd.send_float(name, *value);
    }
}

/// A sample in slot 0 that rises from 0 at its start to 1 at its end, at `rate` Hz.
fn ramp_sample(pd: &mut Pd, rate: f32) {
    let ramp: Vec<f32> = (0..SIZE).map(|i| i as f32 / SIZE as f32).collect();
    assert!(pd.write_array("ge-sample-0", 0, &ramp), "the sample's table takes the ramp");
    pd.send_float("ge-sample-0-rate", rate);
    pd.send_float("ge-sample-0-size", SIZE as f32);
}

/// A test patch around a module that works on sample 0, with a table of `SIZE` samples.
/// `inlets` are the values its inlets rest at, each settable with `t-in<number>`; the
/// module's outlets `left` and `right` go to the two channels.
fn with_sample_module<T>(pd: &mut Pd, dir: &Path, name: &str, inlets: &[f32], left: usize, right: usize, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let mut boxes = vec![format!("table ge-sample-0 {SIZE}"), format!("{name} t1 0"), "dac~ 1 2".to_string()];
    let mut connections = vec![[1, left, 2, 0], [1, right, 2, 1]];
    for (inlet, value) in inlets.iter().enumerate() {
        boxes.push(format!("r t-in{inlet}"));
        boxes.push(format!("sig~ {value}"));
        connections.push([boxes.len() - 2, 0, boxes.len() - 1, 0]);
        connections.push([boxes.len() - 1, 0, 1, inlet]);
    }
    with_patch(pd, dir, &boxes, &connections, |pd| {
        ramp_sample(pd, SAMPLE_RATE);
        measure(pd)
    })
}

/// The Sample Player's inlets: trigger, pitch, then the inputs of Tune, Start and Length.
const PLAYER: [f32; 5] = [0.0, 60.0, 1.0, 1.0, 1.0];
const OUT: usize = 0;
const POSITION: usize = 1;
const PLAYING: usize = 2;

fn with_player<T>(pd: &mut Pd, dir: &Path, right: usize, measure: impl FnOnce(&mut Pd) -> T) -> T {
    with_sample_module(pd, dir, "ge-sample-player", &PLAYER, OUT, right, |pd| {
        set(pd, &[("t1-tune", 0.0), ("t1-start", 0.0), ("t1-length", 1.0), ("t1-mode", 0.0), ("t1-direction", 0.0)]);
        // The knobs reach their values through a 20 ms ramp.
        render(pd, 4410);
        measure(pd)
    })
}

/// The index of the sample the ramp says was read.
fn place(value: f32) -> f32 {
    value * SIZE as f32
}

fn sample_player(pd: &mut Pd, dir: &Path) {
    // Before the first trigger: silence, not playing, and the position at the start.
    with_player(pd, dir, POSITION, |pd| {
        let (out, position) = render(pd, 8820);
        assert_eq!(out.iter().fold(0.0f32, |m, v| m.max(v.abs())), 0.0, "silent before its first trigger");
        assert_eq!(position.iter().fold(0.0f32, |m, v| m.max(v.abs())), 0.0, "and at the start");
    });

    // At middle C the sample comes out as it is: sample k of the output is sample k of the table.
    with_player(pd, dir, POSITION, |pd| {
        pd.send_float("t-in0", 1.0);
        let (out, position) = render(pd, SIZE * 2);
        for k in [100, 1000, 2205, 4000, SIZE - 100] {
            close(place(out[k]), k as f32, 0.02, &format!("at middle C, output sample {k} is sample {k} of the table"));
            close(place(position[k]), k as f32, 0.02, &format!("and Position says so at {k}"));
        }
        // 2 ms of fade at each end.
        close(out[0], 0.0, 1e-6, "it starts from silence");
        assert!(out[44] < 0.6 * 44.0 / SIZE as f32, "and fades in: {} at sample 44", out[44]);
        close(place(out[SIZE - 44]) / (SIZE - 44) as f32, 0.5, 0.02, "it fades out at the end");
        // Once: after one pass it is silent, with the position left at the end.
        assert!(out[SIZE + 2..].iter().all(|v| *v == 0.0), "silent after the end");
        close(position[SIZE + 500], 1.0, 1e-6, "the position rests at the end");
    });

    // Playing: on from the trigger to the end of the pass, whatever the trigger does meanwhile.
    with_player(pd, dir, PLAYING, |pd| {
        let (_, before) = render(pd, 64);
        assert!(before.iter().all(|v| *v == 0.0), "not playing before the trigger");
        pd.send_float("t-in0", 1.0);
        let (_, first) = render(pd, 2048);
        pd.send_float("t-in0", 0.0);
        let (_, rest) = render(pd, SIZE);
        let playing: Vec<f32> = first.into_iter().chain(rest).collect();
        assert!(playing[..SIZE - 1].iter().all(|v| *v == 1.0), "playing until the end, with the key up from sample 2048");
        assert!(playing[SIZE + 1..].iter().all(|v| *v == 0.0), "and not after it");
    });

    // An octave up takes half the time and reads every other sample; a fifth below takes half as long again.
    with_player(pd, dir, PLAYING, |pd| {
        set(pd, &[("t-in1", 72.0), ("t-in0", 1.0)]);
        let (out, playing) = render(pd, SIZE);
        for k in [100, 1000, 2000] {
            close(place(out[k]), 2.0 * k as f32, 0.05, &format!("an octave up, output sample {k} is sample {} of the table", 2 * k));
        }
        let length = playing.iter().filter(|v| **v > 0.5).count();
        close(length as f32, SIZE as f32 / 2.0, 2.0, "and it plays for half as long");
    });
    with_player(pd, dir, PLAYING, |pd| {
        // Tune is the knob in semitones times its input.
        set(pd, &[("t1-tune", -14.0), ("t-in2", 0.5)]);
        render(pd, 4410);
        pd.send_float("t-in0", 1.0);
        let (out, _) = render(pd, SIZE);
        let speed = 2f32.powf(-7.0 / 12.0);
        close(place(out[2000]), 2000.0 * speed, 0.2, "seven semitones down reads at 0.667 of the speed");
    });

    // A sample recorded at another rate than Pd runs at plays at its own speed.
    with_player(pd, dir, OUT, |pd| {
        ramp_sample(pd, SAMPLE_RATE / 2.0);
        pd.send_float("t-in0", 1.0);
        let (out, _) = render(pd, SIZE);
        close(place(out[3000]), 1500.0, 0.05, "a sample at half Pd's rate is read at half speed");
    });

    // Start and Length choose the part: from a quarter in, for half the sample.
    with_player(pd, dir, PLAYING, |pd| {
        set(pd, &[("t1-start", 0.5), ("t-in3", 0.5), ("t1-length", 0.5)]);
        render(pd, 4410);
        pd.send_float("t-in0", 1.0);
        let (out, playing) = render(pd, SIZE);
        let from = SIZE as f32 / 4.0;
        for k in [100, 1000, 2000] {
            close(place(out[k]), from + k as f32, 0.05, &format!("from a quarter in, output sample {k}"));
        }
        close(playing.iter().filter(|v| **v > 0.5).count() as f32, SIZE as f32 / 2.0, 2.0, "for half the sample");
    });
    // A window that would run past the end stops there.
    with_player(pd, dir, PLAYING, |pd| {
        set(pd, &[("t1-start", 0.75)]);
        render(pd, 4410);
        pd.send_float("t-in0", 1.0);
        let (out, playing) = render(pd, SIZE);
        close(place(out[500]), 0.75 * SIZE as f32 + 500.0, 0.05, "from three quarters in");
        close(playing.iter().filter(|v| **v > 0.5).count() as f32, SIZE as f32 / 4.0, 2.0, "to the end of the sample and no further");
    });

    // Reverse reads from the end of the window back to its start.
    with_player(pd, dir, POSITION, |pd| {
        set(pd, &[("t1-direction", 1.0), ("t-in0", 1.0)]);
        let (out, position) = render(pd, SIZE * 2);
        for k in [100, 1000, 4000] {
            close(place(out[k]), (SIZE - k) as f32, 0.05, &format!("in reverse, output sample {k}"));
        }
        close(position[SIZE + 500], 0.0, 1e-6, "and rests at the start");
    });

    // Loop goes round: the same sound again a pass later, and no jump at the seam.
    with_player(pd, dir, PLAYING, |pd| {
        set(pd, &[("t1-mode", 1.0), ("t-in0", 1.0)]);
        let (out, playing) = render(pd, SIZE * 3);
        for k in [1000, 3000] {
            close(place(out[k + SIZE]), k as f32, 0.05, &format!("the second pass reads sample {k} again"));
            close(place(out[k + 2 * SIZE]), k as f32, 0.1, "and the third");
        }
        let jump = out.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(jump < 0.02, "the loop point is faded, largest step {jump}");
        assert!(playing.iter().all(|v| *v == 1.0), "in Loop it is playing while the trigger is on");
        pd.send_float("t-in0", 0.0);
        let (still, playing) = render(pd, SIZE);
        assert!(playing[1..].iter().all(|v| *v == 0.0), "and not once the trigger is off");
        assert!(still.iter().any(|v| *v > 0.5), "though the sample goes round for as long as the voice is heard");
    });

    // A new trigger starts again from the beginning, wherever it had got to.
    with_player(pd, dir, OUT, |pd| {
        pd.send_float("t-in0", 1.0);
        render(pd, 1024);
        pd.send_float("t-in0", 0.0);
        render(pd, 64);
        pd.send_float("t-in0", 1.0);
        let (out, _) = render(pd, SIZE * 2);
        for k in [100, 2000, 4000] {
            close(place(out[k]), k as f32, 0.02, &format!("after a second trigger, output sample {k}"));
        }
        assert!(out[SIZE + 2..].iter().all(|v| *v == 0.0), "and it still ends after one pass");
    });
}

fn play_head(pd: &mut Pd, dir: &Path) {
    // Inlets: the inputs of Position and Start.
    with_sample_module(pd, dir, "ge-sample-head", &[1.0, 1.0], 0, 0, |pd| {
        for (position, start, expected) in [(0.25, 0.0, 0.25), (0.5, 0.25, 0.75), (0.75, 0.5, 0.25)] {
            set(pd, &[("t1-position", position), ("t1-start", start)]);
            render(pd, 4410);
            let (out, _) = render(pd, 64);
            close(out[63], expected, 1e-3, &format!("position {position} from start {start} reads the sample at {expected}"));
        }
        // The position is the knob times what is patched in.
        set(pd, &[("t1-position", 1.0), ("t1-start", 0.0), ("t-in0", 0.4)]);
        render(pd, 4410);
        close(render(pd, 64).0[63], 0.4, 1e-3, "the knob at 1 with 0.4 patched in");
    });
}

/// A 16-bit mono WAV of a ramp, as the editor writes them.
fn wav(rate: u32, samples: &[i16]) -> Vec<u8> {
    let data = samples.len() as u32 * 2;
    let mut bytes = Vec::new();
    bytes.extend(b"RIFF");
    bytes.extend((36 + data).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(1u16.to_le_bytes());
    bytes.extend(rate.to_le_bytes());
    bytes.extend((rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(data.to_le_bytes());
    for sample in samples {
        bytes.extend(sample.to_le_bytes());
    }
    bytes
}

/// What a slot helper tells the modules when the patch loads: the rate, then the size.
fn told(pd: &mut Pd, events: &std::sync::mpsc::Receiver<PdEvent>, slot: usize) -> Vec<(String, f32)> {
    render(pd, 64);
    let prefix = format!("ge-sample-{slot}-");
    events
        .try_iter()
        .filter_map(|event| match event {
            PdEvent::Message { recv, atoms } if recv.starts_with(&prefix) => match atoms.as_slice() {
                [Atom::Float(value)] => Some((recv[prefix.len()..].to_string(), *value)),
                _ => None,
            },
            PdEvent::Print(text) => panic!("Pd printed {text:?}"),
            _ => None,
        })
        .collect()
}

fn slots(pd: &mut Pd, dir: &Path, events: &std::sync::mpsc::Receiver<PdEvent>) {
    let listening: Vec<_> = ["ge-sample-3-rate", "ge-sample-3-size"].iter().map(|name| pd.bind(name)).collect();

    // A tape: so many seconds at Pd's rate, in whole blocks, and silent.
    for (seconds, size) in [(1.0, 44096), (0.25, 11008), (0.0, 64)] {
        with_patch(pd, dir, &[format!("ge-sample-tape 3 {seconds}")], &[], |pd| {
            assert_eq!(told(pd, events, 3), [("rate".to_string(), SAMPLE_RATE), ("size".to_string(), size as f32)], "a tape of {seconds} s");
            let table = pd.read_array("ge-sample-3").expect("the tape has a table");
            assert_eq!(table.len(), size, "which is {size} samples long");
            assert!(table.iter().all(|v| *v == 0.0), "and silent");
            assert_eq!(size % 64, 0, "in whole blocks");
        });
    }

    // A sound file: its samples, its length and its own rate.
    let ramp: Vec<i16> = (0..3000).map(|i| (i * 10) as i16).collect();
    fs::write(dir.join("ge-sample-d.wav"), wav(22_050, &ramp)).unwrap();
    with_patch(pd, dir, &["ge-sample-file 3 ge-sample-d.wav".to_string()], &[], |pd| {
        assert_eq!(told(pd, events, 3), [("rate".to_string(), 22_050.0), ("size".to_string(), 3000.0)], "a sound file");
        let table = pd.read_array("ge-sample-3").expect("the file has a table");
        assert_eq!(table.len(), 3000);
        for i in [0, 1, 1500, 2999] {
            close(table[i], ramp[i] as f32 / 32768.0, 1e-6, &format!("sample {i} of the file"));
        }
    });
    for binding in listening {
        pd.unbind(binding);
    }
}

#[test]
fn sample_modules_do_what_they_are_designed_to() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = bench();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE as u32).unwrap();
    pd.dsp(true);
    events.try_iter().for_each(drop);

    slots(&mut pd, &dir, &events);
    sample_player(&mut pd, &dir);
    play_head(&mut pd, &dir);

    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
