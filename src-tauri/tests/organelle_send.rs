//! Sends patches to a fake Organelle that behaves like the device's web file manager,
//! written from the Organelle_OS source (v3.2 for "classic", v5.1 for OS 5), including
//! the two traps: uploads never overwrite, and every operation claims success.
//!
//! The last test talks to a real device and is ignored by default. It creates (or
//! replaces) the patch `Gridelle_Test` on the device and starts it:
//!   ORGANELLE_ADDRESS=<address> cargo test --test organelle_send -- --ignored --nocapture
//! `ORGANELLE_PATCH=<fixture name or folder path>` sends another patch than basic-synth.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use gridelle_lib::organelle::{osc_message, parse_address, send_patch, send_patch_to, SendReport, Target, EXISTS};

#[derive(Clone, Copy, PartialEq)]
enum Generation {
    Classic,
    Os5,
    /// Some other web server: answers, but knows none of the file manager's addresses.
    NotAnOrganelle,
}

struct State {
    generation: Generation,
    /// Absolute path → `None` for a folder, the contents for a file.
    nodes: BTreeMap<String, Option<Vec<u8>>>,
    resyncs: usize,
    /// When set, deleting does nothing (and still answers "ok", as the device would).
    deleting_is_broken: bool,
    /// Whether OSC sent to the main app arrives.
    hears_osc: bool,
}

impl State {
    fn is_folder(&self, path: &str) -> bool {
        path == "/" || self.nodes.get(path) == Some(&None)
    }

    fn file(&self, path: &str) -> Option<&[u8]> {
        self.nodes.get(path)?.as_deref()
    }

    /// `check_and_inc_name` on the device: a taken name gets " 2", " 3", ... before its extension.
    fn free_name(&self, path: &str) -> String {
        let (stem, extension) = match path.rfind('.') {
            Some(dot) if dot > path.rfind('/').map_or(0, |slash| slash + 1) => path.split_at(dot),
            _ => (path, ""),
        };
        let mut candidate = path.to_string();
        let mut count = 2;
        while self.nodes.contains_key(&candidate) {
            candidate = format!("{stem} {count}{extension}");
            count += 1;
        }
        candidate
    }

    fn children(&self, folder: &str) -> Vec<(String, bool)> {
        let prefix = if folder == "/" { "/".to_string() } else { format!("{folder}/") };
        self.nodes
            .iter()
            .filter_map(|(path, contents)| {
                let name = path.strip_prefix(&prefix)?;
                (!name.is_empty() && !name.contains('/') && !name.starts_with('.'))
                    .then(|| (name.to_string(), contents.is_none()))
            })
            .collect()
    }

    fn patches_folder(&self) -> &'static str {
        if self.is_folder("/usbdrive/Patches") { "/usbdrive/Patches" } else { "/sdcard/Patches" }
    }

    /// What the main app does when it starts a patch.
    fn run_patch(&mut self, folder: &str) {
        if self.file(&format!("{folder}/main.pd")).is_none() {
            return;
        }
        self.nodes.retain(|path, _| !path.starts_with("/tmp/curpatchname/"));
        let name = folder.rsplit('/').next().unwrap();
        self.nodes.insert(format!("/tmp/curpatchname/{name}"), None);
    }

    fn current_patch(&self) -> Option<String> {
        self.children("/tmp/curpatchname").first().map(|(name, _)| name.clone())
    }
}

/// `//sdcard/Patches/` → `/sdcard/Patches`, as the device's file system sees it.
fn normalize(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    format!("/{}", parts.join("/"))
}

fn url_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap();
                out.push(u8::from_str_radix(hex, 16).unwrap());
                i += 2;
            }
            other => out.push(other),
        }
        i += 1;
    }
    String::from_utf8(out).unwrap()
}

fn form_fields(text: &str) -> HashMap<String, String> {
    text.split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (url_decode(key), url_decode(value))
        })
        .collect()
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

