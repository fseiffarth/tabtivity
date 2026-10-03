//! The server-wide policy (hosted plan §6.7, §3.3): the admin's feature
//! switches and the Ollama model allowlist. The gateway owns the file
//! (`/var/lib/<slug>-gateway/policy.json`, `0644`) and writes it on an
//! admin's request; every daemon reads it (`<PREFIX>SERVER_POLICY_FILE`).
//!
//! Compiled into both crates — the gateway's as `app_gateway::policy`, the
//! daemon's by `#[path]` (`services::server::policy`) — so the shape cannot
//! drift. `serde` + `std` only.

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

pub const POLICY_FILE: &str = "policy.json";
/// Longest allowlist the gateway accepts, and longest model name.
pub const MAX_MODELS: usize = 256;
pub const MAX_MODEL_NAME: usize = 200;

/// The admin's server-wide switches. Off means: the feature's commands are
/// refused with a named reason, its timers do not run, its data stays
/// (§6.7 "Switching features off").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Features {
    pub mail: bool,
    pub calendar: bool,
    pub todo: bool,
    /// Opening a calendar or todo list to other users (P4c).
    pub calendar_sharing: bool,
    /// Sharing a project with other users through the hub (P4a/P4b). Off:
    /// no new share and no new member; existing shares keep working until
    /// their owners stop them.
    pub project_sharing: bool,
}

impl Default for Features {
    fn default() -> Self {
        Self { mail: true, calendar: true, todo: true, calendar_sharing: true, project_sharing: true }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Policy {
    pub schema: u32,
    pub features: Features,
    /// `None`: what the admin pulled is allowed (`/api/tags`); `Some(list)`:
    /// only these (a bare name matches its `:latest`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ollama_allowed_models: Option<Vec<String>>,
}

impl Default for Policy {
    fn default() -> Self {
        Self { schema: 1, features: Features::default(), ollama_allowed_models: None }
    }
}

impl Policy {
    /// Read the policy file. Missing → the default (everything on, the
    /// pulled models allowed); unreadable or corrupt → `Err`, and a daemon
    /// treats that as "every switchable feature off" rather than guessing on.
    pub fn load(path: &std::path::Path) -> Result<Policy, String> {
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Policy::default()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        }
    }

    /// What a daemon falls back to when the file cannot be read.
    pub fn fail_closed() -> Policy {
        Policy {
            schema: 1,
            features: Features { mail: false, calendar: false, todo: false, calendar_sharing: false, project_sharing: false },
            ollama_allowed_models: Some(Vec::new()),
        }
    }

    /// Check an admin's edit: bounded, plain model names.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(models) = &self.ollama_allowed_models {
            if models.len() > MAX_MODELS {
                return Err(format!("at most {MAX_MODELS} models"));
            }
            for model in models {
                if model.is_empty()
                    || model.len() > MAX_MODEL_NAME
                    || !model.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'/'))
                {
                    return Err(format!("not a model name: {model:?}"));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_policy_defaults_open_and_fails_closed_when_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(POLICY_FILE);
        assert_eq!(Policy::load(&path).unwrap(), Policy::default());
        std::fs::write(&path, br#"{"features":{"mail":false}}"#).unwrap();
        let policy = Policy::load(&path).unwrap();
        assert!(!policy.features.mail && policy.features.calendar, "missing keys keep their default");
        std::fs::write(&path, b"{oops").unwrap();
        assert!(Policy::load(&path).is_err());
        assert!(!Policy::fail_closed().features.todo && !Policy::fail_closed().features.project_sharing);
        assert!(policy.features.project_sharing, "a policy written before project sharing existed allows it");
        let mut p = Policy { ollama_allowed_models: Some(vec!["llama3:8b".into(), "hf.co/x/y".into()]), ..Policy::default() };
        assert!(p.validate().is_ok());
        p.ollama_allowed_models = Some(vec!["bad model".into()]);
        assert!(p.validate().is_err());
    }
}
