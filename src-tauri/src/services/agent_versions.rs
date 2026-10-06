//! Which release of each agent CLI is installed, and whether it is still the
//! one Tabtivity's flags and parsers were actually checked against.
//!
//! Tabtivity reads other people's CLIs at a level of detail that only holds for
//! the release someone sat down and verified: a `--resume` flag, a session-log
//! key, the numbered rows of an approval menu, the shape of a `/model` sheet.
//! `docs/third_party_update_checklist.md` records those checks in prose — "*
//! verified against Claude Code 2.1.251*" — which is exactly the form nothing
//! can compare against. So the same notes live here as data ([`VERIFIED`]),
//! and this module answers one question with them: *did somebody else's CLI
//! move under us?*
//!
//! It answers only that. It never updates a CLI, never blocks a launch, never
//! reaches the network, and drift is reported, not enforced — an agent whose
//! version moved works exactly as well (or as badly) as it did before anyone
//! looked.
//!
//! Two refusals shape the tables, both inherited from [`crate::commands::agents`]'
//! `WARMUPS` and [`crate::services::agent_usage`]'s `RECIPES`:
//!
//! 1. **Only argv run against a real binary is listed** ([`VERSION_ARGV`]).
//!    `--version` is near-universal, but "near" is how a wrong flag opens an
//!    interactive TUI on a null stdin, or prints something that parses as a
//!    version and is not one. An agent with no recipe reports [`DriftState::Unknown`].
//! 2. **A baseline is a note someone wrote after checking**, never the version
//!    that happened to be installed when the code was written. An agent with no
//!    note reports [`DriftState::Unverified`] — "nobody has checked this one",
//!    which is true and useful, rather than a green tick that is neither.
//!
//! The parsing is deliberately small: CLIs print a version line in whatever
//! shape they like (`2.1.263 (Claude Code)`, `codex-cli 0.153.4`,
//! `0.0.393 Commit: ea52078`), so [`parse_version`] picks the first dotted
//! numeric token and leaves the rest of the line intact for display.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::services::agent_usage::strip_ansi;

/// How long one `--version` run may take before it is killed.
///
/// A version print answers immediately; unlike a warm-up (10 minutes, because
/// it does real work) there is nothing here worth waiting for. The ceiling
/// exists for the CLI that ignores the flag and opens its TUI instead — that
/// process must die, not sit there holding a slot.
pub const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

/// Longest version text kept. The real ones are tens of bytes; the bound is
/// here so a CLI that answers `--version` with its whole help text cannot push
/// a page of prose into the state file and onto a settings row.
pub const MAX_VERSION_TEXT: usize = 200;

/// How long a probe result is reused while its executable is unchanged.
///
/// A day is the fallback for changes that do not replace the launcher itself.
/// Normal installs change its metadata and invalidate the cache immediately.
pub const PROBE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

/// Per-agent argv that prints a version and exits, keyed by the registry `id`.
///
/// Every line here was run against an installed binary; the comment is what it
/// printed, which is also the evidence for [`parse_version`]'s shape rules. To
/// add an agent: run its `--version`, paste the output as the comment, add the
/// line. Do not add one from a README.
const VERSION_ARGV: &[(&str, &[&str])] = &[
    // "2.1.284 (Claude Code)"
    ("claude", &["--version"]),
    // "codex-cli 0.159.3"
    ("codex", &["--version"]),
    // "GitHub Copilot CLI 1.0.88." (1.0.88; 0.0.393 printed "0.0.393 Commit: ea52078")
    ("copilot", &["--version"]),
    // "1.2.9"
    ("antigravity", &["--version"]),
    // "Muse Code 1.3.0 (1.3.0-R3057.1)" — only with [`VERSION_ENV`]'s flag.
    ("muse", &["--version"]),
];

/// Environment a version probe sets for one agent, keyed like [`VERSION_ARGV`].
///
/// For the CLI whose launcher does more than print on `--version`: Muse's
/// wrapper script checks for an update on *any* invocation and, once its
/// interval has passed, starts a background self-update — so an unguarded
/// daily probe would be Tabtivity updating somebody else's CLI.
/// `MUSE_NO_AUTO_UPDATE=1` skips that branch of the launcher (read out of the
/// 1.3.0 launcher, 2026-09-25) and the version still prints.
const VERSION_ENV: &[(&str, &[(&str, &str)])] = &[("muse", &[("MUSE_NO_AUTO_UPDATE", "1")])];

