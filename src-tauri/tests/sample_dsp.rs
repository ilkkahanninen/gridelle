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

/// A test patch with a tape in slot 0 of `seconds`, a Recorder on it fed with noise, and
/// more boxes after those. Box 1 is the Recorder and box 2 the noise; the left channel is
/// outlet `left` of the Recorder unless `more` connects something else to box 3, the
/// `dac~`, and the right channel is the noise, so that a test knows what went in.
fn with_recorder<T>(pd: &mut Pd, dir: &Path, seconds: f32, left: Option<usize>, more: &[&str], wires: &[[usize; 4]], measure: impl FnOnce(&mut Pd) -> T) -> T {
    let mut boxes: Vec<String> = vec![
        format!("ge-sample-tape 0 {seconds}"),
        "ge-sample-recorder t1 0".into(),
        "noise~".into(),
        "dac~ 1 2".into(),
        // The inputs of Record and Overdub, as the compiler holds them with nothing patched in.
        "r t-in1".into(),
        "sig~ 1".into(),
        "r t-in2".into(),
        "sig~ 1".into(),
    ];
    let mut connections = vec![[2, 0, 3, 1], [4, 0, 5, 0], [5, 0, 1, 1], [6, 0, 7, 0], [7, 0, 1, 2]];
    if let Some(outlet) = left {
        connections.push([1, outlet, 3, 0]);
    }
    boxes.extend(more.iter().map(|b| b.to_string()));
    connections.extend(wires);
    with_patch(pd, dir, &boxes, &connections, |pd| {
        set(pd, &[("t1-record", 1.0), ("t1-overdub", 0.0), ("t1-mode", 0.0)]);
        measure(pd)
    })
}

/// The noise straight into the Recorder.
const NOISE_IN: [usize; 4] = [2, 0, 1, 0];
const BLOCK: usize = 64;
/// A tape of a tenth of a second: 69 blocks.
const TAPE: usize = 69 * BLOCK;

fn tape(pd: &mut Pd) -> Vec<f32> {
    pd.read_array("ge-sample-0").expect("the tape has a table")
}

