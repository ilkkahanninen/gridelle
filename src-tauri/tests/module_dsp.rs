//! Measures what the module abstractions in `pd-lib/modules` actually do, in real Pd:
//! oscillator pitch, level, aliasing and modulation, filter frequency responses, the
//! shapers' curves, mixer sums, the envelope's stages, the LFOs, the effects, the wrappers of
//! Pd's own filters and reverbs, the pitch, math and logic modules, the clock and the
//! sequencer, and that every setting's input multiplies its knob.
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
        "ge-fx-delay" | "ge-fx-chorus" | "ge-fx-phaser" | "ge-fx-reverb" | "ge-fx-room" | "ge-fx-hall" => &[Main, Setting, Setting, Setting, Setting],
        "ge-filter-ladder" | "ge-filter-resonator" => &[Main, Setting, Setting, Mod],
        "ge-filter-soft-lp" | "ge-filter-soft-hp" => &[Main, Setting, Mod],
        "ge-fx-cavern" | "ge-follower" => &[Main, Setting, Setting],
        "ge-sample-hold" | "ge-pitch-quantize" => &[Main, Mod],
        "ge-math-add" | "ge-math-multiply" | "ge-math-min" | "ge-math-max" | "ge-logic-and" | "ge-logic-or" => &[Main, Mod],
        "ge-math-abs" | "ge-logic-not" | "ge-logic-toggle" => &[Main],
        "ge-math-constant" => &[Setting],
        "ge-math-scale" | "ge-math-smooth" => &[Main, Setting, Setting],
        "ge-math-crossfade" => &[Main, Mod, Setting],
        "ge-logic-compare" | "ge-logic-divider" => &[Main, Setting],
        "ge-pitch-transpose" => &[Main, Setting, Setting, Mod],
        "ge-pitch-glide" => &[Main, Setting],
        "ge-shaper-soft" | "ge-shaper-fold" | "ge-shaper-cheby" => &[Main, Setting, Mod, Setting],
        "ge-shaper-hard" | "ge-shaper-rectify" => &[Main, Setting, Mod],
        "ge-shaper-crush" => &[Main, Setting, Setting, Mod],
        "ge-amp" => &[Main, Setting],
        "ge-lfo" | "ge-clock" => &[Main, Setting, Setting],
        "ge-sequencer" => &[Main, Mod, Pwm, Setting, Setting, Setting, Setting, Setting, Setting, Setting, Setting, Setting],
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
    with_filter_named(pd, dir, kind.abstraction(), measure)
}