/// One recorded "verified against" note: the release someone actually checked,
/// and which surface that check covered.
pub struct Verified {
    /// Registry `id` of the agent the note is about.
    pub agent: &'static str,
    /// The release that was checked, exactly as its CLI prints it.
    pub version: &'static str,
    /// What the check covered — the checklist section, then the coupling in
    /// words, because "§1.2 moved" is not actionable and "the /model sheet is
    /// unverified past 0.153.4" is.
    pub surface: &'static str,
}

/// The machine-readable half of `docs/third_party_update_checklist.md`.
///
/// One row per *check*, not per agent: Codex has four because four different
/// surfaces are verified separately, and once they sit at different releases
/// the oldest of them is the weakest assumption Tabtivity currently rests on.
/// Collapsing them to one number per agent would throw away the only part that
/// says where to look.
///
/// Bump a row when you re-verify that surface — the row and the prose note it
/// mirrors, in the same commit.
const VERIFIED: &[Verified] = &[
    Verified {
        agent: "claude",
        version: "2.1.292",
        surface: "§1.1 — SessionStart/Stop hook payload, --resume, /usage envelope",
    },
    Verified {
        agent: "codex",
        version: "0.159.3",
        surface: "§1.2 — mobile mode lines and Shift+Tab (agentModes.ts)",
    },
    Verified {
        agent: "codex",
        version: "0.159.3",
        surface: "§1.2 — decision lamp: title repaints, numbered approval rows",
    },
    Verified {
        agent: "codex",
        version: "0.159.3",
        surface: "§1.2 — the two-step /model sheet read off the screen",
    },
    Verified {
        agent: "codex",
        version: "0.159.3",
        surface: "§1.2 — resume writer-lock markers (lifecycle last probed on 0.154.0)",
    },
    Verified {
        agent: "antigravity",
        version: "1.2.14",
        surface: "§1.5 — footer model/effort and the /model dialog (antigravity.ts)",
    },
    Verified {
        agent: "copilot",
        version: "1.0.89",
        surface: "§1.5 — --continue/-p, session-state store, authTokens login layout",
    },
];

/// The one-shot version argv for `agent_id`, or `None` when nobody has checked
/// what that CLI answers.
pub fn version_argv(agent_id: &str) -> Option<Vec<String>> {
    VERSION_ARGV
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map(|(_, args)| args.iter().map(|s| (*s).to_string()).collect())
}

/// Environment variables the version probe for `agent_id` must set.
pub fn version_env(agent_id: &str) -> &'static [(&'static str, &'static str)] {
    VERSION_ENV
        .iter()
        .find(|(id, _)| *id == agent_id)
        .map_or(&[], |(_, env)| env)
}

/// True when this agent can be asked its version at all — what a caller reports
/// as "this CLI cannot say", instead of showing an empty version chip.
pub fn is_supported(agent_id: &str) -> bool {
    VERSION_ARGV.iter().any(|(id, _)| *id == agent_id)
}

/// Every recorded check for one agent, oldest verified release first.
pub fn verified_notes(agent_id: &str) -> Vec<&'static Verified> {
    notes_in(VERIFIED, agent_id)
}

