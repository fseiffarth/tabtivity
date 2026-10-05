//! What the phone's **+ → From the desktop** can attach: the images already
//! sitting on the desktop — the screenshot just taken, the picture just
//! downloaded — listed by name so a message typed on the phone can carry one
//! without a hunt through a file picker on the wrong device.
//!
//! The list is drawn from the user's own screenshot and picture folders
//! (XDG user dirs on Linux, the platform defaults elsewhere) plus Tabtivity's own
//! screenshot staging area, one level deep, newest first, capped. The system
//! clipboard's image is the caller's to add on top (`CLIPBOARD_ID`): reading
//! it needs a display connection, which this module deliberately has not.
//!
//! **No path leaves.** Each entry is named by an opaque id derived from its
//! path, and attaching one re-scans the same folders for that id: the phone
//! can only ever name a file this module would list anyway, never a path of
//! its own choosing. The bytes are then copied into the project's inbox by
//! `mobile_control::inbox`, exactly as a file sent from the phone would be, so
//! the reference the agent reads is the same project-relative one.

use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::services::mobile_control::inbox::MAX_INBOX_FILE;

/// The id the caller gives the clipboard's image, which has no path.
pub const CLIPBOARD_ID: &str = "clipboard";
/// How many files the list carries at most — a phone sheet, not a browser.
pub const MAX_LISTED: usize = 40;
/// What the agents read as an image. Extensions, lowercase.
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp"];

/// One image the phone may ask for. `source` is a folder *label*, never a
/// path; `id` is opaque.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DesktopImage {
    pub id: String,
    pub name: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Seconds since the file was last written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub age_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// A folder the list is drawn from, with the label the phone shows for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageFolder {
    pub label: String,
    pub path: PathBuf,
}

impl ImageFolder {
    fn new(label: &str, path: PathBuf) -> Self {
        Self {
            label: label.to_string(),
            path,
        }
    }
}

/// The platform's screenshot and picture folders plus Tabtivity's own screenshot
/// staging area under `state_dir`, where a shot taken through the Screenshot
/// app waits for its filing answer. Linux honours `user-dirs.dirs`, so a
/// localized `~/Bilder` is found. Shared by the desktop command and the
/// Mobile sidecar's answer with no window (headless owner plan, H3).
pub fn default_folders(state_dir: &Path) -> Vec<ImageFolder> {
    let home = crate::paths::home_dir();
    let user_dirs = if cfg!(target_os = "linux") {
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        fs::read_to_string(config.join("user-dirs.dirs"))
            .map(|text| parse_user_dirs(&text, &home))
            .unwrap_or_default()
    } else {
        HashMap::new()
    };
    let mut folders = image_folders(crate::paths::OsKind::current(), &home, &user_dirs);
    folders.push(ImageFolder {
        label: concat!(crate::app_name!(), " screenshots").into(),
        path: state_dir.join("screenshots-pending"),
    });
    folders
}

/// The `XDG_*_DIR` lines of `user-dirs.dirs`, `$HOME` expanded. Only the
/// `"$HOME/…"` and absolute forms the spec allows; anything else is skipped.
pub fn parse_user_dirs(text: &str, home: &Path) -> HashMap<String, PathBuf> {
    let mut dirs = HashMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if !key.starts_with("XDG_") || !key.ends_with("_DIR") {
            continue;
        }
        let value = value.trim().trim_matches('"');
        let path = if let Some(rest) = value.strip_prefix("$HOME/") {
            home.join(rest.trim_end_matches('/'))
        } else if value == "$HOME" {
            home.to_path_buf()
        } else if value.starts_with('/') {
            PathBuf::from(value)
        } else {
            continue;
        };
        dirs.insert(key.to_string(), path);
    }
    dirs
}