/// The same for any filter abstraction. The sine's frequency is set through `t-freq`.
fn with_filter_named<T>(pd: &mut Pd, dir: &Path, name: &str, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-freq", "osc~ 440", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0]];
    with_module(pd, dir, name, &boxes, &connections, [Some(1), Some(3), None], to_left, measure)
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

// --- wrappers of Pd's own filters and reverbs ----------------------------------------------

/// The soft filters are `lop~` and `hip~` rebuilt so that the cutoff can move at audio rate:
/// with a fixed cutoff they must give what the objects themselves give, here on the right.
fn soft_filters(pd: &mut Pd, dir: &Path) {
    let mut worst = 0.0f32;
    for (name, object) in [("ge-filter-soft-lp", "lop~ 1000"), ("ge-filter-soft-hp", "hip~ 1000")] {
        let boxes = ["r t-freq", "osc~ 440", "r t-mod", "sig~ 0", "r t-cut", object, "dac~ 2"];
        let connections = [[0, 0, 1, 0], [2, 0, 3, 0], [4, 0, 5, 1], [1, 0, 5, 0], [5, 0, 6, 0]];
        with_module(pd, dir, name, &boxes, &connections, [Some(1), Some(3), None], to_left, |pd| {
            for cutoff in [200.0, 1000.0, 6000.0] {
                for hz in [80.0, 1000.0, 9000.0] {
                    pd.send_float("t1-cutoff", cutoff);
                    pd.send_float("t-cut", cutoff);
                    pd.send_float("t-freq", hz);
                    let (ours, theirs) = settled(pd, 0.2);
                    let apart = ours.iter().zip(&theirs).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                    assert!(apart < 0.002, "{name} at {cutoff} Hz differs from [{object}] by {apart} for a {hz} Hz sine");
                    assert!(rms(&theirs) > 0.0005, "{object} lets something through to compare with");
                    worst = worst.max(apart);
                }
            }
        });
    }
    println!("ge-filter-soft-lp / -hp: within {worst:.5} of Pd's own lop~ and hip~");
}

/// Gain in dB of a filter for a quiet sine at `hz` (quiet, because the Ladder saturates).
fn quiet_db(pd: &mut Pd, hz: f32) -> f32 {
    pd.send_float("t-freq", hz);
    db(rms(&settled(pd, 0.3).0) / (0.1 * std::f32::consts::FRAC_1_SQRT_2))
}

/// A filter abstraction fed a sine of amplitude 0.1; with `both`, its two outlets left and right.
fn with_quiet_filter<T>(pd: &mut Pd, dir: &Path, name: &str, both: bool, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-freq", "osc~ 440", "*~ 0.1", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [1, 0, 2, 0], [3, 0, 4, 0]];
    let after = if both { both_outlets } else { to_left };
    with_module(pd, dir, name, &boxes, &connections, [Some(2), Some(4), None], after, measure)
}

fn ladder(pd: &mut Pd, dir: &Path) {
    with_quiet_filter(pd, dir, "ge-filter-ladder", false, |pd| {
        let curve = |pd: &mut Pd, res: f32| -> Vec<f32> {
            set(pd, &[("cutoff", 1000.0), ("res", res)]);
            [125.0, 500.0, 1000.0, 2000.0, 8000.0].iter().map(|hz| quiet_db(pd, *hz)).collect()
        };
        let (plain, half, high) = (curve(pd, 0.0), curve(pd, 0.5), curve(pd, 0.8));
        println!("ge-filter-ladder at 1 kHz, gain in dB at 125 / 500 / 1k / 2k / 8k Hz: Res 0 {plain:.1?}, Res 0.5 {half:.1?}, Res 0.8 {high:.1?}");
        // A low-pass: lows pass and highs fall away. With Pd 0.49's bob~ that is 6 dB an octave,
        // the first of its four stages: three octaves up it is 18 dB down.
        assert!(plain[0].abs() < 1.0, "ladder passes lows at Res 0, {} dB", plain[0]);
        close(plain[2], -3.0, 1.0, "ladder is 3 dB down at its cutoff at Res 0");
        close(plain[4], -18.0, 2.0, "ladder falls 6 dB an octave above its cutoff");
        // Resonance lifts the cutoff and takes from the lows, as on the original.
        assert!(high[2] > high[0] + 15.0, "ladder has a peak at the cutoff with Res up: {} dB against {} for lows", high[2], high[0]);
        assert!(half[0] < plain[0] - 6.0, "ladder's resonance takes from the lows: {} dB against {}", half[0], plain[0]);

        // At full Res it sings by itself, at its cutoff: here with next to nothing going in.
        set(pd, &[("cutoff", 700.0), ("res", 1.0)]);
        pd.send_float("t-freq", 50.0);
        let singing = settled(pd, 1.0).0;
        assert!(rms(&singing) > 0.3, "ladder sings at full Res, rms {}", rms(&singing));
        close(frequency(&singing), 700.0, 35.0, "ladder sings at its cutoff");
        // The Cutoff input closes it.
        set(pd, &[("cutoff", 4000.0), ("res", 0.0)]);
        let open = quiet_db(pd, 1000.0);
        pd.send_float("t-in1", 0.0625);
        let closed = quiet_db(pd, 1000.0);
        assert!(closed < open - 6.0, "ladder's Cutoff input closes it: {closed} dB against {open}");
        println!("ge-filter-ladder: sings at {:.0} Hz (rms {:.2}) at full Res with its cutoff at 700 Hz", frequency(&singing), rms(&singing));
    });
    // Wide open, full resonance, full level: it must stay in bounds.
    let loud = with_filter_named(pd, dir, "ge-filter-ladder", |pd| {
        let mut worst = 0.0f32;
        for (cutoff, res) in [(18000.0, 1.0), (18000.0, 0.0), (60.0, 1.0), (2000.0, 1.0)] {
            set(pd, &[("cutoff", cutoff), ("res", res)]);
            for hz in [50.0, 2000.0, 15000.0] {
                pd.send_float("t-freq", hz);
                let out = settled(pd, 0.3).0;
                assert!(out.iter().all(|v| v.is_finite()), "ladder stays finite at cutoff {cutoff}, res {res}, {hz} Hz");
                worst = worst.max(peak(&out));
            }
        }
        worst
    });
    assert!(loud < 4.0, "ladder stays in bounds, peak {loud}");
    println!("ge-filter-ladder: peak {loud:.2} at its extremes with a full-level sine");
}

fn resonator(pd: &mut Pd, dir: &Path) {
    with_quiet_filter(pd, dir, "ge-filter-resonator", true, |pd| {
        // (band, low) in dB for a sine at `hz`.
        let levels = |pd: &mut Pd, hz: f32| {
            pd.send_float("t-freq", hz);
            let (band, low) = settled(pd, 0.3);
            let full = 0.1 * std::f32::consts::FRAC_1_SQRT_2;
            (db(rms(&band) / full), db(rms(&low) / full))
        };
        // Res is read every 10 ms: give it that before measuring.
        let tuned = |pd: &mut Pd, cutoff: f32, res: f32| {
            set(pd, &[("cutoff", cutoff), ("res", res)]);
            render(pd, 0.05);
        };
        // It rings at its cutoff: full level there, less either side, and narrower as Res rises.
        tuned(pd, 1000.0, 0.5);
        let (at, below, above) = (levels(pd, 1000.0), levels(pd, 500.0), levels(pd, 2000.0));
        close(at.0, 0.0, 1.5, "resonator's band output is at full level at its cutoff");
        assert!(below.0 < -12.0 && above.0 < -12.0, "resonator falls away an octave either side: {} and {} dB", below.0, above.0);
        tuned(pd, 1000.0, 0.9);
        let narrow = levels(pd, 500.0);
        assert!(narrow.0 < below.0 - 10.0, "resonator is narrower with Res up: {} dB an octave down against {}", narrow.0, below.0);
        // The low output keeps what is below the cutoff, and loses the highs faster.
        tuned(pd, 1000.0, 0.5);
        let (low_lows, low_highs, band_lows) = (levels(pd, 125.0).1, levels(pd, 8000.0).1, levels(pd, 125.0).0);
        assert!(low_lows > band_lows + 8.0, "resonator's low output keeps lows the band loses: {low_lows} dB against {band_lows}");
        assert!(low_highs < low_lows - 25.0, "resonator's low output loses the highs: {low_highs} dB against {low_lows}");
        // It works all the way up, which a low-pass built on vcf~ once did not.
        tuned(pd, 18000.0, 0.5);
        pd.send_float("t-in1", 1.2);
        let top = levels(pd, 18000.0);
        assert!(top.0 > -6.0 && top.0 < 6.0 && top.1.is_finite(), "resonator still works at the top of its range: {top:?}");
        pd.send_float("t-in1", 1.0);
        // The Res input multiplies Res: 0.8 x 0.5 is as narrow as 0.4.
        tuned(pd, 1000.0, 0.4);
        let direct = levels(pd, 500.0).0;
        set(pd, &[("res", 0.8)]);
        pd.send_float("t-in2", 0.5);
        render(pd, 0.05);
        close(levels(pd, 500.0).0, direct, 0.2, "resonator's Res input multiplies Res");
        println!("ge-filter-resonator at 1 kHz: band {:.1} dB at the cutoff, {:.1} / {:.1} an octave down at Res 0.5 / 0.9; low output {low_lows:.1} dB at 125 Hz, {low_highs:.1} at 8 kHz", at.0, below.0, narrow.0);
    });
}

/// Seconds for the tail to fall 60 dB, from its slope between two windows.
fn decay_time(tail: &[f32], from: f32, to: f32, window: f32) -> f32 {
    let fall = db(rms_between(tail, from, from + window) / rms_between(tail, to, to + window));
    60.0 * (to - from) / 1000.0 / fall
}

/// Seconds until the tail has fallen 60 dB below `level`, measured in 50 ms windows.
fn time_to_silence(tail: &[f32], level: f32) -> f32 {
    tail.chunks(2205).position(|window| rms(window) < level * 0.001).map(|i| i as f32 * 0.05).unwrap_or(f32::INFINITY)
}

fn pd_reverbs(pd: &mut Pd, dir: &Path) {
    let boxes = ["noise~", "r t-amp", "*~ 0"];
    let connections = [[0, 0, 2, 0], [1, 0, 2, 1]];
    let input = 0.5 / 3f32.sqrt();
    // The two decay times to measure. The Cavern cannot do short ones: its delays are too long.
    for (name, stereo, short, long) in [("ge-fx-cavern", false, 3.0, 8.0), ("ge-fx-room", true, 1.0, 4.0), ("ge-fx-hall", true, 1.0, 4.0)] {
        let after = if stereo { both_outlets } else { to_left };
        with_module(pd, dir, name, &boxes, &connections, [Some(2), None, None], after, |pd| {
            // Decay, Damp and Tone are read every 10 ms: give them that before going on.
            let tuned = |pd: &mut Pd, settings: &[(&str, f32)]| {
                set(pd, settings);
                render(pd, 0.05);
            };
            // Noise for two seconds, then the tail.
            let burst = |pd: &mut Pd, tail: f32| {
                pd.send_float("t-amp", 0.5);
                let steady = render(pd, 2.0);
                pd.send_float("t-amp", 0.0);
                (steady, render(pd, tail))
            };
            tuned(pd, &[("decay", short), ("damp", 0.0), ("tone", 3000.0), ("mix", 1.0)]);
            assert_eq!(peak(&render(pd, 0.3).0), 0.0, "{name} is silent without input");

            let (steady, tail) = burst(pd, short * 2.0);
            let level = rms(&steady.0[44100..]);
            assert!(level > input * 0.5 && level < input * 2.0, "{name}'s wet level is near its input's {input}, got {level}");
            let brief = if stereo { decay_time(&tail.0, 100.0, 500.0, 100.0) } else { time_to_silence(&tail.0, level) };
            close(brief, short, short * 0.25, &format!("{name} rings for its Decay of {short} s"));
            if stereo {
                let right = rms(&steady.1[44100..]);
                assert!(db(level / right).abs() < 3.0, "{name}: left and right are as loud as each other, {level} / {right}");
                let difference: Vec<f32> = steady.0.iter().zip(&steady.1).map(|(a, b)| a - b).collect();
                assert!(rms(&difference) > level * 0.5, "{name}: left and right are not the same signal");
            }

            tuned(pd, &[("decay", long)]);
            let (steady, tail) = burst(pd, long * 2.0);
            let level = rms(&steady.0[44100..]);
            let lasting = if stereo { decay_time(&tail.0, 200.0, 1700.0, 300.0) } else { time_to_silence(&tail.0, level) };
            close(lasting, long, long * 0.25, &format!("{name} rings for its Decay of {long} s"));

            // The Decay input multiplies the time.
            pd.send_float("t-in1", short / long);
            render(pd, 0.05);
            let (steady, tail) = burst(pd, short * 2.0);
            let scaled = if stereo { decay_time(&tail.0, 100.0, 500.0, 100.0) } else { time_to_silence(&tail.0, rms(&steady.0[44100..])) };
            close(scaled, brief, short * 0.15, &format!("{name}'s Decay input multiplies the time"));
            pd.send_float("t-in1", 1.0);

            if stereo {
                // Damp takes the highs above Tone out of every pass, so the room is quiet sooner.
                tuned(pd, &[("decay", long), ("damp", 0.0)]);
                let (_, open) = burst(pd, 1.5);
                tuned(pd, &[("damp", 1.0), ("tone", 1000.0)]);
                let (_, damped) = burst(pd, 1.5);
                let (bright, dull) = (rms_between(&open.0, 800.0, 1200.0), rms_between(&damped.0, 800.0, 1200.0));
                assert!(dull < bright * 0.7, "{name} with Damp up dies away sooner: {dull} against {bright}");
            }

            // The longest room, fed all the time, stays in bounds.
            tuned(pd, &[("decay", 40.0), ("damp", 0.0)]);
            pd.send_float("t-amp", 0.5);
            let loud = peak(&render(pd, 6.0).0);
            assert!(loud < 8.0, "{name} at its longest stays bounded, peak {loud}");
            pd.send_float("t-amp", 0.0);
            println!("{name}: wet level {level:.3} for an input of {input:.3}; rings {brief:.2} s at {short} s, {lasting:.2} s at {long} s, {scaled:.2} s at {long} s x {:.2}; peak {loud:.1} at its longest", short / long);
        });
        // Dry only: the input, untouched.
        with_shaper(pd, dir, name, |pd| {
            set(pd, &[("decay", 3.0), ("damp", 0.3), ("tone", 3000.0), ("mix", 0.0)]);
            pd.send_float("t-amp", 0.8);
            let (out, dry) = settled(pd, 0.2);
            let apart = out.iter().zip(&dry).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(apart < 0.0001, "{name} at Mix 0 is its input, off by {apart}");
        });
    }
}

fn sample_and_hold(pd: &mut Pd, dir: &Path) {
    // A 50 Hz sine to sample, on the right channel too; the trigger is a [sig~] set through t-trig.
    let boxes = ["osc~ 50", "r t-trig", "sig~"];
    let heard = |module: usize| (vec!["dac~ 1", "dac~ 2"], vec![[module, 0, module + 1, 0], [0, 0, module + 2, 0]]);
    with_module(pd, dir, "ge-sample-hold", &boxes, &[[1, 0, 2, 0]], [Some(0), Some(2), None], heard, |pd| {
        assert_eq!(peak(&render(pd, 0.1).0), 0.0, "sample & hold gives nothing before its first trigger");
        let mut held = Vec::new();
        for _ in 0..3 {
            pd.send_float("t-trig", 1.0);
            let (out, input) = render(pd, 0.137);
            assert!(out.iter().all(|v| *v == input[0]), "sample & hold takes the input as the trigger rises ({}) and keeps it", input[0]);
            pd.send_float("t-trig", 0.0);
            let (after, _) = render(pd, 0.05);
            assert!(after.iter().all(|v| *v == input[0]), "sample & hold keeps its value when the trigger falls");
            held.push(input[0]);
        }
        assert!(held[0] != held[1] && held[1] != held[2], "sample & hold takes a new value each time, got {held:?}");
        // Half way up is not a trigger; above it is.
        pd.send_float("t-trig", 0.4);
        assert!(render(pd, 0.05).0.iter().all(|v| *v == held[2]), "a trigger below a half does nothing");
        println!("ge-sample-hold: took {held:.3?} at three triggers");
    });
}

fn follower(pd: &mut Pd, dir: &Path) {
    with_shaper(pd, dir, "ge-follower", |pd| {
        set(pd, &[("smooth", 20.0), ("level", 1.0)]);
        pd.send_float("t-amp", 0.0);
        assert!(peak(&settled(pd, 0.3).0) < 0.0001, "follower is at zero for silence");
        // A sine of amplitude 0.8 has an rms of 0.8 / sqrt(2).
        pd.send_float("t-amp", 0.8);
        let expected = 0.8 * std::f32::consts::FRAC_1_SQRT_2;
        let level = settled(pd, 0.3).0;
        close(mean(&level), expected, 0.02, "follower gives the rms level of its input");
        set(pd, &[("level", 2.0)]);
        close(mean(&settled(pd, 0.3).0), 2.0 * expected, 0.04, "follower times Level");
        pd.send_float("t-in2", 0.25);
        close(mean(&settled(pd, 0.3).0), 0.5 * expected, 0.02, "follower's Level input multiplies Level");
        pd.send_float("t-in2", 1.0);
        set(pd, &[("level", 1.0)]);
        // Smooth is how long it takes to get to each new measurement.
        let rise = |pd: &mut Pd, smooth: f32, input: f32| {
            set(pd, &[("smooth", smooth)]);
            pd.send_float("t-in1", input);
            pd.send_float("t-amp", 0.0);
            render(pd, 1.5);
            pd.send_float("t-amp", 0.8);
            level_at(&render(pd, 0.2).0, 120.0)
        };
        let (quick, slow, scaled) = (rise(pd, 20.0, 1.0), rise(pd, 800.0, 1.0), rise(pd, 800.0, 0.025));
        assert!(quick > expected * 0.9, "follower with Smooth 20 ms is there after 120 ms, at {quick}");
        assert!(slow < expected * 0.5, "follower with Smooth 800 ms is still on its way after 120 ms, at {slow}");
        assert!(scaled > expected * 0.9, "follower's Smooth input multiplies Smooth: 800 ms x 0.025 is quick, at {scaled}");
        pd.send_float("t-amp", 0.0);
        assert!(peak(&settled(pd, 1.0).0) < 0.0001, "follower returns to zero");
        println!("ge-follower: {:.3} for a sine of 0.8 (rms {expected:.3}); 120 ms after it starts: {quick:.3} at Smooth 20 ms, {slow:.3} at 800 ms", mean(&level));
    });
}

// --- pitch ---------------------------------------------------------------------------------

/// A pitch module with a `[sig~]` on its Pitch input (set through `t-pitch`, 60 to begin
/// with) and one on its Mod input (`t-mod`).
fn with_pitch<T>(pd: &mut Pd, dir: &Path, name: &str, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-pitch", "sig~ 60", "r t-mod", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0]];
    with_module(pd, dir, name, &boxes, &connections, [Some(1), Some(3), None], to_left, measure)
}

/// The pitch a module settles on.
fn settled_pitch(pd: &mut Pd) -> f32 {
    *settled(pd, 0.1).0.last().unwrap()
}

fn pitch_modules(pd: &mut Pd, dir: &Path) {
    with_pitch(pd, dir, "ge-pitch-transpose", |pd| {
        set(pd, &[("octave", 0.0), ("semi", 0.0), ("mod", 2.0)]);
        close(settled_pitch(pd), 60.0, 0.001, "transpose at zero leaves the pitch alone");
        set(pd, &[("octave", 1.0), ("semi", 7.0)]);
        close(settled_pitch(pd), 79.0, 0.001, "transpose up an octave and a fifth");
        set(pd, &[("octave", -2.0), ("semi", -3.0)]);
        close(settled_pitch(pd), 33.0, 0.001, "transpose down two octaves and three semitones");
        pd.send_float("t-mod", 0.5);
        close(settled_pitch(pd), 34.0, 0.001, "transpose adds Mod times its amount, in semitones");
        pd.send_float("t-mod", -1.0);
        close(settled_pitch(pd), 31.0, 0.001, "and takes it away for a negative signal");
        println!("ge-pitch-transpose: octaves, semitones and Mod add up");
    });

    with_pitch(pd, dir, "ge-pitch-glide", |pd| {
        // From 48 to 60 with Time at 100 ms: a third of the way there in time it has covered
        // 1 - 1/e of the distance, and 95 % at the end of it.
        set(pd, &[("time", 100.0)]);
        pd.send_float("t-pitch", 48.0);
        close(settled_pitch(pd), 48.0, 0.01, "glide arrives");
        render(pd, 1.0);
        pd.send_float("t-pitch", 60.0);
        let slide = render(pd, 0.3).0;
        let third = 48.0 + 12.0 * (1.0 - (-1.0f32).exp());
        close(level_at(&slide, 100.0 / 3.0), third, 0.15, "glide a third of its Time in");
        close(level_at(&slide, 100.0), 48.0 + 12.0 * 0.95, 0.15, "glide has covered 95 % after its Time");
        assert!(slide.windows(2).all(|w| w[1] >= w[0]), "glide only goes towards its target");
        // The Time input multiplies the time: 100 ms x 0.1 is there ten times sooner.
        pd.send_float("t-in1", 0.1);
        render(pd, 0.05);
        pd.send_float("t-pitch", 48.0);
        let quick = render(pd, 0.1).0;
        close(level_at(&quick, 10.0), 60.0 - 12.0 * 0.95, 0.2, "glide's Time input multiplies the time");
        println!("ge-pitch-glide: {:.2} a third of the way into 100 ms from 48 to 60, {:.2} at 100 ms", level_at(&slide, 100.0 / 3.0), level_at(&slide, 100.0));
    });

    with_pitch(pd, dir, "ge-pitch-quantize", |pd| {
        let snapped = |pd: &mut Pd, root: f32, scale: f32, pitch: f32| {
            set(pd, &[("root", root), ("scale", scale)]);
            pd.send_float("t-pitch", pitch);
            settled_pitch(pd)
        };
        set(pd, &[("mod", 12.0)]);
        // Scales in the order of the registry: 0 chromatic, 1 major, 2 minor, 4 minor pentatonic.
        let cases: [(f32, f32, f32, f32, &str); 12] = [
            (0.0, 0.0, 60.4, 60.0, "chromatic rounds down to the nearest semitone"),
            (0.0, 0.0, 60.6, 61.0, "chromatic rounds up to the nearest semitone"),
            (0.0, 1.0, 62.0, 62.0, "a note of C major stays"),
            (0.0, 1.0, 63.0, 62.0, "D sharp goes to D in C major: of two neighbours, the lower"),
            (0.0, 1.0, 66.0, 65.0, "F sharp goes to F in C major"),
            (0.0, 1.0, 70.0, 69.0, "A sharp goes to A in C major"),
            (0.0, 1.0, 71.6, 72.0, "above B the next octave's C is nearest"),
            (2.0, 1.0, 60.0, 59.0, "C is not in D major: it goes to B"),
            (2.0, 1.0, 1.0, 1.0, "C sharp at the very bottom stays in D major, below its root"),
            (9.0, 2.0, 66.0, 65.0, "F sharp goes to F in A minor"),
            (9.0, 4.0, 59.0, 60.0, "B goes to C in A minor pentatonic, a semitone away, not to A, two away"),
            (0.0, 7.0, 61.0, 60.0, "C sharp goes to C in the whole-tone scale on C"),
        ];
        for (root, scale, pitch, expected, what) in cases {
            close(snapped(pd, root, scale, pitch), expected, 0.001, what);
        }
        // Mod is added before the snap: half of a Range of 12 above middle C is F sharp, so F in C major.
        pd.send_float("t-mod", 0.5);
        close(snapped(pd, 0.0, 1.0, 60.0), 65.0, 0.001, "quantizer adds Mod times Range, then snaps");
        // Every scale gives only its own notes, whatever goes in.
        pd.send_float("t-mod", 0.0);
        let minor_pentatonic = [0.0, 3.0, 5.0, 7.0, 10.0];
        for tenth in 0..240 {
            let out = snapped(pd, 4.0, 4.0, 40.0 + tenth as f32 * 0.1);
            let class = (out - 4.0).rem_euclid(12.0);
            assert!(minor_pentatonic.iter().any(|n| (n - class).abs() < 0.001), "E minor pentatonic gave {out} (class {class})");
        }
        println!("ge-pitch-quantize: {} spot checks, and a sweep of two octaves in E minor pentatonic gives only its notes", cases.len());
    });

    // Keys hands on what the voice gives it, and the pitch as a 0..1 signal.
    for (outlet, expected, what) in [(0, 64.0, "pitch"), (1, 1.0, "gate"), (2, 0.5, "velocity"), (3, 64.0 / 127.0, "key")] {
        let boxes = ["sig~ 64", "sig~ 1", "sig~ 0.5", "ge-keys t1", "dac~ 1"];
        let connections = [[0, 0, 3, 0], [1, 0, 3, 1], [2, 0, 3, 2], [3, outlet, 4, 0]];
        with_patch(pd, dir, &boxes, &connections, |pd| close(settled_pitch(pd), expected, 0.0001, &format!("keys' {what} output")));
    }
    println!("ge-keys: pitch, gate and velocity handed on, key = pitch / 127");
}

// --- math and logic ------------------------------------------------------------------------

/// A module with a `[sig~]` on its first input, set through `t-a`, and one on its second (for
/// those that have a second input which is not a setting's), set through `t-b`.
fn with_values<T>(pd: &mut Pd, dir: &Path, name: &str, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-a", "sig~ 0", "r t-b", "sig~ 0"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0]];
    with_module(pd, dir, name, &boxes, &connections, [Some(1), Some(3), None], to_left, measure)
}

/// What a module gives for the values `a` and `b` at its inputs, once it has settled.
fn result(pd: &mut Pd, a: f32, b: f32) -> f32 {
    pd.send_float("t-a", a);
    pd.send_float("t-b", b);
    settled_pitch(pd)
}

fn math_modules(pd: &mut Pd, dir: &Path) {
    let operators: [(&str, fn(f32, f32) -> f32); 4] =
        [("ge-math-add", |a, b| a + b), ("ge-math-multiply", |a, b| a * b), ("ge-math-min", f32::min), ("ge-math-max", f32::max)];
    for (name, expected) in operators {
        with_values(pd, dir, name, |pd| {
            for (a, b) in [(0.3, 0.4), (-0.5, 0.25), (0.0, -1.0), (2.0, 3.0)] {
                close(result(pd, a, b), expected(a, b), 0.0001, &format!("{name} of {a} and {b}"));
            }
        });
    }
    with_values(pd, dir, "ge-math-abs", |pd| {
        for a in [0.3, -0.3, 0.0, -2.5] {
            close(result(pd, a, 0.0), a.abs(), 0.0001, &format!("abs of {a}"));
        }
    });
    with_values(pd, dir, "ge-math-constant", |pd| {
        set(pd, &[("value", 0.5), ("range", 0.0)]);
        close(settled_pitch(pd), 0.5, 0.0001, "constant is its Value");
        set(pd, &[("range", 1.0)]);
        close(settled_pitch(pd), 5.0, 0.0001, "constant times 10");
        set(pd, &[("range", 2.0), ("value", -0.25)]);
        close(settled_pitch(pd), -25.0, 0.0001, "constant times 100");
        pd.send_float("t-in0", 0.5);
        close(settled_pitch(pd), -12.5, 0.0001, "constant's input multiplies it");
    });
    with_values(pd, dir, "ge-math-scale", |pd| {
        set(pd, &[("amount", -2.0), ("offset", 0.25)]);
        close(result(pd, 0.5, 0.0), -0.75, 0.0001, "scale is in x Amount + Offset");
        set(pd, &[("amount", 0.5), ("offset", 0.5)]);
        close(result(pd, -1.0, 0.0), 0.0, 0.0001, "scale moves -1..1 into 0..1: the bottom");
        close(result(pd, 1.0, 0.0), 1.0, 0.0001, "scale moves -1..1 into 0..1: the top");
    });
    with_values(pd, dir, "ge-math-crossfade", |pd| {
        for (mix, expected) in [(0.0, 1.0), (0.25, 0.5), (0.5, 0.0), (1.0, -1.0)] {
            set(pd, &[("mix", mix)]);
            close(result(pd, 1.0, -1.0), expected, 0.0001, &format!("crossfade from 1 to -1 at Mix {mix}"));
        }
    });
    with_values(pd, dir, "ge-math-smooth", |pd| {
        // A step from 0 to 1 and back: a third of the way into each time it is 1 - 1/e along.
        let third = 1.0 - (-1.0f32).exp();
        let step = |pd: &mut Pd, rise: f32, fall: f32| {
            set(pd, &[("rise", rise), ("fall", fall)]);
            pd.send_float("t-a", 0.0);
            render(pd, 3.0);
            pd.send_float("t-a", 1.0);
            let up = render(pd, 2.0).0;
            pd.send_float("t-a", 0.0);
            (up, render(pd, 2.0).0)
        };
        for (rise, fall) in [(90.0, 300.0), (300.0, 90.0), (150.0, 150.0)] {
            let (up, down) = step(pd, rise, fall);
            close(level_at(&up, rise / 3.0), third, 0.02, &format!("smooth a third into a Rise of {rise} ms (Fall {fall})"));
            close(level_at(&up, rise), 0.95, 0.02, &format!("smooth after its Rise of {rise} ms"));
            close(level_at(&down, fall / 3.0), 1.0 - third, 0.02, &format!("smooth a third into a Fall of {fall} ms (Rise {rise})"));
            close(level_at(&down, fall), 0.05, 0.02, &format!("smooth after its Fall of {fall} ms"));
        }
    });
    println!("math: add, multiply, min, max, abs, constant, scale, crossfade and smooth give what they should");
}

fn logic_modules(pd: &mut Pd, dir: &Path) {
    // On is anything above a half; what comes out is exactly 0 or 1.
    let gates: [(&str, fn(bool, bool) -> bool); 2] = [("ge-logic-and", |a, b| a && b), ("ge-logic-or", |a, b| a || b)];
    for (name, expected) in gates {
        with_values(pd, dir, name, |pd| {
            for (a, b) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0), (0.6, 0.4), (0.51, 7.0), (-1.0, 0.49)] {
                let on = expected(a > 0.5, b > 0.5);
                assert_eq!(result(pd, a, b), if on { 1.0 } else { 0.0 }, "{name} of {a} and {b}");
            }
        });
    }
    with_values(pd, dir, "ge-logic-not", |pd| {
        for (a, expected) in [(0.0, 1.0), (1.0, 0.0), (0.4, 1.0), (0.6, 0.0)] {
            assert_eq!(result(pd, a, 0.0), expected, "not of {a}");
        }
    });
    with_values(pd, dir, "ge-logic-compare", |pd| {
        set(pd, &[("threshold", 0.5)]);
        for (a, expected) in [(0.3, 0.0), (0.7, 1.0), (-0.9, 0.0)] {
            assert_eq!(result(pd, a, 0.0), expected, "compare {a} with a Threshold of 0.5");
        }
        // Threshold's input makes it a comparison of two signals: Threshold 1 times the input.
        set(pd, &[("threshold", 1.0)]);
        for (a, b, expected) in [(0.3, 0.2, 1.0), (0.3, 0.4, 0.0), (-0.5, -0.6, 1.0)] {
            pd.send_float("t-in1", b);
            assert_eq!(result(pd, a, 0.0), expected, "compare {a} with {b}");
        }
    });

    // One gate: on for 20 ms, off for 20 ms. Returns the output while it was on.
    let pulse = |pd: &mut Pd| {
        pd.send_float("t-a", 1.0);
        let on = render(pd, 0.02).0;
        pd.send_float("t-a", 0.0);
        render(pd, 0.02);
        *on.last().unwrap()
    };
    with_values(pd, dir, "ge-logic-toggle", |pd| {
        render(pd, 0.05);
        let states: Vec<f32> = (0..6).map(|_| pulse(pd)).collect();
        assert_eq!(states, [1.0, 0.0, 1.0, 0.0, 1.0, 0.0], "toggle flips each time its input goes on");
        assert_eq!(settled_pitch(pd), 0.0, "toggle keeps its state while the input is off");
    });
    with_values(pd, dir, "ge-logic-divider", |pd| {
        set(pd, &[("divide", 3.0)]);
        render(pd, 0.05);
        let passed: Vec<f32> = (0..7).map(|_| pulse(pd)).collect();
        assert_eq!(passed, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0], "divider by 3 lets the first of every three gates through");
        assert_eq!(settled_pitch(pd), 0.0, "divider is off between gates");
    });
    with_values(pd, dir, "ge-logic-divider", |pd| {
        // Divide's input multiplies it: 4 x 0.5 is every other gate. A Divide of 1 passes them all.
        set(pd, &[("divide", 4.0)]);
        pd.send_float("t-in1", 0.5);
        render(pd, 0.05);
        let passed: Vec<f32> = (0..4).map(|_| pulse(pd)).collect();
        assert_eq!(passed, [1.0, 0.0, 1.0, 0.0], "divider by 4 x 0.5");
    });
    with_values(pd, dir, "ge-logic-divider", |pd| {
        set(pd, &[("divide", 1.0)]);
        render(pd, 0.05);
        let passed: Vec<f32> = (0..3).map(|_| pulse(pd)).collect();
        assert_eq!(passed, [1.0, 1.0, 1.0], "divider by 1 passes every gate");
    });
    println!("logic: and, or, not, compare, toggle and divider give what they should");
}

