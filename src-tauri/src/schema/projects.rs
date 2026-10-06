use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// One entry in `~/.local/share/tabtivity/projects.json`.
/// Unknown fields are preserved so Python rollback can still read the file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: String,
    pub name: String,
    /// "current" | "active" | "inactive"
    pub status: String,
    pub position: i64,
    pub local_file: String,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

/// Full `projects.json` — an ordered list of registered projects.
pub type ProjectsList = Vec<ProjectEntry>;

/// A project's or box's per-phone list (`brand::MOBILE_DEVICES_KEY`), as the
/// readers of `projects.json` / `boxes.json` take it: only an array of strings
/// is a list; any other value — `null`, a string, an array with a non-string
/// entry — is no phone at all. Fail closed, and for this one record only: a
/// strict typed field would fail the whole file instead, and with it every
/// project on every phone.
pub fn mobile_device_list(value: &Value) -> Vec<String> {
    value
        .as_array()
        .and_then(|items| items.iter().map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

/// `deserialize_with` for an `Option<Vec<String>>` per-phone list under
/// `#[serde(default)]`: called only when the key is present, so absent stays
/// `None` (every phone) and present-but-malformed is `Some(vec![])` (none).
pub fn lenient_mobile_devices<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Vec<String>>, D::Error> {
    Ok(Some(mobile_device_list(&Value::deserialize(deserializer)?)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_array_of_strings_is_a_device_list() {
        assert_eq!(mobile_device_list(&serde_json::json!(["a", "b"])), vec!["a", "b"]);
        assert!(mobile_device_list(&serde_json::json!([])).is_empty());
        for bad in [serde_json::json!(null), serde_json::json!("a"), serde_json::json!(["a", 1]), serde_json::json!({ "a": 1 })] {
            assert!(mobile_device_list(&bad).is_empty(), "{bad}");
        }
    }
}
