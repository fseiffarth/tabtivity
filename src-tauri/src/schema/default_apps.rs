use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// `~/.local/share/tabtivity/default_apps.json` — global file-extension→command map.
/// Each project's `project.json["default_apps"]` uses the same structure.
///
/// Keys are file extensions including the leading dot (e.g. `".md"`).
/// Values are executable names or absolute paths.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DefaultApps(pub HashMap<String, String>);

impl DefaultApps {
    pub fn get(&self, ext: &str) -> Option<&str> {
        self.0.get(ext).map(|s| s.as_str())
    }
}