fn recorder(pd: &mut Pd, dir: &Path) {
    // The tape starts at the second block the patch runs, and from then on what goes in
    // is on the tape at the place it went in, lap after lap.
    with_recorder(pd, dir, 0.1, Some(0), &[], &[NOISE_IN], |pd| {
        assert_eq!(tape(pd).len(), TAPE);
        let (out, input) = render(pd, BLOCK + 3 * TAPE);
        let lap = |n: usize| &input[BLOCK + n * TAPE..BLOCK + (n + 1) * TAPE];
        let on_tape = tape(pd);
        for i in [0, 1, 63, 64, 1000, TAPE - 1] {
            // (The switch is a smoothed 1 that settles a few millionths short of it.)
            close(on_tape[i], lap(2)[i], 1e-5, &format!("sample {i} of the third lap is at place {i} of the tape"));
        }
        // Out is the tape as it passes: what was written a lap ago.
        let third = &out[BLOCK + 2 * TAPE..];
        for i in [0, 500, 2000, TAPE - 1] {
            close(third[i], lap(1)[i], 1e-5, &format!("Out in the third lap is the second lap, at {i}"));
        }
    });

    // Position runs from 0 to 1 over a lap, exactly.
    with_recorder(pd, dir, 0.1, Some(1), &[], &[NOISE_IN], |pd| {
        let (position, _) = render(pd, BLOCK + 2 * TAPE);
        for (at, place) in [(BLOCK, 0), (BLOCK + 1, 1), (BLOCK + 1000, 1000), (BLOCK + TAPE - 1, TAPE - 1), (BLOCK + TAPE, 0), (BLOCK + TAPE + 77, 77)] {
            close(position[at] * TAPE as f32, place as f32, 1e-3, &format!("the position at sample {at}"));
        }
    });

    // With Record off the tape goes round untouched, bit for bit, however long.
    with_recorder(pd, dir, 0.1, Some(0), &[], &[NOISE_IN], |pd| {
        render(pd, BLOCK + 2 * TAPE);
        pd.send_float("t1-record", 0.0);
        // The switch is a fade of a few milliseconds, during which a little more is written.
        render(pd, 2 * TAPE);
        let before = tape(pd);
        assert!(before.iter().any(|v| v.abs() > 0.1), "there is a recording on the tape");
        let (out, _) = render(pd, 50 * TAPE);
        assert_eq!(tape(pd), before, "fifty laps later the tape is the same, bit for bit");
        assert_eq!(&out[out.len() - TAPE..], &before[..], "and Out plays it");
        // A gate patched into Record does the same as the knob: 1 x 0 is off, 1 x 1 is on.
        set(pd, &[("t1-record", 1.0), ("t-in1", 0.0)]);
        render(pd, 4 * TAPE);
        assert_eq!(tape(pd), before, "the knob on and the input at 0 does not record");
        pd.send_float("t-in1", 1.0);
        render(pd, 2 * TAPE);
        assert_ne!(tape(pd), before, "the input at 1 does");
    });

    // Overdub keeps the old sound under the new: all of it at 1, half at 0.5.
    for overdub in [1.0, 0.5] {
        with_recorder(pd, dir, 0.1, Some(0), &[], &[NOISE_IN], |pd| {
            pd.send_float("t1-overdub", overdub);
            let (_, input) = render(pd, BLOCK + 3 * TAPE);
            let lap = |n: usize| &input[BLOCK + n * TAPE..BLOCK + (n + 1) * TAPE];
            let on_tape = tape(pd);
            for i in [1000, 3000, TAPE - 1] {
                // (From place 1000 on, the first lap too was recorded with the switch fully on.)
                let expected = lap(2)[i] + overdub * (lap(1)[i] + overdub * lap(0)[i]);
                close(on_tape[i], expected, 1e-4, &format!("with Overdub at {overdub}, place {i} holds the laps added up"));
            }
        });
    }

    // The laps stay in step with the count of blocks: after thousands of them, a tape of
    // one block and one of three still hold exactly the last of what went in.
    for (seconds, blocks) in [(0.0, 1), (0.004, 3)] {
        with_recorder(pd, dir, seconds, Some(0), &[], &[NOISE_IN], |pd| {
            let size = blocks * BLOCK;
            assert_eq!(tape(pd).len(), size);
            let (_, input) = render(pd, BLOCK + 3000 * size);
            let worst = tape(pd).iter().zip(&input[input.len() - size..]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-5, "a tape of {blocks} blocks after 3000 laps holds the last lap, worst difference {worst}");
        });
    }

    // Once: a rise of Record goes back to the start and records one lap, then no more.
    with_recorder(pd, dir, 0.1, Some(1), &[], &[NOISE_IN], |pd| {
        set(pd, &[("t1-mode", 1.0), ("t1-record", 0.0)]);
        render(pd, BLOCK + TAPE + 640);
        let before = tape(pd);
        pd.send_float("t1-record", 1.0);
        // The knob reaches a half 10 ms after it is turned; the lap starts at a block after that.
        let (position, input) = render(pd, 3 * TAPE);
        let start = (1..position.len()).find(|&n| position[n] < position[n - 1]).expect("the tape goes back to its start");
        assert!(start < 1024 && start % BLOCK == 0, "at the start of a block soon after the rise, at sample {start}");
        let on_tape = tape(pd);
        assert_ne!(on_tape, before, "it has recorded");
        for i in [1000, 3000, TAPE - 1] {
            close(on_tape[i], input[start + i], 1e-4, &format!("the lap from the rise is on the tape, at {i}"));
        }
        render(pd, 10 * TAPE);
        assert_eq!(tape(pd), on_tape, "and nothing after that lap, with Record still on");
    });
}

/// How long a signal takes through the test patch, found by matching what comes out with
/// what went in: the lag of `out` behind `input`, in samples, up to `most`.
fn lag(out: &[f32], input: &[f32], most: usize) -> usize {
    let from = most + 2000;
    (0..=most)
        .min_by(|a, b| {
            let error = |lag: usize| (from..from + 500).map(|n| (out[n] - input[n - lag]).abs()).sum::<f32>();
            error(*a).partial_cmp(&error(*b)).unwrap()
        })
        .unwrap()
}

