use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

/// The load error meaning "not misconfigured — turned off". The sidecar's
/// entry point exits *cleanly* on it, so `Restart=on-failure` does not spin an
/// enabled unit forever against a deliberately disabled configuration.
///
/// It is returned for **one** condition only: a settings file that was read and
/// parsed and says `enabled: false`. Everything else about reading that file is
/// a [`SETTINGS_UNREADABLE_ERROR`], because the two need opposite exit codes and
/// used to share one — see [`HostConfig::load`].
pub const DISABLED_ERROR: &str = concat!(crate::app_name!(), " Mobile is disabled");

/// The load error meaning "the settings file could not be read or parsed".
///
/// This is deliberately **not** [`DISABLED_ERROR`]: the sidecar exits non-zero
/// on it so `Restart=on-failure` keeps retrying, because every cause here can
/// heal on its own (the desktop rewrites `settings.json` atomically on the next
/// settings change, and a transient read error is over by the next attempt),
/// whereas a clean exit would take Mobile down until somebody noticed and
/// pressed Reconnect.
pub const SETTINGS_UNREADABLE_ERROR: &str = concat!(crate::app_name!(), " Mobile settings could not be read");

#[derive(Debug, Clone, Deserialize)]
pub struct MobileHostSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_name")]
    pub display_name: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub serve_origin: Option<String>,
    /// Keep running when Tabtivity quits (Settings → Mobile, default off).
    #[serde(default)]
    pub stay_after_quit: Option<bool>,
}

fn default_name() -> String {
    "Workstation".into()
}
fn default_port() -> u16 {
    8742
}

impl Default for MobileHostSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            display_name: default_name(),
            port: default_port(),
            serve_origin: None,
            stay_after_quit: None,
        }
    }
}

#[derive(Deserialize, Default)]
struct SettingsFile {
    // brand-check: allow — a serde key must be a literal; a test pins it to brand::MOBILE_HOST_KEY
    #[serde(default, rename = "tabtivity_mobile_host")]
    app_mobile_host: Option<MobileHostSettings>,
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub state_dir: PathBuf,
    pub control_dir: PathBuf,
    pub host: MobileHostSettings,
    pub origin: String,
}

pub fn validate_origin(raw: &str) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Mobile origin must be a valid HTTPS origin")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Mobile origin must be one exact HTTPS origin with no path, credentials, query, or fragment".into());
    }
    let mut origin = format!("https://{}", url.host_str().unwrap_or_default());
    if let Some(port) = url.port() {
        origin.push_str(&format!(":{port}"));
    }
    Ok(origin)
}

/// The Tailscale CLI to run. PATH first; then the CLI the platform's own
/// Tailscale app ships where PATH does not reach it — the macOS App Store /
/// standalone app bundles its CLI inside `Tailscale.app` and adds nothing to a
/// GUI app's PATH, and a Windows install made after Tabtivity started is on the
/// machine but not yet on this process's PATH (the MiKTeX/Codex gap `paths`
/// already covers). Falls back to the bare name so the spawn error stays the
/// ordinary "not installed" one.
fn tailscale_program_for(
    os: crate::paths::OsKind,
    on_path: bool,
    program_files: Option<&std::ffi::OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> PathBuf {
    if on_path {
        return PathBuf::from("tailscale");
    }
    let bundled = match os {
        crate::paths::OsKind::Macos => {
            Some(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"))
        }
        crate::paths::OsKind::Windows => program_files
            .map(|pf| PathBuf::from(pf).join("Tailscale").join("tailscale.exe")),
        crate::paths::OsKind::Unix => None,
    };
    bundled
        .filter(|path| exists(path))
        .unwrap_or_else(|| PathBuf::from("tailscale"))
}

fn tailscale_program() -> PathBuf {
    tailscale_program_for(
        crate::paths::OsKind::current(),
        crate::paths::binary_on_path("tailscale"),
        std::env::var_os("ProgramFiles").as_deref(),
        |path| path.is_file(),
    )
}

pub fn serve_status_json() -> Result<serde_json::Value, String> {
    let output = crate::paths::command_no_window(tailscale_program())
        .args(["serve", "status", "--json"])
        .output()
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                "Tailscale is not installed".to_string()
            } else {
                error.to_string()
            }
        })?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|_| "Tailscale returned invalid Serve status JSON".into())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DetectedServeSettings {
    pub display_name: String,
    pub port: u16,
    pub origin: String,
}