/// The folders a screenshot or a saved picture lands in on this platform,
/// most likely first. Missing ones are kept — `list` simply finds nothing
/// there — so the order is stable whatever exists.
pub fn image_folders(os: crate::paths::OsKind, home: &Path, user_dirs: &HashMap<String, PathBuf>) -> Vec<ImageFolder> {
    let pictures = user_dirs
        .get("XDG_PICTURES_DIR")
        .cloned()
        .unwrap_or_else(|| home.join("Pictures"));
    let desktop = user_dirs
        .get("XDG_DESKTOP_DIR")
        .cloned()
        .unwrap_or_else(|| home.join("Desktop"));
    let downloads = user_dirs
        .get("XDG_DOWNLOAD_DIR")
        .cloned()
        .unwrap_or_else(|| home.join("Downloads"));
    let screenshots = ImageFolder::new("Screenshots", pictures.join("Screenshots"));
    let pictures = ImageFolder::new("Pictures", pictures);
    let desktop = ImageFolder::new("Desktop", desktop);
    let downloads = ImageFolder::new("Downloads", downloads);
    match os {
        // macOS files a screenshot on the Desktop by default.
        crate::paths::OsKind::Macos => vec![desktop, pictures, screenshots, downloads],
        _ => vec![screenshots, pictures, desktop, downloads],
    }
}

