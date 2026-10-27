//! **Thunderbird's address books, read** — the Address Book's "Import from
//! Thunderbird", and a picked `abook.sqlite` on the file-import path.
//!
//! Read-only, and never in place: each database (with its `-wal`, so changes
//! Thunderbird has not checkpointed yet are seen) is copied into a temp dir
//! and opened there, so a running Thunderbird's locks and files are never
//! touched. The contents are untrusted text like any import — every card goes
//! through `mail_contacts::merge_import`'s normalization afterwards.
//!
//! `AppHandle`-free; the caller supplies the home directory.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::types::ValueRef;
use rusqlite::Connection;

use crate::schema::mail::{MailContact, MailContactList, MailContactPhone};
use crate::services::mail_contacts::{self, MAX_CONTACTS, MAX_LISTS};

/// Largest database copied. A real address book is kilobytes to a few MiB.
pub const MAX_DB_BYTES: u64 = 64 * 1024 * 1024;

/// One address-book database found in a profile.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BookFile {
    pub path: PathBuf,
    /// `history.sqlite`: Thunderbird's "Collected Addresses".
    pub collected: bool,
}

/// What one database held, raw — not yet normalized.
#[derive(Debug, Default)]
pub struct ReadBook {
    pub cards: Vec<MailContact>,
    pub lists: Vec<MailContactList>,
}

/// Where Thunderbird keeps profiles, for every OS at once — a directory that
/// does not exist costs one `stat`. The Flatpak location is left out on
/// purpose: its app id would trip `nothing_reaches_into_another_browsers_profile`
/// (Firefox's profile marker); a Flatpak user picks `abook.sqlite` in Import….
fn profile_roots(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".thunderbird"),
        home.join("snap/thunderbird/common/.thunderbird"),
        home.join("Library/Thunderbird"),
        home.join("AppData/Roaming/Thunderbird"),
    ]
}

/// Whether a profile file is an address book: `abook.sqlite`, `abook-N.sqlite`
/// (further local and CardDAV books) or `history.sqlite`.
fn book_kind(name: &str) -> Option<bool> {
    if name == "history.sqlite" {
        return Some(true);
    }
    let stem = name.strip_suffix(".sqlite")?;
    let rest = stem.strip_prefix("abook")?;
    (rest.is_empty() || rest.strip_prefix('-').is_some_and(|n| n.chars().all(|c| c.is_ascii_digit())))
        .then_some(false)
}

/// Every address book in every profile under `home`, Personal books first.
/// A profile sits either directly in a root or under its `Profiles/`.
pub fn find_books(home: &Path) -> Vec<BookFile> {
    let mut profiles = Vec::new();
    for root in profile_roots(home) {
        for dir in [root.clone(), root.join("Profiles")] {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    profiles.push(e.path());
                }
            }
        }
    }
    profiles.sort();
    let mut books = Vec::new();
    for p in profiles {
        let Ok(entries) = std::fs::read_dir(&p) else { continue };
        let mut here: Vec<BookFile> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
            .filter_map(|e| {
                let collected = book_kind(e.file_name().to_str()?)?;
                Some(BookFile { path: e.path(), collected })
            })
            .collect();
        here.sort_by(|a, b| a.path.cmp(&b.path));
        books.extend(here);
    }
    books.sort_by_key(|b| b.collected);
    books
}

/// Read one database: copy it (and its `-wal`) aside, then query the copy.
pub fn read_book(path: &Path) -> Result<ReadBook, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a file".into());
    }
    if meta.len() > MAX_DB_BYTES {
        return Err(format!(
            "the address book is larger than {} MiB",
            MAX_DB_BYTES / (1024 * 1024)
        ));
    }
    let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let copy = tmp.path().join("abook.sqlite");
    std::fs::copy(path, &copy).map_err(|e| e.to_string())?;
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    let wal = PathBuf::from(wal);
    if wal.is_file() && std::fs::metadata(&wal).is_ok_and(|m| m.len() <= MAX_DB_BYTES) {
        let _ = std::fs::copy(&wal, tmp.path().join("abook.sqlite-wal"));
    }
    let conn = Connection::open(&copy).map_err(|e| e.to_string())?;
    // A picked file may be anyone's: no schema-defined functions or views run.
    let _ = conn.execute_batch("PRAGMA trusted_schema = OFF;");
    read_conn(&conn)
}

fn text(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        ValueRef::Integer(i) => i.to_string(),
        ValueRef::Real(f) => f.to_string(),
        ValueRef::Null | ValueRef::Blob(_) => String::new(),
    }
}

