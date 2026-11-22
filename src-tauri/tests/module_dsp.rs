//! Measures what the module abstractions in `pd-lib/modules` actually do, in real Pd:
//! oscillator pitch, level, aliasing and modulation, filter frequency responses, mixer sums.
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
    let oscillator = format!("{name} t1");
    let boxes = ["r t-pitch", "sig~ 69", "r t-pwm", "sig~ 0", "r t-mod", "sig~ 0", oscillator.as_str(), "dac~ 1"];
    let mut connections = vec![[0, 0, 1, 0], [2, 0, 3, 0], [4, 0, 5, 0], [1, 0, 6, 0], [6, 0, 7, 0]];
    if name == "ge-osc-pulse" {
        connections.extend([[3, 0, 6, 1], [5, 0, 6, 2]]);
    } else {
        connections.push([5, 0, 6, 1]);
    }
    with_patch(pd, dir, &boxes, &connections, |pd| {
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
    let boxes = [carrier.as_str(), "osc~ 100", "ge-osc-sine t1", "dac~ 1"];
    with_patch(pd, dir, &boxes, &[[0, 0, 2, 0], [1, 0, 2, 1], [2, 0, 3, 0]], |pd| {
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
    let boxes = ["sig~ 100", "ge-osc-saw t1", "dac~ 1", "mtof~", "phasor~", "*~ 2", "-~ 1", "dac~ 2"];
    let connections = [[0, 0, 1, 0], [1, 0, 2, 0], [0, 0, 3, 0], [3, 0, 4, 0], [4, 0, 5, 0], [5, 0, 6, 0], [6, 0, 7, 0]];
    with_patch(pd, dir, &boxes, &connections, |pd| {
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
    let name = match kind {
        Kind::Low => "ge-filter-lp t1",
        Kind::High => "ge-filter-hp t1",
        Kind::Band => "ge-filter-bp t1",
        Kind::Notch => "ge-filter-notch t1",
    };
    let boxes = ["r t-freq", "osc~ 440", "r t-mod", "sig~ 0", name, "dac~ 1"];
    let connections = [[0, 0, 1, 0], [2, 0, 3, 0], [1, 0, 4, 0], [3, 0, 4, 1], [4, 0, 5, 0]];
    with_patch(pd, dir, &boxes, &connections, measure)
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
    mixer(&mut pd, &dir);

    drop(pd);
    let _ = fs::remove_dir_all(&dir);
    let printed: Vec<String> = events
        .try_iter()
        .filter_map(|e| if let gridelle_lib::engine::pd::PdEvent::Print(text) = e { Some(text) } else { None })
        .collect();
    assert!(printed.is_empty(), "Pd console should be empty, got {printed:?}");
}
