//! Sound files for the sample modules.
//!
//! A patch refers to a sound file where it is on this computer. Whoever writes a patch
//! folder (the preview, an export, a send to the Organelle) gets it here as the one kind of
//! file the Organelle's Pd 0.49 is sure to read: a mono, 16-bit WAV at the file's own rate.
//! WAV, AIFF, FLAC, MP3 and Ogg Vorbis are decoded; several channels are mixed to one.

use std::collections::HashMap;
use std::fs::File;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as DecodeError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

/// The longest sound that is taken, in seconds. A table of this at 48 kHz is 58 MB in Pd.
pub const MAX_SECONDS: u64 = 300;

/// Pairs of lowest and highest sample that a sound's picture is drawn from.
const PICTURE_COLUMNS: usize = 256;

/// A sound file of a patch: the name it has in the patch folder, and where it is now.
#[derive(Debug, Clone, Deserialize)]
pub struct SampleFile {
    pub file: String,
    pub path: String,
}

/// What the editor shows of a sound file.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SampleInfo {
    /// The file's name, without its folders.
    pub name: String,
    pub frames: usize,
    pub sample_rate: u32,
    /// `PICTURE_COLUMNS` pairs of (lowest, highest), left to right; fewer for a very short sound.
    pub peaks: Vec<f32>,
}

/// A decoded sound: one channel, at its own rate.
#[derive(Debug, Clone, PartialEq)]
pub struct Sound {
    pub rate: u32,
    pub samples: Vec<f32>,
}

/// A sound file as the patch folder gets it.
pub struct Converted {
    pub rate: u32,
    pub frames: usize,
    /// The bytes of a mono, 16-bit WAV.
    pub wav: Vec<u8>,
    pub peaks: Vec<f32>,
}

fn file_name(path: &str) -> String {
    Path::new(path).file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

/// Decode a sound file and mix its channels to one.
pub fn decode(path: &str) -> Result<Sound, String> {
    let name = file_name(path);
    let unreadable = |why: String| format!("{name} could not be read as a sound file ({why}).");

    let file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("{name} is not where the patch expects it: {path}"),
        _ => format!("{name} could not be opened ({e})."),
    })?;
    let mut hint = Hint::new();
    if let Some(extension) = Path::new(path).extension().and_then(|e| e.to_str()) {
        hint.with_extension(extension);
    }
    let stream = MediaSourceStream::new(Box::new(file), Default::default());
    let probed = symphonia::default::get_probe()
        .format(&hint, stream, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|_| unreadable("it is not WAV, AIFF, FLAC, MP3 or Ogg Vorbis".into()))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| unreadable("there is no sound in it".into()))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| unreadable(e.to_string()))?;

    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut samples: Vec<f32> = Vec::new();
    let mut buffer: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            // The end of the file arrives as an error.
            Err(DecodeError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(DecodeError::ResetRequired) => break,
            Err(e) => return Err(unreadable(e.to_string())),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            // A damaged packet is skipped, as players do.
            Err(DecodeError::DecodeError(_)) => continue,
            Err(e) => return Err(unreadable(e.to_string())),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        rate = spec.rate;
        let buffer = buffer.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        if buffer.capacity() < decoded.capacity() * channels {
            *buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        }
        buffer.copy_interleaved_ref(decoded);
        samples.extend(buffer.samples().chunks(channels).map(|frame| frame.iter().sum::<f32>() / channels as f32));
        if rate > 0 && samples.len() as u64 > MAX_SECONDS * rate as u64 {
            return Err(format!("{name} is longer than {} minutes, which is more than a sample can be.", MAX_SECONDS / 60));
        }
    }
    if rate == 0 || samples.is_empty() {
        return Err(unreadable("there is no sound in it".into()));
    }
    Ok(Sound { rate, samples })
}

/// A mono, 16-bit WAV of the sound.
pub fn wav_bytes(sound: &Sound) -> Vec<u8> {
    let data = (sound.samples.len() * 2) as u32;
    let mut bytes = Vec::with_capacity(44 + data as usize);
    bytes.extend(b"RIFF");
    bytes.extend((36 + data).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes()); // PCM
    bytes.extend(1u16.to_le_bytes()); // one channel
    bytes.extend(sound.rate.to_le_bytes());
    bytes.extend((sound.rate * 2).to_le_bytes());
    bytes.extend(2u16.to_le_bytes());
    bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend(data.to_le_bytes());
    for sample in &sound.samples {
        bytes.extend(((sample.clamp(-1.0, 1.0) * 32767.0).round() as i16).to_le_bytes());
    }
    bytes
}

/// The lowest and highest sample of each of up to `columns` stretches of the sound.
fn peaks(samples: &[f32], columns: usize) -> Vec<f32> {
    let columns = columns.min(samples.len());
    let mut picture = Vec::with_capacity(columns * 2);
    for column in 0..columns {
        let part = &samples[column * samples.len() / columns..(column + 1) * samples.len() / columns];
        let (low, high) = part.iter().fold((f32::MAX, f32::MIN), |(lo, hi), s| (lo.min(*s), hi.max(*s)));
        picture.extend([low, high]);
    }
    picture
}