// --- clock and sequencer -------------------------------------------------------------------

/// The samples at which a gate goes on.
fn rises(gate: &[f32]) -> Vec<usize> {
    gate.windows(2).enumerate().filter(|(_, pair)| pair[0] <= 0.5 && pair[1] > 0.5).map(|(n, _)| n + 1).collect()
}

/// The Clock with a `[sig~]` on Run that `t-gate` sets, on to begin with: 120 beats a minute,
/// a tick a sixteenth note, on for half of it. Out is on the left and Phase on the right.
fn with_clock<T>(pd: &mut Pd, dir: &Path, measure: impl FnOnce(&mut Pd) -> T) -> T {
    with_module(pd, dir, "ge-clock", &["r t-gate", "sig~ 1"], &[[0, 0, 1, 0]], [Some(1), None, None], both_outlets, |pd| {
        set(pd, &[("tempo", 120.0), ("width", 50.0), ("division", 4.0)]);
        measure(pd)
    })
}

fn clock(pd: &mut Pd, dir: &Path) {
    with_clock(pd, dir, |pd| {
        // 120 beats a minute in sixteenths is 8 ticks a second: one every 5512.5 samples.
        let (gate, phase) = settled(pd, 2.0);
        assert!(gate.iter().all(|v| *v == 0.0 || *v == 1.0), "clock: Out is 0 or 1");
        let ticks = rises(&gate);
        assert!(ticks.len() >= 15, "clock: 8 ticks a second, got {} in 2 s", ticks.len());
        for pair in ticks.windows(2) {
            assert!((5512..=5513).contains(&(pair[1] - pair[0])), "clock: a tick every 5512.5 samples, got {}", pair[1] - pair[0]);
        }
        let whole = &gate[ticks[0]..*ticks.last().unwrap()];
        close(mean(whole), 0.5, 0.001, "clock is on for Width of each tick");
        // Phase rises from 0 to 1 over a tick, and Out is on while it is below Width.
        let (start, end) = (ticks[0], ticks[1]);
        assert!(phase[start] < 0.001 && phase[end - 1] > 0.999, "clock: Phase goes from 0 to 1, got {}..{}", phase[start], phase[end - 1]);
        close(phase[(start + end) / 2], 0.5, 0.001, "clock: Phase is a half in the middle of a tick");
        assert!(phase[start..end].windows(2).all(|pair| pair[1] > pair[0]), "clock: Phase only rises within a tick");
        let apart = gate.iter().zip(&phase).filter(|(g, p)| (**g > 0.5) != (**p < 0.5)).count();
        assert_eq!(apart, 0, "clock: Out is on exactly while Phase is below Width");

        // Width, and its input.
        let share = |pd: &mut Pd| {
            let gate = settled(pd, 1.0).0;
            let ticks = rises(&gate);
            mean(&gate[ticks[0]..*ticks.last().unwrap()])
        };
        set(pd, &[("width", 25.0)]);
        close(share(pd), 0.25, 0.001, "clock Width 25 %");
        pd.send_float("t-in2", 0.5);
        close(share(pd), 0.125, 0.001, "clock Width 25 % x 0.5");
        pd.send_float("t-in2", 1.0);
        set(pd, &[("width", 50.0)]);

        // Tempo's input multiplies it.
        let period = |pd: &mut Pd, seconds: f32| {
            let ticks = rises(&settled(pd, seconds).0);
            assert!(ticks.len() >= 2, "clock: two ticks in {seconds} s, got {}", ticks.len());
            (ticks[1] - ticks[0]) as f32
        };
        pd.send_float("t-in1", 0.5);
        close(period(pd, 1.0), 11025.0, 1.0, "clock Tempo 120 x 0.5 ticks half as often");
        pd.send_float("t-in1", 1.0);

        // Division is the note value of a tick: at 240 beats a minute there are four beats a second.
        set(pd, &[("tempo", 240.0)]);
        let divisions = [0.25, 0.5, 1.0, 2.0, 4.0, 8.0, 1.5, 3.0, 6.0];
        let mut measured = Vec::new();
        for (number, ticks_a_beat) in divisions.iter().enumerate() {
            set(pd, &[("division", number as f32)]);
            let expected = SAMPLE_RATE / (4.0 * ticks_a_beat);
            let samples = period(pd, 3.2 * expected / SAMPLE_RATE);
            close(samples, expected, 1.0, &format!("clock Division {number}: samples to a tick"));
            measured.push(SAMPLE_RATE / samples);
        }
        set(pd, &[("tempo", 120.0), ("division", 4.0)]);

        // It runs while Run is on, and starts from the beginning when Run comes on.
        render(pd, 0.337);
        pd.send_float("t-gate", 0.0);
        let (gate, phase) = render(pd, 0.1);
        assert_eq!((peak(&gate), peak(&phase)), (0.0, 0.0), "clock: nothing comes out while Run is off");
        pd.send_float("t-gate", 1.0);
        let (gate, phase) = render(pd, 0.45);
        assert_eq!((gate[0], phase[0]), (1.0, 0.0), "clock: a tick starts at the sample Run comes on");
        let ticks = rises(&gate);
        for (number, tick) in ticks.iter().enumerate() {
            close(*tick as f32, 5512.5 * (number + 1) as f32, 1.0, "clock: ticks are counted from where Run came on");
        }
        assert_eq!(ticks.len(), 3, "clock: three more ticks in 450 ms");
        println!("ge-clock: a tick every 5512.5 samples at 120 in sixteenths, from the sample Run comes on; ticks a second at 240 by Division: {measured:.2?}");
    });
}

