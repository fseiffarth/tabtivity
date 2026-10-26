//! The Tabtivity-wide agent config layer: one home-shaped tree the user edits,
//! laid into every agent home at every spawn.
//!
//! Agent homes are per scope (`services::agent_home`) so that config an agent
//! writes in one project never runs in another. That also meant the user's own
//! instructions, skills, hooks and MCP servers reached no agent at all. This
//! layer brings them back without giving up the isolation: it lives at
//! `<state_dir>/agent-global/`, which no fence ever mounts (the state dir is
//! masked; macOS denies it by name), so only the user — through Tabtivity's
//! Settings or its folder — can change it. At every spawn
//! [`apply_to_home`] copies its files into the scope's home and merges its
//! config fragments into the files the CLIs themselves write. An agent can
//! still edit its own scope's copy; the next spawn puts the layer back.
//!
//! - Plain files (`.claude/CLAUDE.md`, `.claude/skills/…`, `.codex/AGENTS.md`,
//!   hook scripts, …) are copied over the home's; a home file the layer
//!   replaces for the first time is kept in `.tabtivity-global-backup/`, and a
//!   file removed from the layer is removed from every home at its next spawn.
//! - The config files a CLI writes itself ([`MERGED`]) are merged, never
//!   replaced: objects/tables recurse, arrays gain the layer's elements, other
//!   values take the layer's. What was merged is recorded in the home's
//!   manifest, so the next spawn first takes exactly that back out and a key
//!   dropped from the layer leaves every home; whatever the CLI or the user
//!   put there stays.
//!
//! [`import_from_user_home`] fills the layer from the user's own `~/.claude`,
//! `~/.codex` and `~/.gemini`, plus the hook and plugin files the other CLIs
//! read (Cursor, Droid, Copilot, OpenCode, Pi, Mistral Vibe) — so a tool the
//! user wired into their agents themselves (rtk's `rtk init -g`, say) reaches
//! every Tabtivity agent too. One click, the one direction that is safe.
//! Tabtivity's own session hooks are filtered out of what it imports; they are
//! registered per home anyway. Every read and write into a home is relative
//! to a directory handle (`services::home_io`): the home is agent-writable
//! and the apply runs unfenced. AppHandle-free.

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::services::home_io::HomeFile;
use crate::storage;

/// The layer's directory under the state dir.
pub const GLOBAL_DIR: &str = "agent-global";
/// Per home: what the last apply placed there.
const MANIFEST: &str = crate::brand::AGENT_GLOBAL_MANIFEST;
/// Per home: the scope's own files the layer replaced on first contact.
const BACKUP_DIR: &str = crate::brand::AGENT_GLOBAL_BACKUP_DIR;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    Json,
    Toml,
}

/// Config files the CLI itself writes (model picks, folder trust, Tabtivity's
/// hooks): merged into, never replaced.
const MERGED: &[(&str, Format)] = &[
    (".claude/settings.json", Format::Json),
    (".claude.json", Format::Json),
    (".codex/config.toml", Format::Toml),
    (".gemini/settings.json", Format::Json),
    (".cursor/hooks.json", Format::Json),
    (".factory/hooks.json", Format::Json),
    (".vibe/hooks.toml", Format::Toml),
];

pub fn global_dir_in(state_dir: &Path) -> PathBuf {
    state_dir.join(GLOBAL_DIR)
}

pub fn global_dir() -> PathBuf {
    global_dir_in(&storage::state_dir())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    /// Relative paths (`/`-separated) of the files copied last time.
    #[serde(default)]
    files: Vec<String>,
    /// Per merged file, the fragment merged last time (TOML as JSON).
    #[serde(default)]
    merged: BTreeMap<String, Value>,
}

/// Every regular file under `root`, relative and `/`-separated, sorted.
/// Symlinks are skipped: the layer is the user's, but a link in it would make
/// the copy read wherever it points.
fn layer_files(root: &Path) -> Vec<String> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            let child = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if ty.is_dir() {
                walk(&entry.path(), &child, out);
            } else if ty.is_file() {
                out.push(child);
            }
        }
    }
    let mut out = Vec::new();
    walk(root, "", &mut out);
    out.sort();
    out
}

/// The exec bits a layer file carries. The copy is written as bytes, so
/// without carrying these a hook or status-line script lands non-executable
/// and every hook call fails with `Permission denied`.
#[cfg(unix)]
fn exec_bits(src: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(src).map(|m| m.permissions().mode() & 0o111).unwrap_or(0)
}

#[cfg(not(unix))]
fn exec_bits(_src: &Path) -> u32 {
    0
}

/// Lay the layer under `state_dir` into `home`. A no-op for a home that never
/// saw the layer while the layer is empty.
///
/// The home is agent-writable and this runs unfenced, so every read and
/// write goes through a directory handle ([`HomeFile`]): a `~/.claude` the
/// agent swaps for a link — before or during the apply — never steers a
/// write out of the home.
pub fn apply_to_home(state_dir: &Path, home: &Path) -> io::Result<()> {
    let layer = global_dir_in(state_dir);
    let manifest_file = HomeFile::open(home, MANIFEST).ok_or_else(|| io::Error::other("home is not a directory"))?;
    let previous: Manifest = manifest_file
        .read()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let files: Vec<String> = layer_files(&layer)
        .into_iter()
        .filter(|rel| !MERGED.iter().any(|(m, _)| m == rel))
        .collect();
    if files.is_empty() && previous.files.is_empty() && previous.merged.is_empty() && !has_merged(&layer) {
        return Ok(());
    }
    let mut placed = Vec::new();
    for rel in &files {
        let Some(dst) = HomeFile::open(home, rel) else {
            eprintln!("agent_global: skip {rel}: not a plain path in {}", home.display());
            continue;
        };
        let src = layer.join(rel);
        let Ok(bytes) = std::fs::read(&src) else { continue };
        let current = dst.read();
        if current.as_deref() != Some(bytes.as_slice()) {
            if let Some(own) = current.filter(|_| !previous.files.contains(rel)) {
                if let Some(backup) = HomeFile::open(home, &format!("{BACKUP_DIR}/{rel}")) {
                    if !backup.exists() {
                        let _ = backup.write(&own);
                    }
                }
            }
            dst.write(&bytes)?;
        }
        // Also repairs a copy an earlier spawn left non-executable.
        let _ = dst.set_exec_bits(exec_bits(&src));
        placed.push(rel.clone());
    }
    for rel in previous.files.iter().filter(|r| !files.contains(r)) {
        if let Some(dst) = HomeFile::open_existing(home, rel) {
            if dst.exists() {
                let _ = dst.remove();
            }
        }
    }
    let mut merged = BTreeMap::new();
    for (rel, format) in MERGED {
        let fragment = read_fragment(&layer.join(rel), *format);
        let before = previous.merged.get(*rel);
        if fragment.is_none() && before.is_none() {
            continue;
        }
        let Some(dst) = HomeFile::open(home, rel) else { continue };
        match merge_file(&dst, *format, before, fragment.as_ref()) {
            Ok(()) => {
                if let Some(json) = fragment {
                    merged.insert((*rel).to_string(), json);
                }
            }
            Err(e) => {
                eprintln!("agent_global: merge {rel} in {}: {e}", home.display());
                // Keep the old record so the next spawn can still take it out.
                if let Some(before) = before {
                    merged.insert((*rel).to_string(), before.clone());
                }
            }
        }
    }
    let manifest = Manifest { files: placed, merged };
    let body = serde_json::to_vec_pretty(&manifest).map_err(io::Error::other)?;
    if manifest_file.read().as_deref() != Some(body.as_slice()) {
        manifest_file.write(&body)?;
    }
    Ok(())
}

