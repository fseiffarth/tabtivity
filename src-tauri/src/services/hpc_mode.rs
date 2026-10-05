//! Which remote hosts Tabtivity treats as **HPC hosts**, and therefore samples
//! carefully.
//!
//! A shared cluster login node runs under usage rules an ordinary dev box does
//! not (`docs/context/hpc_careful_mode.md`): other users' account names may not
//! be determined, information about them that happens to be readable may not be
//! used, and a login node is not to carry a sustained background load. Tabtivity's
//! two host probes — the monitor snapshot (`sysstat::REMOTE_SNAPSHOT_SCRIPT`)
//! and the connect-time usage check (`services::remote_usage`) — therefore have
//! a *careful* variant that collects strictly less.
//!
//! **Detection lives on the host**: each probe script asks whether SLURM is on
//! `PATH` and reports the answer back in its own output, so nothing here has to
//! guess from a hostname (which would be both unreliable and, for a hostname of
//! someone's institution, not ours to hardcode). This module is only the
//! *memory* of that answer, keyed by SSH target, so a caller that has no probe
//! result in hand — the connect path, deciding whether to fire the usage check
//! at all — can still act on what the last probe learned.
//!
//! The memory is process-lifetime only and deliberately one-way: a host may be
//! marked careful, and nothing un-marks it while Tabtivity runs. A false "careful"
//! costs a slightly thinner monitor pane; a false "ordinary" costs a rule
//! violation, so the asymmetry is the point.

use std::collections::HashSet;
use std::sync::Mutex;

use crate::schema::project::RemoteSpec;

static CAREFUL_HOSTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Identity of an SSH target for this registry: `user@host:port`, from
/// `ssh_common::target_key` — the single implementation, shared with the
/// frontend's `targetKey`.
///
/// This module used to spell the same format out a second time. Two copies of a
/// key that must stay byte-identical do not fail loudly when they drift: the
/// lookup simply finds nothing, and "nothing" reads as *not careful, not
/// tagged* — failing open, in exactly the case both flags exist to close.
pub fn key_for(spec: &RemoteSpec) -> String {
    crate::services::ssh_common::target_key(spec.user.as_deref(), &spec.host, spec.port)
}

/// Record what a probe found. Only `true` is remembered (see the module note on
/// the one-way asymmetry).
pub fn remember(key: &str, careful: bool) {
    if !careful {
        return;
    }
    let mut guard = CAREFUL_HOSTS.lock().unwrap();
    guard
        .get_or_insert_with(HashSet::new)
        .insert(key.to_string());
}

/// Whether a previous probe reported this target as an HPC host. `false` for a
/// target never probed — the probes themselves detect on the host, so an unknown
/// target is never sampled wrongly, it just isn't gated yet.
pub fn is_known_careful(key: &str) -> bool {
    CAREFUL_HOSTS
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|s| s.contains(key))
}

/// The user's **explicit** per-machine answer from `settings.careful_hosts`
/// (the system monitor's Light/Detailed switch, and the connect dialog's "Go
/// easy on this machine"), or `None` where they have not answered for this
/// target. Keyed by [`key_for`], which is byte-identical to the frontend's
/// `targetKey` — a divergence would silently look up a host nobody wrote.
pub fn stored_answer(key: &str) -> Option<bool> {
    load_settings()?.careful_hosts?.get(key).copied()
}

/// How long a `settings.json` reading is reused.
///
/// This used to be a fresh read and parse per call, which was fine while the
/// only callers were one SSH round trip deep. [`is_tagged_hpc`] now also backs
/// `ssh_common::authorize_dial`, i.e. it runs on **every** ssh argv built, so an
/// uncached read would put a file open + parse in front of every remote command.
/// Two seconds is short enough that flipping the tag takes effect while the user
/// is still looking at the switch — the auto-sync and lockstep loops re-check it
/// on their own ticks and must see the change — and long enough that a burst of
/// argv builds costs one read.
const SETTINGS_TTL: std::time::Duration = std::time::Duration::from_secs(2);

/// `(read at, what it said)`. The value is `Option` because "no settings file"
/// is itself an answer worth caching, not a reason to retry every call.
static SETTINGS_CACHE: Mutex<Option<(std::time::Instant, Option<crate::schema::Settings>)>> =
    Mutex::new(None);

fn load_settings() -> Option<crate::schema::Settings> {
    if let Ok(cache) = SETTINGS_CACHE.lock() {
        if let Some((at, settings)) = cache.as_ref() {
            if at.elapsed() < SETTINGS_TTL {
                return settings.clone();
            }
        }
    }
    let path = crate::storage::state_dir().join("settings.json");
    match crate::storage::read_json::<crate::schema::Settings>(&path) {
        Ok(fresh) => {
            if let Ok(mut cache) = SETTINGS_CACHE.lock() {
                *cache = Some((std::time::Instant::now(), Some(fresh.clone())));
            }
            Some(fresh)
        }
        // A failed read must NOT be cached. This gate's whole job is to refuse, so
        // "I could not find out" has to fall back on the last thing we did know —
        // caching the failure would answer "not tagged" for the whole TTL, which is
        // the one direction that costs the promise (a mid-write settings.json, an
        // EMFILE, a momentary permission blip would each open a 2 s window in which
        // a cluster login node is dialled as if untagged). The stale value is kept
        // and the next call retries.
        Err(_) => {
            if let Ok(cache) = SETTINGS_CACHE.lock() {
                if let Some((_, prev)) = cache.as_ref() {
                    return prev.clone();
                }
            }
            None
        }
    }
}

