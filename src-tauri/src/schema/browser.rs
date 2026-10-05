//! Serde structs for the in-app browser (TODO group J #61).
//!
//! Same convention as `schema::mail`: snake_case field names, `rename_all =
//! "lowercase"` on the small closed enums, and every type here serializes to
//! exactly the shape the frontend's typed wrappers declare.
//!
//! **What is deliberately absent from every type in this file: a path.** No
//! command in `commands::browser` accepts one and no result carries one. A
//! download reports the *display name* it was saved under and nothing else —
//! where it went is the OS save dialog's business, and telling the frontend
//! would make the next feature request "let the page pick it".

use serde::{Deserialize, Serialize};

/// What the transport is actually doing, as a word rather than an icon. Users
/// do not read padlocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TlsState {
    /// https, certificate validated against the OS trust store.
    Secure,
    /// Plain http. There is no third "mixed" state in v1 because we have no API
    /// to observe passive mixed content (see `browser_engine`'s gap notes).
    Insecure,
    /// Not determined — a live window before its first load completes, or a
    /// scheme with no transport (`about:blank`).
    #[default]
    Unknown,
}

/// The security readout the chrome renders beside the address.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecurityState {
    pub tls: TlsState,
    pub scheme: String,
    /// The host in its **Unicode** form, for display.
    pub host_display: String,
    /// The ASCII/punycode host, present only when it differs from
    /// `host_display`. The chrome must render **both** — the Unicode form alone
    /// is the homograph attack and the ASCII form alone is unreadable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub punycode_warning: Option<String>,
    /// Whether an OpenVPN tunnel Tabtivity knows about is up. Browser traffic goes
    /// through it exactly like every other process on the machine; this is here
    /// so that is *visible* rather than surprising.
    pub vpn_active: bool,
}

impl Default for SecurityState {
    fn default() -> Self {
        Self {
            tls: TlsState::Unknown,
            scheme: String::new(),
            host_display: String::new(),
            punycode_warning: None,
            vpn_active: false,
        }
    }
}

/// The result of the pure navigation-policy check.
///
/// Note the three-into-two mapping, because it is the one place this type is
/// subtler than it looks. The gate has **three** outcomes (allow / confirm /
/// block) and this struct has two fields:
///
/// | gate      | `allowed` | `reason`       |
/// |-----------|-----------|----------------|
/// | Allow     | `true`    | `None`         |
/// | Confirm   | `true`    | `Some(token)`  |
/// | Block     | `false`   | `Some(token)`  |
///
/// So `allowed && reason.is_some()` means *"reachable, but this is a loopback
/// or private-network address and the user should be told before you open
/// it"*. `reason` is a stable machine token (`loopback`, `private-network`,
/// `link-local`, `internal-name`, `app-origin`, `scheme:file`, `downgrade`,
/// `redirect-loop`, `unparsable`, `about-internal`, `no-host`) — the wording
/// lives in the frontend's i18n, never here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UrlVerdict {
    pub allowed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The URL as it should be shown: userinfo removed, host in Unicode form,
    /// format controls stripped. **Never truncated** — eliding
    /// `https://example.com.evil.tld/…` to `https://example.com…` is the attack.
    pub display_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub punycode_warning: Option<String>,
    pub scheme: String,
    pub is_loopback: bool,
}

/// One fetched-and-sanitized page. `html` is a **fragment** with no `href`, no
/// remote-loading attribute and no script anywhere — the frontend renders it in
/// an `<iframe sandbox="" srcdoc>` with its own `default-src 'none'` CSP, which
/// is a third layer nothing here relies on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReaderPage {
    pub requested_url: String,
    /// Where the redirect chain actually ended. Not the same string as
    /// `requested_url` whenever a hop happened, and the difference is the whole
    /// point of reporting it.
    pub final_url: String,
    pub display_url: String,
    pub title: String,
    pub html: String,
    pub security: SecurityState,
    /// The body hit the element budget and was cut.
    pub truncated: bool,
    /// How many remote references the sanitizer dropped, for the "Tabtivity
    /// blocked n remote images" banner.
    pub blocked_remote_assets: u32,
}

