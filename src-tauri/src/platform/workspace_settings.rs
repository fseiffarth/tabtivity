//! The desktop workspace settings the `x11` backend takes over while it runs,
//! and gives back on quit (`docs/wayland_app_parking_plan.md` Phase 2).
//!
//! Parking needs a second workspace that stays put: Cinnamon (Muffin) and
//! GNOME (Mutter) keep the count, the names and whether workspaces come and go
//! in GSettings, so the backend sets them while it runs and restores them in
//! `cleanup`, one table per desktop ([`CINNAMON`], [`GNOME`]).
//!
//! Rules, all decided here and none in the `gsettings` caller:
//! - a key `gsettings get` cannot read (missing schema or key) is skipped;
//! - only a key whose value differs is written, and only a written key is
//!   recorded and restored — the user's other settings are never touched;
//! - the record is persisted to [`RESTORE_FILE`] in the state dir *before*
//!   the first write and deleted after the restore, so a crash leaves the
//!   originals behind for the next start, which restores them first;
//! - without a file, a `workspace-names` that already starts with the app's
//!   own pair (current or old name) is a leftover of a crash under an older
//!   build: it is recorded as the GSettings default (`gsettings reset`), not
//!   as the user's value.
//!
//! Pure over injected `get`/`set` and a file path, so it is compiled and
//! tested on every OS; only `x11.rs` runs it against `gsettings`.

use std::path::Path;

use serde::{Deserialize, Serialize};

/// `<state_dir>/` file holding the originals while the settings are taken over.
pub const RESTORE_FILE: &str = "workspace_settings_restore.json";

/// What a key should hold while the backend runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want {
    /// An integer at least this large (`num-workspaces`); a larger one stays.
    AtLeast(u32),
    /// This exact GVariant text (`false`).
    Exactly(&'static str),
    /// A string list whose first two entries are the app's workspace names
    /// (`workspace-names`); the user's further names are kept.
    BrandNames,
}

/// One key of a desktop's table.
#[derive(Debug, Clone, Copy)]
pub struct SettingKey {
    pub schema: &'static str,
    pub key: &'static str,
    pub want: Want,
}

/// The settings one desktop gets.
#[derive(Debug)]
pub struct DesktopSettings {
    /// The desktop's id in the restore file.
    pub desktop: &'static str,
    /// Written in this order; restored in reverse.
    pub keys: &'static [SettingKey],
    /// A failed write fails the backend (Cinnamon, as it always did). Off:
    /// the failure is logged and the key left alone (GNOME — parking still
    /// works on whatever workspaces Mutter keeps).
    pub strict: bool,
    /// The window manager may ignore a `_NET_WM_DESKTOP` client message, and
    /// `move_window` then writes the property directly (Muffin only).
    pub property_fallback: bool,
}

/// Cinnamon: the three keys the backend has always set.
pub const CINNAMON: DesktopSettings = DesktopSettings {
    desktop: "cinnamon",
    keys: &[
        SettingKey { schema: "org.cinnamon.desktop.wm.preferences", key: "num-workspaces", want: Want::AtLeast(2) },
        SettingKey { schema: "org.cinnamon.desktop.wm.preferences", key: "workspace-names", want: Want::BrandNames },
        SettingKey { schema: "org.cinnamon.muffin", key: "dynamic-workspaces", want: Want::Exactly("false") },
    ],
    strict: true,
    property_fallback: true,
};

/// GNOME (Mutter, X11 and Wayland): dynamic workspaces would collapse the
/// empty hidden workspace, and workspaces-only-on-primary would show a
/// secondary monitor's windows on every workspace, so neither could park.
/// Dynamic workspaces go off before the count is read by Mutter.
pub const GNOME: DesktopSettings = DesktopSettings {
    desktop: "gnome",
    keys: &[
        SettingKey { schema: "org.gnome.mutter", key: "dynamic-workspaces", want: Want::Exactly("false") },
        SettingKey { schema: "org.gnome.mutter", key: "workspaces-only-on-primary", want: Want::Exactly("false") },
        SettingKey { schema: "org.gnome.desktop.wm.preferences", key: "num-workspaces", want: Want::AtLeast(2) },
        SettingKey { schema: "org.gnome.desktop.wm.preferences", key: "workspace-names", want: Want::BrandNames },
    ],
    strict: false,
    property_fallback: false,
};

