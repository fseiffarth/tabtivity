//! Several projects in one file: a **project set**.
//!
//! A set is a zip holding one ordinary project bundle per project, each
//! *stored* (not compressed again — a bundle is already a deflated zip), plus
//! a small manifest naming them:
//!
//! ```text
//! project-set.json             the set manifest (`SetManifest`)
//! projects/01-<name>.<ext>     one whole project bundle per project
//! ```
//!
//! It reuses the single-project bundle unchanged rather than defining a second
//! layout: every member is exactly what "Export project…" would have written,
//! and import runs the single-project import on each one, so nothing a bundle
//! guarantees (the untrusted-layout sanitizer, zip-slip confinement, links
//! written last, re-pointed paths) needs restating here. Because each member
//! is stored, its bytes sit contiguous in the set file, and import reads it in
//! place through a [`FileWindow`] — no member is ever unpacked to a temp file.
//!
//! The set shares the single bundle's extension, so the one file picker opens
//! both; [`inspect_project_bundle`] tells them apart by their manifests.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    absolutize, export_project_excluding, inspect_bundle, BundleInfo, ExportProjectRequest,
    ExportReport, MirrorSource, BUNDLE_EXTENSION, BUNDLE_MANIFEST,
};
use crate::commands::projects::{read_projects_list, sanitize_name, validate_project_id};
use crate::storage;

/// The set manifest. Deliberately not brand-named: no older build ever wrote
/// a set, so there is no legacy name to keep reading.
pub const SET_MANIFEST: &str = "project-set.json";

/// Set format version; import refuses a newer one.
pub const SET_FORMAT: u32 = 1;

/// Where the members live inside the set.
const MEMBER_DIR: &str = "projects";

/// Progress event name (payload: [`ExportSetProgress`]).
pub(super) const SET_PROGRESS_EVENT: &str = "project-export-set";

/// Most projects one set takes. Generous for a person's workspace; a bound
/// so a hand-made manifest cannot make the dialog list a million rows.
const MAX_MEMBERS: usize = 500;

// ── Wire types ────────────────────────────────────────────────────────────

/// `project-set.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetManifest {
    pub format: u32,
    pub app_version: String,
    pub exported_at: String,
    pub members: Vec<SetMemberRecord>,
    /// A newer build's extra keys survive a round trip.
    #[serde(flatten)]
    pub extra: std::collections::HashMap<String, Value>,
}

/// One member as the set manifest records it. Informational only: what import
/// trusts about a member is read from that member's own bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMemberRecord {
    /// Entry name inside the set (`projects/…`).
    pub file: String,
    pub project_id: String,
    pub name: String,
    pub remote: bool,
    /// The member bundle's size.
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetRequest {
    /// The projects, in the order they are packed.
    pub project_ids: Vec<String>,
    pub dest_path: String,
    #[serde(default = "super::yes")]
    pub include_files: bool,
    #[serde(default = "super::yes")]
    pub include_git: bool,
    #[serde(default = "super::yes")]
    pub include_session: bool,
    /// Remote projects: carry their tree. A mirrored one packs its local
    /// mirror; a remote-only one only when it is listed in `host_copy`.
    #[serde(default = "super::yes")]
    pub include_mirror: bool,
    #[serde(default = "super::yes")]
    pub skip_rebuildable: bool,
    #[serde(default)]
    pub include_agent_history: bool,
    /// Remote projects whose tree is packed from the host's own copy (the
    /// dialog lists only connected ones). Without it a remote-only project
    /// travels without its tree.
    #[serde(default)]
    pub host_copy: Vec<String>,
}

/// One project's outcome in a set export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetMember {
    pub project_id: String,
    pub name: String,
    /// The member's export report (its `path` is the entry name in the set).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<ExportReport>,
    /// Why this project is not in the set. The others still are.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetReport {
    pub path: String,
    /// The set file's size on disk.
    pub bytes: u64,
    pub members: Vec<ExportSetMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSetProgress {
    /// 0-based position of the project being packed.
    pub index: usize,
    pub count: usize,
    pub project_id: String,
    /// `"file"` | `"done"`
    pub phase: String,
    pub done: u64,
    pub total: u64,
}