/// A live-page window. The label is opaque to the frontend and is the only
/// handle it ever gets — there is no window id, no native handle, no path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowRef {
    pub label: String,
    pub display_url: String,
}

/// `browser:live-state` — pushed whenever a live window loads, retitles, or
/// finishes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowState {
    pub label: String,
    pub display_url: String,
    /// Already stripped of bidi/format controls. A tab titled
    /// `example.com — Secure  \u{2069}` is a real technique.
    pub title: String,
    pub security: SecurityState,
    pub loading: bool,
}

/// `browser:live-closed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveWindowClosed {
    pub label: String,
}

/// `browser:blocked` — a navigation the gate refused. A page state, not an
/// interrupt: the frontend renders an in-app error page, never a native modal.
///
/// `window_label` is what makes the event *attributable*. Every emitter of this
/// event today is a **live-page window** (its `on_navigation` gate, and its
/// download handler refusing an oversized transfer), which has nothing to do
/// with any reader tab — so without the label the frontend's only option was to
/// guess "the tab that most recently asked for a load", and that guess is wrong
/// in exactly the common case: a live window blocked mid-browse would wipe the
/// page an unrelated reader tab was showing. The reader's own refusals never
/// come through this event at all; they are the return value of
/// `browser_check_url`, which the caller already holds.
///
/// It stays `Option` rather than being made mandatory so a future emitter that
/// genuinely has no window (a background policy pass) can say so instead of
/// inventing a label.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedNavigation {
    pub display_url: String,
    pub reason: String,
    /// The `browser-*` label of the live window this happened in, when it
    /// happened in one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_label: Option<String>,
}

/// `browser:download-requested` — bytes are in quarantine and nothing has
/// reached the user's filesystem. `file_name` is a **display name**, already
/// through `web_safety::sanitize_attachment_name`; it is not where anything is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub download_id: String,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    /// The bytes are not what the name claims — either the sniffed type
    /// disagrees with the extension, or the content sniffs as an executable
    /// regardless of what it is called. A program download is **labelled, not
    /// refused**: people download installers, and a browser that cannot is
    /// broken.
    pub sniff_mismatch: bool,
}

/// What `browser_download_decide` did. Carries a name for the toast and
/// **never a path** — see the module note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct DownloadOutcome {
    pub saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
}

