//! The preview engine: one Pd instance rendered into the default audio output.
//!
//! While the loaded patch has an Audio In module, the default audio input is opened too and
//! fed to Pd as its audio input, which the host stand-in passes on as `inL` and `inR`.
//!
//! Threads:
//! - the cpal output callback renders Pd blocks and applies queued messages;
//! - the cpal input callback, while there is one, writes samples for the output callback;
//! - a forwarder thread hands Pd's output (screen text, LED, console) to the app;
//! - callers (Tauri commands) only queue messages or swap patches under the Pd lock.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, StreamConfig};

use super::pd::{Atom, Binding, Patch, Pd, PdEvent};
use super::scope::{self, ScopeStore};

/// The Organelle runs Pd at this rate; the preview asks the device for the same.
pub const DEVICE_SAMPLE_RATE: u32 = 44_100;

/// Preview stand-in for the Organelle's host patch, written next to every loaded patch.
const HOST_PATCH: &str = include_str!("../../../pd-lib/host.pd");
const HOST_FILE: &str = "gridelle-host.pd";

/// Names the Organelle host listens to; the preview forwards whatever a patch sends there.
const HOST_OUTPUTS: &[&str] =
    &["screenLine1", "screenLine2", "screenLine3", "screenLine4", "screenLine5", "led"];

const FADE_MS: u64 = 12;

/// The file a patch has when it uses the audio input: only then is the input device opened.
const AUDIO_IN_FILE: &str = "ge-audio-in.pd";

/// Samples (left and right interleaved) the input side can hold for the output side.
const INPUT_CAPACITY: usize = 16_384;
/// Reading starts once this much is waiting, so that the two callbacks, which do not run
/// in step, do not leave gaps: about 23 ms at 44.1 kHz.
const INPUT_CUSHION: usize = 2_048;
/// More than this waiting means the output has fallen behind: skip ahead to the cushion.
const INPUT_MAX_LAG: usize = 8_192;

/// Output channels Pd renders: left and right for the audio device, then one for each scope.
/// The host stand-in sends what the Scope modules tap to those.
const PD_OUTPUTS: usize = 2 + scope::SLOTS;

/// The samples of an open audio input, read by the output callback.
type InputFeed = rtrb::Consumer<f32>;

struct Message {
    recv: String,
    atoms: Vec<Atom>,
}

/// Shared between the audio callback and the control side.
struct Shared {
    /// Reload fade, 0.0 or 1.0, stored as f32 bits.
    fade: AtomicU32,
    /// User volume 0..1, stored as f32 bits.
    volume: AtomicU32,
    /// Peak of the last callback, stored as f32 bits.
    peak: AtomicU32,
    /// A change of audio input for the output callback to pick up: a new feed, or none.
    input_change: Mutex<Option<Option<InputFeed>>>,
}

fn load(a: &AtomicU32) -> f32 {
    f32::from_bits(a.load(Ordering::Relaxed))
}

fn store(a: &AtomicU32, v: f32) {
    a.store(v.to_bits(), Ordering::Relaxed)
}

struct Loaded {
    patches: Vec<Patch>,
    dir: PathBuf,
}

pub struct Engine {
    shared: Arc<Shared>,
    queue: Mutex<rtrb::Producer<Message>>,
    loaded: Mutex<Option<Loaded>>,
    _bindings: Mutex<Vec<Binding>>,
    _stream: Mutex<cpal::Stream>,
    /// The audio input, open only while the loaded patch uses it.
    input: Mutex<Option<cpal::Stream>>,
    scopes: Arc<ScopeStore>,
    sample_rate: u32,
    revision: AtomicU64,
}

