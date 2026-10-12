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

impl ProjectEntry {
    /// The one answer to "where is this project's folder", from the trusted
    /// `projects.json` entry: its `directory` (trimmed, if non-empty), else the
    /// folder holding its `local_file` when that is a `project.json` — the
    /// legacy shape, and the frontend's `resolveProjectDirectory`. For a remote
    /// project this is its local per-project state dir, not the tree on the host.
    ///
    /// The fallback goes through `Path`, so a Windows `C:\p\project.json`
    /// resolves on Windows, and it never yields an empty path or a filesystem
    /// root (`/project.json`): callers mount, move and fence what this returns.
    pub fn directory(&self) -> Option<&str> {
        if let Some(dir) = self.extra.get("directory").and_then(Value::as_str) {
            let dir = dir.trim();
            if !dir.is_empty() {
                return Some(dir);
            }
        }
        let file = std::path::Path::new(&self.local_file);
        if !file
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.eq_ignore_ascii_case("project.json"))
        {
            return None;
        }
        file.parent()
            .filter(|dir| dir.file_name().is_some())
            .and_then(std::path::Path::to_str)
    }
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

    fn entry(local_file: &str, directory: Option<&str>) -> ProjectEntry {
        let mut extra = HashMap::new();
        if let Some(d) = directory {
            extra.insert("directory".to_string(), Value::String(d.to_string()));
        }
        ProjectEntry {
            id: "p".to_string(),
            name: "P".to_string(),
            status: "active".to_string(),
            position: 0,
            local_file: local_file.to_string(),
            extra,
        }
    }

    /// An absolute path in this OS's syntax, built per component.
    fn abs(parts: &[&str]) -> std::path::PathBuf {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        parts.iter().fold(std::path::PathBuf::from(root), |p, c| p.join(c))
    }

    #[test]
    fn directory_prefers_the_trimmed_directory_field() {
        let dir = abs(&["w", "alpha"]);
        let dir = dir.to_str().unwrap();
        let file = abs(&["elsewhere", "project.json"]);
        let padded = format!("  {dir}\t");
        let e = entry(file.to_str().unwrap(), Some(&padded));
        assert_eq!(e.directory(), Some(dir));
    }

    #[test]
    fn an_empty_or_blank_directory_falls_back_to_local_files_folder() {
        let dir = abs(&["w", "alpha"]);
        let file = dir.join("project.json");
        for blank in [None, Some(""), Some("   ")] {
            let e = entry(file.to_str().unwrap(), blank);
            assert_eq!(e.directory(), dir.to_str(), "{blank:?}");
        }
    }

    #[test]
    fn the_fallback_reads_a_windows_path_on_windows() {
        if cfg!(windows) {
            let e = entry(r"C:\Users\u\alpha\project.json", None);
            assert_eq!(e.directory(), Some(r"C:\Users\u\alpha"));
        }
    }

    #[test]
    fn the_fallback_needs_a_project_json_under_a_real_folder() {
        let state = abs(&["state", "p.json"]);
        let root = abs(&["project.json"]);
        for file in ["", "project.json", state.to_str().unwrap(), root.to_str().unwrap()] {
            assert_eq!(entry(file, None).directory(), None, "{file}");
        }
    }

    #[test]
    fn only_an_array_of_strings_is_a_device_list() {
        assert_eq!(mobile_device_list(&serde_json::json!(["a", "b"])), vec!["a", "b"]);
        assert!(mobile_device_list(&serde_json::json!([])).is_empty());
        for bad in [serde_json::json!(null), serde_json::json!("a"), serde_json::json!(["a", 1]), serde_json::json!({ "a": 1 })] {
            assert!(mobile_device_list(&bad).is_empty(), "{bad}");
        }
    }
}
