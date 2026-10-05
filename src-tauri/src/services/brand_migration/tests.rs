//! The migrator as a whole: the no-op guarantee, a fresh install, an upgrade,
//! and a crash. Each step's own cases sit with the step.

use super::testing::*;
use super::*;
use crate::brand::LEGACY;

/// THE guarantee of this module while the name is unchanged: a launch of the
/// production pair over a used install moves nothing and writes nothing —
/// no record, no fallback log, no link. Not even an "all done" record: a step
/// marked done now would be skipped on the launch after the rename.
#[test]
fn with_the_name_unchanged_a_launch_touches_nothing() {
    let machine = Machine::new();
    machine.seed_install(&UNCHANGED.cur);
    let before = snapshot(&machine.home);
    let _ = hits::taken();

    let env = machine.env(UNCHANGED);
    assert_eq!(env.legacy_state_dir, None);
    assert_eq!(env.webview_data, None);
    let report = run_startup(&env);

    assert_eq!(report, Report::default());
    assert!(!report.ran);
    assert_eq!(snapshot(&machine.home), before);
    assert!(machine.world.calls.borrow().is_empty());
    assert!(hits::taken().is_empty());
    assert!(!env.state_dir.join(RECORD_FILE).exists());
    assert!(!hits::path_in(&env.state_dir).exists());
    // The lazy entry points write nothing either.
    lazy_done(&UNCHANGED, &env.state_dir, "mail-store", "");
    lazy_ran(&UNCHANGED, &env.state_dir, "project-folders", "");
    lazy_pending(&UNCHANGED, &env.state_dir, "keyring", "locked");
    reopen_step(&UNCHANGED, &env.state_dir, "agent-homes", "a home could not be re-pointed");
    assert_eq!(snapshot(&machine.home), before);
}

/// Every name's dual read collapses to a single lookup while the name is
/// unchanged: there is no old spelling to try.
#[test]
fn with_the_name_unchanged_no_name_has_an_old_spelling() {
    for (name, _, _) in crate::brand::Name::ALL {
        assert_eq!(UNCHANGED.legacy(*name), None, "{name:?}");
    }
    assert_eq!(UNCHANGED.legacy_env_name("TAB_UID"), None);
}

#[test]
fn a_fresh_install_never_spells_the_old_name() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    let report = run_startup(&env);
    assert!(report.ran && report.pending.is_empty(), "{report:?}");
    // First launch creates the state dir afterwards, as `run` does.
    std::fs::create_dir_all(&env.state_dir).expect("state dir");
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");

    let tree = snapshot(&machine.home);
    assert_eq!(spellings(&tree, LEGACY.slug), Vec::<String>::new());
    // Not an upgraded install: the old-name conveniences (the send alias,
    // the old-variable preamble of generated scripts) are not installed.
    assert!(!upgraded_install(&RENAMED, &env.state_dir));
    assert!(!env.record().upgraded);
    assert!(!machine.state_dir(&LEGACY).exists());
    assert!(std::fs::symlink_metadata(machine.state_dir(&LEGACY)).is_err(), "no link under the old name");
}

#[test]
fn an_upgrade_moves_the_state_dir_and_leaves_a_link() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let seeded = snapshot(&old_state);
    let _ = hits::taken();

    let env = machine.env(RENAMED);
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");

    // The folder is under the current name, with everything in it, and the
    // old path leads there.
    assert!(new_state.is_dir());
    assert!(std::fs::symlink_metadata(&old_state).expect("old path").file_type().is_symlink());
    assert_eq!(canonical(&old_state), new_state);
    let moved = snapshot(&new_state);
    // (Entries that carry the old name themselves are renamed by their own
    // steps, and checked there.)
    for path in seeded.keys().filter(|path| !path.contains(LEGACY.slug)) {
        assert!(moved.contains_key(path), "{path} is missing after the move");
    }
    // The name rewrite locks each file it changes, beside it (`<file>.lock`).
    let moved_files = moved.keys().filter(|path| !path.ends_with(".lock")).count();
    assert_eq!(moved_files, seeded.len() - 1 + 1, "only the old host's copy went, and the record came");
    // The old host was retired first, from the folder it ran in, and its
    // old-named copy is gone.
    assert_eq!(
        *machine.world.calls.borrow(),
        [format!("retire-mobile-host {}", old_state.display())]
    );
    assert!(!new_state
        .join("mobile-control")
        .join("bin")
        .join("1.0.0")
        .join(LEGACY.name(crate::brand::Name::MOBILE_HOST_BIN))
        .exists());

    let record = env.record();
    assert!(record.upgraded && upgraded_install(&RENAMED, &env.state_dir));
    for id in [
        "mobile-host",
        "state-dir",
        "share-dir",
        "state-paths",
        "persisted-names",
        "webview-data",
        "agent-homes",
    ] {
        assert_eq!(record.state_of(id), Some(StepState::Done), "{id}");
    }
}