/// The opaque id of one file: a hash of its path, so the same file keeps the
/// same id across two scans and nothing about the path can be read back.
fn image_id(path: &Path) -> String {
    let digest = Sha256::digest(path.as_os_str().as_encoded_bytes());
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

/// Whether `id` has the shape `image_id` produces (or is the clipboard's).
pub fn valid_id(id: &str) -> bool {
    id == CLIPBOARD_ID || (id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

struct Found {
    folder: usize,
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

/// Every attachable image directly inside `folders`: a regular image file,
/// non-empty, no larger than the inbox takes. Symlinks are followed only as
/// far as `metadata` does — the copy later reads whatever the link points at,
/// which is the user's own file to point anywhere.
fn scan(folders: &[ImageFolder]) -> Vec<Found> {
    let mut found = Vec::new();
    for (index, folder) in folders.iter().enumerate() {
        let Ok(entries) = fs::read_dir(&folder.path) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !is_image(&path) {
                continue;
            }
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_INBOX_FILE as u64 {
                continue;
            }
            found.push(Found {
                folder: index,
                path,
                size: meta.len(),
                modified: meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }
    }
    found
}

/// The newest `MAX_LISTED` images across `folders`, newest first.
pub fn list(folders: &[ImageFolder], now: SystemTime) -> Vec<DesktopImage> {
    let mut found = scan(folders);
    found.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.path.cmp(&b.path)));
    found.truncate(MAX_LISTED);
    found
        .into_iter()
        .map(|file| DesktopImage {
            id: image_id(&file.path),
            name: file
                .path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            source: folders[file.folder].label.clone(),
            size: Some(file.size),
            age_secs: Some(
                now.duration_since(file.modified)
                    .map(|age| age.as_secs())
                    .unwrap_or(0),
            ),
            width: None,
            height: None,
        })
        .collect()
}

/// The file behind an id, found by scanning the same folders again — so an
/// id can only ever name something `list` would offer.
pub fn resolve(folders: &[ImageFolder], id: &str) -> Option<PathBuf> {
    if !valid_id(id) || id == CLIPBOARD_ID {
        return None;
    }
    scan(folders)
        .into_iter()
        .find(|file| image_id(&file.path) == id)
        .map(|file| file.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // Opened for WRITING, not reading: `set_modified` is `SetFileTime` on
    // Windows, which wants `FILE_WRITE_ATTRIBUTES` on the handle and answers a
    // read-only one with `PermissionDenied`. Unix does not care either way.
    fn touch(dir: &Path, name: &str, bytes: &[u8], age: Duration) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, bytes).unwrap();
        let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
        path
    }

    #[test]
    fn user_dirs_expand_home_and_skip_what_the_spec_forbids() {
        let home = Path::new("/home/ada");
        let dirs = parse_user_dirs(
            "# comment\nXDG_DESKTOP_DIR=\"$HOME/Schreibtisch\"\nXDG_PICTURES_DIR=\"/media/pics/\"\nXDG_DOWNLOAD_DIR=\"~/Downloads\"\nXDG_MUSIC_DIR=\"$HOME\"\nNOT_A_DIR=\"$HOME/x\"\n",
            home,
        );
        assert_eq!(dirs["XDG_DESKTOP_DIR"], PathBuf::from("/home/ada/Schreibtisch"));
        assert_eq!(dirs["XDG_PICTURES_DIR"], PathBuf::from("/media/pics/"));
        assert_eq!(dirs["XDG_MUSIC_DIR"], PathBuf::from("/home/ada"));
        assert!(!dirs.contains_key("XDG_DOWNLOAD_DIR"));
        assert!(!dirs.contains_key("NOT_A_DIR"));
    }

    #[test]
    fn folders_follow_the_user_dirs_and_put_screenshots_first() {
        let home = Path::new("/home/ada");
        let mut user_dirs = HashMap::new();
        user_dirs.insert("XDG_PICTURES_DIR".to_string(), PathBuf::from("/home/ada/Bilder"));
        let folders = image_folders(crate::paths::OsKind::Unix, home, &user_dirs);
        let labels: Vec<&str> = folders.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, ["Screenshots", "Pictures", "Desktop", "Downloads"]);
        assert_eq!(folders[0].path, PathBuf::from("/home/ada/Bilder/Screenshots"));
        assert_eq!(folders[2].path, PathBuf::from("/home/ada/Desktop"));

        let mac = image_folders(crate::paths::OsKind::Macos, home, &HashMap::new());
        assert_eq!(mac[0].label, "Desktop");
        assert_eq!(mac[1].path, PathBuf::from("/home/ada/Pictures"));
    }

    #[test]
    fn the_list_is_images_only_newest_first_with_opaque_ids() {
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join("shots");
        let pics = dir.path().join("pics");
        fs::create_dir_all(&shots).unwrap();
        fs::create_dir_all(&pics).unwrap();
        let old = touch(&shots, "old.PNG", b"png", Duration::from_secs(3_600));
        let new = touch(&pics, "new.jpg", b"jpg", Duration::from_secs(60));
        touch(&pics, "notes.txt", b"text", Duration::from_secs(1));
        touch(&pics, "empty.png", b"", Duration::from_secs(1));
        fs::create_dir_all(pics.join("album.png")).unwrap();
        let folders = vec![
            ImageFolder::new("Screenshots", shots.clone()),
            ImageFolder::new("Pictures", pics.clone()),
            ImageFolder::new("Missing", dir.path().join("nope")),
        ];

        let listed = list(&folders, SystemTime::now());
        let names: Vec<&str> = listed.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["new.jpg", "old.PNG"]);
        assert_eq!(listed[0].source, "Pictures");
        assert_eq!(listed[1].source, "Screenshots");
        assert_eq!(listed[0].size, Some(3));
        assert!(listed[0].age_secs.unwrap() >= 59);
        assert!(listed[1].age_secs.unwrap() >= 3_599);
        for image in &listed {
            assert!(valid_id(&image.id), "{}", image.id);
            let serialized = serde_json::to_string(image).unwrap();
            assert!(!serialized.contains(dir.path().to_str().unwrap()), "{serialized}");
        }

        assert_eq!(resolve(&folders, &listed[0].id), Some(new));
        assert_eq!(resolve(&folders, &listed[1].id), Some(old));
        assert_eq!(resolve(&folders, &image_id(&pics.join("notes.txt"))), None);
        assert_eq!(resolve(&folders, CLIPBOARD_ID), None);
        assert_eq!(resolve(&folders, "../../etc/passwd"), None);
        assert_eq!(resolve(&folders, ""), None);
    }

    #[test]
    fn an_oversized_image_is_never_offered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.png");
        let file = fs::File::create(&path).unwrap();
        file.set_len(MAX_INBOX_FILE as u64 + 1).unwrap();
        let folders = vec![ImageFolder::new("Pictures", dir.path().to_path_buf())];
        assert!(list(&folders, SystemTime::now()).is_empty());
        assert_eq!(resolve(&folders, &image_id(&path)), None);
    }

    #[test]
    fn the_list_is_capped() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..(MAX_LISTED + 5) {
            fs::write(dir.path().join(format!("{index}.png")), b"x").unwrap();
        }
        let folders = vec![ImageFolder::new("Pictures", dir.path().to_path_buf())];
        assert_eq!(list(&folders, SystemTime::now()).len(), MAX_LISTED);
    }
}
