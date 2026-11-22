//! Measures what the module abstractions in `pd-lib/modules` actually do, in real Pd:
//! oscillator pitch, level, aliasing and modulation, filter frequency responses, the
//! shapers' curves, mixer sums, the envelope's stages, the LFOs, the effects, and that every
//! setting's input multiplies its knob.
//!
//! Each check loads a few-box test patch around one abstraction and analyses the audio
//! it renders. libpd is a single global instance, so everything runs from one test.

use std::fs;
use std::path::{Path, PathBuf};

use gridelle_lib::engine::pd::Pd;

const SAMPLE_RATE: f32 = 44_100.0;

/// A folder holding the abstractions, where test patches can be written next to them.
fn bench() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("gridelle-module-dsp-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let modules = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../pd-lib/modules");
    for entry in fs::read_dir(modules).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    dir
}

/// A Pd patch from object boxes and `[source, outlet, target, inlet]` connections.
fn patch_text(boxes: &[&str], connections: &[[usize; 4]]) -> String {
    let mut text = String::from("#N canvas 0 0 600 400 12;\n");
    for (i, object) in boxes.iter().enumerate() {
        text += &format!("#X obj 30 {} {object};\n", 30 + i * 30);
    }
    for [source, outlet, target, inlet] in connections {
        text += &format!("#X connect {source} {outlet} {target} {inlet};\n");
    }
    text
}

/// Load a test patch, run `measure` with it open, and close it again.
fn with_patch<T>(pd: &mut Pd, dir: &Path, boxes: &[&str], connections: &[[usize; 4]], measure: impl FnOnce(&mut Pd) -> T) -> T {
    let file = dir.join("bench.pd");
    fs::write(&file, patch_text(boxes, connections)).unwrap();
    let patch = pd.open(&file).expect("the test patch opens");
    let result = measure(pd);
    pd.close(patch);
    result
}

/// What a test patch feeds an inlet of the module it is measuring.
#[derive(Clone, Copy)]
enum Inlet {
    /// The signal under test: a pitch for an oscillator, audio for a filter or shaper.
    Main,
    Mod,
    Pwm,
    /// The input of a setting. It gets a `[sig~ 1]` of its own, as the compiler gives one
    /// that has no cable, which the message `t-in<inlet number>` sets.
    Setting,
}

/// The inlets of a module's abstraction, left to right.
fn inlets_of(name: &str) -> &'static [Inlet] {
    use Inlet::*;
    match name {
        "ge-osc-sine" | "ge-osc-tri" | "ge-osc-saw" => &[Main, Setting, Setting, Mod],
        "ge-osc-pulse" => &[Main, Setting, Setting, Setting, Pwm, Mod],
        "ge-filter-lp" | "ge-filter-hp" | "ge-filter-bp" | "ge-filter-notch" | "ge-filter-allpass" => &[Main, Setting, Setting, Mod],
        "ge-fx-delay" | "ge-fx-chorus" | "ge-fx-phaser" | "ge-fx-reverb" => &[Main, Setting, Setting, Setting, Setting],
        "ge-shaper-soft" | "ge-shaper-fold" | "ge-shaper-cheby" => &[Main, Setting, Mod, Setting],
        "ge-shaper-hard" | "ge-shaper-rectify" => &[Main, Setting, Mod],
        "ge-shaper-crush" => &[Main, Setting, Setting, Mod],
        "ge-amp" => &[Main, Setting],
        "ge-lfo" => &[Main, Setting, Setting],
        "ge-lfo-random" => &[Setting, Setting, Setting],
        "ge-audio-out" => &[Main, Main, Setting],
        other => panic!("no inlet list for {other}"),
    }
}

