//! The **contained reader**: is this VM narrow *right now*?
//!
//! A VM project whose trusted record (`projects.json` → `extra["vm"]`, never
//! the in-folder `project.json`) carries `mail_reader` may be served the root
//! MCP's mail read tools — but the flag is a request, not a fact. Every mail
//! call re-checks the live box ([`refusal`]), and while the flag is set the
//! window refuses to widen the box ([`widen_refusal`]), so the two cannot drift
//! apart silently. A reader VM is a VM for reading mail, not a dev box that also
//! reads mail. Design: `docs/mail_mcp_plan.md` §"The contained reader".
//!
//! Pure and `AppHandle`-free: `commands::vm` gathers [`BoxFacts`] from the live
//! registry and proxy and asks here.

use crate::schema::project::{VmEgress, VmSpec};

/// What the live system says about one project's VM, gathered per call.
#[derive(Debug, Clone, Default)]
pub struct BoxFacts {
    /// The trusted spec, `None` when the project is not a VM project at all.
    pub spec: Option<VmSpec>,
    /// The egress the running VM was **booted** with — a saved spec applies on
    /// the next boot, so this, not the spec, is what the guest actually has.
    /// `None` when the VM is not in this process's registry.
    pub booted_egress: Option<VmEgress>,
    /// The live proxy's standing allowlist, `None` when no proxy runs.
    pub live_allow: Option<Vec<String>>,
    /// Temporary allows that have not expired.
    pub live_temp_allows: usize,
    /// The project has a host-side mirror.
    pub mirror: bool,
}

/// Why this box may not be served mail, or `None` when it is narrow. Each miss
/// names itself, so the agent's user reads what to change.
pub fn refusal(f: &BoxFacts) -> Option<String> {
    let only = "mail is served only to a project with the default allowlist";
    let Some(spec) = f.spec.as_ref().filter(|s| s.mail_reader) else {
        return Some("this project is not a mail reader".into());
    };
    let Some(booted) = f.booted_egress else {
        return Some(concat!("this project's VM was not booted by this ", crate::app_name!(), "; boot it from ", crate::app_name!(), " first").into());
    };
    for egress in [spec.egress, booted] {
        match egress {
            VmEgress::Proxy => {}
            VmEgress::Open => {
                return Some("this project's network is open; mail is served only behind the allowlisting proxy".into())
            }
            VmEgress::Off => {
                return Some("this project has no network at all; mail is served only behind the allowlisting proxy".into())
            }
        }
    }
    if spec.allow_github {
        return Some(format!("this project allows GitHub; {only}"));
    }
    if !spec.allow_hosts.is_empty() {
        return Some(format!("this project allows extra hosts; {only}"));
    }
    if f.live_temp_allows > 0 {
        return Some(format!("a host is temporarily allowed for this project; {only}"));
    }
    let default = crate::services::vm_proxy::allowlist_for(&[], false);
    match &f.live_allow {
        Some(live) if *live == default => {}
        Some(_) => return Some(format!("this project's live allowlist is wider than the default; {only}")),
        None => return Some("this project's egress proxy is not running".into()),
    }
    if f.mirror {
        return Some("this project has a host-side mirror; a mail reader must not have one".into());
    }
    None
}

/// Why `next` may not be saved over a project whose flag is (or would be) set:
/// a mail reader is never wider than the default proxy box. `None` allows it.
pub fn widen_refusal(next: &VmSpec, mirror: bool) -> Option<String> {
    if !next.mail_reader {
        return None;
    }
    let first = "turn \"mail reader\" off first";
    if next.egress != VmEgress::Proxy {
        return Some(format!("a mail reader runs behind the allowlisting proxy only; {first}"));
    }
    if next.allow_github {
        return Some(format!("a mail reader cannot allow GitHub; {first}"));
    }
    if !next.allow_hosts.is_empty() {
        return Some(format!("a mail reader cannot allow extra hosts; {first}"));
    }
    if mirror {
        return Some("a mail reader must not have a host-side mirror".into());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn narrow() -> BoxFacts {
        BoxFacts {
            spec: Some(VmSpec { mail_reader: true, egress: VmEgress::Proxy, ..Default::default() }),
            booted_egress: Some(VmEgress::Proxy),
            live_allow: Some(crate::services::vm_proxy::allowlist_for(&[], false)),
            live_temp_allows: 0,
            mirror: false,
        }
    }

    #[test]
    fn the_default_proxy_box_passes() {
        assert_eq!(refusal(&narrow()), None);
    }

    /// Table-driven: every way of being wider refuses, with its own message.
    #[test]
    fn every_miss_refuses_and_names_itself() {
        let spec = |edit: fn(&mut VmSpec)| {
            let mut f = narrow();
            edit(f.spec.as_mut().unwrap());
            f
        };
        let cases: Vec<(&str, BoxFacts, &str)> = vec![
            ("not flagged", spec(|s| s.mail_reader = false), "not a mail reader"),
            ("not a vm", BoxFacts { spec: None, ..narrow() }, "not a mail reader"),
            ("open", spec(|s| s.egress = VmEgress::Open), "network is open"),
            ("off", spec(|s| s.egress = VmEgress::Off), "no network at all"),
            ("booted open", BoxFacts { booted_egress: Some(VmEgress::Open), ..narrow() }, "network is open"),
            ("github", spec(|s| s.allow_github = true), "allows GitHub"),
            ("custom host", spec(|s| s.allow_hosts = vec!["evil.example".into()]), "extra hosts"),
            ("temp allow", BoxFacts { live_temp_allows: 1, ..narrow() }, "temporarily allowed"),
            ("not ours", BoxFacts { booted_egress: None, ..narrow() }, concat!("not booted by this ", crate::app_name!())),
            ("no proxy", BoxFacts { live_allow: None, ..narrow() }, "proxy is not running"),
            (
                "live list drifted",
                BoxFacts { live_allow: Some(vec!["evil.example".into()]), ..narrow() },
                "wider than the default",
            ),
            ("mirror", BoxFacts { mirror: true, ..narrow() }, "mirror"),
        ];
        for (name, facts, needle) in cases {
            let msg = refusal(&facts).unwrap_or_else(|| panic!("{name}: must refuse"));
            assert!(msg.contains(needle), "{name}: {msg}");
        }
    }

    /// The check runs per call: widening mid-session refuses the *next* read.
    #[test]
    fn widening_mid_session_refuses_the_next_call() {
        let mut f = narrow();
        assert!(refusal(&f).is_none());
        f.live_temp_allows = 1;
        assert!(refusal(&f).is_some());
        f.live_temp_allows = 0;
        assert!(refusal(&f).is_none());
    }

    #[test]
    fn the_flag_guards_the_knob() {
        let reader = || VmSpec { mail_reader: true, egress: VmEgress::Proxy, ..Default::default() };
        assert_eq!(widen_refusal(&reader(), false), None);
        assert!(widen_refusal(&VmSpec { egress: VmEgress::Open, ..reader() }, false).is_some());
        assert!(widen_refusal(&VmSpec { egress: VmEgress::Off, ..reader() }, false).is_some());
        assert!(widen_refusal(&VmSpec { allow_github: true, ..reader() }, false).is_some());
        assert!(widen_refusal(&VmSpec { allow_hosts: vec!["x.example".into()], ..reader() }, false).is_some());
        assert!(widen_refusal(&reader(), true).is_some());
        // Clearing the flag first frees every knob again.
        assert_eq!(widen_refusal(&VmSpec { mail_reader: false, egress: VmEgress::Open, ..reader() }, true), None);
    }
}