/// What the test sequencer's steps are set to, in semitones.
const STEPS: [f32; 8] = [0.0, 12.0, 7.0, 3.0, -5.0, 24.0, -24.0, 1.0];

/// The Sequencer with `[sig~]`s on Clock (`t-clock`), Reset (`t-reset`) and Pitch (`t-pitch`,
/// 60 to begin with), eight steps of `STEPS`. Pitch is on the left and Value on the right.
fn with_sequencer<T>(pd: &mut Pd, dir: &Path, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-clock", "sig~ 0", "r t-reset", "sig~ 0", "r t-pitch", "sig~ 60"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0], [4, 0, 5, 0]];
    with_module(pd, dir, "ge-sequencer", &boxes, &connections, [Some(1), Some(3), Some(5)], both_outlets, |pd| {
        set_steps(pd, "t1");
        render(pd, 0.05);
        measure(pd)
    })
}

fn set_steps(pd: &mut Pd, module: &str) {
    pd.send_float(&format!("{module}-steps"), 8.0);
    for (number, semitones) in STEPS.iter().enumerate() {
        pd.send_float(&format!("{module}-step{}", number + 1), *semitones);
    }
}

/// One tick of a clock: on for 10 ms and off for 10 ms. Returns the step being played at the
/// end, in semitones from the pitch of 60, and the Value output.
fn tick(pd: &mut Pd) -> (f32, f32) {
    pd.send_float("t-clock", 1.0);
    render(pd, 0.01);
    pd.send_float("t-clock", 0.0);
    let (pitch, value) = render(pd, 0.01);
    (pitch.last().unwrap() - 60.0, *value.last().unwrap())
}

