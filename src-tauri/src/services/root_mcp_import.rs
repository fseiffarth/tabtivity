//! `calendar_import_ics`: a root agent hands the window an `.ics` file's text.
//!
//! The tool writes no calendar row. Like a mail draft, the staged file is not a
//! `Proposal`: it waits in `<state_dir>/root_mcp/imports/<id>.json` and shows in
//! the review panel as a card, where the *window* reads it with the one ICS
//! parser there is (`src/lib/calendar/{ics,icsSafety}.ts`) and, on the user's ✓,
//! runs the same import the calendar's own Import button runs. This backend
//! never parses iCalendar, so it only moves bytes — and only bytes the agent
//! sent: there is no path and no URL argument, because this process is not
//! fenced and would read what the agent's fence hides.
//!
//! The reply names the staged id and nothing the file contains. AppHandle-free.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use super::root_mcp::{Caller, Effects, Stores};

pub const TOOL: &str = "calendar_import_ics";
/// Under the 128 KiB request body, with room for JSON's escaping of line ends.
pub const MAX_TEXT: usize = 96 * 1024;
const MAX_NAME: usize = 80;
pub const MAX_PER_TAB: usize = 5;
pub const MAX_TOTAL: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StagedImport {
    pub id: String,
    pub tab: String,
    pub name: String,
    /// Milliseconds since the epoch, as a string — the proposals' own shape.
    pub created: String,
    pub text: String,
}

pub fn tool_schema() -> Value {
    json!({
        "name": TOOL,
        "description": concat!("Hand the user an iCalendar (.ics) file to import. Pass the file's full text; ", crate::app_name!(), " takes no path and no URL. Nothing is imported by this call: the file waits in ", crate::app_name!(), "'s review panel, where the user sees what it contains and imports it into a new calendar of its own, or discards it. Say proposed, never imported. At most 96 KiB; a larger file is one the user imports with the calendar's own Import button."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "ics_text": { "type": "string", "maxLength": MAX_TEXT, "description": "The whole file, starting at BEGIN:VCALENDAR." },
                "name": { "type": "string", "description": "What to call the new calendar. \"Imported\" when absent." }
            },
            "required": ["ics_text"]
        }
    })
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn dir(state: &Path) -> PathBuf {
    state.join("root_mcp").join("imports")
}

/// An id is a file name here, so it is only ever the hex this module minted.
fn valid_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

fn now_ms() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

/// Every staged import, oldest first. An unreadable file is skipped, not fatal:
/// one bad row must not hide the others from the panel.
pub fn list(state: &Path) -> Vec<StagedImport> {
    let Ok(entries) = std::fs::read_dir(dir(state)) else { return Vec::new() };
    let mut rows: Vec<StagedImport> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| crate::storage::read_json::<StagedImport>(&e.path()).ok())
        .filter(|row| valid_id(&row.id))
        .collect();
    rows.sort_by(|a, b| (a.created.len(), &a.created, &a.id).cmp(&(b.created.len(), &b.created, &b.id)));
    rows
}

pub fn pending_count(state: &Path) -> usize {
    list(state).len()
}

