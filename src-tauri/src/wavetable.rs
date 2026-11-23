//! Wavetables for the Wavetable oscillator.
//!
//! A wavetable is a row of single cycles, its frames, which the oscillator reads one of
//! and fades to the next. Read as it is, a cycle played high puts its upper harmonics past
//! half the sample rate, where they fold back as tones that do not belong. So each frame
//! is stored ten times over, a level for each octave of pitch, each with only the
//! harmonics that fit. The oscillator picks the level by the pitch it is playing.
//!
//! The file is one record per frame, each record the frame's ten levels in a row. A level
//! is one cycle with three more points for `tabread4~`, which reads one point before the
//! place it is asked for and two after: the cycle's last point in front, its first two
//! behind. `ge-osc-wavetable.pd` has the same lengths and starts in two message boxes, and
//! `tests/wavetable_dsp.rs` checks that they agree.

use std::f64::consts::PI;

/// Levels of a frame, lowest pitch first.
pub const LEVELS: usize = 10;
/// The harmonics each level holds. Level `L` is played up to 55 Hz x 2^L less a quarter
/// tone, where its highest harmonic is at 27 kHz: what folds back lands above 16 kHz.
pub const HARMONICS: [usize; LEVELS] = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1];
/// The points of a cycle at each level. The low levels are long so that their many
/// harmonics have points enough between them for `tabread4~` to read cleanly.
pub const LENGTHS: [usize; LEVELS] = [4096, 4096, 4096, 2048, 1024, 512, 256, 128, 64, 64];
/// The points around a cycle that `tabread4~` needs: one before, two after.
pub const GUARDS: usize = 3;
/// The most frames a wavetable has. The whole table then stays far below 2^24 points, up
/// to which a 32-bit float counts whole numbers exactly.
pub const MAX_FRAMES: usize = 64;
/// The rate written into the file. Nothing reads it: a cycle has no rate of its own.
pub const FILE_RATE: u32 = 44_100;

/// Where each level starts in a record.
pub const fn offsets() -> [usize; LEVELS] {
    let mut starts = [0; LEVELS];
    let mut level = 1;
    while level < LEVELS {
        starts[level] = starts[level - 1] + LENGTHS[level - 1] + GUARDS;
        level += 1;
    }
    starts
}

/// The points of one frame's record: all its levels with their guard points.
pub const RECORD: usize = offsets()[LEVELS - 1] + LENGTHS[LEVELS - 1] + GUARDS;

/// The harmonics kept of a cycle: all that the lowest level has.
const KEPT: usize = HARMONICS[0];

/// One cycle as its harmonics: `cos[h]` and `sin[h]` are the amplitudes of harmonic `h`,
/// from 1 to `KEPT`. There is no place for a constant part: a cycle has no DC here.
#[derive(Debug, Clone, PartialEq)]
pub struct Cycle {
    pub cos: Vec<f64>,
    pub sin: Vec<f64>,
}

impl Cycle {
    pub fn silent() -> Self {
        Cycle { cos: vec![0.0; KEPT + 1], sin: vec![0.0; KEPT + 1] }
    }

    /// A cycle from the amplitudes of its sine harmonics, the first being harmonic 1.
    pub fn from_sines(amplitudes: &[f64]) -> Self {
        let mut cycle = Cycle::silent();
        for (h, amplitude) in amplitudes.iter().take(KEPT).enumerate() {
            cycle.sin[h + 1] = *amplitude;
        }
        cycle
    }

    /// The harmonics of one cycle given as its points, however many there are.
    pub fn from_points(points: &[f32]) -> Self {
        let mut cycle = Cycle::silent();
        let n = points.len();
        if n < 2 {
            return cycle;
        }
        // A cycle of n points can hold harmonics below n / 2.
        let top = KEPT.min((n - 1) / 2);
        if n.is_power_of_two() {
            let mut re: Vec<f64> = points.iter().map(|p| *p as f64).collect();
            let mut im = vec![0.0; n];
            fft(&mut re, &mut im, false);
            for h in 1..=top {
                cycle.cos[h] = 2.0 * re[h] / n as f64;
                cycle.sin[h] = -2.0 * im[h] / n as f64;
            }
        } else {
            // Any other length (the 600 points of an AKWF cycle), harmonic by harmonic. Every
            // angle that comes up is a whole number of n-ths of a turn.
            let turn: Vec<(f64, f64)> = (0..n).map(|i| (2.0 * PI * i as f64 / n as f64).sin_cos()).collect();
            for h in 1..=top {
                let (mut c, mut s) = (0.0, 0.0);
                let mut at = 0;
                for point in points {
                    s += *point as f64 * turn[at].0;
                    c += *point as f64 * turn[at].1;
                    at += h;
                    if at >= n {
                        at -= n;
                    }
                }
                cycle.cos[h] = 2.0 * c / n as f64;
                cycle.sin[h] = 2.0 * s / n as f64;
            }
        }
        cycle
    }