/// What the import dialog learns from a picked file.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum InspectedBundle {
    /// A bundle of one project.
    Project { info: Box<BundleInfo> },
    /// A project set.
    Set { set: SetInfo },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetInfo {
    pub path: String,
    pub app_version: String,
    pub exported_at: String,
    pub members: Vec<SetMemberInfo>,
    /// Default landing folders: for local projects, and for remote mirrors.
    pub suggested_parent: String,
    pub suggested_mirror_parent: String,
}

/// One member as the import dialog sees it: its bundle read, or why not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMemberInfo {
    pub member: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<BundleInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Reading a member in place ─────────────────────────────────────────────

/// A byte range of a file read as a file of its own: a whole bundle, or one
/// member stored inside a set.
#[derive(Debug)]
pub struct FileWindow {
    file: fs::File,
    start: u64,
    len: u64,
    pos: u64,
}

impl FileWindow {
    /// The whole file at `path`.
    pub fn whole(path: &str) -> Result<Self, String> {
        let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
        let len = file.metadata().map_err(|e| format!("open {path}: {e}"))?.len();
        Ok(Self { file, start: 0, len, pos: 0 })
    }

    fn range(mut file: fs::File, start: u64, len: u64) -> std::io::Result<Self> {
        file.seek(SeekFrom::Start(start))?;
        Ok(Self { file, start, len, pos: 0 })
    }
}

impl Read for FileWindow {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let left = self.len.saturating_sub(self.pos);
        if left == 0 || buf.is_empty() {
            return Ok(0);
        }
        let want = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let n = self.file.read(&mut buf[..want])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for FileWindow {
    fn seek(&mut self, to: SeekFrom) -> std::io::Result<u64> {
        let target = match to {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::End(d) => self.len.checked_add_signed(d),
            SeekFrom::Current(d) => self.pos.checked_add_signed(d),
        };
        let Some(target) = target else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "seek before the start of the bundle",
            ));
        };
        // Past the end is allowed, as for a file; reads there return nothing.
        self.file.seek(SeekFrom::Start(self.start + target))?;
        self.pos = target;
        Ok(target)
    }
}

/// Open a set and read its manifest.
fn open_set(path: &str) -> Result<(zip::ZipArchive<fs::File>, SetManifest), String> {
    let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("read {path}: {e}"))?;
    let manifest: SetManifest = {
        let entry = zip
            .by_name(SET_MANIFEST)
            .map_err(|_| format!("That file is not a project set (no {SET_MANIFEST} inside)"))?;
        serde_json::from_reader(entry).map_err(|e| format!("read {SET_MANIFEST}: {e}"))?
    };
    if manifest.format > SET_FORMAT {
        return Err(format!(
            concat!(
                "This project set was written by a newer ",
                crate::app_name!(),
                " (set format {}, this build reads {}). Update ",
                crate::app_name!(),
                " and try again."
            ),
            manifest.format, SET_FORMAT
        ));
    }
    if manifest.members.len() > MAX_MEMBERS {
        return Err(format!(
            "This project set lists {} projects; at most {MAX_MEMBERS} are read",
            manifest.members.len()
        ));
    }
    Ok((zip, manifest))
}

