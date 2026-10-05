//! Prompts and schedules a paired phone left behind, checked against what
//! that phone may still reach (#2348, threat model gap 14).
//!
//! Every rule a phone makes in `agent_tasks.json` — a schedule it created, a
//! collected prompt it sent, a prompt it held while the agent worked —
//! carries its device id (`ScheduledAgentPrompt::phone_device`). Revoking the
//! phone, Lock down (every phone at once), or a per-phone list or Mobile
//! switch that no longer lets it reach the scope cancels those rules:
//!
//! - **eagerly**, where the change lands: the sidecar's admin plane (revoke,
//!   forget all), the window's `mobile_admin` and its project/box Mobile
//!   access commands, and the sidecar's scheduler when it starts;
//! - **at fire time**, in `agent_tasks`' claim, which both owners take before
//!   typing anything: a rule whose phone no longer reaches its scope is taken
//!   out instead of claimed. This is the backstop for a change made while
//!   the other owner was down, or by hand.
//!
//! The access rule is the catalog's own (`discovery::ScopeAccess`) plus the
//! paired-device list (`auth::read_paired_devices`); nothing here restates
//! it. A rule with no device — the desktop's, an agent's, or a phone's
//! written before the field existed — is of unknown origin and left alone.
//! An access that cannot be read is not taken as granted: the rule is held
//! back (not typed, not removed) until it can.

use std::collections::HashSet;
use std::path::Path;

use super::{auth, discovery::ScopeAccess};
use crate::services::agent_tasks::{self, CancelledRule};

/// What a phone may still reach: whether it is paired at all, and the
/// catalog's scopes with their per-phone lists.
pub struct PhoneAccess {
    paired: HashSet<String>,
    /// `Err` when the scope files cannot be read: a phone that is still
    /// paired then reaches nothing that can be told.
    scopes: Result<ScopeAccess, String>,
}

impl PhoneAccess {
    pub fn load(state_dir: &Path) -> Result<Self, String> {
        let paired = auth::read_paired_devices(&state_dir.join("mobile-control"))?
            .into_iter()
            .map(|device| device.id)
            .collect();
        Ok(Self { paired, scopes: ScopeAccess::load(state_dir) })
    }

    /// Whether the phone paired as `device_id` still reaches the scope
    /// `raw_id`. An unpaired phone reaches nothing, whatever the scopes say.
    pub fn reaches(&self, device_id: &str, raw_id: &str) -> Result<bool, String> {
        if !self.paired.contains(device_id) {
            return Ok(false);
        }
        match &self.scopes {
            Ok(scopes) => scopes.reaches(raw_id, device_id),
            Err(why) => Err(why.clone()),
        }
    }
}

/// [`PhoneAccess::reaches`] read fresh from `state_dir` — the claim's check.
pub fn reaches(state_dir: &Path, device_id: &str, raw_id: &str) -> Result<bool, String> {
    PhoneAccess::load(state_dir)?.reaches(device_id, raw_id)
}

/// Cancel every phone-made rule of `state_dir` whose phone no longer reaches
/// its scope — the sidecar's half, under the file's lock alone. `why` words
/// the log line (`"after a revoke"`).
pub fn sweep_in(state_dir: &Path, why: &str) -> Result<Vec<CancelledRule>, String> {
    let access = PhoneAccess::load(state_dir)?;
    let cancelled = agent_tasks::cancel_phone_rules_in(&agent_tasks::file_path(state_dir), |device, raw_id| {
        access.reaches(device, raw_id)
    })?;
    log_cancelled(&cancelled, why);
    Ok(cancelled)
}

/// [`sweep_in`] from the window, under its in-process lock too.
pub fn sweep(state_dir: &Path, why: &str) -> Result<Vec<CancelledRule>, String> {
    let access = PhoneAccess::load(state_dir)?;
    let cancelled = agent_tasks::cancel_phone_rules(&agent_tasks::file_path(state_dir), |device, raw_id| {
        access.reaches(device, raw_id)
    })?;
    log_cancelled(&cancelled, why);
    Ok(cancelled)
}