impl Engine {
    /// Open the default output device and start rendering. `on_event` is called from a
    /// background thread for everything the patch prints or sends to the host.
    pub fn start(on_event: impl Fn(PdEvent) + Send + 'static) -> Result<Engine, String> {
        if let Some(events) = Pd::init() {
            thread::Builder::new()
                .name("pd-events".into())
                .spawn(move || {
                    for event in events {
                        on_event(event);
                    }
                })
                .map_err(|e| e.to_string())?;
        }

        let device = cpal::default_host()
            .default_output_device()
            .ok_or("no audio output device found")?;
        let default = device.default_output_config().map_err(|e| e.to_string())?;
        let format = default.sample_format();
        let channels = default.channels() as usize;

        // Prefer the Organelle's sample rate when the device offers it.
        let wants_device_rate = device
            .supported_output_configs()
            .map(|mut configs| {
                configs.any(|c| {
                    c.channels() as usize == channels
                        && c.sample_format() == format
                        && c.min_sample_rate() <= DEVICE_SAMPLE_RATE
                        && c.max_sample_rate() >= DEVICE_SAMPLE_RATE
                })
            })
            .unwrap_or(false);
        let mut config: StreamConfig = default.into();
        if wants_device_rate {
            config.sample_rate = DEVICE_SAMPLE_RATE;
        }
        let sample_rate = config.sample_rate;

        let bindings = {
            let mut pd = Pd::lock();
            pd.init_audio_with_outputs(sample_rate, PD_OUTPUTS)?;
            pd.dsp(true);
            HOST_OUTPUTS.iter().map(|name| pd.bind(name)).collect()
        };

        let shared = Arc::new(Shared {
            fade: AtomicU32::new(1.0f32.to_bits()),
            volume: AtomicU32::new(0.8f32.to_bits()),
            peak: AtomicU32::new(0),
            input_change: Mutex::new(None),
        });
        let (producer, consumer) = rtrb::RingBuffer::<Message>::new(1024);
        let scopes = Arc::new(ScopeStore::new());

        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, channels, shared.clone(), scopes.clone(), consumer),
            SampleFormat::I16 => build::<i16>(&device, config, channels, shared.clone(), scopes.clone(), consumer),
            SampleFormat::I32 => build::<i32>(&device, config, channels, shared.clone(), scopes.clone(), consumer),
            other => Err(format!("unsupported output sample format {other}")),
        }?;
        stream.play().map_err(|e| e.to_string())?;

        Ok(Engine {
            shared,
            queue: Mutex::new(producer),
            loaded: Mutex::new(None),
            _bindings: Mutex::new(bindings),
            _stream: Mutex::new(stream),
            input: Mutex::new(None),
            scopes,
            sample_rate,
            revision: AtomicU64::new(0),
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Peak output level of the most recent audio callback.
    pub fn peak(&self) -> f32 {
        load(&self.shared.peak)
    }

    /// What the Scope module on `slot` (counted from 0) shows: its last `length` samples as
    /// `columns` pairs of (lowest, highest). See `ScopeStore::picture`.
    pub fn scope(&self, slot: usize, length: usize, columns: usize, trigger: bool) -> Vec<f32> {
        self.scopes.picture(slot, length, columns, trigger)
    }

    pub fn set_volume(&self, volume: f32) {
        store(&self.shared.volume, volume.clamp(0.0, 1.0));
    }

    /// Queue a message for a receiver in the patch (`knob1`, `notes`, a parameter name, ...).
    /// It is applied at the start of the next audio callback.
    pub fn send(&self, recv: &str, atoms: Vec<Atom>) -> Result<(), String> {
        self.queue
            .lock()
            .unwrap()
            .push(Message { recv: recv.to_string(), atoms })
            .map_err(|_| "engine message queue is full".to_string())
    }

    /// Open the audio input, or close it, to match what the patch needs. Returns why the
    /// input is not available, when it is wanted and cannot be had.
    fn set_input(&self, wanted: bool) -> Option<String> {
        let mut input = self.input.lock().unwrap();
        if !wanted {
            if input.take().is_some() {
                *self.shared.input_change.lock().unwrap() = Some(None);
            }
            return None;
        }
        if input.is_some() {
            return None;
        }
        match open_input(self.sample_rate) {
            Ok((stream, feed)) => {
                *self.shared.input_change.lock().unwrap() = Some(Some(feed));
                *input = Some(stream);
                None
            }
            Err(reason) => Some(reason),
        }
    }

    /// Replace the running patch with `files` (name → Pd text); `entry` names the main patch.
    /// The output fades out, the patch is swapped under the Pd lock, and it fades back in.
    ///
    /// A patch with an Audio In module gets the computer's audio input. When that cannot be
    /// opened the patch still loads, with silence at its input, and the reason is returned.
    pub fn load(&self, files: &HashMap<String, String>, entry: &str) -> Result<Option<String>, String> {
        if !files.contains_key(entry) {
            return Err(format!("entry patch {entry} is not among the files"));
        }
        let revision = self.revision.fetch_add(1, Ordering::Relaxed);
        let dir = preview_dir().join(format!("rev-{revision}"));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (name, text) in files {
            if name.contains(['/', '\\']) || name.starts_with('.') || name == HOST_FILE {
                return Err(format!("invalid patch file name {name:?}"));
            }
            fs::write(dir.join(name), text).map_err(|e| e.to_string())?;
        }
        fs::write(dir.join(HOST_FILE), HOST_PATCH).map_err(|e| e.to_string())?;

        let mut loaded = self.loaded.lock().unwrap();
        store(&self.shared.fade, 0.0);
        thread::sleep(Duration::from_millis(FADE_MS * 2));

        let result = {
            let mut pd = Pd::lock();
            if let Some(old) = loaded.take() {
                for patch in old.patches {
                    pd.close(patch);
                }
                let _ = fs::remove_dir_all(&old.dir);
            }
            pd.open(&dir.join(HOST_FILE)).and_then(|host| match pd.open(&dir.join(entry)) {
                Ok(main) => Ok(vec![host, main]),
                Err(e) => {
                    pd.close(host);
                    Err(e)
                }
            })
        };
        store(&self.shared.fade, 1.0);

        match result {
            Ok(patches) => {
                *loaded = Some(Loaded { patches, dir });
                Ok(self.set_input(files.contains_key(AUDIO_IN_FILE)))
            }
            Err(e) => {
                let _ = fs::remove_dir_all(&dir);
                Err(e)
            }
        }
    }
}

/// Where this process keeps the patch revisions it loads.
fn preview_dir() -> PathBuf {
    std::env::temp_dir().join(format!("gridelle-preview-{}", std::process::id()))
}

/// Delete this process's preview files. Call once on exit.
pub fn remove_preview_files() {
    let _ = fs::remove_dir_all(preview_dir());
}

/// Open the default audio input at the output's sample rate. Returns the stream, which
/// records for as long as it is kept, and the end to read its samples from.
fn open_input(sample_rate: u32) -> Result<(cpal::Stream, InputFeed), String> {
    let device = cpal::default_host().default_input_device().ok_or("No audio input device was found.")?;
    // The input has to run at the rate Pd runs at. Prefer float samples, then two channels.
    let supported = device
        .supported_input_configs()
        .map_err(|e| format!("The audio input could not be opened ({e})."))?
        .filter(|c| c.min_sample_rate() <= sample_rate && c.max_sample_rate() >= sample_rate)
        .filter(|c| matches!(c.sample_format(), SampleFormat::F32 | SampleFormat::I16 | SampleFormat::I32))
        .min_by_key(|c| (c.sample_format() != SampleFormat::F32, c.channels() != 2, c.channels()))
        .ok_or_else(|| format!("The audio input does not run at {} kHz, the rate of the output.", sample_rate as f32 / 1000.0))?;
    let format = supported.sample_format();
    let channels = supported.channels() as usize;
    let config: StreamConfig = supported.with_sample_rate(sample_rate).into();

    let (producer, feed) = rtrb::RingBuffer::<f32>::new(INPUT_CAPACITY);
    let stream = match format {
        SampleFormat::F32 => build_input::<f32>(&device, config, channels, producer),
        SampleFormat::I16 => build_input::<i16>(&device, config, channels, producer),
        _ => build_input::<i32>(&device, config, channels, producer),
    }?;
    stream.play().map_err(|e| format!("The audio input could not be started ({e})."))?;
    Ok((stream, feed))
}

fn build_input<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    mut samples: rtrb::Producer<f32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let callback = move |data: &[T], _: &cpal::InputCallbackInfo| {
        for frame in data.chunks(channels.max(1)) {
            // When the output side is not keeping up, the newest samples are the ones dropped.
            if samples.slots() < 2 {
                break;
            }
            let left = f32::from_sample(frame[0]);
            // A single channel, such as a built-in microphone, goes to both sides.
            let right = frame.get(1).map_or(left, |sample| f32::from_sample(*sample));
            let _ = samples.push(left);
            let _ = samples.push(right);
        }
    };
    device
        .build_input_stream(config, callback, |err| eprintln!("audio input stream: {err}"), None)
        .map_err(|e| format!("The audio input could not be opened ({e})."))
}