/// Whether the user has tagged this target **HPC** (`settings.hpc_hosts`, the
/// tick on the login form and the badge on the machine's row).
///
/// This is the gate every *behaviour* hangs off — the disk-usage scan, the
/// giant-folder census, the auto byte-sync and lockstep loops, silent
/// auto-connect. Unlike careful mode there is no default and no probe: nothing
/// tags a host but the user, because nothing else can know whether a machine's
/// operators mind (`sbatch` on `PATH` says a scheduler exists, not that the node
/// is shared). An untagged host therefore behaves exactly as it always has.
pub fn is_tagged_hpc(key: &str) -> bool {
    load_settings()
        .and_then(|s| s.hpc_hosts)
        .and_then(|m| m.get(key).copied())
        .unwrap_or(false)
}

/// [`is_tagged_hpc`] for a host spec.
pub fn is_hpc_spec(spec: &RemoteSpec) -> bool {
    is_tagged_hpc(&key_for(spec))
}

/// Sentinel carried by a command that refused because its target is tagged HPC
/// and the user has not confirmed *this* run. Must match `src/lib/remote/hpc/hpcGuard.ts`.
///
/// The shape is deliberately the one `UNKNOWN_HOST_KEY` already established
/// (`services::ssh_common::guard_first_contact`): everything the frontend needs
/// to raise a dialog and retry rides in the error string, so no call site has to
/// know in advance that its target might be a cluster. The alternative — asking
/// before every scan — would put the question in front of the 99% of users who
/// have no cluster at all.
pub const HPC_GUARD: &str = crate::app_env!("HPC_GUARD");

/// Build the refusal a gated command returns: `TABTIVITY_HPC_GUARD <what> <target>`.
/// `what` is a stable slug the dialog switches its wording on (`du-scan`,
/// `census`, `login-node-run`, `connect`), `target` the `user@host:port` being
/// protected.
pub fn guard_error(what: &str, spec: &RemoteSpec) -> String {
    guard_error_for(what, &key_for(spec))
}

/// [`guard_error`] for a caller holding only the target key — the dial policy
/// (`ssh_common::authorize_dial`), which gates argv builders that never see a
/// `RemoteSpec`.
pub fn guard_error_for(what: &str, key: &str) -> String {
    format!("{HPC_GUARD} {what} {key}")
}

/// [`is_tagged_hpc`] for a project's host (primary or a `compute_hosts` worker),
/// resolving the spec itself. `false` for a local project or an unknown host, so
/// a caller with only ids in hand can gate without plumbing a spec through.
pub fn project_host_is_hpc(project_id: &str, host_id: &str) -> bool {
    crate::services::remote::remote_target_for_host(project_id, host_id)
        .is_some_and(|t| is_hpc_spec(&t.spec))
}

/// Whether this host should be treated carefully **outside the monitor** — the
/// connect-time usage probe, which has no frontend answer passed down to it.
///
/// The user's explicit answer wins in both directions; with no answer it falls
/// back to what earlier probes learned, which is what the gate has always done.
/// Note this is deliberately *not* the frontend's careful-by-default rule: the
/// probe censors itself host-side either way, and defaulting it off here would
/// silently retire the busy-host warning for every remote project rather than
/// only for the machines the user called shared.
pub fn is_careful_host(spec: &RemoteSpec) -> bool {
    let key = key_for(spec);
    // The HPC tag outranks the Light/Detailed answer in one direction only: a
    // tagged machine is careful even if its careful answer says "this one is
    // mine". Those two say different things — "how much may Tabtivity look at" and
    // "is this a shared cluster" — and there is no coherent reading of the second
    // that permits the first's full collection.
    is_tagged_hpc(&key) || stored_answer(&key).unwrap_or_else(|| is_known_careful(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::services::ssh_common::target_key;

    /// The shape of the key itself is pinned once, in
    /// `ssh_common::target_key_matches_frontend`; what belongs here is only that
    /// this registry indexes by *that* key. Spelling the format out again is the
    /// duplication the second implementation was deleted for.
    fn key(user: &Option<String>, host: &str, port: Option<u16>) -> String {
        target_key(user.as_deref(), host, port)
    }

    /// The asymmetry that keeps a flaky probe from *downgrading* a cluster: once
    /// a host has said "I am an HPC host", a later probe that fails to detect it
    /// (SLURM missing from a login shell's `PATH`, say) must not turn the
    /// reduced collection back off.
    #[test]
    fn careful_is_sticky_and_never_cleared() {
        let k = key(&Some("carol".into()), "sticky.example", None);
        remember(&k, true);
        remember(&k, false);
        assert!(is_known_careful(&k));
    }

    /// The wire contract with `src/lib/remote/hpc/hpcGuard.ts`: sentinel, then the slug the
    /// dialog switches its wording on, then the target it names. Parsed by
    /// splitting on whitespace, so neither field may gain a space.
    #[test]
    fn guard_error_carries_the_slug_and_the_target() {
        // Built field-by-field: `RemoteSpec` has no `Default`, and the point of
        // the assertion is the exact three-token shape the frontend splits.
        let spec = RemoteSpec {
            user: Some("alice".into()),
            host: "login.example".into(),
            port: None,
            remote_path: "/home/alice/p".into(),
            openvpn: None,
            auto_connect: None,
            key_auth: None,
            persist_sessions: None,
            vm: None,
            label: None,
            extra: Default::default(),
        };
        assert_eq!(
            guard_error("du-scan", &spec),
            concat!(crate::app_upper!(), "_HPC_GUARD du-scan alice@login.example:22")
        );
        assert_eq!(guard_error("du-scan", &spec).split_whitespace().count(), 3);
    }

    #[test]
    fn an_unprobed_target_is_not_known_careful() {
        assert!(!is_known_careful(&key(&None, "never-probed.example", None)));
    }
}