fn has_merged(layer: &Path) -> bool {
    MERGED.iter().any(|(rel, _)| layer.join(rel).is_file())
}

/// A layer fragment in its JSON form, which is also what the manifest records
/// (a TOML fragment is rebuilt from it when merged).
fn read_fragment(path: &Path, format: Format) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    match format {
        Format::Json => match serde_json::from_str::<Value>(&text) {
            Ok(v) if v.is_object() => Some(v),
            _ => {
                eprintln!("agent_global: {} is not a JSON object; ignored", path.display());
                None
            }
        },
        Format::Toml => match text.parse::<toml_edit::DocumentMut>() {
            Ok(doc) => Some(toml_table_json(doc.as_table())),
            Err(e) => {
                eprintln!("agent_global: {}: {e}; ignored", path.display());
                None
            }
        },
    }
}

fn merge_file(dst: &HomeFile, format: Format, before: Option<&Value>, fragment: Option<&Value>) -> io::Result<()> {
    let current = dst.read();
    let text = current
        .as_deref()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let next = match format {
        Format::Json => {
            let mut value: Value = if text.trim().is_empty() {
                Value::Object(Default::default())
            } else {
                serde_json::from_str(&text).map_err(|e| io::Error::other(format!("unreadable, left alone: {e}")))?
            };
            if let Some(before) = before {
                json_unmerge(&mut value, before);
            }
            if let Some(fragment) = fragment {
                json_merge(&mut value, fragment);
            }
            let mut out = serde_json::to_string_pretty(&value).map_err(io::Error::other)?;
            out.push('\n');
            out
        }
        Format::Toml => {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .map_err(|e| io::Error::other(format!("unreadable, left alone: {e}")))?;
            if let Some(before) = before {
                toml_unmerge(doc.as_table_mut(), before);
            }
            if let Some(fragment) = fragment {
                let layer = json_to_toml_doc(fragment);
                toml_merge(doc.as_table_mut(), layer.as_table());
            }
            doc.to_string()
        }
    };
    // An unchanged or JSON-reformat-only file is left as the CLI wrote it.
    if current.is_some() && semantically_equal(&text, &next, format) {
        return Ok(());
    }
    dst.write(next.as_bytes())
}

fn semantically_equal(a: &str, b: &str, format: Format) -> bool {
    match format {
        Format::Json => serde_json::from_str::<Value>(a).ok() == serde_json::from_str::<Value>(b).ok(),
        Format::Toml => a == b,
    }
}

/// Lay `fragment` over `target`: objects recurse, arrays gain the elements
/// they lack, anything else is replaced.
pub(crate) fn json_merge(target: &mut Value, fragment: &Value) {
    match (target, fragment) {
        (Value::Object(t), Value::Object(f)) => {
            for (k, fv) in f {
                match t.get_mut(k) {
                    Some(tv) if (tv.is_object() && fv.is_object()) || (tv.is_array() && fv.is_array()) => {
                        json_merge(tv, fv)
                    }
                    _ => {
                        t.insert(k.clone(), fv.clone());
                    }
                }
            }
        }
        (Value::Array(t), Value::Array(f)) => {
            for fv in f {
                if !t.contains(fv) {
                    t.push(fv.clone());
                }
            }
        }
        (t, f) => *t = f.clone(),
    }
}

/// Take back out what merging `fragment` put in: array elements equal to the
/// fragment's, values still equal to the fragment's. Containers left empty by
/// that are dropped. What changed since is left.
pub(crate) fn json_unmerge(target: &mut Value, fragment: &Value) {
    let (Value::Object(t), Value::Object(f)) = (target, fragment) else {
        return;
    };
    for (k, fv) in f {
        let Some(tv) = t.get_mut(k) else { continue };
        let drop = match (&mut *tv, fv) {
            (Value::Object(_), Value::Object(_)) => {
                json_unmerge(tv, fv);
                tv.as_object().is_some_and(|o| o.is_empty())
            }
            (Value::Array(items), Value::Array(ours)) => {
                items.retain(|v| !ours.contains(v));
                items.is_empty()
            }
            (tv, fv) => tv == fv,
        };
        if drop {
            t.remove(k);
        }
    }
}

fn toml_value_json(value: &toml_edit::Value) -> Value {
    use toml_edit::Value as V;
    match value {
        V::String(s) => Value::String(s.value().clone()),
        V::Integer(i) => Value::from(*i.value()),
        V::Float(f) => serde_json::Number::from_f64(*f.value()).map(Value::Number).unwrap_or(Value::Null),
        V::Boolean(b) => Value::Bool(*b.value()),
        V::Datetime(d) => Value::String(d.value().to_string()),
        V::Array(a) => Value::Array(a.iter().map(toml_value_json).collect()),
        V::InlineTable(t) => Value::Object(t.iter().map(|(k, v)| (k.to_string(), toml_value_json(v))).collect()),
    }
}

fn toml_item_json(item: &toml_edit::Item) -> Value {
    match item {
        toml_edit::Item::None => Value::Null,
        toml_edit::Item::Value(v) => toml_value_json(v),
        toml_edit::Item::Table(t) => toml_table_json(t),
        toml_edit::Item::ArrayOfTables(a) => Value::Array(a.iter().map(toml_table_json).collect()),
    }
}

