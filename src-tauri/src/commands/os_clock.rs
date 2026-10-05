//! The OS's own 12/24-hour clock preference — the default for Tabtivity's app-wide
//! clock while `Settings.time_format_24h` is unset (`src/lib/timeFormat.ts`).
//!
//! Two answers, strongest first. `use24h` is the desktop's explicit clock
//! switch where it has one (GNOME's `clock-format`, Cinnamon's `clock-use-24h`,
//! macOS's "24-hour time" override, Windows' regional time format). `locale` is
//! the time locale as a BCP 47 tag, for when there is no such switch (KDE, Xfce,
//! a bare window manager): the frontend asks ICU what that locale's clock is,
//! which is what the desktop itself would have printed.
//!
//! The webview cannot answer this by itself: WebKitGTK's `Intl` follows `LANG`,
//! never GNOME's clock switch, and WebView2 follows the browser UI language,
//! not the Windows regional format.

use serde::Serialize;

#[derive(Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OsClockFormat {
    /// The desktop's explicit clock setting, when it has one.
    pub use24h: Option<bool>,
    /// The time locale (`de-DE`), for ICU to judge when `use24h` is unknown.
    pub locale: Option<String>,
}

/// Read once per window at startup; never fails — an OS with no opinion is
/// `{ use24h: null, locale: null }` and the frontend falls back to the language.
#[tauri::command]
pub async fn os_clock_format() -> OsClockFormat {
    tauri::async_runtime::spawn_blocking(detect)
        .await
        .unwrap_or_default()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn detect() -> OsClockFormat {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    OsClockFormat {
        use24h: desktop_clock_24h(&desktop),
        locale: posix_time_locale(|key| std::env::var(key).ok())
            .and_then(|l| posix_locale_to_bcp47(&l)),
    }
}

/// The desktop's own clock switch. Asked only of the desktop that owns it: the
/// GNOME schema is often installed under KDE or Xfce too, holding a default
/// nobody chose, and reading it there would override the user's locale.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn desktop_clock_24h(desktop: &str) -> Option<bool> {
    let desktop = desktop.to_ascii_lowercase();
    if desktop.contains("cinnamon") {
        return gsettings_get("org.cinnamon.desktop.interface", "clock-use-24h")
            .and_then(|v| parse_gsettings_bool(&v));
    }
    if ["gnome", "unity", "budgie", "pantheon"]
        .iter()
        .any(|d| desktop.contains(d))
    {
        return gsettings_get("org.gnome.desktop.interface", "clock-format")
            .and_then(|v| parse_gnome_clock_format(&v));
    }
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn gsettings_get(schema: &str, key: &str) -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", schema, key])
        .stdin(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// `'24h'` / `'12h'` as `gsettings get` prints them.
#[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
fn parse_gnome_clock_format(value: &str) -> Option<bool> {
    match value.trim().trim_matches('\'') {
        "24h" => Some(true),
        "12h" => Some(false),
        _ => None,
    }
}

#[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
fn parse_gsettings_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// The locale that formats times: POSIX precedence, `LC_ALL` over `LC_TIME`
/// over `LANG`. `C`/`POSIX` say nothing about a clock, so they count as unset.
#[cfg(any(not(any(target_os = "windows", target_os = "macos")), test))]
fn posix_time_locale(var: impl Fn(&str) -> Option<String>) -> Option<String> {
    ["LC_ALL", "LC_TIME", "LANG"]
        .iter()
        .filter_map(|key| var(key))
        .find(|v| !v.trim().is_empty())
        .filter(|v| {
            let base = v.split(['.', '@']).next().unwrap_or("");
            base != "C" && base != "POSIX"
        })
}

/// `de_DE.UTF-8@euro` → `de-DE`; `en_DE@rg=dezzzz` (macOS) → `en-DE`.
#[cfg(any(not(target_os = "windows"), test))]
fn posix_locale_to_bcp47(locale: &str) -> Option<String> {
    let base = locale.split(['.', '@']).next()?.trim();
    if base.is_empty() || !base.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return None;
    }
    Some(base.replace('_', "-"))
}

#[cfg(target_os = "macos")]
fn detect() -> OsClockFormat {
    let Some(home) = std::env::var_os("HOME") else {
        return OsClockFormat::default();
    };
    let path = std::path::PathBuf::from(home).join("Library/Preferences/.GlobalPreferences.plist");
    let Some(dict) = plist::Value::from_file(&path)
        .ok()
        .and_then(plist::Value::into_dictionary)
    else {
        return OsClockFormat::default();
    };
    let flag = |key: &str| dict.get(key).and_then(plist::Value::as_boolean) == Some(true);
    let use24h = if flag("AppleICUForce24HourTime") {
        Some(true)
    } else if flag("AppleICUForce12HourTime") {
        Some(false)
    } else {
        None
    };
    OsClockFormat {
        use24h,
        locale: dict
            .get("AppleLocale")
            .and_then(plist::Value::as_string)
            .and_then(posix_locale_to_bcp47),
    }
}

#[cfg(target_os = "windows")]
fn detect() -> OsClockFormat {
    use windows::core::PCWSTR;
    use windows::Win32::Globalization::{GetLocaleInfoEx, LOCALE_STIMEFORMAT};
    let mut buf = [0u16; 128];
    // SAFETY: a null name is LOCALE_NAME_USER_DEFAULT, and the call writes at
    // most `buf.len()` UTF-16 units, returning the count including the NUL.
    let written = unsafe { GetLocaleInfoEx(PCWSTR::null(), LOCALE_STIMEFORMAT, Some(&mut buf)) };
    let use24h = usize::try_from(written)
        .ok()
        .filter(|n| (1..=buf.len()).contains(n))
        .map(|n| windows_time_format_is_24h(&String::from_utf16_lossy(&buf[..n - 1])));
    OsClockFormat { use24h, locale: None }
}

/// A Windows time picture (`HH:mm:ss`, `h:mm:ss tt`) is 24-hour when it uses
/// `H`. Text in single quotes is literal and skipped.
#[cfg(any(target_os = "windows", test))]
fn windows_time_format_is_24h(format: &str) -> bool {
    let mut quoted = false;
    for c in format.chars() {
        match c {
            '\'' => quoted = !quoted,
            'H' if !quoted => return true,
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gnome_and_cinnamon_values_parse() {
        assert_eq!(parse_gnome_clock_format("'24h'\n"), Some(true));
        assert_eq!(parse_gnome_clock_format("'12h'"), Some(false));
        assert_eq!(parse_gnome_clock_format("'weird'"), None);
        assert_eq!(parse_gsettings_bool("true\n"), Some(true));
        assert_eq!(parse_gsettings_bool("false"), Some(false));
        assert_eq!(parse_gsettings_bool(""), None);
    }

    #[test]
    fn time_locale_follows_posix_precedence() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |key: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map(|(_, v)| (*v).to_string())
            }
        };
        assert_eq!(
            posix_time_locale(env(&[("LANG", "en_US.UTF-8"), ("LC_TIME", "de_DE.UTF-8")])),
            Some("de_DE.UTF-8".into())
        );
        assert_eq!(
            posix_time_locale(env(&[("LC_ALL", "fr_FR"), ("LC_TIME", "de_DE.UTF-8")])),
            Some("fr_FR".into())
        );
        // An empty LC_TIME is unset, not "no locale".
        assert_eq!(
            posix_time_locale(env(&[("LANG", "en_GB.UTF-8"), ("LC_TIME", "")])),
            Some("en_GB.UTF-8".into())
        );
        assert_eq!(posix_time_locale(env(&[("LANG", "C.UTF-8")])), None);
        assert_eq!(posix_time_locale(env(&[])), None);
    }

    #[test]
    fn posix_locales_become_bcp47_tags() {
        assert_eq!(posix_locale_to_bcp47("de_DE.UTF-8@euro").as_deref(), Some("de-DE"));
        assert_eq!(posix_locale_to_bcp47("en_DE@rg=dezzzz").as_deref(), Some("en-DE"));
        assert_eq!(posix_locale_to_bcp47("fr").as_deref(), Some("fr"));
        assert_eq!(posix_locale_to_bcp47(".UTF-8"), None);
        assert_eq!(posix_locale_to_bcp47("de DE"), None);
    }

    #[test]
    fn windows_time_pictures() {
        assert!(windows_time_format_is_24h("HH:mm:ss"));
        assert!(windows_time_format_is_24h("H:mm"));
        assert!(!windows_time_format_is_24h("h:mm:ss tt"));
        // Quoted text is literal: an 'H' inside it is not an hour.
        assert!(!windows_time_format_is_24h("h:mm 'Hrs' tt"));
    }
}