/// Open a test patch around the module `name`, created as box number `boxes.len()` with the
/// argument `t1`. `main`, `modulator` and `pwm` are the boxes that feed those inlets (an
/// inlet whose box is `None` stays unconnected); `after` adds the boxes and connections
/// that take the module's output, given the module's box number.
#[allow(clippy::too_many_arguments)]
fn with_module<T>(
    pd: &mut Pd,
    dir: &Path,
    name: &str,
    boxes: &[&str],
    connections: &[[usize; 4]],
    feeds: [Option<usize>; 3],
    after: impl FnOnce(usize) -> (Vec<&'static str>, Vec<[usize; 4]>),
    measure: impl FnOnce(&mut Pd) -> T,
) -> T {
    let mut boxes: Vec<String> = boxes.iter().map(|b| b.to_string()).collect();
    let mut connections = connections.to_vec();
    let module = boxes.len();
    boxes.push(format!("{name} t1"));
    let (more, wires) = after(module);
    boxes.extend(more.iter().map(|b| b.to_string()));
    connections.extend(wires);
    let [main, modulator, pwm] = feeds;
    for (inlet, kind) in inlets_of(name).iter().enumerate() {
        let source = match kind {
            Inlet::Main => main,
            Inlet::Mod => modulator,
            Inlet::Pwm => pwm,
            Inlet::Setting => {
                boxes.push(format!("r t-in{inlet}"));
                boxes.push("sig~ 1".to_string());
                connections.push([boxes.len() - 2, 0, boxes.len() - 1, 0]);
                Some(boxes.len() - 1)
            }
        };
        if let Some(source) = source {
            connections.push([source, 0, module, inlet]);
        }
    }
    let boxes: Vec<&str> = boxes.iter().map(String::as_str).collect();
    with_patch(pd, dir, &boxes, &connections, measure)
}

/// The module's first outlet into the left channel.
fn to_left(module: usize) -> (Vec<&'static str>, Vec<[usize; 4]>) {
    (vec!["dac~ 1"], vec![[module, 0, module + 1, 0]])
}

/// Render `seconds` of audio and return the left and right channels.
fn render(pd: &mut Pd, seconds: f32) -> (Vec<f32>, Vec<f32>) {
    let blocks = (seconds * SAMPLE_RATE / Pd::block_size() as f32).ceil() as usize;
    let mut out = vec![0.0f32; Pd::block_size() * 2 * blocks];
    pd.process(&mut out);
    out.chunks(2).map(|frame| (frame[0], frame[1])).unzip()
}

/// Let parameter ramps and filters settle, then render `seconds`.
fn settled(pd: &mut Pd, seconds: f32) -> (Vec<f32>, Vec<f32>) {
    render(pd, 0.3);
    render(pd, seconds)
}

fn peak(signal: &[f32]) -> f32 {
    signal.iter().fold(0.0, |m, s| m.max(s.abs()))
}

fn mean(signal: &[f32]) -> f32 {
    signal.iter().sum::<f32>() / signal.len() as f32
}

fn rms(signal: &[f32]) -> f32 {
    (signal.iter().map(|s| s * s).sum::<f32>() / signal.len() as f32).sqrt()
}

fn db(ratio: f32) -> f32 {
    20.0 * ratio.max(1e-9).log10()
}

/// Upward zero crossings per second: the fundamental of a simple waveform.
fn frequency(signal: &[f32]) -> f32 {
    let crossings = signal.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
    crossings as f32 * SAMPLE_RATE / signal.len() as f32
}

/// Amplitude of the sine component at `hz` (single-bin Fourier analysis).
fn amplitude_at(signal: &[f32], hz: f32) -> f32 {
    let (mut re, mut im) = (0.0f64, 0.0f64);
    for (n, sample) in signal.iter().enumerate() {
        let phase = 2.0 * std::f64::consts::PI * hz as f64 * n as f64 / SAMPLE_RATE as f64;
        re += *sample as f64 * phase.cos();
        im += *sample as f64 * phase.sin();
    }
    (2.0 * (re * re + im * im).sqrt() / signal.len() as f64) as f32
}

fn note_hz(note: f32) -> f32 {
    440.0 * 2f32.powf((note - 69.0) / 12.0)
}

fn close(actual: f32, expected: f32, tolerance: f32, what: &str) {
    assert!((actual - expected).abs() <= tolerance, "{what}: expected {expected} ± {tolerance}, measured {actual}");
}

// --- oscillators ---------------------------------------------------------------------------

const LINEAR_FM: f32 = 0.0;
const EXPONENTIAL_FM: f32 = 1.0;
const AM: f32 = 2.0;

/// `[sig~ note] → [oscillator] → left`. The Mod input is fed from a `[sig~]` set through
/// `t-mod`, and the pulse's PWM input from one set through `t-pwm`. Settings start at
/// their defaults.
fn with_oscillator<T>(pd: &mut Pd, dir: &Path, name: &str, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-pitch", "sig~ 69", "r t-pwm", "sig~ 0", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0], [4, 0, 5, 0]];
    with_module(pd, dir, name, &boxes, &connections, [Some(1), Some(5), Some(3)], to_left, |pd| {
        pd.send_float("t1-tune", 0.0);
        pd.send_float("t1-fine", 0.0);
        pd.send_float("t1-width", 50.0);
        pd.send_float("t1-depth", 0.25);
        pd.send_float("t1-mode", LINEAR_FM);
        measure(pd)
    })
}

fn oscillators(pd: &mut Pd, dir: &Path) {
    for name in ["ge-osc-sine", "ge-osc-tri", "ge-osc-saw", "ge-osc-pulse"] {
        with_oscillator(pd, dir, name, |pd| {
            let (wave, _) = settled(pd, 1.0);
            close(frequency(&wave), 440.0, 1.0, &format!("{name} plays A4 for note 69"));
            close(peak(&wave), 1.0, 0.08, &format!("{name} peaks at 1"));
            close(mean(&wave), 0.0, 0.01, &format!("{name} has no DC"));

            pd.send_float("t1-tune", 12.0);
            close(frequency(&settled(pd, 1.0).0), 880.0, 2.0, &format!("{name} follows Tune"));
            pd.send_float("t1-tune", 0.0);
            pd.send_float("t1-fine", 100.0);
            close(frequency(&settled(pd, 1.0).0), note_hz(70.0), 1.5, &format!("{name} follows Fine"));
            println!("{name}: 440 Hz at note 69, peak {:.3}", peak(&wave));
        });
    }
}

/// The Mod input in each of its three modes, driven by a constant so the result can be read
/// off as a pitch or a level.
fn modulation(pd: &mut Pd, dir: &Path) {
    for name in ["ge-osc-sine", "ge-osc-tri", "ge-osc-saw", "ge-osc-pulse"] {
        with_oscillator(pd, dir, name, |pd| {
            let mut measure = |mode: f32, depth: f32, input: f32| {
                pd.send_float("t1-mode", mode);
                pd.send_float("t1-depth", depth);
                pd.send_float("t-mod", input);
                let (wave, _) = settled(pd, 1.0);
                (frequency(&wave), peak(&wave))
            };
            let (_, level) = measure(LINEAR_FM, 0.25, 0.0);

            // Depth 0.5 is 48 * 0.25 = 12 semitones per unit of the mod signal.
            let (up, up_level) = measure(EXPONENTIAL_FM, 0.5, 1.0);
            close(up, 880.0, 2.0, &format!("{name} exponential FM, +1 is an octave up"));
            close(up_level, level, 0.08, &format!("{name} exponential FM leaves the level alone"));
            let (down, _) = measure(EXPONENTIAL_FM, 0.5, -1.0);
            close(down, 220.0, 1.0, &format!("{name} exponential FM, -1 is an octave down"));

            // Depth 0.5 shifts the frequency by 8 * 0.25 = 2 times itself per unit of the mod signal.
            let (doubled, doubled_level) = measure(LINEAR_FM, 0.5, 0.5);
            close(doubled, 880.0, 2.0, &format!("{name} linear FM, 0.5 doubles the frequency"));
            close(doubled_level, level, 0.08, &format!("{name} linear FM leaves the level alone"));
            // 440 * (1 - 2) = -440 Hz: the wave runs backwards at the same pitch.
            let (reversed, reversed_level) = measure(LINEAR_FM, 0.5, -1.0);
            close(reversed, 440.0, 1.0, &format!("{name} linear FM goes through zero"));
            close(reversed_level, level, 0.08, &format!("{name} keeps its level running backwards"));

            let (pitch, louder) = measure(AM, 0.5, 1.0);
            close(pitch, 440.0, 1.0, &format!("{name} AM leaves the pitch alone"));
            close(louder, level * 1.5, 0.1, &format!("{name} AM at Depth 0.5, +1 is half as loud again"));
            let (_, silent) = measure(AM, 1.0, -1.0);
            close(silent, 0.0, 0.001, &format!("{name} AM at Depth 1, -1 is silence"));

            println!(
                "{name}: exp FM {up:.1} / {down:.1} Hz, linear FM {doubled:.1} / {reversed:.1} Hz (reversed), AM peak {louder:.3} / {silent:.4}"
            );
        });
    }
}

/// A sine modulating a sine's frequency linearly gives the textbook FM spectrum: side bands
/// spaced by the modulator's frequency, with Bessel-function amplitudes. At index 2.405 the
/// carrier itself vanishes. Any detuning or curvature in the modulation would break this.
fn linear_fm_spectrum(pd: &mut Pd, dir: &Path) {
    let carrier = format!("sig~ {}", 69.0 + 12.0 * (1000.0f32 / 440.0).log2());
    let boxes = [carrier.as_str(), "osc~ 100"];
    with_module(pd, dir, "ge-osc-sine", &boxes, &[], [Some(0), Some(1), None], to_left, |pd| {
        // Index = deviation / modulator frequency = 1000 * 8 * depth² / 100.
        let index = 2.405f32;
        pd.send_float("t1-tune", 0.0);
        pd.send_float("t1-fine", 0.0);
        pd.send_float("t1-mode", LINEAR_FM);
        pd.send_float("t1-depth", (index / 80.0).sqrt());
        let (wave, _) = settled(pd, 1.0);
        let at = |hz: f32| amplitude_at(&wave, hz);
        close(at(1000.0), 0.0, 0.02, "FM at index 2.405 has no carrier left");
        for (offset, bessel) in [(100.0, 0.519), (200.0, 0.432), (300.0, 0.199)] {
            close(at(1000.0 + offset), bessel, 0.02, &format!("upper side band at +{offset} Hz"));
            close(at(1000.0 - offset), bessel, 0.02, &format!("lower side band at -{offset} Hz"));
        }
        println!(
            "ge-osc-sine: linear FM at index 2.405: carrier {:.3}, side bands {:.3} / {:.3} (900 / 1100 Hz), {:.3} / {:.3} (800 / 1200 Hz)",
            at(1000.0), at(900.0), at(1100.0), at(800.0), at(1200.0)
        );
    });
}

/// Fraction of the time the pulse is high.
fn duty(signal: &[f32]) -> f32 {
    signal.iter().filter(|s| **s > 0.0).count() as f32 / signal.len() as f32
}

fn pulse_width(pd: &mut Pd, dir: &Path) {
    with_oscillator(pd, dir, "ge-osc-pulse", |pd| {
        close(duty(&settled(pd, 1.0).0), 0.5, 0.01, "pulse at Width 50 is a square");
        pd.send_float("t1-width", 25.0);
        let (narrow, _) = settled(pd, 1.0);
        close(duty(&narrow), 0.25, 0.01, "pulse at Width 25 is high a quarter of the time");
        close(mean(&narrow), 0.0, 0.01, "a narrow pulse still has no DC");
        // The PWM input moves the width by half its value: 25 % + 0.5 / 2 = 50 %.
        pd.send_float("t-pwm", 0.5);
        close(duty(&settled(pd, 1.0).0), 0.5, 0.01, "PWM input widens the pulse");
        println!("ge-osc-pulse: width and PWM set the duty cycle");
    });
}

/// On a high note the harmonics of a plain saw above half the sample rate fold back as
/// tones that do not belong to the note. Compare against a plain saw on the right channel.
fn saw_aliasing(pd: &mut Pd, dir: &Path) {
    // Box 0 is the note, 1 to 5 a plain saw into the right channel, then ours into the left.
    let boxes = ["sig~ 100", "mtof~", "phasor~", "*~ 2", "-~ 1", "dac~ 2"];
    let connections = [[0, 0, 1, 0], [1, 0, 2, 0], [2, 0, 3, 0], [3, 0, 4, 0], [4, 0, 5, 0]];
    with_module(pd, dir, "ge-osc-saw", &boxes, &connections, [Some(0), None, None], to_left, |pd| {
        pd.send_float("t1-tune", 0.0);
        pd.send_float("t1-fine", 0.0);
        let (ours, plain) = settled(pd, 1.0);
        let fundamental = note_hz(100.0);
        close(amplitude_at(&ours, fundamental), amplitude_at(&plain, fundamental), 0.03, "the fundamental keeps its level");
        // Harmonics 16 and 17 land below the fundamental, where they are easiest to hear.
        for harmonic in [16.0, 17.0] {
            let alias = (harmonic * fundamental - SAMPLE_RATE).abs();
            let (clean, dirty) = (amplitude_at(&ours, alias), amplitude_at(&plain, alias));
            println!(
                "ge-osc-saw: alias of harmonic {harmonic} at {alias:.0} Hz is {:.1} dB, a plain saw's is {:.1} dB",
                db(clean),
                db(dirty)
            );
            assert!(db(clean) < db(dirty) - 12.0, "aliasing at {alias:.0} Hz is at least 12 dB below a plain saw's");
        }
    });
}

fn noise(pd: &mut Pd, dir: &Path) {
    with_patch(pd, dir, &["ge-noise t1", "dac~ 1"], &[[0, 0, 1, 0]], |pd| {
        let (hiss, _) = settled(pd, 1.0);
        // White noise spread evenly over -1..1 has an RMS of 1 / sqrt(3).
        close(rms(&hiss), 0.577, 0.03, "noise level");
        close(mean(&hiss), 0.0, 0.02, "noise has no DC");
        println!("ge-noise: rms {:.3}", rms(&hiss));
    });
}

// --- filters -------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Low,
    High,
    Band,
    Notch,
}

impl Kind {
    fn abstraction(&self) -> &'static str {
        match self {
            Kind::Low => "ge-filter-lp",
            Kind::High => "ge-filter-hp",
            Kind::Band => "ge-filter-bp",
            Kind::Notch => "ge-filter-notch",
        }
    }
}

/// Q for a Res setting, as the filter abstractions compute it.
fn q_for(res: f32) -> f32 {
    0.7 * (res * (15.0f32 / 0.7).ln()).exp()
}

/// The response the filters are designed to have: the "cookbook" (RBJ) biquads, with the
/// low- and high-pass turned down by sqrt(0.7 / Q) as their resonance peak grows.
fn designed_gain(kind: Kind, cutoff: f32, res: f32, hz: f32) -> f32 {
    let q = q_for(res) as f64;
    let w = 2.0 * std::f64::consts::PI * cutoff as f64 / SAMPLE_RATE as f64;
    let (sin, cos) = w.sin_cos();
    let alpha = sin / (2.0 * q);
    // z^-1 and z^-2 on the unit circle, as (re, im).
    let theta = -2.0 * std::f64::consts::PI * hz as f64 / SAMPLE_RATE as f64;
    let (z1, z2) = ((theta.cos(), theta.sin()), ((2.0 * theta).cos(), (2.0 * theta).sin()));
    // |b0 + b1 z^-1 + b2 z^-2|
    let magnitude = |b0: f64, b1: f64, b2: f64| (b0 + b1 * z1.0 + b2 * z2.0).hypot(b1 * z1.1 + b2 * z2.1);
    let poles = magnitude(1.0 + alpha, -2.0 * cos, 1.0 - alpha);
    let trim = (0.7 / q).sqrt();
    let gain = match kind {
        Kind::Low => magnitude(1.0, 2.0, 1.0) * (1.0 - cos) / 2.0 * trim,
        Kind::High => magnitude(1.0, -2.0, 1.0) * (1.0 + cos) / 2.0 * trim,
        Kind::Band => magnitude(alpha, 0.0, -alpha),
        Kind::Notch => magnitude(1.0, -2.0 * cos, 1.0),
    };
    (gain / poles) as f32
}

