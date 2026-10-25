//! The speech model catalog: what the one-click install tab may fetch, from
//! where, and the hash it must have. Only a catalog id ever comes from the
//! renderer — never a path or a URL — and every URL names a fixed commit of
//! its Hugging Face repo (`resolve/<commit>/…`), never `main`, so an upstream
//! re-upload cannot break the hash check for every user.
//!
//! Models live in `<state_dir>/voice/models/`, which is never mounted into a
//! fence. A model counts as installed when its file has the catalog's exact
//! size: the install script checks the hash before the rename, so a file
//! under the final name has passed it.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::quote;

/// What a catalog entry is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelKind {
    /// A whisper speech-to-text model.
    Whisper,
    /// whisper.cpp's Silero voice-activity model, which confirms a finished
    /// segment; fetched along with whichever whisper model is installed.
    Vad,
}

/// One downloadable model.
#[derive(Debug)]
pub struct CatalogEntry {
    pub id: &'static str,
    pub kind: ModelKind,
    pub file: &'static str,
    /// Hugging Face `owner/name`.
    pub repo: &'static str,
    /// The repo commit the URL resolves at.
    pub commit: &'static str,
    pub sha256: &'static str,
    pub size: u64,
}

impl CatalogEntry {
    pub fn url(&self) -> String {
        format!("https://huggingface.co/{}/resolve/{}/{}", self.repo, self.commit, self.file)
    }
}

/// The default model (fixed decision: multilingual `small`, q5_1).
pub const DEFAULT_MODEL: &str = "small";

pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "base",
        kind: ModelKind::Whisper,
        file: "ggml-base-q5_1.bin",
        repo: WHISPER_REPO,
        commit: WHISPER_COMMIT,
        sha256: "422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898",
        size: 59707625,
    },
    CatalogEntry {
        id: "small",
        kind: ModelKind::Whisper,
        file: "ggml-small-q5_1.bin",
        repo: WHISPER_REPO,
        commit: WHISPER_COMMIT,
        sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb",
        size: 190085487,
    },
    CatalogEntry {
        id: "large-v3-turbo",
        kind: ModelKind::Whisper,
        file: "ggml-large-v3-turbo-q5_0.bin",
        repo: WHISPER_REPO,
        commit: WHISPER_COMMIT,
        sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        size: 574041195,
    },
    CatalogEntry {
        id: "silero-vad",
        kind: ModelKind::Vad,
        file: "ggml-silero-v6.2.0.bin",
        repo: VAD_REPO,
        commit: VAD_COMMIT,
        sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
        size: 885098,
    },
];

const WHISPER_REPO: &str = "ggerganov/whisper.cpp";
/// 2024-10-29: the commit that holds the q5 quantizations used here.
const WHISPER_COMMIT: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const VAD_REPO: &str = "ggml-org/whisper-vad";
/// 2025-11-17: Silero v6.2.0, the one whisper.cpp 1.8.3's README names.
const VAD_COMMIT: &str = "9ffd54a1e1ee413ddf265af9913beaf518d1639b";

pub fn entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// A whisper model by id; the VAD model is never one to listen with.
pub fn whisper_entry(id: &str) -> Option<&'static CatalogEntry> {
    entry(id).filter(|e| e.kind == ModelKind::Whisper)
}

pub fn vad_entry() -> &'static CatalogEntry {
    CATALOG
        .iter()
        .find(|e| e.kind == ModelKind::Vad)
        .expect("the catalog has a VAD model")
}

pub fn models_dir() -> PathBuf {
    crate::storage::state_dir().join("voice").join("models")
}

pub fn model_path(entry: &CatalogEntry) -> PathBuf {
    models_dir().join(entry.file)
}

/// Installed: the file is there with the catalog's exact size.
pub fn installed_in(dir: &Path, entry: &CatalogEntry) -> bool {
    std::fs::metadata(dir.join(entry.file)).is_ok_and(|m| m.is_file() && m.len() == entry.size)
}