/// What a file was when it was converted: a changed file is converted again.
#[derive(Clone, Copy, PartialEq)]
struct Stamp {
    modified: Option<SystemTime>,
    length: u64,
}

fn stamp(path: &str) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(Stamp { modified: meta.modified().ok(), length: meta.len() })
}

/// The files converted so far in this run. A patch reloads at every structural edit, and
/// decoding a long MP3 each time would make every such edit wait.
static CONVERTED: Mutex<Option<HashMap<String, (Stamp, Arc<Converted>)>>> = Mutex::new(None);
const KEPT: usize = 16;

/// The sound file at `path`, converted. Kept from the last time while the file has not changed.
pub fn converted(path: &str) -> Result<Arc<Converted>, String> {
    let now = stamp(path);
    {
        let cache = CONVERTED.lock().unwrap();
        if let (Some(now), Some((then, kept))) = (now, cache.as_ref().and_then(|c| c.get(path))) {
            if *then == now {
                return Ok(kept.clone());
            }
        }
    }
    let sound = decode(path)?;
    let converted = Arc::new(Converted {
        rate: sound.rate,
        frames: sound.samples.len(),
        wav: wav_bytes(&sound),
        peaks: peaks(&sound.samples, PICTURE_COLUMNS),
    });
    if let Some(now) = now {
        let mut cache = CONVERTED.lock().unwrap();
        let cache = cache.get_or_insert_with(HashMap::new);
        if cache.len() >= KEPT {
            cache.clear();
        }
        cache.insert(path.to_string(), (now, converted.clone()));
    }
    Ok(converted)
}

/// What the editor shows of the sound file at `path`.
pub fn info(path: &str) -> Result<SampleInfo, String> {
    let sound = converted(path)?;
    Ok(SampleInfo { name: file_name(path), frames: sound.frames, sample_rate: sound.rate, peaks: sound.peaks.clone() })
}

/// Whether `name` is a name a patch's sound file can have in its folder.
pub fn is_sample_name(name: &str) -> bool {
    name.starts_with("ge-sample-") && name.ends_with(".wav") && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.'))
}

/// The bytes of each of a patch's sound files, by the name it has in the patch folder.
pub fn convert_all(samples: &[SampleFile]) -> Result<Vec<(String, Arc<Converted>)>, String> {
    samples
        .iter()
        .map(|sample| {
            if !is_sample_name(&sample.file) {
                return Err(format!("invalid sample file name {:?}", sample.file));
            }
            Ok((sample.file.clone(), converted(&sample.path)?))
        })
        .collect()
}