/// Fields of a `multipart/form-data` body: name → (file name, contents).
fn multipart_fields(body: &[u8], boundary: &str) -> HashMap<String, (Option<String>, Vec<u8>)> {
    let delimiter = format!("--{boundary}").into_bytes();
    let mut fields = HashMap::new();
    let mut at = find(body, &delimiter, 0).expect("multipart body starts with its boundary") + delimiter.len();
    while let Some(next) = find(body, &delimiter, at) {
        // Between two boundaries: CRLF, headers, blank line, contents, CRLF.
        let part = &body[at + 2..next - 2];
        let split = find(part, b"\r\n\r\n", 0).expect("part has headers");
        let headers = String::from_utf8_lossy(&part[..split]).to_string();
        let attribute = |key: &str| {
            let start = headers.find(&format!("{key}=\""))? + key.len() + 2;
            Some(headers[start..start + headers[start..].find('"')?].to_string())
        };
        fields.insert(
            attribute(" name").expect("part has a name"),
            (attribute("filename"), part[split + 4..].to_vec()),
        );
        at = next + delimiter.len();
    }
    fields
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    content_type: String,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> Option<Request> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));

    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        let (name, value) = header.split_once(':')?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    assert!(!headers.contains_key("transfer-encoding"), "the fake device only reads bodies with a length");
    let length = headers.get("content-length").and_then(|l| l.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path: url_decode(path),
        query: form_fields(query),
        content_type: headers.remove("content-type").unwrap_or_default(),
        body,
    })
}