/// A rise at Reset, held for 10 ms. Returns the pitch over those 10 ms.
fn reset(pd: &mut Pd) -> Vec<f32> {
    pd.send_float("t-reset", 1.0);
    let pitch = render(pd, 0.01).0;
    pd.send_float("t-reset", 0.0);
    render(pd, 0.01);
    pitch
}

fn sequencer(pd: &mut Pd, dir: &Path) {
    with_sequencer(pd, dir, |pd| {
        // It starts on its first step, and goes one step on each time Clock goes on.
        let (pitch, value) = render(pd, 0.01);
        assert!(pitch.iter().all(|p| *p == 60.0 + STEPS[0]), "sequencer starts on its first step");
        assert_eq!(peak(&value), 0.0, "sequencer: Value of a step of 0 semitones");
        let played: Vec<(f32, f32)> = (0..10).map(|_| tick(pd)).collect();
        for (number, (step, value)) in played.iter().enumerate() {
            let expected = STEPS[(number + 1) % 8];
            assert_eq!(*step, expected, "sequencer: step after {} ticks", number + 1);
            close(*value, expected / 24.0, 0.00001, "sequencer: Value is the step over 24");
        }

        // Reset goes back to the first step, at that sample.
        let pitch = reset(pd);
        assert!(pitch.iter().all(|p| *p == 60.0 + STEPS[0]), "sequencer: Reset goes to the first step at once");
        assert_eq!(tick(pd).0, STEPS[1], "sequencer: the tick after a reset plays the second step");

        // Pitch is added to the step, and a step's input multiplies its knob.
        pd.send_float("t-pitch", 48.0);
        close(settled_pitch(pd), 48.0 + STEPS[1], 0.0001, "sequencer adds the step to Pitch");
        pd.send_float("t-pitch", 60.0);
        pd.send_float("t-in5", 0.5);
        close(settled_pitch(pd), 60.0 + STEPS[1] * 0.5, 0.0001, "sequencer: the second step's knob times its input");
        pd.send_float("t-in5", 1.0);

        // Steps is how many of them it goes round, and its input multiplies it.
        set(pd, &[("steps", 3.0)]);
        render(pd, 0.05);
        reset(pd);
        let played: Vec<f32> = (0..7).map(|_| tick(pd).0).collect();
        assert_eq!(played, [1, 2, 0, 1, 2, 0, 1].map(|n| STEPS[n]), "sequencer goes round three steps");
        set(pd, &[("steps", 8.0)]);
        pd.send_float("t-in3", 0.25);
        render(pd, 0.05);
        reset(pd);
        let played: Vec<f32> = (0..5).map(|_| tick(pd).0).collect();
        assert_eq!(played, [1, 0, 1, 0, 1].map(|n| STEPS[n]), "sequencer: Steps 8 x 0.25 is two steps");
    });

    // A clock that starts on the gate that resets the sequencer goes on at the same moment,
    // or a block later if it restarts as an LFO does. That rise is the start of the first
    // step, not the end of it: one within 3 ms of a reset is not counted.
    for (blocks_late, counted) in [(0, false), (1, false), (2, false), (4, true)] {
        with_sequencer(pd, dir, |pd| {
            for _ in 0..3 {
                tick(pd);
            }
            pd.send_float("t-reset", 1.0);
            if blocks_late > 0 {
                render(pd, blocks_late as f32 * 64.0 / SAMPLE_RATE - 0.0001);
            }
            pd.send_float("t-clock", 1.0);
            let pitch = render(pd, 0.02).0;
            let step = if counted { STEPS[1] } else { STEPS[0] };
            assert!(pitch.iter().all(|p| *p == 60.0 + step), "sequencer: a clock rise {blocks_late} blocks after a reset counts: {counted}");
            pd.send_float("t-clock", 0.0);
            pd.send_float("t-reset", 0.0);
            render(pd, 0.01);
            assert_eq!(tick(pd).0, STEPS[if counted { 2 } else { 1 }], "sequencer: the next tick after a clock rise {blocks_late} blocks late");
        });
    }
    println!("ge-sequencer: steps in turn on each rise of the clock, round Steps of them; a reset holds the first step for 3 ms");
}