/// `[osc~] → [filter] → left`, with `[sig~]` on the Mod input.
fn with_filter<T>(pd: &mut Pd, dir: &Path, kind: Kind, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-freq", "osc~ 440", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0]];
    with_module(pd, dir, kind.abstraction(), &boxes, &connections, [Some(1), Some(3), None], to_left, measure)
}

/// Gain in dB for a sine at `hz` with the filter set as given.
fn measured_db(pd: &mut Pd, cutoff: f32, res: f32, hz: f32) -> f32 {
    pd.send_float("t1-cutoff", cutoff);
    pd.send_float("t1-res", res);
    pd.send_float("t-freq", hz);
    db(rms(&settled(pd, 0.3).0) / std::f32::consts::FRAC_1_SQRT_2)
}

fn filters(pd: &mut Pd, dir: &Path) {
    // Around each cutoff: two octaves and a bit either side, plus the cutoff itself.
    let ratios = [0.06, 0.25, 0.6, 1.0, 1.8, 4.0, 12.0];
    for kind in [Kind::Low, Kind::High, Kind::Band, Kind::Notch] {
        with_filter(pd, dir, kind, |pd| {
            pd.send_float("t1-mod", 0.0);
            for (cutoff, res) in [(1000.0, 0.0), (1000.0, 0.5), (80.0, 0.0), (80.0, 1.0), (6000.0, 0.3)] {
                let mut row = String::new();
                for hz in ratios.map(|ratio| cutoff * ratio).into_iter().filter(|hz| *hz > 15.0 && *hz < 20000.0) {
                    let expected = db(designed_gain(kind, cutoff, res, hz));
                    let actual = measured_db(pd, cutoff, res, hz);
                    row += &format!(" {hz:.0} Hz {actual:.1}");
                    if kind == Kind::Notch && hz == cutoff {
                        // The null is exact in theory; a notch a few Hz wide is only as deep as
                        // single-precision arithmetic places it.
                        assert!(actual < -20.0, "Notch at {cutoff} Hz, Res {res}: measured {actual} dB at its centre");
                    } else if expected > -40.0 {
                        close(actual, expected, 1.0, &format!("{kind:?} at {cutoff} Hz, Res {res}, gain at {hz} Hz in dB"));
                    } else {
                        assert!(actual < -35.0, "{kind:?} at {cutoff} Hz, Res {res}: {hz} Hz should be far down, measured {actual} dB");
                    }
                }
                println!("{kind:?} at {cutoff} Hz, Res {res}: dB at{row}");
            }
        });
    }

    with_filter(pd, dir, Kind::Low, |pd| {
        pd.send_float("t1-mod", 0.0);
        // Opened fully with no resonance, a low-pass lets everything through at full level.
        close(measured_db(pd, 18000.0, 0.0, 220.0), 0.0, 0.5, "open low-pass at 220 Hz in dB");
        assert!(measured_db(pd, 18000.0, 0.0, 8000.0) > -3.0, "open low-pass passes 8 kHz");

        // One unit on the Mod input moves the cutoff by the Mod setting, in semitones.
        pd.send_float("t1-mod", 12.0);
        pd.send_float("t-mod", 1.0);
        let swept = measured_db(pd, 500.0, 0.0, 3000.0);
        close(swept, db(designed_gain(Kind::Low, 1000.0, 0.0, 3000.0)), 1.0, "Mod input raises a 500 Hz cutoff an octave");
        pd.send_float("t-mod", 0.0);

        // The lowest cutoff with the strongest resonance is where the arithmetic is tightest.
        pd.send_float("t1-cutoff", 20.0);
        pd.send_float("t1-res", 1.0);
        pd.send_float("t-freq", 20.0);
        let ringing = peak(&render(pd, 3.0).0);
        assert!(ringing.is_finite() && ringing < 4.0, "low-pass stays stable at 20 Hz, Res 1 (peak {ringing})");
        println!("Low: fully open passes everything; the Mod input moves the cutoff; stable at 20 Hz, Res 1 (peak {ringing:.2})");
    });

    with_filter(pd, dir, Kind::Notch, |pd| {
        pd.send_float("t1-mod", 0.0);
        for res in [0.0, 0.5] {
            let depth = measured_db(pd, 1000.0, res, 1000.0);
            assert!(depth < -30.0, "notch removes its centre frequency at Res {res}, measured {depth} dB");
        }
        println!("Notch: more than 30 dB down at its centre");
    });
}

// --- shapers -------------------------------------------------------------------------------

fn gain_of(decibels: f32) -> f32 {
    10f32.powf(decibels / 20.0)
}

/// A 220 Hz sine, its level set through `t-amp`, into the shaper; the shaper's output goes
/// left and its input right, so the two can be compared sample by sample. The Mod input is
/// a `[sig~]` set through `t-mod`.
fn with_shaper<T>(pd: &mut Pd, dir: &Path, name: &str, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["osc~ 220", "r t-amp", "*~ 1", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 2, 0], [1, 0, 2, 1], [3, 0, 4, 0]];
    let both = |module: usize| (vec!["dac~ 1", "dac~ 2"], vec![[module, 0, module + 1, 0], [2, 0, module + 2, 0]]);
    with_module(pd, dir, name, &boxes, &connections, [Some(2), Some(4), None], both, |pd| {
        for setting in ["t1-mod", "t1-symmetry", "t1-bias", "t1-shape"] {
            pd.send_float(setting, 0.0);
        }
        measure(pd)
    })
}

/// What Pd's `[hip~ 5]` does to a signal, starting from rest.
fn dc_blocked(signal: &[f32]) -> Vec<f32> {
    let coefficient = 1.0 - 5.0 * 2.0 * std::f32::consts::PI / SAMPLE_RATE;
    let normal = 0.5 * (1.0 + coefficient);
    let mut last = 0.0f32;
    signal
        .iter()
        .map(|x| {
            let next = x + coefficient * last;
            let out = normal * (next - last);
            last = next;
            out
        })
        .collect()
}

/// Largest difference between the shaper's output and `curve` applied to its input. With
/// `blocks_dc` the curve's result goes through the same DC blocker as the module ends in,
/// and only the second half is compared, when both have settled the same way.
fn curve_error(pd: &mut Pd, blocks_dc: bool, curve: impl Fn(f32) -> f32) -> f32 {
    let (output, input) = settled(pd, 1.0);
    let mut expected: Vec<f32> = input.iter().map(|x| curve(*x)).collect();
    if blocks_dc {
        expected = dc_blocked(&expected);
    }
    let from = output.len() / 2;
    output[from..].iter().zip(&expected[from..]).fold(0.0, |worst, (o, e)| worst.max((o - e).abs()))
}

fn fold(x: f32) -> f32 {
    1.0 - 4.0 * ((x / 4.0 + 0.25).rem_euclid(1.0) - 0.5).abs()
}

fn sine_fold(x: f32) -> f32 {
    (x * std::f32::consts::FRAC_PI_2).sin()
}

fn clips_and_folder(pd: &mut Pd, dir: &Path) {
    type Curve = fn(f32) -> f32;
    // Module, its curve, the setting that shifts the signal before the curve (if any),
    // and the Shape to select (the folder's).
    let cases: [(&str, &str, Curve, Option<&str>, f32); 4] = [
        ("ge-shaper-soft", "tanh", f32::tanh, Some("bias"), 0.0),
        ("ge-shaper-hard", "clip", |x| x.clamp(-1.0, 1.0), None, 0.0),
        ("ge-shaper-fold", "triangle fold", fold, Some("symmetry"), 0.0),
        ("ge-shaper-fold", "sine fold", sine_fold, Some("symmetry"), 1.0),
    ];
    for (name, what, curve, shift, shape) in cases {
        with_shaper(pd, dir, name, |pd| {
            pd.send_float("t1-shape", shape);
            let blocks_dc = shift.is_some();
            let mut worst = 0.0f32;
            for (amp, drive) in [(1.0, 0.0), (0.3, 0.0), (1.0, 6.0), (1.0, 12.0), (0.5, 24.0)] {
                pd.send_float("t-amp", amp);
                pd.send_float("t1-drive", drive);
                let error = curve_error(pd, blocks_dc, |x| curve(x * gain_of(drive)));
                close(error, 0.0, 0.005, &format!("{name} ({what}) at Drive {drive} dB, input level {amp}"));
                worst = worst.max(error);
            }

            // Mod: 12 dB per unit of the mod signal, on top of 6 dB of Drive.
            pd.send_float("t-amp", 1.0);
            pd.send_float("t1-drive", 6.0);
            pd.send_float("t1-mod", 12.0);
            for input in [1.0, -0.5] {
                pd.send_float("t-mod", input);
                let gain = gain_of(6.0 + 12.0 * input);
                let error = curve_error(pd, blocks_dc, |x| curve(x * gain));
                close(error, 0.0, 0.005, &format!("{name} ({what}) with {input} on Mod"));
                worst = worst.max(error);
            }
            pd.send_float("t-mod", 0.0);
            println!("{name} ({what}): follows its curve within {worst:.4} at every Drive and Mod setting tried");

            // Bias / Symmetry: the signal is shifted before the curve, which makes the two
            // halves differ (even harmonics), and silence still has to come out as silence.
            let Some(shift) = shift else { return };
            let setting = format!("t1-{shift}");
            pd.send_float("t1-drive", 12.0);
            let second_before = amplitude_at(&settled(pd, 1.0).0, 440.0);
            close(second_before, 0.0, 0.01, &format!("{name} ({what}) has no second harmonic when centred"));

            pd.send_float(&setting, 0.5);
            let gain = gain_of(12.0);
            let error = curve_error(pd, true, |x| curve(x * gain + 0.5) - curve(0.5));
            close(error, 0.0, 0.005, &format!("{name} ({what}) with {shift} 0.5 follows the shifted curve"));
            let (shifted, _) = settled(pd, 1.0);
            let second = amplitude_at(&shifted, 440.0);
            assert!(second > 0.1, "{name} ({what}): {shift} adds even harmonics, second harmonic {second}");
            close(mean(&shifted), 0.0, 0.01, &format!("{name} ({what}) output has no DC"));

            pd.send_float("t-amp", 0.0);
            render(pd, 1.0);
            let silence = peak(&render(pd, 0.5).0);
            close(silence, 0.0, 1e-4, &format!("{name} ({what}) is silent without input, whatever {shift} is"));
            println!("{name} ({what}): second harmonic {second_before:.3} centred, {second:.3} at {shift} 0.5; silent without input");
        });
    }
}