fn tape_head(pd: &mut Pd, dir: &Path) {
    // Box 8 is the head, on the left channel; boxes 9 and 10 hold the input of Delay at 1.
    let head = ["ge-tape-head t2 0", "r t-in0", "sig~ 1"];
    let wires = [[8, 0, 3, 0], [9, 0, 10, 0], [10, 0, 8, 0]];
    with_recorder(pd, dir, 0.1, None, &head, &[NOISE_IN, wires[0], wires[1], wires[2]], |pd| {
        // What went in comes out Delay later, give or take the blocks the place of the
        // recording takes to reach the head: none, one or two, always the same in a patch.
        pd.send_float("t2-delay", 20.0);
        render(pd, 8820);
        let (out, input) = render(pd, 5 * TAPE);
        let delay = lag(&out, &input, 2000);
        let extra = delay as i64 - 882;
        assert!([0, 64, 128].contains(&extra), "20 ms is 882 samples, plus 0, 64 or 128: got {delay}");
        // Sample for sample, through every wrap of the tape in five laps.
        let worst = (2000..out.len()).map(|n| (out[n] - input[n - delay]).abs()).fold(0.0f32, f32::max);
        assert!(worst < 1e-5, "the head plays what went in {delay} samples before, worst difference {worst}");

        // A delay between two samples is the two blended: 20.01 ms is 882.441 samples.
        pd.send_float("t2-delay", 20.01);
        render(pd, 8820);
        let (out, input) = render(pd, 3 * TAPE);
        let (whole, part) = (delay, 0.441);
        let worst = (2000..out.len())
            .map(|n| (out[n] - (input[n - whole] * (1.0 - part) + input[n - whole - 1] * part)).abs())
            .fold(0.0f32, f32::max);
        assert!(worst < 2e-3, "a delay of 882.441 samples blends its two neighbours, worst difference {worst}");

        // Delay is the knob times its input, and stays on the tape: at least a block, at most
        // the tape less four blocks.
        set(pd, &[("t2-delay", 40.0), ("t-in0", 0.5)]);
        render(pd, 8820);
        let (out, input) = render(pd, 3 * TAPE);
        assert_eq!(lag(&out, &input, 2000), delay, "40 ms at half is 20 ms");
        set(pd, &[("t2-delay", 2.0), ("t-in0", 0.1)]);
        render(pd, 8820);
        let (out, input) = render(pd, 3 * TAPE);
        assert_eq!(lag(&out, &input, 2000) as i64 - extra, 64, "the shortest delay is a block");
        set(pd, &[("t2-delay", 5000.0), ("t-in0", 1.0)]);
        render(pd, 8820);
        let (out, input) = render(pd, 3 * TAPE);
        assert_eq!(lag(&out, &input, TAPE) as i64 - extra, (TAPE - 256) as i64, "the longest is the tape less four blocks");
    });

    // An echo: the head patched back into the Recorder at half level. A click goes in once
    // and comes back every Delay, each time at half the level.
    let echo = ["ge-tape-head t2 0", "r t-in0", "sig~ 1", "*~ 0.5", "+~", "r t-click", "vline~"];
    let wires = [[8, 0, 3, 0], [9, 0, 10, 0], [10, 0, 8, 0], [8, 0, 11, 0], [11, 0, 12, 1], [13, 0, 14, 0], [14, 0, 12, 0], [12, 0, 1, 0]];
    with_recorder(pd, dir, 0.5, None, &echo, &wires, |pd| {
        pd.send_float("t2-delay", 50.0);
        render(pd, 22050);
        // One sample at 1.
        pd.send_message("t-click", "list", &[Atom::Float(1.0), Atom::Float(0.0), Atom::Float(0.0)]);
        pd.send_message("t-click", "list", &[Atom::Float(0.0), Atom::Float(0.0), Atom::Float(1000.0 / SAMPLE_RATE)]);
        let (out, _) = render(pd, 22050);
        let clicks: Vec<(usize, f32)> = out.iter().enumerate().filter(|(_, v)| v.abs() > 0.01).map(|(n, v)| (n, *v)).collect();
        assert!(clicks.len() >= 5, "the click comes back again and again: {clicks:?}");
        let period = clicks[1].0 - clicks[0].0;
        assert!([2205, 2269, 2333].contains(&period), "every 50 ms, give or take the blocks of the patch: {period}");
        for (n, pair) in clicks.windows(2).enumerate().take(4) {
            assert_eq!(pair[1].0 - pair[0].0, period, "echo {n} is as far from the next as the first");
            close(pair[1].1 / pair[0].1, 0.5, 1e-4, &format!("echo {} is half the level of the one before", n + 1));
        }
        close(clicks[0].1, 1.0, 1e-4, "the first echo is the click itself");
    });
}