#[test]
fn an_upgrade_runs_once() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    let after_first = snapshot(&machine.home);
    machine.world.calls.borrow_mut().clear();

    let report = run_startup(&env);
    assert_eq!(report, Report { ran: true, ..Report::default() });
    assert_eq!(snapshot(&machine.home), after_first);
    assert!(machine.world.calls.borrow().is_empty());
}

#[test]
fn stored_paths_into_the_state_dir_follow_it() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let env = machine.env(RENAMED);
    run_startup(&env);

    let mirror = new_state.join("remote-projects").join("beta").join("mirror");
    let projects = read_json(&new_state.join("projects.json"));
    assert_eq!(projects[1]["directory"], serde_json::json!(mirror));
    // A path outside the state dir is not touched, and neither is the rest
    // of the entry.
    assert_eq!(
        projects[0]["directory"],
        serde_json::json!(machine.home_tree(&LEGACY).join("projects").join("alpha"))
    );
    assert_eq!(projects[1]["remote"]["host"], "example.org");
    let tabs = read_json(&new_state.join("sessions").join("beta").join("tabs.json"));
    assert_eq!(tabs["tabs"][0]["cwd"], serde_json::json!(mirror));
    let sync = read_json(&new_state.join("remote-projects").join("beta").join("sync.json"));
    assert_eq!(sync["mirror"], serde_json::json!(mirror));
    let archived = read_json(&machine.home_tree(&LEGACY).join("archive").join("gamma").join("entry.json"));
    assert_eq!(archived["state"], serde_json::json!(new_state.join("remote-projects").join("gamma")));

    // No stored path names the old folder any more.
    let old_prefix = old_state.to_string_lossy().into_owned();
    for (path, content) in snapshot(&new_state) {
        if path != RECORD_FILE {
            // As written, and as a JSON string spells it on Windows.
            assert_eq!(replace_path(&content, &old_prefix, "<old>"), content, "{path} still names the old state dir");
        }
    }
}

#[test]
fn names_written_into_the_state_files_are_the_current_ones() {
    use crate::brand::Name;
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    let state = &env.state_dir;
    let settings = read_json(&state.join("settings.json"));
    assert_eq!(settings["newname_mobile_host"]["port"], 8742);
    assert_eq!(settings["theme"], "dark");
    assert!(settings.get(LEGACY.name(Name::MOBILE_HOST_KEY)).is_none());
    assert_eq!(read_json(&state.join("boxes.json"))[0]["newname_mobile_access"], true);
    assert_eq!(read_json(&state.join("time_summary.json"))["days"]["2026-09-30"]["__newname__"], 90.0);
    let tabs = read_json(&state.join("sessions").join("beta").join("tabs.json"));
    assert_eq!(tabs["tabs"][1]["cmd"], "__newname_mail__");
    assert_eq!(tabs["tabs"][2]["env"]["NEWNAME_TAB_UID"], "uid-3");
    assert_eq!(tabs["tabs"][0]["cmd"], "bash");
}

/// After an upgrade nothing in the state dir spells the old name any more —
/// not a file name, not a stored path, not a key. (The record's own notes
/// may name the old folder.)
#[test]
fn after_an_upgrade_the_state_dir_does_not_spell_the_old_name() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    let mut tree = snapshot(&env.state_dir);
    tree.remove(RECORD_FILE);
    // The `~/<name>` tree of an existing install keeps its old name (moving
    // the user's projects is a step of its own), so paths into it still do.
    let home_tree = machine.home_tree(&LEGACY).to_string_lossy().into_owned();
    for content in tree.values_mut() {
        *content = replace_path(content, &home_tree, "<home tree>");
    }
    assert_eq!(spellings(&tree, LEGACY.slug), Vec::<String>::new());
}