fn notes_in(table: &'static [Verified], agent_id: &str) -> Vec<&'static Verified> {
    let mut notes: Vec<&'static Verified> =
        table.iter().filter(|note| note.agent == agent_id).collect();
    notes.sort_by(|a, b| version_cmp(a.version, b.version));
    notes
}

/// Cut `text` to [`MAX_VERSION_TEXT`], marking the cut rather than letting a
/// truncated version number look like a real one.
fn bounded(text: &str) -> String {
    if text.len() <= MAX_VERSION_TEXT {
        return text.to_string();
    }
    let mut cut = MAX_VERSION_TEXT;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…", &text[..cut])
}

/// What a `--version` run printed, or the CLI's own complaint.
///
/// Some CLIs print their version to stderr and still exit 0; a non-zero exit is
/// a failure whatever it printed, since a version we did not really read is
/// worse than no version at all.
pub fn version_text(stdout: &str, stderr: &str, code: Option<i32>) -> Result<String, String> {
    let out = bounded(strip_ansi(stdout).trim());
    let err = bounded(strip_ansi(stderr).trim());
    if code == Some(0) {
        if !out.is_empty() {
            return Ok(out);
        }
        if !err.is_empty() {
            return Ok(err);
        }
    }
    Err(if !err.is_empty() {
        err
    } else if !out.is_empty() {
        out
    } else {
        match code {
            Some(status) => format!("the CLI exited with status {status} and printed nothing"),
            None => "the CLI was stopped before it answered".to_string(),
        }
    })
}

/// The version number inside one whitespace-separated token, if it is one.
///
/// Accepts `1.2`, `1.2.3`, `v1.2.3`, `1.2.3-beta.1`; rejects a bare number and
/// a commit hash, which is why at least one dot and a digit-led second
/// component are required (`0.0.393 Commit: ea52078` must answer `0.0.393`).
fn version_token(raw: &str) -> Option<String> {
    let trimmed = raw.trim_matches(|c: char| !c.is_ascii_alphanumeric());
    let candidate = match trimmed.strip_prefix(['v', 'V']) {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest,
        _ => trimmed,
    };
    if candidate
        .chars()
        .any(|c| !(c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '+'))
    {
        return None;
    }
    let mut parts = candidate.split('.');
    let major = parts.next()?;
    if major.is_empty() || !major.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let minor = parts.next()?;
    if !minor.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    Some(candidate.to_string())
}

/// The version a CLI printed, dug out of whatever it printed around it.
///
/// Only the first few lines are read: a CLI that prefixes its version with an
/// update notice still answers, while one that prints a changelog cannot have a
/// number from halfway down it mistaken for the version.
pub fn parse_version(text: &str) -> Option<String> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .take(3)
        .flat_map(|line| line.split_whitespace())
        .find_map(version_token)
}

/// Order two version strings by their dot-separated components: numeric where
/// both sides are numbers, lexical otherwise, and a missing component counts as
/// lower (`1.2` < `1.2.3`).
///
/// Deliberately not a semver implementation — these strings come from other
/// people's CLIs and are not promised to be semver. It words a drift
/// ("newer"/"older"), where an exotic string it orders oddly costs an
/// adjective, and picks a launch flag ([`claude_takes_name_flag`]), where it
/// costs the typed fallback that flag replaces — never a launch.
pub fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let split = |v: &str| {
        v.split(['.', '-', '+'])
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    let (left, right) = (split(a), split(b));
    for index in 0..left.len().max(right.len()) {
        let l = left.get(index).map(String::as_str).unwrap_or("");
        let r = right.get(index).map(String::as_str).unwrap_or("");
        let ordering = match (l.parse::<u64>(), r.parse::<u64>()) {
            (Ok(ln), Ok(rn)) => ln.cmp(&rn),
            _ => l.cmp(r),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }
    Ordering::Equal
}

/// How the installed release sits relative to one recorded check.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Newer,
    Older,
    /// Ordered equal but not the same string — a build suffix, a rename.
    Different,
}

/// One check the installed release has moved away from.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleNote {
    pub version: String,
    pub surface: String,
    pub direction: Direction,
}

/// The verdict for one agent.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DriftState {
    /// Installed release equals every recorded check.
    Match,
    /// At least one recorded check was made against a different release.
    Moved,
    /// Installed and readable, but nobody has recorded a check for it.
    Unverified,
    /// Not installed, no version recipe, or the probe failed.
    Unknown,
}

/// Compare an installed version against every recorded check for that agent.
pub fn drift(agent_id: &str, installed: Option<&str>) -> (DriftState, Vec<StaleNote>) {
    drift_in(VERIFIED, agent_id, installed)
}

fn drift_in(
    table: &'static [Verified],
    agent_id: &str,
    installed: Option<&str>,
) -> (DriftState, Vec<StaleNote>) {
    let Some(installed) = installed else {
        return (DriftState::Unknown, Vec::new());
    };
    let notes = notes_in(table, agent_id);
    if notes.is_empty() {
        return (DriftState::Unverified, Vec::new());
    }
    let stale: Vec<StaleNote> = notes
        .iter()
        .filter(|note| note.version != installed)
        .map(|note| StaleNote {
            version: note.version.to_string(),
            surface: note.surface.to_string(),
            direction: match version_cmp(installed, note.version) {
                std::cmp::Ordering::Greater => Direction::Newer,
                std::cmp::Ordering::Less => Direction::Older,
                std::cmp::Ordering::Equal => Direction::Different,
            },
        })
        .collect();
    if stale.is_empty() {
        (DriftState::Match, stale)
    } else {
        (DriftState::Moved, stale)
    }
}