/// Write a patch's sound files into its folder.
pub fn write_all(dir: &Path, samples: &[SampleFile]) -> Result<(), String> {
    for (name, sound) in convert_all(samples)? {
        std::fs::write(dir.join(&name), &sound.wav).map_err(|e| format!("{name} could not be written ({e})."))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sound(name: &str) -> String {
        format!("{}/tests/sounds/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// The level of the 441 Hz that every test sound is, and of everything else in it.
    fn tone_and_rest(sound: &Sound) -> (f32, f32) {
        let w = 2.0 * std::f32::consts::PI * 441.0 / sound.rate as f32;
        // The middle half: a lossy format pads its ends with silence and rings there.
        let middle = &sound.samples[sound.samples.len() / 4..sound.samples.len() * 3 / 4];
        let (mut sin, mut cos) = (0.0f64, 0.0f64);
        for (n, s) in middle.iter().enumerate() {
            sin += (*s * (w * n as f32).sin()) as f64;
            cos += (*s * (w * n as f32).cos()) as f64;
        }
        let amplitude = (2.0 * (sin * sin + cos * cos).sqrt() / middle.len() as f64) as f32;
        let power = middle.iter().map(|s| (s * s) as f64).sum::<f64>() / middle.len() as f64;
        let rest = (power - (amplitude * amplitude / 2.0) as f64).max(0.0).sqrt() as f32;
        (amplitude, rest)
    }

    #[test]
    fn decodes_every_format_to_the_same_mono_sound() {
        // ffmpeg's sine source is an eighth of full scale: 0.125. The Ogg file is in stereo,
        // as ffmpeg's Vorbis encoder insists, each channel 3 dB down; mixed to one, so is the tone.
        for (name, rate, exact, level) in [
            ("tone-16.wav", 44_100, true, 0.125),
            ("tone-24.wav", 44_100, true, 0.125),
            ("tone-8.wav", 44_100, true, 0.125),
            ("tone-32.wav", 44_100, true, 0.125),
            ("tone-float.wav", 44_100, true, 0.125),
            ("tone-48k.wav", 48_000, true, 0.125),
            ("tone.aiff", 44_100, true, 0.125),
            ("tone.flac", 44_100, true, 0.125),
            // The MP3 encoder turned it down by 0.45 dB: ffmpeg's own decoder measures the same.
            ("tone.mp3", 44_100, false, 0.1188),
            ("tone.ogg", 44_100, false, 0.125 * std::f32::consts::FRAC_1_SQRT_2),
        ] {
            let decoded = decode(&sound(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(decoded.rate, rate, "{name}: its own rate");
            let quarter_second = rate as usize / 4;
            if exact {
                assert_eq!(decoded.samples.len(), quarter_second, "{name}: a quarter of a second");
            } else {
                // A lossy format pads its ends.
                assert!(decoded.samples.len().abs_diff(quarter_second) < 3000, "{name}: about a quarter of a second, got {}", decoded.samples.len());
            }
            let (tone, rest) = tone_and_rest(&decoded);
            assert!((tone - level).abs() < 0.004, "{name}: the tone at {level}, got {tone}");
            // 8 bits are coarse, and the lossy formats lose something.
            // (The measure itself is good to about 0.002: the stretch is not a whole number of cycles.)
            let allowed = if name == "tone-8.wav" || !exact { 0.01 } else { 0.003 };
            assert!(rest < allowed, "{name}: nothing but the tone, got {rest}");
        }
    }

    #[test]
    fn mixes_channels_to_one() {
        // Left and right in step: the same sound (ffmpeg put the tone in each channel 3 dB
        // down). Left and right opposed: silence.
        let (tone, _) = tone_and_rest(&decode(&sound("tone-stereo.wav")).unwrap());
        assert!((tone - 0.125 * std::f32::consts::FRAC_1_SQRT_2).abs() < 0.001, "two channels in step give the tone, got {tone}");
        let opposed = decode(&sound("tone-stereo-opposed.wav")).unwrap();
        assert!(opposed.samples.iter().all(|s| s.abs() < 1e-4), "two channels opposed cancel");
    }

    #[test]
    fn writes_a_wav_that_it_reads_back_the_same() {
        let original = Sound { rate: 22_050, samples: (0..1000).map(|i| ((i as f32) / 500.0 - 1.0) * 0.9).collect() };
        let bytes = wav_bytes(&original);
        assert_eq!(bytes.len(), 44 + 2000, "a 44 byte header and two bytes a sample");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1, "one channel");
        assert_eq!(u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]), 22_050);
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16, "16 bits");
        let path = std::env::temp_dir().join(format!("gridelle-samples-test-{}.wav", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let back = decode(path.to_str().unwrap()).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(back.rate, 22_050);
        assert_eq!(back.samples.len(), 1000);
        for (a, b) in original.samples.iter().zip(&back.samples) {
            assert!((a - b).abs() < 2.0 / 32768.0, "within two 16-bit steps: {a} against {b}");
        }
        // Louder than full scale is clipped, not wrapped round.
        let loud = wav_bytes(&Sound { rate: 44_100, samples: vec![2.0, -2.0] });
        assert_eq!(&loud[44..], [0xff, 0x7f, 0x01, 0x80]);
    }

    #[test]
    fn says_what_is_wrong_with_a_file_it_cannot_read() {
        let missing = decode("/nowhere/kick.wav").unwrap_err();
        assert!(missing.starts_with("kick.wav is not where the patch expects it"), "{missing}");
        let text = decode(&sound("not-a-sound.wav")).unwrap_err();
        assert!(text.starts_with("not-a-sound.wav could not be read as a sound file"), "{text}");
    }

    #[test]
    fn describes_a_sound_for_the_editor_and_keeps_the_conversion() {
        let path = sound("tone-16.wav");
        let described = info(&path).unwrap();
        assert_eq!((described.name.as_str(), described.frames, described.sample_rate), ("tone-16.wav", 11_025, 44_100));
        assert_eq!(described.peaks.len(), PICTURE_COLUMNS * 2);
        assert!(described.peaks.iter().all(|v| v.abs() <= 0.126), "the picture is within the tone's level");
        assert!(described.peaks.iter().any(|v| *v > 0.12) && described.peaks.iter().any(|v| *v < -0.12), "and reaches it");
        // A second asking gives the same conversion, not a new one.
        assert!(Arc::ptr_eq(&converted(&path).unwrap(), &converted(&path).unwrap()));
        // A very short sound has a column for each sample.
        assert_eq!(peaks(&[0.5, -0.5, 0.25], 256), [0.5, 0.5, -0.5, -0.5, 0.25, 0.25]);
    }

    #[test]
    fn writes_a_patchs_sounds_under_the_names_the_patch_uses() {
        let dir = std::env::temp_dir().join(format!("gridelle-samples-write-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let samples = [SampleFile { file: "ge-sample-c.wav".into(), path: sound("tone.flac") }];
        write_all(&dir, &samples).unwrap();
        let written = decode(dir.join("ge-sample-c.wav").to_str().unwrap()).unwrap();
        assert_eq!((written.rate, written.samples.len()), (44_100, 11_025));
        // A name that could leave the folder, or is not a sample's, is refused.
        for bad in ["../ge-sample-a.wav", "main.pd", "ge-sample-a.wav/x"] {
            assert!(write_all(&dir, &[SampleFile { file: bad.into(), path: sound("tone.flac") }]).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