type Reply = (u16, &'static str, Vec<u8>);

fn json(generation: Generation, value: serde_json::Value) -> Reply {
    // OS 5 passes an already-encoded JSON text through jsonify, which encodes it again.
    let text = if generation == Generation::Os5 {
        serde_json::Value::String(value.to_string()).to_string()
    } else {
        value.to_string()
    };
    (200, "application/json", text.into_bytes())
}

fn handle(state: &mut State, request: Request) -> Reply {
    let not_found: Reply = (404, "text/html", b"not found".to_vec());
    let failed: Reply = (500, "text/html", b"server error".to_vec());
    let generation = state.generation;
    let route = match generation {
        Generation::Classic => request.path.strip_prefix("/files"),
        Generation::Os5 => Some(request.path.as_str()),
        Generation::NotAnOrganelle => None,
    };
    let Some(route) = route else { return not_found };
    let ok = || json(generation, serde_json::json!({"ok": "ok"}));

    match (request.method.as_str(), route) {
        ("GET", "/fmdata") => {
            let field = |name: &str| request.query.get(name).cloned().unwrap_or_default();
            match field("operation").as_str() {
                "get_node" => {
                    let folder = normalize(&field("path"));
                    if !state.is_folder(&folder) {
                        return failed;
                    }
                    let items: Vec<serde_json::Value> = state
                        .children(&folder)
                        .into_iter()
                        .map(|(name, is_folder)| {
                            serde_json::json!({
                                "name": name,
                                "type": if is_folder { "folder" } else { "file" },
                                "children": is_folder,
                                "path": format!("{folder}/{name}"),
                            })
                        })
                        .collect();
                    json(generation, serde_json::Value::Array(items))
                }
                "create_node" => {
                    let parent = normalize(&field("path"));
                    if !state.is_folder(&parent) {
                        return failed;
                    }
                    let path = state.free_name(&format!("{parent}/{}", field("name")));
                    state.nodes.insert(path, None);
                    ok()
                }
                "delete_node" => {
                    let path = normalize(&field("path"));
                    if !state.deleting_is_broken {
                        let inside = format!("{path}/");
                        state.nodes.retain(|p, _| *p != path && !p.starts_with(&inside));
                    }
                    ok()
                }
                _ => failed,
            }
        }
        ("POST", "/upload") => {
            let boundary = request.content_type.split("boundary=").nth(1).expect("upload is multipart").to_string();
            let mut fields = multipart_fields(&request.body, &boundary);
            let (_, folder) = fields.remove("dst").expect("upload names its folder as dst");
            let (name, contents) = fields.remove("files[]").expect("upload carries the file as files[]");
            let folder = normalize(&String::from_utf8(folder).unwrap());
            if !state.is_folder(&folder) {
                return failed;
            }
            let path = state.free_name(&format!("{folder}/{}", name.expect("uploaded file has a name")));
            state.nodes.insert(path, Some(contents));
            (200, "application/json", br#"{"files":[{"name":"x"}]}"#.to_vec())
        }
        ("GET", "/download") => {
            // The classic server's handler requires both parameters.
            if generation == Generation::Classic && !request.query.contains_key("cb") {
                return not_found;
            }
            let path = normalize(request.query.get("fpath").map_or("", String::as_str));
            match state.file(&path) {
                Some(contents) => (200, "application/octet-stream", contents.to_vec()),
                None => failed,
            }
        }
        ("GET", "/resync") if generation == Generation::Classic => {
            state.resyncs += 1;
            (200, "text/html", b"done".to_vec())
        }
        ("POST", "/reload_patch") if generation == Generation::Os5 => {
            assert!(request.content_type.starts_with("application/x-www-form-urlencoded"));
            let fields = form_fields(&String::from_utf8(request.body).unwrap());
            let Some(path) = fields.get("path") else { return (400, "text/html", b"no path provided".to_vec()) };
            state.run_patch(&normalize(path));
            (200, "text/html", format!("reloading patch: {path}").into_bytes())
        }
        _ => not_found,
    }
}

struct FakeOrganelle {
    state: Arc<Mutex<State>>,
    target: Target,
}

impl FakeOrganelle {
    fn start(generation: Generation) -> FakeOrganelle {
        let folders = ["/sdcard", "/sdcard/Patches", "/usbdrive", "/tmp", "/tmp/curpatchname", "/tmp/curpatchname/Something_Else"];
        let state = Arc::new(Mutex::new(State {
            generation,
            nodes: folders.iter().map(|f| (f.to_string(), None)).collect(),
            resyncs: 0,
            deleting_is_broken: false,
            hears_osc: true,
        }));

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let http_state = state.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let Some(request) = read_request(&stream) else { continue };
                let (status, content_type, body) = handle(&mut http_state.lock().unwrap(), request);
                let head = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let mut stream = stream;
                let _ = stream.write_all(head.as_bytes()).and_then(|_| stream.write_all(&body));
            }
        });

        // The main app: starts the patch named in an OSC /loadPatch message.
        let socket = UdpSocket::bind("127.0.0.1:0").unwrap();
        let osc_port = socket.local_addr().unwrap().port();
        let osc_state = state.clone();
        thread::spawn(move || {
            let mut packet = [0u8; 1024];
            while let Ok(length) = socket.recv(&mut packet) {
                let packet = &packet[..length];
                let prefix = osc_message("/loadPatch", "");
                // An empty string argument is four zero bytes; drop them to get the common prefix.
                let prefix = &prefix[..prefix.len() - 4];
                let Some(argument) = packet.strip_prefix(prefix) else { continue };
                let name = String::from_utf8_lossy(argument.split(|b| *b == 0).next().unwrap()).to_string();
                let mut state = osc_state.lock().unwrap();
                if state.hears_osc {
                    let folder = format!("{}/{name}", state.patches_folder());
                    state.run_patch(&folder);
                }
            }
        });

        FakeOrganelle { state, target: Target { host: "127.0.0.1".into(), port: Some(port), osc_port } }
    }

    fn put(&self, path: &str, contents: Option<&str>) {
        self.state.lock().unwrap().nodes.insert(path.to_string(), contents.map(|c| c.as_bytes().to_vec()));
    }

    fn text(&self, path: &str) -> Option<String> {
        self.state.lock().unwrap().file(path).map(|bytes| String::from_utf8_lossy(bytes).to_string())
    }

    fn names(&self, folder: &str) -> Vec<String> {
        self.state.lock().unwrap().children(folder).into_iter().map(|(name, _)| name).collect()
    }

    fn send(&self, folder: &str, files: &HashMap<String, String>, replace: bool) -> Result<SendReport, String> {
        send_patch_to(&self.target, folder, files, replace)
    }
}

fn patch(main: &str) -> HashMap<String, String> {
    HashMap::from([
        ("main.pd".to_string(), main.to_string()),
        ("voice.pd".to_string(), "#N canvas 0 50 800 600 12;\n#X obj 30 30 inlet;\n".to_string()),
        ("ge-voice.pd".to_string(), "#N canvas 0 0 620 380 12;\n#X msg 180 170 0 \\, 1 0 1.5;\n".to_string()),
    ])
}