#[test]
fn the_webview_data_is_copied_and_the_old_copy_stays() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    let old = machine.webview_data(&LEGACY);
    let new = machine.webview_data(&RENAMED.cur);
    assert_eq!(snapshot(&new), snapshot(&old));
    assert!(!snapshot(&old).is_empty());
}

#[test]
fn webview_data_the_current_identifier_already_has_is_not_overwritten() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let new = machine.webview_data(&RENAMED.cur);
    write(&new.join("localstorage").join("app.localstorage"), "theme=light");
    run_startup(&machine.env(RENAMED));
    assert_eq!(
        std::fs::read_to_string(new.join("localstorage").join("app.localstorage")).expect("read"),
        "theme=light"
    );
}

/// Pull the plug at every checkpoint in turn; the launch after it finishes
/// the job, and the result is what an uninterrupted upgrade produces.
#[test]
fn a_crash_at_any_checkpoint_is_finished_by_the_next_launch() {
    let reference = Machine::new();
    reference.seed_install(&LEGACY);
    run_startup(&reference.env(RENAMED));
    let expected = snapshot(&reference.home);

    for checkpoint in [
        "dir:before-rename",
        "dir:after-rename",
        "paths:before-file",
        "names:before-file",
        "copy:before-file",
        "webview:after-copy",
        "homes:before-home",
    ] {
        let machine = Machine::new();
        machine.seed_install(&LEGACY);
        let mut env = machine.env(RENAMED);
        env.crash_at = Some(checkpoint);
        let report = run_startup(&env);
        assert!(report.crashed, "{checkpoint} was never reached");

        env.crash_at = None;
        let report = run_startup(&env);
        assert!(!report.crashed && report.pending.is_empty(), "{checkpoint}: {report:?}");
        // Same tree as the uninterrupted run, with this machine's own home
        // in the stored paths.
        let got = snapshot(&machine.home);
        let reference_home = reference.home.to_string_lossy().into_owned();
        let home = machine.home.to_string_lossy().into_owned();
        assert_eq!(got.len(), expected.len(), "{checkpoint}");
        for (path, content) in &expected {
            assert_eq!(
                got.get(path).map(|got| replace_path(got, &home, &reference_home)).as_ref(),
                Some(content),
                "{checkpoint}: {path}"
            );
        }
    }
}

#[test]
fn a_state_dir_under_both_names_is_left_for_the_user() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    write(&new_state.join("settings.json"), "{}");
    // Everything but the old phone host's copy, which is retired either way.
    let kept = |dir: &std::path::Path| {
        let mut tree = snapshot(dir);
        tree.retain(|path, _| !path.starts_with("mobile-control/bin/1.0.0/"));
        tree
    };
    let before = kept(&machine.state_dir(&LEGACY));
    let _ = hits::taken();

    let report = run_startup(&machine.env(RENAMED));
    assert!(report.pending.iter().any(|(id, _)| *id == "state-dir"), "{report:?}");
    assert_eq!(kept(&machine.state_dir(&LEGACY)), before);
    assert!(hits::taken().contains(&"state-dir".to_string()));
}

/// The stored paths into the state dir, after an upgrade: re-pointed at the
/// current folder, none naming the old one.
fn assert_stored_paths_follow(machine: &Machine) {
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let mirror = new_state.join("remote-projects").join("beta").join("mirror");
    assert_eq!(read_json(&new_state.join("projects.json"))[1]["directory"], serde_json::json!(mirror));
    let tabs = read_json(&new_state.join("sessions").join("beta").join("tabs.json"));
    assert_eq!(tabs["tabs"][0]["cwd"], serde_json::json!(mirror));
    let old_prefix = old_state.to_string_lossy().into_owned();
    for (path, content) in snapshot(&new_state) {
        if path != RECORD_FILE {
            // As written, and as a JSON string spells it on Windows.
            assert_eq!(replace_path(&content, &old_prefix, "<old>"), content, "{path} still names the old state dir");
        }
    }
}

