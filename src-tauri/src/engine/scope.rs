//! What the scopes show: the latest stretch of each signal a Scope module taps.
//!
//! The audio callback writes every sample of every scope channel; a command from the UI
//! reads a window of one of them, reduced to the columns of the picture. Neither waits for
//! the other: the samples are atomics, and a reader that is overtaken by the writer gets a
//! few samples from the wrong lap, which a moving picture does not show.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

/// Scope modules a patch can show at once: the extra output channels Pd is given.
pub const SLOTS: usize = 8;

/// Samples kept for each slot, a power of two: nearly six seconds at 44.1 kHz.
const CAPACITY: usize = 1 << 18;

/// The longest window that can be asked for. A triggered window looks back twice its length.
pub const MAX_WINDOW: usize = CAPACITY / 2;

pub struct ScopeStore {
    slots: Vec<Vec<AtomicU32>>,
    /// Frames written so far. Frame `n` is at index `n % CAPACITY` of every slot.
    written: AtomicU64,
}

impl Default for ScopeStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ScopeStore {
    pub fn new() -> ScopeStore {
        let slot = || (0..CAPACITY).map(|_| AtomicU32::new(0)).collect();
        ScopeStore { slots: (0..SLOTS).map(|_| slot()).collect(), written: AtomicU64::new(0) }
    }

    /// Add one frame: a sample for each slot. Called from the audio callback only.
    pub fn write(&self, frame: &[f32]) {
        let at = self.written.load(Ordering::Relaxed);
        let index = (at as usize) & (CAPACITY - 1);
        for (slot, sample) in self.slots.iter().zip(frame) {
            slot[index].store(sample.to_bits(), Ordering::Relaxed);
        }
        self.written.store(at + 1, Ordering::Release);
    }

    /// The last `count` samples of a slot, oldest first. Shorter while less has been written.
    fn latest(&self, slot: usize, count: usize) -> Vec<f32> {
        let Some(samples) = self.slots.get(slot) else { return Vec::new() };
        let end = self.written.load(Ordering::Acquire);
        let count = (count.min(CAPACITY) as u64).min(end);
        (end - count..end)
            .map(|n| f32::from_bits(samples[(n as usize) & (CAPACITY - 1)].load(Ordering::Relaxed)))
            .collect()
    }

    /// A window of `length` samples of a slot as `columns` pairs of (lowest, highest), left
    /// to right, for drawing. With `trigger` the window starts where the signal last rose
    /// through its middle, so that a steady wave stands still; otherwise it is the latest
    /// `length` samples.
    pub fn picture(&self, slot: usize, length: usize, columns: usize, trigger: bool) -> Vec<f32> {
        let length = length.clamp(1, MAX_WINDOW);
        let recent = self.latest(slot, if trigger { length * 2 } else { length });
        let start = if trigger { trigger_point(&recent, length) } else { recent.len().saturating_sub(length) };
        columns_of(&recent[start..(start + length).min(recent.len())], columns)
    }
}

/// Where a window of `length` samples should start in `samples` so that it begins on the
/// last rise through the middle of the signal that still leaves room for the whole window.
/// The latest `length` samples when there is no such rise.
fn trigger_point(samples: &[f32], length: usize) -> usize {
    let latest = samples.len().saturating_sub(length);
    let (low, high) = samples.iter().fold((f32::MAX, f32::MIN), |(lo, hi), s| (lo.min(*s), hi.max(*s)));
    // A flat line has nothing to trigger on, and noise this small should not be chased.
    if !(high - low > 1e-4) {
        return latest;
    }
    let middle = (low + high) / 2.0;
    (1..=latest).rev().find(|&i| samples[i - 1] < middle && samples[i] >= middle).unwrap_or(latest)
}