/// One key's value before the backend changed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recorded {
    pub schema: String,
    pub key: String,
    /// The GVariant text `gsettings get` printed; `None` = put the GSettings
    /// default back (`gsettings reset`).
    pub original: Option<String>,
}

/// The restore file's shape.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreFile {
    pub desktop: String,
    pub keys: Vec<Recorded>,
}

/// One `gsettings` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Set { schema: String, key: String, value: String },
    Reset { schema: String, key: String },
}

/// A key the plan touches: what to write (if anything) and what to record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Planned {
    pub write: Option<String>,
    pub record: Recorded,
}

/// What `table` would write, given each key's `current` value.
pub fn plan(table: &DesktopSettings, current: impl Fn(&str, &str) -> Option<String>) -> Vec<Planned> {
    let mut out = Vec::new();
    for k in table.keys {
        let Some(value) = current(k.schema, k.key) else { continue };
        let value = value.trim().to_string();
        let record = |original: Option<String>| Recorded {
            schema: k.schema.to_string(),
            key: k.key.to_string(),
            original,
        };
        match k.want {
            Want::AtLeast(min) => {
                let Ok(n) = value.parse::<u32>() else { continue };
                if n < min {
                    out.push(Planned { write: Some(min.to_string()), record: record(Some(value)) });
                }
            }
            Want::Exactly(want) => {
                if value != want {
                    out.push(Planned { write: Some(want.to_string()), record: record(Some(value)) });
                }
            }
            Want::BrandNames => {
                let names = workspace_names(&value);
                let desired = workspace_names_with_brand(&names);
                let write = (names != desired).then(|| workspace_names_value(&desired));
                if brand_leftover(&names) {
                    // A crash under a build that kept no restore file: the
                    // user's own names are gone, the default is the best guess.
                    out.push(Planned { write, record: record(None) });
                } else if let Some(write) = write {
                    out.push(Planned { write: Some(write), record: record(Some(value)) });
                }
            }
        }
    }
    out
}

/// The calls that put `record` back, last write first.
pub fn restore_ops(record: &[Recorded]) -> Vec<Op> {
    record
        .iter()
        .rev()
        .map(|r| match &r.original {
            Some(value) => Op::Set { schema: r.schema.clone(), key: r.key.clone(), value: value.clone() },
            None => Op::Reset { schema: r.schema.clone(), key: r.key.clone() },
        })
        .collect()
}

/// Take `table`'s settings over (or, with `None`, only restore a leftover
/// file). Returns the record [`give_back`] restores.
///
/// A restore file left by a crash is restored first — its originals win over
/// whatever is current — and the plan is made afresh from the restored values.
/// `Err` only from a strict table, after undoing what it had written.
pub fn take_over(
    table: Option<&DesktopSettings>,
    path: &Path,
    get: impl Fn(&str, &str) -> Option<String>,
    mut set: impl FnMut(&Op) -> Result<(), String>,
) -> Result<Vec<Recorded>, String> {
    if let Some(left) = read_restore_file(path) {
        run(&restore_ops(&left.keys), &mut set);
        remove_restore_file(path);
    }
    let Some(table) = table else { return Ok(Vec::new()) };
    let planned = plan(table, get);
    if planned.is_empty() {
        return Ok(Vec::new());
    }
    let mut record: Vec<Recorded> = planned.iter().map(|p| p.record.clone()).collect();
    persist(path, table, &record);
    let mut written: Vec<Recorded> = Vec::new();
    for p in &planned {
        let Some(value) = &p.write else {
            written.push(p.record.clone());
            continue;
        };
        let op = Op::Set { schema: p.record.schema.clone(), key: p.record.key.clone(), value: value.clone() };
        match set(&op) {
            Ok(()) => written.push(p.record.clone()),
            Err(e) if table.strict => {
                run(&restore_ops(&written), &mut set);
                remove_restore_file(path);
                return Err(e);
            }
            Err(e) => {
                eprintln!("workspace settings: {e}");
                // Not written: nothing to restore, unless it is a leftover
                // the reset still repairs.
                if p.record.original.is_none() {
                    written.push(p.record.clone());
                }
            }
        }
    }
    if written != record {
        record = written;
        persist(path, table, &record);
    }
    Ok(record)
}