    /// The cycle as `length` points (a power of two), with its harmonics up to `harmonics`.
    pub fn points(&self, length: usize, harmonics: usize) -> Vec<f64> {
        let mut re = vec![0.0; length];
        let mut im = vec![0.0; length];
        let top = harmonics.min(KEPT).min(length / 2 - 1);
        for h in 1..=top {
            re[h] = self.cos[h] / 2.0;
            im[h] = -self.sin[h] / 2.0;
            re[length - h] = re[h];
            im[length - h] = -im[h];
        }
        fft(&mut re, &mut im, true);
        re
    }

    /// The highest point of the cycle at its fullest.
    pub fn peak(&self) -> f64 {
        self.points(LENGTHS[0], HARMONICS[0]).iter().fold(0.0, |top, p| top.max(p.abs()))
    }

    /// The same cycle with every harmonic times `gain`.
    pub fn scaled(&self, gain: f64) -> Self {
        Cycle { cos: self.cos.iter().map(|c| c * gain).collect(), sin: self.sin.iter().map(|s| s * gain).collect() }
    }

    /// The cycle at a peak of 1, or as it is when it is silent.
    pub fn normalized(&self) -> Self {
        let peak = self.peak();
        if peak > 1e-12 {
            self.scaled(1.0 / peak)
        } else {
            self.clone()
        }
    }
}

/// The Fourier transform in place, for a power-of-two length. The inverse is not divided
/// by the length: `Cycle::points` has its harmonics at the size they are to come out at.
pub fn fft(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut size = 2;
    while size <= n {
        let angle = if inverse { 2.0 } else { -2.0 } * PI / size as f64;
        let (step_re, step_im) = (angle.cos(), angle.sin());
        for start in (0..n).step_by(size) {
            let (mut w_re, mut w_im) = (1.0, 0.0);
            for k in 0..size / 2 {
                let (a, b) = (start + k, start + k + size / 2);
                let (t_re, t_im) = (re[b] * w_re - im[b] * w_im, re[b] * w_im + im[b] * w_re);
                re[b] = re[a] - t_re;
                im[b] = im[a] - t_im;
                re[a] += t_re;
                im[a] += t_im;
                let next = w_re * step_re - w_im * step_im;
                w_im = w_re * step_im + w_im * step_re;
                w_re = next;
            }
        }
        size *= 2;
    }
}

/// At most `most` of the frames, evenly spread, the first and the last among them.
pub fn thinned(frames: &[Cycle], most: usize) -> Vec<Cycle> {
    if frames.len() <= most || most < 2 {
        return frames.iter().take(most.max(1)).cloned().collect();
    }
    (0..most).map(|i| frames[(i * (frames.len() - 1) + (most - 1) / 2) / (most - 1)].clone()).collect()
}

/// The table of a wavetable, as the oscillator reads it: a record for each frame, at most
/// `MAX_FRAMES` of them. One gain for the whole table brings its highest point, at any
/// level, to 1: taking harmonics away can raise a peak, and the file cannot hold more.
pub fn table(frames: &[Cycle]) -> Vec<f32> {
    let frames = thinned(frames, MAX_FRAMES);
    let starts = offsets();
    let mut table = vec![0.0f64; frames.len() * RECORD];
    for (number, frame) in frames.iter().enumerate() {
        for level in 0..LEVELS {
            let length = LENGTHS[level];
            let cycle = frame.points(length, HARMONICS[level]);
            let at = number * RECORD + starts[level];
            table[at] = cycle[length - 1];
            table[at + 1..at + 1 + length].copy_from_slice(&cycle);
            table[at + 1 + length] = cycle[0];
            table[at + 2 + length] = cycle[1];
        }
    }
    let peak = table.iter().fold(0.0f64, |top, p| top.max(p.abs()));
    let gain = if peak > 1e-12 { 1.0 / peak } else { 1.0 };
    table.iter().map(|p| (p * gain) as f32).collect()
}