#[test]
fn sends_a_new_patch_and_starts_it() {
    let device = FakeOrganelle::start(Generation::Classic);
    let files = patch("#N canvas 0 50 800 600 12;\n#X obj 30 30 r notes;\n");

    let report = device.send("My_Patch", &files, false).unwrap();

    assert_eq!(report, SendReport { path: "/sdcard/Patches/My_Patch".into(), started: true });
    assert_eq!(device.names("/sdcard/Patches/My_Patch"), ["ge-voice.pd", "main.pd", "voice.pd"]);
    for (name, text) in &files {
        assert_eq!(device.text(&format!("/sdcard/Patches/My_Patch/{name}")).as_ref(), Some(text), "{name}");
    }
    let state = device.state.lock().unwrap();
    assert_eq!(state.resyncs, 1, "the patch menu is refreshed once");
    assert_eq!(state.current_patch().as_deref(), Some("My_Patch"));
}

/// The app calls the sender from a Tauri command, which runs on the async runtime's worker
/// threads, where a blocking HTTP client may not be used directly.
#[test]
fn can_be_called_from_the_async_runtime_as_the_tauri_command_does() {
    let device = FakeOrganelle::start(Generation::Classic);
    let target = device.target.clone();
    let files = patch("x\n");

    let report = tauri::async_runtime::block_on(tauri::async_runtime::spawn(async move {
        send_patch_to(&target, "My_Patch", &files, false)
    }));

    let report = report.expect("the sender does not panic on a runtime worker thread").unwrap();
    assert_eq!(report, SendReport { path: "/sdcard/Patches/My_Patch".into(), started: true });
}

#[test]
fn resending_replaces_the_patch_files_and_leaves_other_files_alone() {
    let device = FakeOrganelle::start(Generation::Classic);
    device.send("My_Patch", &patch("first version\n"), false).unwrap();
    device.put("/sdcard/Patches/My_Patch/notes.txt", Some("mine"));

    // A Gridelle patch is replaced without `replace`.
    device.send("My_Patch", &patch("second version\n"), false).unwrap();

    assert_eq!(device.text("/sdcard/Patches/My_Patch/main.pd").as_deref(), Some("second version\n"));
    assert_eq!(device.text("/sdcard/Patches/My_Patch/notes.txt").as_deref(), Some("mine"));
    assert_eq!(device.names("/sdcard/Patches/My_Patch"), ["ge-voice.pd", "main.pd", "notes.txt", "voice.pd"]);
}

#[test]
fn a_folder_gridelle_did_not_make_is_only_replaced_on_request() {
    let device = FakeOrganelle::start(Generation::Classic);
    device.put("/sdcard/Patches/Rhodey", None);
    device.put("/sdcard/Patches/Rhodey/main.pd", Some("someone else's patch"));

    assert_eq!(device.send("Rhodey", &patch("ours\n"), false), Err(EXISTS.to_string()));
    assert_eq!(device.text("/sdcard/Patches/Rhodey/main.pd").as_deref(), Some("someone else's patch"));
    assert_eq!(device.names("/sdcard/Patches/Rhodey"), ["main.pd"]);

    device.send("Rhodey", &patch("ours\n"), true).unwrap();
    assert_eq!(device.text("/sdcard/Patches/Rhodey/main.pd").as_deref(), Some("ours\n"));
}

#[test]
fn uses_the_usb_drive_when_it_has_a_patches_folder() {
    let device = FakeOrganelle::start(Generation::Classic);
    device.put("/usbdrive/Patches", None);

    let report = device.send("My_Patch", &patch("x\n"), false).unwrap();

    assert_eq!(report, SendReport { path: "/usbdrive/Patches/My_Patch".into(), started: true });
    assert!(device.names("/sdcard/Patches").is_empty());
}

#[test]
fn works_with_the_os_5_server() {
    let device = FakeOrganelle::start(Generation::Os5);
    device.send("My_Patch", &patch("first version\n"), false).unwrap();

    let report = device.send("My_Patch", &patch("second version\n"), false).unwrap();

    assert_eq!(report, SendReport { path: "/sdcard/Patches/My_Patch".into(), started: true });
    assert_eq!(device.text("/sdcard/Patches/My_Patch/main.pd").as_deref(), Some("second version\n"));
    assert_eq!(device.names("/sdcard/Patches/My_Patch"), ["ge-voice.pd", "main.pd", "voice.pd"]);
    assert_eq!(device.state.lock().unwrap().current_patch().as_deref(), Some("My_Patch"));
}

