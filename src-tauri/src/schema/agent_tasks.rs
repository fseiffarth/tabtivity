//! `agent_tasks.json`: scheduled agent prompts per agent tab, their claims and
//! delivery budget.
//!
//! Every struct here but the IPC-only target binding is persisted, and a
//! state file outlives the build that
//! wrote it: a packaged Tabtivity, a frozen `package:dev` snapshot and a dev
//! window all read the same file, so the newest of them adding one optional
//! field would otherwise make every older build reject the whole file with
//! `unknown field ...` and show the user no schedules at all. So none of
//! them `deny_unknown_fields`, and each persisted struct keeps what it does
//! not know in a `#[serde(flatten)] extra` map (as `Project` does): an older
//! build loads the entry and writes the newer fields back untouched. Those
//! maps hold only what the file held — the edit boundary
//! (`services::agent_tasks::apply_upsert`) never takes them from a caller. An
//! unknown rule *variant* (`type`) still fails, since the rule is an
//! internally tagged enum, and an unknown field *inside* a rule is dropped
//! (the variants carry no map).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentScheduleRule {
    Once { at: String },
    Daily { time: String },
    Weekdays { weekdays: Vec<u8>, time: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentScheduleResult {
    Delivered,
    Missed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentScheduleLastRun {
    pub occurrence: String,
    pub result: AgentScheduleResult,
    pub at: String,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduledAgentPrompt {
    pub id: String,
    pub enabled: bool,
    pub message: String,
    pub rule: AgentScheduleRule,
    /// Slash commands submitted to the agent one at a time, in order, BEFORE
    /// `message` — the composer's prefix chips and its `/model <name>` pick.
    /// They are separate submissions rather than extra lines of `message`
    /// because a CLI's `/clear` or `/model` takes the whole line: appending the
    /// prompt to it would make the command swallow the prompt instead of
    /// running. Empty for every schedule written before the composer existed,
    /// which is why it defaults rather than being required.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preface: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<AgentScheduleLastRun>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<ScheduleOrigin>,
    /// The paired phone that made this rule — a schedule it created, a
    /// collected prompt it sent, a prompt it held — or last edited it (a
    /// phone's edit takes a desktop or agent rule over; the collected prompt a
    /// phone wrote carries it into the rule the desktop sends), by the device
    /// id the sidecar knows it as (never a secret). A rule whose phone is
    /// revoked, or no longer reaches the scope, is cancelled rather than typed
    /// (`mobile_control::phone_origin`). Absent on every rule only the desktop
    /// or an agent touched, and on phone rules written before it existed:
    /// those are of unknown origin and left alone. A desktop edit keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone_device: Option<String>,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleAuthor { Agent }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleOrigin {
    pub by: ScheduleAuthor,
    pub session: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_delivery: Option<String>,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// Kept independently of retired rules; claims reserve budget before any PTY write.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentScheduleDelivery {
    pub id: String,
    pub day: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentScheduleResult>,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentPromptTarget {
    #[serde(default)]
    pub schedules: Vec<ScheduledAgentPrompt>,
    /// Latest atomically claimed occurrence by schedule id. Claims intentionally
    /// survive a crash: an occurrence whose first input write may have happened
    /// is never retried after a reload.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub claims: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_deliveries: Vec<AgentScheduleDelivery>,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn agent_tasks_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTasksFile {
    #[serde(default = "agent_tasks_version")]
    pub version: u8,
    #[serde(default)]
    pub projects: BTreeMap<String, BTreeMap<String, AgentPromptTarget>>,
    /// Fields a newer build wrote that this one does not know: kept and
    /// written back untouched (see the module doc).
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for AgentTasksFile {
    fn default() -> Self {
        Self {
            version: agent_tasks_version(),
            projects: BTreeMap::new(),
            extra: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScheduleTargetBinding {
    pub project_id: String,
    pub schedule_target_id: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).expect("serialize")
    }

    /// Rules are tagged by `type` in snake_case: an unknown or miscased
    /// `type` fails. A field the rule does not know is dropped rather than
    /// failing the file (a newer build may have added it; see the module doc).
    #[test]
    fn schedule_rules_are_type_tagged_and_strict_about_the_type() {
        let daily: AgentScheduleRule = serde_json::from_str(r#"{"type":"daily","time":"09:00"}"#).unwrap();
        assert_eq!(daily, AgentScheduleRule::Daily { time: "09:00".into() });
        assert_eq!(json(&daily), serde_json::json!({"type":"daily","time":"09:00"}));

        let weekdays: AgentScheduleRule =
            serde_json::from_str(r#"{"type":"weekdays","weekdays":[1,3,5],"time":"07:30"}"#).unwrap();
        assert_eq!(
            weekdays,
            AgentScheduleRule::Weekdays { weekdays: vec![1, 3, 5], time: "07:30".into() }
        );
        let once = AgentScheduleRule::Once { at: "2026-09-16T08:00".into() };
        assert_eq!(json(&once)["type"], "once");

        let extra: AgentScheduleRule =
            serde_json::from_str(r#"{"type":"once","at":"x","time":"y"}"#).unwrap();
        assert_eq!(extra, AgentScheduleRule::Once { at: "x".into() });
        assert!(serde_json::from_str::<AgentScheduleRule>(r#"{"type":"hourly"}"#).is_err());
        assert!(serde_json::from_str::<AgentScheduleRule>(r#"{"type":"Daily","time":"09:00"}"#).is_err());
    }

    /// A schedule written before the composer existed has no `preface`; it
    /// loads as empty and the empty list is not written back. `last` likewise.
    #[test]
    fn a_pre_composer_schedule_loads_and_writes_back_without_preface_or_last() {
        let raw = r#"{"id":"s1","enabled":true,"message":"run tests",
                      "rule":{"type":"daily","time":"09:00"}}"#;
        let s: ScheduledAgentPrompt = serde_json::from_str(raw).unwrap();
        assert!(s.preface.is_empty());
        assert!(s.last.is_none());
        let out = json(&s);
        assert!(out.get("preface").is_none());
        assert!(out.get("last").is_none());

        let with: ScheduledAgentPrompt = serde_json::from_str(
            r#"{"id":"s2","enabled":false,"message":"m","rule":{"type":"once","at":"t"},
                "preface":["/clear","/model opus"],
                "last":{"occurrence":"2026-09-15T09:00","result":"missed","at":"2026-09-15T09:01"}}"#,
        )
        .unwrap();
        assert_eq!(with.preface, vec!["/clear", "/model opus"]);
        assert_eq!(with.last.as_ref().unwrap().result, AgentScheduleResult::Missed);
        assert_eq!(json(&AgentScheduleResult::Delivered), "delivered");
        assert_eq!(json(&AgentScheduleResult::Failed), "failed");
        assert!(serde_json::from_str::<ScheduledAgentPrompt>(
            r#"{"id":"s","enabled":true,"message":"m","rule":{"type":"once","at":"t"},"nope":1}"#
        )
        .is_ok());
    }

    /// An empty file is a valid file: version 1, no projects. Claims are only
    /// written once one exists, and they survive the round trip (they must —
    /// a claim that vanished on reload would retry an occurrence).
    #[test]
    fn the_tasks_file_defaults_to_version_one_and_keeps_claims() {
        let empty: AgentTasksFile = serde_json::from_str("{}").unwrap();
        assert_eq!(empty.version, 1);
        assert!(empty.projects.is_empty());
        assert_eq!(json(&AgentTasksFile::default()), serde_json::json!({"version":1,"projects":{}}));

        let target: AgentPromptTarget = serde_json::from_str(r#"{"schedules":[]}"#).unwrap();
        assert!(json(&target).get("claims").is_none());
        let claimed: AgentPromptTarget = serde_json::from_str(
            r#"{"schedules":[],"claims":{"s1":"2026-09-15T09:00"}}"#,
        )
        .unwrap();
        let back: AgentPromptTarget = serde_json::from_value(json(&claimed)).unwrap();
        assert_eq!(back.claims["s1"], "2026-09-15T09:00");

        assert!(serde_json::from_str::<AgentTasksFile>(r#"{"version":1,"projects":{},"extra":1}"#).is_ok());
        let nested: AgentTasksFile = serde_json::from_str(
            r#"{"projects":{"p1":{"tab-a":{"schedules":[]}}}}"#,
        )
        .unwrap();
        assert!(nested.projects["p1"]["tab-a"].schedules.is_empty());
    }

    /// A file written by a newer build, with an unknown field on every
    /// persisted struct, loads in this one, nothing it knows is lost, and a
    /// save writes every unknown field back untouched (an older build must
    /// not strip what a newer one added). Only a field inside the rule — a
    /// tagged enum without a map — is dropped.
    #[test]
    fn a_file_from_a_newer_build_with_unknown_fields_round_trips() {
        let raw = r#"{"version":1,"future_top":{"nested":[1,2]},"projects":{"p1":{"tab-a":{
            "future_target":1,
            "schedules":[{"id":"s1","enabled":true,"message":"run tests",
                "rule":{"type":"weekdays","weekdays":[1,5],"time":"07:30","tz":"UTC"},
                "preface":["/clear"],
                "last":{"occurrence":"o","result":"delivered","at":"a","took_ms":3},
                "origin":{"by":"agent","session":"sess","at":"a","model":"m"},
                "phone_device":"dev","future_schedule":"x"}],
            "claims":{"s1":"o"},
            "agent_deliveries":[{"id":"d1","day":"2026-10-15","at":"a","result":"failed","why":"?"}]
        }}}}"#;
        let file: AgentTasksFile = serde_json::from_str(raw).expect("newer file loads");
        let target = &file.projects["p1"]["tab-a"];
        let s = &target.schedules[0];
        assert_eq!(s.rule, AgentScheduleRule::Weekdays { weekdays: vec![1, 5], time: "07:30".into() });
        assert_eq!(s.preface, vec!["/clear"]);
        assert_eq!(s.last.as_ref().unwrap().result, AgentScheduleResult::Delivered);
        assert_eq!(s.origin.as_ref().unwrap().session, "sess");
        assert_eq!(s.phone_device.as_deref(), Some("dev"));
        assert_eq!(target.claims["s1"], "o");
        assert_eq!(target.agent_deliveries[0].result, Some(AgentScheduleResult::Failed));
        // Known fields never land in the map.
        assert_eq!(s.extra.keys().collect::<Vec<_>>(), vec!["future_schedule"]);
        assert_eq!(file.extra.keys().collect::<Vec<_>>(), vec!["future_top"]);

        // load → save: the whole file comes back as written, but for the
        // rule's unknown field.
        let out = json(&file);
        let mut expected: serde_json::Value = serde_json::from_str(raw).unwrap();
        expected["projects"]["p1"]["tab-a"]["schedules"][0]["rule"]
            .as_object_mut()
            .unwrap()
            .remove("tz");
        assert_eq!(out, expected);
        let back: AgentTasksFile = serde_json::from_value(out.clone()).unwrap();
        assert_eq!(json(&back), out);

        // A file without unknown fields writes no trace of the maps.
        let plain = r#"{"version":1,"projects":{"p":{"t":{"schedules":[{"id":"s","enabled":true,
            "message":"m","rule":{"type":"once","at":"t"}}]}}}}"#;
        let plain_file: AgentTasksFile = serde_json::from_str(plain).unwrap();
        assert_eq!(json(&plain_file), serde_json::from_str::<serde_json::Value>(plain).unwrap());

        let binding: AgentScheduleTargetBinding =
            serde_json::from_str(r#"{"projectId":"p","scheduleTargetId":"t","extra":1}"#).unwrap();
        assert_eq!(binding.schedule_target_id, "t");
    }

    /// The binding crosses the wire in camelCase; snake_case keys are not its
    /// fields, so the required ones are missing and it fails.
    #[test]
    fn the_target_binding_is_camel_case() {
        let b: AgentScheduleTargetBinding =
            serde_json::from_str(r#"{"projectId":"p","scheduleTargetId":"t"}"#).unwrap();
        assert_eq!(b.project_id, "p");
        assert_eq!(json(&b)["scheduleTargetId"], "t");
        assert!(serde_json::from_str::<AgentScheduleTargetBinding>(
            r#"{"project_id":"p","schedule_target_id":"t"}"#
        )
        .is_err());
    }
}