pub fn installed(entry: &CatalogEntry) -> bool {
    installed_in(&models_dir(), entry)
}

/// One row of `voice_status`' model list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelState {
    pub id: &'static str,
    pub kind: ModelKind,
    pub installed: bool,
    pub size_bytes: u64,
}

pub fn states() -> Vec<ModelState> {
    let dir = models_dir();
    CATALOG
        .iter()
        .map(|e| ModelState { id: e.id, kind: e.kind, installed: installed_in(&dir, e), size_bytes: e.size })
        .collect()
}

/// The fetch-and-verify script for whisper model `id` (plus the VAD model),
/// for the install tab: one script, one click, never copy-it-yourself.
/// `windows` picks PowerShell over bash. Every path and URL is quoted for the
/// shell that runs it, and the expected hash is part of the script, never
/// fetched alongside the file.
pub fn install_script(id: &str, dir: &Path, windows: bool) -> Option<String> {
    let model = whisper_entry(id)?;
    let fetches = [model, vad_entry()];
    let dir = dir.to_string_lossy();
    Some(if windows {
        let mut s = String::from("$ErrorActionPreference = 'Stop'\n");
        s += &format!("New-Item -ItemType Directory -Force -Path {} | Out-Null\n", quote::powershell(&dir));
        s += &format!("Set-Location -LiteralPath {}\n", quote::powershell(&dir));
        for e in fetches {
            let name = quote::powershell(e.file);
            let part = quote::powershell(&format!("{}.part", e.file));
            s += &format!(
                "if (Test-Path -LiteralPath {name}) {{ Write-Output ('── ' + {name} + ' is already here ──') }} else {{\n\
                 \x20 Write-Output ('── Fetching ' + {name} + ' ({mb} MB) ──')\n\
                 \x20 Invoke-WebRequest -Uri {url} -OutFile {part}\n\
                 \x20 $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath {part}).Hash.ToLower()\n\
                 \x20 if ($actual -ne {hash}) {{ Remove-Item -LiteralPath {part}; throw \"checksum mismatch: $actual\" }}\n\
                 \x20 Move-Item -Force -LiteralPath {part} -Destination {name}\n\
                 }}\n",
                mb = e.size.div_ceil(1_000_000),
                url = quote::powershell(&e.url()),
                hash = quote::powershell(e.sha256),
            );
        }
        s += "Write-Output '── Speech model ready. ──'\n";
        s
    } else {
        // macOS has no `sha256sum`; `shasum -a 256` reads the same `-c` format.
        let sha = if cfg!(target_os = "macos") { "shasum -a 256" } else { "sha256sum" };
        let mut s = String::from("#!/usr/bin/env bash\nset -euo pipefail\n");
        s += &format!("mkdir -p {}\ncd {}\n", quote::posix(&dir), quote::posix(&dir));
        for e in fetches {
            let name = quote::posix(e.file);
            let part = quote::posix(&format!("{}.part", e.file));
            s += &format!(
                "if [ -f {name} ]; then echo '── '{name}' is already here ──'; else\n\
                 \x20 echo '── Fetching '{name}' ({mb} MB) ──'\n\
                 \x20 curl -fL --progress-bar -o {part} {url}\n\
                 \x20 echo {check} | {sha} -c - || {{ rm -f {part}; exit 1; }}\n\
                 \x20 mv {part} {name}\n\
                 fi\n",
                mb = e.size.div_ceil(1_000_000),
                url = quote::posix(&e.url()),
                check = quote::posix(&format!("{}  {}.part", e.sha256, e.file)),
            );
        }
        s += "echo '── Speech model ready. ──'\n";
        s
    })
}