fn toml_table_json(table: &toml_edit::Table) -> Value {
    Value::Object(table.iter().map(|(k, v)| (k.to_string(), toml_item_json(v))).collect())
}

/// Rebuild a TOML document from a fragment's JSON form: the manifest keeps the
/// JSON, and the layer file may have changed or gone since. Objects of objects
/// become tables, arrays of objects arrays of tables.
fn json_to_toml_doc(value: &Value) -> toml_edit::DocumentMut {
    fn value_of(v: &Value) -> Option<toml_edit::Value> {
        Some(match v {
            Value::String(s) => s.as_str().into(),
            Value::Bool(b) => (*b).into(),
            Value::Number(n) => match n.as_i64() {
                Some(i) => i.into(),
                None => n.as_f64()?.into(),
            },
            Value::Array(a) => {
                let mut arr = toml_edit::Array::new();
                for item in a {
                    arr.push_formatted(value_of(item)?);
                }
                toml_edit::Value::Array(arr)
            }
            Value::Object(o) => {
                let mut t = toml_edit::InlineTable::new();
                for (k, item) in o {
                    t.insert(k, value_of(item)?);
                }
                toml_edit::Value::InlineTable(t)
            }
            Value::Null => return None,
        })
    }
    fn table_of(o: &serde_json::Map<String, Value>) -> toml_edit::Table {
        let mut t = toml_edit::Table::new();
        t.set_implicit(true);
        for (k, v) in o {
            let item = match v {
                Value::Object(inner) => toml_edit::Item::Table(table_of(inner)),
                Value::Array(a) if !a.is_empty() && a.iter().all(Value::is_object) => {
                    let mut aot = toml_edit::ArrayOfTables::new();
                    for inner in a.iter().filter_map(Value::as_object) {
                        aot.push(table_of(inner));
                    }
                    toml_edit::Item::ArrayOfTables(aot)
                }
                other => match value_of(other) {
                    Some(v) => toml_edit::Item::Value(v),
                    None => continue,
                },
            };
            t.insert(k, item);
        }
        t
    }
    let mut doc = toml_edit::DocumentMut::new();
    if let Value::Object(o) = value {
        *doc.as_table_mut() = table_of(o);
    }
    doc
}

fn clear_positions(item: &mut toml_edit::Item) {
    match item {
        toml_edit::Item::Table(t) => {
            t.set_position(None);
            for (_, child) in t.iter_mut() {
                clear_positions(child);
            }
        }
        toml_edit::Item::ArrayOfTables(a) => {
            for t in a.iter_mut() {
                t.set_position(None);
                for (_, child) in t.iter_mut() {
                    clear_positions(child);
                }
            }
        }
        _ => {}
    }
}

/// [`json_merge`] for a TOML document, keeping the target's formatting.
fn toml_merge(target: &mut dyn toml_edit::TableLike, layer: &dyn toml_edit::TableLike) {
    for (k, item) in layer.iter() {
        let existing = target.get_mut(k);
        match (existing, item) {
            (Some(t), l) if t.is_table_like() && l.is_table_like() => {
                if let (Some(t), Some(l)) = (t.as_table_like_mut(), l.as_table_like()) {
                    toml_merge(t, l);
                }
            }
            (Some(toml_edit::Item::ArrayOfTables(t)), toml_edit::Item::ArrayOfTables(l)) => {
                let have: Vec<Value> = t.iter().map(toml_table_json).collect();
                for table in l.iter() {
                    if !have.contains(&toml_table_json(table)) {
                        let mut table = table.clone();
                        table.set_position(None);
                        t.push(table);
                    }
                }
            }
            (Some(t), l) if t.is_array() && l.is_array() => {
                let (Some(t), Some(l)) = (t.as_array_mut(), l.as_array()) else { continue };
                let have: Vec<Value> = t.iter().map(toml_value_json).collect();
                for v in l.iter() {
                    if !have.contains(&toml_value_json(v)) {
                        t.push_formatted(v.clone());
                    }
                }
            }
            _ => {
                let mut item = item.clone();
                clear_positions(&mut item);
                target.insert(k, item);
            }
        }
    }
}

/// [`json_unmerge`] for a TOML document.
fn toml_unmerge(target: &mut dyn toml_edit::TableLike, fragment: &Value) {
    let Value::Object(f) = fragment else { return };
    for (k, fv) in f {
        let Some(item) = target.get_mut(k) else { continue };
        let drop = if fv.is_object() && item.is_table_like() {
            match item.as_table_like_mut() {
                Some(t) => {
                    toml_unmerge(t, fv);
                    t.is_empty()
                }
                None => false,
            }
        } else if let (Some(ours), toml_edit::Item::ArrayOfTables(tables)) = (fv.as_array(), &mut *item) {
            let mut i = 0;
            while i < tables.len() {
                if tables.get(i).is_some_and(|t| ours.contains(&toml_table_json(t))) {
                    tables.remove(i);
                } else {
                    i += 1;
                }
            }
            tables.is_empty()
        } else if let (Some(ours), Some(arr)) = (fv.as_array(), item.as_array_mut()) {
            arr.retain(|v| !ours.contains(&toml_value_json(v)));
            arr.is_empty()
        } else {
            &toml_item_json(item) == fv
        };
        if drop {
            target.remove(k);
        }
    }
}

// ---------------------------------------------------------------------------
// Import from the user's own home

/// What an import took, for the Settings row.
#[derive(Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub files: usize,
    pub configs: usize,
}

/// Where each CLI keeps what the layer carries, relative to a home: single
/// files and whole directories copied as they are.
const IMPORT_FILES: &[&str] = &[".copilot/copilot-instructions.md"];
const IMPORT_DIRS: &[&str] = &[
    ".claude/skills",
    ".claude/commands",
    ".claude/agents",
    ".claude/output-styles",
    ".claude/hooks",
    ".codex/prompts",
    ".codex/rules",
    ".codex/skills",
    ".gemini/commands",
    ".gemini/hooks",
    ".copilot/hooks",
    ".config/opencode/plugins",
    ".pi/agent/extensions",
    ".vibe/prompts",
];
/// JSON hook configs of CLIs Tabtivity registers nothing in, taken whole.
const IMPORT_JSON: &[&str] = &[".cursor/hooks.json", ".factory/hooks.json"];
/// Homes whose top-level `.md` files are instructions: `AGENTS.md` /
/// `GEMINI.md` and the files they `@`-import (rtk's `RTK.md`).
const INSTRUCTION_DIRS: &[&str] = &[".codex", ".gemini"];
/// Top-level files of `~/.claude` taken by extension: the instructions
/// (`CLAUDE.md` and the files it `@`-imports) and the scripts its hooks and
/// status line name. Nothing else there is config.
const CLAUDE_TOP_EXTENSIONS: &[&str] = &["md", "sh", "py", "js", "mjs", "cjs", "ts"];

