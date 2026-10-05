//! Capability-scope regression guard (`docs/browser_plan_b.md` §2.2, BC-1…BC-3).
//!
//! **Why this file exists.** `tauri_utils::acl::capability::Capability` documents
//! `windows` as: *"If a window label matches any of the patterns in this list, the
//! capability will be enabled on all the webviews of that window, regardless of
//! the value of `webviews`."* And `ipc::authority::RuntimeAuthority::resolve_access`
//! grants when
//!
//! ```text
//! origin.matches(&cmd.context) && (webviews.any(match) || windows.any(match))
//! ```
//!
//! So a `windows: ["main", …]` grant is not a grant to *the* webview in that
//! window — it is a grant to every webview that window will ever hold. Tabtivity's
//! `default.json` used to be written that way. Nothing exploited it, because
//! Tabtivity creates exactly one webview per window, but it meant the day someone
//! added a second webview to `main` (an embedded browser pane being the obvious
//! candidate) that webview would silently inherit `core:default`,
//! `dialog:default`, `drag:default` and `notification:default` — with only
//! Tauri's origin check standing between a browsed page and all of it.
//!
//! Re-scoping to `webviews` is behaviour-preserving for what ships today:
//! `WebviewWindowBuilder::new(app, label, url)` builds both the window *and* its
//! webview with that same label (`tauri::webview::webview_window` — the builder
//! forwards `&label` to `WindowBuilder::new` and `WebviewBuilder::new`), and
//! every window Tabtivity creates goes through it — `main` from `tauri.conf.json`,
//! `detached-*` from `commands::subwindow`, `present-*` from
//! `commands::presenter`. This test pins that the re-scope stays done.
//!
//! It reads the JSON as data rather than linking `tauri_utils`, so it keeps
//! failing even if the capability schema moves.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

/// Labels that must keep working. If one of these ever stops matching, the UI is
/// silently dead — every `invoke` from that window is rejected by the ACL.
const MUST_STILL_MATCH: &[&str] = &["main", "detached-p1-g1", "detached-abc", "present-deck1"];

/// The label the in-app browser's live-page windows use. Nothing but
/// `browser.json` (which grants nothing) may match it.
const BROWSER_LABELS: &[&str] = &["browser-0", "browser-abc123", "browser-"];

fn capabilities_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("capabilities")
}

fn read_capabilities() -> BTreeMap<String, Value> {
    let dir = capabilities_dir();
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(&dir).expect("capabilities/ must exist") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .expect("utf-8 file name")
            .to_string();
        let raw = std::fs::read_to_string(&path).expect("read capability");
        let value: Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{name} is not valid JSON: {e}"));
        out.insert(name, value);
    }
    assert!(!out.is_empty(), "no capability files found in {dir:?}");
    out
}

/// The subset of glob syntax Tauri's capability patterns actually use: `*`
/// matching any run of characters. Written out rather than pulled from the
/// `glob` crate so this test has no dependency that could itself change
/// semantics under it.
fn glob_match(pattern: &str, label: &str) -> bool {
    fn go(p: &[u8], s: &[u8]) -> bool {
        match p.first() {
            None => s.is_empty(),
            Some(b'*') => (0..=s.len()).any(|i| go(&p[1..], &s[i..])),
            Some(&c) => !s.is_empty() && s[0] == c && go(&p[1..], &s[1..]),
        }
    }
    go(pattern.as_bytes(), label.as_bytes())
}

