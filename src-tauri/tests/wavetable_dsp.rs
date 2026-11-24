//! Plays the Wavetable oscillator in real Pd on tables whose harmonics are known, and
//! measures what comes out: every harmonic at its level across the keyboard, how much
//! there is between the harmonics (what folded back, and what reading the table adds),
//! the fade from frame to frame, and the places where the reading could go wrong: the
//! change of level in a glide, the last frame of a full table, the first block.

use std::f64::consts::PI;
use std::fs;
use std::path::{Path, PathBuf};

use gridelle_lib::engine::pd::{Pd, PdEvent};
use gridelle_lib::samples::{wav_bytes, Sound};
use gridelle_lib::wavetable::{self, Cycle, HARMONICS, LENGTHS, LEVELS, RECORD};

const SAMPLE_RATE: f32 = 44_100.0;

/// A folder holding the abstractions, where test patches can be written next to them.
fn bench() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gridelle-wavetable-dsp-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules");
    for entry in fs::read_dir(modules).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    dir
}

/// Boxes of the test patch, by number.
const WOBBLE: usize = 15;
const OSCILLATOR: usize = 16;

/// The oscillator `t1` on sample slot 0, which holds the wavetable of `frames`, or a bare
/// table of nothing when there are none. Its pitch is a `[sig~]` that `t-pitch` sets, plus
/// a `[line~]` for glides (`t-glide`), plus an octave: an oscillator plays the note it is
/// given an octave down, so that the notes here are the notes heard; the inputs of Tune, Fine tune and Position are
/// `[sig~ 1]`s (`t-in1` to `t-in3`), as the compiler gives an input with no cable;
/// Position modulation is a `[sig~]` (`t-scan`) plus a 100 Hz sine at the level
/// `t-wobble`; Modulation is a `[sig~]` (`t-mod`).
fn with_oscillator<T>(pd: &mut Pd, dir: &Path, frames: &[Cycle], measure: impl FnOnce(&mut Pd) -> T) -> T {
    let table = if frames.is_empty() {
        "table ge-wave-0 64"
    } else {
        let sound = Sound { rate: wavetable::FILE_RATE, samples: wavetable::table(frames) };
        fs::write(dir.join("ge-wave-a.wav"), wav_bytes(&sound)).unwrap();
        "ge-wave-file 0 ge-wave-a.wav"
    };
    let boxes = [
        table, "r t-pitch", "sig~ 60", "r t-in1", "sig~ 1", "r t-in2", "sig~ 1", "r t-in3", "sig~ 1", "r t-scan", "sig~ 0", "r t-mod", "sig~ 0",
        "osc~ 100", "r t-wobble", "*~ 0", "ge-osc-wavetable t1 0", "dac~ 1", "r t-glide", "line~", "+~ 12",
    ];
    let connections = [
        [1, 0, 2, 0], [2, 0, 20, 0], [18, 0, 19, 0], [19, 0, 20, 0], [20, 0, OSCILLATOR, 0],
        [3, 0, 4, 0], [4, 0, OSCILLATOR, 1], [5, 0, 6, 0], [6, 0, OSCILLATOR, 2], [7, 0, 8, 0], [8, 0, OSCILLATOR, 3],
        [9, 0, 10, 0], [10, 0, OSCILLATOR, 4], [13, 0, WOBBLE, 0], [14, 0, WOBBLE, 1], [WOBBLE, 0, OSCILLATOR, 4],
        [11, 0, 12, 0], [12, 0, OSCILLATOR, 5], [OSCILLATOR, 0, 17, 0],
    ];
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
    for (setting, value) in [("tune", 0.0), ("fine", 0.0), ("position", 0.0), ("depth", 0.0), ("mode", 0.0)] {
        pd.send_float(&format!("t1-{setting}"), value);
    }
    let result = measure(pd);
    pd.close(patch);
    result
}

/// Render `samples` (rounded up to whole blocks) of the left channel.
fn render(pd: &mut Pd, samples: usize) -> Vec<f32> {
    let blocks = samples.div_ceil(Pd::block_size());
    let mut out = vec![0.0f32; Pd::block_size() * 2 * blocks];
    pd.process(&mut out);
    out.chunks(2).map(|frame| frame[0]).collect()
}