/// Find the one private HTTPS root handler that points at Tabtivity's supported
/// loopback listener shape. Detection is deliberately as strict as activation:
/// a Funnel, non-root handler, non-loopback proxy, or ambiguous set is never
/// turned into settings merely because it appeared in Tailscale's JSON.
pub fn detect_serve_settings_json(
    status: &serde_json::Value,
) -> Result<DetectedServeSettings, String> {
    let mut candidates = Vec::new();
    let Some(web) = status.get("Web").and_then(serde_json::Value::as_object) else {
        return Err("Tailscale Serve has no HTTPS web mappings".into());
    };

    for (authority, server) in web {
        let Some(proxy) = server
            .get("Handlers")
            .and_then(|handlers| handlers.get("/"))
            .and_then(|handler| handler.get("Proxy"))
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Ok(target) = url::Url::parse(proxy) else {
            continue;
        };
        if target.scheme() != "http"
            || target.host_str() != Some("127.0.0.1")
            || !target.username().is_empty()
            || target.password().is_some()
            || target.path() != "/"
            || target.query().is_some()
            || target.fragment().is_some()
        {
            continue;
        }
        let Some(port) = target.port() else {
            continue;
        };
        if !(1024..=65535).contains(&port) {
            continue;
        }

        let raw_origin = format!("https://{authority}");
        let Ok(origin) = validate_origin(&raw_origin) else {
            continue;
        };
        let Ok(origin_url) = url::Url::parse(&origin) else {
            continue;
        };
        let Some(host) = origin_url.host_str() else {
            continue;
        };
        let Some(public_port) = origin_url.port_or_known_default() else {
            continue;
        };
        if status
            .pointer(&format!("/TCP/{public_port}/HTTPS"))
            .and_then(serde_json::Value::as_bool)
            != Some(true)
            || status
                .get("AllowFunnel")
                .and_then(|funnel| funnel.get(authority))
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        {
            continue;
        }

        let display_name = host.split('.').next().unwrap_or_default().trim();
        if display_name.is_empty() || display_name.len() > 64 {
            continue;
        }
        candidates.push(DetectedServeSettings {
            display_name: display_name.into(),
            port,
            origin,
        });
    }

    candidates.sort_by(|a, b| a.origin.cmp(&b.origin).then(a.port.cmp(&b.port)));
    candidates.dedup();
    match candidates.len() {
        1 => Ok(candidates.remove(0)),
        0 => Err("No private HTTPS root handler proxies to http://127.0.0.1:<port>".into()),
        _ => Err(concat!("Multiple eligible Tailscale Serve mappings were found; keep only the ", crate::app_name!(), " root mapping before detecting settings").into()),
    }
}

pub fn verify_serve_json(
    status: &serde_json::Value,
    origin: &str,
    port: u16,
) -> Result<(), String> {
    let origin = validate_origin(origin)?;
    let url = url::Url::parse(&origin).map_err(|_| "Invalid Serve origin")?;
    let host = url.host_str().ok_or("Invalid Serve origin")?;
    let public_port = url
        .port_or_known_default()
        .ok_or("Invalid Serve origin port")?;
    let authority = format!("{host}:{public_port}");
    let target = format!("http://127.0.0.1:{port}");

    let https = status
        .pointer(&format!("/TCP/{public_port}/HTTPS"))
        .and_then(serde_json::Value::as_bool);
    if https != Some(true) {
        return Err(format!(
            "Tailscale Serve has no HTTPS listener for {authority}"
        ));
    }
    let proxy = status
        .get("Web")
        .and_then(|web| web.get(&authority))
        .and_then(|server| server.get("Handlers"))
        .and_then(|handlers| handlers.get("/"))
        .and_then(|handler| handler.get("Proxy"))
        .and_then(serde_json::Value::as_str);
    if proxy != Some(target.as_str()) {
        return Err(format!(
            "Tailscale Serve root handler for {authority} must proxy exactly to {target}"
        ));
    }
    if status
        .get("AllowFunnel")
        .and_then(|funnel| funnel.get(&authority))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return Err(concat!("The configured origin is exposed through Tailscale Funnel; disable Funnel before enabling ", crate::app_name!(), " Mobile").into());
    }
    Ok(())
}

pub fn verify_tailscale_serve(origin: &str, port: u16) -> Result<(), String> {
    verify_serve_json(&serve_status_json()?, origin, port)
}

