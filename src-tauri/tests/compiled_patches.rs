//! Loads every compiled fixture in `tests/golden` (written by the TypeScript compiler
//! tests) into real Pd and checks it behaves like an instrument: silent at rest,
//! audible on a note, silent again after release, and free of Pd errors.

use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::Receiver;

use gridelle_lib::engine::pd::{Atom, Pd, PdEvent};

const SAMPLE_RATE: u32 = 44_100;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn peak(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0, |m, s| m.max(s.abs()))
}

/// Render `seconds` of audio and return it (interleaved stereo).
fn render(pd: &mut Pd, seconds: f32) -> Vec<f32> {
    let block = Pd::block_size() * 2;
    let blocks = (seconds * SAMPLE_RATE as f32 / Pd::block_size() as f32).ceil() as usize;
    let mut out = vec![0.0f32; block * blocks];
    pd.process(&mut out);
    out
}

#[test]
fn golden_patches_play_in_pd() {
    let events = Pd::init().expect("first init returns the event stream");
    let mut names: Vec<String> = fs::read_dir(repo().join("tests/golden"))
        .expect("tests/golden exists; run `npx vitest run` to generate it")
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("main.pd").exists())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert!(!names.is_empty(), "no compiled fixtures found");

    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE).unwrap();
    pd.dsp(true);
    let bindings: Vec<_> = ["screenLine1", "screenLine2", "screenLine3", "screenLine4", "screenLine5", "led"]
        .iter()
        .map(|name| pd.bind(name))
        .collect();
    // Drop Pd's startup banner so that anything printed later is the patch's doing.
    events.try_iter().for_each(drop);

    for name in &names {
        let host = pd.open(&repo().join("pd-lib/host.pd")).unwrap();
        let main = pd.open(&repo().join("tests/golden").join(name).join("main.pd")).unwrap();

        let rest = render(&mut pd, 0.2);
        assert!(peak(&rest) < 1e-4, "{name}: silent before any note, peak {}", peak(&rest));

        // A chord, to exercise voice allocation.
        for pitch in [48.0, 55.0, 64.0] {
            pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(100.0)]);
        }
        let playing = render(&mut pd, 0.5);
        let level = peak(&playing);
        assert!(level > 0.02, "{name}: notes should be audible, peak {level}");
        assert!(level <= 1.0, "{name}: output stays within the host's clip range");
        let (left, right): (Vec<f32>, Vec<f32>) =
            playing.chunks(2).map(|frame| (frame[0], frame[1])).unzip();
        assert!(peak(&left) > 0.02 && peak(&right) > 0.02, "{name}: both channels carry sound");

        for pitch in [48.0, 55.0, 64.0] {
            pd.send_list("notes", &[Atom::Float(pitch), Atom::Float(0.0)]);
        }
        let released = render(&mut pd, 2.0);
        let tail = &released[released.len() - 4096..];
        // A looper is the one patch that is meant to go on: it has its own check below.
        if name != "looper" {
            assert!(peak(tail) < 1e-3, "{name}: releases to silence, tail peak {}", peak(tail));
        }
        if name == "audio-input" {
            // The audio input runs once and is heard with no key held. Its left side goes
            // through a wide-open low-pass at full level, its right side in at half; Audio Out
            // is at its default level of 0.25.
            let heard = |pd: &mut Pd, left: f32, right: f32| {
                let frames = (0.3 * SAMPLE_RATE as f32) as usize / Pd::block_size() * Pd::block_size();
                let input: Vec<f32> = (0..frames)
                    .flat_map(|n| {
                        let sine = (2.0 * std::f32::consts::PI * 440.0 * n as f32 / SAMPLE_RATE as f32).sin();
                        [sine * left, sine * right]
                    })
                    .collect();
                let mut out = vec![0.0f32; input.len()];
                pd.process_with_input(&input, &mut out);
                peak(&out[out.len() / 2..])
            };
            let (from_left, from_right, from_nothing) = (heard(&mut pd, 0.5, 0.0), heard(&mut pd, 0.0, 0.5), heard(&mut pd, 0.0, 0.0));
            assert!((from_left - 0.125).abs() < 0.01, "{name}: the left input is heard at 0.5 x 0.25, got {from_left}");
            assert!((from_right - 0.0625).abs() < 0.005, "{name}: the right input is heard at 0.5 x 0.5 x 0.25, got {from_right}");
            assert!(from_nothing < 1e-3, "{name}: silent again without input, got {from_nothing}");
            println!("{name}: input of 0.5 heard at {from_left:.3} from the left, {from_right:.3} from the right, with no key held");
        }
        if name == "sampler" {
            // Both samples were loaded when the patch started: the sound file from the
            // folder, a quarter of a second of a tone, and half a second of blank tape.
            let file = pd.read_array("ge-sample-0").expect("sample A has a table");
            assert_eq!(file.len(), 11_025, "{name}: sample A is the sound file");
            assert!((peak(&file) - 0.125).abs() < 0.001, "{name}: with its sound in it, peak {}", peak(&file));
            let tape = pd.read_array("ge-sample-1").expect("sample B has a table");
            assert_eq!((tape.len(), peak(&tape)), (22_080, 0.0), "{name}: sample B is half a second of silence, in whole blocks");

            // A note that is let go at once still plays the sound to its end: at middle C a
            // quarter of a second, and then the voice is quiet. (Interleaved: 4410 frames are 100 ms.)
            pd.send_list("notes", &[Atom::Float(60.0), Atom::Float(100.0)]);
            render(&mut pd, 0.01);
            pd.send_list("notes", &[Atom::Float(60.0), Atom::Float(0.0)]);
            let after = render(&mut pd, 0.5);
            let part = |from_ms: usize, to_ms: usize| peak(&after[2 * 44 * from_ms..2 * 44 * to_ms]);
            assert!(part(100, 200) > 0.02, "{name}: the sound plays on after the key, peak {}", part(100, 200));
            assert!(part(300, 500) < 1e-4, "{name}: and ends when the sample does, peak {}", part(300, 500));
        }
        if name == "looper" {
            // The chord was recorded while the keys were down, and the tape goes round with
            // no key held: half a second of it (22 080 samples), the same every lap.
            assert!(peak(tail) > 0.02, "{name}: the tape plays on with no key held, peak {}", peak(tail));
            let lap = 2 * 22_080;
            let again = released[released.len() - 2 * lap..].split_at(lap);
            let worst = again.0.iter().zip(again.1).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-6, "{name}: each lap of the tape is the same as the one before, worst difference {worst}");
            // What is on it is what was played: as loud as the chord was, at the tape's half share of the mix.
            let on_tape = pd.read_array("ge-sample-0").expect("the looper's tape");
            let heard = peak(again.1);
            assert!((peak(&on_tape) * 0.5 * 0.25 - heard).abs() < 0.001, "{name}: the tape at half of the mix and Audio Out's quarter: {} against {heard}", peak(&on_tape));
            println!("{name}: the tape holds the chord at {:.3} and plays it back at {heard:.3}", peak(&on_tape));
        }
        if name == "tape-echo" {
            // The amp's release is 60 ms. What is heard after that is the tape, 120 ms behind
            // and fed back at 0.4 through a filter: each echo quieter than the one before.
            // (Interleaved stereo: 88 values a millisecond.)
            let part = |from_ms: usize, to_ms: usize| peak(&released[88 * from_ms..88 * to_ms]);
            let echoes = [part(130, 250), part(250, 370), part(370, 490), part(490, 610)];
            assert!(echoes[0] > 0.01, "{name}: echoes are heard after the keys are let go: {echoes:?}");
            assert!(echoes.windows(2).all(|pair| pair[1] < pair[0] * 0.6), "{name}: each echo is quieter than the one before: {echoes:?}");
            println!("{name}: echoes after the release at {echoes:.3?}");
        }
        if name == "voice-effects" {
            // The delay and reverb inside the voices ring on after the keys are up: the voice
            // stays audible until they are quiet. (Interleaved stereo: 4410 frames are 100 ms.)
            let ringing = &released[2 * 4410..2 * 3 * 4410];
            assert!(peak(ringing) > 0.003, "{name}: echoes are heard after the keys are let go, peak {}", peak(ringing));
        }
        if name == "bare-oscillator" {
            // Nothing in this patch ends a note but the voice itself going idle, which is a
            // fade of a few milliseconds. (Interleaved stereo: 2205 frames are 50 ms.)
            let soon = &released[2 * 2205..2 * 4410];
            assert!(peak(soon) < 1e-3, "{name}: silent 50 ms after the keys are let go, peak {}", peak(soon));
        }

        if name == "basic-synth" {
            knob_pages_behave(&mut pd, &events);
        }

        pd.close(main);
        pd.close(host);

        let prints: Vec<String> = events
            .try_iter()
            .filter_map(|e| if let PdEvent::Print(s) = e { Some(s) } else { None })
            .collect();
        assert!(prints.is_empty(), "{name}: Pd console should be empty, got {prints:?}");
        println!("{name}: peak {level:.3}");
    }
    for binding in bindings {
        pd.unbind(binding);
    }
}