/// `samples` reduced to `columns` pairs of (lowest, highest). Fewer when there are fewer
/// samples than columns: then each sample is a column of its own.
fn columns_of(samples: &[f32], columns: usize) -> Vec<f32> {
    if samples.is_empty() {
        return Vec::new();
    }
    let columns = columns.clamp(1, samples.len());
    let mut picture = Vec::with_capacity(columns * 2);
    for column in 0..columns {
        let from = column * samples.len() / columns;
        let to = ((column + 1) * samples.len() / columns).max(from + 1).min(samples.len());
        let (low, high) = samples[from..to].iter().fold((f32::MAX, f32::MIN), |(lo, hi), s| (lo.min(*s), hi.max(*s)));
        picture.extend([low, high]);
    }
    picture
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_with(slot: usize, samples: impl Iterator<Item = f32>) -> ScopeStore {
        let store = ScopeStore::new();
        let mut frame = [0.0f32; SLOTS];
        for sample in samples {
            frame[slot] = sample;
            store.write(&frame);
        }
        store
    }

    #[test]
    fn gives_the_latest_samples_of_the_slot_asked_for() {
        let store = store_with(2, (0..1000).map(|n| n as f32));
        assert_eq!(store.picture(2, 4, 4, false), [996.0, 996.0, 997.0, 997.0, 998.0, 998.0, 999.0, 999.0]);
        // Another slot got silence, and a slot that does not exist gives nothing.
        assert_eq!(store.picture(3, 2, 2, false), [0.0, 0.0, 0.0, 0.0]);
        assert_eq!(store.picture(SLOTS, 4, 4, false), Vec::<f32>::new());
    }

    #[test]
    fn reduces_a_window_to_the_lowest_and_highest_of_each_column() {
        let store = store_with(0, (0..100).map(|n| n as f32));
        // The last 100 samples in 4 columns of 25.
        assert_eq!(store.picture(0, 100, 4, false), [0.0, 24.0, 25.0, 49.0, 50.0, 74.0, 75.0, 99.0]);
        // More columns than samples: one column for each sample.
        assert_eq!(store.picture(0, 3, 512, false), [97.0, 97.0, 98.0, 98.0, 99.0, 99.0]);
    }

    #[test]
    fn has_less_to_show_until_enough_has_been_written() {
        let store = store_with(0, [1.0, 2.0, 3.0].into_iter());
        assert_eq!(store.picture(0, 100, 100, false), [1.0, 1.0, 2.0, 2.0, 3.0, 3.0]);
        assert_eq!(ScopeStore::new().picture(0, 100, 100, true), Vec::<f32>::new());
    }

    #[test]
    fn keeps_going_round_when_more_than_its_capacity_has_been_written() {
        let store = store_with(0, (0..CAPACITY + 10).map(|n| n as f32));
        let picture = store.picture(0, 2, 2, false);
        assert_eq!(picture, [(CAPACITY + 8) as f32, (CAPACITY + 8) as f32, (CAPACITY + 9) as f32, (CAPACITY + 9) as f32]);
    }

    #[test]
    fn starts_a_triggered_window_where_the_wave_rises_through_its_middle() {
        // A sine with a period of 100 samples, stopped at different points of its cycle: the
        // window always starts at the same point of the wave.
        let sine = |n: usize| (2.0 * std::f32::consts::PI * n as f32 / 100.0).sin();
        for stop in [1000, 1013, 1049, 1077] {
            let store = store_with(0, (0..stop).map(sine));
            let picture = store.picture(0, 200, 200, true);
            assert_eq!(picture.len(), 400);
            assert!(picture[0].abs() < 0.07 && picture[2] > picture[0], "stopped at {stop}: starts at {} then {}", picture[0], picture[2]);
        }
        // A signal that never crosses zero is triggered on its own middle.
        let store = store_with(0, (0..1050).map(|n| 5.0 + sine(n)));
        let picture = store.picture(0, 200, 200, true);
        assert!((picture[0] - 5.0).abs() < 0.07 && picture[2] > picture[0]);
    }

    #[test]
    fn shows_the_latest_stretch_when_there_is_nothing_to_trigger_on() {
        let store = store_with(0, (0..500).map(|_| 0.25));
        assert_eq!(store.picture(0, 3, 3, true), [0.25; 6]);
        // A ramp that only falls has no rise: the latest samples.
        let store = store_with(0, (0..500).map(|n| -(n as f32)));
        assert_eq!(store.picture(0, 2, 2, true), [-498.0, -498.0, -499.0, -499.0]);
    }
}