/// One line per cancellation pass: the journal is where a prompt that was
/// never typed can be accounted for.
pub fn log_cancelled(cancelled: &[CancelledRule], why: &str) {
    if cancelled.is_empty() {
        return;
    }
    let ids: Vec<String> = cancelled
        .iter()
        .map(|rule| format!("{}/{}/{}", rule.project_id, rule.target_id, rule.schedule_id))
        .collect();
    eprintln!(
        "{}: cancelled {} prompt(s) or schedule(s) a phone made, {why}: the phone was revoked or no longer reaches the scope ({})",
        crate::app_slug!(),
        cancelled.len(),
        ids.join(", ")
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::agent_tasks::{AgentScheduleRule, AgentTasksFile, ScheduledAgentPrompt};
    use chrono::Local;
    use serde_json::json;

    const PHONE_A: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const PHONE_B: &str = "BBBBBBBBBBBBBBBBBBBBBBBBBBB";

    fn write(path: &Path, value: &serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    /// Paired phones, as the host's `devices.json` holds them.
    fn pair(state_dir: &Path, phones: &[&str]) {
        let devices: Vec<_> = phones
            .iter()
            .map(|id| json!({ "id": id, "name": "Phone", "public_key": "k", "created_at": 1, "last_seen_at": null }))
            .collect();
        write(&state_dir.join("mobile-control/devices.json"), &json!({ "schema": 1, "devices": devices }));
    }

    /// Two opted-in local projects: `p-all` open to every phone, `p-list`
    /// to the phones in `list`.
    fn scopes(state_dir: &Path, list: &[&str]) {
        let project = |id: &str, devices: Option<&[&str]>| {
            let mut row = json!({ "id": id, "name": id, "directory": state_dir.join(id), "status": "active" });
            row[crate::brand::MOBILE_ACCESS_KEY] = json!(true);
            if let Some(devices) = devices {
                row[crate::brand::MOBILE_DEVICES_KEY] = json!(devices);
            }
            row
        };
        write(&state_dir.join("projects.json"), &json!([project("p-all", None), project("p-list", Some(list))]));
    }

    fn rule(id: &str, rule: AgentScheduleRule, phone: Option<&str>) -> ScheduledAgentPrompt {
        ScheduledAgentPrompt {
            id: id.into(),
            enabled: true,
            message: format!("prompt {id}"),
            rule,
            preface: Vec::new(),
            last: None,
            origin: None,
            phone_device: phone.map(str::to_string),
        }
    }

    fn now_key() -> String {
        Local::now().format("%Y-%m-%dT%H:%M").to_string()
    }

    /// In each project, on target `t`: a held prompt of phone A, a daily
    /// schedule of phone A, one of phone B, a desktop rule and a phone rule
    /// written before the field existed.
    fn seed(state_dir: &Path) {
        let path = agent_tasks::file_path(state_dir);
        for project in ["p-all", "p-list"] {
            let rules = [
                rule("a-held", AgentScheduleRule::Once { at: now_key() }, Some(PHONE_A)),
                rule("a-daily", AgentScheduleRule::Daily { time: "09:00".into() }, Some(PHONE_A)),
                rule("b-daily", AgentScheduleRule::Daily { time: "09:00".into() }, Some(PHONE_B)),
                rule("desk", AgentScheduleRule::Daily { time: "09:00".into() }, None),
            ];
            for row in rules {
                agent_tasks::upsert_in(&path, project, "t", row, None).unwrap();
            }
        }
        // An old phone rule: the raw JSON an earlier build wrote, no device.
        let mut file: AgentTasksFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let old: ScheduledAgentPrompt = serde_json::from_value(json!({
            "id": "old", "enabled": true, "message": "from before",
            "rule": { "type": "once", "at": now_key() },
        }))
        .unwrap();
        assert_eq!(old.phone_device, None);
        file.projects.get_mut("p-list").unwrap().get_mut("t").unwrap().schedules.push(old);
        std::fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();
    }

    fn ids(state_dir: &Path, project: &str) -> Vec<String> {
        agent_tasks::list_at(state_dir, project, "t").unwrap().into_iter().map(|rule| rule.id).collect()
    }

    #[test]
    fn a_revoke_cancels_that_phones_rules_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A, PHONE_B]);
        pair(dir.path(), &[PHONE_A, PHONE_B]);
        seed(dir.path());
        assert!(sweep_in(dir.path(), "test").unwrap().is_empty(), "nothing lost, nothing cancelled");

        pair(dir.path(), &[PHONE_B]);
        let cancelled = sweep_in(dir.path(), "after a revoke").unwrap();
        assert_eq!(cancelled.len(), 4, "A's held prompt and schedule in both projects: {cancelled:?}");
        assert!(cancelled.iter().all(|rule| rule.schedule_id.starts_with("a-")));
        assert_eq!(ids(dir.path(), "p-all"), ["b-daily", "desk"]);
        assert_eq!(ids(dir.path(), "p-list"), ["b-daily", "desk", "old"], "another phone's, the desktop's and an old rule stay");
    }

    #[test]
    fn lock_down_cancels_every_phones_rules_but_no_desktop_or_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A, PHONE_B]);
        pair(dir.path(), &[PHONE_A, PHONE_B]);
        seed(dir.path());
        // Forget all leaves an empty device list behind.
        pair(dir.path(), &[]);
        assert_eq!(sweep_in(dir.path(), "after Lock down").unwrap().len(), 6);
        assert_eq!(ids(dir.path(), "p-all"), ["desk"]);
        assert_eq!(ids(dir.path(), "p-list"), ["desk", "old"]);
    }

    #[test]
    fn narrowing_cancels_only_the_scopes_a_phone_lost() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A, PHONE_B]);
        pair(dir.path(), &[PHONE_A, PHONE_B]);
        seed(dir.path());

        // `p-list` now open to phone B alone: A keeps `p-all`.
        scopes(dir.path(), &[PHONE_B]);
        let cancelled = sweep(dir.path(), "after an access change").unwrap();
        assert_eq!(
            cancelled.iter().map(|rule| (rule.project_id.as_str(), rule.schedule_id.as_str())).collect::<Vec<_>>(),
            [("p-list", "a-held"), ("p-list", "a-daily")]
        );
        assert_eq!(ids(dir.path(), "p-all"), ["a-held", "a-daily", "b-daily", "desk"]);

        // Mobile switched off for `p-all`: every phone loses it.
        let mut projects: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.path().join("projects.json")).unwrap()).unwrap();
        projects[0][crate::brand::MOBILE_ACCESS_KEY] = json!(false);
        write(&dir.path().join("projects.json"), &projects);
        assert_eq!(sweep_in(dir.path(), "test").unwrap().len(), 3);
        assert_eq!(ids(dir.path(), "p-all"), ["desk"]);
    }

    #[test]
    fn an_access_that_cannot_be_read_cancels_nothing() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A]);
        pair(dir.path(), &[PHONE_A, PHONE_B]);
        seed(dir.path());
        std::fs::write(dir.path().join("projects.json"), b"{ not json").unwrap();
        // Paired phones with unreadable scopes: unknown, so nothing goes.
        assert!(sweep_in(dir.path(), "test").unwrap().is_empty());
        assert_eq!(reaches(dir.path(), PHONE_A, "p-all").map_err(|_| ()), Err(()));
        // An unpaired phone reaches nothing whatever the scopes say.
        assert_eq!(reaches(dir.path(), "CCCCCCCCCCCCCCCCCCCCCCCCCCC", "p-all"), Ok(false));
    }

    /// The catalog lists no box when `boxes.json` is unreadable and no root
    /// when `settings.json` is; for a rule that would be removed, that is
    /// unknown, not "lost" — while a missing file still is "none".
    #[test]
    fn an_unreadable_box_or_root_file_holds_its_phone_rules_back() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A]);
        pair(dir.path(), &[PHONE_A]);
        assert_eq!(reaches(dir.path(), PHONE_A, "box:b1"), Ok(false), "no boxes.json: no box");
        assert_eq!(reaches(dir.path(), PHONE_A, "root"), Ok(false), "no settings.json: root is off");
        std::fs::write(dir.path().join("boxes.json"), b"[ torn").unwrap();
        std::fs::write(dir.path().join("settings.json"), b"{ torn").unwrap();
        assert!(reaches(dir.path(), PHONE_A, "box:b1").is_err());
        assert!(reaches(dir.path(), PHONE_A, "root").is_err());
        assert_eq!(reaches(dir.path(), PHONE_A, "p-all"), Ok(true), "projects still answer");
        assert_eq!(reaches(dir.path(), PHONE_A, "gone"), Ok(false));

        let path = agent_tasks::file_path(dir.path());
        for scope in ["box:b1", "root"] {
            agent_tasks::upsert_in(&path, scope, "t", rule("held", AgentScheduleRule::Once { at: now_key() }, Some(PHONE_A)), None).unwrap();
        }
        assert!(sweep_in(dir.path(), "test").unwrap().is_empty());
        assert_eq!(agent_tasks::claim_in(&path, "box:b1", "t", "held", &now_key(), Local::now()), Ok(false));
        assert_eq!(ids(dir.path(), "box:b1"), ["held"], "held back, not removed");
        assert_eq!(ids(dir.path(), "root"), ["held"]);
    }

    /// The backstop: a revoke the sweep never saw (the owner was down) still
    /// stops the rule at the claim — taken out, never claimed — while
    /// another phone's, the desktop's and an old rule fire as before.
    #[test]
    fn the_claim_drops_a_revoked_phones_rule_instead_of_firing_it() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A, PHONE_B]);
        pair(dir.path(), &[PHONE_B]);
        seed(dir.path());
        let path = agent_tasks::file_path(dir.path());
        let key = now_key();
        let now = Local::now();

        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "a-held", &key, now), Ok(false));
        assert!(!ids(dir.path(), "p-all").contains(&"a-held".to_string()), "taken out, not left to retry");
        assert_eq!(agent_tasks::claim_in(&path, "p-list", "t", "a-daily", "2026-10-04T09:00", now), Ok(false));
        assert!(!ids(dir.path(), "p-list").contains(&"a-daily".to_string()));

        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "b-daily", "2026-10-04T09:00", now), Ok(true));
        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "desk", "2026-10-04T09:00", now), Ok(true));
        assert_eq!(agent_tasks::claim_in(&path, "p-list", "t", "old", &key, now), Ok(true), "an old rule loads and fires");

        // Narrowed, not revoked: B loses `p-list` only.
        scopes(dir.path(), &[]);
        assert_eq!(agent_tasks::claim_in(&path, "p-list", "t", "b-daily", "2026-10-05T09:00", now), Ok(false));
        assert!(!ids(dir.path(), "p-list").contains(&"b-daily".to_string()));
        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "b-daily", "2026-10-05T09:00", now), Ok(true), "B keeps `p-all`");
    }

    #[test]
    fn an_unreadable_access_holds_a_phone_rule_back_without_removing_it() {
        let dir = tempfile::tempdir().unwrap();
        scopes(dir.path(), &[PHONE_A]);
        pair(dir.path(), &[PHONE_A]);
        seed(dir.path());
        std::fs::write(dir.path().join("projects.json"), b"[").unwrap();
        let path = agent_tasks::file_path(dir.path());
        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "a-held", &now_key(), Local::now()), Ok(false));
        assert!(ids(dir.path(), "p-all").contains(&"a-held".to_string()));
        assert_eq!(agent_tasks::claim_in(&path, "p-all", "t", "desk", "2026-10-04T09:00", Local::now()), Ok(true));
    }

    /// An edit keeps the phone a rule came from; a write cannot invent a
    /// malformed one.
    #[test]
    fn an_edit_keeps_the_phone_and_a_bad_device_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = agent_tasks::file_path(dir.path());
        agent_tasks::upsert_in(&path, "p", "t", rule("r", AgentScheduleRule::Daily { time: "09:00".into() }, Some(PHONE_A)), None).unwrap();
        let edited = ScheduledAgentPrompt { message: "new words".into(), phone_device: None, ..rule("r", AgentScheduleRule::Daily { time: "10:00".into() }, None) };
        let rows = agent_tasks::upsert_in(&path, "p", "t", edited, Some("t")).unwrap();
        assert_eq!(rows[0].phone_device.as_deref(), Some(PHONE_A));
        assert_eq!(rows[0].message, "new words");
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["projects"]["p"]["t"]["schedules"][0]["phone_device"], PHONE_A);
        assert!(agent_tasks::upsert_in(&path, "p", "t", rule("x", AgentScheduleRule::Daily { time: "09:00".into() }, Some("bad\u{7}")), None).is_err());
    }
}