/// A Clock into a Sequencer, as a patch has them: the sequencer's pitch on the left and the
/// clock's ticks on the right. With `keyed` both follow a gate that `t-gate` sets, as their
/// pre-cords do; without, the clock runs free and nothing resets the sequencer.
fn with_clock_and_sequencer<T>(pd: &mut Pd, dir: &Path, keyed: bool, measure: impl FnOnce(&mut Pd) -> T) -> T {
    let boxes = ["r t-gate", "sig~ 0", "sig~ 1", "sig~ 60", "ge-clock c1", "ge-sequencer s1", "dac~ 1", "dac~ 2"];
    let (gate, one, pitch, clock, sequencer) = (1, 2, 3, 4, 5);
    let mut connections = vec![[0, 0, gate, 0], [one, 0, clock, 1], [one, 0, clock, 2], [clock, 0, sequencer, 0], [pitch, 0, sequencer, 2]];
    connections.push([if keyed { gate } else { one }, 0, clock, 0]);
    if keyed {
        connections.push([gate, 0, sequencer, 1]);
    }
    connections.extend((3..12).map(|inlet| [one, 0, sequencer, inlet]));
    connections.extend([[sequencer, 0, 6, 0], [clock, 0, 7, 0]]);
    with_patch(pd, dir, &boxes, &connections, |pd| {
        pd.send_float("c1-tempo", 120.0);
        pd.send_float("c1-width", 50.0);
        pd.send_float("c1-division", 4.0);
        set_steps(pd, "s1");
        measure(pd)
    })
}

