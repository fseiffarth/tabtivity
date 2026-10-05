use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
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
#[serde(deny_unknown_fields)]
pub struct AgentScheduleLastRun {
    pub occurrence: String,
    pub result: AgentScheduleResult,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
    /// collected prompt it sent, a prompt it held — by the device id the
    /// sidecar knows it as (never a secret). A rule whose phone is revoked, or
    /// no longer reaches the scope, is cancelled rather than typed
    /// (`mobile_control::phone_origin`). Absent on every rule the desktop or
    /// an agent made, and on phone rules written before it existed: those
    /// are of unknown origin and left alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phone_device: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleAuthor { Agent }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScheduleOrigin {
    pub by: ScheduleAuthor,
    pub session: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_delivery: Option<String>,
}

/// Kept independently of retired rules; claims reserve budget before any PTY write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentScheduleDelivery {
    pub id: String,
    pub day: String,
    pub at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<AgentScheduleResult>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
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
}

fn agent_tasks_version() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AgentTasksFile {
    #[serde(default = "agent_tasks_version")]
    pub version: u8,
    #[serde(default)]
    pub projects: BTreeMap<String, BTreeMap<String, AgentPromptTarget>>,
}

impl Default for AgentTasksFile {
    fn default() -> Self {
        Self {
            version: agent_tasks_version(),
            projects: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
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

    /// Rules are tagged by `type` in snake_case and reject a field they do not
    /// know — a typo in the composer's payload fails loudly instead of
    /// scheduling something subtly different.
    #[test]
    fn schedule_rules_are_type_tagged_and_strict() {
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

        assert!(serde_json::from_str::<AgentScheduleRule>(r#"{"type":"once","at":"x","time":"y"}"#).is_err());
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
        .is_err());
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

        assert!(serde_json::from_str::<AgentTasksFile>(r#"{"version":1,"projects":{},"extra":1}"#).is_err());
        let nested: AgentTasksFile = serde_json::from_str(
            r#"{"projects":{"p1":{"tab-a":{"schedules":[]}}}}"#,
        )
        .unwrap();
        assert!(nested.projects["p1"]["tab-a"].schedules.is_empty());
    }

    /// The binding crosses the wire in camelCase and is strict too.
    #[test]
    fn the_target_binding_is_camel_case_and_strict() {
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
