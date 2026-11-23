//! The wavetables the editor comes with.
//!
//! `banks/banks.json` is the list: an id that patches are saved with, a name, a group and
//! the number of frames. The editor's front end reads the same file. Each bank is made
//! here when a patch first uses it: from a formula, or from the cycles of Adventure Kid
//! Waveforms in `wavetables/akwf.bin`, which are in the public domain (see `AKWF.txt`
//! there). Nothing is random that is not seeded: the Organelle is sent a table again only
//! when its bytes have changed.

use std::f64::consts::PI;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::wavetable::{Cycle, HARMONICS};

/// A wavetable of the editor's own, as the list has it.
#[derive(Debug, Clone, Deserialize)]
pub struct Bank {
    pub id: String,
    pub name: String,
    pub group: String,
    pub frames: usize,
    /// For a bank of AKWF cycles: the number of its first cycle in `akwf.bin`.
    #[serde(default)]
    pub akwf: Option<usize>,
}

/// The AKWF cycles: 600 samples each, 16 bits, one after another.
static AKWF: &[u8] = include_bytes!("../wavetables/akwf.bin");
const AKWF_CYCLE: usize = 600;

/// The bank a new Wavetable oscillator gets. `DEFAULT_BANK` in `src/core/wavetables/banks.ts` is the same.
pub const DEFAULT_BANK: &str = "basic-shapes";

/// Every harmonic a cycle can have.
const TOP: usize = HARMONICS[0];

/// The banks, in the order the editor lists them.
pub fn list() -> &'static [Bank] {
    static LIST: OnceLock<Vec<Bank>> = OnceLock::new();
    LIST.get_or_init(|| serde_json::from_str(include_str!("../../banks/banks.json")).expect("banks.json is a list of banks"))
}

/// The frames of a bank, each at a peak of 1, or `None` for an id that is not in the list.
pub fn cycles(id: &str) -> Option<Vec<Cycle>> {
    let bank = list().iter().find(|bank| bank.id == id)?;
    if let Some(first) = bank.akwf {
        return (first..first + bank.frames)
            .map(|number| {
                let bytes = AKWF.get(number * AKWF_CYCLE * 2..(number + 1) * AKWF_CYCLE * 2)?;
                let points: Vec<f32> = bytes.chunks(2).map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).collect();
                Some(Cycle::from_points(&points).normalized())
            })
            .collect();
    }
    let frame = generator(id)?;
    let last = bank.frames.saturating_sub(1).max(1) as f64;
    Some((0..bank.frames).map(|number| frame(number as f64 / last).normalized()).collect())
}

/// A cycle from a curve over one cycle, `t` from 0 to 1. It is measured at many more
/// points than it has harmonics, so that the corners of a curve do not fold into it.
fn drawn(curve: impl Fn(f64) -> f64) -> Cycle {
    const POINTS: usize = 16_384;
    Cycle::from_points(&(0..POINTS).map(|i| curve(i as f64 / POINTS as f64) as f32).collect::<Vec<_>>())
}

/// A cycle from the level of each sine harmonic, by its number.
fn sines(level: impl FnMut(usize) -> f64) -> Cycle {
    Cycle::from_sines(&(1..=TOP).map(level).collect::<Vec<_>>())
}

/// Harmonic `h` at a level and a phase, added to a cycle.
fn add(cycle: &mut Cycle, h: usize, level: f64, phase: f64) {
    if (1..=TOP).contains(&h) {
        cycle.sin[h] += level * phase.cos();
        cycle.cos[h] += level * phase.sin();
    }
}

/// A blend of two cycles: `a` at 0, `b` at 1.
fn blend(a: &Cycle, b: &Cycle, mix: f64) -> Cycle {
    let part = |x: &[f64], y: &[f64]| x.iter().zip(y).map(|(x, y)| x + (y - x) * mix).collect();
    Cycle { cos: part(&a.cos, &b.cos), sin: part(&a.sin, &b.sin) }
}

/// The place `position` (0 to 1) has among `keys`: the blend of the two it lies between.
fn between(keys: &[Cycle], position: f64) -> Cycle {
    let place = position.clamp(0.0, 1.0) * (keys.len() - 1) as f64;
    let from = (place.floor() as usize).min(keys.len() - 2);
    blend(&keys[from], &keys[from + 1], place - from as f64)
}