/// The Grains module's inlets: pitch, then the inputs of Tune, Position, Scatter, Size,
/// Density and Width.
const GRAINS: [f32; 7] = [60.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0];

/// What a test puts in the sample the grains read.
#[derive(Clone, Copy)]
enum Fill {
    Silence,
    /// Every sample 1: what comes out is then the grains' own shapes.
    Ones,
    /// From 0 at the start to 1 at the end: what comes out, over what `Ones` gives, is the place read.
    Ramp,
    /// So many cycles of a sine.
    Sine(usize),
}

/// A test patch with a tape of a tenth of a second in slot 0 (which gives the grains the
/// place of a recording to follow, as a real patch does) and a Grains module on it.
fn with_grains<T>(pd: &mut Pd, dir: &Path, fill: Fill, settings: &[(&str, f32)], measure: impl FnOnce(&mut Pd) -> T) -> T {
    let mut boxes = vec!["ge-sample-tape 0 0.1".to_string(), "ge-sample-grains t1 0".to_string(), "dac~ 1 2".to_string()];
    let mut connections = vec![[1, 0, 2, 0], [1, 1, 2, 1]];
    for (inlet, value) in GRAINS.iter().enumerate() {
        boxes.push(format!("r t-in{inlet}"));
        boxes.push(format!("sig~ {value}"));
        connections.push([boxes.len() - 2, 0, boxes.len() - 1, 0]);
        connections.push([boxes.len() - 1, 0, 1, inlet]);
    }
    with_patch(pd, dir, &boxes, &connections, |pd| {
        let table: Vec<f32> = (0..TAPE)
            .map(|i| match fill {
                Fill::Silence => 0.0,
                Fill::Ones => 1.0,
                Fill::Ramp => i as f32 / TAPE as f32,
                Fill::Sine(cycles) => (2.0 * std::f32::consts::PI * (cycles * i) as f32 / TAPE as f32).sin(),
            })
            .collect();
        assert!(pd.write_array("ge-sample-0", 0, &table));
        // No scatter and no width unless a test asks: then nothing in it is left to chance.
        let defaults = [("tune", 0.0), ("position", 0.5), ("scatter", 0.0), ("size", 80.0), ("density", 20.0), ("width", 0.0), ("from", 0.0)];
        for (name, value) in defaults {
            let value = settings.iter().find(|(n, _)| *n == name).map_or(value, |(_, v)| *v);
            pd.send_float(&format!("t1-{name}"), value);
        }
        measure(pd)
    })
}

/// The usual number of samples from one rise through zero to the next: the length of a
/// cycle of the sound inside the grains, whatever happens where one grain meets the next.
fn cycle_length(signal: &[f32]) -> f32 {
    let rises: Vec<f32> = (1..signal.len())
        .filter(|&n| signal[n - 1] < 0.0 && signal[n] >= 0.0)
        .map(|n| n as f32 - signal[n] / (signal[n] - signal[n - 1]))
        .collect();
    let mut lengths: Vec<f32> = rises.windows(2).map(|pair| pair[1] - pair[0]).collect();
    lengths.sort_by(|a, b| a.partial_cmp(b).unwrap());
    lengths[lengths.len() / 2]
}

/// Half a second for the first grains of all four streams to have started, then two seconds.
fn grains_of(pd: &mut Pd) -> (Vec<f32>, Vec<f32>) {
    render(pd, 22_050);
    render(pd, 88_200)
}

/// The place in the sample the grains read at each moment, where they sound: what comes
/// out of a ramp over what comes out of ones, with everything else the same.
fn places_read(pd: &mut Pd, dir: &Path, settings: &[(&str, f32)], input: (&str, f32)) -> Vec<f32> {
    let run = |pd: &mut Pd, fill| {
        with_grains(pd, dir, fill, settings, |pd| {
            pd.send_float(input.0, input.1);
            grains_of(pd).0
        })
    };
    let (ramp, ones) = (run(pd, Fill::Ramp), run(pd, Fill::Ones));
    ramp.iter().zip(&ones).filter(|(_, shape)| **shape > 0.2).map(|(read, shape)| read / shape).collect()
}

fn spread(values: &[f32]) -> (f32, f32) {
    values.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)))
}

