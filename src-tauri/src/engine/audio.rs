//! The preview engine: one Pd instance rendered into the default audio output.
//!
//! Threads:
//! - the cpal callback renders Pd blocks and applies queued messages;
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
use cpal::{FromSample, SampleFormat, SizedSample, StreamConfig};

use super::pd::{Atom, Binding, Patch, Pd, PdEvent};

/// The Organelle runs Pd at this rate; the preview asks the device for the same.
pub const DEVICE_SAMPLE_RATE: u32 = 44_100;

/// Preview stand-in for the Organelle's host patch, written next to every loaded patch.
const HOST_PATCH: &str = include_str!("../../../pd-lib/host.pd");
const HOST_FILE: &str = "gridelle-host.pd";

/// Names the Organelle host listens to; the preview forwards whatever a patch sends there.
const HOST_OUTPUTS: &[&str] =
    &["screenLine1", "screenLine2", "screenLine3", "screenLine4", "screenLine5", "led"];

const FADE_MS: u64 = 12;

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
            pd.init_audio(sample_rate)?;
            pd.dsp(true);
            HOST_OUTPUTS.iter().map(|name| pd.bind(name)).collect()
        };

        let shared = Arc::new(Shared {
            fade: AtomicU32::new(1.0f32.to_bits()),
            volume: AtomicU32::new(0.8f32.to_bits()),
            peak: AtomicU32::new(0),
        });
        let (producer, consumer) = rtrb::RingBuffer::<Message>::new(1024);

        let stream = match format {
            SampleFormat::F32 => build::<f32>(&device, config, channels, shared.clone(), consumer),
            SampleFormat::I16 => build::<i16>(&device, config, channels, shared.clone(), consumer),
            SampleFormat::I32 => build::<i32>(&device, config, channels, shared.clone(), consumer),
            other => Err(format!("unsupported output sample format {other}")),
        }?;
        stream.play().map_err(|e| e.to_string())?;

        Ok(Engine {
            shared,
            queue: Mutex::new(producer),
            loaded: Mutex::new(None),
            _bindings: Mutex::new(bindings),
            _stream: Mutex::new(stream),
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

    /// Replace the running patch with `files` (name → Pd text); `entry` names the main patch.
    /// The output fades out, the patch is swapped under the Pd lock, and it fades back in.
    pub fn load(&self, files: &HashMap<String, String>, entry: &str) -> Result<(), String> {
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
                Ok(())
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

fn build<T>(
    device: &cpal::Device,
    config: StreamConfig,
    channels: usize,
    shared: Arc<Shared>,
    mut queue: rtrb::Consumer<Message>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let block_len = Pd::block_size() * 2;
    let mut block = vec![0.0f32; block_len];
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

        let target = load(&shared.fade) * load(&shared.volume);
        let mut peak = 0.0f32;
        for frame in data.chunks_mut(channels) {
            if pos >= block_len {
                pd.process(&mut block);
                pos = 0;
            }
            gain += (target - gain).clamp(-step, step);
            let (left, right) = (block[pos] * gain, block[pos + 1] * gain);
            pos += 2;
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