/// Copy a user file into the layer, following symlinks (the user's home is
/// the user's own). Returns whether it was taken.
fn take_file(src: &Path, dst: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(src) else { return false };
    if !meta.is_file() {
        return false;
    }
    if let Some(parent) = dst.parent() {
        if crate::services::agent_home::create_private_dir(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(src, dst).is_ok()
}

fn take_dir(src: &Path, dst: &Path, depth: usize) -> usize {
    if depth > 8 {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(src) else { return 0 };
    let mut n = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        // A CLI's own bundled content (`skills/.system`, …) is its to update.
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            n += take_dir(&path, &dst.join(&name), depth + 1);
        } else if take_file(&path, &dst.join(&name)) {
            n += 1;
        }
    }
    n
}

/// Whether a hook entry is one of Tabtivity's own session hooks.
///
/// Recognised by the hooks dir in the command. A user's own CLI config that
/// an older build registered its hook in names that build's state dir, so
/// the hooks dir under the app's old name counts as well.
fn is_app_hook(command: &str, hooks_dir: &str) -> bool {
    is_app_hook_for(&crate::brand::PAIR, command, hooks_dir)
}

pub(crate) fn is_app_hook_for(pair: &crate::brand::Pair, command: &str, hooks_dir: &str) -> bool {
    if hooks_dir.is_empty() {
        return false;
    }
    if command.contains(hooks_dir) {
        return true;
    }
    let (Some(old_name), cur_name) = (
        pair.legacy(crate::brand::Name::STATE_DIR_NAME),
        pair.cur(crate::brand::Name::STATE_DIR_NAME),
    ) else {
        return false;
    };
    // `<base>/<current name>/hooks` → `<base>/<old name>/hooks`.
    let hooks = Path::new(hooks_dir);
    let Some(state) = hooks.parent() else { return false };
    if state.file_name().and_then(|name| name.to_str()) != Some(cur_name.as_str()) {
        return false;
    }
    let old_hooks = state.with_file_name(old_name).join(hooks.file_name().unwrap_or_default());
    let matched = command.contains(old_hooks.to_string_lossy().as_ref());
    if matched {
        crate::brand::legacy_hit("hook-entry");
    }
    matched
}

/// Drop Tabtivity's own hook commands from a Claude/Gemini-style `hooks` map
/// (`{event: [{matcher, hooks: [{command}]}]}`), and the groups and events
/// that leaves empty.
pub(crate) fn strip_app_json_hooks(settings: &mut Value, hooks_dir: &str) {
    let Some(events) = settings.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for groups in events.values_mut() {
        let Some(groups) = groups.as_array_mut() else { continue };
        for group in groups.iter_mut() {
            if let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                hooks.retain(|h| {
                    !h.get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| is_app_hook(c, hooks_dir))
                });
            }
        }
        groups.retain(|g| g.get("hooks").and_then(Value::as_array).is_none_or(|h| !h.is_empty()));
    }
    events.retain(|_, groups| groups.as_array().is_none_or(|g| !g.is_empty()));
    if events.is_empty() {
        settings.as_object_mut().map(|o| o.remove("hooks"));
    }
}

/// The part of the user's `~/.codex/config.toml` that is config rather than
/// Codex's own per-machine state: folder trust (`projects`), notices and the
/// hook-trust records go; Tabtivity's own hooks go.
pub(crate) fn filtered_codex_config(text: &str, hooks_dir: &str) -> Option<String> {
    let mut doc: toml_edit::DocumentMut = text.parse().ok()?;
    let root = doc.as_table_mut();
    root.remove("projects");
    root.remove("notice");
    if let Some(hooks) = root.get_mut("hooks").and_then(toml_edit::Item::as_table_like_mut) {
        hooks.remove("state");
        let events: Vec<String> = hooks.iter().map(|(k, _)| k.to_string()).collect();
        for ev in events {
            let Some(groups) = hooks.get_mut(&ev).and_then(toml_edit::Item::as_array_of_tables_mut) else {
                continue;
            };
            let mut i = 0;
            while i < groups.len() {
                let ours = groups.get(i).is_some_and(|g| {
                    toml_table_json(g)
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|hs| {
                            hs.iter().any(|h| {
                                h.get("command")
                                    .and_then(Value::as_str)
                                    .is_some_and(|c| is_app_hook(c, hooks_dir))
                            })
                        })
                });
                if ours {
                    groups.remove(i);
                } else {
                    i += 1;
                }
            }
            if groups.is_empty() {
                hooks.remove(&ev);
            }
        }
        if hooks.is_empty() {
            root.remove("hooks");
        }
    }
    let out = doc.to_string();
    (!out.trim().is_empty()).then_some(out)
}

/// The user's `~/.vibe/hooks.toml` minus Tabtivity's own session hook, which
/// every home gets registered anyway (`agent_session::register_hooks_in_home`).
pub(crate) fn filtered_vibe_hooks(text: &str, hooks_dir: &str) -> Option<String> {
    let mut doc: toml_edit::DocumentMut = text.parse().ok()?;
    // The hook's name under the app's old name; `None` while it is unchanged.
    let legacy_vibe_hook = crate::brand::PAIR.legacy(crate::brand::Name::VIBE_SESSION_HOOK);
    if let Some(hooks) = doc.get_mut("hooks").and_then(toml_edit::Item::as_array_of_tables_mut) {
        hooks.retain(|h| {
            let name = h.get("name").and_then(toml_edit::Item::as_str);
            let command = h.get("command").and_then(toml_edit::Item::as_str).unwrap_or("");
            name != Some(crate::brand::VIBE_SESSION_HOOK)
                && name.is_none_or(|name| Some(name) != legacy_vibe_hook.as_deref())
                && !is_app_hook(command, hooks_dir)
        });
        if hooks.is_empty() {
            doc.remove("hooks");
        }
    }
    let out = doc.to_string();
    (!out.trim().is_empty()).then_some(out)
}

