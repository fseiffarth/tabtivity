use std::collections::HashMap;
use std::path::Path;

use crate::schema::DefaultApps;
use crate::storage;

fn default_apps_path() -> std::path::PathBuf {
    storage::state_dir().join("default_apps.json")
}

#[tauri::command]
pub fn get_default_apps() -> Result<DefaultApps, String> {
    let path = default_apps_path();
    if !path.exists() {
        return Ok(DefaultApps::default());
    }
    storage::read_json(&path).map_err(|e| e.to_string())
}

/// Replace the whole map. Kept for older frontends; under the file's lock
/// like the patch, so it cannot interleave with one (headless owner plan,
/// H1b) — but it still overwrites entries another client set meanwhile,
/// which is why the frontend patches instead.
#[tauri::command]
pub fn save_default_apps(default_apps: DefaultApps) -> Result<(), String> {
    storage::patch_json(&default_apps_path(), DefaultApps::default(), |apps| {
        *apps = default_apps;
        Ok(())
    })
}

/// Change entries in place (headless owner plan, H1b): `set` adds or
/// replaces, `remove` drops, both under the file's lock on top of what is on
/// disk right now — so a dialog on the desktop and a settings page on the
/// phone saving at once keep each other's entries. Answers the map as stored.
#[tauri::command]
pub fn patch_default_apps(
    set: Option<HashMap<String, String>>,
    remove: Option<Vec<String>>,
) -> Result<DefaultApps, String> {
    patch_default_apps_at(&default_apps_path(), set.unwrap_or_default(), &remove.unwrap_or_default())
}

pub fn patch_default_apps_at(
    path: &Path,
    set: HashMap<String, String>,
    remove: &[String],
) -> Result<DefaultApps, String> {
    storage::patch_json(path, DefaultApps::default(), |apps| {
        for ext in remove {
            apps.0.remove(ext);
        }
        for (ext, exec) in set {
            apps.0.insert(ext, exec);
        }
        Ok(apps.clone())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two clients each patch one entry: neither erases the other's, and a
    /// removal only takes its own key.
    #[test]
    fn patches_compose_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("default_apps.json");
        let one = patch_default_apps_at(&path, HashMap::from([(".md".to_string(), "vim".to_string())]), &[]).unwrap();
        assert_eq!(one.get(".md"), Some("vim"));
        let two = patch_default_apps_at(&path, HashMap::from([(".pdf".to_string(), "evince".to_string())]), &[]).unwrap();
        assert_eq!(two.get(".md"), Some("vim"), "the first client's entry survives the second's patch");
        assert_eq!(two.get(".pdf"), Some("evince"));
        let three = patch_default_apps_at(&path, HashMap::new(), &[".md".to_string(), ".none".to_string()]).unwrap();
        assert_eq!(three.get(".md"), None);
        assert_eq!(three.get(".pdf"), Some("evince"));
        let stored: DefaultApps = storage::read_json(&path).unwrap();
        assert_eq!(stored.0, three.0);
    }
}