/// Write the install script for `id` and return the command the install tab
/// runs; `None` for an id that is not a whisper model in the catalog.
pub fn install_command(id: &str) -> Result<String, String> {
    let windows = cfg!(windows);
    let dir = models_dir();
    let script = install_script(id, &dir, windows).ok_or_else(|| "unknown-model".to_string())?;
    let parent = dir.parent().unwrap_or(&dir).to_path_buf();
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let path = parent.join(if windows { "fetch-model.ps1" } else { "fetch-model.sh" });
    std::fs::write(&path, script).map_err(|e| e.to_string())?;
    let path = path.to_string_lossy();
    Ok(if windows {
        format!("powershell -NoProfile -ExecutionPolicy Bypass -File {}", quote::powershell(&path))
    } else {
        format!("bash {}", quote::posix(&path))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_pinned() {
        let mut ids: Vec<_> = CATALOG.iter().map(|e| e.id).collect();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len(), "ids are unique");
        for e in CATALOG {
            assert!(e.sha256.len() == 64 && e.sha256.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()), "{}: sha256", e.id);
            assert!(e.commit.len() == 40 && e.commit.bytes().all(|b| b.is_ascii_hexdigit()), "{}: commit", e.id);
            assert!(e.size > 0 && !e.file.is_empty() && !e.file.contains(['/', '\\', '\'']), "{}", e.id);
            assert!(e.url().starts_with("https://huggingface.co/") && e.url().contains("/resolve/"), "{}", e.url());
            assert!(!e.url().contains("/main/"), "{}", e.url());
        }
        assert!(whisper_entry(DEFAULT_MODEL).is_some());
        assert_eq!(CATALOG.iter().filter(|e| e.kind == ModelKind::Vad).count(), 1);
    }

    #[test]
    fn only_a_whisper_catalog_id_gets_a_script() {
        let dir = Path::new("models");
        assert!(install_script("../../etc/passwd", dir, false).is_none());
        assert!(install_script("https://example.com/x.bin", dir, false).is_none());
        assert!(install_script(vad_entry().id, dir, false).is_none());
        assert!(install_script(DEFAULT_MODEL, dir, true).is_some());
    }

    #[test]
    fn the_bash_script_verifies_the_embedded_hash_before_the_rename() {
        let dir = if cfg!(windows) { Path::new(r"C:\Users\o'brien\voice\models").to_path_buf() } else { Path::new("/home/o'brien/voice/models").to_path_buf() };
        let script = install_script(DEFAULT_MODEL, &dir, false).unwrap();
        let small = whisper_entry(DEFAULT_MODEL).unwrap();
        assert!(script.contains(&quote::posix(&dir.to_string_lossy())), "{script}");
        assert!(script.contains(&small.url()));
        for e in [small, vad_entry()] {
            let check = script.find(&format!("{}  {}.part", e.sha256, e.file)).unwrap();
            let mv = script.find(&format!("mv '{}.part' '{}'", e.file, e.file)).unwrap();
            assert!(check < mv);
        }
        assert!(!script.contains("SHA256SUMS"));
    }

    #[test]
    fn the_powershell_script_verifies_the_embedded_hash_before_the_rename() {
        let dir = Path::new(r"C:\Users\o'brien\voice\models");
        let script = install_script(DEFAULT_MODEL, dir, true).unwrap();
        assert!(script.contains(r"'C:\Users\o''brien\voice\models'"), "{script}");
        for e in [whisper_entry(DEFAULT_MODEL).unwrap(), vad_entry()] {
            let check = script.find(&format!("-ne '{}'", e.sha256)).unwrap();
            let mv = script.find(&format!("Move-Item -Force -LiteralPath '{}.part'", e.file)).unwrap();
            assert!(check < mv);
        }
    }

    #[test]
    fn installed_means_the_exact_size() {
        let dir = tempfile::tempdir().unwrap();
        let e = vad_entry();
        assert!(!installed_in(dir.path(), e));
        std::fs::write(dir.path().join(e.file), vec![0u8; e.size as usize - 1]).unwrap();
        assert!(!installed_in(dir.path(), e));
        std::fs::write(dir.path().join(e.file), vec![0u8; e.size as usize]).unwrap();
        assert!(installed_in(dir.path(), e));
    }
}