/// The frame length a wavetable file says it has, in its `clm ` chunk: the text there
/// starts `<!>2048 `. Serum writes it, and Vital and Surge do the same.
pub fn declared_cycle(file: &[u8]) -> Option<usize> {
    if file.len() < 12 || &file[0..4] != b"RIFF" || &file[8..12] != b"WAVE" {
        return None;
    }
    let mut at = 12;
    while at + 8 <= file.len() {
        let size = u32::from_le_bytes(file[at + 4..at + 8].try_into().ok()?) as usize;
        let body = file.get(at + 8..(at + 8 + size).min(file.len()))?;
        if &file[at..at + 4] == b"clm " {
            let text = body.strip_prefix(b"<!>")?;
            let digits: String = text.iter().take_while(|b| b.is_ascii_digit()).map(|b| *b as char).collect();
            return digits.parse().ok().filter(|cycle| (2..=8192).contains(cycle));
        }
        // Chunks are padded to an even length.
        at += 8 + size + (size & 1);
    }
    None
}

/// The points of a cycle in a sound that is to be read as a wavetable. `chosen` is what
/// the user set, `declared` what the file says of itself. Without either: a WaveEdit bank
/// (64 cycles of 256 points) is known by its length, a sound of up to 4096 points is one
/// cycle, and anything else is in cycles of 2048 points, as Serum's files are.
pub fn cycle_length(points: usize, chosen: Option<usize>, declared: Option<usize>) -> usize {
    let guess = match points {
        16_384 => 256,
        0..=4096 => points,
        _ => 2048,
    };
    chosen.or(declared).filter(|cycle| *cycle >= 2).unwrap_or(guess).min(points).max(1)
}

/// The cycles of a sound cut into stretches of `cycle` points: at most `most` of them,
/// evenly spread, the first and the last among them. What is left over at the end of the
/// sound is dropped.
pub fn cycles(sound: &[f32], cycle: usize, most: usize) -> Vec<Cycle> {
    let cycle = cycle.max(2);
    let whole = sound.len() / cycle;
    let kept = whole.min(most);
    (0..kept)
        .map(|i| {
            let number = if kept < 2 { 0 } else { (i * (whole - 1) + (kept - 1) / 2) / (kept - 1) };
            Cycle::from_points(&sound[number * cycle..(number + 1) * cycle])
        })
        .collect()
}

