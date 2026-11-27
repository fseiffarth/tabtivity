use crate::schema::settings::WindowState;
use crate::schema::Settings;
use crate::storage;
use serde_json::{Map, Value};

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn get_settings() -> Result<Settings, String> {
    let path = storage::settings_path();
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
    // An old build's plaintext git token stays on the backend until it is
    // migrated to the keyring (`git_hosting::migrate_legacy_token`).
    settings.git_token = None;
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_settings(settings: Settings) -> Result<(), String> {
    save_settings_at(&storage::settings_path(), settings)
}

fn save_settings_at(path: &std::path::Path, settings: Settings) -> Result<(), String> {
    let mut previous = None;
    let saved = storage::patch_json(path, Settings::default(), |current| {
        if settings.rev != current.rev {
            return Err(SETTINGS_STALE.to_string());
        }
        previous = Some(current.clone());
        let rev = current.rev + 1;
        let git_token = current.git_token.take();
        let endpoints = current.agent_api_custom_endpoints.take();
        *current = settings.clone();
        current.rev = rev;
        // Never the renderer's to write: it is never sent one (`get_settings`).
        current.git_token = git_token;
        // Where a saved API key goes is the add/remove commands' to say.
        current.agent_api_custom_endpoints = endpoints;
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn patch_settings(patch: Map<String, Value>) -> Result<Settings, String> {
    patch_settings_at(&storage::settings_path(), patch)
}

fn patch_settings_at(path: &std::path::Path, mut patch: Map<String, Value>) -> Result<Settings, String> {
    // The revision is the file's to move, never a caller's to set: a patch
    // built by spreading a cached object carries the old one.
    patch.remove("rev");
    // Tokens go to the keyring through `set_git_hosts`, never into this file.
    patch.remove("git_token");
    // A custom endpoint's address is where its saved API key is sent: only
    // `agent_api_custom_endpoint_add`/`_remove`/`_refresh_models` change the
    // list, never a patch (a paired browser can send one too).
    patch.remove("agent_api_custom_endpoints");
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
    use crate::services::copilot::{credentials, session::sessions};
    if copilot_invalidated(previous, next) {
        sessions().stop_all_now();
    }
    // "Stay signed in" switched: on keeps a live sign-in's token now, off
    // deletes the entry. Off the settings write: the keychain may block.
    if let Some(on) = stay_signed_in_switched(previous, next) {
        app_core::rt::spawn(async move {
            let running = sessions().all_running();
            if let Err(error) = credentials::setting_changed(on, &running, &credentials::keychain()).await {
                eprintln!("copilot: stay signed in: {error}");
            }
        });
    }
}

/// The new value of `copilot_stay_signed_in` when a write switched it. Pure.
fn stay_signed_in_switched(previous: &Settings, next: &Settings) -> Option<bool> {
    let (was, is) = (previous.copilot_stay_signed_in.unwrap_or(false), next.copilot_stay_signed_in.unwrap_or(false));
    (was != is).then_some(is)
}

/// Whether a settings write must stop every Copilot server: the provider,
/// consent or flag changed, or the AI switch just turned off (a server is a
/// network-capable process holding a signed-in session). Editor tuning such
/// as `autocomplete_delay_ms` is not among them. Pure + tested.
fn copilot_invalidated(previous: &Settings, next: &Settings) -> bool {
    use crate::services::ai_switch::off_now;
    previous.code_completion_provider != next.code_completion_provider
        || previous.completion_project_policies != next.completion_project_policies
        || previous.copilot_completion() != next.copilot_completion()
        || (!off_now(previous.ai_off, previous.ai_off_until) && off_now(next.ai_off, next.ai_off_until))
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
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn save_window_state(state: WindowState) -> Result<(), String> {
    let path = storage::settings_path();
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

    /// B9: switching AI off stops every Copilot server; switching it back on,
    /// or tuning the editor's delay, stops none.
    #[test]
    fn the_ai_switch_turning_off_stops_copilot_and_editor_tuning_does_not() {
        let on = Settings::default();
        let off = Settings { ai_off: Some(true), ..Settings::default() };
        assert!(copilot_invalidated(&on, &off));
        assert!(!copilot_invalidated(&off, &on));
        assert!(!copilot_invalidated(&off, &off.clone()));
        // A switch whose "off for a while" already passed is on: no change.
        let lapsed = Settings { ai_off: Some(true), ai_off_until: Some(1), ..Settings::default() };
        assert!(!copilot_invalidated(&on, &lapsed));
        let tuned = Settings {
            autocomplete_delay_ms: Some(crate::schema::settings::AutocompleteDelays { ollama: Some(400), copilot: Some(100), ..Default::default() }),
            ..Settings::default()
        };
        assert!(!copilot_invalidated(&on, &tuned));
        assert!(!copilot_invalidated(&tuned, &on));
        let provider = Settings { code_completion_provider: Some("copilot".into()), ..Settings::default() };
        assert!(copilot_invalidated(&on, &provider));
    }

    /// B11: only a switch of "Stay signed in" acts on the keychain, and it
    /// stops no server.
    #[test]
    fn stay_signed_in_acts_only_when_it_switches() {
        let unset = Settings::default();
        let on = Settings { copilot_stay_signed_in: Some(true), ..Settings::default() };
        let off = Settings { copilot_stay_signed_in: Some(false), ..Settings::default() };
        assert_eq!(stay_signed_in_switched(&unset, &on), Some(true));
        assert_eq!(stay_signed_in_switched(&on, &off), Some(false));
        assert_eq!(stay_signed_in_switched(&on, &unset), Some(false));
        assert_eq!(stay_signed_in_switched(&unset, &off), None, "unset is off");
        assert_eq!(stay_signed_in_switched(&on, &on.clone()), None);
        assert!(!copilot_invalidated(&unset, &on));
    }

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

    /// The frontend sends a cleared key (`undefined`, "back to the default") as
    /// `null`; the merge must reset it rather than keep the old value.
    #[test]
    fn a_null_in_a_settings_patch_clears_the_field() {
        let mut settings = Settings { ui_zoom: Some(1.5), ..Settings::default() };
        let patch = serde_json::from_value::<Map<String, Value>>(serde_json::json!({ "ui_zoom": null }))
            .unwrap();

        merge_settings_patch(&mut settings, patch).unwrap();

        assert_eq!(settings.ui_zoom, None);
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

    /// The old plaintext git token is the backend's alone: a patch cannot set
    /// it, and a whole-document save (whose renderer never saw it) keeps it.
    #[test]
    fn the_old_git_token_is_never_written_from_the_renderer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, r#"{"git_token":"old-plaintext"}"#).unwrap();
        let patch = serde_json::from_value::<Map<String, Value>>(serde_json::json!({"git_token": "from-renderer"})).unwrap();
        patch_settings_at(&path, patch).unwrap();
        let mut loaded: Settings = storage::read_json(&path).unwrap();
        assert_eq!(loaded.git_token.as_deref(), Some("old-plaintext"));
        loaded.git_token = None;
        save_settings_at(&path, loaded).unwrap();
        assert_eq!(storage::read_json::<Settings>(&path).unwrap().git_token.as_deref(), Some("old-plaintext"));
    }

    /// Where a custom endpoint's key is sent is not a setting a patch or a
    /// whole-document save can change: the key would go to the new address.
    #[test]
    fn a_patch_or_a_save_cannot_retarget_a_custom_endpoint() {
        use crate::schema::settings::CustomEndpoint;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let endpoint = |url: &str| CustomEndpoint { slot: 1, label: "Lab".into(), base_url: url.into(), models: vec!["m".into()] };
        let ours = endpoint("https://llm.example.org/v1");
        let start = Settings { agent_api_custom_endpoints: Some(vec![ours.clone()]), ..Settings::default() };
        storage::write_json(&path, &start).unwrap();
        let theirs = serde_json::to_value(vec![endpoint("https://llm.example.com/v1")]).unwrap();
        let patch = serde_json::from_value::<Map<String, Value>>(serde_json::json!({"agent_api_custom_endpoints": theirs, "language": "de"})).unwrap();
        let saved = patch_settings_at(&path, patch).unwrap();
        assert_eq!(saved.language.as_deref(), Some("de"), "the rest of the patch lands");
        assert_eq!(saved.agent_api_custom_endpoints, Some(vec![ours.clone()]));
        let mut whole = storage::read_json::<Settings>(&path).unwrap();
        whole.agent_api_custom_endpoints = Some(vec![endpoint("https://llm.example.com/v1")]);
        save_settings_at(&path, whole).unwrap();
        assert_eq!(storage::read_json::<Settings>(&path).unwrap().agent_api_custom_endpoints, Some(vec![ours]));
    }

    /// The Mobile host block round-trips every key through a patch: the phone
    /// upload switch, the browser-access switch, and a key only a newer build
    /// knows. Before these were named (or caught by `extra`), the patch that
    /// set one erased it again.
    #[test]
    fn mobile_host_switches_and_unknown_keys_survive_a_patch() {
        let key = crate::brand::MOBILE_HOST_KEY;
        let host = serde_json::json!({
            "enabled": true,
            "project_files": true,
            "project_uploads": true,
            "browser_client": true,
            "linked_desktops": ["https://laptop.example.ts.net"],
            "some_future_switch": {"a": [1, 2]}
        });
        let mut settings = Settings::default();
        let patch = |json: Value| serde_json::from_value::<Map<String, Value>>(json).unwrap();
        merge_settings_patch(&mut settings, patch(serde_json::json!({ key: host.clone() }))).unwrap();
        let typed = settings.app_mobile_host.as_ref().unwrap();
        assert_eq!(typed.project_uploads, Some(true));
        assert_eq!(typed.browser_client, Some(true));
        assert_eq!(typed.linked_desktops.as_deref(), Some(&["https://laptop.example.ts.net".to_string()][..]));

        // An unrelated patch, then a write → read through the file shape.
        merge_settings_patch(&mut settings, patch(serde_json::json!({"language": "de"}))).unwrap();
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(written[key], host, "the whole block survives");
        let back: Settings = serde_json::from_value(written).unwrap();
        assert_eq!(serde_json::to_value(&back).unwrap()[key], host);

        // Unset stays unset (the switch is off by default).
        merge_settings_patch(&mut settings, patch(serde_json::json!({ key: {"enabled": true} }))).unwrap();
        let written = serde_json::to_value(&settings).unwrap();
        assert_eq!(written[key], serde_json::json!({"enabled": true}));
    }
}