/// Imported or discarded — either way the staged copy goes. Idempotent.
pub fn remove(state: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Unknown import".into());
    }
    let _guard = lock();
    match std::fs::remove_file(dir(state).join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn call(stores: &Stores, tab: &str, args: &Value) -> Result<(Value, Effects), String> {
    stores.check()?;
    // A reader is handed no attachment, and this must not become the way one
    // reaches the calendar; `root_mcp_security::tool` already says so.
    if stores.caller == Caller::Reader || !stores.access.allows(stores.caller, TOOL) {
        return Err(format!("unknown tool '{TOOL}'"));
    }
    // The import makes a calendar, which a scoped grant cannot.
    if !stores.access.calendars.all {
        return Err("Importing a calendar file needs the all-calendars grant".into());
    }
    let text = args["ics_text"].as_str().unwrap_or("");
    if text.len() > MAX_TEXT {
        return Err(format!("Calendar file too large ({} bytes; limit {MAX_TEXT}). The user can import it with the calendar's Import button.", text.len()));
    }
    // The one thing checked about the content: that it claims to be a calendar.
    // What is *in* it is the window's parser's business, not this process's.
    if !text.to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
        return Err("`ics_text` is not iCalendar text (no BEGIN:VCALENDAR)".into());
    }
    let name: String = super::root_mcp_mail::strip_invisible(args["name"].as_str().unwrap_or(""))
        .replace(['\n', '\t'], " ")
        .trim()
        .chars()
        .take(MAX_NAME)
        .collect();
    let _guard = lock();
    stores.check()?;
    let staged = list(stores.state);
    if staged.len() >= MAX_TOTAL || staged.iter().filter(|r| r.tab == tab).count() >= MAX_PER_TAB {
        return Err("Too many calendar imports are waiting; the user has to decide on those first".into());
    }
    let id = super::root_mcp::mint_token().ok_or("No OS entropy")?;
    let row = StagedImport { id: id.clone(), tab: tab.to_string(), name, created: now_ms(), text: text.to_string() };
    let folder = dir(stores.state);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    crate::storage::write_json_atomic(&folder.join(format!("{id}.json")), &row).map_err(|e| e.to_string())?;
    Ok((
        json!({
            "staged": true,
            "import": id,
            "note": concat!("Waiting in ", crate::app_name!(), "'s review panel. Nothing is imported until the user approves it there."),
        }),
        Effects::default(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::root_mcp_security::{Access, Policy, Scope};

    struct Fixture {
        dir: tempfile::TempDir,
        settings: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let settings = dir.path().join("settings.json");
            std::fs::write(&settings, "{}").unwrap();
            Fixture { dir, settings }
        }
        fn stores(&self, caller: Caller) -> Stores<'_> {
            Stores {
                calendar: &self.settings,
                projects: &self.settings,
                settings: &self.settings,
                state: self.dir.path(),
                caller,
                mail: None,
                reader_refusal: None,
                policy: Policy::load(&self.settings).unwrap(),
                access: Access::initial(caller),
                session: None,
                deadline: None,
            }
        }
    }
    const ICS: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn stages_the_text_and_echoes_none_of_it() {
        let f = Fixture::new();
        let (reply, effects) =
            call(&f.stores(Caller::Agent), "tab", &json!({"ics_text": ICS, "name": "Con\u{202e}f\nerence"})).unwrap();
        assert_eq!(reply["staged"], true);
        assert!(effects.changes.is_empty());
        assert!(!reply.to_string().contains("SUMMARY"));
        let rows = list(f.dir.path());
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, ICS);
        assert_eq!(rows[0].name, "Conf erence");
        assert_eq!(rows[0].tab, "tab");
        assert_eq!(reply["import"], rows[0].id);
        // No calendar row was written anywhere.
        assert_eq!(std::fs::read_to_string(&f.settings).unwrap(), "{}");
    }

    #[test]
    fn refuses_readers_scoped_grants_read_only_and_non_calendar_text() {
        let f = Fixture::new();
        let args = json!({"ics_text": ICS});
        assert!(call(&f.stores(Caller::Reader), "tab", &args).is_err());
        let mut scoped = f.stores(Caller::Agent);
        scoped.access.calendars = Scope { all: false, ids: vec!["default".into()] };
        assert!(call(&scoped, "tab", &args).is_err());
        let mut read_only = f.stores(Caller::Agent);
        read_only.access.write = false;
        assert!(call(&read_only, "tab", &args).is_err());
        assert!(call(&f.stores(Caller::Agent), "tab", &json!({"ics_text": "/etc/passwd"})).is_err());
        let big = format!("BEGIN:VCALENDAR{}", "x".repeat(MAX_TEXT));
        assert!(call(&f.stores(Caller::Agent), "tab", &json!({"ics_text": big})).is_err());
        assert!(list(f.dir.path()).is_empty());
    }

    #[test]
    fn caps_per_tab_and_remove_is_idempotent_and_id_bound() {
        let f = Fixture::new();
        let args = json!({"ics_text": ICS});
        for _ in 0..MAX_PER_TAB {
            call(&f.stores(Caller::Agent), "a", &args).unwrap();
        }
        assert!(call(&f.stores(Caller::Agent), "a", &args).is_err());
        call(&f.stores(Caller::Agent), "b", &args).unwrap();
        assert_eq!(pending_count(f.dir.path()), MAX_PER_TAB + 1);
        let id = list(f.dir.path())[0].id.clone();
        remove(f.dir.path(), &id).unwrap();
        remove(f.dir.path(), &id).unwrap();
        assert_eq!(pending_count(f.dir.path()), MAX_PER_TAB);
        // Never a path: an id that is not this module's hex touches nothing.
        assert!(remove(f.dir.path(), "../settings").is_err());
        assert!(f.settings.exists());
    }
}
