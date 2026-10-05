use crate::schema::settings::WindowState;
use crate::schema::Settings;
use crate::storage;
use serde_json::{Map, Value};

#[tauri::command]
pub fn get_settings() -> Result<Settings, String> {
    let path = storage::state_dir().join("settings.json");
    let mut settings = if path.exists() {
        storage::read_json(&path).map_err(|e| e.to_string())?
    } else {
        Settings::default()
    };
    // Seed platform-appropriate global apps when none are configured. The
    // global-app toolbar only renders roles that have an entry, so a fresh
    // install (no `global_apps` in settings.json) shows an empty bar. On Linux
    // these were historically seeded by the legacy app; on Windows nothing
    // populated them, leaving the toolbar blank. Detection runs at read time and
    // is not persisted, so the bar appears immediately; the first edit in the
    // Global Apps settings panel writes the merged set back to disk.
    seed_default_global_apps(&mut settings);
    Ok(settings)
}

fn seed_default_global_apps(settings: &mut Settings) {
    if settings
        .global_apps
        .as_ref()
        .is_none_or(|apps| apps.is_empty())
    {
        if let Some(defaults) = default_global_apps() {
            settings.global_apps = Some(defaults);
        }
    }
}

/// What the whole-document save is told when the file moved on since the
/// caller loaded it.
pub const SETTINGS_STALE: &str =
    "settings changed on disk since they were loaded; reload and apply the edit again";

/// The whole-document save — compare-and-swap on the file's `rev` (headless
/// owner plan, H1): refused when the file moved on since `settings` was
/// loaded, so a patch another window or the Mobile sidecar landed in between
/// is never erased. The frontend only reaches this as a fallback for a
/// backend without `patch_settings`.
#[tauri::command]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    save_settings_at(&storage::state_dir().join("settings.json"), settings)
}

fn save_settings_at(path: &std::path::Path, settings: Settings) -> Result<(), String> {
    let mut previous = None;
    let saved = storage::patch_json(path, Settings::default(), |current| {
        if settings.rev != current.rev {
            return Err(SETTINGS_STALE.to_string());
        }
        previous = Some(current.clone());
        let rev = current.rev + 1;
        *current = settings.clone();
        current.rev = rev;
        Ok(current.clone())
    })?;
    if let Some(previous) = previous {
        invalidate_copilot(&previous, &saved);
    }
    Ok(())
}

/// Atomically merge a frontend settings patch against the latest file.
///
/// Every webview has its own JS heap and therefore its own settings cache. A
/// frontend read followed by `save_settings` is two independent transactions:
/// another window can commit between them and have its unrelated change
/// overwritten by the stale whole object. This command keeps read + shallow
/// merge + write under `storage`'s process-wide JSON mutation lock and returns
/// the exact object that won, so every sender can broadcast the same snapshot.
#[tauri::command]
pub fn patch_settings(patch: Map<String, Value>) -> Result<Settings, String> {
    patch_settings_at(&storage::state_dir().join("settings.json"), patch)
}

fn patch_settings_at(path: &std::path::Path, mut patch: Map<String, Value>) -> Result<Settings, String> {
    // The revision is the file's to move, never a caller's to set: a patch
    // built by spreading a cached object carries the old one.
    patch.remove("rev");
    let mut previous = None;
    let saved = storage::patch_json(path, Settings::default(), |settings| {
        seed_default_global_apps(settings);
        previous = Some(settings.clone());
        merge_settings_patch(settings, patch)?;
        settings.rev += 1;
        Ok(settings.clone())
    })?;
    if let Some(previous) = previous { invalidate_copilot(&previous, &saved); }
    Ok(saved)
}

fn invalidate_copilot(previous: &Settings, next: &Settings) {
    if previous.code_completion_provider != next.code_completion_provider
        || previous.completion_project_policies != next.completion_project_policies
        || previous.copilot_completion.unwrap_or(previous.debug.unwrap_or(false))
            != next.copilot_completion.unwrap_or(next.debug.unwrap_or(false)) {
        crate::services::copilot::session::sessions().stop_all_now();
    }
}

fn merge_settings_patch(settings: &mut Settings, patch: Map<String, Value>) -> Result<(), String> {
    let mut value = serde_json::to_value(&*settings).map_err(|e| e.to_string())?;
    let current = value
        .as_object_mut()
        .ok_or_else(|| "settings must serialize as an object".to_string())?;
    current.extend(patch);
    *settings = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist only the main window's geometry, leaving every other setting on disk
/// untouched.
///
/// Kept as a dedicated patch because this fires on a debounce every time the
/// user drags or resizes the main window; it must never replace unrelated keys.
#[tauri::command]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    let path = storage::state_dir().join("settings.json");
    storage::patch_json(&path, Settings::default(), |settings| {
        settings.window_state = Some(state);
        settings.rev += 1;
        Ok(())
    })
}