/// How much of harmonic `h` is in, when the first `count` are (a fraction fades the last in).
fn within(h: usize, count: f64) -> f64 {
    (count - h as f64 + 1.0).clamp(0.0, 1.0)
}

/// Numbers that look random and are the same every time: a seed gives a row of them, 0 to 1.
struct Dice(u64);

impl Dice {
    fn roll(&mut self) -> f64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn sine() -> Cycle {
    sines(|h| if h == 1 { 1.0 } else { 0.0 })
}

fn triangle() -> Cycle {
    sines(|h| if h % 2 == 1 { (if h % 4 == 1 { 1.0 } else { -1.0 }) / (h * h) as f64 } else { 0.0 })
}

/// A rising saw that goes through zero where the sine does.
fn saw() -> Cycle {
    sines(|h| (if h % 2 == 1 { 1.0 } else { -1.0 }) / h as f64)
}

/// A pulse that is up for `width` of the cycle, from its start.
fn pulse(width: f64) -> Cycle {
    let mut cycle = Cycle::silent();
    for h in 1..=TOP {
        let turn = 2.0 * PI * h as f64 * width;
        cycle.cos[h] = turn.sin() / h as f64;
        cycle.sin[h] = (1.0 - turn.cos()) / h as f64;
    }
    cycle
}

fn is_prime(n: usize) -> bool {
    n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0)
}

/// The nine drawbars of a tonewheel organ as harmonics of its lowest: 16', 5 1/3', 8', 4',
/// 2 2/3', 2', 1 3/5', 1 1/3', 1'.
const DRAWBAR_HARMONICS: [usize; 9] = [1, 3, 2, 4, 6, 8, 10, 12, 16];

/// Sixteen settings of the drawbars, each from 0 to 8, from hollow to full.
const DRAWBARS: [&str; 16] = [
    "008000000", "008400000", "808000000", "888000000", "888800000", "808808000", "800000888", "008080800", "688600000", "888400080",
    "868868446", "006876540", "888888000", "880080088", "888848688", "888888888",
];

/// The first three formants of five vowels, in Hz: a, e, i, o, u.
const VOWELS: [[f64; 3]; 5] = [[730.0, 1090.0, 2440.0], [530.0, 1840.0, 2480.0], [270.0, 2290.0, 3010.0], [570.0, 840.0, 2410.0], [300.0, 870.0, 2240.0]];

/// A voice on a low A with formants at the three frequencies.
fn vowel(formants: [f64; 3]) -> Cycle {
    const NOTE: f64 = 110.0;
    const WIDTHS: [f64; 3] = [70.0, 100.0, 140.0];
    const LEVELS: [f64; 3] = [1.0, 0.6, 0.3];
    sines(|h| {
        let hz = h as f64 * NOTE;
        let shape: f64 = (0..3).map(|i| LEVELS[i] / (1.0 + ((hz - formants[i]) / WIDTHS[i]).powi(2))).sum();
        (shape + 0.02) / (h as f64).powf(0.6)
    })
}