/// What one agent's version probe last answered.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Seen {
    /// The parsed version, absent when the CLI printed something unparseable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The line as printed, kept for display and for the next person who has to
    /// work out why a version did not parse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<String>,
    /// Why the probe failed, when it did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Unix seconds of the probe. Drives [`PROBE_TTL`]; defaulted rather than
    /// required, so a file written by a build that did not know this field
    /// reads as "probed at the epoch" (i.e. stale) instead of failing the whole
    /// store and taking every other agent's entry with it.
    #[serde(default)]
    pub checked_at: u64,
    /// Identity of the executable that answered. An installer can replace it
    /// before the day-long probe TTL expires.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<VersionSource>,
    /// The installed version the user has already been told about. A newer one
    /// raises the notice again; the same one does not nag every launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSource {
    path: PathBuf,
    modified_nanos: u128,
    len: u64,
    link_modified_nanos: u128,
}

fn modified_nanos(metadata: &std::fs::Metadata) -> Option<u128> {
    Some(
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    )
}

/// Follow the launcher and also watch its link: installers can replace either
/// the binary itself or a symlink that selects a different release.
fn version_source(path: &Path) -> Option<VersionSource> {
    let target = std::fs::metadata(path).ok()?;
    let link = std::fs::symlink_metadata(path).ok()?;
    Some(VersionSource {
        path: path.canonicalize().ok()?,
        modified_nanos: modified_nanos(&target)?,
        len: target.len(),
        link_modified_nanos: modified_nanos(&link)?,
    })
}

/// `<state_dir>/agent_versions.json` — probe results keyed by registry `id`.
///
/// Cache, not truth: the baselines ship in [`VERIFIED`] so the repo's claim is
/// the same on every machine, and deleting this file costs one re-probe.
pub type Store = HashMap<String, Seen>;