/// Detect installed apps for the global-app toolbar roles on the current
/// platform. Only roles whose executable actually resolves are returned, so the
/// seeded buttons always launch something. Returns `None` when nothing is
/// detected (e.g. unsupported platform), leaving the toolbar empty as before.
fn default_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    #[cfg(target_os = "windows")]
    {
        detect_windows_global_apps()
    }
    #[cfg(target_os = "macos")]
    {
        detect_macos_global_apps()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        detect_linux_global_apps()
    }
}

/// Seed the global-app toolbar with common Linux desktop apps for the shared
/// roles. Unlike Windows/macOS, a Linux app has no fixed install path, so each
/// candidate is a binary name resolved via `PATH` (`crate::paths::resolve_executable`,
/// which already covers the GUI-launched-process PATH gap). Mail, calendar,
/// file-manager, system-monitor, notes and media-player roles are deliberately
/// absent, for the same reason as the other two platforms: Tabtivity has its own
/// of each. There is no app guaranteed present on every distro, so — unlike
/// macOS (Safari) — the toolbar can still come back empty on a minimal
/// install; a role can always be set by hand in the Global Apps settings panel.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect_linux_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate binary names on PATH (first found wins).
    let candidates: [(&str, &[&str]); 4] = [
        (
            "browser",
            &[
                "firefox",
                "google-chrome",
                "chromium-browser",
                "chromium",
                "brave-browser",
            ],
        ),
        ("password_manager", &["keepassxc", "bitwarden", "keepassx"]),
        (
            "screenshot",
            &[
                "spectacle",
                "flameshot",
                "gnome-screenshot",
                "ksnip",
                "shutter",
                "xfce4-screenshooter",
                "scrot",
                "maim",
            ],
        ),
        (
            "screen_recorder",
            &["kazam", "simplescreenrecorder", "vokoscreen", "peek", "obs"],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, bins)| {
            bins.iter()
                .find_map(|bin| crate::paths::resolve_executable(bin))
                .map(|path| {
                    (
                        role.to_string(),
                        GlobalAppEntry {
                            exec: path.to_string_lossy().to_string(),
                            visible: true,
                            extra: HashMap::new(),
                        },
                    )
                })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

/// First existing path among `candidates`, or `None`. Used to pick the
/// best-available executable for a role across install locations.
#[cfg(any(target_os = "windows", target_os = "macos"))]
fn first_existing(candidates: &[String]) -> Option<String> {
    candidates
        .iter()
        .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
        .cloned()
}

/// Build a `\\`-joined path under an environment-variable-rooted directory,
/// returning an empty string when the variable is unset so the candidate is
/// skipped by [`first_existing`].
#[cfg(target_os = "windows")]
fn env_join(var: &str, tail: &str) -> String {
    match std::env::var(var) {
        Ok(root) if !root.is_empty() => format!("{root}\\{tail}"),
        _ => String::new(),
    }
}

/// Probe well-known install locations for the common global-app roles on
/// Windows. Every role is included only when found, so the toolbar can come
/// back empty. Mail, calendar, file-manager, system-monitor, notes and
/// media-player roles are deliberately absent: Tabtivity has its own of each (the
/// Monitor tab, the editable file viewers, the in-tab media viewer), so seeding
/// an external app for them only offered a second, worse copy.
#[cfg(target_os = "windows")]
fn detect_windows_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 3] = [
        (
            "browser",
            vec![
                env_join("ProgramFiles", "Google\\Chrome\\Application\\chrome.exe"),
                env_join(
                    "ProgramFiles(x86)",
                    "Google\\Chrome\\Application\\chrome.exe",
                ),
                env_join("ProgramFiles", "Mozilla Firefox\\firefox.exe"),
                env_join("ProgramFiles(x86)", "Mozilla Firefox\\firefox.exe"),
                env_join(
                    "ProgramFiles(x86)",
                    "Microsoft\\Edge\\Application\\msedge.exe",
                ),
                env_join("ProgramFiles", "Microsoft\\Edge\\Application\\msedge.exe"),
            ],
        ),
        (
            "screenshot",
            vec![env_join("WINDIR", "System32\\SnippingTool.exe")],
        ),
        (
            "password_manager",
            vec![
                env_join("ProgramFiles", "KeePassXC\\KeePassXC.exe"),
                env_join("ProgramFiles(x86)", "KeePass Password Safe 2\\KeePass.exe"),
            ],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, paths)| {
            first_existing(&paths).map(|exec| {
                (
                    role.to_string(),
                    GlobalAppEntry {
                        exec,
                        visible: true,
                        extra: HashMap::new(),
                    },
                )
            })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

/// Seed the global-app toolbar with stock macOS apps for the common roles. Each
/// `exec` points at the launchable binary inside the bundle's `Contents/MacOS/`
/// (not the `.app` path) so the existing `Command::new(exec)` launch path works.
/// Roles whose app is absent (e.g. iTerm) are skipped; the toolbar is never empty
/// on a stock install since Safari is always present. Mail, calendar,
/// file-manager, system-monitor, notes and media-player roles are deliberately
/// absent — Tabtivity has its own of each (the Monitor tab, the editable file
/// viewers, the in-tab media viewer), so seeding Mail/Finder/Activity Monitor/
/// Notes/QuickTime here only offered a second, worse copy.
#[cfg(target_os = "macos")]
fn detect_macos_global_apps(
) -> Option<std::collections::HashMap<String, crate::schema::settings::GlobalAppEntry>> {
    use crate::schema::settings::GlobalAppEntry;
    use std::collections::HashMap;

    // role -> ordered candidate executable paths (first existing wins).
    let candidates: [(&str, Vec<String>); 2] = [
        (
            "browser",
            vec![
                "/Applications/Safari.app/Contents/MacOS/Safari".to_string(),
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".to_string(),
                "/Applications/Firefox.app/Contents/MacOS/firefox".to_string(),
            ],
        ),
        (
            "screenshot",
            vec![
                "/System/Applications/Utilities/Screenshot.app/Contents/MacOS/Screenshot"
                    .to_string(),
            ],
        ),
    ];

    let detected: HashMap<String, GlobalAppEntry> = candidates
        .into_iter()
        .filter_map(|(role, paths)| {
            first_existing(&paths).map(|exec| {
                (
                    role.to_string(),
                    GlobalAppEntry {
                        exec,
                        visible: true,
                        extra: HashMap::new(),
                    },
                )
            })
        })
        .collect();

    if detected.is_empty() {
        None
    } else {
        Some(detected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patch_is_shallow_and_preserves_unrelated_fields() {
        let mut settings = Settings {
            color_scheme: Some("fancy_dark".into()),
            language: Some("de".into()),
            ..Settings::default()
        };
        let patch = serde_json::from_value::<Map<String, Value>>(serde_json::json!({
            "color_scheme": "soft_dark",
            "files_alerts_muted": ["one"]
        }))
        .unwrap();

        merge_settings_patch(&mut settings, patch).unwrap();

        assert_eq!(settings.color_scheme.as_deref(), Some("soft_dark"));
        assert_eq!(settings.language.as_deref(), Some("de"));
        assert_eq!(settings.files_alerts_muted, Some(vec!["one".into()]));
    }

    /// Headless owner plan, H1: every write moves the file's revision; the
    /// whole-document save must carry the one it loaded and is refused
    /// otherwise, so a patch landed in between survives it.
    #[test]
    fn whole_document_save_is_compare_and_swap_and_patches_move_the_revision() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let patch = |json: Value| serde_json::from_value::<Map<String, Value>>(json).unwrap();

        let first = patch_settings_at(&path, patch(serde_json::json!({"language": "de"}))).unwrap();
        assert_eq!(first.rev, 1);
        let loaded: Settings = storage::read_json(&path).unwrap();
        assert_eq!((loaded.rev, loaded.language.as_deref()), (1, Some("de")));

        // Another window patches the theme in between.
        let second = patch_settings_at(&path, patch(serde_json::json!({"color_scheme": "soft_dark", "rev": 40}))).unwrap();
        assert_eq!(second.rev, 2, "a caller's rev in a patch is ignored");

        // The stale whole document is refused and the theme patch survives.
        let mut stale = loaded.clone();
        stale.language = Some("fr".into());
        assert_eq!(save_settings_at(&path, stale).unwrap_err(), SETTINGS_STALE);
        let kept: Settings = storage::read_json(&path).unwrap();
        assert_eq!(kept.color_scheme.as_deref(), Some("soft_dark"));
        assert_eq!(kept.language.as_deref(), Some("de"));

        // Reloaded and re-applied, it lands and moves the revision again.
        let mut fresh: Settings = storage::read_json(&path).unwrap();
        fresh.language = Some("fr".into());
        save_settings_at(&path, fresh).unwrap();
        let done: Settings = storage::read_json(&path).unwrap();
        assert_eq!((done.rev, done.language.as_deref(), done.color_scheme.as_deref()), (3, Some("fr"), Some("soft_dark")));

        // A file written before revisions is revision 0 and takes a whole
        // document that says so.
        let legacy = dir.path().join("old.json");
        std::fs::write(&legacy, r#"{"language":"it"}"#).unwrap();
        let loaded: Settings = storage::read_json(&legacy).unwrap();
        assert_eq!(loaded.rev, 0);
        save_settings_at(&legacy, loaded).unwrap();
        assert_eq!(storage::read_json::<Settings>(&legacy).unwrap().rev, 1);
    }
}