fn has_table(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [name],
        |_| Ok(()),
    )
    .is_ok()
}

fn read_conn(conn: &Connection) -> Result<ReadBook, String> {
    if !has_table(conn, "properties") {
        return Err("this is not a Thunderbird address book".into());
    }
    // card uid → its properties, in first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut props: HashMap<String, HashMap<String, String>> = HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT card, name, value FROM properties")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let card = text(r.get_ref(0).map_err(|e| e.to_string())?);
            let name = text(r.get_ref(1).map_err(|e| e.to_string())?);
            let value = text(r.get_ref(2).map_err(|e| e.to_string())?);
            if !props.contains_key(&card) {
                if order.len() >= MAX_CONTACTS {
                    continue;
                }
                order.push(card.clone());
            }
            props.entry(card).or_default().insert(name, value);
        }
    }

    let mut out = ReadBook::default();
    let mut first_email: HashMap<String, String> = HashMap::new();
    for uid in &order {
        let c = card_from(&props[uid]);
        if let Some(e) = c.emails.first() {
            first_email.insert(uid.clone(), e.clone());
        }
        out.cards.push(c);
    }

    if has_table(conn, "lists") && has_table(conn, "list_cards") {
        let mut members: HashMap<String, Vec<String>> = HashMap::new();
        let mut stmt = conn
            .prepare("SELECT list, card FROM list_cards")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            let list = text(r.get_ref(0).map_err(|e| e.to_string())?);
            let card = text(r.get_ref(1).map_err(|e| e.to_string())?);
            if let Some(e) = first_email.get(&card) {
                members.entry(list).or_default().push(e.clone());
            }
        }
        let mut stmt = conn
            .prepare("SELECT uid, name, nickName, description FROM lists")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            if out.lists.len() >= MAX_LISTS {
                break;
            }
            let uid = text(r.get_ref(0).map_err(|e| e.to_string())?);
            out.lists.push(MailContactList {
                name: text(r.get_ref(1).map_err(|e| e.to_string())?),
                nickname: text(r.get_ref(2).map_err(|e| e.to_string())?),
                description: text(r.get_ref(3).map_err(|e| e.to_string())?),
                members: members.remove(&uid).unwrap_or_default(),
                ..Default::default()
            });
        }
    }
    Ok(out)
}