pub fn store_path() -> PathBuf {
    crate::storage::state_dir().join("agent_versions.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

/// Read the store at `path`. A missing or unreadable file is an empty store —
/// this is a cache, and refusing to report anything because it is corrupt would
/// be the only real damage it could do.
pub fn load_in(path: &Path) -> Store {
    crate::storage::read_json(path).unwrap_or_default()
}

pub fn load() -> Store {
    load_in(&store_path())
}

/// True when `seen` is young enough to answer with instead of spawning a CLI.
pub fn fresh(seen: &Seen, ttl: Duration) -> bool {
    now_secs().saturating_sub(seen.checked_at) < ttl.as_secs()
}

/// A cached answer belongs to the same executable only while its identity and
/// metadata still match. Old cache entries without `source` get one new probe.
pub fn fresh_for_path(seen: &Seen, ttl: Duration, path: &Path) -> bool {
    fresh(seen, ttl)
        && seen.source.is_some()
        && seen.source.as_ref() == version_source(path).as_ref()
}

/// The entry one probe result becomes, carrying `dismissed` over from whatever
/// the store already held for that agent.
fn seen_from(
    result: Result<String, String>,
    dismissed: Option<String>,
    source: Option<VersionSource>,
) -> Seen {
    match result {
        Ok(raw) => Seen {
            version: parse_version(&raw),
            raw: Some(raw),
            error: None,
            checked_at: now_secs(),
            source,
            dismissed,
        },
        Err(error) => Seen {
            version: None,
            raw: None,
            error: Some(error),
            checked_at: now_secs(),
            source,
            dismissed,
        },
    }
}

/// Record one probe result and hand back the entry that was stored, so a caller
/// reports exactly what the next reader of the store will see.
///
/// The `dismissed` marker is carried over *inside* the read-modify-write, not
/// read first and written after: a dismissal landing between the two would
/// otherwise be the one thing this loses. A failed write costs a re-probe and
/// nothing else, so the probe result is still returned.
pub fn remember_in(path: &Path, agent_id: &str, result: Result<String, String>) -> Seen {
    remember_with_source_in(path, agent_id, result, None)
}

fn remember_with_source_in(
    path: &Path,
    agent_id: &str,
    result: Result<String, String>,
    source: Option<VersionSource>,
) -> Seen {
    let unwritten = seen_from(result.clone(), None, source.clone());
    crate::storage::patch_json(path, Store::new(), |store| {
        let dismissed = store.get(agent_id).and_then(|seen| seen.dismissed.clone());
        let entry = seen_from(result, dismissed, source);
        store.insert(agent_id.to_string(), entry.clone());
        Ok(entry)
    })
    .unwrap_or(unwritten)
}

pub fn remember(agent_id: &str, result: Result<String, String>, executable: &Path) -> Seen {
    remember_with_source_in(&store_path(), agent_id, result, version_source(executable))
}

/// Mark the drift notice for `version` as seen. Recording the *version* rather
/// than a bare flag is what makes the notice come back when the CLI moves
/// again, without coming back every launch in between.
pub fn dismiss_in(path: &Path, agent_id: &str, version: &str) {
    let _ = crate::storage::patch_json(path, Store::new(), |store| {
        store.entry(agent_id.to_string()).or_default().dismissed = Some(version.to_string());
        Ok(())
    });
}

pub fn dismiss(agent_id: &str, version: &str) {
    dismiss_in(&store_path(), agent_id, version);
}

/// One agent's version answer, as the settings panel and the probe example both
/// render it.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionReport {
    pub agent: String,
    pub label: String,
    /// Whether the binary was found at all.
    pub installed: bool,
    /// Whether this agent has a version recipe.
    pub supported: bool,
    /// The parsed version.
    pub version: Option<String>,
    /// The version line as the CLI printed it.
    pub raw: Option<String>,
    pub state: DriftState,
    /// Every recorded check the installed release has moved away from, oldest
    /// verified release first — the oldest being the weakest assumption.
    pub stale: Vec<StaleNote>,
    pub error: Option<String>,
    /// Unix seconds of the probe behind this answer, 0 when there was none.
    pub checked_at: u64,
    /// Whether this came from the store rather than a fresh run.
    pub cached: bool,
    /// Whether the user has already dismissed the notice for this version.
    pub dismissed: bool,
}

impl VersionReport {
    /// The answer for an agent that was not probed: not installed, no recipe,
    /// or a probe that failed. Always [`DriftState::Unknown`] — never a green
    /// tick for a CLI nobody managed to ask.
    pub fn unread(agent: &str, label: &str, installed: bool, error: Option<String>) -> Self {
        Self {
            agent: agent.to_string(),
            label: label.to_string(),
            installed,
            supported: is_supported(agent),
            version: None,
            raw: None,
            state: DriftState::Unknown,
            stale: Vec::new(),
            error,
            checked_at: 0,
            cached: false,
            dismissed: false,
        }
    }

    /// The answer built from a probe result, fresh or cached.
    pub fn from_seen(agent: &str, label: &str, seen: &Seen, cached: bool) -> Self {
        let (state, stale) = drift(agent, seen.version.as_deref());
        Self {
            agent: agent.to_string(),
            label: label.to_string(),
            installed: true,
            supported: true,
            dismissed: match (&seen.version, &seen.dismissed) {
                (Some(version), Some(dismissed)) => version == dismissed,
                _ => false,
            },
            version: seen.version.clone(),
            raw: seen.raw.clone(),
            state,
            stale,
            error: seen.error.clone(),
            checked_at: seen.checked_at,
            cached,
        }
    }
}

/// First Claude Code release with `-n/--name <name>` — "Added `-n` /
/// `--name <name>` CLI flag to set a display name for the session at startup"
/// (Claude Code changelog, 2.1.76). An older CLI exits on the unknown option.
pub const CLAUDE_NAME_FLAG_SINCE: &str = "2.1.76";

/// Whether the Claude a probe last read accepts `--name` at launch.
///
/// Only a known version says yes: no probe, a failed one, or an unparsed line
/// all answer no, and the caller keeps typing `/rename` instead. A stale entry
/// still counts — an installed CLI moves forward, and 2.1.76 is far behind
/// anything a daily probe has seen since.
pub fn claude_takes_name_flag(seen: Option<&Seen>) -> bool {
    seen.and_then(|seen| seen.version.as_deref())
        .is_some_and(|v| version_cmp(v, CLAUDE_NAME_FLAG_SINCE) != std::cmp::Ordering::Less)
}

/// First Codex release with `--no-daemon`, which is also the first whose TUI
/// may hand its threads to a detached, shared `app-server --managed-daemon`
/// (`daemon_auto_start`, on by default). 0.155.x has neither and exits on the
/// unknown option. Checked against the npm linux-x64 builds of 0.155.1 and
/// 0.156.0.
pub const CODEX_NO_DAEMON_SINCE: &str = "0.156.0";

/// Whether the Codex a probe last read accepts `--no-daemon` at launch — the
/// same rule as [`claude_takes_name_flag`]: only a known version says yes.
pub fn codex_takes_no_daemon(seen: Option<&Seen>) -> bool {
    seen.and_then(|seen| seen.version.as_deref())
        .is_some_and(|v| version_cmp(v, CODEX_NO_DAEMON_SINCE) != std::cmp::Ordering::Less)
}

/// Whether `args` start Codex's interactive TUI — nothing, an option, or its
/// `resume`/`fork` subcommands — rather than a subcommand of its own (`login`,
/// `exec`, `mcp`, …) that has no background server to opt out of.
pub fn codex_runs_tui(args: &[String]) -> bool {
    args.first()
        .is_none_or(|arg| arg.starts_with('-') || arg == "resume" || arg == "fork")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_takes_no_daemon_from_0_156_0_on() {
        let seen = |v: Option<&str>| Seen {
            version: v.map(str::to_string),
            ..Seen::default()
        };
        assert!(codex_takes_no_daemon(Some(&seen(Some("0.156.0")))));
        assert!(codex_takes_no_daemon(Some(&seen(Some("0.159.2")))));
        assert!(!codex_takes_no_daemon(Some(&seen(Some("0.155.1")))));
        assert!(!codex_takes_no_daemon(Some(&seen(None))));
        assert!(!codex_takes_no_daemon(None));
    }

    #[test]
    fn only_the_codex_tui_gets_tui_flags() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(codex_runs_tui(&args(&[])));
        assert!(codex_runs_tui(&args(&["resume", "01a0f263-e07f-77a2-9ef3-d1e1b921d724"])));
        assert!(codex_runs_tui(&args(&["resume"])));
        assert!(codex_runs_tui(&args(&["--oss", "-m", "qwen3"])));
        assert!(!codex_runs_tui(&args(&["login", "--device-auth"])));
        assert!(!codex_runs_tui(&args(&["exec", "--skip-git-repo-check", "hi"])));
    }

    #[test]
    fn claude_takes_name_from_2_1_76_on() {
        let seen = |v: Option<&str>| Seen {
            version: v.map(str::to_string),
            ..Seen::default()
        };
        assert!(claude_takes_name_flag(Some(&seen(Some("2.1.76")))));
        // Numeric, not lexical: 2.1.276 is newer than 2.1.76.
        assert!(claude_takes_name_flag(Some(&seen(Some("2.1.276")))));
        assert!(claude_takes_name_flag(Some(&seen(Some("3.0.0")))));
        assert!(!claude_takes_name_flag(Some(&seen(Some("2.1.75")))));
        assert!(!claude_takes_name_flag(Some(&seen(Some("1.0.128")))));
        // Nothing read, nothing claimed.
        assert!(!claude_takes_name_flag(Some(&seen(None))));
        assert!(!claude_takes_name_flag(None));
    }

    /// The shapes the recipes were verified against, and the one that must
    /// not be read as a version: `copilot`'s trailing commit hash (0.0.x), then
    /// its sentence with a closing full stop (1.0.x).
    #[test]
    fn parses_the_version_lines_the_recipes_were_verified_against() {
        assert_eq!(parse_version("2.1.263 (Claude Code)").as_deref(), Some("2.1.263"));
        assert_eq!(parse_version("codex-cli 0.153.4").as_deref(), Some("0.153.4"));
        assert_eq!(
            parse_version("0.0.393 Commit: ea52078").as_deref(),
            Some("0.0.393")
        );
        assert_eq!(
            parse_version("GitHub Copilot CLI 1.0.88.").as_deref(),
            Some("1.0.88")
        );
        assert_eq!(parse_version("1.2.9").as_deref(), Some("1.2.9"));
        assert_eq!(
            parse_version("Muse Code 1.3.0 (1.3.0-R3057.1)").as_deref(),
            Some("1.3.0")
        );
    }

    #[test]
    fn a_probe_env_belongs_to_an_agent_with_a_recipe() {
        for (agent, _) in VERSION_ENV {
            assert!(is_supported(agent), "{agent} has a probe env but no recipe");
        }
        assert_eq!(version_env("muse"), &[("MUSE_NO_AUTO_UPDATE", "1")]);
        assert!(version_env("claude").is_empty());
    }

    #[test]
    fn accepts_a_v_prefix_and_a_prerelease_suffix() {
        assert_eq!(parse_version("v1.2.3").as_deref(), Some("1.2.3"));
        assert_eq!(parse_version("mytool 1.2.3-beta.1").as_deref(), Some("1.2.3-beta.1"));
        assert_eq!(parse_version("1.2").as_deref(), Some("1.2"));
    }

    #[test]
    fn refuses_what_is_not_a_version() {
        // A bare number is a build counter or a hash, not a version.
        assert_eq!(parse_version("build 12345"), None);
        assert_eq!(parse_version("ea52078"), None);
        assert_eq!(parse_version(""), None);
        // A number from halfway down a changelog is not the version either.
        let notice = "up to date\nchangelog:\nrecent releases:\n- 9.9.9 fixed everything";
        assert_eq!(parse_version(notice), None);
    }

    #[test]
    fn a_version_prefixed_by_an_update_notice_still_parses() {
        assert_eq!(
            parse_version("A new release is available.\n2.1.263 (Claude Code)").as_deref(),
            Some("2.1.263")
        );
    }

    #[test]
    fn orders_components_numerically_not_lexically() {
        use std::cmp::Ordering;
        // The whole reason not to compare strings: "10" < "9" lexically.
        assert_eq!(version_cmp("0.153.10", "0.153.9"), Ordering::Greater);
        assert_eq!(version_cmp("2.1.263", "2.1.251"), Ordering::Greater);
        assert_eq!(version_cmp("1.2", "1.2.3"), Ordering::Less);
        assert_eq!(version_cmp("1.2.3", "1.2.3"), Ordering::Equal);
    }

    #[test]
    fn drift_names_every_stale_check_oldest_first() {
        // Checks made at different releases, listed out of order. Installed
        // 0.153.4 matches one, has moved past two and predates the last; the
        // oldest baseline sorts first.
        static TABLE: &[Verified] = &[
            Verified { agent: "codex", version: "0.154.0", surface: "§1.2 — d" },
            Verified { agent: "codex", version: "0.151.0", surface: "§1.2 — a" },
            Verified { agent: "codex", version: "0.153.4", surface: "§1.2 — c" },
            Verified { agent: "codex", version: "0.153.0", surface: "§1.2 — b" },
            Verified { agent: "claude", version: "9.9.9", surface: "§1.1" },
        ];
        let (state, stale) = drift_in(TABLE, "codex", Some("0.153.4"));
        assert_eq!(state, DriftState::Moved);
        assert_eq!(stale.len(), 3);
        assert_eq!(stale[0].version, "0.151.0");
        assert_eq!(stale[0].direction, Direction::Newer);
        assert_eq!(stale[2].version, "0.154.0");
        assert_eq!(stale[2].direction, Direction::Older);
        assert!(stale.iter().all(|note| note.surface.contains("§1.2")));
    }

    #[test]
    fn codex_drift_uses_the_current_verified_release() {
        // An older install names every surface; the checked release is quiet,
        // and the next release raises all four again.
        let (state, stale) = drift("codex", Some("0.153.4"));
        assert_eq!(state, DriftState::Moved);
        assert_eq!(stale.len(), 4);
        assert!(stale.iter().all(|note| note.direction == Direction::Older));
        let (state, stale) = drift("codex", Some("0.159.3"));
        assert_eq!(state, DriftState::Match);
        assert!(stale.is_empty());
        let (state, stale) = drift("codex", Some("0.159.4"));
        assert_eq!(state, DriftState::Moved);
        assert_eq!(stale.len(), 4);
        assert!(stale.iter().all(|note| note.version == "0.159.3" && note.direction == Direction::Newer));
    }

    #[test]
    fn an_older_install_is_drift_too() {
        let (state, stale) = drift("claude", Some("2.0.0"));
        assert_eq!(state, DriftState::Moved);
        assert_eq!(stale[0].direction, Direction::Older);
    }

    #[test]
    fn matching_every_note_is_a_match_and_no_notes_is_unverified() {
        assert_eq!(drift("claude", Some("2.1.292")).0, DriftState::Match);
        // `muse` has a recipe but no recorded check — the honest answer is
        // "nobody has verified this", not a tick.
        assert_eq!(drift("muse", Some("1.3.0")).0, DriftState::Unverified);
        assert_eq!(drift("claude", None).0, DriftState::Unknown);
    }

    #[test]
    fn every_verified_note_names_an_agent_that_can_be_asked() {
        // A baseline for an agent with no recipe could never be compared
        // against anything, so it would be a note nothing reads.
        for note in VERIFIED {
            assert!(
                is_supported(note.agent),
                "{} has a verified note but no version recipe",
                note.agent
            );
        }
    }

    #[test]
    fn version_text_prefers_stdout_and_accepts_stderr() {
        assert_eq!(version_text("1.2.3\n", "", Some(0)).unwrap(), "1.2.3");
        // Some CLIs print the version to stderr and still exit 0.
        assert_eq!(version_text("", "1.2.3", Some(0)).unwrap(), "1.2.3");
        // A non-zero exit is a failure whatever it printed.
        assert!(version_text("1.2.3", "boom", Some(1)).is_err());
        assert!(version_text("", "", None).is_err());
    }

    #[test]
    fn version_text_strips_ansi_and_bounds_the_line() {
        assert_eq!(
            version_text("\u{1b}[32m1.2.3\u{1b}[0m", "", Some(0)).unwrap(),
            "1.2.3"
        );
        let flood = "x".repeat(MAX_VERSION_TEXT * 2);
        let bounded = version_text(&flood, "", Some(0)).unwrap();
        assert!(bounded.len() <= MAX_VERSION_TEXT + 4);
        assert!(bounded.ends_with('…'));
    }

    #[test]
    fn a_probe_keeps_the_dismissal_and_a_new_version_revives_the_notice() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_versions.json");

        remember_in(&path, "claude", Ok("2.1.251 (Claude Code)".to_string()));
        dismiss_in(&path, "claude", "2.1.251");
        let seen = load_in(&path)["claude"].clone();
        assert!(VersionReport::from_seen("claude", "Claude", &seen, true).dismissed);

        // The CLI moves: the marker survives the write but no longer matches,
        // so the notice comes back exactly once per new release.
        remember_in(&path, "claude", Ok("2.1.263 (Claude Code)".to_string()));
        let seen = load_in(&path)["claude"].clone();
        assert_eq!(seen.dismissed.as_deref(), Some("2.1.251"));
        let report = VersionReport::from_seen("claude", "Claude", &seen, true);
        assert!(!report.dismissed);
        assert_eq!(report.state, DriftState::Moved);
    }

    #[test]
    fn a_failed_probe_is_recorded_as_an_error_not_as_a_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent_versions.json");
        remember_in(&path, "codex", Err("did not answer within 5s".to_string()));
        let seen = load_in(&path)["codex"].clone();
        assert!(seen.version.is_none());
        assert_eq!(seen.error.as_deref(), Some("did not answer within 5s"));
        assert_eq!(
            VersionReport::from_seen("codex", "Codex", &seen, true).state,
            DriftState::Unknown
        );
    }

    #[test]
    fn freshness_is_the_ttl() {
        let seen = Seen {
            checked_at: now_secs(),
            ..Default::default()
        };
        assert!(fresh(&seen, PROBE_TTL));
        let stale = Seen {
            checked_at: now_secs().saturating_sub(PROBE_TTL.as_secs() + 1),
            ..Default::default()
        };
        assert!(!fresh(&stale, PROBE_TTL));
    }

    #[test]
    fn replacing_an_executable_invalidates_its_cached_version() {
        let dir = tempfile::tempdir().unwrap();
        let executable = dir.path().join("codex");
        std::fs::write(&executable, "old binary").unwrap();
        let seen = Seen {
            checked_at: now_secs(),
            source: version_source(&executable),
            ..Default::default()
        };
        assert!(fresh_for_path(&seen, PROBE_TTL, &executable));
        assert!(!fresh_for_path(
            &Seen { source: None, ..seen.clone() },
            PROBE_TTL,
            &executable
        ));
        std::fs::write(&executable, "newer, longer binary").unwrap();
        assert!(!fresh_for_path(&seen, PROBE_TTL, &executable));
    }

    #[test]
    fn a_missing_store_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_in(&dir.path().join("nope.json")).is_empty());
    }
}