fn rectifier(pd: &mut Pd, dir: &Path) {
    with_shaper(pd, dir, "ge-shaper-rectify", |pd| {
        pd.send_float("t-amp", 1.0);
        let rectified = |x: f32, amount: f32| x.max(0.0) + (1.0 - 2.0 * amount) * x.min(0.0);
        let mut worst = 0.0f32;
        for amount in [0.0, 0.25, 0.5, 1.0] {
            pd.send_float("t1-amount", amount);
            let error = curve_error(pd, true, |x| rectified(x, amount));
            close(error, 0.0, 0.005, &format!("rectifier at Amount {amount}"));
            worst = worst.max(error);
        }
        // Full-wave: the wave repeats twice as often, so the fundamental is gone.
        let (full, _) = settled(pd, 1.0);
        close(amplitude_at(&full, 220.0), 0.0, 0.01, "full-wave has no fundamental left");
        let octave = amplitude_at(&full, 440.0);
        close(octave, 4.0 / (3.0 * std::f32::consts::PI), 0.01, "full-wave sine: second harmonic is 4 / 3 pi");
        close(mean(&full), 0.0, 0.01, "rectifier output has no DC");

        // Mod: from Amount 0, a mod signal of 1 at 0.5 per unit is half-wave.
        pd.send_float("t1-amount", 0.0);
        pd.send_float("t1-mod", 0.5);
        pd.send_float("t-mod", 1.0);
        let error = curve_error(pd, true, |x| rectified(x, 0.5));
        close(error, 0.0, 0.005, "rectifier Mod raises the amount");
        println!("ge-shaper-rectify: follows its curve within {:.4}; full-wave moves the sine up an octave (level {octave:.3})", worst.max(error));
    });
}

/// How many times a second the signal changes value.
fn steps_per_second(signal: &[f32]) -> f32 {
    signal.windows(2).filter(|w| w[0] != w[1]).count() as f32 * SAMPLE_RATE / signal.len() as f32
}

fn bitcrusher(pd: &mut Pd, dir: &Path) {
    with_shaper(pd, dir, "ge-shaper-crush", |pd| {
        pd.send_float("t-amp", 1.0);

        // Rate, at full resolution: the output moves only when a new sample is taken.
        pd.send_float("t1-bits", 16.0);
        let mut rates = Vec::new();
        for rate in [500.0, 2000.0, 8000.0] {
            pd.send_float("t1-rate", rate);
            let steps = steps_per_second(&settled(pd, 1.0).0);
            close(steps, rate, rate * 0.02, &format!("bitcrusher takes {rate} samples a second"));
            rates.push(format!("{steps:.0}"));
        }
        // Mod: 12 semitones per unit doubles the rate.
        pd.send_float("t1-rate", 1000.0);
        pd.send_float("t1-mod", 12.0);
        pd.send_float("t-mod", 1.0);
        let doubled = steps_per_second(&settled(pd, 1.0).0);
        close(doubled, 2000.0, 40.0, "bitcrusher Mod raises the rate an octave");
        pd.send_float("t-mod", 0.0);

        // Bits, at the highest rate: every output value sits on a step of 1 / 2^(bits - 1).
        pd.send_float("t1-rate", 18000.0);
        let mut counts = Vec::new();
        for bits in [1.0f32, 3.0, 5.0, 8.0] {
            pd.send_float("t1-bits", bits);
            let (output, input) = settled(pd, 1.0);
            let levels = 2f32.powf(bits - 1.0);
            let off_grid = output.iter().map(|y| (y * levels - (y * levels).round()).abs()).fold(0.0, f32::max);
            close(off_grid, 0.0, 0.01, &format!("bitcrusher at {bits} bits lands on its steps"));
            let mut used: Vec<i32> = output.iter().map(|y| (y * levels).round() as i32).collect();
            used.sort();
            used.dedup();
            assert_eq!(used.len() as f32, 2.0 * levels + 1.0, "a full-level sine at {bits} bits uses every step from -1 to 1");
            // The held sample is at most three samples old, and rounding moves it by half a step.
            let lag = 3.0 * 2.0 * std::f32::consts::PI * 220.0 / SAMPLE_RATE;
            let apart = output.iter().zip(&input).map(|(y, x)| (y - x).abs()).fold(0.0, f32::max);
            assert!(apart <= 0.5 / levels + lag + 0.01, "bitcrusher at {bits} bits stays near its input, off by {apart}");
            counts.push(format!("{}", used.len()));
        }

        pd.send_float("t-amp", 0.0);
        let silence = peak(&settled(pd, 0.5).0);
        close(silence, 0.0, 1e-6, "bitcrusher is silent without input");
        println!(
            "ge-shaper-crush: {} steps a second at Rate 500 / 2000 / 8000, {doubled:.0} with Mod an octave up from 1000; {} levels at 1 / 3 / 5 / 8 bits",
            rates.join(" / "),
            counts.join(" / ")
        );
    });
}

/// Polynomial n turns a full-level sine into harmonic n and nothing else.
fn chebyshev(pd: &mut Pd, dir: &Path) {
    with_shaper(pd, dir, "ge-shaper-cheby", |pd| {
        pd.send_float("t-amp", 1.0);
        pd.send_float("t1-drive", 0.0);
        let mut levels = Vec::new();
        for order in 1..=8 {
            pd.send_float("t1-order", order as f32);
            let (wave, _) = settled(pd, 1.0);
            for harmonic in 1..=9 {
                let expected = if harmonic == order { 1.0 } else { 0.0 };
                close(
                    amplitude_at(&wave, 220.0 * harmonic as f32),
                    expected,
                    0.03,
                    &format!("Chebyshev order {order}, harmonic {harmonic}"),
                );
            }
            levels.push(format!("{:.3}", amplitude_at(&wave, 220.0 * order as f32)));
        }
        println!("ge-shaper-cheby: level of harmonic n at Order n, n = 1..8: {}", levels.join(" "));

        pd.send_float("t1-order", 2.5);
        let (between, _) = settled(pd, 1.0);
        close(amplitude_at(&between, 440.0), 0.5, 0.03, "Order 2.5 is half second harmonic");
        close(amplitude_at(&between, 660.0), 0.5, 0.03, "Order 2.5 is half third harmonic");

        // Mod: 2 orders per unit of the mod signal, from Order 2.
        pd.send_float("t1-order", 2.0);
        pd.send_float("t1-mod", 2.0);
        pd.send_float("t-mod", 1.0);
        let (moved, _) = settled(pd, 1.0);
        close(amplitude_at(&moved, 880.0), 1.0, 0.03, "Mod moves the order from 2 to 4");
        pd.send_float("t-mod", 0.0);

        // At half level the second polynomial gives 2 * (0.5 cos)^2 = 0.25 + 0.25 cos 2a; the 0.25 is DC and is blocked.
        pd.send_float("t1-drive", -6.0206);
        let (half, _) = settled(pd, 1.0);
        close(amplitude_at(&half, 440.0), 0.25, 0.02, "Order 2 at half level");
        close(mean(&half), 0.0, 0.01, "Chebyshev output has no DC");

        // Drive past full level only clips the input; the output stays in range.
        pd.send_float("t1-drive", 12.0);
        pd.send_float("t1-order", 8.0);
        let loud = peak(&settled(pd, 0.5).0);
        assert!(loud <= 2.01, "Chebyshev output stays bounded when overdriven, peak {loud}");

        pd.send_float("t-amp", 0.0);
        render(pd, 1.0);
        let mut silence = 0.0f32;
        for order in [2.0, 3.0, 4.0, 6.5, 8.0] {
            pd.send_float("t1-order", order);
            render(pd, 0.5);
            silence = silence.max(peak(&render(pd, 0.3).0));
        }
        close(silence, 0.0, 1e-4, "Chebyshev is silent without input at every order");
        println!("ge-shaper-cheby: blends neighbours, follows Mod, silent without input");
    });
}

// --- mixer ---------------------------------------------------------------------------------

fn mixer(pd: &mut Pd, dir: &Path) {
    let boxes = ["sig~ 0.25", "sig~ 0.5", "ge-mixer t1", "dac~ 1"];
    with_patch(pd, dir, &boxes, &[[0, 0, 2, 0], [1, 0, 2, 2], [2, 0, 3, 0]], |pd| {
        pd.send_float("t1-level1", 1.0);
        pd.send_float("t1-level3", 0.5);
        close(mean(&settled(pd, 0.1).0), 0.25 + 0.5 * 0.5, 0.001, "mixer sums its inputs times their levels");
        pd.send_float("t1-level1", 2.0);
        close(mean(&settled(pd, 0.1).0), 2.0 * 0.25 + 0.5 * 0.5, 0.001, "mixer follows a level change");
        println!("ge-mixer: sums inputs times levels");
    });
}

// --- envelope ------------------------------------------------------------------------------

/// The level `ms` milliseconds into a rendered stretch.
fn level_at(signal: &[f32], ms: f32) -> f32 {
    signal[((ms / 1000.0 * SAMPLE_RATE) as usize).min(signal.len() - 1)]
}

/// Hold the gate for `hold` seconds and then let go for `tail` seconds; returns both stretches.
fn play(pd: &mut Pd, hold: f32, tail: f32) -> (Vec<f32>, Vec<f32>) {
    pd.send_float("t-gate", 1.0);
    let held = render(pd, hold).0;
    pd.send_float("t-gate", 0.0);
    (held, render(pd, tail).0)
}

