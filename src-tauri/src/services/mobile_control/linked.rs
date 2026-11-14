//! Linked desktops (`docs/phone_multi_desktop_plan.md`, Phase 1): the other
//! desktops' phone hosts whose installed phone app may show this desktop's
//! phone UI in a frame, and which this desktop's app may frame in turn.
//!
//! The list is `[MOBILE_HOST_KEY].linked_desktops` in `settings.json`, read
//! per request like `files::files_open`, so an edit applies without a
//! restart. Every entry is re-validated on every read and an invalid one is
//! dropped on its own (one bad value never closes the others); the desktop
//! validates on add only to say why. A link names an origin, never a
//! project, path, command or tmux target, and grants no session: a framed
//! page still signs in as a paired device of this host.
//!
//! Only a machine of this host's own tailnet links: `<machine>.<tailnet>.ts.net`
//! with this host's `<tailnet>`, any port. `ts.net` is a public suffix, so
//! such names are one site and this host's `SameSite=Strict` session cookie
//! reaches its page framed under another of them. A `*.c.ts.net` name is a
//! suffix of its own (another site: the cookie would not be sent) and is
//! refused, as is every name when this host is not on `ts.net` itself.
//! Behind the server gateway the list is never read (`host::linked_for`).

use std::path::Path;

use serde_json::Value;

/// At most this many linked desktops; entries past it are ignored.
pub const MAX_LINKED: usize = 8;

/// Why an origin cannot be linked. The desktop's add check
/// (`src/lib/linkedDesktops.ts`) mirrors these to say so.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkRefusal {
    /// Not one exact `https://host[:port]` origin.
    Invalid,
    /// Not a `<machine>.<tailnet>.ts.net` name of this host's tailnet, or
    /// this host is not on `ts.net`.
    OtherTailnet,
    /// This host's own origin.
    OwnOrigin,
}

/// The `<tailnet>.ts.net` part of an origin's host, when the host is exactly
/// `<machine>.<tailnet>.ts.net` and not under the `*.c.ts.net` suffix.
fn tailnet_of(origin: &str) -> Option<String> {
    let url = url::Url::parse(origin).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let labels: Vec<&str> = host.split('.').collect();
    match labels.as_slice() {
        [machine, tailnet, "ts", "net"] if !machine.is_empty() && !tailnet.is_empty() && *tailnet != "c" => {
            Some(format!("{tailnet}.ts.net"))
        }
        _ => None,
    }
}

/// `raw`, normalized (`config::validate_origin`), if this host (at `own`,
/// its normalized origin) may link it.
pub fn validate_linked_origin(own: &str, raw: &str) -> Result<String, LinkRefusal> {
    let origin = super::config::validate_origin(raw.trim()).map_err(|_| LinkRefusal::Invalid)?;
    let theirs = tailnet_of(&origin).ok_or(LinkRefusal::OtherTailnet)?;
    if tailnet_of(own).as_deref() != Some(theirs.as_str()) {
        return Err(LinkRefusal::OtherTailnet);
    }
    if origin.eq_ignore_ascii_case(own) {
        return Err(LinkRefusal::OwnOrigin);
    }
    Ok(origin)
}

