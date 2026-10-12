//! The app windows' navigation gate (decision D6, threat recheck gap 38).
//!
//! The `main` window, the `detached-*` popouts, the `present-*` audience
//! windows and the `connect` window load the app origin and hold the IPC
//! bridge to every command. A navigation that takes one of them off that
//! origin — a link in rendered content that slipped past its click handler,
//! a `\\host\x` href on Windows, a mermaid label, a form — would either
//! reload the app and lose drafts or put a foreign page where the app's own
//! code ran. So every navigation of those webviews is judged here, and a new
//! window (a middle click, `target=_blank`, `window.open`) never opens inside
//! the app: a web URL goes to the system browser, anything else is refused.
//!
//! Windows with a gate of their own are left to it: the live browser pages
//! (`browser-*`, `commands::browser`) and the native print windows
//! (`print-*`, `commands::print_native`).
//!
//! Pure: the Tauri glue (`nav_gate_plugin`, `app_new_window` in `lib.rs`)
//! only asks these functions.

use url::Url;

/// Which rule a webview's navigations follow.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// The window judges its own navigations; this gate stays out.
    Own,
    /// Only the app origin (and its blank, srcdoc and blob documents).
    AppOrigin,
}

/// The rule for a webview by its label. Unknown labels get the app-origin
/// rule: a new kind of window is gated until someone decides otherwise.
pub fn gate_for(label: &str) -> Gate {
    if label.starts_with("browser-") || label.starts_with("print-") {
        Gate::Own
    } else {
        Gate::AppOrigin
    }
}

/// The origins the app's own pages load from: `tauri://localhost` on Linux
/// and macOS, `http(s)://tauri.localhost` on Windows, plus the dev server's
/// origin in a dev build.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AppOrigins(Vec<(String, String, Option<u16>)>);

impl AppOrigins {
    /// This build's origins. `dev_url` is the configured `devUrl`, passed
    /// only when the build serves from it.
    pub fn for_build(windows: bool, dev_url: Option<&Url>) -> Self {
        let mut origins = Vec::new();
        if windows {
            origins.push(("http".into(), "tauri.localhost".into(), Some(80)));
            origins.push(("https".into(), "tauri.localhost".into(), Some(443)));
        } else {
            origins.push(("tauri".into(), "localhost".into(), None));
        }
        if let Some(url) = dev_url {
            if let Some(host) = url.host_str() {
                origins.push((url.scheme().to_string(), host.to_ascii_lowercase(), url.port_or_known_default()));
            }
        }
        Self(origins)
    }

    /// Is `url` a document of one of these origins?
    pub fn contains(&self, url: &Url) -> bool {
        let Some(host) = url.host_str() else {
            return false;
        };
        let host = host.to_ascii_lowercase();
        self.0.iter().any(|(scheme, h, port)| {
            url.scheme() == scheme && host == *h && url.port_or_known_default() == *port
        })
    }
}

/// May an app window navigate (top level or a frame) to `url`? The app
/// origin, `about:blank` and `about:srcdoc` (the sandboxed frames mail and
/// reader mode render into), and `blob:` URLs the app origin minted.
pub fn may_navigate(url: &Url, app: &AppOrigins) -> bool {
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "blob" => Url::parse(url.path()).is_ok_and(|inner| app.contains(&inner)),
        _ => app.contains(url),
    }
}

/// What a new-window request from an app window becomes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NewWindow {
    /// Hand this web URL to the system browser (`open_external_url`'s rule).
    External(String),
    /// Open nothing.
    Deny,
}