fn write_layer_json(layer: &Path, rel: &str, value: &Value) -> bool {
    let dst = layer.join(rel);
    if let Some(parent) = dst.parent() {
        if crate::services::agent_home::create_private_dir(parent).is_err() {
            return false;
        }
    }
    serde_json::to_vec_pretty(value)
        .ok()
        .is_some_and(|body| std::fs::write(dst, body).is_ok())
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

/// Fill the layer under `state_dir` from `user_home`: instructions, skills,
/// commands, agents, hook scripts and MCP servers of Claude, Codex and Gemini.
/// Logins, transcripts, history and folder trust are not taken. What it takes
/// replaces the layer's copy; the rest of the layer is left.
pub fn import_from_user_home_in(state_dir: &Path, user_home: &Path) -> io::Result<ImportReport> {
    let layer = global_dir_in(state_dir);
    crate::services::agent_home::create_private_dir(&layer)?;
    let hooks_dir = state_dir.join("hooks").to_string_lossy().into_owned();
    let mut report = ImportReport::default();

    let claude = user_home.join(".claude");
    if let Ok(entries) = std::fs::read_dir(&claude) {
        for entry in entries.flatten() {
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if CLAUDE_TOP_EXTENSIONS.contains(&ext)
                && take_file(&path, &layer.join(".claude").join(entry.file_name()))
            {
                report.files += 1;
            }
        }
    }
    for dir in INSTRUCTION_DIRS {
        let Ok(entries) = std::fs::read_dir(user_home.join(dir)) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("md")
                && take_file(&path, &layer.join(dir).join(entry.file_name()))
            {
                report.files += 1;
            }
        }
    }
    for rel in IMPORT_FILES {
        if take_file(&user_home.join(rel), &layer.join(rel)) {
            report.files += 1;
        }
    }
    for rel in IMPORT_DIRS {
        report.files += take_dir(&user_home.join(rel), &layer.join(rel), 0);
    }

    if let Some(mut settings) = read_json(&claude.join("settings.json")).filter(Value::is_object) {
        strip_app_json_hooks(&mut settings, &hooks_dir);
        if write_layer_json(&layer, ".claude/settings.json", &settings) {
            report.configs += 1;
        }
    }
    // `~/.claude.json` is mostly Claude's own state; only the user-scope MCP
    // servers are config.
    if let Some(servers) = read_json(&user_home.join(".claude.json"))
        .and_then(|v| v.get("mcpServers").cloned())
        .filter(|s| s.as_object().is_some_and(|o| !o.is_empty()))
    {
        if write_layer_json(&layer, ".claude.json", &serde_json::json!({ "mcpServers": servers })) {
            report.configs += 1;
        }
    }
    if let Some(config) = std::fs::read_to_string(user_home.join(".codex/config.toml"))
        .ok()
        .and_then(|text| filtered_codex_config(&text, &hooks_dir))
    {
        let dst = layer.join(".codex/config.toml");
        if crate::services::agent_home::create_private_dir(&layer.join(".codex")).is_ok()
            && std::fs::write(dst, config).is_ok()
        {
            report.configs += 1;
        }
    }
    if let Some(mut settings) = read_json(&user_home.join(".gemini/settings.json")).filter(Value::is_object) {
        strip_app_json_hooks(&mut settings, &hooks_dir);
        if write_layer_json(&layer, ".gemini/settings.json", &settings) {
            report.configs += 1;
        }
    }
    for rel in IMPORT_JSON {
        if let Some(config) = read_json(&user_home.join(rel)).filter(Value::is_object) {
            if write_layer_json(&layer, rel, &config) {
                report.configs += 1;
            }
        }
    }
    if let Some(hooks) = std::fs::read_to_string(user_home.join(".vibe/hooks.toml"))
        .ok()
        .and_then(|text| filtered_vibe_hooks(&text, &hooks_dir))
    {
        if crate::services::agent_home::create_private_dir(&layer.join(".vibe")).is_ok()
            && std::fs::write(layer.join(".vibe/hooks.toml"), hooks).is_ok()
        {
            report.configs += 1;
        }
    }
    Ok(report)
}

pub fn import_from_user_home() -> io::Result<ImportReport> {
    import_from_user_home_in(&storage::state_dir(), &crate::paths::home_dir())
}

/// Marks that the first start of the Tabtivity-wide layer has run.
const IMPORTED_MARKER: &str = ".agent_global_imported";

/// The import, done once for the user at the first start with the layer, so
/// agents keep their instructions, skills, hooks and MCP servers without a
/// trip to Settings. Skipped when the layer already holds files (the user
/// filled it); never repeated, so later edits to the layer are the user's.
pub fn import_once_in(state_dir: &Path, user_home: &Path) {
    let marker = state_dir.join(IMPORTED_MARKER);
    if marker.exists() {
        return;
    }
    if layer_files(&global_dir_in(state_dir)).is_empty() {
        if let Err(e) = import_from_user_home_in(state_dir, user_home) {
            eprintln!("agent_global: first import: {e}");
            return;
        }
    }
    let _ = std::fs::write(&marker, b"");
}

pub fn import_once() {
    import_once_in(&storage::state_dir(), &crate::paths::home_dir());
}

/// What the Settings row shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerStatus {
    pub dir: String,
    pub files: usize,
    /// Whether the layer's Codex config routes approvals to auto-review.
    pub codex_auto_review: bool,
}

pub fn status() -> LayerStatus {
    let dir = global_dir();
    LayerStatus {
        files: layer_files(&dir).len(),
        codex_auto_review: codex_auto_review_in(&dir),
        dir: dir.to_string_lossy().into_owned(),
    }
}

/// Codex's `approvals_reviewer` value that hands the requests Codex would ask
/// the user about to a reviewer agent instead. The Manage CLIs switch writes
/// it into the layer, so it is the user's own Codex config in every home, not
/// a mode Tabtivity picks: the approval policy and the sandbox stay Codex's.
/// Fenced Linux Codex needs it most — its sandbox cannot nest under the fence,
/// so every command asks to run outside it (`docs/context/agent_authority.md`).
const CODEX_REVIEWER: &str = "approvals_reviewer";
const CODEX_AUTO_REVIEW: &str = "auto_review";

fn codex_auto_review_in(layer: &Path) -> bool {
    std::fs::read_to_string(layer.join(".codex/config.toml"))
        .ok()
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok())
        .is_some_and(|doc| doc.get(CODEX_REVIEWER).and_then(|v| v.as_str()) == Some(CODEX_AUTO_REVIEW))
}