/// The ADSR's stages are its knobs times its inputs, read when each stage starts.
fn envelope(pd: &mut Pd, dir: &Path) {
    // The gate and the four setting inputs each come from a [sig~] that a message sets.
    let boxes = [
        "r t-gate", "sig~", "r t-a", "sig~ 1", "r t-d", "sig~ 1", "r t-s", "sig~ 1", "r t-r", "sig~ 1",
        "ge-env-adsr t", "dac~ 1",
    ];
    let connections = [
        [0, 0, 1, 0], [1, 0, 10, 0], [2, 0, 3, 0], [3, 0, 10, 1], [4, 0, 5, 0], [5, 0, 10, 2],
        [6, 0, 7, 0], [7, 0, 10, 3], [8, 0, 9, 0], [9, 0, 10, 4], [10, 0, 11, 0],
    ];
    with_patch(pd, dir, &boxes, &connections, |pd| {
        for (knob, value) in [("attack", 100.0), ("decay", 100.0), ("sustain", 0.5), ("release", 200.0)] {
            pd.send_float(&format!("t-{knob}"), value);
        }
        let inputs = |pd: &mut Pd, a: f32, d: f32, s: f32, r: f32| {
            for (input, value) in [("a", a), ("d", d), ("s", s), ("r", r)] {
                pd.send_float(&format!("t-{input}"), value);
            }
            // The inputs are signals: let them reach the envelope before a key goes down.
            render(pd, 0.05);
        };
        // A stage starts on a block boundary, up to 1.5 ms late, which is 0.015 on a 100 ms ramp.
        let tolerance = 0.03;

        assert_eq!(peak(&render(pd, 0.2).0), 0.0, "envelope is silent before a key is played");

        // Inputs at 1, as when nothing is patched: the knobs alone.
        inputs(pd, 1.0, 1.0, 1.0, 1.0);
        let (held, tail) = play(pd, 0.5, 0.4);
        close(level_at(&held, 50.0), 0.5, tolerance, "attack of 100 ms is half way at 50 ms");
        close(level_at(&held, 150.0), 0.75, tolerance, "decay of 100 ms is half way down to sustain at 150 ms");
        close(level_at(&held, 400.0), 0.5, 0.001, "sustain is 0.5");
        close(level_at(&tail, 100.0), 0.25, tolerance, "release of 200 ms is half way at 100 ms");
        assert_eq!(level_at(&tail, 300.0), 0.0, "envelope is silent after its release");
        assert!(peak(&held) <= 1.0, "envelope peaks at 1, got {}", peak(&held));

        // Each input scales its own stage and no other.
        inputs(pd, 0.5, 1.0, 1.0, 1.0);
        let (held, _) = play(pd, 0.5, 0.4);
        close(level_at(&held, 25.0), 0.5, tolerance, "A input 0.5: attack is 50 ms");
        close(level_at(&held, 100.0), 0.75, tolerance, "A input 0.5: decay still 100 ms, after the shorter attack");

        inputs(pd, 1.0, 2.0, 1.0, 1.0);
        let (held, _) = play(pd, 0.5, 0.4);
        close(level_at(&held, 50.0), 0.5, tolerance, "D input 2: attack unchanged");
        close(level_at(&held, 200.0), 0.75, tolerance, "D input 2: decay is 200 ms");

        inputs(pd, 1.0, 1.0, 0.5, 1.0);
        let (held, tail) = play(pd, 0.5, 0.4);
        close(level_at(&held, 400.0), 0.25, 0.001, "S input 0.5: sustain is 0.25");
        close(level_at(&tail, 100.0), 0.125, tolerance, "S input 0.5: release unchanged");

        inputs(pd, 1.0, 1.0, 1.0, 0.25);
        let (held, tail) = play(pd, 0.5, 0.4);
        close(level_at(&held, 400.0), 0.5, 0.001, "R input 0.25: sustain unchanged");
        close(level_at(&tail, 25.0), 0.25, tolerance, "R input 0.25: release is 50 ms");
        assert_eq!(level_at(&tail, 60.0), 0.0, "R input 0.25: silent after 50 ms");

        // Out of range: sustain stops at 1, a negative time is no time.
        inputs(pd, -1.0, 1.0, 3.0, -1.0);
        let (held, tail) = play(pd, 0.5, 0.4);
        close(level_at(&held, 5.0), 1.0, 0.001, "negative A input: the attack is immediate");
        close(level_at(&held, 400.0), 1.0, 0.001, "S input 3: sustain stays at 1");
        assert_eq!(level_at(&tail, 5.0), 0.0, "negative R input: the release is immediate");
        assert!(held.iter().chain(&tail).all(|v| v.is_finite() && (0.0..=1.0).contains(v)), "envelope stays within 0..1");

        // An input is read when its stage starts: a change during a note waits for the next one.
        inputs(pd, 1.0, 1.0, 1.0, 1.0);
        pd.send_float("t-gate", 1.0);
        render(pd, 0.4);
        pd.send_float("t-s", 0.5);
        pd.send_float("t-r", 0.25);
        close(level_at(&render(pd, 0.2).0, 150.0), 0.5, 0.001, "sustain of a held note does not follow its input");
        pd.send_float("t-gate", 0.0);
        close(level_at(&render(pd, 0.4).0, 25.0), 0.25, tolerance, "release takes the input as it is at key up");
        let (held, _) = play(pd, 0.5, 0.4);
        close(level_at(&held, 400.0), 0.25, 0.001, "the next note takes the new sustain");

        // A key played again during the release carries on from where the envelope is.
        inputs(pd, 1.0, 1.0, 1.0, 1.0);
        let (_, tail) = play(pd, 0.4, 0.1);
        let before = *tail.last().unwrap();
        pd.send_float("t-gate", 1.0);
        let again = render(pd, 0.3).0;
        close(before, 0.25, tolerance, "half way through the release");
        let lowest = again.iter().cloned().fold(f32::MAX, f32::min);
        // The release runs on for the block in which the new gate is noticed, no further.
        assert!(lowest >= before - 0.01, "retrigger starts from {before}, not from zero (went down to {lowest})");
        close(level_at(&again, 250.0), 0.5, 0.001, "and reaches sustain again");
        pd.send_float("t-gate", 0.0);
        render(pd, 0.4);

        println!("ge-env-adsr: stages are knob x input, read at key down (A, D, S) and key up (R)");
    });
}

// --- LFOs ----------------------------------------------------------------------------------

/// Both outlets of a modulation source: the first into the left channel, the second into the right.
fn both_outlets(module: usize) -> (Vec<&'static str>, Vec<[usize; 4]>) {
    (vec!["dac~ 1", "dac~ 2"], vec![[module, 0, module + 1, 0], [module, 1, module + 2, 0]])
}

/// The LFO with a `[sig~]` on Reset that `t-gate` sets, at 5 Hz, full level, sine.
fn with_lfo<T>(pd: &mut Pd, dir: &Path, measure: impl FnOnce(&mut Pd) -> T) -> T {
    with_module(pd, dir, "ge-lfo", &["r t-gate", "sig~"], &[[0, 0, 1, 0]], [Some(1), None, None], both_outlets, |pd| {
        pd.send_float("t1-rate", 5.0);
        pd.send_float("t1-level", 1.0);
        pd.send_float("t1-shape", 0.0);
        measure(pd)
    })
}

fn lfo(pd: &mut Pd, dir: &Path) {
    // The value a quarter, a half and three quarters of the way through a cycle.
    let shapes: [(&str, [f32; 3]); 5] = [
        ("sine", [1.0, 0.0, -1.0]),
        ("triangle", [1.0, 0.0, -1.0]),
        ("saw", [-0.5, 0.0, 0.5]),
        ("ramp", [0.5, 0.0, -0.5]),
        ("square", [1.0, f32::NAN, -1.0]),
    ];
    with_lfo(pd, dir, |pd| {
        for (number, (name, expected)) in shapes.iter().enumerate() {
            pd.send_float("t1-shape", number as f32);
            pd.send_float("t-gate", 0.0);
            render(pd, 0.13);
            // A rising edge at Reset: the cycle of 200 ms starts again, within a block of 1.5 ms.
            pd.send_float("t-gate", 1.0);
            let (wave, positive) = render(pd, 0.4);
            for (quarter, value) in expected.iter().enumerate() {
                if value.is_nan() {
                    continue;
                }
                let ms = 50.0 * (quarter as f32 + 1.0);
                close(level_at(&wave, ms), *value, 0.06, &format!("lfo {name} {ms} ms after a reset"));
                close(level_at(&wave, ms + 200.0), *value, 0.06, &format!("lfo {name} a cycle later"));
            }
            assert!(peak(&wave) <= 1.0001, "lfo {name} stays within -1..1, peak {}", peak(&wave));
            let apart = wave.iter().zip(&positive).map(|(w, p)| (p - (w + 1.0) / 2.0).abs()).fold(0.0f32, f32::max);
            assert!(apart < 0.0001, "lfo {name}: the second outlet is the first moved into 0..1 (off by {apart})");
        }

        // Sine and triangle start from zero, so a restart is not a jump.
        for shape in [0.0, 1.0] {
            pd.send_float("t1-shape", shape);
            pd.send_float("t-gate", 0.0);
            render(pd, 0.13);
            pd.send_float("t-gate", 1.0);
            let start = level_at(&render(pd, 0.05).0, 3.0);
            assert!((0.0..0.15).contains(&start), "lfo shape {shape} restarts from zero going up, got {start}");
        }

        // With no new edge it runs on at its rate; Level scales both outlets.
        pd.send_float("t1-shape", 0.0);
        close(frequency(&settled(pd, 2.0).0), 5.0, 0.6, "lfo runs at its rate");
        pd.send_float("t1-rate", 20.0);
        close(frequency(&settled(pd, 2.0).0), 20.0, 0.6, "lfo follows Rate");
        pd.send_float("t1-level", 0.5);
        let (wave, positive) = settled(pd, 0.5);
        close(peak(&wave), 0.5, 0.01, "lfo Level 0.5 halves the wave");
        let (low, high) = positive.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        assert!(low >= 0.0 && (high - 0.5).abs() < 0.01, "lfo 0..1 outlet at Level 0.5 runs from 0 to 0.5, got {low}..{high}");
        println!("ge-lfo: five shapes restart on a gate edge, run at Rate, second outlet is 0..1");
    });
}