/// A rename that fails (on Windows: a phone host or a scanner holding the
/// folder) leaves the current name absent. That must not read as a fresh
/// install to the path step: it stays pending with the move, and the launch
/// that moves the folder re-points the paths.
#[test]
fn a_failed_move_leaves_state_paths_pending_and_the_next_launch_rewrites_them() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let mut env = machine.env(RENAMED);
    env.fail_at = Some("dir:rename");
    let report = run_startup(&env);
    assert!(report.pending.iter().any(|(id, _)| *id == "state-dir"), "{report:?}");
    assert!(!machine.state_dir(&RENAMED.cur).exists());
    let record = env.record();
    assert_eq!(record.state_of("state-dir"), Some(StepState::Pending));
    assert_eq!(record.state_of("state-paths"), Some(StepState::Pending));

    env.fail_at = None;
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    let record = env.record();
    assert_eq!(record.state_of("state-dir"), Some(StepState::Done));
    assert_eq!(record.state_of("state-paths"), Some(StepState::Done));
    assert_stored_paths_follow(&machine);
}

/// The same with the old path being the user's own link to another disk:
/// a link there does not mean "moved" until the move step says so.
#[cfg(unix)]
#[test]
fn a_users_own_link_at_the_old_path_waits_for_the_move_too() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let elsewhere = machine.home.join("other-disk").join("state");
    std::fs::create_dir_all(elsewhere.parent().expect("parent")).expect("mkdir");
    std::fs::rename(&old_state, &elsewhere).expect("move away");
    std::os::unix::fs::symlink(&elsewhere, &old_state).expect("link");

    let mut env = machine.env(RENAMED);
    env.fail_at = Some("dir:rename");
    run_startup(&env);
    assert_eq!(env.record().state_of("state-paths"), Some(StepState::Pending));

    env.fail_at = None;
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert_eq!(canonical(&machine.state_dir(&RENAMED.cur)), elsewhere);
    assert_stored_paths_follow(&machine);
}

/// The link at the old path is the net for every absolute path nothing
/// rewrote, so a move without it is not done: it stays pending (listed in
/// Settings) and the next launch makes the link.
#[test]
fn a_failed_link_keeps_the_move_pending_and_a_later_launch_links() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let new_state = machine.state_dir(&RENAMED.cur);
    let mut env = machine.env(RENAMED);
    env.fail_at = Some("dir:link");
    run_startup(&env);

    assert!(new_state.join("projects.json").is_file());
    assert!(std::fs::symlink_metadata(&old_state).is_err(), "no link yet");
    let record = env.record();
    assert_eq!(record.state_of("state-dir"), Some(StepState::Pending));
    assert!(record.steps["state-dir"].note.contains("could not be linked"), "{:?}", record.steps["state-dir"]);
    // The paths do not wait for the link.
    assert_eq!(record.state_of("state-paths"), Some(StepState::Done));
    assert_stored_paths_follow(&machine);
    assert!(record.upgraded);

    env.fail_at = None;
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert!(std::fs::symlink_metadata(&old_state).expect("link").file_type().is_symlink());
    assert_eq!(canonical(&old_state), new_state);
    assert_eq!(env.record().state_of("state-dir"), Some(StepState::Done));
}

/// After a failed move the launch ran from the old folder and started the
/// current phone host in it, which `mobile-host` (done, and only ever after
/// the old-named host) never stops. The retry stops it before the rename.
#[test]
fn a_retried_move_stops_the_host_running_from_the_old_folder_first() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let old_state = machine.state_dir(&LEGACY);
    let mut env = machine.env(RENAMED);
    env.fail_at = Some("dir:rename");
    run_startup(&env);
    assert_eq!(
        *machine.world.calls.borrow(),
        [format!("retire-mobile-host {}", old_state.display())],
        "a first attempt has no host of its own to stop"
    );
    machine.world.calls.borrow_mut().clear();

    env.fail_at = None;
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert_eq!(*machine.world.calls.borrow(), [format!("stop-host {}", old_state.display())]);
}