/// Everything the patch has sent to the screen and LED since the last call, as `name: text`.
fn host_output(pd: &mut Pd, events: &Receiver<PdEvent>) -> Vec<String> {
    render(pd, 0.02);
    let mut lines = Vec::new();
    let mut prints = Vec::new();
    for event in events.try_iter() {
        match event {
            PdEvent::Message { recv, atoms } => {
                let text: Vec<String> = atoms.iter().map(Atom::to_text).collect();
                lines.push(format!("{recv}: {}", text.join(" ")));
            }
            PdEvent::Print(p) => prints.push(p),
        }
    }
    assert!(prints.is_empty(), "Pd console should be empty, got {prints:?}");
    lines
}

/// The basic-synth fixture has two knob pages: "Filter" (cutoff, res, mod, tune) and
/// "Amp envelope" (attack, -, sustain, release). Check paging, takeover and the screen.
fn knob_pages_behave(pd: &mut Pd, events: &Receiver<PdEvent>) {
    // Entering a page re-shows it. Stepping Aux twice wraps around to page 1.
    pd.send_float("aux", 1.0);
    pd.send_float("aux", 0.0);
    let page2 = host_output(pd, events);
    assert!(page2.contains(&"screenLine5: Amp envelope 2/2".to_string()), "{page2:?}");
    assert!(page2.contains(&"led: 4".to_string()), "{page2:?}");
    assert!(page2.contains(&"screenLine2: -".to_string()), "unused knob blanks its line: {page2:?}");
    assert!(page2.contains(&"screenLine1: ADSR Attack 2 ms".to_string()), "{page2:?}");
    assert!(page2.contains(&"screenLine3: ADSR Sustain 0.8".to_string()), "{page2:?}");
    assert!(page2.contains(&"screenLine4: ADSR Release 150 ms".to_string()), "{page2:?}");

    pd.send_float("aux", 1.0);
    pd.send_float("aux", 0.0);
    let page1 = host_output(pd, events);
    assert!(page1.contains(&"screenLine5: Filter 1/2".to_string()), "{page1:?}");
    assert!(page1.contains(&"led: 3".to_string()), "{page1:?}");
    assert!(page1.contains(&"screenLine1: Low-p Cutoff 400 Hz".to_string()), "{page1:?}");
    assert!(page1.contains(&"screenLine2: Low-pass Res 0.5".to_string()), "{page1:?}");
    assert!(page1.contains(&"screenLine3: Low-pass Mod 48 st".to_string()), "{page1:?}");
    assert!(page1.contains(&"screenLine4: Saw Tune 0 st".to_string()), "{page1:?}");

    // Soft takeover: knob 2 (res, stored at 0.5) ignores a far-away position...
    pd.send_float("knob2", 0.9);
    assert_eq!(host_output(pd, events), Vec::<String>::new(), "a knob far from the value is ignored");
    pd.send_float("knob2", 0.8);
    assert_eq!(host_output(pd, events), Vec::<String>::new(), "still on the same side");
    // ...takes over once it crosses the stored value, even in one big step...
    pd.send_float("knob2", 0.3);
    assert_eq!(host_output(pd, events), vec!["screenLine2: Low-pass Res 0.3"]);
    // ...and then follows directly.
    pd.send_float("knob2", 0.92);
    assert_eq!(host_output(pd, events), vec!["screenLine2: Low-pass Res 0.92"]);

    // A knob that starts close to the value takes over at once. Tune is stored at 0.5 (0 st).
    pd.send_float("knob4", 0.51);
    assert_eq!(host_output(pd, events), vec!["screenLine4: Saw Tune 1 st"]);
    pd.send_float("knob4", 1.0);
    assert_eq!(host_output(pd, events), vec!["screenLine4: Saw Tune 36 st"]);
    pd.send_float("knob4", 0.0);
    assert_eq!(host_output(pd, events), vec!["screenLine4: Saw Tune -36 st"]);

    // The exponential cutoff range reaches both ends.
    pd.send_float("knob1", 0.44);
    host_output(pd, events);
    pd.send_float("knob1", 0.0);
    assert_eq!(host_output(pd, events), vec!["screenLine1: Low-p Cutoff 20 Hz"]);
    pd.send_float("knob1", 1.0);
    assert_eq!(host_output(pd, events), vec!["screenLine1: Low-p Cutoff 18000 Hz"]);

    // Knobs on the other page did not move: page 2 still shows its own values,
    // and coming back shows the values set above.
    pd.send_float("aux", 1.0);
    let page2 = host_output(pd, events);
    assert!(page2.contains(&"screenLine1: ADSR Attack 2 ms".to_string()), "{page2:?}");
    // Knob 1 sits at 1.0 from the other page; attack is stored near 0.15, so no jump.
    pd.send_float("knob1", 0.95);
    assert_eq!(host_output(pd, events), Vec::<String>::new(), "page switch needs a new takeover");
    pd.send_float("aux", 0.0);
    pd.send_float("aux", 1.0);
    let page1 = host_output(pd, events);
    assert!(page1.contains(&"screenLine2: Low-pass Res 0.92".to_string()), "{page1:?}");
    assert!(page1.contains(&"screenLine4: Saw Tune -36 st".to_string()), "{page1:?}");

    // The editor moves a knob's stored position through its slot receiver.
    pd.send_float("ge-slot-0-2", 0.25);
    assert_eq!(host_output(pd, events), vec!["screenLine2: Low-pass Res 0.25"]);
    pd.send_float("ge-slot-1-3", 0.1);
    assert_eq!(host_output(pd, events), Vec::<String>::new(), "a slot on another page stays quiet");
    println!("knob pages: paging, takeover, ranges and screen text behave");
}