/// Switch auto-review on or off in the layer under `state_dir`, editing only
/// that one key of its Codex config. Off removes the key only while it still
/// says `auto_review`; a reviewer the user named themselves stays. A config
/// that does not parse is refused rather than rewritten.
pub fn set_codex_auto_review_in(state_dir: &Path, on: bool) -> io::Result<()> {
    let layer = global_dir_in(state_dir);
    let path = layer.join(".codex/config.toml");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    let mut doc = text
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| io::Error::other(format!("{}: {e}", path.display())))?;
    if on {
        doc[CODEX_REVIEWER] = toml_edit::value(CODEX_AUTO_REVIEW);
    } else if doc.get(CODEX_REVIEWER).and_then(|v| v.as_str()) == Some(CODEX_AUTO_REVIEW) {
        doc.remove(CODEX_REVIEWER);
    }
    let out = doc.to_string();
    if out == text {
        return Ok(());
    }
    if out.trim().is_empty() {
        return std::fs::remove_file(&path);
    }
    crate::services::agent_home::create_private_dir(&layer)?;
    crate::services::agent_home::create_private_dir(&layer.join(".codex"))?;
    std::fs::write(&path, out)
}

pub fn set_codex_auto_review(on: bool) -> io::Result<()> {
    set_codex_auto_review_in(&storage::state_dir(), on)
}

