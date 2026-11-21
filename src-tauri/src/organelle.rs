//! Sends a compiled patch to an Organelle on the local network and starts it there.
//!
//! The Organelle runs a web file manager while it is on Wi-Fi. Two generations exist:
//!
//! - OS 3.x–4.x ("classic"): CherryPy on port 80, everything under `/files`. It cannot
//!   start a patch; the device's main app takes OSC `/loadPatch <name>` on UDP 4001.
//! - OS 5: Flask on port 8080, the same operations without the `/files` prefix, JSON
//!   answers encoded twice, and `POST /reload_patch` to start a patch.
//!
//! Both share two quirks this module is built around: an upload never overwrites (a taken
//! name becomes `main 2.pd`), and every operation answers "ok" even when it failed. So
//! files are deleted before they are uploaded, and everything is read back afterwards.

use std::collections::HashMap;
use std::net::UdpSocket;
use std::thread::sleep;
use std::time::Duration;

use reqwest::blocking::{multipart, Client, Response};
use serde::Serialize;
use serde_json::Value;

/// Returned as the error when the folder is on the device, was not made by Gridelle,
/// and `replace` was not set. Same convention as `export_patch`.
pub const EXISTS: &str = "exists";

/// Part of every patch Gridelle writes; its presence marks a folder as one of ours.
const MARKER_FILE: &str = "ge-voice.pd";
/// The file that makes a folder a patch. Sent last, so a half-sent folder is not offered as one.
const ENTRY_FILE: &str = "main.pd";

const CLASSIC_PORT: u16 = 80;
const OS5_PORT: u16 = 8080;
/// The device's main app listens here for OSC.
const OSC_PORT: u16 = 4001;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(4);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const START_POLLS: u32 = 12;
const START_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Where to reach the device.
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub host: String,
    /// Web server port; `None` tries the usual port of each OS generation.
    pub port: Option<u16>,
    pub osc_port: u16,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendReport {
    /// The patch folder on the device, e.g. `/sdcard/Patches/Basic_Synth`.
    pub path: String,
    /// Whether the device confirmed it is now running the patch.
    pub started: bool,
}

/// Read what a user types or pastes as the address: `192.168.1.20`, `my-organelle.local`,
/// `host:8080`, or a whole URL copied from a browser.
pub fn parse_address(address: &str) -> Result<Target, String> {
    let trimmed = address.trim();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or(trimmed);
    let authority = without_scheme.split('/').next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => {
            let port = port.parse::<u16>().map_err(|_| format!("“{port}” is not a port number."))?;
            (host, Some(port))
        }
        None => (authority, None),
    };
    if host.is_empty() {
        return Err("Enter the Organelle's address first.".into());
    }
    if !host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')) {
        return Err(format!("“{host}” is not an address. Use an IP address such as 192.168.1.20, or a host name."));
    }
    Ok(Target { host: host.to_string(), port, osc_port: OSC_PORT })
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Layout {
    Classic,
    Os5,
}

struct Entry {
    name: String,
    is_folder: bool,
}

fn has(entries: &[Entry], name: &str, is_folder: bool) -> bool {
    entries.iter().any(|e| e.name == name && e.is_folder == is_folder)
}

struct Device {
    client: Client,
    /// `http://host:port` plus the layout's path prefix.
    base: String,
    layout: Layout,
}

impl Device {
    fn new(client: &Client, host: &str, port: u16, layout: Layout) -> Device {
        let prefix = if layout == Layout::Classic { "/files" } else { "" };
        Device { client: client.clone(), base: format!("http://{host}:{port}{prefix}"), layout }
    }

