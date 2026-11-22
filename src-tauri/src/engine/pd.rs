//! Minimal safe wrapper around the vendored libpd (single instance, single precision).
//!
//! libpd keeps global state, so there is exactly one [`Pd`], reached through
//! [`Pd::lock`] / [`Pd::try_lock`]. Every libpd call happens with that lock held.

use std::ffi::{c_char, c_float, c_int, c_void, CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, MutexGuard, OnceLock, TryLockError};

#[repr(C)]
struct TAtom {
    _opaque: [u8; 0],
}

type PrintHook = extern "C" fn(*const c_char);
type BangHook = extern "C" fn(*const c_char);
type FloatHook = extern "C" fn(*const c_char, c_float);
type SymbolHook = extern "C" fn(*const c_char, *const c_char);
type ListHook = extern "C" fn(*const c_char, c_int, *mut TAtom);
type MessageHook = extern "C" fn(*const c_char, *const c_char, c_int, *mut TAtom);

unsafe extern "C" {
    fn libpd_init() -> c_int;
    fn libpd_add_to_search_path(path: *const c_char);
    /// Setup of the `bob~` external from Pd's `extra`, compiled in by `build.rs`.
    fn bob_tilde_setup();
    fn libpd_init_audio(in_ch: c_int, out_ch: c_int, sample_rate: c_int) -> c_int;
    fn libpd_blocksize() -> c_int;
    fn libpd_openfile(name: *const c_char, dir: *const c_char) -> *mut c_void;
    fn libpd_closefile(patch: *mut c_void);
    fn libpd_process_float(ticks: c_int, input: *const c_float, output: *mut c_float) -> c_int;

    fn libpd_bang(recv: *const c_char) -> c_int;
    fn libpd_float(recv: *const c_char, x: c_float) -> c_int;
    fn libpd_start_message(maxlen: c_int) -> c_int;
    fn libpd_add_float(x: c_float);
    fn libpd_add_symbol(symbol: *const c_char);
    fn libpd_finish_list(recv: *const c_char) -> c_int;
    fn libpd_finish_message(recv: *const c_char, msg: *const c_char) -> c_int;

    fn libpd_bind(recv: *const c_char) -> *mut c_void;
    fn libpd_unbind(binding: *mut c_void);

    fn libpd_set_banghook(hook: BangHook);
    fn libpd_set_floathook(hook: FloatHook);
    fn libpd_set_symbolhook(hook: SymbolHook);
    fn libpd_set_listhook(hook: ListHook);
    fn libpd_set_messagehook(hook: MessageHook);
    fn libpd_set_printhook(hook: unsafe extern "C" fn(*const c_char));
    fn libpd_set_concatenated_printhook(hook: PrintHook);
    fn libpd_print_concatenator(s: *const c_char);

    fn libpd_is_float(a: *mut TAtom) -> c_int;
    fn libpd_is_symbol(a: *mut TAtom) -> c_int;
    fn libpd_get_float(a: *mut TAtom) -> c_float;
    fn libpd_get_symbol(a: *mut TAtom) -> *const c_char;
    fn libpd_next_atom(a: *mut TAtom) -> *mut TAtom;
}

/// A Pd atom: a number or a symbol.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum Atom {
    Float(f32),
    Symbol(String),
}

impl Atom {
    /// Text as Pd would print it (`%g`-style for numbers).
    pub fn to_text(&self) -> String {
        match self {
            Atom::Float(f) if f.fract() == 0.0 && f.abs() < 1e9 => format!("{}", *f as i64),
            Atom::Float(f) => format!("{f}"),
            Atom::Symbol(s) => s.clone(),
        }
    }
}

/// Something the patch sent out to a name we are bound to, or printed.
#[derive(Debug, Clone, PartialEq)]
pub enum PdEvent {
    Print(String),
    /// A message arriving at a bound receiver name, flattened to atoms.
    /// A bang is an empty list; a `[Cutoff 440 Hz(` message keeps its selector as the first atom.
    Message { recv: String, atoms: Vec<Atom> },
}

static EVENTS: OnceLock<Sender<PdEvent>> = OnceLock::new();

fn emit(event: PdEvent) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(event);
    }
}

unsafe fn text(ptr: *const c_char) -> String {
    if ptr.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned()
    }
}

unsafe fn atoms(argc: c_int, mut argv: *mut TAtom) -> Vec<Atom> {
    let mut out = Vec::with_capacity(argc.max(0) as usize);
    for _ in 0..argc {
        unsafe {
            if libpd_is_float(argv) != 0 {
                out.push(Atom::Float(libpd_get_float(argv)));
            } else if libpd_is_symbol(argv) != 0 {
                out.push(Atom::Symbol(text(libpd_get_symbol(argv))));
            }
            argv = libpd_next_atom(argv);
        }
    }
    out
}