/// Restore `record` and delete the restore file.
pub fn give_back(record: &[Recorded], path: &Path, mut set: impl FnMut(&Op) -> Result<(), String>) {
    run(&restore_ops(record), &mut set);
    if !record.is_empty() {
        remove_restore_file(path);
    }
}

fn run(ops: &[Op], set: &mut impl FnMut(&Op) -> Result<(), String>) {
    for op in ops {
        if let Err(e) = set(op) {
            eprintln!("workspace settings restore: {e}");
        }
    }
}

fn persist(path: &Path, table: &DesktopSettings, record: &[Recorded]) {
    if record.is_empty() {
        remove_restore_file(path);
        return;
    }
    let file = RestoreFile { desktop: table.desktop.to_string(), keys: record.to_vec() };
    let written = serde_json::to_vec_pretty(&file)
        .map_err(|e| e.to_string())
        .and_then(|bytes| crate::storage::write_private_atomic(path, &bytes));
    if let Err(e) = written {
        // Parking still works; only a crash would now leave the settings.
        eprintln!("workspace settings: {e}");
    }
}

/// The restore file at `path`, if one is there and readable. An unreadable
/// one is reported and removed: its originals are lost either way.
pub fn read_restore_file(path: &Path) -> Option<RestoreFile> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(file) => Some(file),
        Err(e) => {
            eprintln!("workspace settings: {}: {e}", path.display());
            remove_restore_file(path);
            None
        }
    }
}

fn remove_restore_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("workspace settings: remove {}: {e}", path.display()),
    }
}

// ── workspace-names (GVariant `as`) ─────────────────────────────────────────

/// The strings of a GVariant string list as `gsettings get` prints it
/// (`['A', 'B']`, `@as []`), `\'` and `\\` unescaped.
pub fn workspace_names(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut escaped = false;

    for ch in value.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '\'' if in_string => {
                names.push(std::mem::take(&mut current));
                in_string = false;
            }
            '\'' => in_string = true,
            _ if in_string => current.push(ch),
            _ => {}
        }
    }

    names
}

/// `names` with the app's pair in the first two slots, the rest kept.
fn workspace_names_with_brand(names: &[String]) -> Vec<String> {
    let mut out = names.to_vec();
    while out.len() < 2 {
        out.push(String::new());
    }
    out[0] = crate::brand::WM_CLASS.to_string();
    out[1] = crate::brand::WM_CLASS_HIDDEN.to_string();
    out
}

/// `names` as the GVariant text `gsettings set` takes.
pub fn workspace_names_value(names: &[String]) -> String {
    let values = names
        .iter()
        .map(|name| format!("'{}'", name.replace('\\', "\\\\").replace('\'', "\\'")))
        .collect::<Vec<_>>()
        .join(", ");
    format!("[{values}]")
}