    /// Find the file manager, whichever generation it is.
    fn find(target: &Target) -> Result<Device, String> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let candidates = match target.port {
            Some(port) => vec![(port, Layout::Classic), (port, Layout::Os5)],
            None => vec![(CLASSIC_PORT, Layout::Classic), (OS5_PORT, Layout::Os5), (CLASSIC_PORT, Layout::Os5)],
        };
        let mut answered = false;
        for (port, layout) in candidates {
            let device = Device::new(&client, &target.host, port, layout);
            match device.try_list("/sdcard/") {
                Ok(Some(_)) => return Ok(device),
                Ok(None) => answered = true,
                // Nothing at this address at all: the other ports would only time out too.
                Err(e) if e.is_timeout() => break,
                Err(_) => {}
            }
        }
        Err(if answered {
            format!("{} answered, but not as an Organelle's Patch Manager.", target.host)
        } else {
            format!(
                "No Organelle found at {}. Check that it is on the same Wi-Fi network and that its web server is running.",
                target.host
            )
        })
    }

    fn fmdata(&self, query: &[(&str, &str)]) -> Result<Response, reqwest::Error> {
        self.client.get(format!("{}/fmdata", self.base)).query(query).send()
    }

    /// The contents of a folder. `Ok(None)` when the server has no such folder
    /// (or is not a file manager at all).
    fn try_list(&self, path: &str) -> Result<Option<Vec<Entry>>, reqwest::Error> {
        let response = self.fmdata(&[("operation", "get_node"), ("path", path)])?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let text = response.text()?;
        let Ok(mut value) = serde_json::from_str::<Value>(&text) else { return Ok(None) };
        // OS 5 wraps the JSON list in a JSON string.
        if let Value::String(inner) = &value {
            let Ok(unwrapped) = serde_json::from_str::<Value>(inner) else { return Ok(None) };
            value = unwrapped;
        }
        let Value::Array(items) = value else { return Ok(None) };
        let entries = items
            .iter()
            .filter_map(|item| {
                Some(Entry {
                    name: item.get("name")?.as_str()?.to_string(),
                    is_folder: item.get("type")?.as_str()? == "folder",
                })
            })
            .collect();
        Ok(Some(entries))
    }

    fn list(&self, path: &str) -> Result<Option<Vec<Entry>>, String> {
        self.try_list(path).map_err(lost)
    }

    fn operation(&self, query: &[(&str, &str)]) -> Result<(), String> {
        self.fmdata(query).map_err(lost)?;
        Ok(())
    }

    fn create_folder(&self, parent: &str, name: &str) -> Result<(), String> {
        self.operation(&[("operation", "create_node"), ("path", parent), ("name", name)])
    }

    fn delete(&self, path: &str) -> Result<(), String> {
        self.operation(&[("operation", "delete_node"), ("path", path)])
    }

    fn upload(&self, folder: &str, name: &str, contents: &str) -> Result<(), String> {
        let file = multipart::Part::bytes(contents.as_bytes().to_vec())
            .file_name(name.to_string())
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = multipart::Form::new().text("dst", folder.to_string()).part("files[]", file);
        let response = self.client.post(format!("{}/upload", self.base)).multipart(form).send().map_err(lost)?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("The Organelle refused {name} ({}).", response.status()))
        }
    }

    fn download(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        let response = self
            .client
            .get(format!("{}/download", self.base))
            .query(&[("fpath", path), ("cb", "gridelle")])
            .send()
            .map_err(lost)?;
        if !response.status().is_success() {
            return Ok(None);
        }
        Ok(Some(response.bytes().map_err(lost)?.to_vec()))
    }

    /// Make the device rebuild its patch menu. OS 5 does this itself after each upload.
    fn refresh_menu(&self) -> Result<(), String> {
        if self.layout == Layout::Classic {
            self.client.get(format!("{}/resync", self.base)).send().map_err(lost)?;
        }
        Ok(())
    }

    /// Ask the device to run the patch in `patches/folder`; true when it confirms.
    fn start(&self, target: &Target, patches: &str, folder: &str) -> Result<bool, String> {
        match self.layout {
            Layout::Os5 => {
                let path = format!("{patches}/{folder}");
                let response = self
                    .client
                    .post(format!("{}/reload_patch", self.base))
                    .form(&[("path", path.as_str())])
                    .send()
                    .map_err(lost)?;
                Ok(response.status().is_success())
            }
            Layout::Classic => {
                // There is no reply to an OSC message, so a failure to send is not an error
                // either: the patch is on the device and can be started from its menu.
                let sent = UdpSocket::bind("0.0.0.0:0")
                    .and_then(|socket| {
                        socket.send_to(&osc_message("/loadPatch", folder), (target.host.as_str(), target.osc_port))
                    })
                    .is_ok();
                if !sent {
                    return Ok(false);
                }
                // The main app records the running patch as a folder name in /tmp/curpatchname.
                // (If this patch was already running, this cannot tell a restart from no reaction.)
                for _ in 0..START_POLLS {
                    sleep(START_POLL_INTERVAL);
                    if let Some(current) = self.list("/tmp/curpatchname")? {
                        if has(&current, folder, true) {
                            return Ok(true);
                        }
                    }
                }
                Ok(false)
            }
        }
    }
}