extern "C" fn on_print(s: *const c_char) {
    let line = unsafe { text(s) };
    let line = line.trim_end();
    if !line.is_empty() {
        emit(PdEvent::Print(line.to_string()));
    }
}

extern "C" fn on_bang(recv: *const c_char) {
    emit(PdEvent::Message { recv: unsafe { text(recv) }, atoms: vec![] });
}

extern "C" fn on_float(recv: *const c_char, x: c_float) {
    emit(PdEvent::Message { recv: unsafe { text(recv) }, atoms: vec![Atom::Float(x)] });
}

extern "C" fn on_symbol(recv: *const c_char, sym: *const c_char) {
    emit(PdEvent::Message {
        recv: unsafe { text(recv) },
        atoms: vec![Atom::Symbol(unsafe { text(sym) })],
    });
}

extern "C" fn on_list(recv: *const c_char, argc: c_int, argv: *mut TAtom) {
    emit(PdEvent::Message { recv: unsafe { text(recv) }, atoms: unsafe { atoms(argc, argv) } });
}

extern "C" fn on_message(recv: *const c_char, msg: *const c_char, argc: c_int, argv: *mut TAtom) {
    let mut all = vec![Atom::Symbol(unsafe { text(msg) })];
    all.extend(unsafe { atoms(argc, argv) });
    emit(PdEvent::Message { recv: unsafe { text(recv) }, atoms: all });
}

/// An open patch file. Closing is explicit via [`Pd::close`].
#[derive(Debug)]
pub struct Patch(*mut c_void);
// The handle is only ever used with the global Pd lock held.
unsafe impl Send for Patch {}

/// A subscription to a send name. Dropping it leaks the binding; use [`Pd::unbind`].
#[derive(Debug)]
pub struct Binding(*mut c_void);
unsafe impl Send for Binding {}

pub struct Pd {
    channels: usize,
    _private: (),
}

static PD: OnceLock<Mutex<Pd>> = OnceLock::new();

/// The Pd version on the Organelle (OS 3.x and 4.x), as `pd compatibility` takes it.
const DEVICE_PD_VERSION: c_float = 0.49;

/// The abstractions from Pd's `extra` folder that modules wrap. On the Organelle they are
/// part of Pd's installation; here they are written to a folder on Pd's search path. An
/// exported patch does not contain them.
const EXTRA_ABSTRACTIONS: &[(&str, &str)] = &[
    ("rev1~.pd", include_str!("../../vendor/libpd/pure-data/extra/rev1~.pd")),
    ("rev1-stage.pd", include_str!("../../vendor/libpd/pure-data/extra/rev1-stage.pd")),
    ("rev1-final.pd", include_str!("../../vendor/libpd/pure-data/extra/rev1-final.pd")),
    ("rev2~.pd", include_str!("../../vendor/libpd/pure-data/extra/rev2~.pd")),
    ("rev3~.pd", include_str!("../../vendor/libpd/pure-data/extra/rev3~.pd")),
];

fn write_extra_abstractions() -> std::io::Result<PathBuf> {
    let dir = std::env::temp_dir().join("gridelle-pd-extra");
    std::fs::create_dir_all(&dir)?;
    for (name, text) in EXTRA_ABSTRACTIONS {
        std::fs::write(dir.join(name), text)?;
    }
    Ok(dir)
}

fn cstr(s: &str) -> CString {
    CString::new(s.replace('\0', "")).expect("nul bytes removed")
}

impl Pd {
    /// Initialise libpd on first use and return the receiving end of its event stream.
    /// Returns `None` for the receiver on later calls (there is one stream).
    pub fn init() -> Option<Receiver<PdEvent>> {
        let mut receiver = None;
        PD.get_or_init(|| {
            let (tx, rx) = channel();
            let _ = EVENTS.set(tx);
            receiver = Some(rx);
            unsafe {
                libpd_set_concatenated_printhook(on_print);
                libpd_set_printhook(libpd_print_concatenator);
                libpd_set_banghook(on_bang);
                libpd_set_floathook(on_float);
                libpd_set_symbolhook(on_symbol);
                libpd_set_listhook(on_list);
                libpd_set_messagehook(on_message);
                libpd_init();
                bob_tilde_setup();
                match write_extra_abstractions() {
                    Ok(dir) => libpd_add_to_search_path(cstr(&dir.to_string_lossy()).as_ptr()),
                    Err(e) => eprintln!("could not write Pd's extra abstractions: {e}"),
                }
                // Behave as the Organelle's Pd where Pd offers the choice. Of the things that
                // make sound, that is `bob~`, whose output changed in 0.52.
                libpd_start_message(1);
                libpd_add_float(DEVICE_PD_VERSION);
                libpd_finish_message(cstr("pd").as_ptr(), cstr("compatibility").as_ptr());
            }
            Mutex::new(Pd { channels: 2, _private: () })
        });
        receiver
    }