/// A picture of a wavetable for the editor: up to `count` of its frames, evenly spread,
/// each as `points` values between -1 and 1.
pub fn picture(frames: &[Cycle], count: usize, points: usize) -> Vec<Vec<f32>> {
    let shown = thinned(frames, count);
    let peak = shown.iter().map(|frame| frame.peak()).fold(0.0f64, f64::max).max(1e-12);
    shown
        .iter()
        .map(|frame| frame.points(points, points / 2 - 1).iter().map(|p| (p / peak).clamp(-1.0, 1.0) as f32).collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A saw: every harmonic at one over its number.
    fn saw() -> Cycle {
        Cycle::from_sines(&(1..=KEPT).map(|h| 1.0 / h as f64).collect::<Vec<_>>())
    }

    fn square() -> Cycle {
        Cycle::from_sines(&(1..=KEPT).map(|h| if h % 2 == 1 { 1.0 / h as f64 } else { 0.0 }).collect::<Vec<_>>())
    }

    #[test]
    fn a_record_is_ten_levels_with_their_guard_points() {
        assert_eq!(offsets(), [0, 4099, 8198, 12297, 14348, 15375, 15890, 16149, 16280, 16347]);
        assert_eq!(RECORD, 16_414);
        assert_eq!(RECORD, LENGTHS.iter().map(|length| length + GUARDS).sum::<usize>());
        // A level has points enough for its harmonics: eight to the shortest wave at least.
        for level in 0..LEVELS {
            assert!(LENGTHS[level].is_power_of_two() && LENGTHS[level] >= 8 * HARMONICS[level], "level {level}");
        }
        assert!(MAX_FRAMES * RECORD < 1 << 24);
    }

    #[test]
    fn a_cycle_survives_being_made_into_points_and_back() {
        let cycle = Cycle { cos: (0..=KEPT).map(|h| if h == 0 { 0.0 } else { 0.3 / h as f64 }).collect(), ..saw() };
        for length in [4096usize, 2048] {
            let points: Vec<f32> = cycle.points(length, KEPT).iter().map(|p| *p as f32).collect();
            let back = Cycle::from_points(&points);
            for h in 1..=KEPT.min(length / 2 - 1) {
                assert!((back.cos[h] - cycle.cos[h]).abs() < 1e-6 && (back.sin[h] - cycle.sin[h]).abs() < 1e-6, "harmonic {h} at {length} points");
            }
        }
        // A sine is a sine: one harmonic in, the same curve out.
        let sine = Cycle::from_sines(&[1.0]).points(64, 1);
        for (i, point) in sine.iter().enumerate() {
            assert!((point - (2.0 * PI * i as f64 / 64.0).sin()).abs() < 1e-12);
        }
    }

    #[test]
    fn reads_a_cycle_of_any_number_of_points() {
        // 600 points, as the AKWF cycles have: a third harmonic and a quiet fifth, with DC.
        let points: Vec<f32> = (0..600)
            .map(|i| {
                let t = 2.0 * PI * i as f64 / 600.0;
                (0.25 + 0.8 * (3.0 * t).sin() + 0.1 * (5.0 * t).cos()) as f32
            })
            .collect();
        let cycle = Cycle::from_points(&points);
        assert!((cycle.sin[3] - 0.8).abs() < 1e-6 && (cycle.cos[5] - 0.1).abs() < 1e-6);
        let rest: f64 = (1..=KEPT).filter(|h| *h != 3 && *h != 5).map(|h| cycle.cos[h].abs() + cycle.sin[h].abs()).sum::<f64>()
            + cycle.cos[3].abs()
            + cycle.sin[5].abs();
        assert!(rest < 1e-5, "nothing else in it, and no DC: {rest}");
        // It holds no more harmonics than its points allow.
        assert!(cycle.cos[300..].iter().chain(&cycle.sin[300..]).all(|a| *a == 0.0));
    }

    #[test]
    fn each_level_has_its_harmonics_and_no_more() {
        let table = table(&[saw()]);
        assert_eq!(table.len(), RECORD);
        let starts = offsets();
        // The saw's Gibbs peak is the highest point, at the fullest level: that is the 1.
        let peak = table.iter().fold(0.0f32, |top, p| top.max(p.abs()));
        assert!((peak - 1.0).abs() < 1e-6, "the table's peak is 1, got {peak}");
        let gain = 1.0 / saw().peak();
        for level in 0..LEVELS {
            let length = LENGTHS[level];
            let level_points = &table[starts[level] + 1..starts[level] + 1 + length];
            let found = Cycle::from_points(level_points);
            for h in 1..=KEPT.min(length / 2 - 1) {
                let expected = if h <= HARMONICS[level] { gain / h as f64 } else { 0.0 };
                assert!((found.sin[h] - expected).abs() < 2e-6, "level {level} harmonic {h}: {} for {expected}", found.sin[h]);
                assert!(found.cos[h].abs() < 2e-6, "level {level} harmonic {h} keeps its phase");
            }
            // No DC, and the guard points are the cycle going round.
            assert!(level_points.iter().map(|p| *p as f64).sum::<f64>().abs() / (length as f64) < 1e-6, "level {level} has no DC");
            assert_eq!(table[starts[level]], level_points[length - 1], "level {level}: the point before");
            assert_eq!(table[starts[level] + 1 + length], level_points[0], "level {level}: the first point after");
            assert_eq!(table[starts[level] + 2 + length], level_points[1], "level {level}: the second point after");
        }
    }

    #[test]
    fn frames_follow_each_other_at_one_gain() {
        let quiet = saw().scaled(0.25);
        let table = table(&[saw(), quiet, square()]);
        assert_eq!(table.len(), 3 * RECORD);
        let level = |frame: usize, level: usize| {
            let at = frame * RECORD + offsets()[level] + 1;
            Cycle::from_points(&table[at..at + LENGTHS[level]])
        };
        let ratio = level(1, 3).sin[1] / level(0, 3).sin[1];
        assert!((ratio - 0.25).abs() < 1e-4, "a quieter frame stays quieter: {ratio}");
        assert!(level(2, 0).sin[2].abs() < 1e-6 && level(2, 0).sin[3] > 0.1, "the third frame is the square");
        assert!(table.iter().all(|p| p.abs() <= 1.0));
        // Silence stays silence, and is not divided by nothing.
        assert!(super::table(&[Cycle::silent()]).iter().all(|p| *p == 0.0));
    }

    #[test]
    fn keeps_the_first_and_the_last_of_too_many_frames() {
        let frames: Vec<Cycle> = (1..=200).map(|n| Cycle::from_sines(&[n as f64])).collect();
        let kept = thinned(&frames, MAX_FRAMES);
        assert_eq!(kept.len(), MAX_FRAMES);
        assert_eq!((kept[0].sin[1], kept[MAX_FRAMES - 1].sin[1]), (1.0, 200.0));
        assert!(kept.windows(2).all(|pair| pair[1].sin[1] > pair[0].sin[1]), "in order, none twice");
        assert_eq!(thinned(&frames[..5], MAX_FRAMES).len(), 5);
        assert_eq!(table(&frames).len(), MAX_FRAMES * RECORD);
    }

    /// A WAV file's bytes with the chunks given after its format chunk.
    fn riff(chunks: &[(&[u8; 4], &[u8])]) -> Vec<u8> {
        let mut body = b"WAVEfmt \x10\0\0\0".to_vec();
        body.extend([1, 0, 1, 0, 0x44, 0xac, 0, 0, 0x88, 0x58, 1, 0, 2, 0, 16, 0]);
        for (name, data) in chunks {
            body.extend(*name);
            body.extend((data.len() as u32).to_le_bytes());
            body.extend(*data);
            if data.len() % 2 == 1 {
                body.push(0);
            }
        }
        let mut file = b"RIFF".to_vec();
        file.extend((body.len() as u32).to_le_bytes());
        file.extend(body);
        file
    }

    #[test]
    fn finds_the_frame_length_a_file_declares() {
        let serum = riff(&[(b"LIST", b"odd"), (b"clm ", b"<!>2048 10000000 wavetable (www.example.com)"), (b"data", &[0; 8])]);
        assert_eq!(declared_cycle(&serum), Some(2048));
        assert_eq!(declared_cycle(&riff(&[(b"data", &[0; 8]), (b"clm ", b"<!>1024 00000000")])), Some(1024));
        assert_eq!(declared_cycle(&riff(&[(b"data", &[0; 8])])), None);
        assert_eq!(declared_cycle(&riff(&[(b"clm ", b"nonsense")])), None);
        assert_eq!(declared_cycle(&riff(&[(b"clm ", b"<!>0 ")])), None);
        assert_eq!(declared_cycle(b"not a wav at all"), None);
        assert_eq!(declared_cycle(&serum[..30]), None);
    }

    #[test]
    fn works_out_how_long_a_cycle_is() {
        // What the user chose, then what the file says, then a guess from its length.
        assert_eq!(cycle_length(100_000, Some(512), Some(2048)), 512);
        assert_eq!(cycle_length(100_000, None, Some(1024)), 1024);
        assert_eq!(cycle_length(16_384, None, None), 256, "a WaveEdit bank");
        assert_eq!(cycle_length(16_384, Some(2048), None), 2048, "or eight frames of Serum's, when told so");
        assert_eq!(cycle_length(600, None, None), 600, "one short cycle");
        assert_eq!(cycle_length(4096, None, None), 4096);
        assert_eq!(cycle_length(524_288, None, None), 2048);
        assert_eq!(cycle_length(300, Some(2048), None), 300, "never longer than the sound");

        let sound: Vec<f32> = (0..2048 * 3 + 500).map(|i| ((i / 2048 + 1) as f32) * (2.0 * std::f32::consts::PI * i as f32 / 2048.0).sin()).collect();
        let frames = cycles(&sound, cycle_length(sound.len(), None, None), MAX_FRAMES);
        assert_eq!(frames.len(), 3, "whole cycles only");
        for (number, frame) in frames.iter().enumerate() {
            assert!((frame.sin[1] - (number + 1) as f64).abs() < 1e-4, "frame {number} is the sine at its own level");
        }
        // Of more cycles than a table holds, the first, the last and some between are taken.
        let few = cycles(&sound, 2048, 2);
        assert_eq!(few.len(), 2);
        assert!((few[0].sin[1] - 1.0).abs() < 1e-4 && (few[1].sin[1] - 3.0).abs() < 1e-4);
        assert!(cycles(&sound[..100], 2048, MAX_FRAMES).is_empty());
    }

    #[test]
    fn draws_a_few_frames_small() {
        let frames: Vec<Cycle> = (0..40).map(|n| if n < 20 { saw() } else { square() }).collect();
        let drawn = picture(&frames, 16, 64);
        assert_eq!(drawn.len(), 16);
        assert!(drawn.iter().all(|frame| frame.len() == 64 && frame.iter().all(|p| p.abs() <= 1.0)));
        assert!(drawn[0] != drawn[15]);
        assert_eq!(picture(&frames[..3], 16, 64).len(), 3);
    }
}