#[test]
fn reports_when_the_device_does_not_start_the_patch() {
    let device = FakeOrganelle::start(Generation::Classic);
    device.state.lock().unwrap().hears_osc = false;

    let report = device.send("My_Patch", &patch("x\n"), false).unwrap();

    assert_eq!(report, SendReport { path: "/sdcard/Patches/My_Patch".into(), started: false });
    assert!(device.text("/sdcard/Patches/My_Patch/main.pd").is_some(), "the patch is still on the device");
}

#[test]
fn notices_a_file_the_device_claimed_to_replace_but_did_not() {
    let device = FakeOrganelle::start(Generation::Classic);
    device.send("My_Patch", &patch("first version\n"), false).unwrap();
    device.state.lock().unwrap().deleting_is_broken = true;

    let error = device.send("My_Patch", &patch("second version\n"), false).unwrap_err();

    assert!(error.contains("main.pd"), "{error}");
}

#[test]
fn says_so_when_nothing_answers_or_it_is_not_an_organelle() {
    // A port nothing listens on: bind one, note it, close it.
    let free_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let nobody = Target { host: "127.0.0.1".into(), port: Some(free_port), osc_port: 9 };
    let error = send_patch_to(&nobody, "My_Patch", &patch("x\n"), false).unwrap_err();
    assert!(error.starts_with("No Organelle found at 127.0.0.1"), "{error}");

    let router = FakeOrganelle::start(Generation::NotAnOrganelle);
    let error = router.send("My_Patch", &patch("x\n"), false).unwrap_err();
    assert!(error.contains("not as an Organelle"), "{error}");
}

#[test]
fn reads_addresses_as_people_type_them() {
    let target = |host: &str, port| Ok(Target { host: host.into(), port, osc_port: 4001 });
    assert_eq!(parse_address("192.168.1.20"), target("192.168.1.20", None));
    assert_eq!(parse_address("  my-organelle.local "), target("my-organelle.local", None));
    assert_eq!(parse_address("http://192.168.1.20/files/"), target("192.168.1.20", None));
    assert_eq!(parse_address("192.168.1.20:8080"), target("192.168.1.20", Some(8080)));
    assert!(parse_address("").is_err());
    assert!(parse_address("   ").is_err());
    assert!(parse_address("my organelle").is_err());
    assert!(parse_address("192.168.1.20:http").is_err());
}

#[test]
fn builds_osc_messages_with_padded_strings() {
    assert_eq!(osc_message("/loadPatch", "Basic_Synth"), b"/loadPatch\0\0,s\0\0Basic_Synth\0");
    assert_eq!(osc_message("/abc", "abcd"), b"/abc\0\0\0\0,s\0\0abcd\0\0\0\0");
}

#[test]
#[ignore = "writes to a real Organelle; set ORGANELLE_ADDRESS"]
fn sends_a_patch_to_a_real_organelle() {
    let address = std::env::var("ORGANELLE_ADDRESS").expect("set ORGANELLE_ADDRESS to the device's address");
    // Which patch: a fixture's name under tests/golden (the default is basic-synth), or the path of any patch folder.
    let patch = std::env::var("ORGANELLE_PATCH").unwrap_or_else(|_| "basic-synth".to_string());
    let folder = if patch.contains('/') {
        PathBuf::from(&patch)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/golden").join(&patch)
    };
    let files: HashMap<String, String> = std::fs::read_dir(&folder)
        .unwrap_or_else(|e| panic!("{} is a patch folder (run `npm test` to generate the fixtures): {e}", folder.display()))
        .flatten()
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), std::fs::read_to_string(entry.path()).unwrap()))
        .collect();
    assert!(files.contains_key("main.pd"));

    let report = send_patch(&address, "Gridelle_Test", &files, false).expect("the patch is sent");

    println!("sent {} files of {patch} to {}; started: {}", files.len(), report.path, report.started);
    assert!(report.path.ends_with("/Patches/Gridelle_Test"));
}
