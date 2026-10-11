//! "Open in <IDE>": the project opened in the IDE its tree carries markers
//! for. Detection and launcher resolution are `services::ide_detect`; this
//! layer maps a project id to the directory that is scanned, launches through
//! the shared window registry (`commands::apps::do_launch`) and edits the
//! per-IDE override in `settings.json`.
//!
//! The directory always comes from the trusted `projects.json` — the frontend
//! sends a project id, never a path — and for a remote project it is the local
//! lockstep mirror (the same folder the pill's "Show on disk" reveals), so no
//! SSH probe runs and nothing here needs a connected session.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use crate::commands::apps::{
    do_launch, list_installed_apps, run_off_thread, TrackedWindow, WindowRegistryState,
    ORIGIN_PROJECT_IDE,
};
use crate::schema::Settings;
use crate::services::ide_detect::{self, Detected, HostProbe, IdeId, Launcher};
use crate::storage;

/// One IDE the project offers, with the program that would open it when one
/// was found. `exec` is `None` when nothing is installed for it (nor for any
/// stand-in); the frontend then offers to pick an executable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdeCandidate {
    pub id: IdeId,
    pub family: &'static str,
    /// The detected IDE's product name.
    pub label: &'static str,
    /// The marker that identified it, relative to the project dir.
    pub marker_path: String,
    /// What the launcher is handed (dir, `.sln` or `.code-workspace`).
    pub target: String,
    pub exec: Option<String>,
    /// The launcher's name — the detected IDE's, or the stand-in's when
    /// another IDE opens it (`Rider` for a `.sln` without Visual Studio).
    pub display_name: Option<String>,
    pub source: Option<ide_detect::LauncherSource>,
    /// True when `exec` comes from `settings.ide_launchers`, so the menu can
    /// offer "use the detected one" instead of "choose".
    pub overridden: bool,
}

/// The directory a project's markers are read from: its tree for a local
/// project, its local mirror for a remote one — only when that mirror exists,
/// because there is nothing to open otherwise.
fn project_root(project_id: &str) -> Result<PathBuf, String> {
    let dir = if crate::services::remote::remote_target_for(project_id).is_some() {
        crate::services::remote_sync::mirror_dir(project_id)
    } else {
        PathBuf::from(
            crate::services::remote::project_directory(project_id)
                .ok_or_else(|| format!("unknown project {project_id}"))?,
        )
    };
    if !dir.is_dir() {
        return Err(format!("project folder not found: {}", dir.display()));
    }
    Ok(dir)
}

fn ide_overrides() -> HashMap<String, String> {
    let path = storage::state_dir().join("settings.json");
    storage::read_json::<Settings>(&path)
        .ok()
        .and_then(|s| s.ide_launchers)
        .unwrap_or_default()
}

/// A detection paired with the program that would open it, if any.
struct Candidate {
    detected: Detected,
    launcher: Option<Launcher>,
}

fn candidates(project_id: &str) -> Result<(PathBuf, Vec<Candidate>), String> {
    let dir = project_root(project_id)?;
    let detected = ide_detect::detect(&dir);
    if detected.is_empty() {
        return Ok((dir, Vec::new()));
    }
    let overrides = ide_overrides();
    let installed = list_installed_apps();
    let probe = HostProbe::real();
    let resolved = detected
        .into_iter()
        .map(|detected| Candidate {
            launcher: ide_detect::resolve_launcher(detected.ide, &overrides, &installed, &probe),
            detected,
        })
        .collect();
    Ok((dir, resolved))
}

/// The IDEs `project_id`'s tree carries markers for, each with its resolved
/// launcher. Cheap (one top-level listing plus a few `exists` checks), so the
/// menus call it on open rather than caching.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn detect_project_ides(project_id: String) -> Result<Vec<IdeCandidate>, String> {
    run_off_thread(move || {
        let (dir, found) = candidates(&project_id)?;
        Ok(found
            .into_iter()
            .map(|Candidate { detected: d, launcher }| {
                let target = launcher
                    .as_ref()
                    .map(|l| l.target_for(&d, &dir))
                    .unwrap_or_else(|| d.target.clone());
                IdeCandidate {
                    id: d.ide,
                    family: d.ide.family(),
                    label: d.ide.label(),
                    marker_path: d.marker.to_string_lossy().into_owned(),
                    target: target.to_string_lossy().into_owned(),
                    overridden: launcher
                        .as_ref()
                        .is_some_and(|l| l.source == ide_detect::LauncherSource::Override),
                    exec: launcher.as_ref().map(|l| l.exec.clone()),
                    display_name: launcher.as_ref().map(|l| l.display_name.clone()),
                    source: launcher.as_ref().map(|l| l.source),
                }
            })
            .collect())
    })
    .await
}

/// Launch `ide_id` on the project. Detection runs again here — the frontend's
/// list is a display, never the thing that is executed — and the window is
/// tracked with [`ORIGIN_PROJECT_IDE`].
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn open_project_in_ide(
    registry: State<'_, WindowRegistryState>,
    project_id: String,
    ide_id: String,
) -> Result<TrackedWindow, String> {
    let registry = registry.inner().clone();
    run_off_thread(move || {
        let ide = IdeId::parse(&ide_id).ok_or_else(|| format!("unknown IDE {ide_id}"))?;
        let (dir, found) = candidates(&project_id)?;
        let Candidate { detected, launcher } = found
            .into_iter()
            .find(|c| c.detected.ide == ide)
            .ok_or_else(|| format!("{} is not set up for {}", project_id, ide.label()))?;
        let launcher = launcher.ok_or_else(|| format!("{} is not installed", ide.label()))?;
        let target = launcher.target_for(&detected, &dir);
        do_launch(
            &registry,
            &launcher.exec,
            &[],
            Some(&target.to_string_lossy()),
            Some(&project_id),
            Some("ide"),
            ORIGIN_PROJECT_IDE,
        )
    })
    .await
}

/// Set (or, with `None`/blank, clear) the user's program for `ide_id`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn set_ide_launcher(ide_id: String, exec: Option<String>) -> Result<(), String> {
    IdeId::parse(&ide_id).ok_or_else(|| format!("unknown IDE {ide_id}"))?;
    let exec = exec.map(|e| e.trim().to_string()).filter(|e| !e.is_empty());
    let path = storage::state_dir().join("settings.json");
    storage::patch_json(&path, Settings::default(), |settings| {
        let mut map = settings.ide_launchers.take().unwrap_or_default();
        match exec {
            Some(exec) => {
                map.insert(ide_id, exec);
            }
            None => {
                map.remove(&ide_id);
            }
        }
        settings.ide_launchers = (!map.is_empty()).then_some(map);
        Ok(())
    })
}