#[test]
fn a_finished_step_can_be_reopened_and_runs_again() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    assert_eq!(env.record().state_of("agent-homes"), Some(StepState::Done));

    reopen_step(&RENAMED, &env.state_dir, "agent-homes", "a home could not be re-pointed");
    let record = env.record();
    assert_eq!(record.state_of("agent-homes"), Some(StepState::Pending));
    assert_eq!(record.steps["agent-homes"].note, "a home could not be re-pointed");
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert_eq!(env.record().state_of("agent-homes"), Some(StepState::Done));
}

/// A state dir that has moved, without a link, holding `files` (relative
/// path → JSON).
fn moved_state(machine: &Machine, files: &[(&str, serde_json::Value)]) -> std::path::PathBuf {
    let new_state = machine.state_dir(&RENAMED.cur);
    for (rel, value) in files {
        write_json(&new_state.join(rel), value);
    }
    new_state
}

/// The path rewrite of a state file moves the counters concurrent writers
/// check, like the name rewrite, and locks only what it changes. The
/// archive's manifests sit in the user's tree and get no lock file.
#[test]
fn the_state_path_rewrite_moves_the_counters_and_locks_only_what_it_changes() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    let old = machine.state_dir(&LEGACY);
    let new_state = moved_state(
        &machine,
        &[
            ("settings.json", serde_json::json!({ "rev": 7, "lastDir": old.join("x") })),
            (
                "sessions/beta/terminals.json",
                serde_json::json!({ "workspaceVersion": 4, "tab_layout": [{ "cwd": old.join("y") }] }),
            ),
            ("calendar.json", serde_json::json!({ "rev": 2, "dir": "/elsewhere" })),
        ],
    );
    let manifest = env.home_trees[0].join("archive").join("gamma").join("entry.json");
    write_json(&manifest, &serde_json::json!({ "state": old.join("remote-projects").join("gamma") }));

    let outcome = state_dir::rewrite_state_paths(&env).expect("runs");
    assert!(matches!(outcome, Outcome::Done(_)), "{outcome:?}");

    let settings = read_json(&new_state.join("settings.json"));
    assert_eq!(settings["rev"], 8);
    assert_eq!(settings["lastDir"], serde_json::json!(new_state.join("x")));
    let session = read_json(&new_state.join("sessions").join("beta").join("terminals.json"));
    assert_eq!(session["workspaceVersion"], 5);
    assert_eq!(session["tab_layout"][0]["cwd"], serde_json::json!(new_state.join("y")));
    assert_eq!(read_json(&new_state.join("calendar.json"))["rev"], 2);
    assert!(new_state.join("settings.json.lock").exists(), "a changed state file is locked");
    assert!(!new_state.join("calendar.json.lock").exists(), "nothing to change, nothing locked");
    assert_eq!(
        read_json(&manifest)["state"],
        serde_json::json!(new_state.join("remote-projects").join("gamma"))
    );
    assert!(!manifest.with_file_name("entry.json.lock").exists(), "the archive gets no lock file");
}

/// A writer that holds a state file's lock (a phone host the previous launch
/// started) finishes first; the rewrite re-reads under the lock, so neither
/// the writer's change nor the re-pointed path is lost.
#[test]
fn the_state_path_rewrite_waits_for_a_writer_holding_the_lock() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    let old = machine.state_dir(&LEGACY);
    let new_state = moved_state(
        &machine,
        &[("projects.json", serde_json::json!([{ "id": "beta", "directory": old.join("mirror") }]))],
    );
    let file = new_state.join("projects.json");

    let (read, was_read) = std::sync::mpsc::channel();
    let writer_file = file.clone();
    let writer = std::thread::spawn(move || {
        let _lock = crate::storage::FileLock::exclusive(&writer_file).expect("lock");
        let mut value = read_json(&writer_file);
        read.send(()).expect("signal");
        std::thread::sleep(std::time::Duration::from_millis(200));
        value[0]["name"] = serde_json::json!("Beta");
        crate::storage::write_json_atomic(&writer_file, &value).expect("write");
    });
    was_read.recv().expect("writer read");
    state_dir::rewrite_state_paths(&env).expect("runs");
    writer.join().expect("writer");

    let projects = read_json(&file);
    assert_eq!(projects[0]["name"], "Beta", "the writer's change survived");
    assert_eq!(projects[0]["directory"], serde_json::json!(new_state.join("mirror")), "the path was re-pointed");
}