fn random(pd: &mut Pd, dir: &Path) {
    let opened = |pd: &mut Pd, measure: &mut dyn FnMut(&mut Pd)| {
        with_module(pd, dir, "ge-lfo-random", &[], &[], [None, None, None], both_outlets, |pd| {
            pd.send_float("t1-rate", 100.0);
            pd.send_float("t1-smooth", 0.0);
            pd.send_float("t1-level", 1.0);
            measure(pd)
        })
    };
    let mut first = Vec::new();
    opened(pd, &mut |pd| {
        // Steps: a new value a hundred times a second, anywhere between -1 and 1.
        let (wave, positive) = settled(pd, 2.0);
        close(steps_per_second(&wave), 100.0, 2.0, "random takes a new value at every tick of Rate");
        let (low, high) = wave.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        assert!(low >= -1.0 && high <= 1.0, "random stays within -1..1, got {low}..{high}");
        assert!(low < -0.8 && high > 0.8, "random uses the whole range, got {low}..{high}");
        close(rms(&wave), 0.577, 0.1, "random values are spread evenly (rms of a uniform spread)");
        close(mean(&wave), 0.0, 0.2, "random is centred");
        let apart = wave.iter().zip(&positive).map(|(w, p)| (p - (w + 1.0) / 2.0).abs()).fold(0.0f32, f32::max);
        assert!(apart < 0.0001, "random: the second outlet is the first moved into 0..1 (off by {apart})");
        first = wave.iter().step_by(441).take(20).cloned().collect();

        // Half smooth: half of every tick is spent on the way, the other half at rest.
        pd.send_float("t1-smooth", 0.5);
        let wave = settled(pd, 2.0).0;
        let resting = wave.windows(2).filter(|w| w[0] == w[1]).count() as f32 / wave.len() as f32;
        close(resting, 0.5, 0.03, "random at Smooth 0.5 rests for half of each tick");

        // Fully smooth: a line with no jumps. One tick is 441 samples and the range is 2 wide.
        pd.send_float("t1-smooth", 1.0);
        let wave = settled(pd, 2.0).0;
        let jump = wave.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0f32, f32::max);
        assert!(jump < 2.0 / 441.0 * 1.05, "random at Smooth 1 never jumps, largest step {jump}");
        let (low, high) = wave.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        assert!(low < -0.8 && high > 0.8, "random at Smooth 1 still uses the range, got {low}..{high}");

        // Level scales it; the Rate input multiplies the rate, and a negative rate stops the clock.
        pd.send_float("t1-smooth", 0.0);
        pd.send_float("t1-level", 0.25);
        assert!(peak(&settled(pd, 1.0).0) <= 0.25, "random Level 0.25 scales the values");
        pd.send_float("t1-level", 1.0);
        pd.send_float("t-in0", 0.5);
        close(steps_per_second(&settled(pd, 2.0).0), 50.0, 2.0, "random Rate input 0.5 halves the rate");
        pd.send_float("t-in0", -1.0);
        assert_eq!(steps_per_second(&settled(pd, 1.0).0), 0.0, "random holds its value at a negative rate");
    });
    // Another copy, as another voice would be, has values of its own.
    opened(pd, &mut |pd| {
        let second: Vec<f32> = settled(pd, 2.0).0.iter().step_by(441).take(20).cloned().collect();
        assert_ne!(first, second, "two copies of Random give different values");
    });
    println!("ge-lfo-random: a new value at every tick, gliding for the Smooth part of it; each copy its own");
}

// --- all-pass and effects ------------------------------------------------------------------

/// Rms of the stretch from `from` to `to` milliseconds.
fn rms_between(signal: &[f32], from: f32, to: f32) -> f32 {
    let at = |ms: f32| ((ms / 1000.0 * SAMPLE_RATE) as usize).min(signal.len());
    rms(&signal[at(from)..at(to)])
}

fn set(pd: &mut Pd, settings: &[(&str, f32)]) {
    for (name, value) in settings {
        pd.send_float(&format!("t1-{name}"), *value);
    }
}

/// The All-pass lets every frequency through at full level and turns its phase by half a
/// cycle at the cutoff, so that added to its input it leaves a notch there.
fn all_pass(pd: &mut Pd, dir: &Path) {
    let boxes = ["r t-freq", "osc~ 440", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0]];
    let mut worst = 0.0f32;
    with_module(pd, dir, "ge-filter-allpass", &boxes, &connections, [Some(1), Some(3), None], to_left, |pd| {
        for (cutoff, res) in [(300.0, 0.0), (1200.0, 0.3), (5000.0, 0.8)] {
            for hz in [60.0, 300.0, 1200.0, 5000.0, 12000.0] {
                worst = worst.max(measured_db(pd, cutoff, res, hz).abs());
            }
        }
    });
    assert!(worst < 0.3, "all-pass keeps every frequency at its level, worst {worst} dB off");

    let summed = |module: usize| (vec!["+~", "dac~ 1"], vec![[module, 0, module + 1, 0], [1, 0, module + 1, 1], [module + 1, 0, module + 2, 0]]);
    let (at_cutoff, below, above) = with_module(pd, dir, "ge-filter-allpass", &boxes, &connections, [Some(1), Some(3), None], summed, |pd| {
        set(pd, &[("cutoff", 1000.0), ("res", 0.3)]);
        let mut level = |hz: f32| {
            pd.send_float("t-freq", hz);
            rms(&settled(pd, 0.3).0) / std::f32::consts::FRAC_1_SQRT_2
        };
        (level(1000.0), level(60.0), level(12000.0))
    });
    assert!(at_cutoff < 0.02, "all-pass plus its input cancels at the cutoff, got {at_cutoff}");
    close(below, 2.0, 0.1, "all-pass far below the cutoff is in phase with its input");
    close(above, 2.0, 0.1, "all-pass far above the cutoff has gone a whole cycle round");
    println!("ge-filter-allpass: within {worst:.2} dB of flat; plus its input: {at_cutoff:.3} at the cutoff, {below:.2} / {above:.2} far below / above");
}

/// A 20 ms burst of a 220 Hz sine into the delay, then what comes out over the next half second.
fn echoes(pd: &mut Pd) -> Vec<f32> {
    pd.send_float("t-amp", 0.0);
    render(pd, 0.7);
    pd.send_float("t-amp", 1.0);
    let mut out = render(pd, 0.02).0;
    pd.send_float("t-amp", 0.0);
    out.extend(render(pd, 0.5).0);
    out
}

fn delay(pd: &mut Pd, dir: &Path) {
    let full = std::f32::consts::FRAC_1_SQRT_2;
    with_shaper(pd, dir, "ge-fx-delay", |pd| {
        // Wet only, bright: the burst comes back after Time, then again at half the level.
        set(pd, &[("time", 100.0), ("feedback", 0.5), ("tone", 18000.0), ("mix", 1.0)]);
        let out = echoes(pd);
        assert!(rms_between(&out, 0.0, 95.0) < 0.001, "delay is silent until the first echo");
        close(rms_between(&out, 103.0, 117.0), full, 0.03, "delay: first echo at full level after 100 ms");
        assert!(rms_between(&out, 130.0, 195.0) < 0.001, "delay is silent between echoes");
        close(rms_between(&out, 203.0, 217.0), full * 0.5, 0.03, "delay: second echo times Feedback");
        close(rms_between(&out, 303.0, 317.0), full * 0.25, 0.03, "delay: third echo times Feedback again");

        // Tone darkens each pass: a one-pole low-pass at 200 Hz lets 0.672 of a 220 Hz sine through.
        set(pd, &[("tone", 200.0)]);
        let out = echoes(pd);
        close(rms_between(&out, 103.0, 117.0), full, 0.03, "delay: the first echo is not filtered");
        close(rms_between(&out, 205.0, 217.0), full * 0.5 * 0.672, 0.03, "delay: second echo through the low-pass");

        // The Time input multiplies the time; the Feedback input the feedback.
        set(pd, &[("tone", 18000.0)]);
        pd.send_float("t-in1", 0.5);
        pd.send_float("t-in2", 0.5);
        let out = echoes(pd);
        close(rms_between(&out, 53.0, 67.0), full, 0.03, "delay Time input 0.5: first echo after 50 ms");
        close(rms_between(&out, 103.0, 117.0), full * 0.25, 0.03, "delay Feedback input 0.5: second echo at a quarter");
        pd.send_float("t-in1", 1.0);
        pd.send_float("t-in2", 1.0);

        // Dry only: the input, untouched.
        set(pd, &[("mix", 0.0)]);
        pd.send_float("t-amp", 0.8);
        let (out, input) = settled(pd, 0.2);
        let apart = out.iter().zip(&input).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(apart < 0.0001, "delay at Mix 0 is its input, off by {apart}");
        println!("ge-fx-delay: echoes at Time, each times Feedback through the Tone low-pass; dry at Mix 0");
    });
}

fn chorus(pd: &mut Pd, dir: &Path) {
    // Against its input: with no depth the wet signal is the input 2 ms late.
    with_shaper(pd, dir, "ge-fx-chorus", |pd| {
        set(pd, &[("rate", 2.0), ("depth", 0.0), ("feedback", 0.0), ("mix", 1.0)]);
        pd.send_float("t-amp", 0.8);
        let (out, input) = settled(pd, 0.3);
        let late = 0.002 * SAMPLE_RATE;
        let (whole, part) = (late.floor() as usize, late.fract());
        let apart = (whole + 1..out.len())
            .map(|n| (out[n] - (input[n - whole] * (1.0 - part) + input[n - whole - 1] * part)).abs())
            .fold(0.0f32, f32::max);
        assert!(apart < 0.01, "chorus without depth is its input 2 ms late, off by {apart}");

        // With depth the pitch wobbles: the delay sweeps 10 ms at 2 Hz, about 6 % either way.
        set(pd, &[("depth", 1.0)]);
        let wet = settled(pd, 1.0).0;
        let pitches: Vec<f32> = wet.chunks(2205).map(frequency).collect();
        let (low, high) = pitches.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        assert!(low < 215.0 && high > 225.0, "chorus bends the pitch both ways, got {low}..{high} Hz");
    });
    // Its two outlets: the same with no depth, moving apart with it.
    with_module(pd, dir, "ge-fx-chorus", &["osc~ 220", "*~ 0.8"], &[[0, 0, 1, 0]], [Some(1), None, None], both_outlets, |pd| {
        set(pd, &[("rate", 2.0), ("depth", 0.0), ("feedback", 0.0), ("mix", 1.0)]);
        let (left, right) = settled(pd, 0.3);
        let apart = left.iter().zip(&right).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(apart < 0.0001, "chorus: left and right are the same without depth, off by {apart}");
        set(pd, &[("depth", 0.5), ("mix", 0.5)]);
        let (left, right) = settled(pd, 1.0);
        let difference: Vec<f32> = left.iter().zip(&right).map(|(a, b)| a - b).collect();
        assert!(rms(&difference) > 0.05, "chorus: left and right move apart with depth, rms {}", rms(&difference));
        // Fed back hard it must stay in bounds.
        set(pd, &[("depth", 0.2), ("feedback", 0.9), ("mix", 1.0)]);
        let loud = peak(&settled(pd, 2.0).0);
        assert!(loud < 12.0, "chorus with Feedback at its top stays bounded, peak {loud}");
        println!("ge-fx-chorus: a 2 ms delay swept by Depth, left and right a quarter cycle apart; peak {loud:.1} at full feedback");
    });
}