/// A member entry name the set may name: inside [`MEMBER_DIR`], one level,
/// nothing that walks out.
fn member_name_ok(member: &str) -> bool {
    member
        .strip_prefix(MEMBER_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .is_some_and(|leaf| {
            !leaf.is_empty()
                && !leaf.contains(['/', '\\'])
                && leaf != "."
                && leaf != ".."
        })
}

/// The bytes of `member` inside the set at `path`, as a file of their own.
/// Only a stored, unencrypted entry can be read in place, which is the only
/// kind a set is written with; anything else is refused.
pub fn member_window(path: &str, member: &str) -> Result<FileWindow, String> {
    if !member_name_ok(member) {
        return Err(format!("not a project in this set: {member}"));
    }
    let (mut zip, manifest) = open_set(path)?;
    if !manifest.members.iter().any(|m| m.file == member) {
        return Err(format!("not a project in this set: {member}"));
    }
    let (start, len) = {
        let entry = zip
            .by_name(member)
            .map_err(|e| format!("read {member}: {e}"))?;
        if entry.compression() != zip::CompressionMethod::Stored || entry.encrypted() {
            return Err(format!("{member} is not stored plainly in this set"));
        }
        let start = entry
            .data_start()
            .ok_or_else(|| format!("read {member}: no data offset"))?;
        (start, entry.compressed_size())
    };
    drop(zip);
    let total = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    if start.checked_add(len).is_none_or(|end| end > total) {
        return Err(format!("{member} runs past the end of the set"));
    }
    let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    FileWindow::range(file, start, len).map_err(|e| format!("read {member}: {e}"))
}

// ── Export ────────────────────────────────────────────────────────────────

/// `projects/07-<name>.<ext>`: numbered, so two projects of one name stay apart.
fn member_file(index: usize, name: &str) -> String {
    let safe = sanitize_name(name);
    let stem = if safe.is_empty() { "project" } else { &safe };
    format!("{MEMBER_DIR}/{:02}-{stem}.{BUNDLE_EXTENSION}", index + 1)
}

fn stored_options(size: u64) -> zip::write::FileOptions<'static, 'static, ()> {
    zip::write::FileOptions::<()>::default()
        .compression_method(zip::CompressionMethod::Stored)
        .unix_permissions(0o644)
        .large_file(size >= u32::MAX as u64)
}

/// Write a project set. `progress(index, project_id, done, total)` reports
/// the file count of the project being packed.
pub fn export_project_set_blocking(
    req: ExportSetRequest,
    progress: &mut dyn FnMut(usize, &str, u64, u64),
) -> Result<ExportSetReport, String> {
    let mut ids: Vec<String> = Vec::new();
    for id in &req.project_ids {
        validate_project_id(id)?;
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    if ids.is_empty() {
        return Err("No projects were chosen".to_string());
    }
    if ids.len() > MAX_MEMBERS {
        return Err(format!("At most {MAX_MEMBERS} projects go into one set"));
    }

    let dest = PathBuf::from(&req.dest_path);
    if dest.as_os_str().is_empty() {
        return Err("No destination was chosen".to_string());
    }
    let stage_parent = dest
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    fs::create_dir_all(&stage_parent)
        .map_err(|e| format!("create {}: {e}", stage_parent.display()))?;

    // Each member is written whole into `work`, copied into the staged set,
    // and deleted: one member's worth of extra disk at a time. Both sit beside
    // the destination — inside a project's tree when the set is saved into
    // one, so the walks are told to leave them (and the destination) out.
    let work = tempfile::Builder::new()
        .prefix(".project-set-")
        .tempdir_in(&stage_parent)
        .map_err(|e| format!("stage set in {}: {e}", stage_parent.display()))?;
    let mut staged = tempfile::NamedTempFile::new_in(&stage_parent)
        .map_err(|e| format!("stage set in {}: {e}", stage_parent.display()))?;
    let exclude = vec![
        absolutize(&dest),
        absolutize(work.path()),
        absolutize(staged.path()),
    ];

    let mut members: Vec<ExportSetMember> = Vec::new();
    let mut records: Vec<SetMemberRecord> = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(staged.as_file_mut());
        for (index, id) in ids.iter().enumerate() {
            let entry = match crate::services::remote::project_entry(id) {
                Ok(entry) => entry,
                Err(e) => {
                    members.push(ExportSetMember {
                        project_id: id.clone(),
                        name: String::new(),
                        report: None,
                        error: Some(e),
                    });
                    continue;
                }
            };
            let remote_only = crate::services::remote::entry_is_remote_only(&entry);
            let from_host = req.host_copy.contains(id);
            let inner = work.path().join(format!("{index}.part"));
            let inner_req = ExportProjectRequest {
                project_id: id.clone(),
                dest_path: inner.to_string_lossy().to_string(),
                include_files: req.include_files,
                include_git: req.include_git,
                include_session: req.include_session,
                // A remote-only project has no local copy to fall back on.
                include_mirror: req.include_mirror && (from_host || !remote_only),
                mirror_source: if from_host { MirrorSource::Host } else { MirrorSource::Local },
                skip_rebuildable: req.skip_rebuildable,
                keep_rebuildable: Vec::new(),
                include_agent_history: req.include_agent_history,
            };
            let exported = export_project_excluding(inner_req, &exclude, &mut |done, total| {
                progress(index, id, done, total)
            });
            let mut report = match exported {
                Ok(report) => report,
                Err(e) => {
                    let _ = fs::remove_file(&inner);
                    members.push(ExportSetMember {
                        project_id: id.clone(),
                        name: entry.name.clone(),
                        report: None,
                        error: Some(e),
                    });
                    continue;
                }
            };
            let file = member_file(index, &entry.name);
            let source = fs::File::open(&inner).map_err(|e| format!("read {}: {e}", inner.display()))?;
            let size = source.metadata().map(|m| m.len()).unwrap_or(0);
            zip.start_file(file.as_str(), stored_options(size))
                .map_err(|e| format!("zip {file}: {e}"))?;
            std::io::copy(&mut std::io::BufReader::new(source), &mut zip)
                .map_err(|e| format!("zip {file}: {e}"))?;
            let _ = fs::remove_file(&inner);

            report.path = file.clone();
            records.push(SetMemberRecord {
                file,
                project_id: id.clone(),
                name: entry.name.clone(),
                remote: report.remote,
                bytes: size,
            });
            members.push(ExportSetMember {
                project_id: id.clone(),
                name: entry.name,
                report: Some(report),
                error: None,
            });
        }

        if records.is_empty() {
            // Nothing to carry: say why the first one failed, write nothing.
            let why = members
                .iter()
                .find_map(|m| m.error.clone())
                .unwrap_or_else(|| "No project could be exported".to_string());
            return Err(why);
        }

        let manifest = SetManifest {
            format: SET_FORMAT,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            exported_at: storage::iso_now(),
            members: records,
            extra: Default::default(),
        };
        let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
        zip.start_file(SET_MANIFEST, zip::write::FileOptions::<()>::default().unix_permissions(0o644))
            .map_err(|e| format!("zip {SET_MANIFEST}: {e}"))?;
        std::io::Write::write_all(&mut zip, &bytes).map_err(|e| format!("zip {SET_MANIFEST}: {e}"))?;
        zip.finish().map_err(|e| format!("finish set: {e}"))?;
    }
    staged.as_file_mut().sync_all().map_err(|e| e.to_string())?;
    staged
        .persist(&dest)
        .map_err(|e| format!("write {}: {e}", dest.display()))?;

    Ok(ExportSetReport {
        path: dest.to_string_lossy().to_string(),
        bytes: fs::metadata(&dest).map(|m| m.len()).unwrap_or(0),
        members,
    })
}

// ── Inspect ───────────────────────────────────────────────────────────────

/// Read a picked file — a project bundle or a project set — for the import
/// dialog, unpacking nothing.
pub fn inspect_project_bundle_blocking(bundle_path: String) -> Result<InspectedBundle, String> {
    if !is_set(&bundle_path)? {
        return inspect_bundle(bundle_path, None, &read_projects_list()?)
            .map(|info| InspectedBundle::Project { info: Box::new(info) });
    }
    let (_zip, manifest) = open_set(&bundle_path)?;
    let list = read_projects_list()?;
    let members = manifest
        .members
        .iter()
        .map(|record| {
            let read = if member_name_ok(&record.file) {
                inspect_bundle(bundle_path.clone(), Some(record.file.clone()), &list)
            } else {
                Err(format!("not a project in this set: {}", record.file))
            };
            match read {
                Ok(info) => SetMemberInfo {
                    member: record.file.clone(),
                    info: Some(info),
                    error: None,
                },
                Err(e) => SetMemberInfo {
                    member: record.file.clone(),
                    info: None,
                    error: Some(e),
                },
            }
        })
        .collect();
    Ok(InspectedBundle::Set {
        set: SetInfo {
            path: bundle_path,
            app_version: manifest.app_version,
            exported_at: manifest.exported_at,
            members,
            suggested_parent: super::projects_root().to_string_lossy().to_string(),
            suggested_mirror_parent: crate::paths::projects_ssh_root().to_string_lossy().to_string(),
        },
    })
}

/// Whether the zip at `path` is a set: it carries the set manifest and no
/// project manifest of its own. A file that is neither is left to the
/// single-bundle reader, which words that refusal.
fn is_set(path: &str) -> Result<bool, String> {
    let file = fs::File::open(path).map_err(|e| format!("open {path}: {e}"))?;
    let zip = zip::ZipArchive::new(file).map_err(|e| format!("read {path}: {e}"))?;
    let has = |wanted: &str| zip.file_names().any(|n| n.is_ok_and(|n| n == wanted));
    Ok(has(SET_MANIFEST) && !has(BUNDLE_MANIFEST))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn member_names_stay_one_level_inside_the_member_folder() {
        assert!(member_name_ok("projects/01-a.zip"));
        assert!(!member_name_ok("projects/"));
        assert!(!member_name_ok("projects/.."));
        assert!(!member_name_ok("projects/a/b.zip"));
        assert!(!member_name_ok("projects/..\\x"));
        assert!(!member_name_ok("other/a.zip"));
        assert!(!member_name_ok("projectsX/a.zip"));
        assert!(!member_name_ok(SET_MANIFEST));
    }

    #[test]
    fn member_files_are_numbered_and_sanitized() {
        assert_eq!(
            member_file(0, "My Paper"),
            format!("projects/01-{}.{BUNDLE_EXTENSION}", sanitize_name("My Paper"))
        );
        assert_eq!(member_file(11, ""), format!("projects/12-project.{BUNDLE_EXTENSION}"));
        assert!(member_name_ok(&member_file(3, "../../etc")));
    }

    #[test]
    fn a_window_reads_and_seeks_only_its_range() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("f");
        fs::write(&path, b"0123456789").unwrap();
        let mut w = FileWindow::range(fs::File::open(&path).unwrap(), 3, 4).unwrap();
        let mut out = String::new();
        w.read_to_string(&mut out).unwrap();
        assert_eq!(out, "3456");
        assert_eq!(w.seek(SeekFrom::End(-1)).unwrap(), 3);
        let mut one = [0u8; 4];
        assert_eq!(w.read(&mut one).unwrap(), 1);
        assert_eq!(&one[..1], b"6");
        assert!(w.seek(SeekFrom::Current(-10)).is_err());
        w.seek(SeekFrom::Start(1)).unwrap();
        let mut two = [0u8; 2];
        w.read_exact(&mut two).unwrap();
        assert_eq!(&two, b"45");
    }

    /// A stored zip inside a zip opens through the window exactly like the
    /// same zip as a file of its own — the one property import relies on.
    #[test]
    fn a_stored_member_reads_in_place_and_a_deflated_one_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let inner = {
            let mut buf = std::io::Cursor::new(Vec::new());
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("hello.txt", zip::write::FileOptions::<()>::default()).unwrap();
            z.write_all(b"hi there").unwrap();
            z.finish().unwrap();
            buf.into_inner()
        };
        let set = tmp.path().join("set.zip");
        {
            let mut file = fs::File::create(&set).unwrap();
            let mut z = zip::ZipWriter::new(&mut file);
            z.start_file("projects/01-a.zip", stored_options(inner.len() as u64)).unwrap();
            z.write_all(&inner).unwrap();
            z.start_file("projects/02-b.zip", zip::write::FileOptions::<()>::default()).unwrap();
            z.write_all(&inner).unwrap();
            let manifest = SetManifest {
                format: SET_FORMAT,
                app_version: "test".into(),
                exported_at: "now".into(),
                members: ["projects/01-a.zip", "projects/02-b.zip"]
                    .iter()
                    .map(|f| SetMemberRecord {
                        file: f.to_string(),
                        project_id: "x".into(),
                        name: "x".into(),
                        remote: false,
                        bytes: 0,
                    })
                    .collect(),
                extra: Default::default(),
            };
            z.start_file(SET_MANIFEST, zip::write::FileOptions::<()>::default()).unwrap();
            z.write_all(&serde_json::to_vec(&manifest).unwrap()).unwrap();
            z.finish().unwrap();
        }
        let path = set.to_str().unwrap();
        assert!(is_set(path).unwrap());

        let window = member_window(path, "projects/01-a.zip").unwrap();
        let mut archive = zip::ZipArchive::new(window).unwrap();
        let mut body = String::new();
        archive.by_name("hello.txt").unwrap().read_to_string(&mut body).unwrap();
        assert_eq!(body, "hi there");

        assert!(member_window(path, "projects/02-b.zip").unwrap_err().contains("not stored"));
        assert!(member_window(path, "projects/03-c.zip").unwrap_err().contains("not a project"));
        assert!(member_window(path, SET_MANIFEST).is_err());
    }

    #[test]
    fn a_newer_set_format_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let set = tmp.path().join("set.zip");
        {
            let mut file = fs::File::create(&set).unwrap();
            let mut z = zip::ZipWriter::new(&mut file);
            z.start_file(SET_MANIFEST, zip::write::FileOptions::<()>::default()).unwrap();
            z.write_all(br#"{"format":99,"appVersion":"9","exportedAt":"x","members":[]}"#).unwrap();
            z.finish().unwrap();
        }
        let err = open_set(set.to_str().unwrap()).unwrap_err();
        assert!(err.contains("newer"), "{err}");
    }
}
