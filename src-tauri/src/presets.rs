//! The presets: `.gridelle` files in one directory, `Documents/Gridelle`.
//!
//! The editor lists them, opens one by a click and saves the current patch among them
//! under the patch's own name. The presets that come with the editor are files there too,
//! written once (`seed`) and from then on the user's own to change or delete. The functions here take the directory, so that tests can
//! give them one of their own; the Tauri commands in `lib.rs` pass the real one.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file name ending of a preset. The same as `FILE_EXTENSION` in the editor.
pub const EXTENSION: &str = "gridelle";

/// What saving answers when a preset of that name is there and it was not told to replace it.
pub const EXISTS: &str = "exists";

/// The file that remembers which of the editor's own presets have been written to the
/// directory. Hidden, so it is not listed, and kept with the presets, so that a directory
/// started afresh gets them again.
const SEEDED_FILE: &str = ".gridelle-examples";

/// One of the presets that come with the editor: the name of its file, and its contents.
#[derive(Debug, Clone, Deserialize)]
pub struct Example {
    pub name: String,
    pub contents: String,
}

/// The longest a preset's name may be, in characters.
const MAX_NAME: usize = 80;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Preset {
    /// The file's name without its ending: what the list shows.
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Presets {
    /// Where presets are kept, whether or not the directory exists yet.
    pub dir: String,
    pub presets: Vec<Preset>,
}

/// Whether `name` can be a preset's file name as it is: one path component, with nothing
/// in it that a file name cannot hold on macOS, Windows or Linux. The editor cleans a
/// patch's name to fit (`presetFileName`), so a refusal here means a caller that did not.
pub fn is_preset_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().count() <= MAX_NAME
        && name == name.trim()
        && !name.starts_with('.')
        && !name.ends_with('.')
        && !name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// The presets in `dir`, by name without regard to case. A directory that is not there
/// yet has none.
pub fn list(dir: &Path) -> Result<Presets, String> {
    let mut presets = Vec::new();
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                let is_preset = path.extension().is_some_and(|e| e == EXTENSION) && path.is_file();
                let name = path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
                // Hidden files are not the user's presets: an editor's backup, a half-written save.
                if is_preset && !name.is_empty() && !name.starts_with('.') {
                    presets.push(Preset { name, path: path.to_string_lossy().into_owned() });
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("The presets in {} could not be listed ({e}).", dir.display())),
    }
    presets.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name)));
    Ok(Presets { dir: dir.to_string_lossy().into_owned(), presets })
}

