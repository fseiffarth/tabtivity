//! **Why is the mailbox empty?** — the headless answer.
//!
//!   cargo run --example mail_probe --manifest-path src-tauri/Cargo.toml
//!
//! An account that "vanished" and a mailbox that came back empty are, on this
//! design, usually the *same* event seen twice: the account list and the message
//! index are both sealed under one key, so a key that cannot be reached takes
//! both with it — and the degrade is deliberately silent (`Unlock::Unavailable`
//! opens a memory-only store rather than refusing to open the mailbox at all,
//! because a locked keyring must not be able to make mail unreadable *forever*).
//! Silent is right for the app and useless for diagnosis, which is what this
//! probe is for: it names which of the four unlock outcomes actually happened.
//!
//! Read-only. It opens nothing that is not already on disk, writes nothing,
//! touches no network, and prints no secret — account **labels**, never
//! passwords, never message content.

use std::path::PathBuf;

use app_lib::commands::mail as mail_cmd;
use app_lib::services::mail_crypt::{self, Unlock};
use app_lib::services::mail_store::MailStore;

fn mail_dir() -> PathBuf {
    app_lib::storage::state_dir().join("mail")
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // FIRST, before anything in this process has opened the mail database —
    // which is exactly the order a launch runs in, because the header's unread
    // badge calls this command before any mail surface exists. On an encrypted
    // install this used to answer "no accounts": the sealed list needs the store
    // key, and nothing had asked for it yet. If this prints 0 while the sealed
    // file below opens fine, that regression is back.
    println!("mail_accounts_list() on a cold process:");
    match mail_cmd::mail_accounts_list().await {
        Ok(list) => {
            println!("  {} account(s)", list.len());
            for a in &list {
                println!("    - {} [{}]", a.label, a.id);
            }
        }
        Err(e) => println!("  failed: {e}"),
    }
    println!();

    let dir = mail_dir();
    println!("mail dir: {}", dir.display());
    for name in [
        "key.json",
        "accounts.json",
        "accounts.json.enc",
        "filters.json",
        "filters.json.enc",
        "mail.db",
    ] {
        let p = dir.join(name);
        match std::fs::metadata(&p) {
            Ok(m) => println!("  {name:<18} {} bytes", m.len()),
            Err(_) => println!("  {name:<18} —"),
        }
    }

    // The one question. Every "my account disappeared" report resolves here.
    println!("\nunlock:");
    let keys = match mail_crypt::unlock(&dir) {
        Unlock::Ready(k) => {
            println!("  Ready — the store key was read; nothing should look empty");
            Some(k)
        }
        Unlock::Disabled => {
            println!("  Disabled — this store is not encrypted (plain accounts.json)");
            None
        }
        Unlock::NeedsPassphrase => {
            println!("  NeedsPassphrase — a passphrase store nobody has unlocked this session.");
            println!("  Until it is typed, the app runs on a MEMORY-ONLY store: no accounts,");
            println!("  no mail, and everything synced meanwhile is discarded at exit.");
            None
        }
        Unlock::Unavailable(why) => {
            println!("  Unavailable — {why}");
            println!("  This is the one that looks like data loss and is not: the sealed");
            println!("  accounts.json.enc cannot be opened, so the account list reads EMPTY,");
            println!("  and the store degrades to memory-only, so the mailbox reads empty too.");
            println!("  Nothing on disk was touched — unlock the keyring and relaunch.");
            None
        }
    };

    // What the app would actually show, read the same way it reads it.
    println!("\naccounts:");
    let enc = dir.join("accounts.json.enc");
    let plain = dir.join("accounts.json");
    if let Some(keys) = &keys {
        if enc.exists() {
            match std::fs::read(&enc)
                .map_err(|e| e.to_string())
                .and_then(|raw| {
                    mail_crypt::open(&keys.field, &mail_crypt::accounts_aad(), &raw)
                        .map_err(|e| e.to_string())
                }) {
                Ok(plain_bytes) => print_labels(&plain_bytes),
                Err(e) => println!("  sealed list did not decrypt: {e}"),
            }
        } else if plain.exists() {
            match std::fs::read(&plain) {
                Ok(b) => print_labels(&b),
                Err(e) => println!("  {e}"),
            }
        } else {
            println!("  no account file at all — nothing was ever configured here");
        }
    } else if enc.exists() {
        println!(
            "  {} exists but cannot be opened without the key.",
            enc.display()
        );
        println!("  The app reads this file the same way and therefore shows NO accounts.");
    } else if plain.exists() {
        match std::fs::read(&plain) {
            Ok(b) => print_labels(&b),
            Err(e) => println!("  {e}"),
        }
    } else {
        println!("  no account file at all");
    }

    // And the index behind the folder counts, opened read-only with whatever key
    // we resolved — so "the mail is gone" can be separated from "the mail is
    // there and unreadable".
    println!("\nstore:");
    match MailStore::open_with_keys(&dir, keys.map(std::sync::Arc::new)) {
        Ok(store) => match store.priority_counts() {
            Ok(c) => println!("  opened. important={} urgent={}", c.important, c.urgent),
            Err(e) => println!("  opened, but counts failed: {e}"),
        },
        Err(e) => println!("  could not open: {e}"),
    }
}

fn print_labels(bytes: &[u8]) {
    #[derive(serde::Deserialize)]
    struct Loose {
        #[serde(default)]
        accounts: Vec<serde_json::Value>,
    }
    match serde_json::from_slice::<Loose>(bytes) {
        Ok(list) => {
            println!("  {} account(s)", list.accounts.len());
            for a in list.accounts {
                let label = a
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("(no label)");
                let id = a.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                println!("    - {label} [{id}]");
            }
        }
        Err(e) => println!("  account file is not readable as JSON: {e}"),
    }
}