fn patterns(cap: &Value, key: &str) -> Vec<String> {
    cap.get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn glob_match_is_itself_correct() {
    // The assertions below are only as good as this matcher, so it gets its own
    // test — a matcher that says "no" to everything would make every negative
    // assertion pass vacuously.
    assert!(glob_match("main", "main"));
    assert!(!glob_match("main", "main2"));
    assert!(glob_match("detached-*", "detached-x"));
    assert!(glob_match("detached-*", "detached-"));
    assert!(!glob_match("detached-*", "detached"));
    assert!(glob_match("*", "anything"));
    assert!(glob_match("a*c", "abbbc"));
    assert!(!glob_match("a*c", "abbb"));
}

/// **BC-1.** No capability may scope by window label.
#[test]
fn no_capability_scopes_by_window() {
    for (name, cap) in read_capabilities() {
        assert!(
            cap.get("windows").is_none(),
            "`{name}` uses a `windows` glob. A window pattern grants the capability to \
             EVERY webview in that window (tauri_utils Capability::windows), which is \
             exactly the over-grant an in-app browser would inherit. Use `webviews` — \
             a WebviewWindow's webview carries the window's own label, so the list is \
             the same. See docs/browser_plan_b.md §2.2 BC-1."
        );
    }
}

/// The re-scope must not have broken any window that exists today.
#[test]
fn the_default_capability_still_reaches_every_shipping_webview() {
    let caps = read_capabilities();
    let default = caps
        .get("default.json")
        .expect("capabilities/default.json must exist");
    let webviews = patterns(default, "webviews");
    assert!(
        !webviews.is_empty(),
        "default.json must scope by `webviews`; an empty list grants nothing and the \
         whole UI goes dead"
    );
    for label in MUST_STILL_MATCH {
        assert!(
            webviews.iter().any(|p| glob_match(p, label)),
            "no pattern in default.json's `webviews` matches `{label}` — that window's \
             every invoke would be rejected by the ACL. Patterns: {webviews:?}"
        );
    }
    assert!(
        !default
            .get("permissions")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty(),
        "default.json granting nothing would be a silently dead UI"
    );
}

/// **BC-3.** The browser's own label must reach no permission at all.
#[test]
fn nothing_grants_the_browser_label_a_permission() {
    for (name, cap) in read_capabilities() {
        let grants_something = cap
            .get("permissions")
            .and_then(|p| p.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if !grants_something {
            // A capability that grants nothing cannot over-grant, whatever it
            // matches. `browser.json` is deliberately of this shape.
            continue;
        }
        for key in ["windows", "webviews"] {
            for pattern in patterns(&cap, key) {
                for label in BROWSER_LABELS {
                    assert!(
                        !glob_match(&pattern, label),
                        "`{name}`'s `{key}` pattern `{pattern}` matches the browser label \
                         `{label}`. A live-page window must reach no Tauri command; see \
                         docs/browser_plan_b.md §2.2 BC-3."
                    );
                }
            }
        }
    }
}

/// **BC-2.** A `remote` block is the one line that hands a browsed page the IPC
/// bridge — `Origin::Remote` only ever matches through it.
#[test]
fn no_capability_has_a_remote_block() {
    for (name, cap) in read_capabilities() {
        assert!(
            cap.get("remote").is_none(),
            "`{name}` declares a `remote` capability. Remote origins are denied every \
             command *because* no capability names them; this key is the whole gate. \
             See docs/browser_plan_b.md §2.2 BC-2."
        );
    }
}

/// `local: false` disables a capability for the app's own origin. On any
/// capability the app itself needs that is a dead UI; it is correct only on a
/// grant-nothing capability like `browser.json`, where it is a second belt.
#[test]
fn only_a_grant_nothing_capability_may_be_non_local() {
    for (name, cap) in read_capabilities() {
        let local = cap.get("local").and_then(Value::as_bool).unwrap_or(true);
        if local {
            continue;
        }
        let permissions = cap
            .get("permissions")
            .and_then(|p| p.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        assert_eq!(
            permissions, 0,
            "`{name}` sets `local: false` while granting {permissions} permission(s) — \
             either it is dead for the app origin, or it is a grant meant for remote \
             content. Neither is intended."
        );
    }
}

/// **BC-4 / BC-6.** Two `tauri.conf.json` facts the browser's isolation rests on.
#[test]
fn the_app_config_keeps_its_security_posture() {
    let conf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
    let raw = std::fs::read_to_string(&conf).expect("read tauri.conf.json");
    let value: Value = serde_json::from_str(&raw).expect("tauri.conf.json is valid JSON");
    let app = value.get("app").expect("app section");

    assert!(
        app.get("withGlobalTauri").and_then(Value::as_bool) != Some(true),
        "withGlobalTauri exposes the convenience wrapper to every webview"
    );

    let security = app.get("security").expect("app.security");
    let csp = security
        .get("csp")
        .and_then(Value::as_str)
        .expect("app.security.csp must be set");
    // Reader mode renders sanitized HTML in a `sandbox=""` srcdoc frame with no
    // network of its own. The temptation, the first time an image does not load,
    // is to add `https:` to the app CSP — which would give the app origin a
    // fetch reach it has never had. Remote bytes must come through the backend
    // or not at all.
    //
    // `http://ipc.localhost` is Tauri's own Windows IPC origin, not a network
    // reach, so it is removed before the scan rather than special-cased inside
    // it.
    let scanned = csp.replace("http://ipc.localhost", "");
    for banned in ["https:", "http:", "//"] {
        assert!(
            !scanned.contains(banned),
            "app.security.csp gained `{banned}` — reader mode must never be \"fixed\" by \
             giving the app origin a network fetch reach: {csp}"
        );
    }
    assert!(
        security.get("assetProtocol").is_none(),
        "the asset protocol is a *local* origin (tauri is_local_url), so enabling it \
         widens what a navigation-policy bug can reach"
    );
    assert!(
        security
            .get("dangerousDisableAssetCspModification")
            .is_none(),
        "dangerousDisableAssetCspModification"
    );
    assert!(
        security.get("pattern").is_none(),
        "app.security.pattern changes the IPC shape the browser plan reasons about"
    );

    let windows = app
        .get("windows")
        .and_then(Value::as_array)
        .expect("app.windows");
    for w in windows {
        assert_eq!(
            w.get("dragDropEnabled").and_then(Value::as_bool),
            Some(false),
            "dragDropEnabled lets content receive local file paths from an OS drop"
        );
    }
}

/// macOS gates camera/microphone/location on the *process* via `Info.plist`
/// usage-description keys. Declaring none is the strongest single permission
/// control in the browser plan, because the OS enforces it rather than us.
#[test]
fn the_macos_bundle_declares_no_capture_usage_descriptions() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for file in ["tauri.macos.conf.json", "entitlements.plist"] {
        let path = dir.join(file);
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        for banned in [
            "NSCameraUsageDescription",
            "NSMicrophoneUsageDescription",
            "NSLocationWhenInUseUsageDescription",
            "NSLocationAlwaysAndWhenInUseUsageDescription",
            "NSBluetoothAlwaysUsageDescription",
            "com.apple.security.device.camera",
            "com.apple.security.device.audio-input",
        ] {
            assert!(
                !raw.contains(banned),
                "`{file}` declares `{banned}`. Without it those APIs are unavailable to \
                 the whole process no matter what any webview asks for; with it, a \
                 browsed page's request becomes a question the OS is willing to ask. \
                 See docs/browser_plan_b.md §5.2."
            );
        }
    }
}