/// Whether `names` start with the pair the backend writes — under the app's
/// current name or the one an older build wrote (counted).
fn brand_leftover(names: &[String]) -> bool {
    let starts = |a: &str, b: &str| names.len() >= 2 && names[0] == a && names[1] == b;
    if starts(crate::brand::WM_CLASS, crate::brand::WM_CLASS_HIDDEN) {
        return true;
    }
    let legacy = crate::brand::WM_CLASS != crate::brand::LEGACY_WM_CLASS
        && starts(crate::brand::LEGACY_WM_CLASS, crate::brand::LEGACY_WM_CLASS_HIDDEN);
    if legacy {
        crate::brand::legacy_hit("workspace-names");
    }
    legacy
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    type Store = RefCell<BTreeMap<(String, String), String>>;

    fn store(pairs: &[(&str, &str, &str)]) -> Store {
        RefCell::new(
            pairs
                .iter()
                .map(|(s, k, v)| ((s.to_string(), k.to_string()), v.to_string()))
                .collect(),
        )
    }

    fn get(store: &Store) -> impl Fn(&str, &str) -> Option<String> + '_ {
        move |s, k| store.borrow().get(&(s.to_string(), k.to_string())).cloned()
    }

    /// Applies ops to `store`; `Reset` writes `<default>`, and every op is logged.
    fn set<'a>(store: &'a Store, log: &'a RefCell<Vec<Op>>) -> impl FnMut(&Op) -> Result<(), String> + 'a {
        move |op| {
            log.borrow_mut().push(op.clone());
            let mut s = store.borrow_mut();
            match op {
                Op::Set { schema, key, value } => {
                    s.insert((schema.clone(), key.clone()), value.clone());
                }
                Op::Reset { schema, key } => {
                    s.insert((schema.clone(), key.clone()), "<default>".into());
                }
            }
            Ok(())
        }
    }

    fn value(store: &Store, schema: &str, key: &str) -> Option<String> {
        store.borrow().get(&(schema.to_string(), key.to_string())).cloned()
    }

    fn brand_pair() -> String {
        workspace_names_value(&[crate::brand::WM_CLASS.into(), crate::brand::WM_CLASS_HIDDEN.into()])
    }

    const CWM: &str = "org.cinnamon.desktop.wm.preferences";
    const GWM: &str = "org.gnome.desktop.wm.preferences";
    const MUT: &str = "org.gnome.mutter";

    #[test]
    fn cinnamon_writes_its_three_keys_as_before() {
        let s = store(&[
            (CWM, "num-workspaces", "1"),
            (CWM, "workspace-names", "@as []"),
            ("org.cinnamon.muffin", "dynamic-workspaces", "true"),
        ]);
        let planned = plan(&CINNAMON, get(&s));
        let writes: Vec<_> = planned
            .iter()
            .map(|p| (p.record.schema.as_str(), p.record.key.as_str(), p.write.clone().unwrap()))
            .collect();
        assert_eq!(
            writes,
            vec![
                (CWM, "num-workspaces", "2".to_string()),
                (CWM, "workspace-names", brand_pair()),
                ("org.cinnamon.muffin", "dynamic-workspaces", "false".to_string()),
            ]
        );
        const { assert!(CINNAMON.strict && CINNAMON.property_fallback) };
    }

    #[test]
    fn gnome_writes_only_what_differs_and_records_only_that() {
        let s = store(&[
            (MUT, "dynamic-workspaces", "true"),
            (MUT, "workspaces-only-on-primary", "false"),
            (GWM, "num-workspaces", "4"),
            (GWM, "workspace-names", "@as []"),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let log = RefCell::new(Vec::new());
        let record = take_over(Some(&GNOME), &path, get(&s), set(&s, &log)).unwrap();
        let keys: Vec<_> = record.iter().map(|r| r.key.as_str()).collect();
        assert_eq!(keys, vec!["dynamic-workspaces", "workspace-names"]);
        assert_eq!(log.borrow().len(), 2, "two writes, nothing else");
        assert_eq!(value(&s, MUT, "dynamic-workspaces").as_deref(), Some("false"));
        assert_eq!(value(&s, GWM, "num-workspaces").as_deref(), Some("4"), "4 ≥ 2 stays");
        assert_eq!(value(&s, GWM, "workspace-names"), Some(brand_pair()));
        const { assert!(!GNOME.strict && !GNOME.property_fallback) };
        // Persisted before the writes, exactly the record.
        let file = read_restore_file(&path).unwrap();
        assert_eq!(file.desktop, "gnome");
        assert_eq!(file.keys, record);
    }

    #[test]
    fn gnome_raises_a_single_workspace_and_keeps_extra_names() {
        let s = store(&[
            (MUT, "dynamic-workspaces", "false"),
            (MUT, "workspaces-only-on-primary", "true"),
            (GWM, "num-workspaces", "1"),
            (GWM, "workspace-names", "['Mail', 'Code', 'Extra']"),
        ]);
        let planned = plan(&GNOME, get(&s));
        let keys: Vec<_> = planned.iter().map(|p| p.record.key.as_str()).collect();
        assert_eq!(keys, vec!["workspaces-only-on-primary", "num-workspaces", "workspace-names"]);
        let names = planned[2].write.as_deref().unwrap();
        assert_eq!(
            workspace_names(names),
            vec![crate::brand::WM_CLASS, crate::brand::WM_CLASS_HIDDEN, "Extra"]
        );
        assert_eq!(planned[2].record.original.as_deref(), Some("['Mail', 'Code', 'Extra']"));
    }

    #[test]
    fn unreadable_keys_are_skipped() {
        // GNOME < 40 (keys shadowed elsewhere) or no mutter schema at all.
        let s = store(&[(GWM, "num-workspaces", "1")]);
        let planned = plan(&GNOME, get(&s));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].record.key, "num-workspaces");
        // An unparsable count is left alone too.
        let s = store(&[(GWM, "num-workspaces", "many")]);
        assert!(plan(&GNOME, get(&s)).is_empty());
    }

    #[test]
    fn nothing_to_change_writes_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let settled = store(&[(MUT, "dynamic-workspaces", "false"), (GWM, "num-workspaces", "3")]);
        let log = RefCell::new(Vec::new());
        let record = take_over(Some(&GNOME), &path, get(&settled), set(&settled, &log)).unwrap();
        assert!(record.is_empty());
        assert!(log.borrow().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn give_back_restores_exactly_the_recorded_originals() {
        let s = store(&[
            (MUT, "dynamic-workspaces", "true"),
            (MUT, "workspaces-only-on-primary", "true"),
            (GWM, "num-workspaces", "1"),
            (GWM, "workspace-names", "['Mine']"),
            ("org.gnome.other", "untouched", "7"),
        ]);
        let before = s.borrow().clone();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let log = RefCell::new(Vec::new());
        let record = take_over(Some(&GNOME), &path, get(&s), set(&s, &log)).unwrap();
        assert_eq!(record.len(), 4);
        log.borrow_mut().clear();
        give_back(&record, &path, set(&s, &log));
        assert_eq!(*s.borrow(), before);
        assert_eq!(log.borrow().len(), 4, "one write per recorded key");
        assert!(!path.exists(), "the restore file goes with the restore");
        // Last write first.
        assert!(matches!(&log.borrow()[0], Op::Set { key, .. } if key == "workspace-names"));
    }

    #[test]
    fn a_crash_file_wins_over_current_values() {
        // The previous run took over and died: current values are the app's.
        let s = store(&[
            (MUT, "dynamic-workspaces", "false"),
            (MUT, "workspaces-only-on-primary", "false"),
            (GWM, "num-workspaces", "2"),
            (GWM, "workspace-names", &brand_pair()),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let left = RestoreFile {
            desktop: "gnome".into(),
            keys: vec![
                Recorded { schema: MUT.into(), key: "dynamic-workspaces".into(), original: Some("true".into()) },
                Recorded { schema: GWM.into(), key: "workspace-names".into(), original: Some("['Mine']".into()) },
            ],
        };
        std::fs::write(&path, serde_json::to_vec(&left).unwrap()).unwrap();
        let log = RefCell::new(Vec::new());
        let record = take_over(Some(&GNOME), &path, get(&s), set(&s, &log)).unwrap();
        let originals: Vec<_> = record.iter().map(|r| (r.key.as_str(), r.original.as_deref())).collect();
        assert_eq!(
            originals,
            vec![("dynamic-workspaces", Some("true")), ("workspace-names", Some("['Mine']"))],
            "the file's originals, not the app's own values, are recorded"
        );
        log.borrow_mut().clear();
        give_back(&record, &path, set(&s, &log));
        assert_eq!(value(&s, MUT, "dynamic-workspaces").as_deref(), Some("true"));
        assert_eq!(value(&s, GWM, "workspace-names").as_deref(), Some("['Mine']"));
    }

    #[test]
    fn a_crash_file_is_restored_even_without_a_table() {
        let s = store(&[("org.cinnamon.muffin", "dynamic-workspaces", "false")]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let left = RestoreFile {
            desktop: "cinnamon".into(),
            keys: vec![Recorded {
                schema: "org.cinnamon.muffin".into(),
                key: "dynamic-workspaces".into(),
                original: Some("true".into()),
            }],
        };
        std::fs::write(&path, serde_json::to_vec(&left).unwrap()).unwrap();
        let log = RefCell::new(Vec::new());
        assert!(take_over(None, &path, get(&s), set(&s, &log)).unwrap().is_empty());
        assert_eq!(value(&s, "org.cinnamon.muffin", "dynamic-workspaces").as_deref(), Some("true"));
        assert!(!path.exists());
    }

    #[test]
    fn brand_named_workspaces_without_a_file_are_reset() {
        let s = store(&[(GWM, "workspace-names", &brand_pair())]);
        let planned = plan(&GNOME, get(&s));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].write, None, "already the pair: nothing to write");
        assert_eq!(planned[0].record.original, None, "restored as the default");
        assert_eq!(
            restore_ops(&[planned[0].record.clone()]),
            vec![Op::Reset { schema: GWM.into(), key: "workspace-names".into() }]
        );

        let legacy = workspace_names_value(&[
            crate::brand::LEGACY_WM_CLASS.into(),
            crate::brand::LEGACY_WM_CLASS_HIDDEN.into(),
            "Extra".into(),
        ]);
        let s = store(&[(CWM, "workspace-names", &legacy)]);
        let planned = plan(&CINNAMON, get(&s));
        assert_eq!(planned.len(), 1);
        assert_eq!(planned[0].record.original, None);
        if crate::brand::WM_CLASS != crate::brand::LEGACY_WM_CLASS {
            assert!(planned[0].write.is_some(), "the old pair is renamed");
        }
    }

    #[test]
    fn a_failed_strict_write_undoes_the_earlier_ones() {
        let s = store(&[
            (CWM, "num-workspaces", "1"),
            (CWM, "workspace-names", "['A', 'B']"),
            ("org.cinnamon.muffin", "dynamic-workspaces", "true"),
        ]);
        let before = s.borrow().clone();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let log = RefCell::new(Vec::new());
        let mut inner = set(&s, &log);
        let failing = |op: &Op| match op {
            Op::Set { key, value, .. } if key == "dynamic-workspaces" && value == "false" => Err("refused".to_string()),
            _ => inner(op),
        };
        assert!(take_over(Some(&CINNAMON), &path, get(&s), failing).is_err());
        assert_eq!(*s.borrow(), before);
        assert!(!path.exists());
    }

    #[test]
    fn a_failed_lenient_write_is_not_recorded() {
        let s = store(&[(MUT, "dynamic-workspaces", "true"), (GWM, "num-workspaces", "1")]);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        let log = RefCell::new(Vec::new());
        let mut inner = set(&s, &log);
        let failing = |op: &Op| match op {
            Op::Set { key, .. } if key == "dynamic-workspaces" => Err("not writable".to_string()),
            _ => inner(op),
        };
        let record = take_over(Some(&GNOME), &path, get(&s), failing).unwrap();
        assert_eq!(record.len(), 1);
        assert_eq!(record[0].key, "num-workspaces");
        assert_eq!(read_restore_file(&path).unwrap().keys, record);
    }

    #[test]
    fn a_corrupt_restore_file_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RESTORE_FILE);
        std::fs::write(&path, b"{ not json").unwrap();
        assert!(read_restore_file(&path).is_none());
        assert!(!path.exists());
    }

    #[test]
    fn parses_workspace_names() {
        assert_eq!(workspace_names("['Work', 'Play']"), vec!["Work", "Play"]);
        assert!(workspace_names("@as []").is_empty());
        let names = workspace_names("['Can\\'t', 'Other']");
        assert_eq!(names, vec!["Can't", "Other"]);
    }

    #[test]
    fn names_value_round_trips_and_sets_the_first_two_slots() {
        let pair = workspace_names_with_brand(&[]);
        assert_eq!(pair, vec![crate::brand::WM_CLASS, crate::brand::WM_CLASS_HIDDEN]);
        let original = vec!["Old".to_string(), "Also-Old".to_string(), "Can't".to_string()];
        let value = workspace_names_value(&workspace_names_with_brand(&original));
        assert_eq!(
            workspace_names(&value),
            vec![crate::brand::WM_CLASS, crate::brand::WM_CLASS_HIDDEN, "Can't"]
        );
    }
}