/// Save `contents` as the preset `name` in `dir`, which is made if it is not there, and
/// answer the file's path. Fails with [`EXISTS`] when there is such a preset already,
/// unless `overwrite` is set.
pub fn save(dir: &Path, name: &str, contents: &str, overwrite: bool) -> Result<String, String> {
    if !is_preset_name(name) {
        return Err(format!("{name:?} cannot be a preset's name."));
    }
    let path = dir.join(format!("{name}.{EXTENSION}"));
    if path.exists() && !overwrite {
        return Err(EXISTS.into());
    }
    fs::create_dir_all(dir).map_err(|e| format!("The folder {} could not be made ({e}).", dir.display()))?;
    // Written beside it and moved into place, so that a save that fails half way leaves
    // the preset as it was. The name is hidden, and so not listed if it is left behind.
    let partial = dir.join(format!(".{name}.{EXTENSION}.saving"));
    let written = fs::write(&partial, contents).and_then(|()| fs::rename(&partial, &path));
    if let Err(e) = written {
        let _ = fs::remove_file(&partial);
        return Err(format!("{name} could not be saved ({e})."));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Write the editor's own presets into `dir`, each of them once ever: the names written so
/// far are kept in the directory, so one the user has since deleted stays deleted, and one
/// that a later version of the editor adds is written when that version first runs. A
/// preset of the user's that has an example's name is left as it is.
pub fn seed(dir: &Path, examples: &[Example]) -> Result<(), String> {
    let record = dir.join(SEEDED_FILE);
    let mut seeded: Vec<String> = fs::read_to_string(&record).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let fresh: Vec<&Example> = examples.iter().filter(|example| !seeded.contains(&example.name)).collect();
    if fresh.is_empty() {
        return Ok(());
    }
    for example in fresh {
        match save(dir, &example.name, &example.contents, false) {
            Ok(_) => {}
            Err(e) if e == EXISTS => {}
            Err(e) => return Err(e),
        }
        seeded.push(example.name.clone());
    }
    let text = serde_json::to_string(&seeded).map_err(|e| e.to_string())?;
    fs::write(&record, text).map_err(|e| format!("The folder {} could not be written to ({e}).", dir.display()))
}

/// Delete the preset at `path`, which has to be a preset directly inside `dir`.
pub fn delete(dir: &Path, path: &str) -> Result<(), String> {
    let path = PathBuf::from(path);
    let inside = path.parent() == Some(dir);
    let named = path.file_stem().and_then(|stem| stem.to_str()).is_some_and(is_preset_name);
    if !inside || !named || path.extension().is_none_or(|e| e != EXTENSION) {
        return Err("That is not one of the saved presets.".into());
    }
    fs::remove_file(&path).map_err(|e| format!("The preset could not be deleted ({e})."))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of the test's own, removed when the test is done with it.
    struct Folder(PathBuf);

    impl Folder {
        fn new(name: &str) -> Folder {
            let dir = std::env::temp_dir().join(format!("gridelle-presets-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            Folder(dir)
        }
    }

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn names(dir: &Path) -> Vec<String> {
        list(dir).unwrap().presets.into_iter().map(|p| p.name).collect()
    }

    #[test]
    fn a_directory_that_is_not_there_has_no_presets_and_listing_does_not_make_it() {
        let folder = Folder::new("missing");
        let listed = list(&folder.0).unwrap();
        assert_eq!(listed.presets, []);
        assert_eq!(listed.dir, folder.0.to_string_lossy());
        assert!(!folder.0.exists());
    }

    #[test]
    fn lists_the_presets_by_name_and_nothing_else() {
        let folder = Folder::new("list");
        for name in ["tape Echo", "Basic Synth", "Äänimaisema", "basic bass"] {
            save(&folder.0, name, "{}", false).unwrap();
        }
        // What is not a preset: other files, a folder named like one, hidden files.
        fs::write(folder.0.join("notes.txt"), "mine").unwrap();
        fs::write(folder.0.join("kick.wav"), "sound").unwrap();
        fs::write(folder.0.join(".hidden.gridelle"), "{}").unwrap();
        fs::write(folder.0.join(".gridelle"), "{}").unwrap();
        fs::create_dir(folder.0.join("Folder.gridelle")).unwrap();

        let listed = list(&folder.0).unwrap();
        assert_eq!(names(&folder.0), ["basic bass", "Basic Synth", "tape Echo", "Äänimaisema"]);
        assert_eq!(listed.presets[1].path, folder.0.join("Basic Synth.gridelle").to_string_lossy());
    }

    #[test]
    fn saves_under_the_name_and_asks_before_replacing() {
        let folder = Folder::new("save");
        // The directory is made by the first save.
        let path = save(&folder.0, "My Patch", "first", false).unwrap();
        assert_eq!(path, folder.0.join("My Patch.gridelle").to_string_lossy());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");

        assert_eq!(save(&folder.0, "My Patch", "second", false).unwrap_err(), EXISTS);
        assert_eq!(fs::read_to_string(&path).unwrap(), "first", "nothing was written");
        assert_eq!(save(&folder.0, "My Patch", "second", true).unwrap(), path);
        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        // Nothing is left of the file it was written through.
        assert_eq!(fs::read_dir(&folder.0).unwrap().count(), 1);
        assert_eq!(names(&folder.0), ["My Patch"]);
    }

    #[test]
    fn refuses_names_that_are_not_one_plain_file_name() {
        let folder = Folder::new("names");
        for good in ["Tape Echo", "Säkkijärven polkka #2!", "a", "It's (mine) & yours, v1.2"] {
            assert!(is_preset_name(good), "{good}");
        }
        let long = "x".repeat(81);
        for bad in ["", " ", "../escape", "a/b", "a\\b", "C:patch", ".hidden", "ends.", " padded", "padded ", "what?", "a\nb", "x*", "<x>", "a|b", "\"q\"", long.as_str()] {
            assert!(!is_preset_name(bad), "{bad:?}");
            assert!(save(&folder.0, bad, "{}", true).is_err(), "{bad:?}");
        }
        assert!(is_preset_name(&"x".repeat(80)));
        assert!(!folder.0.exists(), "a refused save makes nothing");
    }

    fn example(name: &str, contents: &str) -> Example {
        Example { name: name.into(), contents: contents.into() }
    }

    #[test]
    fn writes_the_editors_own_presets_once_and_leaves_deleted_ones_deleted() {
        let folder = Folder::new("seed");
        let first = [example("New patch", "new"), example("Basic Synth", "synth"), example("Looper", "loop")];
        // The first start: the directory is made and all of them written.
        seed(&folder.0, &first).unwrap();
        assert_eq!(names(&folder.0), ["Basic Synth", "Looper", "New patch"]);
        assert_eq!(fs::read_to_string(folder.0.join("Looper.gridelle")).unwrap(), "loop");

        // The user deletes one and rewrites another. The next start changes neither.
        delete(&folder.0, &folder.0.join("Looper.gridelle").to_string_lossy()).unwrap();
        save(&folder.0, "New patch", "my own base", true).unwrap();
        seed(&folder.0, &first).unwrap();
        assert_eq!(names(&folder.0), ["Basic Synth", "New patch"]);
        assert_eq!(fs::read_to_string(folder.0.join("New patch.gridelle")).unwrap(), "my own base");

        // A later version of the editor comes with one more: that one is written, the deleted one is not.
        let later = [first[0].clone(), first[1].clone(), first[2].clone(), example("Tape Echo", "echo")];
        seed(&folder.0, &later).unwrap();
        assert_eq!(names(&folder.0), ["Basic Synth", "New patch", "Tape Echo"]);
        seed(&folder.0, &later).unwrap();
        assert_eq!(names(&folder.0), ["Basic Synth", "New patch", "Tape Echo"]);
    }

    #[test]
    fn does_not_write_over_a_preset_the_user_already_has_under_an_examples_name() {
        let folder = Folder::new("seed-own");
        save(&folder.0, "Basic Synth", "mine", false).unwrap();
        seed(&folder.0, &[example("Basic Synth", "the example"), example("Looper", "loop")]).unwrap();
        assert_eq!(fs::read_to_string(folder.0.join("Basic Synth.gridelle")).unwrap(), "mine");
        assert_eq!(names(&folder.0), ["Basic Synth", "Looper"]);
        // And it counts as written: deleting it does not bring the example in its place.
        delete(&folder.0, &folder.0.join("Basic Synth.gridelle").to_string_lossy()).unwrap();
        seed(&folder.0, &[example("Basic Synth", "the example"), example("Looper", "loop")]).unwrap();
        assert_eq!(names(&folder.0), ["Looper"]);
    }

    #[test]
    fn starts_again_in_a_directory_that_was_removed_and_refuses_a_bad_name() {
        let folder = Folder::new("seed-again");
        seed(&folder.0, &[example("New patch", "new")]).unwrap();
        fs::remove_dir_all(&folder.0).unwrap();
        seed(&folder.0, &[example("New patch", "new")]).unwrap();
        assert_eq!(names(&folder.0), ["New patch"]);
        assert!(seed(&folder.0, &[example("../outside", "x")]).is_err());
        assert_eq!(names(&folder.0), ["New patch"]);
    }

    #[test]
    fn deletes_a_preset_of_the_directory_and_nothing_else() {
        let folder = Folder::new("delete");
        let path = save(&folder.0, "Old", "{}", false).unwrap();
        save(&folder.0, "Kept", "{}", false).unwrap();
        fs::write(folder.0.join("notes.txt"), "mine").unwrap();
        fs::create_dir(folder.0.join("sub")).unwrap();
        fs::write(folder.0.join("sub/Deep.gridelle"), "{}").unwrap();
        let outside = std::env::temp_dir().join(format!("gridelle-presets-outside-{}.gridelle", std::process::id()));
        fs::write(&outside, "{}").unwrap();

        delete(&folder.0, &path).unwrap();
        assert_eq!(names(&folder.0), ["Kept"]);
        assert!(delete(&folder.0, &path).is_err(), "it is gone");

        for other in [
            folder.0.join("notes.txt"),
            folder.0.join("sub/Deep.gridelle"),
            folder.0.join("sub/../Kept.gridelle"),
            folder.0.join(".hidden.gridelle"),
            outside.clone(),
        ] {
            assert!(delete(&folder.0, &other.to_string_lossy()).is_err(), "{}", other.display());
        }
        assert!(outside.exists() && folder.0.join("notes.txt").exists() && folder.0.join("sub/Deep.gridelle").exists());
        assert_eq!(names(&folder.0), ["Kept"]);
        fs::remove_file(&outside).unwrap();
    }
}