/// Create the layer's directory (for "Open folder") and return it.
pub fn ensure_dir() -> io::Result<PathBuf> {
    let dir = global_dir();
    crate::services::agent_home::create_private_dir(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use crate::brand::SLUG;
    use super::*;
    use serde_json::json;

    fn write(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn json_merge_then_unmerge_leaves_what_the_cli_wrote() {
        let mut home = json!({
            "model": "sonnet",
            "hooks": {"Stop": [{"hooks": [{"type": "command", "command": crate::app_slug!()}]}]}
        });
        let layer = json!({
            "permissions": {"defaultMode": "auto"},
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "mine"}]}],
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook claude"}]}]
            }
        });
        json_merge(&mut home, &layer);
        assert_eq!(home["permissions"]["defaultMode"], "auto");
        assert_eq!(home["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(home["model"], "sonnet");
        // Merging twice adds nothing.
        let once = home.clone();
        json_merge(&mut home, &layer);
        assert_eq!(home, once);
        json_unmerge(&mut home, &layer);
        assert_eq!(
            home,
            json!({
                "model": "sonnet",
                "hooks": {"Stop": [{"hooks": [{"type": "command", "command": crate::app_slug!()}]}]}
            })
        );
    }

    #[test]
    fn unmerge_keeps_a_value_changed_since() {
        let mut home = json!({"model": "opus"});
        json_unmerge(&mut home, &json!({"model": "sonnet"}));
        assert_eq!(home["model"], "opus");
    }

    #[test]
    fn files_are_copied_backed_up_once_and_removed_with_the_layer() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let layer = global_dir_in(&state);
        write(&layer.join(".claude/CLAUDE.md"), "global");
        write(&layer.join(".claude/skills/a/SKILL.md"), "skill");
        write(&home.join(".claude/CLAUDE.md"), "scope's own");
        apply_to_home(&state, &home).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".claude/CLAUDE.md")).unwrap(), "global");
        assert_eq!(std::fs::read_to_string(home.join(".claude/skills/a/SKILL.md")).unwrap(), "skill");
        assert_eq!(
            std::fs::read_to_string(home.join(BACKUP_DIR).join(".claude/CLAUDE.md")).unwrap(),
            "scope's own"
        );
        // An agent's edit of its copy is put back at the next spawn, and the
        // backup still holds the scope's original.
        std::fs::write(home.join(".claude/CLAUDE.md"), "tampered").unwrap();
        apply_to_home(&state, &home).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".claude/CLAUDE.md")).unwrap(), "global");
        assert_eq!(
            std::fs::read_to_string(home.join(BACKUP_DIR).join(".claude/CLAUDE.md")).unwrap(),
            "scope's own"
        );
        std::fs::remove_dir_all(layer.join(".claude/skills")).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert!(!home.join(".claude/skills/a/SKILL.md").exists());
        assert!(home.join(".claude/CLAUDE.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn a_hook_script_stays_executable_in_the_home() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let script = global_dir_in(&state).join(".claude/statusline-mode-hook.sh");
        write(&script, "#!/bin/sh\n");
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        write(&global_dir_in(&state).join(".claude/CLAUDE.md"), "global");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o111;
        apply_to_home(&state, &home).unwrap();
        let dst = home.join(".claude/statusline-mode-hook.sh");
        assert_eq!(mode(&dst), 0o111);
        assert_eq!(mode(&home.join(".claude/CLAUDE.md")), 0);
        // A copy an earlier spawn left non-executable, bytes unchanged, is repaired.
        std::fs::set_permissions(&dst, std::fs::Permissions::from_mode(0o644)).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert_eq!(mode(&dst), 0o111);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_temporary_symlink_cannot_redirect_a_global_write() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let victim = tmp.path().join("victim");
        write(&global_dir_in(&state).join(".codex/AGENTS.md"), "global");
        write(&home.join(".codex/AGENTS.md"), "scope");
        write(&victim, "keep");
        std::os::unix::fs::symlink(&victim, home.join(concat!(".codex/.AGENTS.md.", crate::app_slug!(), "-tmp"))).unwrap();

        apply_to_home(&state, &home).unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(), "global");
    }

    /// The directory race (agent_authority reevaluation, item 1): the layer
    /// file's directory is opened by handle, so a `.claude` swapped for a
    /// link between two applies — or between the open and the write — never
    /// redirects the copy. The write lands where the handle points.
    #[cfg(unix)]
    #[test]
    fn a_directory_swapped_between_applies_never_redirects_the_layer() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        write(&global_dir_in(&state).join(".claude/CLAUDE.md"), "global");
        apply_to_home(&state, &home).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".claude/CLAUDE.md")).unwrap(), "global");
        // The agent's move between two spawns.
        std::fs::rename(home.join(".claude"), home.join(".claude.moved")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();
        write(&global_dir_in(&state).join(".claude/CLAUDE.md"), "changed");
        apply_to_home(&state, &home).unwrap();
        assert!(!outside.join("CLAUDE.md").exists());
        assert!(std::fs::symlink_metadata(home.join(".claude")).unwrap().file_type().is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_home_never_steers_a_write_outside_it() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        write(&global_dir_in(&state).join(".claude/CLAUDE.md"), "global");
        write(&global_dir_in(&state).join(".codex/AGENTS.md"), "codex");
        std::os::unix::fs::symlink(&outside, home.join(".claude")).unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(outside.join("victim"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.join("victim"), home.join(".codex/AGENTS.md")).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert!(!outside.join("CLAUDE.md").exists());
        assert_eq!(std::fs::read_to_string(outside.join("victim")).unwrap(), "keep");
        assert_eq!(std::fs::read_to_string(home.join(".codex/AGENTS.md")).unwrap(), "codex");
    }

    #[test]
    fn claude_settings_are_merged_and_taken_back_out() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let layer_file = global_dir_in(&state).join(".claude/settings.json");
        write(&layer_file, r#"{"env": {"A": "1"}, "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook claude"}]}]}}"#);
        write(&home.join(".claude/settings.json"), r#"{"model": "opus"}"#);
        apply_to_home(&state, &home).unwrap();
        let merged = read_json(&home.join(".claude/settings.json")).unwrap();
        assert_eq!(merged["model"], "opus");
        assert_eq!(merged["env"]["A"], "1");
        assert_eq!(merged["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        write(&layer_file, r#"{"env": {"B": "2"}}"#);
        apply_to_home(&state, &home).unwrap();
        let merged = read_json(&home.join(".claude/settings.json")).unwrap();
        assert_eq!(merged, json!({"model": "opus", "env": {"B": "2"}}));
        std::fs::remove_file(&layer_file).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert_eq!(read_json(&home.join(".claude/settings.json")).unwrap(), json!({"model": "opus"}));
    }

    #[test]
    fn codex_config_gains_the_mcp_servers_and_keeps_its_own_trust() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let layer_file = global_dir_in(&state).join(".codex/config.toml");
        write(&layer_file, "[mcp_servers.docs]\ncommand = \"docs-mcp\"\nargs = [\"--stdio\"]\n");
        write(
            &home.join(".codex/config.toml"),
            concat!("model = \"gpt-5\"\n\n[projects.\"/work/p\"]\ntrust_level = \"trusted\"\n\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '", crate::app_slug!(), "'\n"),
        );
        apply_to_home(&state, &home).unwrap();
        let text = std::fs::read_to_string(home.join(".codex/config.toml")).unwrap();
        let doc: toml_edit::DocumentMut = text.parse().expect("still valid TOML");
        assert_eq!(doc["mcp_servers"]["docs"]["command"].as_str(), Some("docs-mcp"));
        assert_eq!(doc["projects"]["/work/p"]["trust_level"].as_str(), Some("trusted"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        assert!(text.contains(concat!("command = '", crate::app_slug!(), "'")));
        // Idempotent.
        apply_to_home(&state, &home).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".codex/config.toml")).unwrap(), text);
        std::fs::remove_file(&layer_file).unwrap();
        apply_to_home(&state, &home).unwrap();
        let doc: toml_edit::DocumentMut = std::fs::read_to_string(home.join(".codex/config.toml"))
            .unwrap()
            .parse()
            .unwrap();
        assert!(doc.get("mcp_servers").is_none());
        assert_eq!(doc["projects"]["/work/p"]["trust_level"].as_str(), Some("trusted"));
    }

    #[test]
    fn the_codex_auto_review_switch_edits_one_key_and_reaches_every_home() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        let layer = global_dir_in(&state);
        let layer_file = layer.join(".codex/config.toml");
        write(&home.join(".codex/config.toml"), "approvals_reviewer = \"user\"\nmodel = \"gpt-5\"\n");
        // From nothing: on writes the key, off removes the file it created.
        assert!(!codex_auto_review_in(&layer));
        set_codex_auto_review_in(&state, true).unwrap();
        assert!(codex_auto_review_in(&layer));
        apply_to_home(&state, &home).unwrap();
        let doc: toml_edit::DocumentMut =
            std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().parse().unwrap();
        assert_eq!(doc["approvals_reviewer"].as_str(), Some("auto_review"));
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        set_codex_auto_review_in(&state, false).unwrap();
        assert!(!layer_file.exists());
        apply_to_home(&state, &home).unwrap();
        let doc: toml_edit::DocumentMut =
            std::fs::read_to_string(home.join(".codex/config.toml")).unwrap().parse().unwrap();
        assert!(doc.get("approvals_reviewer").is_none());
        assert_eq!(doc["model"].as_str(), Some("gpt-5"));
        // An imported config keeps its comments and tables around the key.
        let imported = "# mine\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n";
        write(&layer_file, imported);
        set_codex_auto_review_in(&state, true).unwrap();
        let text = std::fs::read_to_string(&layer_file).unwrap();
        assert!(text.contains("# mine") && text.contains("[mcp_servers.docs]"));
        set_codex_auto_review_in(&state, false).unwrap();
        assert_eq!(std::fs::read_to_string(&layer_file).unwrap(), imported);
        // A reviewer the user named is not the switch's to remove.
        write(&layer_file, "approvals_reviewer = \"user\"\n");
        set_codex_auto_review_in(&state, false).unwrap();
        assert_eq!(std::fs::read_to_string(&layer_file).unwrap(), "approvals_reviewer = \"user\"\n");
        // A broken config is refused, not overwritten.
        write(&layer_file, "not = [toml");
        assert!(set_codex_auto_review_in(&state, true).is_err());
        assert_eq!(std::fs::read_to_string(&layer_file).unwrap(), "not = [toml");
    }

    #[test]
    fn an_empty_layer_leaves_a_home_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert!(!home.join(MANIFEST).exists());
    }

    #[test]
    fn first_start_imports_once_and_never_over_a_filled_layer() {
        let tmp = tempfile::tempdir().unwrap();
        let user = tmp.path().join("user");
        write(&user.join(".claude/CLAUDE.md"), "mine");
        let state = tmp.path().join("state");
        import_once_in(&state, &user);
        assert!(global_dir_in(&state).join(".claude/CLAUDE.md").is_file());
        // Never again: a file the user removes from the layer stays removed.
        std::fs::remove_file(global_dir_in(&state).join(".claude/CLAUDE.md")).unwrap();
        import_once_in(&state, &user);
        assert!(!global_dir_in(&state).join(".claude/CLAUDE.md").exists());

        // A layer the user already filled is left alone.
        let filled = tmp.path().join("filled");
        write(&global_dir_in(&filled).join(".codex/AGENTS.md"), "layer");
        import_once_in(&filled, &user);
        assert!(!global_dir_in(&filled).join(".claude/CLAUDE.md").exists());
    }

    #[test]
    fn import_takes_config_and_leaves_logins_state_and_app_hooks() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let user = tmp.path().join("user");
        let hooks = state.join("hooks").join(concat!(crate::app_slug!(), "_session_start.sh"));
        let hooks = hooks.to_string_lossy();
        write(&user.join(".claude/CLAUDE.md"), "@RTK.md");
        write(&user.join(".claude/RTK.md"), "rtk");
        write(&user.join(".claude/statusline.sh"), "#!/bin/sh");
        write(&user.join(".claude/.credentials.json"), "{\"token\":1}");
        write(&user.join(".claude/history.jsonl"), "{}");
        write(&user.join(".claude/skills/s/SKILL.md"), "skill");
        write(&user.join(".codex/skills/.system/x.md"), "bundled");
        write(&user.join(".codex/AGENTS.md"), "codex\n@/home/u/.codex/RTK.md");
        write(&user.join(".codex/RTK.md"), "rtk");
        write(&user.join(".codex/auth.json"), "{}");
        // What `rtk init -g` leaves for the other CLIs.
        write(&user.join(".gemini/hooks/rtk-hook-gemini.sh"), "#!/bin/bash\nexec rtk hook gemini");
        write(
            &user.join(".cursor/hooks.json"),
            r#"{"version": 1, "hooks": {"preToolUse": [{"command": "rtk hook cursor", "matcher": "Shell"}]}}"#,
        );
        write(
            &user.join(".vibe/hooks.toml"),
            &format!(
                "[[hooks]]\nname = \"{SLUG}-session\"\ntype = \"post_agent\"\ncommand = '{hooks}'\n\n[[hooks]]\nname = \"rtk-rewrite\"\ntype = \"pre_tool\"\nmatch = \"bash\"\ncommand = \"rtk hook vibe\"\n"
            ),
        );
        write(
            &user.join(".claude/settings.json"),
            &json!({
                "model": "opus",
                "hooks": {
                    "SessionStart": [{"hooks": [{"type": "command", "command": hooks}]}],
                    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk hook claude"}]}]
                }
            })
            .to_string(),
        );
        write(
            &user.join(".claude.json"),
            r#"{"oauthAccount": {"emailAddress": "a@b"}, "mcpServers": {"m": {"command": "x"}}, "projects": {}}"#,
        );
        write(
            &user.join(".codex/config.toml"),
            &format!(
                "model = \"gpt-5\"\n[projects.\"/p\"]\ntrust_level = \"trusted\"\n[mcp_servers.m]\ncommand = \"x\"\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = \"command\"\ncommand = '{hooks}'\n[hooks.state.\"x\"]\nenabled = true\n"
            ),
        );
        let report = import_from_user_home_in(&state, &user).unwrap();
        assert_eq!(report, ImportReport { files: 7, configs: 5 });
        let layer = global_dir_in(&state);
        assert!(layer.join(".claude/CLAUDE.md").is_file());
        assert!(layer.join(".claude/RTK.md").is_file());
        assert!(layer.join(".claude/statusline.sh").is_file());
        assert!(layer.join(".claude/skills/s/SKILL.md").is_file());
        assert!(!layer.join(".claude/.credentials.json").exists());
        assert!(!layer.join(".claude/history.jsonl").exists());
        assert!(!layer.join(".codex/skills/.system").exists());
        assert!(!layer.join(".codex/auth.json").exists());
        let settings = read_json(&layer.join(".claude/settings.json")).unwrap();
        assert!(settings["hooks"].get("SessionStart").is_none());
        assert_eq!(settings["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        assert_eq!(read_json(&layer.join(".claude.json")).unwrap(), json!({"mcpServers": {"m": {"command": "x"}}}));
        let codex = std::fs::read_to_string(layer.join(".codex/config.toml")).unwrap();
        let doc: toml_edit::DocumentMut = codex.parse().unwrap();
        assert!(doc.get("projects").is_none());
        assert!(doc.get("hooks").is_none());
        assert_eq!(doc["mcp_servers"]["m"]["command"].as_str(), Some("x"));
        assert!(layer.join(".codex/RTK.md").is_file());
        assert!(layer.join(".gemini/hooks/rtk-hook-gemini.sh").is_file());
        assert_eq!(
            read_json(&layer.join(".cursor/hooks.json")).unwrap()["hooks"]["preToolUse"][0]["command"],
            "rtk hook cursor"
        );
        let vibe: toml_edit::DocumentMut =
            std::fs::read_to_string(layer.join(".vibe/hooks.toml")).unwrap().parse().unwrap();
        let vibe_hooks = vibe["hooks"].as_array_of_tables().unwrap();
        assert_eq!(vibe_hooks.len(), 1);
        assert_eq!(vibe_hooks.get(0).unwrap()["name"].as_str(), Some("rtk-rewrite"));
    }

    #[test]
    fn a_vibe_hook_from_the_layer_joins_the_homes_own() {
        let tmp = tempfile::tempdir().unwrap();
        let state = tmp.path().join("state");
        let home = tmp.path().join("home");
        write(
            &global_dir_in(&state).join(".vibe/hooks.toml"),
            "[[hooks]]\nname = \"rtk-rewrite\"\ntype = \"pre_tool\"\ncommand = \"rtk hook vibe\"\n",
        );
        let own = concat!("# ", crate::app_name!(), ": remember the live Vibe session for this tab.\n[[hooks]]\nname = \"", crate::app_slug!(), "-session\"\ntype = \"post_agent\"\ncommand = \"x\"\n");
        write(&home.join(".vibe/hooks.toml"), own);
        apply_to_home(&state, &home).unwrap();
        let doc: toml_edit::DocumentMut =
            std::fs::read_to_string(home.join(".vibe/hooks.toml")).unwrap().parse().unwrap();
        let names: Vec<_> = doc["hooks"]
            .as_array_of_tables()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, [concat!(crate::app_slug!(), "-session"), "rtk-rewrite"]);
        std::fs::remove_file(global_dir_in(&state).join(".vibe/hooks.toml")).unwrap();
        apply_to_home(&state, &home).unwrap();
        assert_eq!(std::fs::read_to_string(home.join(".vibe/hooks.toml")).unwrap(), own);
    }
}
