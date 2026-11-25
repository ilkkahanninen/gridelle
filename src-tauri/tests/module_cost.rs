//! Measures what every module costs to run, in real Pd, and writes it to
//! `src/core/modules/costs.json` as a part of what a Saw costs. The editor turns that into
//! a share of the Organelle's CPU with the figures the CPU probe gave on the device
//! (`src/core/cost.ts`). Run it after adding a module or changing one's DSP:
//!
//!   cd src-tauri && cargo test --test module_cost -- --ignored --nocapture
//!
//! What to measure comes from `tests/cost/modules.json`, which a vitest writes from the
//! registry: each module's abstraction, what feeds its inlets and its creation arguments.
//! Each module runs in sixteen copies, fed as the compiler would feed them unpatched, for a
//! few seconds of sound as fast as Pd can make it; what that takes over the same patch with
//! no copies, per copy, is its cost. The fastest of three runs counts, as the one least
//! disturbed by anything else the computer was doing.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use gridelle_lib::engine::pd::{Pd, PdEvent};
use serde::Deserialize;

const SAMPLE_RATE: u32 = 44_100;
const COPIES: usize = 16;
const SECONDS: usize = 3;
const RUNS: usize = 3;

#[derive(Deserialize)]
#[serde(untagged)]
enum Feed {
    Value(f32),
    Kind(String),
}

#[derive(Deserialize)]
struct Module {
    #[serde(rename = "type")]
    kind: String,
    pd: String,
    inlets: Vec<Feed>,
    args: String,
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Around the copies: what the modules read and listen to, as a compiled patch has it.
const SURROUNDINGS: &[&str] = &[
    "osc~ 220",
    "table ge-sample-0 88200",
    "table ge-wave-0 1050496",
    "sig~ 0",
    "s~ ge-sample-0-at",
    "s~ inL",
    "s~ inR",
    "loadbang",
    // Someone to hear the sizes in a patch whose copies do not.
    "r ge-sample-0-rate",
    "r ge-sample-0-size",
    "r ge-wave-0-size",
];

/// A patch of `copies` copies of `module`, each inlet fed as the plan says, with the loadbang
/// telling the sample modules how big their tables are.
fn bench_patch(module: &Module, copies: usize) -> String {
    let mut boxes: Vec<String> = SURROUNDINGS.iter().map(|b| b.to_string()).collect();
    let mut connections: Vec<[usize; 4]> = vec![[3, 0, 4, 0], [0, 0, 5, 0], [0, 0, 6, 0]];
    let message = boxes.len();
    boxes.push("msg ; ge-sample-0-rate 44100 ; ge-sample-0-size 88200 ; ge-wave-0-size 1050496".to_string());
    connections.push([7, 0, message, 0]);
    // One [sig~] per value the inlets rest at.
    let mut values: Vec<(f32, usize)> = Vec::new();
    for feed in &module.inlets {
        if let Feed::Value(v) = feed {
            if !values.iter().any(|(w, _)| w == v) {
                values.push((*v, boxes.len()));
                boxes.push(format!("sig~ {v}"));
            }
        }
    }
    for i in 0..copies {
        let at = boxes.len();
        boxes.push(format!("{} t{i} {}", module.pd, module.args).trim().to_string());
        for (inlet, feed) in module.inlets.iter().enumerate() {
            match feed {
                Feed::Kind(kind) if kind == "main" => connections.push([0, 0, at, inlet]),
                Feed::Value(v) => connections.push([values.iter().find(|(w, _)| w == v).unwrap().1, 0, at, inlet]),
                _ => {}
            }
        }
    }
    let mut text = String::from("#N canvas 0 0 800 600 12;\n");
    for (i, b) in boxes.iter().enumerate() {
        let kind = if b.starts_with("msg ") { "msg" } else { "obj" };
        let body = b.strip_prefix("msg ").unwrap_or(b).replace(';', "\\;");
        text += &format!("#X {kind} 30 {} {body};\n", 30 + i * 20);
    }
    for [a, o, b, i] in connections {
        text += &format!("#X connect {a} {o} {b} {i};\n");
    }
    text
}

/// Seconds of work to make `SECONDS` of sound with this patch open: the fastest of `RUNS`.
fn time_patch(pd: &mut Pd, dir: &Path, text: &str) -> f64 {
    let file = dir.join("bench.pd");
    fs::write(&file, text).unwrap();
    let patch = pd.open(&file).expect("the bench patch opens");
    let blocks_per_second = SAMPLE_RATE as usize / 64 + 1;
    let mut buffer = vec![0.0f32; 64 * 2 * blocks_per_second];
    // A first second to settle: tables filled, ramps done.
    pd.process(&mut buffer);
    let mut best = f64::MAX;
    for _ in 0..RUNS {
        let start = Instant::now();
        for _ in 0..SECONDS {
            pd.process(&mut buffer);
        }
        best = best.min(start.elapsed().as_secs_f64());
    }
    pd.close(patch);
    best
}

#[test]
#[ignore = "measures every module for a minute or so and writes src/core/modules/costs.json"]
fn measures_what_every_module_costs() {
    let events = Pd::init().expect("first init returns the event stream");
    let dir = std::env::temp_dir().join(format!("gridelle-cost-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    for entry in fs::read_dir(repo().join("pd-lib/modules")).unwrap().flatten() {
        fs::copy(entry.path(), dir.join(entry.file_name())).unwrap();
    }
    let plan: Vec<Module> =
        serde_json::from_str(&fs::read_to_string(repo().join("tests/cost/modules.json")).expect("run npm test to write tests/cost/modules.json"))
            .unwrap();
    let mut pd = Pd::lock();
    pd.init_audio(SAMPLE_RATE).unwrap();
    pd.dsp(true);

    let empty = Module { kind: String::new(), pd: String::new(), inlets: Vec::new(), args: String::new() };
    let base = time_patch(&mut pd, &dir, &bench_patch(&empty, 0));
    let mut per_copy: BTreeMap<String, f64> = BTreeMap::new();
    for module in &plan {
        // Each copy's share of the work over the patch with none.
        let mut cost = f64::MAX;
        for _ in 0..2 {
            cost = cost.min((time_patch(&mut pd, &dir, &bench_patch(module, COPIES)) - base).max(0.0) / COPIES as f64);
        }
        per_copy.insert(module.kind.clone(), cost);
    }
    drop(pd);
    let _ = fs::remove_dir_all(&dir);

    let saw = per_copy["osc-saw"];
    let mut costs = serde_json::Map::new();
    for (kind, cost) in &per_copy {
        // Two decimals of a Saw: finer than the measurement is.
        costs.insert(kind.clone(), serde_json::json!(((cost / saw) * 100.0).round() / 100.0));
    }
    let table = serde_json::json!({ "reference": "osc-saw", "costs": costs });
    fs::write(repo().join("src/core/modules/costs.json"), serde_json::to_string_pretty(&table).unwrap() + "\n").unwrap();
    for (kind, cost) in &per_copy {
        println!("{kind:24} {:6.2} saws  ({:.1} µs per second of sound)", cost / saw, cost / SECONDS as f64 * 1e6);
    }

    let printed: Vec<String> = events.try_iter().filter_map(|e| if let PdEvent::Print(text) = e { Some(text) } else { None }).collect();
    let errors: Vec<&String> = printed.iter().filter(|t| t.contains("error") || t.contains("no such") || t.contains("couldn't")).collect();
    assert!(errors.is_empty(), "Pd complained: {errors:?}");
}