/// How the frontend learns what this platform will actually do, instead of
/// discovering it from a failed command. Same posture as the Docker sandbox on
/// Windows: refuse clearly rather than silently do something weaker than the
/// user was promised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrowserCapabilities {
    pub live_windows_supported: bool,
    pub reader_supported: bool,
    /// A stable token naming *why*, when something is off. The wording lives in
    /// the frontend's i18n.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform_note: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// The frontend's typed wrappers switch on these lowercase words; a
    /// renamed variant would fall through to "unknown" silently.
    #[test]
    fn tls_state_is_lowercase_and_defaults_to_unknown() {
        assert_eq!(json(&TlsState::Secure), "secure");
        assert_eq!(json(&TlsState::Insecure), "insecure");
        assert_eq!(json(&TlsState::Unknown), "unknown");
        assert_eq!(TlsState::default(), TlsState::Unknown);
        assert_eq!(
            serde_json::from_str::<TlsState>("\"secure\"").unwrap(),
            TlsState::Secure
        );
        assert!(serde_json::from_str::<TlsState>("\"Secure\"").is_err());
        assert_eq!(SecurityState::default().tls, TlsState::Unknown);
        assert!(!SecurityState::default().vpn_active);
    }

    /// The three-into-two mapping from the type doc: allow has no `reason`
    /// key at all, confirm is `allowed` *with* a reason, block is neither.
    #[test]
    fn url_verdict_encodes_allow_confirm_block_as_documented() {
        let base = UrlVerdict {
            allowed: true,
            reason: None,
            display_url: "https://example.com/".into(),
            punycode_warning: None,
            scheme: "https".into(),
            is_loopback: false,
        };
        let allow = json(&base);
        assert_eq!(allow["allowed"], true);
        assert!(allow.get("reason").is_none(), "allow carries no reason key");
        assert!(allow.get("punycode_warning").is_none());

        let confirm = json(&UrlVerdict {
            reason: Some("loopback".into()),
            is_loopback: true,
            ..base.clone()
        });
        assert_eq!(confirm["allowed"], true);
        assert_eq!(confirm["reason"], "loopback");

        let block = json(&UrlVerdict {
            allowed: false,
            reason: Some("scheme:file".into()),
            ..base
        });
        assert_eq!(block["allowed"], false);
        assert_eq!(block["reason"], "scheme:file");
    }

    /// The punycode warning is present exactly when the ASCII host differs —
    /// absent (not null) otherwise, so the chrome's "render both" rule keys on
    /// presence.
    #[test]
    fn punycode_warning_is_absent_not_null() {
        let plain = SecurityState {
            tls: TlsState::Secure,
            scheme: "https".into(),
            host_display: "example.com".into(),
            punycode_warning: None,
            vpn_active: false,
        };
        assert!(json(&plain).get("punycode_warning").is_none());
        let homograph = SecurityState {
            host_display: "аpple.com".into(),
            punycode_warning: Some("xn--pple-43d.com".into()),
            ..plain
        };
        let out = json(&homograph);
        assert_eq!(out["punycode_warning"], "xn--pple-43d.com");
        let back: SecurityState = serde_json::from_value(out).unwrap();
        assert_eq!(back, homograph);
    }

    /// The module's one rule: no type here carries a path. A download outcome
    /// is a flag plus a display name, and its default is "nothing saved".
    #[test]
    fn download_types_carry_a_display_name_and_never_a_path() {
        let outcome = DownloadOutcome::default();
        assert!(!outcome.saved);
        assert_eq!(json(&outcome), serde_json::json!({ "saved": false }));

        let request = DownloadRequest {
            download_id: "d1".into(),
            file_name: "setup.exe".into(),
            mime_type: None,
            size_bytes: Some(1024),
            sniff_mismatch: true,
        };
        let out = json(&request);
        let keys: Vec<&str> = out.as_object().unwrap().keys().map(String::as_str).collect();
        assert!(
            keys.iter().all(|k| !k.contains("path") && !k.contains("dir")),
            "a path-shaped key leaked: {keys:?}"
        );
        assert!(out.get("mime_type").is_none());
        assert_eq!(out["size_bytes"], 1024);
        assert_eq!(out["sniff_mismatch"], true);
    }

    /// `browser:blocked` names the live window it happened in when it has one,
    /// and omits the key — rather than writing null — when it does not.
    #[test]
    fn blocked_navigation_window_label_is_optional_on_the_wire() {
        let attributed = BlockedNavigation {
            display_url: "http://192.0.2.1/".into(),
            reason: "private-network".into(),
            window_label: Some("browser-3".into()),
        };
        assert_eq!(json(&attributed)["window_label"], "browser-3");
        let background = BlockedNavigation {
            window_label: None,
            ..attributed
        };
        assert!(json(&background).get("window_label").is_none());
        let back: BlockedNavigation =
            serde_json::from_str(r#"{"display_url":"u","reason":"no-host"}"#).unwrap();
        assert!(back.window_label.is_none());
    }

    /// A reader page round-trips with its nested security readout intact and
    /// keeps `requested_url` and `final_url` as distinct fields.
    #[test]
    fn reader_page_round_trips_with_both_urls() {
        let page = ReaderPage {
            requested_url: "http://example.com".into(),
            final_url: "https://example.com/".into(),
            display_url: "https://example.com/".into(),
            title: "Example".into(),
            html: "<p>hi</p>".into(),
            security: SecurityState {
                tls: TlsState::Secure,
                scheme: "https".into(),
                host_display: "example.com".into(),
                punycode_warning: None,
                vpn_active: true,
            },
            truncated: false,
            blocked_remote_assets: 2,
        };
        let back: ReaderPage = serde_json::from_value(json(&page)).unwrap();
        assert_eq!(back, page);
        assert_ne!(back.requested_url, back.final_url);
        let caps = BrowserCapabilities {
            live_windows_supported: false,
            reader_supported: true,
            platform_note: None,
        };
        assert!(json(&caps).get("platform_note").is_none());
    }
}