    /// Block until the engine is free. Never call this from the audio callback.
    pub fn lock() -> MutexGuard<'static, Pd> {
        Self::init();
        PD.get().unwrap().lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Non-blocking variant for the audio callback.
    pub fn try_lock() -> Option<MutexGuard<'static, Pd>> {
        match PD.get()?.try_lock() {
            Ok(guard) => Some(guard),
            Err(TryLockError::Poisoned(e)) => Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => None,
        }
    }

    pub fn block_size() -> usize {
        unsafe { libpd_blocksize() as usize }
    }

    /// Configure stereo output, no input.
    pub fn init_audio(&mut self, sample_rate: u32) -> Result<(), String> {
        self.channels = 2;
        match unsafe { libpd_init_audio(0, 2, sample_rate as c_int) } {
            0 => Ok(()),
            code => Err(format!("libpd_init_audio failed ({code})")),
        }
    }

    pub fn open(&mut self, file: &Path) -> Result<Patch, String> {
        let name = file.file_name().and_then(|n| n.to_str()).ok_or("patch path has no file name")?;
        let dir = file.parent().and_then(|d| d.to_str()).ok_or("patch path has no directory")?;
        let handle = unsafe { libpd_openfile(cstr(name).as_ptr(), cstr(dir).as_ptr()) };
        if handle.is_null() {
            Err(format!("could not open {}", file.display()))
        } else {
            Ok(Patch(handle))
        }
    }

    pub fn close(&mut self, patch: Patch) {
        unsafe { libpd_closefile(patch.0) }
    }

    pub fn dsp(&mut self, on: bool) {
        self.send_message("pd", "dsp", &[Atom::Float(if on { 1.0 } else { 0.0 })]);
    }

    pub fn bind(&mut self, name: &str) -> Binding {
        Binding(unsafe { libpd_bind(cstr(name).as_ptr()) })
    }

    pub fn unbind(&mut self, binding: Binding) {
        unsafe { libpd_unbind(binding.0) }
    }

    pub fn send_bang(&mut self, recv: &str) {
        unsafe { libpd_bang(cstr(recv).as_ptr()) };
    }

    pub fn send_float(&mut self, recv: &str, value: f32) {
        unsafe { libpd_float(cstr(recv).as_ptr(), value) };
    }

    fn add_atoms(atoms: &[Atom]) -> bool {
        if unsafe { libpd_start_message(atoms.len() as c_int) } != 0 {
            return false;
        }
        for atom in atoms {
            match atom {
                Atom::Float(f) => unsafe { libpd_add_float(*f) },
                Atom::Symbol(s) => unsafe { libpd_add_symbol(cstr(s).as_ptr()) },
            }
        }
        true
    }

    pub fn send_list(&mut self, recv: &str, atoms: &[Atom]) {
        if Self::add_atoms(atoms) {
            unsafe { libpd_finish_list(cstr(recv).as_ptr()) };
        }
    }

    pub fn send_message(&mut self, recv: &str, selector: &str, atoms: &[Atom]) {
        if Self::add_atoms(atoms) {
            unsafe { libpd_finish_message(cstr(recv).as_ptr(), cstr(selector).as_ptr()) };
        }
    }

    /// Send atoms the way a Pd message box would: one float is a float,
    /// a leading symbol is a selector, anything else is a list.
    pub fn send(&mut self, recv: &str, atoms: &[Atom]) {
        match atoms {
            [] => self.send_bang(recv),
            [Atom::Float(f)] => self.send_float(recv, *f),
            [Atom::Symbol(sel), rest @ ..] => self.send_message(recv, sel, rest),
            _ => self.send_list(recv, atoms),
        }
    }

    /// Render `out.len() / 2 / block_size` blocks of interleaved stereo into `out`.
    pub fn process(&mut self, out: &mut [f32]) {
        let ticks = out.len() / self.channels / Self::block_size();
        debug_assert_eq!(ticks * self.channels * Self::block_size(), out.len());
        unsafe { libpd_process_float(ticks as c_int, std::ptr::null(), out.as_mut_ptr()) };
    }
}