fn lost(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "The Organelle stopped answering. Check its Wi-Fi connection and try again.".into()
    } else {
        format!("Lost the connection to the Organelle ({}).", error.without_url())
    }
}

/// An OSC string: the bytes, a terminating zero, padded with zeros to a multiple of four.
fn osc_string(text: &str) -> Vec<u8> {
    let mut bytes = text.as_bytes().to_vec();
    bytes.push(0);
    while bytes.len() % 4 != 0 {
        bytes.push(0);
    }
    bytes
}

/// An OSC message with one string argument.
pub fn osc_message(address: &str, argument: &str) -> Vec<u8> {
    [osc_string(address), osc_string(",s"), osc_string(argument)].concat()
}

/// Put the patch `files` (name → text) in a folder named `folder` on the device at
/// `address`, then start it. Fails with [`EXISTS`] when a folder of that name is there
/// and is not a Gridelle patch, unless `replace` is set; replacing swaps same-named
/// files and leaves anything else in the folder alone.
pub fn send_patch(
    address: &str,
    folder: &str,
    files: &HashMap<String, String>,
    replace: bool,
) -> Result<SendReport, String> {
    send_patch_to(&parse_address(address)?, folder, files, replace)
}

pub fn send_patch_to(
    target: &Target,
    folder: &str,
    files: &HashMap<String, String>,
    replace: bool,
) -> Result<SendReport, String> {
    // The blocking HTTP client panics when it is created or dropped on an async runtime's
    // worker thread, and that is where Tauri runs commands. A thread of its own is always
    // safe, and a panic in it comes back as an error instead of a command that never answers.
    std::thread::scope(|scope| {
        scope
            .spawn(|| send_on_this_thread(target, folder, files, replace))
            .join()
            .unwrap_or_else(|_| Err("Sending to the Organelle stopped unexpectedly.".into()))
    })
}

fn send_on_this_thread(
    target: &Target,
    folder: &str,
    files: &HashMap<String, String>,
    replace: bool,
) -> Result<SendReport, String> {
    let device = Device::find(target)?;

    // The device plays from a USB drive when one with a Patches folder is plugged in.
    let on_usb = device.list("/usbdrive/")?.is_some_and(|entries| has(&entries, "Patches", true));
    let patches = if on_usb { "/usbdrive/Patches" } else { "/sdcard/Patches" };
    let siblings = device
        .list(patches)?
        .ok_or_else(|| format!("The Organelle has no {patches} folder to put the patch in."))?;
    let dir = format!("{patches}/{folder}");

    let existing = if has(&siblings, folder, true) {
        let contents = device.list(&dir)?.unwrap_or_default();
        if !replace && !has(&contents, MARKER_FILE, false) {
            return Err(EXISTS.into());
        }
        contents
    } else {
        device.create_folder(patches, folder)?;
        let created = device.list(patches)?.is_some_and(|entries| has(&entries, folder, true));
        if !created {
            return Err(format!("The Organelle could not create the folder {dir}."));
        }
        Vec::new()
    };

    let mut names: Vec<&String> = files.keys().collect();
    names.sort_by_key(|name| (name.as_str() == ENTRY_FILE, name.as_str()));
    for name in &names {
        if has(&existing, name, false) {
            device.delete(&format!("{dir}/{name}"))?;
        }
        device.upload(&dir, name, &files[*name])?;
    }

    // Nothing above reports a failure, so read every file back.
    for name in &names {
        let stored = device.download(&format!("{dir}/{name}"))?;
        if stored.as_deref() != Some(files[*name].as_bytes()) {
            return Err(format!("The Organelle did not store {name} correctly. Try sending again."));
        }
    }

    device.refresh_menu()?;
    let started = device.start(target, patches, folder)?;
    Ok(SendReport { path: dir, started })
}