#[test]
fn an_empty_folder_under_the_current_name_does_not_block_the_move() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    std::fs::create_dir_all(machine.state_dir(&RENAMED.cur)).expect("mkdir");
    let report = run_startup(&machine.env(RENAMED));
    assert!(report.pending.is_empty(), "{report:?}");
    assert!(machine.state_dir(&RENAMED.cur).join("projects.json").is_file());
}

#[test]
fn a_sandboxed_instance_leaves_the_machine_alone() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let before = snapshot(&machine.home);
    let mut env = machine.env(RENAMED);
    // What `Env::for_this_machine` builds when the environment names the
    // state dir.
    env.machine_wide = false;
    env.state_dir = machine.home.join("sandbox-state");
    env.legacy_state_dir = None;
    env.webview_data = None;
    std::fs::create_dir_all(&env.state_dir).expect("mkdir");
    let report = run_startup(&env);
    assert!(report.pending.is_empty(), "{report:?}");
    assert!(machine.world.calls.borrow().is_empty());
    let mut after = snapshot(&machine.home);
    after.retain(|path, _| !path.starts_with("sandbox-state"));
    assert_eq!(after, before);
}

#[test]
fn the_named_dir_resolution_prefers_the_current_name_and_counts_the_old_one() {
    let machine = Machine::new();
    let name = crate::brand::Name::HOME_DIR_NAME;
    let _ = hits::taken();
    // Neither exists: the current name, and nothing is counted.
    assert_eq!(
        resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"),
        machine.home_tree(&RENAMED.cur)
    );
    assert!(hits::taken().is_empty());
    // Only the old one exists: it is used, and counted.
    std::fs::create_dir_all(machine.home_tree(&LEGACY)).expect("mkdir");
    assert_eq!(resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"), machine.home_tree(&LEGACY));
    assert_eq!(hits::taken(), ["home-tree"]);
    // Both exist: the current one.
    std::fs::create_dir_all(machine.home_tree(&RENAMED.cur)).expect("mkdir");
    assert_eq!(
        resolve_named_dir(&RENAMED, name, &machine.home, "home-tree"),
        machine.home_tree(&RENAMED.cur)
    );
    assert!(hits::taken().is_empty());
}

#[test]
fn the_status_lists_hits_and_unfinished_steps_and_is_empty_while_unchanged() {
    let machine = Machine::new();
    machine.seed_install(&LEGACY);
    let env = machine.env(RENAMED);
    run_startup(&env);
    hits::Buffer::new().note(&hits::path_in(&env.state_dir), "tmux-prefix", "2026-10-01T12:00:00+00:00");

    let status = status_in(&RENAMED, &env.state_dir);
    assert!(status.renamed);
    assert_eq!(
        status.hits,
        [HitRow {
            id: "tmux-prefix".into(),
            count: 1,
            first: "2026-10-01T12:00:00+00:00".into(),
            last: "2026-10-01T12:00:00+00:00".into(),
        }]
    );
    // The launch steps are done; what is listed are the lazy ones.
    let ids: Vec<&str> = status.unfinished.iter().map(|step| step.id.as_str()).collect();
    assert_eq!(ids, LAZY_STEPS.iter().map(|(id, _, _)| *id).collect::<std::collections::BTreeSet<_>>().into_iter().collect::<Vec<_>>());
    assert!(status.unfinished.iter().any(|step| step.id == "mail-store" && step.state == StepState::Pending));

    assert_eq!(status_in(&UNCHANGED, &env.state_dir), Status::default());
}

#[test]
fn the_record_keeps_what_a_later_build_added() {
    let machine = Machine::new();
    let env = machine.env(RENAMED);
    std::fs::create_dir_all(&env.state_dir).expect("mkdir");
    write(
        &env.state_dir.join(RECORD_FILE),
        r#"{"steps":{"future-step":{"state":"done","at":"t","note":"x"}},"schema":7}"#,
    );
    run_startup(&env);
    let record = read_json(&env.state_dir.join(RECORD_FILE));
    assert_eq!(record["schema"], 7);
    assert_eq!(record["steps"]["future-step"]["note"], "x");
    assert_eq!(record["steps"]["state-dir"]["state"], "done");
}