/// Let the settings' ramps finish, then render `samples`.
fn settled(pd: &mut Pd, samples: usize) -> Vec<f32> {
    render(pd, 4410);
    render(pd, samples)
}

fn note_hz(note: f32) -> f32 {
    440.0 * 2f32.powf((note - 69.0) / 12.0)
}

fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-30).log10()
}

/// The level of the sine at `hz` in a signal, under a window that keeps the tones beside it out.
fn amplitude_at(signal: &[f32], hz: f32) -> f32 {
    let n = signal.len() as f64;
    let (mut re, mut im, mut weight) = (0.0f64, 0.0f64, 0.0f64);
    for (i, sample) in signal.iter().enumerate() {
        let window = 0.5 - 0.5 * (2.0 * PI * i as f64 / n).cos();
        let phase = 2.0 * PI * hz as f64 * i as f64 / SAMPLE_RATE as f64;
        re += window * *sample as f64 * phase.cos();
        im += window * *sample as f64 * phase.sin();
        weight += window;
    }
    (2.0 * (re * re + im * im).sqrt() / weight) as f32
}

/// How much of a tone at `hz` is not the tone: the power between its harmonics, below 16 kHz,
/// against all of its power, in dB. What folds back from above half the rate lands there,
/// and so does whatever reading the table adds.
fn between_harmonics(signal: &[f32], hz: f32) -> f64 {
    const N: usize = 65_536;
    assert!(signal.len() >= N);
    let mut re: Vec<f64> = (0..N)
        .map(|i| {
            // Blackman-Harris: what a tone leaks beside itself is 92 dB down.
            let x = 2.0 * PI * i as f64 / N as f64;
            signal[i] as f64 * (0.35875 - 0.48829 * x.cos() + 0.14128 * (2.0 * x).cos() - 0.01168 * (3.0 * x).cos())
        })
        .collect();
    let mut im = vec![0.0; N];
    wavetable::fft(&mut re, &mut im, false);
    let bin = SAMPLE_RATE as f64 / N as f64;
    let step = hz as f64 / bin;
    let (mut all, mut rest) = (0.0, 0.0);
    for k in 8..N / 2 {
        let power = re[k] * re[k] + im[k] * im[k];
        all += power;
        let from_harmonic = (k as f64 / step - (k as f64 / step).round()).abs() * step;
        if from_harmonic > 8.0 && (k as f64) * bin < 16_000.0 {
            rest += power;
        }
    }
    db(rest / all)
}

/// The level a tone at `hz` is read from, as the oscillator works it out.
fn level_of(hz: f32) -> usize {
    let note = 69.0 + 12.0 * (hz / 440.0).log2();
    ((note - 20.5) / 12.0).clamp(0.0, 9.5).floor() as usize
}

/// What is stored of frame `number` at `level`, as harmonics.
fn stored(table: &[f32], number: usize, level: usize) -> Cycle {
    let at = number * RECORD + wavetable::offsets()[level] + 1;
    Cycle::from_points(&table[at..at + LENGTHS[level]])
}

fn saw() -> Cycle {
    Cycle::from_sines(&(1..=HARMONICS[0]).map(|h| 1.0 / h as f64).collect::<Vec<_>>())
}

fn harmonic(number: usize) -> Cycle {
    let mut levels = vec![0.0; number];
    levels[number - 1] = 1.0;
    Cycle::from_sines(&levels)
}