/// The output callback's view of the audio input: one Pd block of it at a time.
struct InputReader {
    feed: Option<InputFeed>,
    /// Enough has gathered to read without gaps.
    primed: bool,
}

impl InputReader {
    /// Fill `block` with the next input samples, or with silence where there are none.
    fn next_block(&mut self, block: &mut [f32]) {
        block.fill(0.0);
        let Some(feed) = &mut self.feed else { return };
        let mut waiting = feed.slots();
        if waiting > INPUT_MAX_LAG {
            // Catch up, keeping left and right in step.
            let skip = (waiting - INPUT_CUSHION) & !1;
            if let Ok(chunk) = feed.read_chunk(skip) {
                chunk.commit_all();
            }
            waiting -= skip;
        }
        if !self.primed {
            self.primed = waiting >= INPUT_CUSHION;
        }
        if !self.primed {
            return;
        }
        if waiting < block.len() {
            // Ran dry: gather a cushion again instead of stuttering.
            self.primed = false;
            return;
        }
        for sample in block.iter_mut() {
            *sample = feed.pop().unwrap_or(0.0);
        }
    }
}

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    shared: Arc<Shared>,
    scopes: Arc<ScopeStore>,
    mut queue: rtrb::Consumer<Message>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    // A block of Pd's output: for each frame, left, right, then the scope channels.
    let block_len = Pd::block_size() * PD_OUTPUTS;
    let mut block = vec![0.0f32; block_len];
    let mut input_block = vec![0.0f32; Pd::block_size() * 2];
    let mut input = InputReader { feed: None, primed: false };
    // Start "empty" so the first frame renders a fresh block.
    let mut pos = block_len;
    let mut gain = 0.0f32;
    let step = 1.0 / (config.sample_rate as f32 * FADE_MS as f32 / 1000.0);

    let callback = move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
        let silence = T::from_sample(0.0f32);
        let Some(mut pd) = Pd::try_lock() else {
            // A patch swap holds the lock; it only happens after the fade-out.
            data.fill(silence);
            gain = 0.0;
            return;
        };
        while let Ok(message) = queue.pop() {
            pd.send(&message.recv, &message.atoms);
        }
        // The audio input was opened or closed since the last callback.
        if let Ok(mut change) = shared.input_change.try_lock() {
            if let Some(feed) = change.take() {
                input = InputReader { feed, primed: false };
            }
        }

        let target = load(&shared.fade) * load(&shared.volume);
        let mut peak = 0.0f32;
        for frame in data.chunks_mut(channels) {
            if pos >= block_len {
                input.next_block(&mut input_block);
                pd.process_with_input(&input_block, &mut block);
                pos = 0;
            }
            gain += (target - gain).clamp(-step, step);
            let (left, right) = (block[pos] * gain, block[pos + 1] * gain);
            scopes.write(&block[pos + 2..pos + PD_OUTPUTS]);
            pos += PD_OUTPUTS;
            peak = peak.max(left.abs()).max(right.abs());
            match frame {
                [mono] => *mono = T::from_sample((left + right) * 0.5),
                [l, r, rest @ ..] => {
                    *l = T::from_sample(left);
                    *r = T::from_sample(right);
                    rest.fill(silence);
                }
                [] => {}
            }
        }
        store(&shared.peak, peak);
    };

    device
        .build_output_stream(config, callback, |err| eprintln!("audio stream: {err}"), None)
        .map_err(|e| e.to_string())
}