/// What makes the frame at `position`, 0 to 1 across the bank, for each bank id.
fn generator(id: &str) -> Option<Box<dyn Fn(f64) -> Cycle>> {
    let frame: Box<dyn Fn(f64) -> Cycle> = match id {
        // --- Basic ---
        "basic-shapes" => {
            let keys = [sine(), triangle().normalized(), saw().normalized(), pulse(0.5).normalized(), pulse(0.125).normalized()];
            Box::new(move |p| between(&keys, p))
        }
        "sine-to-saw" => Box::new(|p| sines(|h| within(h, 2f64.powf(9.0 * p)) * (if h % 2 == 1 { 1.0 } else { -1.0 }) / h as f64)),
        "sine-to-square" => Box::new(|p| sines(|h| if h % 2 == 1 { within(h, 2f64.powf(9.0 * p)) / h as f64 } else { 0.0 })),
        "pulse-width" => Box::new(|p| pulse(0.5 - 0.47 * p)),
        "triangle-to-saw" => Box::new(|p| {
            // The peak moves from the middle of the cycle to its end.
            let peak = 0.5 + 0.48 * p;
            drawn(move |t| if t < peak { 2.0 * t / peak - 1.0 } else { 1.0 - 2.0 * (t - peak) / (1.0 - peak) })
        }),

        // --- Analog ---
        "sync-saw" => Box::new(|p| {
            let ratio = 1.0 + 7.0 * p;
            drawn(move |t| 2.0 * (ratio * t).fract() - 1.0)
        }),
        "sync-square" => Box::new(|p| {
            let ratio = 1.0 + 7.0 * p;
            drawn(move |t| if (ratio * t).fract() < 0.5 { 1.0 } else { -1.0 })
        }),
        "sync-sine" => Box::new(|p| {
            // A sine restarted every cycle, under a window that hides the restart.
            let ratio = 1.0 + 11.0 * p;
            drawn(move |t| (2.0 * PI * ratio * t).sin() * (PI * t).sin().powi(2))
        }),
        "resonance" => Box::new(|p| {
            // A saw through a low-pass that rings, its cutoff rising from the first harmonic to the 128th.
            let cutoff = 2f64.powf(7.0 * p);
            let mut cycle = Cycle::silent();
            for h in 1..=TOP {
                let x = h as f64 / cutoff;
                let (re, im) = (1.0 - x * x, x / 6.0);
                let size = 1.0 / (re * re + im * im).sqrt();
                add(&mut cycle, h, size / h as f64, -im.atan2(re));
            }
            cycle
        }),
        "reso-wave" => Box::new(|p| {
            // A sine at a multiple of the pitch that dies away over each cycle.
            let ratio = 1.0 + 15.0 * p;
            drawn(move |t| (2.0 * PI * ratio * t).sin() * (1.0 - t))
        }),

        // --- Additive ---
        "harmonics" => Box::new(|p| {
            // One harmonic at a time, from the 1st to the 32nd.
            let place = 1.0 + 31.0 * p;
            sines(|h| (1.0 - (h as f64 - place).abs()).max(0.0))
        }),
        "overtones" => Box::new(|p| sines(|h| within(h, 1.0 + 63.0 * p))),
        "odd-to-even" => Box::new(|p| sines(|h| if h == 1 { 1.0 } else if h % 2 == 1 { (1.0 - p) / h as f64 } else { p / h as f64 })),
        "octaves" => Box::new(|p| sines(|h| if h.is_power_of_two() { within(h.trailing_zeros() as usize + 1, 1.0 + 8.0 * p) * 0.75f64.powi(h.trailing_zeros() as i32) } else { 0.0 })),
        "drawbars" => {
            let keys: Vec<Cycle> = DRAWBARS
                .iter()
                .map(|setting| {
                    let mut cycle = Cycle::silent();
                    for (bar, digit) in setting.bytes().enumerate() {
                        add(&mut cycle, DRAWBAR_HARMONICS[bar], (digit - b'0') as f64 / 8.0, 0.0);
                    }
                    cycle.normalized()
                })
                .collect();
            Box::new(move |p| between(&keys, p))
        }
        "tilt" => Box::new(|p| sines(|h| (h as f64).powf(-(3.0 - 2.7 * p)))),
        "primes" => Box::new(|p| {
            let mut found = 0;
            sines(|h| {
                if h == 1 {
                    1.0
                } else if is_prime(h) {
                    found += 1;
                    within(found, 24.0 * p) / (h as f64).sqrt()
                } else {
                    0.0
                }
            })
        }),

        // --- Vocal ---
        "vowels" => Box::new(|p| {
            let place = p.clamp(0.0, 1.0) * (VOWELS.len() - 1) as f64;
            let from = (place.floor() as usize).min(VOWELS.len() - 2);
            let mix = place - from as f64;
            vowel(std::array::from_fn(|i| VOWELS[from][i] + (VOWELS[from + 1][i] - VOWELS[from][i]) * mix))
        }),
        "formant" => Box::new(|p| {
            let centre = 2f64.powf(6.0 * p);
            let width = centre / 4.0 + 0.5;
            sines(|h| (1.0 + 12.0 * (-((h as f64 - centre) / width).powi(2)).exp()) / h as f64)
        }),
        "twin-peaks" => Box::new(|p| {
            // Two formants that cross: one going up, the other coming down.
            let (up, down) = (2.0 * 2f64.powf(4.5 * p), 96.0 / 2f64.powf(4.0 * p));
            let peak = |h: usize, centre: f64| (-((h as f64 - centre) / (centre / 5.0 + 0.5)).powi(2)).exp();
            sines(|h| (0.5 + 10.0 * peak(h, up) + 6.0 * peak(h, down)) / h as f64)
        }),

        // --- FM ---
        "fm-1-1" => fm(1.0, 1.0, 8.0),
        "fm-1-2" => fm(1.0, 2.0, 8.0),
        "fm-1-3" => fm(1.0, 3.0, 8.0),
        "fm-3-1" => fm(3.0, 1.0, 6.0),
        "phase-distortion" => Box::new(|p| {
            // A cosine read fast over the first part of the cycle and slowly over the rest.
            let knee = 0.5 - 0.48 * p;
            drawn(move |t| {
                let phase = if t < knee { 0.5 * t / knee } else { 0.5 + 0.5 * (t - knee) / (1.0 - knee) };
                -(2.0 * PI * phase).cos()
            })
        }),

        // --- Shaped ---
        "wavefold" => Box::new(|p| {
            let gain = 1.0 + 8.0 * p;
            drawn(move |t| (gain * PI / 2.0 * (2.0 * PI * t).sin()).sin())
        }),
        "overdrive" => Box::new(|p| {
            let gain = 0.5 * 80f64.powf(p);
            drawn(move |t| (gain * (2.0 * PI * t).sin()).tanh())
        }),
        "bit-reduction" => Box::new(|p| {
            // A sine measured in fewer and fewer steps: from 32 a side down to 1.
            let steps = 2f64.powf(5.0 - 5.0 * p);
            drawn(move |t| ((2.0 * PI * t).sin() * steps).round() / steps)
        }),
        "stepped" => Box::new(|p| {
            // A sine held for a stretch at a time: 64 stretches a cycle down to 4.
            let stretches = (64.0 * 2f64.powf(-4.0 * p)).round();
            drawn(move |t| (2.0 * PI * ((t * stretches).floor() + 0.5) / stretches).sin())
        }),

        // --- Spectral ---
        "glass" => {
            // Nine spectra of chance, each harmonic up or down, passed through one after another.
            let mut dice = Dice(0x61A5_5EED);
            let keys: Vec<Cycle> = (0..9)
                .map(|_| sines(|h| if h <= 96 { (dice.roll() * 2.0 - 1.0) * dice.roll() / (h as f64).powf(0.8) } else { 0.0 }).normalized())
                .collect();
            Box::new(move |p| between(&keys, p))
        }
        "bells" => {
            // Sixteen chords of a few far-apart harmonics over the fundamental.
            let mut dice = Dice(0xBE11_5EED);
            let keys: Vec<Cycle> = (0..16)
                .map(|_| {
                    let mut cycle = sine();
                    for _ in 0..6 {
                        let h = 2 + (dice.roll() * 46.0) as usize;
                        add(&mut cycle, h, 0.3 + 0.7 * dice.roll(), 0.0);
                    }
                    cycle.normalized()
                })
                .collect();
            Box::new(move |p| between(&keys, p))
        }
        "noise-bands" => {
            // A band of harmonics at phases of chance, rising from the bottom to the 256th.
            let mut dice = Dice(0x0B5E_55ED);
            let phases: Vec<f64> = (0..=TOP).map(|_| dice.roll() * 2.0 * PI).collect();
            Box::new(move |p| {
                let centre = 2f64.powf(8.0 * p);
                let width = centre / 3.0 + 1.0;
                let mut cycle = Cycle::silent();
                for h in 1..=TOP {
                    add(&mut cycle, h, (-((h as f64 - centre) / width).powi(2)).exp(), phases[h]);
                }
                cycle
            })
        }
        _ => return None,
    };
    Some(frame)
}