impl HostConfig {
    /// Read the desktop's settings and decide whether the host should run.
    ///
    /// The one rule worth stating: **an unreadable settings file is not a
    /// disabled one.** This used to be `read().ok().and_then(parse.ok())
    /// .unwrap_or_default()`, and since `MobileHostSettings::default()` has
    /// `enabled: false`, *any* read or parse failure came back as
    /// [`DISABLED_ERROR`] — on which the entry point exits 0, which
    /// `Restart=on-failure` does not restart. So a single unreadable read left
    /// the sidecar permanently dead while `settings.json` still said
    /// `enabled: true`, with nothing in the journal to say why and the desktop
    /// showing only its probe's `Connection refused (os error 111)` against the
    /// socket file the dead process left behind.
    ///
    /// A missing file is the exception that stays clean: Mobile cannot have
    /// been enabled by a desktop that has never written its settings.
    pub fn load(state_dir: &Path) -> Result<Self, String> {
        let path = state_dir.join("settings.json");
        let settings: SettingsFile = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("{SETTINGS_UNREADABLE_ERROR}: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(DISABLED_ERROR.into())
            }
            Err(error) => return Err(format!("{SETTINGS_UNREADABLE_ERROR}: {error}")),
        };
        let host = settings.app_mobile_host.unwrap_or_default();
        if !host.enabled {
            return Err(DISABLED_ERROR.into());
        }
        if !(1024..=65535).contains(&host.port) {
            return Err("Mobile host port must be between 1024 and 65535".into());
        }
        let origin = validate_origin(
            host.serve_origin
                .as_deref()
                .ok_or("A verified Tailscale Serve origin is required")?,
        )?;
        let control_dir = state_dir.join("mobile-control");
        Ok(Self {
            state_dir: state_dir.to_path_buf(),
            control_dir,
            host,
            origin,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The serde key is a literal in the attribute; this ties it to the brand
    /// module so the two cannot drift.
    #[test]
    fn the_mobile_host_key_is_the_brand_constant() {
        let json = format!(r#"{{"{}":{{"enabled":true}}}}"#, crate::brand::MOBILE_HOST_KEY);
        let file: SettingsFile = serde_json::from_str(&json).unwrap();
        assert!(file.app_mobile_host.is_some());
    }
    use crate::paths::OsKind;

    #[test]
    fn tailscale_on_path_is_always_preferred() {
        for os in [OsKind::Macos, OsKind::Windows, OsKind::Unix] {
            let program = tailscale_program_for(os, true, None, |_| true);
            assert_eq!(program, PathBuf::from("tailscale"));
        }
    }

    #[test]
    fn tailscale_falls_back_to_the_app_bundled_cli_on_macos() {
        let bundled = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        let found = tailscale_program_for(OsKind::Macos, false, None, |p| p == bundled);
        assert_eq!(found, bundled);
        let missing = tailscale_program_for(OsKind::Macos, false, None, |_| false);
        assert_eq!(missing, PathBuf::from("tailscale"));
    }

    #[test]
    fn tailscale_falls_back_to_program_files_on_windows() {
        let pf = std::ffi::OsStr::new(r"C:\Program Files");
        let expected = PathBuf::from(pf).join("Tailscale").join("tailscale.exe");
        let found = tailscale_program_for(OsKind::Windows, false, Some(pf), |p| p == expected);
        assert_eq!(found, expected);
        let no_env = tailscale_program_for(OsKind::Windows, false, None, |_| true);
        assert_eq!(no_env, PathBuf::from("tailscale"));
    }

    #[test]
    fn tailscale_has_no_bundled_fallback_on_other_unixes() {
        let program = tailscale_program_for(OsKind::Unix, false, None, |_| true);
        assert_eq!(program, PathBuf::from("tailscale"));
    }

    fn state_dir_with(settings: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("state dir");
        fs::write(dir.path().join("settings.json"), settings).expect("settings");
        dir
    }

    const ENABLED: &str = concat!(r#"{""#, crate::app_slug!(), r#"_mobile_host":{"enabled":true,"port":8742,
        "serve_origin":"https://desk.example.ts.net"}}"#);

    #[test]
    fn only_an_explicit_off_is_the_clean_disabled_exit() {
        let dir = state_dir_with(concat!(r#"{""#, crate::app_slug!(), r#"_mobile_host":{"enabled":false}}"#));
        assert_eq!(
            HostConfig::load(dir.path()).unwrap_err(),
            DISABLED_ERROR,
            "an explicit off must stay the clean exit"
        );

        // No Mobile block at all, and no settings file at all, are the same
        // statement: a desktop that never enabled it.
        let dir = state_dir_with(r#"{"theme":"dark"}"#);
        assert_eq!(HostConfig::load(dir.path()).unwrap_err(), DISABLED_ERROR);
        let empty = tempfile::tempdir().expect("state dir");
        assert_eq!(HostConfig::load(empty.path()).unwrap_err(), DISABLED_ERROR);
    }

    /// The regression this split exists for: an unparseable settings file used
    /// to fall back to `MobileHostSettings::default()`, whose `enabled` is
    /// false — so it reported DISABLED, the entry point exited 0, and
    /// `Restart=on-failure` left Mobile down for good.
    #[test]
    fn an_unreadable_settings_file_is_never_reported_as_disabled() {
        for broken in [
            "{ this is not json",
            "",
            // Present, enabled, but one field serde cannot take: the whole
            // parse fails, which is exactly the case that read as "off".
            concat!(r#"{""#, crate::app_slug!(), r#"_mobile_host":{"enabled":true,"port":"8742"}}"#),
        ] {
            let dir = state_dir_with(broken);
            let error = HostConfig::load(dir.path()).unwrap_err();
            assert_ne!(error, DISABLED_ERROR, "{broken:?} reported as disabled");
            assert!(
                error.starts_with(SETTINGS_UNREADABLE_ERROR),
                "{broken:?} gave {error}"
            );
        }
    }

    #[test]
    fn an_enabled_configuration_loads_its_origin_and_port() {
        let dir = state_dir_with(ENABLED);
        let config = HostConfig::load(dir.path()).expect("config");
        assert_eq!(config.origin, "https://desk.example.ts.net");
        assert_eq!(config.host.port, 8742);
        assert_eq!(config.control_dir, dir.path().join("mobile-control"));
    }

    #[test]
    fn a_misconfigured_but_enabled_host_is_a_failure_not_a_disable() {
        // An enabled host with no verified origin cannot serve, but it is also
        // not "off" — reporting it as DISABLED would exit 0 and hide it.
        let dir = state_dir_with(concat!(r#"{""#, crate::app_slug!(), r#"_mobile_host":{"enabled":true}}"#));
        assert_ne!(HostConfig::load(dir.path()).unwrap_err(), DISABLED_ERROR);
    }

    #[test]
    fn accepts_only_exact_https_origin() {
        assert_eq!(
            validate_origin("https://desk.tail.test").unwrap(),
            "https://desk.tail.test"
        );
        for bad in [
            "http://desk.tail.test",
            "https://u@desk.tail.test",
            "https://desk.tail.test/x",
            "https://desk.tail.test/?q=x",
        ] {
            assert!(validate_origin(bad).is_err(), "accepted {bad}");
        }
    }

    fn serve_status() -> serde_json::Value {
        serde_json::json!({
            "TCP": { "443": { "HTTPS": true } },
            "Web": {
                "desk.example.ts.net:443": {
                    "Handlers": { "/": { "Proxy": "http://127.0.0.1:8742" } }
                }
            }
        })
    }

    #[test]
    fn verifies_exact_non_funnel_root_handler() {
        assert!(verify_serve_json(&serve_status(), "https://desk.example.ts.net", 8742).is_ok());
    }

    #[test]
    fn detects_name_origin_and_loopback_port() {
        assert_eq!(
            detect_serve_settings_json(&serve_status()).unwrap(),
            DetectedServeSettings {
                display_name: "desk".into(),
                port: 8742,
                origin: "https://desk.example.ts.net".into(),
            }
        );
    }

    #[test]
    fn detection_rejects_funnel_and_ambiguous_mappings() {
        let mut funnel = serve_status();
        funnel["AllowFunnel"] = serde_json::json!({ "desk.example.ts.net:443": true });
        assert!(detect_serve_settings_json(&funnel).is_err());

        let mut ambiguous = serve_status();
        ambiguous["Web"]["other.example.ts.net:443"] = serde_json::json!({
            "Handlers": { "/": { "Proxy": "http://127.0.0.1:9000" } }
        });
        assert!(detect_serve_settings_json(&ambiguous).is_err());
    }

    #[test]
    fn rejects_wrong_target_or_funnel() {
        assert!(verify_serve_json(&serve_status(), "https://desk.example.ts.net", 9999).is_err());
        let mut funnel = serve_status();
        funnel["AllowFunnel"] = serde_json::json!({ "desk.example.ts.net:443": true });
        assert!(verify_serve_json(&funnel, "https://desk.example.ts.net", 8742).is_err());
    }
}
