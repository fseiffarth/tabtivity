//! Would a respawn resume the tab's own conversation? The check the window's
//! stop sweep asks before it ends an idle agent tab's process
//! (`docs/done/agent_tab_stop_plan.md` §5.1, `src/stores/agents/agentTabStop.ts`):
//! a stopped tab comes back on its restore args, and each CLI's spawn-time
//! resolver (`agent_session::resolve_agent_session`) turns those into a resume
//! of the tab's recorded conversation only while that record exists and the
//! CLI still has the conversation. Otherwise the respawn starts fresh, or — for
//! the CLIs restored on `--continue` — opens the folder's newest conversation,
//! which may be another tab's. Such a tab is never stopped.
//!
//! Each arm reads exactly what its resolver reads, and nothing is written: no
//! hook is registered and no launch note left, so asking is free of the
//! spawn's side effects. Local, cloud tabs only (a local-model, remote or
//! assistant tab is never stopped).

use std::path::Path;

use crate::services::agent_home::scope_home;
use crate::services::agent_session::{self, is_uuid_shaped, read_live_session_for};

/// Whether the tab of `agent` (its binary) keyed `uid` (its `sessionId`, the
/// `TAB_UID` of its spawn), working in `cwd`, would on a respawn now resume the
/// conversation it is in. `false` for anything not known to: an unknown CLI,
/// a key of the wrong shape, a tab with no conversation recorded yet.
pub fn resume_pinned(agent: &str, project_id: Option<&str>, uid: &str, cwd: &str) -> bool {
    if !is_uuid_shaped(uid) {
        return false;
    }
    match agent {
        "claude" => {
            let roots = agent_session::claude_projects_roots(project_id);
            claude_pinned(read_live_session_for(project_id, uid), uid, |id| {
                roots.iter().any(|root| agent_session::claude_session_exists(root, id))
            })
        }
        "codex" => {
            let sessions = agent_session::codex_sessions_root(project_id);
            let stores = crate::services::codex_store::state_dbs(Some(project_id.unwrap_or(crate::storage::ROOT_SCOPE)));
            recorded_pinned(read_live_session_for(project_id, uid), |id| {
                agent_session::codex_session_exists_in(&sessions, stores.iter().map(|p| p.as_path()), id)
            })
        }
        "vibe" => {
            let home = scope_home(project_id).join(".vibe");
            recorded_pinned(read_live_session_for(project_id, uid), |id| agent_session::vibe_session_exists(&home, id))
        }
        "opencode" => crate::services::opencode_session::resume_pinned(project_id, uid),
        // Copilot is always launched onto `--session-id <its record, else its
        // key>`, never the folder's latest: pinned once that session has events.
        "copilot" => crate::services::copilot_session::tab_events(project_id, uid).is_some(),
        "agy" => {
            Path::new(cwd).is_absolute()
                && crate::services::google_chat::recorded_tab_conversation(&scope_home(project_id), cwd, project_id, uid).is_some()
        }
        "muse" => {
            Path::new(cwd).is_absolute()
                && crate::services::muse_session::recorded_tab_session(&scope_home(project_id), cwd, project_id, uid).is_some()
        }
        "cursor-agent" => {
            Path::new(cwd).is_absolute()
                && crate::services::cursor_session::recorded_tab_session(&scope_home(project_id), cwd, project_id, uid).is_some()
        }
        _ => false,
    }
}

/// Claude's rule (`resolve_claude_session_in`), strict: the conversation the
/// tab is in now is the live record's when there is one, else its launch id;
/// pinned only when Claude has that one's log. A record whose log is missing
/// (a `/clear` not yet prompted) would resume the conversation before it, so
/// it is not pinned.
fn claude_pinned(live: Option<String>, launch: &str, exists: impl Fn(&str) -> bool) -> bool {
    match live {
        Some(id) => exists(&id),
        None => exists(launch),
    }
}

/// The hook-record CLIs' rule (Codex, Vibe): pinned while a record exists and
/// the CLI still has that conversation.
fn recorded_pinned(live: Option<String>, exists: impl Fn(&str) -> bool) -> bool {
    live.is_some_and(|id| exists(&id))
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "0b9c6a52-5d55-4c3e-9f57-3f2b1a0c9d11";
    const CLEARED: &str = "1c2d3e4f-0000-4000-8000-000000000001";

    #[test]
    fn claude_follows_the_live_record_and_wants_its_log() {
        let has = |ids: &'static [&'static str]| move |id: &str| ids.contains(&id);
        // Never prompted: no log under the key.
        assert!(!claude_pinned(None, KEY, has(&[])));
        // Prompted, no clear yet.
        assert!(claude_pinned(None, KEY, has(&[KEY])));
        assert!(claude_pinned(Some(KEY.into()), KEY, has(&[KEY])));
        // After a /clear the live session is the one that counts…
        assert!(claude_pinned(Some(CLEARED.into()), KEY, has(&[KEY, CLEARED])));
        // …and while it has no log the respawn would reopen the cleared one.
        assert!(!claude_pinned(Some(CLEARED.into()), KEY, has(&[KEY])));
    }

    #[test]
    fn a_hook_record_cli_wants_a_record_the_cli_still_has() {
        assert!(!recorded_pinned(None, |_| true));
        assert!(!recorded_pinned(Some(CLEARED.into()), |_| false));
        assert!(recorded_pinned(Some(CLEARED.into()), |id| id == CLEARED));
    }

    #[test]
    fn an_unknown_cli_or_a_bad_key_is_never_pinned() {
        for agent in ["gemini", "grok", "qwen", "droid", "aider", "my-agent"] {
            assert!(!resume_pinned(agent, Some("p"), KEY, ""), "{agent}");
        }
        assert!(!resume_pinned("claude", Some("p"), "../../etc", ""));
        assert!(!resume_pinned("codex", Some("p"), "", ""));
    }

    #[test]
    fn a_folder_cli_needs_an_absolute_working_folder() {
        assert!(!resume_pinned("agy", Some("p"), KEY, "relative"));
        assert!(!resume_pinned("muse", Some("p"), KEY, ""));
        assert!(!resume_pinned("cursor-agent", Some("p"), KEY, ""));
    }
}