/// One card from its properties. Thunderbird 102+ keeps the whole card as a
/// vCard in `_vCard` (plus a few cached columns); older profiles only have the
/// named properties. The vCard wins; the named ones fill what it lacks.
fn card_from(p: &HashMap<String, String>) -> MailContact {
    let get = |k: &str| p.get(k).map(|v| v.trim().to_string()).unwrap_or_default();
    let mut c = p
        .get("_vCard")
        .and_then(|v| mail_contacts::parse_vcards(v).into_iter().next())
        .unwrap_or_default();
    let fill = |slot: &mut String, v: String| {
        if slot.is_empty() {
            *slot = v;
        }
    };
    fill(&mut c.display_name, get("DisplayName"));
    fill(&mut c.first_name, get("FirstName"));
    fill(&mut c.last_name, get("LastName"));
    fill(&mut c.nickname, get("NickName"));
    fill(&mut c.organization, get("Company"));
    fill(&mut c.job_title, get("JobTitle"));
    fill(&mut c.notes, get("Notes"));
    let web = get("WebPage1");
    fill(&mut c.website, if web.is_empty() { get("WebPage2") } else { web });
    for k in ["PrimaryEmail", "SecondEmail"] {
        let e = get(k);
        if !e.is_empty() && !c.emails.iter().any(|x| x.eq_ignore_ascii_case(&e)) {
            c.emails.push(e);
        }
    }
    for (k, kind) in [
        ("WorkPhone", "work"),
        ("HomePhone", "home"),
        ("CellularNumber", "cell"),
        ("FaxNumber", "fax"),
        ("PagerNumber", "pager"),
    ] {
        let n = get(k);
        if !n.is_empty() && !c.phones.iter().any(|x| x.number == n) {
            c.phones.push(MailContactPhone { kind: kind.into(), number: n });
        }
    }
    if c.address.is_empty() {
        let lines = |prefix: &str| -> Vec<String> {
            ["Address", "Address2", "City", "State", "ZipCode", "Country"]
                .iter()
                .map(|s| get(&format!("{prefix}{s}")))
                .filter(|s| !s.is_empty())
                .collect()
        };
        let home = lines("Home");
        c.address = if home.is_empty() { lines("Work") } else { home }.join("\n");
    }
    if c.birthday.is_empty() {
        let (y, m, d) = (get("BirthYear"), get("BirthMonth"), get("BirthDay"));
        if !m.is_empty() && !d.is_empty() {
            let (m, d) = (format!("{m:0>2}"), format!("{d:0>2}"));
            c.birthday = if y.is_empty() { format!("--{m}-{d}") } else { format!("{y}-{m}-{d}") };
        }
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tb_db(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE properties (card TEXT, name TEXT, value TEXT);
             CREATE TABLE lists (uid TEXT PRIMARY KEY, name TEXT, nickName TEXT, description TEXT);
             CREATE TABLE list_cards (list TEXT, card TEXT);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn book_file_names() {
        assert_eq!(book_kind("abook.sqlite"), Some(false));
        assert_eq!(book_kind("abook-3.sqlite"), Some(false));
        assert_eq!(book_kind("history.sqlite"), Some(true));
        assert_eq!(book_kind("abook-x.sqlite"), None);
        assert_eq!(book_kind("abook.sqlite-wal"), None);
        assert_eq!(book_kind("places.sqlite"), None);
    }

    #[test]
    fn finds_books_in_both_profile_layouts_personal_first() {
        let home = tempfile::tempdir().unwrap();
        let a = home.path().join(".thunderbird/abc.default-release");
        let b = home.path().join("Library/Thunderbird/Profiles/xyz.default");
        for d in [&a, &b] {
            std::fs::create_dir_all(d).unwrap();
        }
        std::fs::write(a.join("history.sqlite"), b"").unwrap();
        std::fs::write(a.join("abook.sqlite"), b"").unwrap();
        std::fs::write(a.join("places.sqlite"), b"").unwrap();
        std::fs::write(b.join("abook-1.sqlite"), b"").unwrap();
        let found = find_books(home.path());
        let names: Vec<(String, bool)> = found
            .iter()
            .map(|f| (f.path.file_name().unwrap().to_string_lossy().into_owned(), f.collected))
            .collect();
        assert_eq!(names.len(), 3);
        assert!(names[..2].iter().all(|(_, c)| !c));
        assert_eq!(names[2], ("history.sqlite".to_string(), true));
    }

    #[test]
    fn reads_modern_and_legacy_cards_and_lists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abook.sqlite");
        let conn = tb_db(&path);
        let rows = [
            ("c1", "_vCard", "BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Ada Lovelace\r\nEMAIL:ada@x.test\r\nEND:VCARD"),
            ("c1", "PrimaryEmail", "ada@x.test"),
            ("c1", "CellularNumber", "123"),
            ("c2", "DisplayName", "Bob Legacy"),
            ("c2", "PrimaryEmail", "bob@x.test"),
            ("c2", "SecondEmail", "b@y.test"),
            ("c2", "HomeCity", "Bonn"),
            ("c2", "BirthMonth", "3"),
            ("c2", "BirthDay", "7"),
        ];
        for (card, name, value) in rows {
            conn.execute("INSERT INTO properties VALUES (?1, ?2, ?3)", [card, name, value]).unwrap();
        }
        conn.execute("INSERT INTO lists VALUES ('l1', 'Friends', 'fr', '')", []).unwrap();
        conn.execute("INSERT INTO list_cards VALUES ('l1', 'c1'), ('l1', 'c2')", []).unwrap();
        drop(conn);

        let book = read_book(&path).unwrap();
        assert_eq!(book.cards.len(), 2);
        let ada = book.cards.iter().find(|c| c.display_name == "Ada Lovelace").unwrap();
        assert_eq!(ada.emails, ["ada@x.test"]);
        assert_eq!(ada.phones[0].number, "123");
        let bob = book.cards.iter().find(|c| c.display_name == "Bob Legacy").unwrap();
        assert_eq!(bob.emails, ["bob@x.test", "b@y.test"]);
        assert_eq!(bob.address, "Bonn");
        assert_eq!(bob.birthday, "--03-07");
        assert_eq!(book.lists.len(), 1);
        assert_eq!(book.lists[0].name, "Friends");
        let mut members = book.lists[0].members.clone();
        members.sort();
        assert_eq!(members, ["ada@x.test", "bob@x.test"]);
    }

    #[test]
    fn a_database_that_is_not_an_address_book_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("other.sqlite");
        Connection::open(&path).unwrap().execute_batch("CREATE TABLE t (x);").unwrap();
        assert!(read_book(&path).is_err());
    }
}