/// Phase turned by one stage of the phaser at `hz`, in radians, for a pole at `c`.
fn stage_phase(c: f64, hz: f64) -> f64 {
    let w = 2.0 * std::f64::consts::PI * hz / SAMPLE_RATE as f64;
    // (z^-1 - c) / (1 - c z^-1) on the unit circle.
    let (re_n, im_n) = (w.cos() - c, -w.sin());
    let (re_d, im_d) = (1.0 - c * w.cos(), c * w.sin());
    im_n.atan2(re_n) - im_d.atan2(re_d)
}

fn phaser(pd: &mut Pd, dir: &Path) {
    let full = std::f32::consts::FRAC_1_SQRT_2;
    // With no depth the stages sit at 784 Hz (note 79): there the four add up to a whole cycle.
    let centre = 440.0 * 2f64.powf((79.0 - 69.0) / 12.0);
    let w = std::f64::consts::PI * centre / SAMPLE_RATE as f64;
    let pole = (1.0 - w) / (1.0 + w);
    // The first notch is where they add up to half a cycle.
    let turned = |hz: f64| (4.0 * stage_phase(pole, hz)).rem_euclid(2.0 * std::f64::consts::PI);
    let notch = (100..700).map(|hz| hz as f64).min_by(|a, b| (turned(*a) - std::f64::consts::PI).abs().total_cmp(&(turned(*b) - std::f64::consts::PI).abs())).unwrap() as f32;

    with_module(pd, dir, "ge-fx-phaser", &["r t-freq", "osc~ 440"], &[[0, 0, 1, 0]], [Some(1), None, None], to_left, |pd| {
        let level = |pd: &mut Pd, hz: f32| {
            pd.send_float("t-freq", hz);
            rms(&settled(pd, 0.3).0)
        };
        // Wet only: every frequency at its level.
        set(pd, &[("rate", 1.0), ("depth", 0.0), ("feedback", 0.0), ("mix", 1.0)]);
        for hz in [100.0, notch, centre as f32, 3000.0] {
            close(level(pd, hz), full, 0.02, &format!("phaser wet alone is flat at {hz} Hz"));
        }
        // Half and half: a notch where the stages turn the phase half a cycle, nothing lost where it is a whole one.
        set(pd, &[("mix", 0.5)]);
        let (in_notch, at_centre) = (level(pd, notch), level(pd, centre as f32));
        assert!(in_notch < 0.03, "phaser has a notch at {notch} Hz, level {in_notch}");
        close(at_centre, full, 0.02, "phaser passes its centre frequency");

        // With depth the notch moves: a tone at that frequency comes and goes.
        set(pd, &[("depth", 0.5), ("rate", 5.0)]);
        pd.send_float("t-freq", notch);
        let swept = settled(pd, 1.0).0;
        let levels: Vec<f32> = swept.chunks(441).map(rms).collect();
        let (low, high) = levels.iter().fold((f32::MAX, f32::MIN), |(lo, hi), v| (lo.min(*v), hi.max(*v)));
        assert!(low < 0.15 && high > 0.5, "phaser sweeps its notch across the tone, level {low}..{high}");

        set(pd, &[("depth", 0.3), ("feedback", 0.9), ("mix", 1.0)]);
        let loud = peak(&settled(pd, 2.0).0);
        assert!(loud < 12.0, "phaser with Feedback at its top stays bounded, peak {loud}");
        println!("ge-fx-phaser: flat when wet, notch at {notch:.0} Hz (level {in_notch:.3}) mixed, swept by Depth; peak {loud:.1} at full feedback");
    });
}

fn reverb(pd: &mut Pd, dir: &Path) {
    let boxes = ["noise~", "r t-amp", "*~ 0"];
    let connections = [[0, 0, 2, 0], [1, 0, 2, 1]];
    with_module(pd, dir, "ge-fx-reverb", &boxes, &connections, [Some(2), None, None], both_outlets, |pd| {
        set(pd, &[("size", 0.5), ("decay", 1.0), ("damp", 0.0), ("mix", 1.0)]);
        assert_eq!(peak(&render(pd, 0.3).0), 0.0, "reverb is silent without input");

        // Noise at 0.5, then nothing: how loud the room is, and how it dies away.
        let burst = |pd: &mut Pd| {
            pd.send_float("t-amp", 0.5);
            let steady = render(pd, 1.5);
            pd.send_float("t-amp", 0.0);
            (steady, render(pd, 1.5))
        };
        let (steady, tail) = burst(pd);
        let (left, right) = (rms(&steady.0[22050..]), rms(&steady.1[22050..]));
        let input = 0.5 / 3f32.sqrt();
        assert!(left > input * 0.4 && left < input * 2.5, "reverb's wet level is near its input's {input}, got {left}");
        assert!((db(left / right)).abs() < 3.0, "reverb: left and right are as loud as each other, {left} / {right}");
        let difference: Vec<f32> = steady.0.iter().zip(&steady.1).map(|(a, b)| a - b).collect();
        assert!(rms(&difference) > left * 0.5, "reverb: left and right are not the same signal");
        // Decay is the time to fall 60 dB: from 100 to 600 ms that is 30 dB at 1 s.
        let fall = db(rms_between(&tail.0, 100.0, 200.0) / rms_between(&tail.0, 600.0, 700.0));
        close(fall, 30.0, 6.0, "reverb falls 30 dB in half its Decay");

        set(pd, &[("decay", 0.3)]);
        let (_, tail) = burst(pd);
        let quick = db(rms_between(&tail.0, 50.0, 100.0) / rms_between(&tail.0, 200.0, 250.0));
        close(quick, 30.0, 8.0, "reverb at Decay 0.3 s falls 30 dB in 150 ms");

        // Damp takes the highs out of every pass, so a damped room is quieter sooner.
        set(pd, &[("decay", 1.0), ("damp", 0.9)]);
        let (_, damped) = burst(pd);
        set(pd, &[("damp", 0.0)]);
        let (_, open) = burst(pd);
        let (dull, bright) = (rms_between(&damped.0, 300.0, 400.0), rms_between(&open.0, 300.0, 400.0));
        assert!(dull < bright * 0.7, "reverb with Damp up dies away sooner: {dull} against {bright}");

        // The longest, largest room stays in bounds.
        set(pd, &[("size", 1.0), ("decay", 20.0)]);
        pd.send_float("t-amp", 0.5);
        let loud = peak(&render(pd, 4.0).0);
        assert!(loud < 6.0, "reverb at its longest stays bounded, peak {loud}");
        println!("ge-fx-reverb: wet level {left:.3} / {right:.3} for an input of {input:.3}; falls {fall:.0} dB in 0.5 s at Decay 1 s, {quick:.0} dB in 0.15 s at 0.3 s; peak {loud:.1} at its longest");
    });
    // Dry only: the input, untouched.
    with_shaper(pd, dir, "ge-fx-reverb", |pd| {
        set(pd, &[("size", 0.5), ("decay", 1.0), ("damp", 0.3), ("mix", 0.0)]);
        pd.send_float("t-amp", 0.8);
        let (out, input) = settled(pd, 0.2);
        let apart = out.iter().zip(&input).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(apart < 0.0001, "reverb at Mix 0 is its input, off by {apart}");
    });
}

// --- setting inputs ------------------------------------------------------------------------

/// One render of a module with a knob at `knob` and that setting's input at `input`.
fn with_setting(pd: &mut Pd, dir: &Path, name: &str, inlet: usize, receiver: &str, knob: f32, input: f32) -> Vec<f32> {
    let measure = |pd: &mut Pd| {
        pd.send_float("t-amp", 0.8);
        pd.send_float("t-freq", 330.0);
        pd.send_float("t1-cutoff", 1500.0);
        pd.send_float("t1-res", 0.3);
        pd.send_float("t1-drive", 12.0);
        pd.send_float("t1-order", 3.0);
        pd.send_float("t1-amount", 1.0);
        pd.send_float("t1-rate", 6000.0);
        pd.send_float("t1-bits", 6.0);
        if name == "ge-lfo" {
            pd.send_float("t1-rate", 8.0);
        }
        if name.starts_with("ge-fx-") {
            set(pd, &[("time", 80.0), ("feedback", 0.3), ("tone", 5000.0), ("mix", 0.5), ("rate", 1.0)]);
            set(pd, &[("depth", 0.5), ("size", 0.5), ("decay", 0.5), ("damp", 0.3)]);
        }
        pd.send_float(&format!("t1-{receiver}"), knob);
        pd.send_float(&format!("t-in{inlet}"), input);
        render(pd, 0.3).0
    };
    if name.starts_with("ge-osc-") {
        with_oscillator(pd, dir, name, measure)
    } else if name == "ge-lfo" {
        with_lfo(pd, dir, measure)
    } else if name.starts_with("ge-filter-") {
        let kind = [Kind::Low, Kind::High, Kind::Band, Kind::Notch].into_iter().find(|k| k.abstraction() == name).unwrap();
        with_filter(pd, dir, kind, measure)
    } else {
        with_shaper(pd, dir, name, measure)
    }
}