fn grains(pd: &mut Pd, dir: &Path) {
    let centre = std::f32::consts::FRAC_1_SQRT_2;
    let nothing_patched = ("t-in2", 1.0);

    // Nothing in the sample, nothing out.
    with_grains(pd, dir, Fill::Silence, &[], |pd| {
        let (left, right) = grains_of(pd);
        assert!(left.iter().chain(&right).all(|v| *v == 0.0), "silent on an empty sample");
    });

    // Density is grains a second and Size how long each lasts. At 20 a second, four
    // streams make a grain each every 200 ms; grains of 200 ms then overlap four deep, and
    // four raised cosines a quarter apart add up to a steady 2, halved, and split equally
    // between left and right.
    with_grains(pd, dir, Fill::Ones, &[("size", 200.0)], |pd| {
        let (left, right) = grains_of(pd);
        let (low, high) = spread(&left);
        assert!((low - centre).abs() < 2e-3 && (high - centre).abs() < 2e-3, "full grains overlapping are steady at 0.707: {low}..{high}");
        assert_eq!(left, right, "with no Width both sides are the same");
    });
    // Grains of 25 ms at 20 a second: one starts every 50 ms and lasts half of that.
    with_grains(pd, dir, Fill::Ones, &[("size", 25.0)], |pd| {
        let (left, _) = grains_of(pd);
        let starts = left.windows(2).filter(|w| w[0] <= 1e-4 && w[1] > 1e-4).count();
        close(starts as f32 / 2.0, 20.0, 0.5, "grains a second");
        let sounding = left.iter().filter(|v| **v > 1e-4).count() as f32 / left.len() as f32;
        close(sounding, 0.5, 0.02, "each lasts 25 of its 50 ms");
        close(spread(&left).1, 0.5 * centre, 2e-3, "and peaks at a half, split between the sides");
    });
    // A grain cannot outlast its turn: Size beyond 4 / Density is that long.
    with_grains(pd, dir, Fill::Ones, &[("size", 1000.0)], |pd| {
        let (low, high) = spread(&grains_of(pd).0);
        assert!((low - centre).abs() < 2e-3 && (high - centre).abs() < 2e-3, "Size beyond a stream's turn is a full grain: {low}..{high}");
    });

    // Pitch: middle C reads the sample as recorded, other notes and Tune faster or slower.
    // The sample is 16 cycles of a sine in its tenth of a second: 159.8 Hz as recorded.
    let recorded = 16.0 * SAMPLE_RATE / TAPE as f32;
    for (pitch, tune, tune_input, speed) in [(60.0, 0.0, 1.0, 1.0), (72.0, 0.0, 1.0, 2.0), (60.0, -14.0, 0.5, 2f32.powf(-7.0 / 12.0)), (67.0, 5.0, 1.0, 2.0)] {
        // Grains end to end, so that each is heard alone: overlapping, they would add up
        // or cancel as the pitch moves, which is the sound of grains and no measure of pitch.
        with_grains(pd, dir, Fill::Sine(16), &[("size", 50.0), ("position", 0.0), ("tune", tune)], |pd| {
            set(pd, &[("t-in0", pitch), ("t-in1", tune_input)]);
            let (left, _) = grains_of(pd);
            close(cycle_length(&left), SAMPLE_RATE / (recorded * speed), 0.5, &format!("the length of a cycle at note {pitch} with Tune {tune} x {tune_input}"));
        });
    }

    // Position is where the grains start, 0 to 1 through the sample. A 10 ms grain reads on
    // through a tenth of this sample, so what it reads lies between Position and that further.
    for (position, input, from) in [(0.2, 1.0, 0.2), (0.6, 1.0, 0.6), (0.8, 0.5, 0.4)] {
        let read = places_read(pd, dir, &[("size", 10.0), ("position", position)], ("t-in2", input));
        let (low, high) = spread(&read);
        assert!(low > from + 0.01 && high < from + 0.09, "Position {position} x {input}: grains read from {from} on, got {low}..{high}");
    }
    // Scatter spreads the starts either side of Position, by half of it each way.
    let read = places_read(pd, dir, &[("size", 10.0), ("position", 0.5), ("scatter", 0.6)], nothing_patched);
    let (low, high) = spread(&read);
    assert!(low < 0.32 && high > 0.78, "Scatter 0.6 around 0.5 reaches towards 0.2 and 0.8 (and a grain's length on): {low}..{high}");
    assert!(low > 0.19 && high < 0.91, "and no further: {low}..{high}");

    // Width spreads the grains between the sides, each at the same power wherever it lands.
    with_grains(pd, dir, Fill::Ones, &[("size", 25.0), ("width", 1.0)], |pd| {
        let (left, right) = grains_of(pd);
        let tops: Vec<(f32, f32)> = (1..left.len() - 1)
            .filter(|&n| left[n] + right[n] > 0.3 && left[n] + right[n] >= left[n - 1] + right[n - 1] && left[n] + right[n] > left[n + 1] + right[n + 1])
            .map(|n| (left[n], right[n]))
            .collect();
        assert!(tops.len() > 30, "grains to look at: {}", tops.len());
        for (l, r) in &tops {
            close((l * l + r * r).sqrt(), 0.5, 5e-3, "a grain has the same power wherever it is panned");
        }
        let (leftmost, rightmost) = spread(&tops.iter().map(|(l, r)| r - l).collect::<Vec<_>>());
        assert!(leftmost < -0.25 && rightmost > 0.25, "with Width at 1 grains land on both sides: {leftmost}..{rightmost}");
    });
}