/// The linked desktops of the host at `own`, from a parsed `settings.json`:
/// valid entries only, normalized, de-duplicated, at most [`MAX_LINKED`].
pub fn linked_in(settings: &Value, own: &str) -> Vec<String> {
    let Some(entries) = settings
        .get(crate::brand::MOBILE_HOST_KEY)
        .and_then(|host| host.get("linked_desktops"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for origin in entries
        .iter()
        .filter_map(Value::as_str)
        .filter_map(|raw| validate_linked_origin(own, raw).ok())
    {
        if out.len() == MAX_LINKED {
            break;
        }
        if !out.contains(&origin) {
            out.push(origin);
        }
    }
    out
}

/// [`linked_in`] over `<state_dir>/settings.json`; an unreadable or
/// malformed file is no link.
pub fn linked_desktops(state_dir: &Path, own: &str) -> Vec<String> {
    std::fs::read(state_dir.join("settings.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .map(|settings| linked_in(&settings, own))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: &str = "https://desk.example.ts.net";

    #[test]
    fn only_a_machine_of_this_hosts_tailnet_links() {
        assert_eq!(validate_linked_origin(OWN, "https://laptop.example.ts.net"), Ok("https://laptop.example.ts.net".into()));
        assert_eq!(validate_linked_origin(OWN, " https://Laptop.EXAMPLE.ts.net/ "), Ok("https://laptop.example.ts.net".into()));
        // Another instance on this machine, on Serve's third port.
        assert_eq!(validate_linked_origin(OWN, "https://desk.example.ts.net:10000"), Ok("https://desk.example.ts.net:10000".into()));
        assert_eq!(validate_linked_origin(OWN, "https://desk.example.ts.net:443"), Err(LinkRefusal::OwnOrigin));
        assert_eq!(validate_linked_origin(OWN, "https://desk.example.ts.net"), Err(LinkRefusal::OwnOrigin));
        for other in [
            "https://laptop.other.ts.net",
            "https://laptop.c.ts.net",
            "https://laptop.example.c.ts.net",
            "https://example.ts.net",
            "https://a.laptop.example.ts.net",
            "https://laptop.example.com",
        ] {
            assert_eq!(validate_linked_origin(OWN, other), Err(LinkRefusal::OtherTailnet), "{other}");
        }
        for invalid in ["http://laptop.example.ts.net", "https://laptop.example.ts.net/x", "https://u@laptop.example.ts.net", "laptop", ""] {
            assert_eq!(validate_linked_origin(OWN, invalid), Err(LinkRefusal::Invalid), "{invalid}");
        }
        // A host not on ts.net links nothing.
        assert_eq!(
            validate_linked_origin("https://desk.example.com", "https://laptop.example.ts.net"),
            Err(LinkRefusal::OtherTailnet)
        );
    }

    #[test]
    fn the_list_drops_bad_entries_one_by_one_and_caps_at_eight() {
        let key = crate::brand::MOBILE_HOST_KEY;
        let mut entries = vec![
            serde_json::json!("https://laptop.example.ts.net"),
            serde_json::json!(7),
            serde_json::json!("https://evil.example.com"),
            serde_json::json!("https://LAPTOP.example.ts.net"),
            serde_json::json!(OWN),
        ];
        for n in 0..12 {
            entries.push(serde_json::json!(format!("https://m{n}.example.ts.net")));
        }
        let settings = serde_json::json!({ key: { "linked_desktops": entries } });
        let list = linked_in(&settings, OWN);
        assert_eq!(list.len(), MAX_LINKED);
        assert_eq!(list[0], "https://laptop.example.ts.net");
        assert_eq!(list[1], "https://m0.example.ts.net");

        assert!(linked_in(&serde_json::json!({ key: { "linked_desktops": "https://laptop.example.ts.net" } }), OWN).is_empty());
        assert!(linked_in(&serde_json::json!({ key: {} }), OWN).is_empty());
        assert!(linked_in(&serde_json::json!({}), OWN).is_empty());
    }

    #[test]
    fn an_unreadable_settings_file_is_no_link() {
        let dir = tempfile::tempdir().unwrap();
        assert!(linked_desktops(dir.path(), OWN).is_empty());
        std::fs::write(dir.path().join("settings.json"), b"{not json").unwrap();
        assert!(linked_desktops(dir.path(), OWN).is_empty());
        let key = crate::brand::MOBILE_HOST_KEY;
        std::fs::write(
            dir.path().join("settings.json"),
            serde_json::to_vec(&serde_json::json!({ key: { "linked_desktops": ["https://laptop.example.ts.net"] } })).unwrap(),
        )
        .unwrap();
        assert_eq!(linked_desktops(dir.path(), OWN), ["https://laptop.example.ts.net"]);
    }
}
