//! Keeps the phone's drop boxes from growing without end.
//!
//! Nothing else prunes a project's `outbox/` (agent → phone, `tabtivity-send`)
//! or `inbox/` (phone → agent, the composer's **+**, markup bakes): both only
//! met their 1 GiB caps, after which sends and uploads were refused. This
//! sweep runs at start and every [`EVERY`] after, over every local project,
//! box, root and Tabby chat folder ([`discovery::drop_box_roots`]), and deletes what has
//! sat there longer than its box keeps it. An outbox file is a copy the phone
//! has had its look at; an inbox file is an `@` reference a resumed session
//! may still read, so it is kept longer. A chat bubble whose file went shows
//! it gone (inbox) or is no longer drawn (outbox). The global inbox (*Send
//! to desktop*) is the user's to empty and is not swept.

use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use super::{discovery, inbox, outbox};

const DAY: Duration = Duration::from_secs(86_400);
/// How long an outbox file stays.
pub const OUTBOX_KEEP: Duration = Duration::from_secs(30 * 86_400);
/// How long a project-inbox file stays.
pub const INBOX_KEEP: Duration = Duration::from_secs(90 * 86_400);
/// When a send's lock or stage counts as left behind by a dead send: one
/// copies at most 24 MiB.
const STALE_SEND: Duration = Duration::from_secs(3_600);
/// How often the sweep runs — often enough that a dead send's lock does not
/// block sends for long; one look is a listing of two folders per project.
const EVERY: Duration = Duration::from_secs(3_600);

/// One sweep over every drop box below `state_dir`'s registries and in
/// `root_dir` (root's work folder), as of `now`: how many outbox and inbox
/// files went. A folder that is gone, linked or unreadable is skipped.
pub fn sweep(state_dir: &Path, root_dir: &Path, now: SystemTime) -> (usize, usize) {
    let (Some(outbox_cutoff), Some(inbox_cutoff), Some(stale)) =
        (now.checked_sub(OUTBOX_KEEP), now.checked_sub(INBOX_KEEP), now.checked_sub(STALE_SEND))
    else {
        return (0, 0);
    };
    let mut swept = (0, 0);
    for root in discovery::drop_box_roots(state_dir, root_dir) {
        if let Ok(cleared) = outbox::sweep(&root, outbox_cutoff, stale) {
            swept.0 += cleared.files;
        }
        if let Ok(count) = inbox::sweep(&root, inbox_cutoff) {
            swept.1 += count;
        }
    }
    swept
}

/// Runs [`sweep`] now and every [`EVERY`] on a thread of its own, which ends
/// with the process.
pub fn start(state_dir: PathBuf) {
    let spawned = std::thread::Builder::new().name("drop-sweep".into()).spawn(move || loop {
        let (outbox, inbox) = sweep(&state_dir, &crate::paths::root_work_dir(), SystemTime::now());
        if outbox + inbox > 0 {
            eprintln!(
                "drop sweep: removed {outbox} outbox file(s) older than {} days and {inbox} inbox file(s) older than {} days",
                OUTBOX_KEEP.as_secs() / DAY.as_secs(),
                INBOX_KEEP.as_secs() / DAY.as_secs(),
            );
        }
        std::thread::sleep(EVERY);
    });
    if let Err(error) = spawned {
        eprintln!("drop sweep: not started: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn aged(path: &Path, bytes: &[u8], age: Duration) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        let file = fs::File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    #[test]
    fn every_registered_folder_is_swept_whatever_its_mobile_switch() {
        let state = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let folder = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let projects = serde_json::json!([
            { "id": "p1", "name": "P", "status": "active", "directory": project.path() },
        ]);
        fs::write(state.path().join("projects.json"), projects.to_string()).unwrap();
        let boxes = serde_json::json!([{ "id": "b1", "name": "B", "folder": folder.path() }]);
        fs::write(state.path().join("boxes.json"), boxes.to_string()).unwrap();

        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        let outbox_of = |root: &Path| root.join(outbox::OUTBOX_DIR);
        let inbox_of = |root: &Path| root.join(inbox::INBOX_DIR);
        aged(&outbox_of(project.path()).join("old.png"), png, DAY * 31);
        aged(&outbox_of(project.path()).join("new.png"), png, DAY * 29);
        aged(&inbox_of(project.path()).join("20260101-000000-old.png"), png, DAY * 91);
        aged(&inbox_of(project.path()).join("20260101-000000-new.png"), png, DAY * 89);
        aged(&outbox_of(folder.path()).join("old.png"), png, DAY * 31);
        aged(&outbox_of(root.path()).join("old.png"), png, DAY * 31);

        let (outbox, inbox) = sweep(state.path(), root.path(), SystemTime::now());
        assert_eq!((outbox, inbox), (3, 1));
        assert!(outbox_of(project.path()).join("new.png").exists());
        assert!(inbox_of(project.path()).join("20260101-000000-new.png").exists());
        assert!(!outbox_of(folder.path()).join("old.png").exists());
    }

    #[test]
    fn a_tabby_chats_files_are_swept_and_a_link_in_its_place_is_not() {
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let chat = crate::services::assistant::chat_dir(state.path(), "1c9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a11").unwrap();
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
        let inbox_of = |root: &Path| root.join(inbox::INBOX_DIR);
        aged(&inbox_of(&chat).join("20260101-000000-old.png"), png, DAY * 91);
        aged(&inbox_of(&chat).join("20260101-000000-new.png"), png, DAY * 89);

        #[cfg(unix)]
        let elsewhere = {
            let elsewhere = tempfile::tempdir().unwrap();
            aged(&inbox_of(elsewhere.path()).join("20260101-000000-old.png"), png, DAY * 91);
            let link = chat.with_file_name("2d9d8f3e-2c1a-4e7b-9a55-3f6d1c2b7a12");
            std::os::unix::fs::symlink(elsewhere.path(), link).unwrap();
            elsewhere
        };

        assert_eq!(sweep(state.path(), root.path(), SystemTime::now()), (0, 1));
        assert!(inbox_of(&chat).join("20260101-000000-new.png").exists());
        #[cfg(unix)]
        assert!(inbox_of(elsewhere.path()).join("20260101-000000-old.png").exists());
    }

    #[test]
    fn no_registry_sweeps_nothing_of_its_own() {
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(state.path().join("projects.json"), "not json").unwrap();
        // Root's work folder is still swept; no project or box is listed.
        assert_eq!(discovery::drop_box_roots(state.path(), root.path()), vec![root.path().to_path_buf()]);
    }
}