/// Every setting has an input that its knob multiplies: the knob at `v` with the input at
/// `k` must give what the knob at `v * k` gives with the input at 1, sample for sample.
/// Each render opens the patch afresh, so oscillators start from the same phase. The first
/// 150 ms are left out: a cutoff is smoothed as a pitch, so on its way to 4000 Hz times
/// 0.25 it does not pass through the same frequencies as on its way to 1000 Hz.
fn setting_inputs(pd: &mut Pd, dir: &Path) {
    // Module, inlet of the setting's input, the knob's receiver, knob value, input value.
    let cases: &[(&str, usize, &str, f32, f32)] = &[
        ("ge-osc-sine", 1, "tune", 12.0, 0.5),
        ("ge-osc-sine", 2, "fine", 80.0, -0.5),
        ("ge-osc-tri", 1, "tune", -7.0, 2.0),
        ("ge-osc-tri", 2, "fine", 50.0, 0.25),
        ("ge-osc-saw", 1, "tune", 24.0, 0.25),
        ("ge-osc-saw", 2, "fine", -60.0, 0.5),
        ("ge-osc-pulse", 1, "tune", 12.0, -0.5),
        ("ge-osc-pulse", 2, "fine", 80.0, 0.5),
        ("ge-osc-pulse", 3, "width", 80.0, 0.25),
        ("ge-filter-lp", 1, "cutoff", 4000.0, 0.25),
        ("ge-filter-lp", 2, "res", 0.8, 0.5),
        ("ge-filter-hp", 1, "cutoff", 250.0, 4.0),
        ("ge-filter-hp", 2, "res", 0.4, 2.0),
        ("ge-filter-bp", 1, "cutoff", 2400.0, 0.125),
        ("ge-filter-bp", 2, "res", 1.0, 0.25),
        ("ge-filter-notch", 1, "cutoff", 660.0, 0.5),
        ("ge-filter-notch", 2, "res", 0.6, 0.5),
        ("ge-shaper-soft", 1, "drive", 24.0, 0.5),
        ("ge-shaper-soft", 3, "bias", 0.8, 0.5),
        ("ge-shaper-hard", 1, "drive", 24.0, 0.25),
        ("ge-shaper-fold", 1, "drive", 20.0, 0.5),
        ("ge-shaper-fold", 3, "symmetry", 0.8, -0.5),
        ("ge-shaper-cheby", 1, "order", 6.0, 0.5),
        ("ge-shaper-cheby", 3, "drive", -12.0, 0.5),
        ("ge-shaper-rectify", 1, "amount", 1.0, 0.25),
        ("ge-shaper-crush", 2, "bits", 8.0, 0.5),
        ("ge-lfo", 1, "rate", 16.0, 0.5),
        ("ge-lfo", 2, "level", 0.8, 0.5),
        ("ge-fx-delay", 1, "time", 160.0, 0.5),
        ("ge-fx-delay", 2, "feedback", 0.8, 0.5),
        ("ge-fx-delay", 3, "tone", 800.0, 0.25),
        ("ge-fx-delay", 4, "mix", 0.8, 0.5),
        ("ge-fx-chorus", 1, "rate", 4.0, 0.5),
        ("ge-fx-chorus", 2, "depth", 0.8, 0.5),
        ("ge-fx-chorus", 3, "feedback", 0.8, 0.5),
        ("ge-fx-chorus", 4, "mix", 0.8, 0.5),
        ("ge-fx-phaser", 1, "rate", 4.0, 0.5),
        ("ge-fx-phaser", 2, "depth", 0.8, 0.5),
        ("ge-fx-phaser", 3, "feedback", 0.8, 0.5),
        ("ge-fx-phaser", 4, "mix", 0.8, 0.5),
        ("ge-fx-reverb", 1, "size", 0.8, 0.5),
        ("ge-fx-reverb", 2, "decay", 2.0, 0.25),
        ("ge-fx-reverb", 3, "damp", 0.8, 0.5),
        ("ge-fx-reverb", 4, "mix", 0.8, 0.5),
    ];
    let mut worst = 0.0f32;
    for &(name, inlet, receiver, knob, input) in cases {
        let what = format!("{name} {receiver} {knob} x {input}");
        let scaled = with_setting(pd, dir, name, inlet, receiver, knob, input);
        let direct = with_setting(pd, dir, name, inlet, receiver, knob * input, 1.0);
        let untouched = with_setting(pd, dir, name, inlet, receiver, knob, 1.0);
        let apart = |a: &[f32], b: &[f32]| a[6615..].iter().zip(&b[6615..]).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(rms(&scaled) > 0.01, "{what}: the module is making sound (rms {})", rms(&scaled));
        assert!(apart(&scaled, &untouched) > 0.01, "{what}: the input changes the output");
        let error = apart(&scaled, &direct);
        assert!(error < 0.001, "{what}: differs by {error} from the knob at {}", knob * input);
        worst = worst.max(error);
    }
    println!("setting inputs: knob x input matches the knob alone in {} cases, within {worst:.6}", cases.len());

    // The crusher's Rate moves a clock, where a rounding difference shifts a step by a sample:
    // count the steps instead.
    let steps = |pd: &mut Pd, knob: f32, input: f32| {
        steps_per_second(&with_setting(pd, dir, "ge-shaper-crush", 1, "rate", knob, input)[4410..])
    };
    let (scaled, direct) = (steps(pd, 8000.0, 0.25), steps(pd, 2000.0, 1.0));
    close(scaled, direct, 20.0, "crusher Rate 8000 x 0.25 steps as often as Rate 2000");
    println!("ge-shaper-crush: {scaled:.0} steps a second at Rate 8000 x 0.25, {direct:.0} at Rate 2000");

    // The multiplication is per sample: a 100 Hz wobble on a low-pass's Cutoff input puts side
    // bands 100 Hz either side of a tone sitting on the filter's slope.
    let boxes = ["osc~ 1000", "osc~ 100", "*~ 0.5", "+~ 1"];
    let connections = [[1, 0, 2, 0], [2, 0, 3, 0]];
    let wobbling = |module: usize| (vec!["dac~ 1"], vec![[module, 0, module + 1, 0], [3, 0, module, 1]]);
    let side_band = with_module(pd, dir, "ge-filter-lp", &boxes, &connections, [Some(0), None, None], wobbling, |pd| {
        pd.send_float("t1-cutoff", 1000.0);
        pd.send_float("t1-res", 0.2);
        // Take the input's own [sig~ 1] out of the sum: the wobble already swings around 1.
        pd.send_float("t-in1", 0.0);
        let wave = settled(pd, 1.0).0;
        (amplitude_at(&wave, 900.0), amplitude_at(&wave, 1100.0), amplitude_at(&wave, 1000.0))
    });
    assert!(side_band.0 > 0.05 && side_band.1 > 0.05, "cutoff input at audio rate makes side bands, got {side_band:?}");
    println!(
        "ge-filter-lp: cutoff input wobbling at 100 Hz: side bands {:.3} / {:.3} around a tone of {:.3}",
        side_band.0, side_band.1, side_band.2
    );
}

/// The Amp is its input times Level times CV, and CV rests at 1.
fn amp_and_output(pd: &mut Pd, dir: &Path) {
    with_module(pd, dir, "ge-amp", &["sig~ 0.5"], &[], [Some(0), None, None], to_left, |pd| {
        pd.send_float("t1-level", 0.8);
        close(mean(&settled(pd, 0.1).0), 0.4, 0.001, "amp with nothing in CV passes its input at Level");
        pd.send_float("t-in1", 0.5);
        close(mean(&settled(pd, 0.1).0), 0.2, 0.001, "amp CV 0.5 halves it");
        pd.send_float("t-in1", 0.0);
        assert_eq!(peak(&settled(pd, 0.1).0), 0.0, "amp CV 0 closes it");
        println!("ge-amp: in x Level x CV, open with nothing in CV");
    });

    // Audio Out throws to the host's buses: catch them as the host does.
    let caught = |_module: usize| (vec!["catch~ outL", "dac~ 1", "catch~ outR", "dac~ 2"], vec![[2, 0, 3, 0], [4, 0, 5, 0]]);
    with_module(pd, dir, "ge-audio-out", &["sig~ 0.5"], &[], [Some(0), None, None], caught, |pd| {
        pd.send_float("t1-level", 0.5);
        let (left, right) = settled(pd, 0.1);
        close(mean(&left), 0.25, 0.001, "audio out left is its input times Level");
        close(mean(&right), 0.25, 0.001, "audio out right likewise");
        pd.send_float("t-in2", 0.5);
        close(mean(&settled(pd, 0.1).0), 0.125, 0.001, "audio out Level input 0.5 halves it");
        println!("ge-audio-out: both channels x Level x its input");
    });
}

#[test]
fn modules_do_what_they_are_designed_to() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = bench();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE as u32).unwrap();
    pd.dsp(true);
    events.try_iter().for_each(drop);

    oscillators(&mut pd, &dir);
    modulation(&mut pd, &dir);
    linear_fm_spectrum(&mut pd, &dir);
    pulse_width(&mut pd, &dir);
    saw_aliasing(&mut pd, &dir);
    noise(&mut pd, &dir);
    filters(&mut pd, &dir);
    clips_and_folder(&mut pd, &dir);
    rectifier(&mut pd, &dir);
    bitcrusher(&mut pd, &dir);
    chebyshev(&mut pd, &dir);
    mixer(&mut pd, &dir);
    envelope(&mut pd, &dir);
    lfo(&mut pd, &dir);
    random(&mut pd, &dir);
    all_pass(&mut pd, &dir);
    delay(&mut pd, &dir);
    chorus(&mut pd, &dir);
    phaser(&mut pd, &dir);
    reverb(&mut pd, &dir);
    setting_inputs(&mut pd, &dir);
    amp_and_output(&mut pd, &dir);

    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events
        .try_iter()
        .filter_map(|e| if let gridelle_lib::engine::pd::PdEvent::Print(text) = e { Some(text) } else { None })
        .collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