/// A middle click, a `target=_blank` link or a `window.open` in an app
/// window: an `http(s)` page off the app origin opens in the system browser,
/// the way the app opens every external link; anything else — an app-origin
/// page (a second copy of the app with the IPC bridge), a `file:`, `data:`
/// or `blob:` document, an unknown scheme — opens nowhere.
pub fn new_window(url: &Url, app: &AppOrigins) -> NewWindow {
    let web = matches!(url.scheme(), "http" | "https") && url.host_str().is_some_and(|h| !h.is_empty());
    if web && !app.contains(url) {
        NewWindow::External(url.to_string())
    } else {
        NewWindow::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn only_live_pages_and_print_windows_keep_their_own_gate() {
        for label in ["browser-1a2b", "print-77"] {
            assert_eq!(gate_for(label), Gate::Own, "{label}");
        }
        for label in ["main", "detached-p1-g2", "present-deck", "connect", "anything-new", ""] {
            assert_eq!(gate_for(label), Gate::AppOrigin, "{label}");
        }
    }

    #[test]
    fn linux_and_macos_allow_only_the_tauri_origin_and_its_inert_documents() {
        let app = AppOrigins::for_build(false, None);
        for ok in [
            "tauri://localhost/",
            "tauri://localhost/index.html?detached=1#x",
            "TAURI://LOCALHOST/index.html",
            "about:blank",
            "about:srcdoc",
            "blob:tauri://localhost/5f0c-11",
        ] {
            assert!(may_navigate(&url(ok), &app), "{ok}");
        }
        for refused in [
            "https://evil.example/",
            "http://localhost:1420/",
            "http://tauri.localhost/",
            "tauri://evil/",
            "file:///home/u/x.html",
            "file://host/share/x.html",
            "data:text/html,<b>x</b>",
            "javascript:alert(1)",
            "about:config",
            "blob:https://evil.example/5f0c",
            "blob:null/5f0c",
            "ipc://localhost/cmd",
        ] {
            assert!(!may_navigate(&url(refused), &app), "{refused}");
        }
    }

    #[test]
    fn windows_allows_the_tauri_localhost_origin_and_a_dev_build_its_dev_server() {
        let app = AppOrigins::for_build(true, None);
        assert!(may_navigate(&url("http://tauri.localhost/index.html"), &app));
        assert!(may_navigate(&url("https://tauri.localhost/"), &app));
        assert!(may_navigate(&url("blob:http://tauri.localhost/abc"), &app));
        assert!(!may_navigate(&url("http://tauri.localhost:8080/"), &app));
        assert!(!may_navigate(&url("tauri://localhost/"), &app));
        assert!(!may_navigate(&url("http://evil.tauri.localhost.example/"), &app));

        let dev = url("http://localhost:1420");
        let app = AppOrigins::for_build(false, Some(&dev));
        assert!(may_navigate(&url("http://localhost:1420/src/main.tsx"), &app));
        assert!(may_navigate(&url("tauri://localhost/"), &app));
        assert!(!may_navigate(&url("http://localhost:1421/"), &app));
        assert!(!may_navigate(&url("https://localhost:1420/"), &app));
        assert!(!may_navigate(&url("http://127.0.0.1:1420/"), &app));
    }

    /// The wiring, which no runtime test reaches: every app window is built
    /// with the new-window handler, `main` included (so Tauri must not build
    /// it from the config), and the gate plugin is registered.
    #[test]
    fn every_app_window_is_built_with_the_gate() {
        for (file, src) in [
            ("subwindow.rs", include_str!("../commands/subwindow.rs")),
            ("presenter.rs", include_str!("../commands/presenter.rs")),
            ("connect.rs", include_str!("../commands/connect.rs")),
        ] {
            assert!(src.contains(".on_new_window(crate::app_new_window("), "{file} builds an app window without the new-window gate");
        }
        let lib = include_str!("../lib.rs");
        assert!(lib.contains(".plugin(nav_gate_plugin())"));
        assert!(lib.contains("create_main_window(_app)?;"));
        assert!(lib.contains(".on_new_window(app_new_window("));
        for (file, conf) in [
            ("tauri.conf.json", include_str!("../../tauri.conf.json")),
            ("tauri.macos.conf.json", include_str!("../../tauri.macos.conf.json")),
        ] {
            let conf: serde_json::Value = serde_json::from_str(conf).unwrap();
            for window in conf["app"]["windows"].as_array().unwrap() {
                assert_eq!(window["create"], serde_json::Value::Bool(false), "{file}: Tauri would build a window without the gate");
            }
        }
    }

    #[test]
    fn new_windows_send_web_pages_to_the_browser_and_refuse_the_rest() {
        let dev = url("http://localhost:1420");
        let app = AppOrigins::for_build(false, Some(&dev));
        assert_eq!(
            new_window(&url("https://example.com/a?b#c"), &app),
            NewWindow::External("https://example.com/a?b#c".into())
        );
        assert_eq!(
            new_window(&url("http://192.0.2.7:8080/"), &app),
            NewWindow::External("http://192.0.2.7:8080/".into())
        );
        for refused in [
            "tauri://localhost/docs/x.md",
            "http://localhost:1420/docs/x.md",
            "about:blank",
            "blob:tauri://localhost/1",
            "file:///etc/passwd",
            "file://host/share/run.exe",
            "data:text/html,x",
            "javascript:alert(1)",
            "mailto:a@example.com",
            "smb://host/share",
        ] {
            assert_eq!(new_window(&url(refused), &app), NewWindow::Deny, "{refused}");
        }
        let windows = AppOrigins::for_build(true, None);
        assert_eq!(new_window(&url("http://tauri.localhost/index.html"), &windows), NewWindow::Deny);
    }
}
