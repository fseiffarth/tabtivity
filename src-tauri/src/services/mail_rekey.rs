//! What a server's mailbox re-key is doing, for the Server settings (hosted
//! plan §6.8, user decision 2026-10-03).
//!
//! Revoking a device rotates the secrets key, and the rotation gives the mail
//! store a fresh master key (`mail_crypt::rotate_device_key_file`); the old
//! one stays in `key.json`'s `previous` list until every row is re-sealed
//! (`MailStore::rekey_step`, driven by `commands::mail`'s re-key thread).
//! This module only holds that thread's latest word, so a status route can
//! answer without reaching into `commands`.

use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use serde::Serialize;

use crate::services::mail_crypt::{self, MailKeys};
use crate::services::mail_store::{MailStore, RekeyStep};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RekeyState {
    /// Re-sealing, batch by batch; mail works meanwhile.
    Running,
    /// Waiting for the secrets key: everything is moved but the old key can
    /// only be retired while unlocked, or the store has not been opened since
    /// the rotation (a reboot before any device released the key).
    Waiting,
    /// Stopped on an error; retried at the next unlock, rotation or open.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RekeyStatus {
    pub state: RekeyState,
    /// Rows and blob files looked at so far, of `total` (0 of 0: not known).
    pub done: u64,
    pub total: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static STATUS: Mutex<Option<RekeyStatus>> = Mutex::new(None);

/// The re-key thread's word (`None`: not running, or finished).
pub fn set(status: Option<RekeyStatus>) {
    *STATUS.lock().unwrap_or_else(PoisonError::into_inner) = status;
}

pub fn current() -> Option<RekeyStatus> {
    STATUS.lock().unwrap_or_else(PoisonError::into_inner).clone()
}

/// What the Server settings show for the store in `mail_dir`: the thread's
/// word, else "waiting" while `key.json` still lists a previous master (the
/// thread has not run since — it starts when the store opens), else nothing.
pub fn status(mail_dir: &Path) -> Option<RekeyStatus> {
    current().or_else(|| pending(mail_dir))
}

/// "Waiting" when `key.json` in `mail_dir` still lists a previous master.
fn pending(mail_dir: &Path) -> Option<RekeyStatus> {
    let pending = mail_crypt::read_key_file(mail_dir).ok().flatten().is_some_and(|file| !file.previous.is_empty());
    pending.then_some(RekeyStatus { state: RekeyState::Waiting, done: 0, total: 0, error: None })
}

/// What the re-key loop needs from the process it runs in
/// (`commands::mail` on a server; the tests' own in tests).
pub trait Host {
    /// The open, persistent, encrypted store, without opening one (`None`:
    /// closed, or the memory-only stand-in — the next open resumes).
    fn store(&self) -> Option<Arc<MailStore>>;
    /// Re-read `key.json` and switch the store and the session to it;
    /// whether a re-key is still due.
    fn refresh(&self) -> Result<bool, String>;
    /// Drop the previous masters from `key.json` once nothing needs them
    /// ([`mail_crypt::retire_previous`]): `Ok(false)` when a newer rotation
    /// made another master current, [`mail_crypt::DEVICE_LOCKED`] while the
    /// secrets key is locked.
    fn retire(&self, dir: &Path, keys: &MailKeys) -> Result<bool, String>;
    /// Retiring waits for the secrets key: run again at the next release.
    fn wait_for_unlock(&self);
}

/// Re-key the open store until its keys hold no previous master: batch by
/// batch ([`MailStore::rekey_step`], `pause` apart so mail commands get the
/// store in between), then the files beside the database
/// ([`reseal_side_files`]), then retire the old masters and switch to the
/// keys `key.json` holds afterwards. A rotation mid-way changes the target
/// and the pass starts over towards the newest master. Keeps [`set`] up to
/// date; returns when done, waiting for the key, or stopped on an error.
pub fn run(host: &impl Host, pause: std::time::Duration) {
    let mut target = String::new();
    let (mut done, mut total) = (0u64, 0u64);
    let mut superseded = 0;
    let fail = |error: String| {
        eprintln!("mail: re-keying the mailbox stopped (retried at the next unlock or open): {error}");
        set(Some(RekeyStatus { state: RekeyState::Failed, done: 0, total: 0, error: Some(error) }));
    };
    loop {
        let Some(store) = host.store() else {
            set(None);
            return;
        };
        let Some(keys) = store.keys().filter(|k| k.rekeying()) else {
            set(None);
            return;
        };
        if keys.fingerprint() != target {
            target = keys.fingerprint();
            (done, total) = store.rekey_progress().unwrap_or_default();
        }
        match store.rekey_step() {
            Ok(RekeyStep::More { seen, .. }) => {
                done = (done + seen as u64).min(total);
                set(Some(RekeyStatus { state: RekeyState::Running, done, total, error: None }));
                std::thread::sleep(pause);
            }
            Ok(RekeyStep::Done) => {
                if let Err(error) = reseal_side_files(store.dir(), &keys) {
                    return fail(error);
                }
                match host.retire(store.dir(), &keys) {
                    Ok(true) => {
                        eprintln!("mail: re-keyed the mailbox; the previous key is retired");
                        let _ = store.rekey_clear();
                        set(None);
                        if let Err(error) = host.refresh() {
                            eprintln!("mail: reloading the key after the re-key failed (the next open does): {error}");
                            return;
                        }
                    }
                    // A newer rotation made another master the current one:
                    // switch to it, and the pass goes on towards that.
                    Ok(false) => {
                        superseded += 1;
                        if superseded > 3 {
                            return fail("the mail key file keeps changing under the re-key".into());
                        }
                        if let Err(error) = host.refresh() {
                            return fail(error);
                        }
                    }
                    // Everything is moved; retiring the old master needs the
                    // secrets key. The next release goes on.
                    Err(why) if why == mail_crypt::DEVICE_LOCKED => {
                        set(Some(RekeyStatus { state: RekeyState::Waiting, done: total, total, error: None }));
                        host.wait_for_unlock();
                        return;
                    }
                    Err(error) => return fail(error),
                }
            }
            Err(error) => return fail(error),
        }
    }
}

/// The re-key's pass over the sealed files beside the database (the account
/// list, the filter rules, the address book, the OpenPGP keyring): each one
/// still under a previous master is re-sealed under the current one, and all
/// are synced (a writer since the switch wrote them under the current key,
/// but not durably — and the old master is about to go).
pub fn reseal_side_files(dir: &Path, keys: &MailKeys) -> Result<(), String> {
    let _side = mail_crypt::side_files();
    for (name, aad) in [
        ("accounts.json.enc", mail_crypt::accounts_aad()),
        ("filters.json.enc", mail_crypt::filters_aad()),
        ("contacts.json.enc", mail_crypt::contacts_aad()),
    ] {
        let path = dir.join(name);
        let raw = match std::fs::read(&path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        };
        if let Ok((plain, false)) = keys.open_any(|k| &k.field, &aad, &raw) {
            mail_crypt::write_bytes_durable(&path, &mail_crypt::seal(&keys.field, &aad, &plain))?;
        }
    }
    crate::services::mail_pgp::reseal_keyring(dir, keys)?;
    for name in ["accounts.json.enc", "filters.json.enc", "contacts.json.enc", "pgp.json"] {
        // Opened for writing: `FlushFileBuffers` on Windows needs it.
        if let Ok(file) = std::fs::OpenOptions::new().read(true).write(true).open(dir.join(name)) {
            file.sync_all().map_err(|e| e.to_string())?;
        }
    }
    if let Ok(handle) = std::fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    //! The re-key on revoke (user decision 2026-10-03), on a real store: a
    //! full pass, a crash at several points and the resume, new mail written
    //! during it, a second revoke mid-way, and — the point of it all — a
    //! revoked device's old master opens nothing the store holds afterwards.

    use super::*;
    use crate::schema::mail::{MailAddress, MailAttachmentMeta, MailDraft, MailFolder, MailFolderKind, MailHeader, MailSort};
    use crate::services::mail_crypt::{device_kek_from, unlock_with_device_key};
    use crate::services::mail_store::{RekeyCrash, REKEY_CRASHED};
    use crate::services::server::secrets::MasterKey;
    use std::path::PathBuf;

    #[test]
    fn the_status_serializes_as_the_panel_reads_it() {
        let status = RekeyStatus { state: RekeyState::Running, done: 3, total: 10, error: None };
        assert_eq!(serde_json::to_value(&status).unwrap(), serde_json::json!({ "state": "running", "done": 3, "total": 10 }));
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(pending(dir.path()), None, "no key file: nothing to say");
    }

    /// More than two batches of rows.
    const MESSAGES: u32 = 450;
    const ACCOUNT: &str = "acct";

    fn folder() -> MailFolder {
        MailFolder { id: "acct|INBOX".into(), account_id: ACCOUNT.into(), path: "INBOX".into(), name: "INBOX".into(), kind: MailFolderKind::Inbox, unread: 0, total: 0 }
    }

    fn header(uid: u32) -> MailHeader {
        MailHeader {
            id: format!("acct|INBOX#{uid}"),
            account_id: ACCOUNT.into(),
            folder_id: folder().id,
            uid,
            rfc_message_id: Some(format!("<{uid}@example.com>")),
            subject: format!("subject {uid}"),
            from: MailAddress { name: Some("Sender".into()), address: "sender@example.com".into() },
            to: vec![MailAddress { name: None, address: "me@example.org".into() }],
            cc: Vec::new(),
            auth: None,
            date: format!("2026-09-{:02}T09:00:00Z", 1 + uid % 28),
            seen: false,
            flagged: false,
            answered: false,
            has_attachments: uid.is_multiple_of(50),
            size: 1234,
            preview: format!("preview of {uid}"),
            malformed_headers: None,
            priority: None,
            priority_source: None,
            priority_reason: None,
        }
    }

    /// Mail in every place a value is sealed: headers, a folder, bodies with
    /// raw blobs, attachments, a draft with a staged file, an agent mark.
    fn fill(store: &MailStore, uids: impl Iterator<Item = u32>) {
        store.upsert_folder(&folder()).unwrap();
        for uid in uids {
            let h = header(uid);
            store.upsert_header(&h).unwrap();
            if uid.is_multiple_of(50) {
                let raw = store.put_blob(format!("raw message {uid}").as_bytes()).unwrap();
                store.cache_body(&h.id, 1, Some(&format!("<p>body {uid}</p>")), Some(&format!("body {uid}")), "[]", 0, false, Some(&raw)).unwrap();
                let blob = store.put_blob(format!("attachment {uid}").as_bytes()).unwrap();
                let meta = MailAttachmentMeta { part_id: "2".into(), filename: format!("file-{uid}.pdf"), mime: "application/pdf".into(), size: 10, inline: false, type_mismatch: None };
                store.put_attachment(&h.id, &meta, &blob).unwrap();
            }
        }
    }

    struct Fixture {
        _tmp: tempfile::TempDir,
        mail: PathBuf,
        /// The K before the revoke, and the mail keys under it: what a
        /// revoked device opens with its copies of `wraps.json` and `key.json`.
        k1: MasterKey,
        old: Arc<MailKeys>,
        store: Arc<MailStore>,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let mail = tmp.path().join("mail");
        let k1 = MasterKey::generate();
        let old = Arc::new(mail_crypt::enable_with_device(&mail, &device_kek_from(&k1)).unwrap());
        let store = Arc::new(MailStore::open_with_keys(&mail, Some(old.clone())).unwrap());
        fill(&store, 1..=MESSAGES);
        store.save_draft(&MailDraft { id: "d1".into(), account_id: ACCOUNT.into(), subject: "draft subject".into(), body_text: "draft body".into(), ..Default::default() }).unwrap();
        store.stage_attachment("d1", "s1", "picked.pdf", "application/pdf", b"picked bytes").unwrap();
        assert_eq!(store.agent_mark(&[header(7).id], true).unwrap(), 1);
        mail_crypt::write_bytes_atomic(&mail.join("accounts.json.enc"), &mail_crypt::seal(&old.field, &mail_crypt::accounts_aad(), b"{\"accounts\":[]}")).unwrap();
        crate::services::mail_pgp::write_keyring_plaintext(&mail, &old, b"{\"version\":1,\"entries\":[]}").unwrap();
        Fixture { _tmp: tmp, mail, k1, old, store }
    }

    /// The vault's rotation, as far as the mail key file goes: a new K, the
    /// file re-keyed to it (written in place here; the vault moves it in).
    fn rotate(mail: &Path, from: &MasterKey) -> MasterKey {
        let to = MasterKey::generate();
        let bytes = mail_crypt::rotate_device_key_file(mail, from, &to).unwrap();
        mail_crypt::write_bytes_atomic(&mail_crypt::key_file_path(mail), &bytes).unwrap();
        to
    }

    fn keys_of(mail: &Path, k: &MasterKey) -> Arc<MailKeys> {
        Arc::new(unlock_with_device_key(mail, k).unwrap())
    }

    /// Run batches until the store says done; how many there were.
    fn run_to_done(store: &MailStore) -> usize {
        let mut steps = 0;
        while let RekeyStep::More { .. } = store.rekey_step().unwrap() {
            steps += 1;
            assert!(steps < 10_000, "a re-key that never ends");
        }
        steps
    }

    /// Finish as the thread does: the side files, then retire, then the
    /// keys `key.json` holds afterwards.
    fn finish(mail: &Path, k: &MasterKey, store: &MailStore) {
        let keys = store.keys().unwrap();
        reseal_side_files(mail, &keys).unwrap();
        assert!(mail_crypt::retire_previous_with(mail, k, &keys).unwrap(), "nothing newer: retired");
        assert!(mail_crypt::read_key_file(mail).unwrap().unwrap().previous.is_empty());
        store.rekey_clear().unwrap();
        let after = keys_of(mail, k);
        assert!(!after.rekeying());
        store.switch_keys(after).unwrap();
    }

    /// Everything the fixture wrote reads back through `store`, and nothing
    /// reads as damaged.
    fn assert_reads(store: &MailStore, mail: &Path, uids: &[u32]) {
        assert_eq!(store.folders(ACCOUNT).unwrap()[0].path, "INBOX");
        let page = store.headers_page(&folder().id, 0, 10_000, None, MailSort::Date, true, false).unwrap();
        assert_eq!(page.total as usize, uids.len());
        for h in &page.items {
            assert_eq!(h.subject, format!("subject {}", h.uid));
            assert_eq!(h.preview, format!("preview of {}", h.uid));
            assert!(h.malformed_headers.is_none(), "damaged: {h:?}");
        }
        for uid in uids.iter().filter(|u| u.is_multiple_of(50)) {
            let id = header(*uid).id;
            let (html, _, _, _, _) = store.cached_body(&id, 1).unwrap().expect("a cached body");
            assert_eq!(html.as_deref(), Some(format!("<p>body {uid}</p>").as_str()));
            let (meta, digest) = store.attachment(&id, "2").unwrap().expect("an attachment");
            assert_eq!(meta.filename, format!("file-{uid}.pdf"));
            assert_eq!(store.get_blob(&digest).unwrap(), format!("attachment {uid}").as_bytes());
        }
        assert_eq!(store.draft("d1").unwrap().unwrap().subject, "draft subject");
        assert_eq!(store.staged("d1").unwrap()[0].filename, "picked.pdf");
        assert_eq!(store.staged_bytes("d1", "s1").unwrap(), b"picked bytes");
        assert!(store.agent_marked(&header(7).id).unwrap());
        let keys = store.keys().unwrap();
        let accounts = std::fs::read(mail.join("accounts.json.enc")).unwrap();
        assert!(keys.open_any(|k| &k.field, &mail_crypt::accounts_aad(), &accounts).is_ok(), "the account list");
        assert!(crate::services::mail_pgp::keyring_plaintext(mail, &keys).unwrap().is_some(), "the keyring");
    }

    /// The revoked device's view: the old K and old copies of `key.json`
    /// give it the old master's keys. Nothing in the store opens with them:
    /// no sealed column, no blob, no staged file, no side file — and the
    /// key file itself does not open with the old K.
    fn assert_old_opens_nothing(mail: &Path, k1: &MasterKey, old: &MailKeys) {
        assert!(unlock_with_device_key(mail, k1).is_err(), "the key file under the old K");
        let conn = rusqlite::Connection::open(mail.join("mail.db")).unwrap();
        let mut checked = 0;
        for (sql, table, column) in [
            ("SELECT id, account_id, subject FROM messages", "messages", "subject"),
            ("SELECT id, account_id, preview FROM messages", "messages", "preview"),
            ("SELECT id, account_id, path FROM folders", "folders", "path"),
            ("SELECT id, account_id, json FROM drafts", "drafts", "json"),
            ("SELECT message_id, '', html FROM bodies_cache", "bodies_cache", "html"),
            ("SELECT message_id || char(0) || part_id, '', filename FROM attachments", "attachments", "filename"),
            ("SELECT draft_id || char(0) || staged_id, '', filename FROM staged", "staged", "filename"),
        ] {
            let mut stmt = conn.prepare(sql).unwrap();
            let rows: Vec<(String, String, Vec<u8>)> = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect();
            for (row, account, sealed) in rows {
                let aad = mail_crypt::field_aad(&account, table, column, &row);
                assert!(mail_crypt::open(&old.field, &aad, &sealed).is_err(), "{table}.{column} of {row} opens with the old master");
                checked += 1;
            }
        }
        assert!(checked > MESSAGES as usize, "{checked} values checked");
        let mut blobs = 0;
        for entry in std::fs::read_dir(mail.join("blobs")).unwrap().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let bytes = std::fs::read(entry.path()).unwrap();
            assert!(mail_crypt::open(&old.blob, &mail_crypt::blob_aad(&name), &bytes).is_err(), "blob {name}");
            blobs += 1;
        }
        assert!(blobs > 0);
        let staged = std::fs::read(mail.join("outbox/d1/s1")).unwrap();
        assert!(mail_crypt::open(&old.blob, &mail_crypt::staged_aad("d1", "s1"), &staged).is_err(), "the staged file");
        let accounts = std::fs::read(mail.join("accounts.json.enc")).unwrap();
        assert!(mail_crypt::open(&old.field, &mail_crypt::accounts_aad(), &accounts).is_err(), "the account list");
        assert!(crate::services::mail_pgp::keyring_plaintext(mail, old).is_err(), "the keyring");
    }

    fn all_uids() -> Vec<u32> {
        (1..=MESSAGES).collect()
    }

    #[test]
    fn a_full_re_key_moves_everything_and_the_old_master_opens_nothing() {
        let f = fixture();
        let k2 = rotate(&f.mail, &f.k1);
        // Between the rotation and the switch the store still writes under
        // the old master — which `previous` keeps readable and the pass moves.
        f.store.upsert_header(&header(MESSAGES + 1)).unwrap();
        let ring = keys_of(&f.mail, &k2);
        assert!(ring.rekeying() && !ring.same_master(&f.old));
        f.store.switch_keys(ring.clone()).unwrap();
        let mut uids = all_uids();
        uids.push(MESSAGES + 1);
        assert_reads(&f.store, &f.mail, &uids);

        // Mail after the switch is sealed under the new master at once.
        f.store.upsert_header(&header(MESSAGES + 2)).unwrap();
        uids.push(MESSAGES + 2);
        let conn = rusqlite::Connection::open(f.mail.join("mail.db")).unwrap();
        let fresh: Vec<u8> = conn.query_row("SELECT subject FROM messages WHERE id = ?1", [header(MESSAGES + 2).id], |r| r.get(0)).unwrap();
        let aad = mail_crypt::field_aad(ACCOUNT, "messages", "subject", &header(MESSAGES + 2).id);
        assert!(mail_crypt::open(&f.old.field, &aad, &fresh).is_err() && mail_crypt::open(&ring.field, &aad, &fresh).is_ok());

        let (done, total) = f.store.rekey_progress().unwrap();
        assert!(done == 0 && total > MESSAGES as u64, "{done}/{total}");
        assert!(run_to_done(&f.store) > 3, "several batches");
        assert_eq!(f.store.rekey_progress().unwrap().0, f.store.rekey_progress().unwrap().1, "all of it");
        finish(&f.mail, &k2, &f.store);
        assert_reads(&f.store, &f.mail, &uids);
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
        // A fresh process opens it with the new K alone.
        drop(f.store);
        let reopened = MailStore::open_with_keys(&f.mail, Some(keys_of(&f.mail, &k2))).unwrap();
        assert_reads(&reopened, &f.mail, &uids);
    }

    /// The mail re-key review's three open gaps, closed (user decision, final
    /// review): a blob written under the old keys just before the switch and
    /// named by a row only after the blob stage still opens under its old
    /// name — under the new key; replies keep finding their message under
    /// the new key's digest (and no old-key digest is left); the WAL holds
    /// nothing from before the pass when the old master is retired.
    #[test]
    fn late_blobs_reply_links_and_the_wal_follow_the_re_key() {
        let f = fixture();
        let late = f.store.put_blob(b"late attachment bytes").unwrap();
        let sent = MailFolder { id: "acct|Sent".into(), account_id: ACCOUNT.into(), path: "Sent".into(), name: "Sent".into(), kind: MailFolderKind::Sent, unread: 0, total: 0 };
        f.store.upsert_folder(&sent).unwrap();
        let mut reply = header(9_001);
        reply.id = "acct|Sent#9001".into();
        reply.folder_id = sent.id.clone();
        reply.rfc_message_id = Some("<reply-9001@example.org>".into());
        f.store.upsert_header(&reply).unwrap();
        f.store.set_reply_key(&reply.id, Some("<3@example.com>")).unwrap();
        assert_eq!(f.store.replies_to(&header(3).id).unwrap().len(), 1);
        let old_digest = mail_crypt::name_digest(&f.old.name, "reply", "3@example.com");

        let k2 = rotate(&f.mail, &f.k1);
        f.store.switch_keys(keys_of(&f.mail, &k2)).unwrap();
        run_to_done(&f.store);
        let wal = f.mail.join("mail.db-wal");
        assert!(std::fs::metadata(&wal).map(|m| m.len()).unwrap_or(0) == 0, "the WAL was truncated before the retire");
        finish(&f.mail, &k2, &f.store);

        // The late row names the blob by the name `put_blob` gave it.
        let meta = MailAttachmentMeta { part_id: "9".into(), filename: "late.pdf".into(), mime: "application/pdf".into(), size: 21, inline: false, type_mismatch: None };
        f.store.put_attachment(&header(3).id, &meta, &late).unwrap();
        assert_eq!(f.store.get_blob(&late).unwrap(), b"late attachment bytes");
        let on_disk = std::fs::read(f.mail.join("blobs").join(&late)).unwrap();
        assert!(mail_crypt::open(&f.old.blob, &mail_crypt::blob_aad(&late), &on_disk).is_err(), "the old master opens it no more");

        assert_eq!(f.store.replies_to(&header(3).id).unwrap().iter().map(|h| h.id.clone()).collect::<Vec<_>>(), [reply.id.clone()]);
        let conn = rusqlite::Connection::open(f.mail.join("mail.db")).unwrap();
        let stale: i64 = conn.query_row("SELECT COUNT(*) FROM messages WHERE reply_key = ?1", [old_digest], |r| r.get(0)).unwrap();
        assert_eq!(stale, 0, "no digest under the retired key is left");
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
    }

    /// The process dies after a number of batches (or inside the blob pass,
    /// or after the last batch before the retire); every time, the store
    /// reopened with the keys on disk reads everything, and the pass resumes
    /// from its marker to the same end.
    #[test]
    fn a_crash_at_any_point_of_a_re_key_loses_nothing_and_resumes() {
        enum Crash {
            AfterSteps(usize),
            Blob(RekeyCrash),
        }
        for crash in [Crash::AfterSteps(0), Crash::AfterSteps(1), Crash::AfterSteps(2), Crash::AfterSteps(4), Crash::AfterSteps(1_000), Crash::Blob(RekeyCrash::BlobsWritten), Crash::Blob(RekeyCrash::BlobsCommitted)] {
            let f = fixture();
            let k2 = rotate(&f.mail, &f.k1);
            f.store.switch_keys(keys_of(&f.mail, &k2)).unwrap();
            match crash {
                Crash::AfterSteps(n) => {
                    for _ in 0..n {
                        if f.store.rekey_step().unwrap() == RekeyStep::Done {
                            break;
                        }
                    }
                }
                Crash::Blob(at) => loop {
                    match f.store.rekey_step_inner(Some(at)) {
                        Err(why) if why == REKEY_CRASHED => break,
                        Ok(RekeyStep::More { .. }) => {}
                        other => panic!("{at:?}: never reached: {other:?}"),
                    }
                },
            }
            // The restart: a new store on the same files, the keys from disk.
            drop(f.store);
            let store = MailStore::open_with_keys(&f.mail, Some(keys_of(&f.mail, &k2))).unwrap();
            assert_reads(&store, &f.mail, &all_uids());
            run_to_done(&store);
            finish(&f.mail, &k2, &store);
            assert_reads(&store, &f.mail, &all_uids());
            assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
        }
    }

    /// Mail keeps arriving while the pass runs (a sync on another thread):
    /// it is sealed under the new master from the start, nothing written
    /// meanwhile is left under the old one, and nothing reads as damaged.
    #[test]
    fn new_mail_during_a_re_key_is_sealed_under_the_new_key() {
        let f = fixture();
        let k2 = rotate(&f.mail, &f.k1);
        f.store.switch_keys(keys_of(&f.mail, &k2)).unwrap();
        let writer = {
            let store = f.store.clone();
            std::thread::spawn(move || {
                for uid in MESSAGES + 1..=MESSAGES + 300 {
                    fill(&store, std::iter::once(uid));
                    // A re-sync rewrites existing rows too.
                    store.upsert_header(&header(uid - MESSAGES)).unwrap();
                }
            })
        };
        run_to_done(&f.store);
        writer.join().unwrap();
        finish(&f.mail, &k2, &f.store);
        let uids: Vec<u32> = (1..=MESSAGES + 300).collect();
        assert_reads(&f.store, &f.mail, &uids);
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
    }

    /// A second device revoked while the first re-key runs: the store
    /// switches to the newest master, a retire aimed at the superseded one
    /// changes nothing, and the pass ends with neither old master opening
    /// anything.
    #[test]
    fn a_second_revoke_mid_way_re_keys_towards_the_newest_key() {
        let f = fixture();
        let k2 = rotate(&f.mail, &f.k1);
        let ring2 = keys_of(&f.mail, &k2);
        f.store.switch_keys(ring2.clone()).unwrap();
        for _ in 0..3 {
            f.store.rekey_step().unwrap();
        }
        let k3 = rotate(&f.mail, &k2);
        let ring3 = keys_of(&f.mail, &k3);
        assert_eq!(ring3.previous().len(), 2, "both earlier masters stay readable");
        assert!(!mail_crypt::retire_previous_with(&f.mail, &k3, &ring2).unwrap(), "a retire for the superseded master is refused");
        f.store.switch_keys(ring3).unwrap();
        assert_reads(&f.store, &f.mail, &all_uids());
        run_to_done(&f.store);
        finish(&f.mail, &k3, &f.store);
        assert_reads(&f.store, &f.mail, &all_uids());
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
        assert_old_opens_nothing(&f.mail, &k2, &ring2);
    }

    /// Blob files whose new keyed name is already taken: the same bytes
    /// arrived again after the switch (`put_blob` wrote them, unsynced) — that
    /// copy is adopted; a file there that does not open under the current
    /// key (a torn write) is replaced, never pointed at. A blob two messages
    /// share moves for both.
    #[test]
    fn a_blob_already_under_its_new_name_is_adopted_only_if_it_opens() {
        let f = fixture();
        let shared = f.store.put_blob(b"shared attachment").unwrap();
        let meta = |part: &str| MailAttachmentMeta { part_id: part.into(), filename: "shared.pdf".into(), mime: "application/pdf".into(), size: 17, inline: false, type_mismatch: None };
        f.store.put_attachment(&header(1).id, &meta("3"), &shared).unwrap();
        f.store.put_attachment(&header(2).id, &meta("3"), &shared).unwrap();
        let k2 = rotate(&f.mail, &f.k1);
        let ring = keys_of(&f.mail, &k2);
        f.store.switch_keys(ring.clone()).unwrap();
        // The same bytes again since the switch: already under the new name.
        let again = f.store.put_blob(b"attachment 100").unwrap();
        assert_eq!(again, mail_crypt::blob_id(&ring.addr, b"attachment 100"));
        // A torn file where another blob's new name points.
        let torn = mail_crypt::blob_id(&ring.addr, b"attachment 150");
        std::fs::write(f.mail.join("blobs").join(&torn), b"not an envelope").unwrap();

        run_to_done(&f.store);
        finish(&f.mail, &k2, &f.store);
        assert_reads(&f.store, &f.mail, &all_uids());
        for uid in [1, 2] {
            let (_, digest) = f.store.attachment(&header(uid).id, "3").unwrap().expect("the shared attachment");
            assert_eq!(digest, mail_crypt::blob_id(&ring.addr, b"shared attachment"), "both rows follow the move");
            assert_eq!(f.store.get_blob(&digest).unwrap(), b"shared attachment");
        }
        assert!(!f.mail.join("blobs").join(&shared).exists(), "the old file is gone");
        assert_eq!(f.store.attachment(&header(100).id, "2").unwrap().unwrap().1, again, "adopted");
        assert_eq!(f.store.get_blob(&torn).unwrap(), b"attachment 150", "rewritten, not adopted");
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
    }

    /// The thread's loop ([`run`]) against a host that holds K: it moves
    /// everything, retires, and switches to the retired keys; while the key
    /// is locked it waits with everything moved and finishes on the next try.
    #[test]
    fn the_loop_finishes_or_waits_for_the_key() {
        struct TestHost {
            store: Arc<MailStore>,
            mail: PathBuf,
            k: Mutex<Option<MasterKey>>,
            waited: std::sync::atomic::AtomicBool,
        }
        impl Host for TestHost {
            fn store(&self) -> Option<Arc<MailStore>> {
                Some(self.store.clone())
            }
            fn refresh(&self) -> Result<bool, String> {
                let guard = self.k.lock().unwrap();
                let k = guard.as_ref().ok_or(mail_crypt::DEVICE_LOCKED)?;
                let keys = keys_of(&self.mail, k);
                self.store.switch_keys(keys.clone())?;
                Ok(keys.rekeying())
            }
            fn retire(&self, dir: &Path, keys: &MailKeys) -> Result<bool, String> {
                let guard = self.k.lock().unwrap();
                mail_crypt::retire_previous_with(dir, guard.as_ref().ok_or(mail_crypt::DEVICE_LOCKED)?, keys)
            }
            fn wait_for_unlock(&self) {
                self.waited.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let f = fixture();
        let k2 = rotate(&f.mail, &f.k1);
        f.store.switch_keys(keys_of(&f.mail, &k2)).unwrap();
        let host = TestHost { store: f.store.clone(), mail: f.mail.clone(), k: Mutex::new(None), waited: Default::default() };
        run(&host, std::time::Duration::ZERO);
        assert!(host.waited.load(std::sync::atomic::Ordering::SeqCst), "locked: waits");
        assert!(f.store.keys().unwrap().rekeying(), "nothing retired while locked");
        assert_reads(&f.store, &f.mail, &all_uids());
        *host.k.lock().unwrap() = Some(k2);
        run(&host, std::time::Duration::ZERO);
        assert!(!f.store.keys().unwrap().rekeying(), "retired and switched");
        assert_reads(&f.store, &f.mail, &all_uids());
        assert_old_opens_nothing(&f.mail, &f.k1, &f.old);
    }
}