/// Each step lasts from one tick of the clock to the next, starting with the first step at
/// `from`: the pitch is checked a quarter and three quarters of the way through each tick.
fn steps_follow_ticks(pitch: &[f32], ticks: &[f32], from: usize, what: &str) {
    let starts: Vec<usize> = std::iter::once(from).chain(rises(ticks).into_iter().filter(|tick| *tick > from)).collect();
    assert!(starts.len() >= 10, "{what}: ten ticks to check, got {}", starts.len());
    for (number, pair) in starts.windows(2).enumerate() {
        for part in [1, 3] {
            let at = pair[0] + (pair[1] - pair[0]) * part / 4;
            assert_eq!(pitch[at] - 60.0, STEPS[number % 8], "{what}: tick {number}, {part} quarters in");
        }
    }
}

fn clock_and_sequencer(pd: &mut Pd, dir: &Path) {
    // Free: from the moment the patch loads, the first step lasts a whole tick.
    with_clock_and_sequencer(pd, dir, false, |pd| {
        let (pitch, ticks) = render(pd, 1.5);
        assert_eq!(ticks[0], 1.0, "a free clock is on from the first sample");
        steps_follow_ticks(&pitch, &ticks, 0, "free clock and sequencer");
    });
    // On a key: the sequence starts from its first step when the key goes down, each time.
    with_clock_and_sequencer(pd, dir, true, |pd| {
        let (pitch, ticks) = render(pd, 0.2);
        assert!(peak(&ticks) == 0.0 && pitch.iter().all(|p| *p == 60.0 + STEPS[0]), "nothing moves before the key");
        for hold in [1.5, 1.33] {
            pd.send_float("t-gate", 1.0);
            let (pitch, ticks) = render(pd, hold);
            steps_follow_ticks(&pitch, &ticks, 0, "clock and sequencer on a key");
            pd.send_float("t-gate", 0.0);
            let (pitch, ticks) = render(pd, 0.21);
            let stopped = pitch[0];
            assert!(peak(&ticks) == 0.0 && pitch.iter().all(|p| *p == stopped), "the sequence stops where it is when the key is let go");
        }
    });
    println!("ge-clock into ge-sequencer: each step lasts one whole tick, from the first, free or started by a key");
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
        if ["ge-fx-cavern", "ge-fx-room", "ge-fx-hall"].contains(&name) {
            set(pd, &[("decay", 3.0), ("tone", 3000.0)]);
        }
        pd.send_float(&format!("t1-{receiver}"), knob);
        pd.send_float(&format!("t-in{inlet}"), input);
        render(pd, 0.3).0
    };
    if name.starts_with("ge-osc-") {
        with_oscillator(pd, dir, name, measure)
    } else if name == "ge-lfo" {
        with_lfo(pd, dir, measure)
    } else if name == "ge-clock" {
        with_clock(pd, dir, measure)
    } else if name == "ge-sequencer" {
        // Four ticks in: on the fifth step of eight, or the second of three.
        with_sequencer(pd, dir, |pd| {
            for _ in 0..4 {
                tick(pd);
            }
            measure(pd)
        })
    } else if name.starts_with("ge-math-") || name.starts_with("ge-logic-") {
        with_values(pd, dir, name, |pd| {
            set(pd, &[("amount", 1.0), ("offset", 0.5), ("mix", 0.5), ("value", 1.0), ("range", 0.0)]);
            set(pd, &[("threshold", 1.0), ("rise", 400.0), ("fall", 400.0)]);
            pd.send_float("t-a", 0.6);
            pd.send_float("t-b", -0.4);
            measure(pd)
        })
    } else if name.starts_with("ge-pitch-") {
        with_pitch(pd, dir, name, |pd| {
            set(pd, &[("octave", 1.0), ("semi", 3.0), ("mod", 0.0), ("time", 150.0)]);
            measure(pd)
        })
    } else if name.starts_with("ge-filter-") {
        with_filter_named(pd, dir, name, measure)
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
        ("ge-filter-allpass", 1, "cutoff", 4000.0, 0.25),
        ("ge-filter-ladder", 1, "cutoff", 4000.0, 0.25),
        ("ge-filter-ladder", 2, "res", 0.8, 0.5),
        ("ge-filter-resonator", 1, "cutoff", 2000.0, 0.5),
        ("ge-filter-soft-lp", 1, "cutoff", 4000.0, 0.0625),
        ("ge-filter-soft-hp", 1, "cutoff", 250.0, 4.0),
        ("ge-fx-cavern", 2, "mix", 0.8, 0.5),
        ("ge-fx-room", 4, "mix", 0.8, 0.5),
        ("ge-fx-hall", 4, "mix", 0.8, 0.5),
        ("ge-pitch-transpose", 1, "octave", 2.0, 0.5),
        ("ge-pitch-transpose", 2, "semi", 3.0, 4.0),
        ("ge-pitch-glide", 1, "time", 400.0, 0.5),
        ("ge-math-constant", 0, "value", 0.8, 0.5),
        ("ge-math-scale", 1, "amount", 1.6, 0.5),
        ("ge-math-scale", 2, "offset", 0.8, -0.5),
        ("ge-math-crossfade", 2, "mix", 0.8, 0.5),
        ("ge-math-smooth", 1, "rise", 400.0, 0.25),
        ("ge-logic-compare", 1, "threshold", 1.0, 0.5),
        ("ge-clock", 1, "tempo", 240.0, 0.5),
        ("ge-clock", 2, "width", 80.0, 0.5),
        ("ge-sequencer", 3, "steps", 6.0, 0.5),
        ("ge-sequencer", 8, "step5", 12.0, 0.5),
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
    soft_filters(&mut pd, &dir);
    ladder(&mut pd, &dir);
    resonator(&mut pd, &dir);
    pd_reverbs(&mut pd, &dir);
    sample_and_hold(&mut pd, &dir);
    follower(&mut pd, &dir);
    pitch_modules(&mut pd, &dir);
    math_modules(&mut pd, &dir);
    logic_modules(&mut pd, &dir);
    clock(&mut pd, &dir);
    sequencer(&mut pd, &dir);
    clock_and_sequencer(&mut pd, &dir);
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