/// The two messages in the oscillator's patch are the builder's lengths and starts.
fn layout_matches_the_builder() {
    let text = fs::read_to_string(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules/ge-osc-wavetable.pd")).unwrap();
    let message = |numbers: &[usize]| format!(" 0 {};", numbers.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(" "));
    assert!(text.lines().any(|line| line.starts_with("#X msg") && line.ends_with(&message(&LENGTHS))), "the lengths of the levels");
    assert!(text.lines().any(|line| line.starts_with("#X msg") && line.ends_with(&message(&wavetable::offsets()))), "the starts of the levels");
    assert!(text.contains(&format!("*~ {RECORD};")) && text.contains(&format!("/ {RECORD};")) && text.contains(&format!("+ {RECORD};")), "the length of a record");
    assert_eq!(LEVELS, 10);
}

/// A saw across the keyboard: each harmonic that fits comes out at the level it is stored
/// at, none above the ones its level has, and next to nothing between them.
fn saw_across_the_keyboard(pd: &mut Pd, dir: &Path) {
    let frames = [saw()];
    let table = wavetable::table(&frames);
    with_oscillator(pd, dir, &frames, |pd| {
        let mut report = Vec::new();
        let (mut worst_between, mut worst_level) = (f64::MIN, 0.0f32);
        for note in [24.0f32, 31.0, 32.0, 33.0, 36.0, 43.0, 45.0, 48.0, 57.0, 60.0, 69.0, 72.0, 81.0, 84.0, 93.0, 96.0, 105.0, 108.0, 117.0, 120.0, 127.0] {
            pd.send_float("t-pitch", note);
            let wave = settled(pd, 65_536);
            let hz = note_hz(note);
            let level = level_of(hz);
            let kept = stored(&table, 0, level);
            // Every harmonic below 16 kHz, above which what folds back is let be: at its
            // stored level, or absent above the level's last.
            let audible = (16_000.0 / hz) as usize;
            let mut off = 0.0f32;
            for h in 1..=audible.min(HARMONICS[0]) {
                let expected = if h <= HARMONICS[level] { kept.sin[h].hypot(kept.cos[h]) as f32 } else { 0.0 };
                let measured = amplitude_at(&wave[..44_100], hz * h as f32);
                let error = (measured - expected).abs();
                assert!(error < 0.03 * expected + 0.0003, "saw at note {note}: harmonic {h} is {measured}, stored as {expected}");
                off = off.max(error / expected.max(1e-3));
            }
            // The level is the right one: it reaches 14 kHz at least, unless the table has no more.
            let reach = HARMONICS[level] as f32 * hz;
            assert!(reach >= 13_900.0 || level == 0, "note {note}: level {level} reaches only {reach} Hz");
            assert!(reach <= 28_100.0, "note {note}: level {level} reaches {reach} Hz, which folds back below 16 kHz");
            let between = between_harmonics(&wave, hz);
            worst_between = worst_between.max(between);
            worst_level = worst_level.max(off);
            report.push(format!("{note}:{between:.0}"));
            assert!(wave.iter().all(|v| v.is_finite() && v.abs() <= 1.01), "saw at note {note} stays within -1..1");
        }
        println!("ge-osc-wavetable: a saw, dB between its harmonics below 16 kHz by note: {}", report.join(" "));
        println!("ge-osc-wavetable: harmonics within {:.2} % of what is stored; worst between them {worst_between:.1} dB", worst_level * 100.0);
        assert!(worst_between < -80.0, "what is between the harmonics stays 80 dB down, worst {worst_between:.1}");
    });
}

fn main_checks(pd: &mut Pd, dir: &Path) {
    // Two frames: the fundamental alone, and the third harmonic alone.
    let frames = [harmonic(1), harmonic(3)];
    let parts = |pd: &mut Pd| {
        let wave = settled(pd, 44_100);
        (amplitude_at(&wave, note_hz(60.0)), amplitude_at(&wave, 3.0 * note_hz(60.0)))
    };
    let near = |(first, third): (f32, f32), expected: (f32, f32), what: &str| {
        assert!((first - expected.0).abs() < 0.004 && (third - expected.1).abs() < 0.004, "{what}: expected {expected:?}, got ({first}, {third})");
    };
    with_oscillator(pd, dir, &frames, |pd| {
        // The first block after loading is already the wave, and nothing wild.
        let first = render(pd, 64);
        assert!(first.iter().all(|v| v.is_finite() && v.abs() <= 1.01), "the first block is in range: {first:?}");

        // Position goes from the first frame to the last, fading from each frame to the next.
        near(parts(pd), (1.0, 0.0), "Position 0 is the first frame");
        pd.send_float("t1-position", 1.0);
        near(parts(pd), (0.0, 1.0), "Position 1 is the last frame");
        pd.send_float("t1-position", 0.5);
        near(parts(pd), (0.5, 0.5), "Position 0.5 is half of each");
        // Its input multiplies it, and Position modulation is added.
        pd.send_float("t1-position", 1.0);
        pd.send_float("t-in3", 0.25);
        near(parts(pd), (0.75, 0.25), "Position 1 x 0.25");
        pd.send_float("t-scan", 0.5);
        near(parts(pd), (0.25, 0.75), "plus Position modulation of 0.5");
        pd.send_float("t-scan", 5.0);
        near(parts(pd), (0.0, 1.0), "the position stops at the last frame");
        pd.send_float("t-scan", -5.0);
        near(parts(pd), (1.0, 0.0), "and at the first");
        pd.send_float("t-scan", 0.0);
        pd.send_float("t-in3", 1.0);

        // The fade is per sample: a 100 Hz wobble of the position puts side bands of a
        // quarter 100 Hz either side of each frame's tone, which is left at a half.
        pd.send_float("t1-position", 0.5);
        pd.send_float("t-wobble", 0.5);
        let wave = settled(pd, 44_100);
        let hz = note_hz(60.0);
        for (tone, what) in [(hz, "the first frame"), (3.0 * hz, "the last frame")] {
            let (centre, below, above) = (amplitude_at(&wave, tone), amplitude_at(&wave, tone - 100.0), amplitude_at(&wave, tone + 100.0));
            assert!((centre - 0.5).abs() < 0.01 && (below - 0.25).abs() < 0.01 && (above - 0.25).abs() < 0.01, "{what} wobbled: {centre} with {below} and {above} beside it");
        }
        pd.send_float("t-wobble", 0.0);
        pd.send_float("t1-position", 0.0);

        // Tune and Fine tune as on the other oscillators.
        pd.send_float("t1-tune", 12.0);
        let wave = settled(pd, 44_100);
        assert!(amplitude_at(&wave, 2.0 * hz) > 0.99 && amplitude_at(&wave, hz) < 0.01, "Tune 12 is an octave up");
        pd.send_float("t1-tune", 0.0);

        // Linear FM far enough turns the frequency round: the wave is read backwards, at the same levels.
        pd.send_float("t1-depth", 1.0);
        pd.send_float("t-mod", -0.25);
        let wave = settled(pd, 44_100);
        assert!((amplitude_at(&wave, hz) - 1.0).abs() < 0.01 && wave.iter().all(|v| v.is_finite()), "a frequency below zero reads the table backwards");
        pd.send_float("t-mod", 0.0);
        pd.send_float("t1-depth", 0.0);
        println!("ge-osc-wavetable: Position fades from frame to frame, per sample; Tune and FM as on the other oscillators");
    });

    // A setting's input multiplies its knob: 0.8 x 0.5 is 0.4, sample for sample.
    let position = |pd: &mut Pd, knob: f32, input: f32| {
        with_oscillator(pd, dir, &frames, |pd| {
            pd.send_float("t1-position", knob);
            pd.send_float("t-in3", input);
            render(pd, 13_230)
        })
    };
    let (scaled, direct, untouched) = (position(pd, 0.8, 0.5), position(pd, 0.4, 1.0), position(pd, 0.8, 1.0));
    let apart = |a: &[f32], b: &[f32]| a[6615..].iter().zip(&b[6615..]).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
    assert!(apart(&scaled, &direct) < 1e-6 && apart(&scaled, &untouched) > 0.05, "Position 0.8 x 0.5 is Position 0.4");
}

/// The places where reading the table could go wrong.
fn edges(pd: &mut Pd, dir: &Path) {
    // A glide through five changes of level, on a sine: every level holds the same sine, at
    // its own length, so the sweep must stay as smooth as a sine is. One sample read from
    // the wrong place would stand out as a corner.
    with_oscillator(pd, dir, &[harmonic(1), harmonic(1)], |pd| {
        pd.send_float("t-pitch", 24.0);
        render(pd, 4410);
        pd.send_list("t-glide", &[gridelle_lib::engine::pd::Atom::Float(60.0), gridelle_lib::engine::pd::Atom::Float(1500.0)]);
        let sweep = render(pd, 66_150);
        let corner = sweep.windows(3).map(|w| (w[2] - 2.0 * w[1] + w[0]).abs()).fold(0.0f32, f32::max);
        let top = (2.0 * std::f32::consts::PI * note_hz(84.0) / SAMPLE_RATE).powi(2);
        assert!(corner < 1.3 * top, "a sine stays a sine through the changes of level: sharpest corner {corner}, a sine at the top has {top}");
        assert!((sweep.iter().fold(0.0f32, |m, v| m.max(v.abs())) - 1.0).abs() < 0.01);
        println!("ge-osc-wavetable: a glide over five levels has no corner sharper than {corner:.4} (a steady sine at its top: {top:.4})");
    });

    // A saw gliding slowly over one change of level makes no jump bigger than the saw's own.
    with_oscillator(pd, dir, &[saw()], |pd| {
        let jump = |wave: &[f32]| wave.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        pd.send_float("t-pitch", 56.0);
        let below = jump(&settled(pd, 22_050));
        pd.send_float("t-pitch", 57.0);
        let above = jump(&settled(pd, 22_050));
        pd.send_float("t-pitch", 56.0);
        render(pd, 4410);
        pd.send_list("t-glide", &[gridelle_lib::engine::pd::Atom::Float(1.0), gridelle_lib::engine::pd::Atom::Float(900.0)]);
        let across = jump(&render(pd, 44_100));
        assert!(across <= 1.15 * below.max(above), "a saw across a change of level: biggest step {across}, {below} and {above} either side");
    });

    // A full table of 64 frames: the last is read as cleanly as the first, a million points in.
    let frames: Vec<Cycle> = (0..64).map(|_| saw()).collect();
    with_oscillator(pd, dir, &frames, |pd| {
        pd.send_float("t-pitch", 38.0);
        let first = between_harmonics(&settled(pd, 65_536), note_hz(38.0));
        pd.send_float("t1-position", 1.0);
        let last = between_harmonics(&settled(pd, 65_536), note_hz(38.0));
        pd.send_float("t1-position", 0.5);
        let middle = between_harmonics(&settled(pd, 65_536), note_hz(38.0));
        assert!(last < first + 3.0 && middle < first + 3.0 && last < -70.0, "frame 64 as clean as frame 1: {first:.1} dB, {middle:.1} in the middle, {last:.1} at the end");
        println!("ge-osc-wavetable: between the harmonics of a low saw: {first:.1} dB on frame 1 of 64, {middle:.1} between 32 and 33, {last:.1} on 64");
    });

    // A single frame is played whatever the position.
    with_oscillator(pd, dir, &[saw()], |pd| {
        pd.send_float("t1-position", 0.7);
        let wave = settled(pd, 44_100);
        let expected = stored(&wavetable::table(&[saw()]), 0, level_of(note_hz(60.0))).sin[1] as f32;
        assert!((amplitude_at(&wave, note_hz(60.0)) - expected).abs() < 0.003, "one frame plays at any position");
    });

    // With no wavetable in its slot the oscillator is silent, and says nothing.
    with_oscillator(pd, dir, &[], |pd| {
        pd.send_float("t1-position", 0.5);
        let wave = settled(pd, 4410);
        assert!(wave.iter().all(|v| *v == 0.0), "no table, no sound");
    });
}

#[test]
fn the_wavetable_oscillator_does_what_it_is_designed_to() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = bench();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE as u32).unwrap();
    pd.dsp(true);
    events.try_iter().for_each(drop);

    layout_matches_the_builder();
    saw_across_the_keyboard(&mut pd, &dir);
    main_checks(&mut pd, &dir);
    edges(&mut pd, &dir);

    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