/// A sine at `carrier` times the pitch whose phase another at `modulator` times the pitch
/// moves, more and more across the bank.
fn fm(carrier: f64, modulator: f64, most: f64) -> Box<dyn Fn(f64) -> Cycle> {
    Box::new(move |p| {
        let index = most * p;
        drawn(move |t| (2.0 * PI * carrier * t + index * (2.0 * PI * modulator * t).sin()).sin())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_bank_in_the_list_can_be_made() {
        let ids: HashSet<&str> = list().iter().map(|bank| bank.id.as_str()).collect();
        assert_eq!(ids.len(), list().len(), "no id twice");
        assert!(ids.contains(DEFAULT_BANK));
        // Of the AKWF banks every eighth is made here: each takes a moment, and they are all made alike.
        let akwf: Vec<&Bank> = list().iter().filter(|bank| bank.akwf.is_some()).collect();
        for bank in list().iter().filter(|bank| bank.akwf.is_none()).chain(akwf.iter().step_by(8).copied()) {
            assert!((1..=crate::wavetable::MAX_FRAMES).contains(&bank.frames), "{}: {} frames", bank.id, bank.frames);
            let frames = cycles(&bank.id).unwrap_or_else(|| panic!("{} has nothing that makes it", bank.id));
            assert_eq!(frames.len(), bank.frames, "{}", bank.id);
            for (number, frame) in frames.iter().enumerate() {
                assert!((frame.peak() - 1.0).abs() < 1e-9, "{} frame {number} peaks at {}", bank.id, frame.peak());
                assert!(frame.cos.iter().chain(&frame.sin).all(|a| a.is_finite()), "{} frame {number}", bank.id);
            }
            // A bank is a movement: its two ends differ.
            if frames.len() > 1 {
                assert!(frames[0] != frames[frames.len() - 1], "{} goes somewhere", bank.id);
            }
        }
        assert!(cycles("no-such-bank").is_none());
    }

    #[test]
    fn the_akwf_cycles_are_all_there_and_each_in_one_bank() {
        assert_eq!(AKWF.len() % (AKWF_CYCLE * 2), 0);
        let mut covered = vec![0u8; AKWF.len() / (AKWF_CYCLE * 2)];
        for bank in list().iter().filter(|bank| bank.akwf.is_some()) {
            assert!(bank.id.starts_with("akwf-") && bank.group.starts_with("AKWF "), "{}", bank.id);
            for cycle in bank.akwf.unwrap()..bank.akwf.unwrap() + bank.frames {
                covered[cycle] += 1;
            }
        }
        assert_eq!(covered.len(), 4158);
        assert!(covered.iter().all(|times| *times == 1), "every cycle is in one bank and one only");
        // The cello's cycles are not each other's, and have a fundamental.
        let cello = cycles("akwf-cello").unwrap();
        assert_eq!(cello.len(), 19);
        let low = |cycle: &Cycle| (1..=8).map(|h| cycle.sin[h].hypot(cycle.cos[h])).fold(0.0f64, f64::max);
        assert!(cello[0] != cello[1], "two cycles of the cello are two different ones");
        assert!(cello.iter().all(|cycle| low(cycle) > 0.1), "a cello has low harmonics: {:?}", cello.iter().map(low).collect::<Vec<_>>());
        // 600 points hold 299 harmonics and no more.
        assert!(cello[0].sin[300..].iter().all(|a| *a == 0.0));
    }

    #[test]
    fn a_bank_is_the_same_every_time() {
        for id in ["glass", "bells", "noise-bands", "sync-saw"] {
            assert_eq!(cycles(id), cycles(id), "{id}");
        }
    }

    #[test]
    fn the_basic_shapes_are_the_shapes() {
        let frames = cycles("basic-shapes").unwrap();
        // 33 frames: the sine, the triangle, the saw, the square and a narrow pulse, eight apart.
        let sine = &frames[0];
        assert!((sine.sin[1] - 1.0).abs() < 1e-9 && sine.sin[2..].iter().all(|a| a.abs() < 1e-12));
        let triangle = &frames[8];
        assert!((triangle.sin[3] / triangle.sin[1] + 1.0 / 9.0).abs() < 1e-9 && triangle.sin[2].abs() < 1e-12);
        let saw = &frames[16];
        assert!((saw.sin[2] / saw.sin[1] + 0.5).abs() < 1e-9 && (saw.sin[3] / saw.sin[1] - 1.0 / 3.0).abs() < 1e-9);
        let square = &frames[24];
        assert!(square.sin[2].abs() < 1e-9 && (square.sin[3] / square.sin[1] - 1.0 / 3.0).abs() < 1e-9 && square.cos[1].abs() < 1e-9);
        assert!(frames[32].sin[2].abs() > 0.1, "a narrow pulse has even harmonics");
    }

    #[test]
    fn a_drawn_curve_has_the_harmonics_it_should() {
        // A sawtooth drawn as a line: 2 / (pi h), every other one upside down.
        let saw = drawn(|t| 2.0 * t - 1.0);
        for h in [1usize, 2, 7, 100, 512] {
            let expected = -2.0 / (PI * h as f64);
            assert!((saw.sin[h] - expected).abs() < expected.abs() * 0.04, "harmonic {h}: {} for {expected}", saw.sin[h]);
        }
    }
}