/// Grains that follow a recording: Position is then how far behind where the Recorder is.
fn grains_behind_the_recording(pd: &mut Pd, dir: &Path) {
    // Slot 0 is a tape with a Recorder on it that is not recording, so that the ramp put
    // on the tape stays, while its place goes round. Slot 1 is all ones, read by a second
    // Grains with the same settings: what the first reads, over that, is the place it reads.
    let boxes: Vec<String> = [
        "ge-sample-tape 0 0.1",
        "ge-sample-tape 1 0.1",
        "ge-sample-recorder t2 0",
        "ge-sample-grains t1 0",
        "ge-sample-grains t3 1",
        "dac~ 1 2",
        "sig~ 60",
        "sig~ 1",
        "sig~ 0",
    ]
    .iter()
    .map(|b| b.to_string())
    .collect();
    let mut connections = vec![[3, 0, 5, 0], [4, 0, 5, 1], [8, 0, 2, 1], [7, 0, 2, 2]];
    for grains in [3, 4] {
        connections.push([6, 0, grains, 0]);
        connections.extend((1..7).map(|inlet| [7, 0, grains, inlet]));
    }
    with_patch(pd, dir, &boxes, &connections, |pd| {
        let ramp: Vec<f32> = (0..TAPE).map(|i| i as f32 / TAPE as f32).collect();
        assert!(pd.write_array("ge-sample-0", 0, &ramp) && pd.write_array("ge-sample-1", 0, &vec![1.0; TAPE]));
        for module in ["t1", "t3"] {
            set(pd, &[(&format!("{module}-tune"), 0.0), (&format!("{module}-position"), 0.25), (&format!("{module}-scatter"), 0.0)]);
            set(pd, &[(&format!("{module}-size"), 20.0), (&format!("{module}-density"), 20.0), (&format!("{module}-width"), 0.0)]);
        }
        set(pd, &[("t1-from", 1.0), ("t3-from", 0.0), ("t2-record", 0.0), ("t2-overdub", 0.0), ("t2-mode", 0.0)]);
        let start = 22_080;
        render(pd, start);
        let (read, shape) = render(pd, 88_200);
        assert_eq!(pd.read_array("ge-sample-0").unwrap(), ramp, "the tape was not recorded on");
        // The Recorder is at place (n - 64) of its lap at sample n. A quarter of the tape
        // behind that, and reading on at the tape's own speed, a grain stays a quarter behind.
        let mut worst = 0.0f32;
        let mut looked_at = 0;
        for n in 0..read.len() {
            let recording = ((start + n - BLOCK) % TAPE) as f32 / TAPE as f32;
            let expected = (recording - 0.25).rem_euclid(1.0);
            // Where the grain sounds, and away from where the ramp jumps from its end to its start.
            if shape[n] > 0.2 && expected > 0.06 && expected < 0.94 {
                worst = worst.max((read[n] / shape[n] - expected).abs());
                looked_at += 1;
            }
        }
        assert!(looked_at > 10_000, "enough of the grains were looked at: {looked_at}");
        // The place of the recording reaches the grains up to two blocks late: 128 / 4416.
        assert!(worst < 0.035, "grains read a quarter of the tape behind the recording, worst difference {worst}");
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
    recorder(&mut pd, &dir);
    tape_head(&mut pd, &dir);
    grains(&mut pd, &dir);
    grains_behind_the_recording(&mut pd, &dir);

    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
