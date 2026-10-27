use super::*;
use crate::schema::calendar::{Subtask, TaskFileLink};
use std::collections::HashMap;

fn tmp_path() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("calendar.json");
    (dir, path)
}

fn event(title: &str, start: &str, end: &str) -> CalendarEvent {
    CalendarEvent {
        title: title.into(),
        start: start.into(),
        end: end.into(),
        ..Default::default()
    }
}

#[test]
fn concurrent_calendar_edits_do_not_lose_rows() {
    let (_dir, path) = tmp_path();
    let path = std::sync::Arc::new(path);
    let mut threads = Vec::new();
    for i in 0..12 {
        let path = path.clone();
        threads.push(std::thread::spawn(move || {
            create_event_at(
                path.as_ref(),
                event(
                    &format!("event-{i}"),
                    "2026-08-28T10:00:00Z",
                    "2026-08-28T11:00:00Z",
                ),
            )
            .unwrap();
        }));
    }
    for thread in threads {
        thread.join().unwrap();
    }

    let data = read_data(path.as_ref()).unwrap();
    assert_eq!(data.events.len(), 12);
}

// ── Compare-and-swap (#171) ─────────────────────────────────────────

/// Two writers read the same file; the first commits, the second is
/// rejected rather than clobbering, and its retry against fresh state
/// lands with both edits intact.
#[test]
fn interleaved_read_modify_writes_reject_the_stale_one_and_keep_both_edits() {
    let (_dir, path) = tmp_path();
    let base = read_data(&path).unwrap();
    assert_eq!(base.rev, 0, "a missing file is revision 0");

    let mut a = base.clone();
    a.events.push(event("a", "2026-07-08T09:00", "2026-07-08T10:00"));
    assert_eq!(commit(&path, &base, &mut a).unwrap(), Commit::Committed);

    // B read the same base as A, so its write would erase A's event.
    let mut b = base.clone();
    b.events.push(event("b", "2026-07-08T11:00", "2026-07-08T12:00"));
    assert_eq!(commit(&path, &base, &mut b).unwrap(), Commit::Stale);
    let on_disk = read_data(&path).unwrap();
    assert_eq!(on_disk.events.len(), 1, "the rejected write touched nothing");
    assert_eq!(on_disk.events[0].title, "a");

    // B retries from what is on disk now.
    let fresh = read_data(&path).unwrap();
    let mut b = fresh.clone();
    b.events.push(event("b", "2026-07-08T11:00", "2026-07-08T12:00"));
    assert_eq!(commit(&path, &fresh, &mut b).unwrap(), Commit::Committed);

    let final_state = read_data(&path).unwrap();
    let mut titles: Vec<&str> = final_state.events.iter().map(|e| e.title.as_str()).collect();
    titles.sort();
    assert_eq!(titles, vec!["a", "b"]);
    assert_eq!(final_state.rev, 2, "one bump per committed write");
}

/// `transact` does the retry itself: an edit whose commit finds the file
/// moved on (here: another process wrote between the read and the
/// commit) is re-run against the fresh state, and nothing is lost.
#[test]
fn transact_reapplies_the_edit_when_another_process_wrote_in_between() {
    let (_dir, path) = tmp_path();
    create_event_at(&path, event("first", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();

    let runs = std::cell::Cell::new(0);
    let ((), data) = transact(&path, |data| {
        runs.set(runs.get() + 1);
        if runs.get() == 1 {
            // Another process: reads the file, adds a row, writes it back
            // with the next revision — without our in-process lock.
            let mut other = read_data(&path).unwrap();
            other.events.push(event("other", "2026-07-09T09:00", "2026-07-09T10:00"));
            other.rev += 1;
            write_data(&path, &other).unwrap();
        }
        data.events.push(event("mine", "2026-07-10T09:00", "2026-07-10T10:00"));
        data.normalize();
        Ok(())
    })
    .unwrap();

    assert_eq!(runs.get(), 2, "the first attempt was rejected and re-run");
    let mut titles: Vec<&str> = data.events.iter().map(|e| e.title.as_str()).collect();
    titles.sort();
    assert_eq!(titles, vec!["first", "mine", "other"]);
    assert_eq!(read_data(&path).unwrap(), data, "the returned state is what reached disk");
}

/// Every write moves the file's revision; a record's revision moves only
/// when that record changed, whatever number the caller's copy carried.
#[test]
fn revisions_are_stamped_per_changed_record_and_per_write() {
    let (_dir, path) = tmp_path();
    let a = create_event_at(&path, event("a", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
    let b = create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();
    assert_eq!((a.rev, b.rev), (1, 1));
    assert_eq!(read_data(&path).unwrap().rev, 2);

    let mut edited = a.clone();
    edited.title = "a2".into();
    edited.rev = 99; // the store decides, not the caller
    let stored = update_event_at(&path, edited).unwrap();
    assert_eq!(stored.rev, 2);
    let data = read_data(&path).unwrap();
    assert_eq!(data.rev, 3);
    assert_eq!(data.events.iter().find(|e| e.id == b.id).unwrap().rev, 1, "untouched row keeps its revision");

    // An edit that changes nothing writes nothing.
    let unchanged = update_event_at(&path, stored.clone()).unwrap();
    assert_eq!(unchanged.rev, 2);
    assert_eq!(read_data(&path).unwrap().rev, 3);
}

/// A whole-document save carries the revision it was loaded at: a stale
/// one is refused instead of written over a newer file.
#[test]
fn whole_document_save_is_refused_when_the_file_moved_on() {
    let (_dir, path) = tmp_path();
    create_event_at(&path, event("a", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
    let loaded = read_data(&path).unwrap();

    // Someone else edits in the meantime.
    create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();

    let mut stale = loaded.clone();
    stale.events[0].title = "renamed".into();
    let error = save_document_at(&path, stale).unwrap_err();
    assert!(error.contains("changed on disk"), "{error}");
    let data = read_data(&path).unwrap();
    assert_eq!(data.events.len(), 2, "b survived");
    assert_eq!(data.events[0].title, "a", "the stale rename never landed");

    // Reloaded and re-applied, it lands.
    let mut fresh = read_data(&path).unwrap();
    fresh.events[0].title = "renamed".into();
    save_document_at(&path, fresh).unwrap();
    assert_eq!(read_data(&path).unwrap().events[0].title, "renamed");
}

/// A file written before revisions existed reads as revision 0 and takes
/// the first revision-aware write like any other; a legacy version-1
/// array does the same.
#[test]
fn files_without_revisions_round_trip_into_the_first_revision() {
    let (_dir, path) = tmp_path();
    std::fs::write(
        &path,
        r##"{"version":3,"calendars":[{"id":"cal","name":"Cal","color":"#fff"}],"events":[{"id":"e1","calendar_id":"cal","start":"2026-07-08T09:00","end":"2026-07-08T10:00","title":"old"}],"tasks":[]}"##,
    )
    .unwrap();
    let loaded = read_data(&path).unwrap();
    assert_eq!((loaded.rev, loaded.events[0].rev, loaded.calendars[0].rev), (0, 0, 0));
    assert_eq!(on_disk_rev(&path), 0);

    create_event_at(&path, event("new", "2026-07-09T09:00", "2026-07-09T10:00")).unwrap();
    let data = read_data(&path).unwrap();
    assert_eq!(data.rev, 1);
    assert_eq!(data.events.iter().find(|e| e.id == "e1").unwrap().rev, 0, "an untouched legacy row is still unversioned");
    assert_eq!(data.events.iter().find(|e| e.title == "new").unwrap().rev, 1);

    let (_dir, legacy) = tmp_path();
    std::fs::write(&legacy, r#"[{"id":"v1","date":"2026-07-08","time":"09:00","title":"v1"}]"#).unwrap();
    assert_eq!(on_disk_rev(&legacy), 0);
    create_event_at(&legacy, event("new", "2026-07-09T09:00", "2026-07-09T10:00")).unwrap();
    let data = read_data(&legacy).unwrap();
    assert_eq!(data.rev, 1);
    assert_eq!(data.events.len(), 2);
}

#[test]
fn read_missing_file_is_an_empty_default_calendar() {
    let (_dir, path) = tmp_path();
    let data = read_data(&path).unwrap();
    assert!(data.events.is_empty());
    assert!(data.tasks.is_empty());
    assert_eq!(data.calendars.len(), 1, "a default calendar always exists");
}

#[test]
fn create_then_read_roundtrips() {
    let (_dir, path) = tmp_path();
    let ev = create_event_at(
        &path,
        event("standup", "2026-07-08T09:00", "2026-07-08T09:15"),
    )
    .unwrap();
    assert!(!ev.id.is_empty());

    let data = read_data(&path).unwrap();
    assert_eq!(data.events.len(), 1);
    assert_eq!(data.events[0].title, "standup");
    assert_eq!(data.events[0].start, "2026-07-08T09:00");
    assert_eq!(data.events[0].end, "2026-07-08T09:15");
    assert_eq!(data.events[0].calendar_id, DEFAULT_CALENDAR_ID);
}

#[test]
fn create_mints_unique_ids_and_ignores_caller_id() {
    let (_dir, path) = tmp_path();
    let mut forged = event("a", "2026-07-08T09:00", "2026-07-08T10:00");
    forged.id = "forged".into();
    let a = create_event_at(&path, forged).unwrap();
    let b = create_event_at(&path, event("b", "2026-07-08T11:00", "2026-07-08T12:00")).unwrap();
    assert_ne!(a.id, "forged", "the store owns identity");
    assert_ne!(a.id, b.id);
    assert_eq!(read_data(&path).unwrap().events.len(), 2);
}

#[test]
fn update_replaces_the_event() {
    let (_dir, path) = tmp_path();
    let ev =
        create_event_at(&path, event("old", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();

    let mut edited = ev.clone();
    edited.title = "new".into();
    edited.start = "2026-07-09T10:30".into();
    edited.end = "2026-07-09T11:30".into();
    edited.location = "room 2".into();
    let out = update_event_at(&path, edited).unwrap();

    assert_eq!(out.title, "new");
    let data = read_data(&path).unwrap();
    assert_eq!(data.events.len(), 1);
    assert_eq!(data.events[0].title, "new");
    assert_eq!(data.events[0].start, "2026-07-09T10:30");
    assert_eq!(data.events[0].location, "room 2");
}

#[test]
fn update_missing_id_errors() {
    let (_dir, path) = tmp_path();
    let mut ghost = event("x", "2026-07-08T09:00", "2026-07-08T10:00");
    ghost.id = "nope".into();
    assert!(update_event_at(&path, ghost).is_err());
}

#[test]
fn delete_removes_the_event() {
    let (_dir, path) = tmp_path();
    let ev =
        create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
    delete_event_at(&path, &ev.id).unwrap();
    assert!(read_data(&path).unwrap().events.is_empty());
}

#[test]
fn delete_missing_id_errors() {
    let (_dir, path) = tmp_path();
    assert!(delete_event_at(&path, "nope").is_err());
}

#[test]
fn task_crud_roundtrips() {
    let (_dir, path) = tmp_path();
    let t = create_task_at(
        &path,
        CalendarTask {
            title: "write plan".into(),
            due: Some("2026-07-10".into()),
            priority: 1,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!t.id.is_empty());

    let mut done = t.clone();
    done.percent = 100;
    done.completed = Some("2026-07-09T12:00".into());
    update_task_at(&path, done).unwrap();

    let data = read_data(&path).unwrap();
    assert_eq!(data.tasks.len(), 1);
    assert_eq!(data.tasks[0].percent, 100);
    assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-09T12:00"));

    delete_task_at(&path, &t.id).unwrap();
    assert!(read_data(&path).unwrap().tasks.is_empty());
}

#[test]
fn calendar_crud_roundtrips() {
    let (_dir, path) = tmp_path();
    let cal = create_calendar_at(
        &path,
        Calendar {
            rev: 0,
            id: String::new(),
            name: "Work".into(),
            color: "#ff0000".into(),
            visible: true,
            readonly: false,
            extra: Default::default(),
        },
    )
    .unwrap();

    let data = read_data(&path).unwrap();
    assert_eq!(data.calendars.len(), 2, "default + Work");

    let mut hidden = cal.clone();
    hidden.visible = false;
    update_calendar_at(&path, hidden).unwrap();
    let data = read_data(&path).unwrap();
    assert!(
        !data
            .calendars
            .iter()
            .find(|c| c.id == cal.id)
            .unwrap()
            .visible
    );
}

#[test]
fn deleting_a_calendar_takes_its_events_and_tasks_with_it() {
    let (_dir, path) = tmp_path();
    let cal = create_calendar_at(
        &path,
        Calendar {
            rev: 0,
            id: String::new(),
            name: "Work".into(),
            color: "#ff0000".into(),
            visible: true,
            readonly: false,
            extra: Default::default(),
        },
    )
    .unwrap();

    let mut in_work = event("meeting", "2026-07-08T09:00", "2026-07-08T10:00");
    in_work.calendar_id = cal.id.clone();
    create_event_at(&path, in_work).unwrap();
    create_event_at(
        &path,
        event("personal", "2026-07-08T18:00", "2026-07-08T19:00"),
    )
    .unwrap();

    delete_calendar_at(&path, &cal.id).unwrap();

    let data = read_data(&path).unwrap();
    assert_eq!(data.calendars.len(), 1);
    assert_eq!(data.events.len(), 1, "only the Work event is gone");
    assert_eq!(data.events[0].title, "personal");
}

#[test]
fn restoring_a_deleted_calendar_brings_its_events_back() {
    let (_dir, path) = tmp_path();
    let mut cal = read_data(&path).unwrap().calendars[0].clone();
    cal.name = "Work".to_string();
    let cal = create_calendar_at(&path, cal).unwrap();
    let mut in_work = event("meeting", "2026-07-08T09:00", "2026-07-08T10:00");
    in_work.calendar_id = cal.id.clone();
    let in_work = create_event_at(&path, in_work).unwrap();

    delete_calendar_at(&path, &cal.id).unwrap();
    // An id reused while the calendar was gone must not be clobbered.
    let mut data = read_data(&path).unwrap();
    let mut squatter = event("squatter", "2026-07-09T09:00", "2026-07-09T10:00");
    squatter.id = in_work.id.clone();
    squatter.calendar_id = data.calendars[0].id.clone();
    data.events.push(squatter);
    write_data(&path, &data).unwrap();

    let data = restore_calendar_at(&path, cal.clone(), vec![in_work.clone()], vec![]).unwrap();
    assert!(data.calendars.iter().any(|c| c.id == cal.id));
    let restored: Vec<_> = data.events.iter().filter(|e| e.calendar_id == cal.id).collect();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].title, "meeting");
    assert_ne!(restored[0].id, in_work.id, "the squatter keeps the id");
    assert_eq!(data.events.len(), 2);

    assert!(restore_calendar_at(&path, cal, vec![], vec![]).is_err(), "no double restore");
}

#[test]
fn cannot_delete_the_last_calendar() {
    let (_dir, path) = tmp_path();
    let data = read_data(&path).unwrap();
    let only = data.calendars[0].id.clone();
    // Writing first, so the file exists with exactly one calendar.
    write_data(&path, &data).unwrap();
    assert!(delete_calendar_at(&path, &only).is_err());
}

#[test]
fn legacy_file_migrates_on_read() {
    let (_dir, path) = tmp_path();
    std::fs::write(
        &path,
        r#"[
                {"id":"a","date":"2026-07-08","time":"09:00","title":"standup","notes":"daily"},
                {"id":"b","date":"2026-07-09","time":"","title":"holiday"}
            ]"#,
    )
    .unwrap();

    let data = read_data(&path).unwrap();
    assert_eq!(data.events.len(), 2);

    let standup = data.events.iter().find(|e| e.title == "standup").unwrap();
    assert_eq!(standup.start, "2026-07-08T09:00");
    assert_eq!(standup.end, "2026-07-08T10:00");
    assert!(!standup.all_day);
    assert_eq!(standup.notes, "daily");

    let holiday = data.events.iter().find(|e| e.title == "holiday").unwrap();
    assert!(holiday.all_day);
    assert_eq!(holiday.start, "2026-07-09");
    assert_eq!(holiday.end, "2026-07-10");
}

#[test]
fn legacy_file_is_rewritten_in_the_current_shape() {
    let (_dir, path) = tmp_path();
    std::fs::write(
        &path,
        r#"[{"id":"a","date":"2026-07-08","time":"09:00","title":"standup"}]"#,
    )
    .unwrap();

    // Any write path (here: adding an event) upgrades the file on disk.
    create_event_at(&path, event("new", "2026-07-10T09:00", "2026-07-10T10:00")).unwrap();

    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(
        raw.contains("\"version\""),
        "upgraded file carries a version: {raw}"
    );
    let data = read_data(&path).unwrap();
    assert_eq!(
        data.events.len(),
        2,
        "the migrated event survives the write"
    );
}

#[test]
fn empty_optional_fields_are_omitted_from_the_file() {
    let (_dir, path) = tmp_path();
    create_event_at(&path, event("x", "2026-07-08T09:00", "2026-07-08T10:00")).unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    assert!(
        !raw.contains("\"notes\""),
        "empty notes must be skipped: {raw}"
    );
    assert!(
        !raw.contains("\"location\""),
        "empty location must be skipped: {raw}"
    );
    assert!(
        !raw.contains("\"rrule\""),
        "absent rrule must be skipped: {raw}"
    );
    assert!(
        !raw.contains("\"column\""),
        "board fields must be skipped: {raw}"
    );
    assert!(
        !raw.contains("\"task_columns\""),
        "unused board must be skipped: {raw}"
    );
}

// ── Todo board ──────────────────────────────────────────────────────────

/// Give the store a board, as the first drag or column edit would. Creating a
/// task deliberately does *not* — `create_task` is also the calendar Tasks
/// view's write path, and a plain to-do must not conjure a board.
fn seed_board(path: &Path) {
    let mut data = read_data(path).unwrap();
    data.ensure_board();
    data.normalize();
    write_data(path, &data).unwrap();
}

fn card(path: &Path, title: &str) -> CalendarTask {
    seed_board(path);
    create_task_at(
        path,
        CalendarTask {
            title: title.into(),
            ..Default::default()
        },
    )
    .unwrap()
}

fn place(id: &str, column: &str, index: u32) -> TaskPlacement {
    TaskPlacement {
        id: id.into(),
        column: column.into(),
        index,
        completed_stamp: Some("2026-07-28T12:00".into()),
    }
}

/// The ids of one column, top to bottom, as the board would draw them.
fn order_of(path: &Path, column: &str) -> Vec<String> {
    let data = read_data(path).unwrap();
    column_order(&data, column, "")
        .into_iter()
        .map(|(id, _)| id)
        .collect()
}

#[test]
fn create_task_returns_the_normalized_record() {
    let (_dir, path) = tmp_path();
    let t = card(&path, "fresh");
    assert_eq!(t.column, "backlog", "a new card must come back placed");
    assert!(t.rank.is_some(), "a new card must come back ranked");
}

#[test]
fn update_task_returns_the_reconciled_record() {
    let (_dir, path) = tmp_path();
    let t = card(&path, "t");
    let out = update_task_at(&path, CalendarTask { percent: 100, ..t }).unwrap();
    assert_eq!(out.column, "done", "ticking must return the moved card");
}

#[test]
fn move_places_at_the_requested_index() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    let b = card(&path, "b");
    let c = card(&path, "c");
    assert_eq!(
        order_of(&path, "backlog"),
        vec![a.id.clone(), b.id.clone(), c.id.clone()]
    );

    // c to the top.
    move_tasks_at(&path, vec![place(&c.id, "backlog", 0)]).unwrap();
    assert_eq!(
        order_of(&path, "backlog"),
        vec![c.id.clone(), a.id.clone(), b.id.clone()]
    );

    // a to the middle.
    move_tasks_at(&path, vec![place(&a.id, "backlog", 1)]).unwrap();
    assert_eq!(
        order_of(&path, "backlog"),
        vec![c.id.clone(), a.id.clone(), b.id.clone()]
    );

    // c past the end appends.
    move_tasks_at(&path, vec![place(&c.id, "backlog", 999)]).unwrap();
    assert_eq!(order_of(&path, "backlog"), vec![a.id, b.id, c.id]);
}

#[test]
fn move_across_columns_is_one_write() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    let b = card(&path, "b");
    let changed = move_tasks_at(
        &path,
        vec![place(&a.id, "doing", 0), place(&b.id, "doing", 0)],
    )
    .unwrap();
    assert_eq!(changed.len(), 2);
    assert_eq!(order_of(&path, "doing"), vec![b.id, a.id]);
    assert!(order_of(&path, "backlog").is_empty());
}

#[test]
fn move_is_idempotent() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    let b = card(&path, "b");
    move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
    let after_first = read_data(&path).unwrap();

    let changed = move_tasks_at(&path, vec![place(&b.id, "doing", 0)]).unwrap();
    assert!(changed.is_empty(), "a replayed placement changes nothing");
    assert_eq!(read_data(&path).unwrap(), after_first);
    assert_eq!(order_of(&path, "backlog"), vec![a.id]);
}

#[test]
fn move_reindexes_when_ranks_collide() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    let b = card(&path, "b");
    // Force two ranks too close to split.
    let mut data = read_data(&path).unwrap();
    for t in data.tasks.iter_mut() {
        t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
    }
    write_data(&path, &data).unwrap();

    let c = card(&path, "c");
    move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();

    let data = read_data(&path).unwrap();
    for t in data.tasks.iter() {
        let rank = t.rank.unwrap();
        assert_eq!(
            rank % RANK_GAP,
            0.0,
            "a collapsed column is reindexed to clean multiples, got {rank}"
        );
    }
    assert_eq!(order_of(&path, "backlog"), vec![a.id, c.id, b.id]);
}

#[test]
fn dropping_on_done_completes_and_dragging_out_uncompletes() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");

    move_tasks_at(&path, vec![place(&a.id, "done", 0)]).unwrap();
    let data = read_data(&path).unwrap();
    assert_eq!(data.tasks[0].percent, 100);
    assert_eq!(data.tasks[0].completed.as_deref(), Some("2026-07-28T12:00"));

    move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
    let data = read_data(&path).unwrap();
    assert_eq!(data.tasks[0].percent, 0);
    assert_eq!(data.tasks[0].completed, None, "the stamp must go too");
    assert_eq!(data.tasks[0].column, "doing");
}

#[test]
fn move_returns_every_changed_task_not_just_the_dragged_one() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    let b = card(&path, "b");
    let mut data = read_data(&path).unwrap();
    for t in data.tasks.iter_mut() {
        t.rank = Some(if t.id == a.id { 1.0 } else { 1.0 + 1e-9 });
    }
    write_data(&path, &data).unwrap();

    let c = card(&path, "c");
    let changed = move_tasks_at(&path, vec![place(&c.id, "backlog", 1)]).unwrap();
    let ids: HashSet<&str> = changed.iter().map(|t| t.id.as_str()).collect();
    assert!(ids.contains(a.id.as_str()) && ids.contains(b.id.as_str()));
}

#[test]
fn move_refiles_an_unknown_target_column_rather_than_refusing() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    move_tasks_at(&path, vec![place(&a.id, "no-such-column", 0)]).unwrap();
    assert_eq!(read_data(&path).unwrap().tasks[0].column, "backlog");
}

#[test]
fn columns_set_refiles_the_cards_of_a_deleted_column() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

    let kept: Vec<TaskColumn> = read_data(&path)
        .unwrap()
        .task_columns
        .into_iter()
        .filter(|c| c.id != "doing")
        .collect();
    let data = columns_set_at(&path, kept, None).unwrap();
    assert_eq!(data.tasks[0].column, "backlog");
    assert!(!data.task_columns.iter().any(|c| c.id == "doing"));
}

#[test]
fn columns_set_honours_an_explicit_fallback() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();
    let kept: Vec<TaskColumn> = read_data(&path)
        .unwrap()
        .task_columns
        .into_iter()
        .filter(|c| c.id != "doing")
        .collect();
    let data = columns_set_at(&path, kept, Some("today".into())).unwrap();
    assert_eq!(data.tasks[0].column, "today");
}

#[test]
fn columns_set_refuses_an_empty_list() {
    let (_dir, path) = tmp_path();
    card(&path, "a");
    assert!(columns_set_at(&path, Vec::new(), None).is_err());
    assert_eq!(
        read_data(&path).unwrap().task_columns.len(),
        6,
        "the refused edit must leave the board alone"
    );
}

/// The other half of the lazy-seeding rule, at the command layer: a to-do
/// created from the calendar's Tasks view must not grow board state.
#[test]
fn creating_a_task_does_not_create_a_board() {
    let (_dir, path) = tmp_path();
    create_task_at(
        &path,
        CalendarTask {
            title: "plain".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let data = read_data(&path).unwrap();
    assert!(data.task_columns.is_empty());
    assert!(data.tasks[0].column.is_empty());
}

#[test]
fn columns_set_preserves_a_renamed_columns_cards() {
    let (_dir, path) = tmp_path();
    let a = card(&path, "a");
    move_tasks_at(&path, vec![place(&a.id, "doing", 0)]).unwrap();

    let renamed: Vec<TaskColumn> = read_data(&path)
        .unwrap()
        .task_columns
        .into_iter()
        .map(|mut c| {
            if c.id == "doing" {
                c.name = "In flight".into();
            }
            c
        })
        .collect();
    let data = columns_set_at(&path, renamed, None).unwrap();
    assert_eq!(
        data.tasks[0].column, "doing",
        "a rename must not move a card"
    );
    assert!(data.task_columns.iter().any(|c| c.name == "In flight"));
}

#[test]
fn columns_set_mints_ids_for_new_columns() {
    let (_dir, path) = tmp_path();
    let mut columns = read_data(&path).unwrap().task_columns;
    columns.push(TaskColumn {
        id: String::new(),
        name: "Blocked".into(),
        position: 9,
        ..Default::default()
    });
    let data = columns_set_at(&path, columns, None).unwrap();
    let added = data
        .task_columns
        .iter()
        .find(|c| c.name == "Blocked")
        .unwrap();
    assert!(!added.id.is_empty(), "a new column must be given an id");
}

// ── CalDAV reconciliation ────────────────────────────────────────────
//
// The property every one of these exists to protect: a sync that runs on a
// timer must update what the server owns and touch nothing else. A single
// regression here is invisible until a user finds their board reshuffled.

fn caldav_calendar(path: &Path) -> String {
    create_calendar_at(
        path,
        Calendar {
            rev: 0,
            id: String::new(),
            name: "Work".into(),
            color: "#4aa3df".into(),
            visible: true,
            readonly: true,
            extra: HashMap::new(),
        },
    )
    .unwrap()
    .id
}

fn parsed_event(href: &str, etag: &str, title: &str, start: &str) -> CalDavParsed {
    CalDavParsed {
        href: href.into(),
        etag: etag.into(),
        events: vec![CalendarEvent {
            title: title.into(),
            start: start.into(),
            end: format!("{start}:00").replace("::00", ":00"),
            ..Default::default()
        }],
        tasks: Vec::new(),
    }
}

fn parsed_task(href: &str, etag: &str, title: &str, percent: u8) -> CalDavParsed {
    CalDavParsed {
        href: href.into(),
        etag: etag.into(),
        events: Vec::new(),
        tasks: vec![CalendarTask {
            title: title.into(),
            percent,
            ..Default::default()
        }],
    }
}

#[test]
fn a_first_sync_creates_rows_and_stamps_their_resource_identity() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let data = merge_caldav_calendar_at(
        &path,
        &cal,
        vec![
            parsed_event("https://d/e/a.ics", "\"1\"", "standup", "2026-07-08T09:00"),
            parsed_task("https://d/e/t.ics", "\"2\"", "write it up", 0),
        ],
        &[],
        true,
    )
    .unwrap();

    assert_eq!(data.events.len(), 1);
    assert_eq!(data.tasks.len(), 1);
    let event = &data.events[0];
    assert!(!event.id.is_empty(), "the store owns identity");
    assert_eq!(event.calendar_id, cal);
    assert_eq!(
        extra_str(&event.extra, CALDAV_HREF_KEY),
        "https://d/e/a.ics"
    );
    assert_eq!(extra_str(&event.extra, CALDAV_ETAG_KEY), "\"1\"");
    assert_eq!(
        extra_str(&data.tasks[0].extra, CALDAV_HREF_KEY),
        "https://d/e/t.ics"
    );
}

#[test]
fn a_push_stamps_the_resource_identity_onto_a_local_row() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let mut data = read_data(&path).unwrap();
    data.events.push(CalendarEvent {
        id: "e1".into(),
        calendar_id: cal.clone(),
        title: "written here".into(),
        start: "2026-08-01T09:00".into(),
        end: "2026-08-01T10:00".into(),
        ..Default::default()
    });
    write_data(&path, &data).unwrap();

    set_caldav_identity_at(&path, "event", "e1", "https://d/e/e1.ics", "\"7\"", None).unwrap();
    let after = read_data(&path).unwrap().events.remove(0);
    assert_eq!(
        extra_str(&after.extra, CALDAV_HREF_KEY),
        "https://d/e/e1.ics"
    );
    assert_eq!(extra_str(&after.extra, CALDAV_ETAG_KEY), "\"7\"");
    assert_eq!(
        after.title, "written here",
        "the row itself is not rewritten"
    );

    // A server that accepted the write but named no version must clear the
    // old validator, not keep one that no longer describes anything.
    set_caldav_identity_at(&path, "event", "e1", "https://d/e/e1.ics", "", None).unwrap();
    assert_eq!(
        extra_str(&read_data(&path).unwrap().events[0].extra, CALDAV_ETAG_KEY),
        ""
    );

    assert!(set_caldav_identity_at(&path, "event", "nope", "h", "e", None).is_err());
    assert!(set_caldav_identity_at(&path, "sheep", "e1", "h", "e", None).is_err());
}

#[test]
fn a_second_sync_updates_the_server_fields_and_keeps_the_board_placement() {
    // THE test for this feature. `replace_calendar_events_at` would fail it,
    // which is the whole reason this function exists.
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    merge_caldav_calendar_at(
        &path,
        &cal,
        vec![parsed_task("https://d/e/t.ics", "\"1\"", "draft", 0)],
        &[],
        true,
    )
    .unwrap();

    // The user drags the card, tags it, and adds a subtask.
    let mut task = read_data(&path).unwrap().tasks.remove(0);
    let id = task.id.clone();
    task.column = "doing".into();
    task.rank = Some(2048.0);
    task.tags = vec!["thesis".into()];
    task.subtasks = vec![Subtask {
        id: "s0".into(),
        title: "outline".into(),
        done: true,
        ..Default::default()
    }];
    task.project_id = "proj-1".into();
    task.file = Some(TaskFileLink {
        project_id: "proj-1".into(),
        path: "src/main.rs".into(),
        line: Some(42),
        text: "why?".into(),
    });
    task.created = "2026-07-01T08:00".into();
    update_task_at(&path, task).unwrap();

    // The server's copy is renamed and half-done.
    let data = merge_caldav_calendar_at(
        &path,
        &cal,
        vec![parsed_task("https://d/e/t.ics", "\"2\"", "draft (v2)", 50)],
        &[],
        true,
    )
    .unwrap();

    assert_eq!(
        data.tasks.len(),
        1,
        "a matched row is updated, not duplicated"
    );
    let after = &data.tasks[0];
    assert_eq!(
        after.id, id,
        "the id every other surface references survives"
    );
    assert_eq!(after.title, "draft (v2)", "the server owns the title");
    assert_eq!(after.percent, 50);
    assert_eq!(extra_str(&after.extra, CALDAV_ETAG_KEY), "\"2\"");
    assert_eq!(
        after.column, "doing",
        "the board column is the user's, not the server's"
    );
    assert_eq!(after.rank, Some(2048.0));
    assert_eq!(after.tags, vec!["thesis".to_string()]);
    assert_eq!(after.subtasks.len(), 1);
    assert_eq!(after.project_id, "proj-1");
    assert_eq!(after.file.as_ref().map(|f| f.path.as_str()), Some("src/main.rs"));
    assert_eq!(after.created, "2026-07-01T08:00");
}

#[test]
fn a_new_task_is_placed_by_normalize_like_any_other() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    // The board exists (its first write seeded the columns).
    let seed = card(&path, "local");
    move_tasks_at(&path, vec![place(&seed.id, "doing", 0)]).unwrap();

    let data = merge_caldav_calendar_at(
        &path,
        &cal,
        vec![parsed_task(
            "https://d/e/new.ics",
            "\"1\"",
            "from the server",
            0,
        )],
        &[],
        true,
    )
    .unwrap();
    let fresh = data
        .tasks
        .iter()
        .find(|t| t.title == "from the server")
        .unwrap();
    assert!(
        !fresh.column.is_empty(),
        "an unplaced card is filed by normalize"
    );
    assert!(fresh.rank.is_some());
}

#[test]
fn an_explicit_deletion_removes_both_kinds() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    merge_caldav_calendar_at(
        &path,
        &cal,
        vec![
            parsed_event(
                "https://d/e/a.ics",
                "\"1\"",
                "gone soon",
                "2026-07-08T09:00",
            ),
            parsed_task("https://d/e/t.ics", "\"1\"", "gone soon too", 0),
        ],
        &[],
        true,
    )
    .unwrap();

    let data = merge_caldav_calendar_at(
        &path,
        &cal,
        vec![],
        &[
            "https://d/e/a.ics".to_string(),
            "https://d/e/t.ics".to_string(),
        ],
        false,
    )
    .unwrap();
    assert!(data.events.is_empty());
    assert!(data.tasks.is_empty());
}

#[test]
fn absence_from_a_full_listing_deletes_an_event_but_never_a_task() {
    // The ambiguity `docs/caldav_plan.md` refuses to guess at: a VTODO can
    // vanish from a `calendar-query` because it was deleted *or* because
    // the server stopped returning completed-and-old ones by default. An
    // event has no such filter, so its absence is trustworthy.
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    merge_caldav_calendar_at(
        &path,
        &cal,
        vec![
            parsed_event("https://d/e/a.ics", "\"1\"", "meeting", "2026-07-08T09:00"),
            parsed_task("https://d/e/t.ics", "\"1\"", "todo", 100),
        ],
        &[],
        true,
    )
    .unwrap();

    let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], true).unwrap();
    assert!(
        data.events.is_empty(),
        "an event absent from a full listing is gone"
    );
    assert_eq!(
        data.tasks.len(),
        1,
        "a task absent from a full listing is NOT deleted"
    );
}

#[test]
fn absence_from_an_incremental_report_deletes_nothing() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    merge_caldav_calendar_at(
        &path,
        &cal,
        vec![parsed_event(
            "https://d/e/a.ics",
            "\"1\"",
            "meeting",
            "2026-07-08T09:00",
        )],
        &[],
        true,
    )
    .unwrap();

    // `full: false` — unchanged resources are simply not in a sync-collection
    // reply, so treating absence as deletion would empty the calendar on the
    // first quiet interval.
    let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], false).unwrap();
    assert_eq!(data.events.len(), 1);
}

#[test]
fn a_sync_never_deletes_a_row_it_did_not_create() {
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let mut local = event("hand-made", "2026-07-08T09:00", "2026-07-08T10:00");
    local.calendar_id = cal.clone();
    create_event_at(&path, local).unwrap();

    let data = merge_caldav_calendar_at(&path, &cal, vec![], &[], true).unwrap();
    assert_eq!(
        data.events.len(),
        1,
        "a row with no caldav_href was not put there by a sync"
    );
}

#[test]
fn a_resource_holding_a_series_and_its_override_matches_positionally() {
    // One CalDAV resource can hold a master VEVENT plus its RECURRENCE-ID
    // overrides — there is no separate occurrence object to fetch — so both
    // components arrive under one href.
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let series = CalDavParsed {
        href: "https://d/e/s.ics".into(),
        etag: "\"1\"".into(),
        events: vec![
            CalendarEvent {
                title: "weekly".into(),
                start: "2026-07-08T09:00".into(),
                end: "2026-07-08T10:00".into(),
                ..Default::default()
            },
            CalendarEvent {
                title: "weekly (moved)".into(),
                start: "2026-07-15T11:00".into(),
                end: "2026-07-15T12:00".into(),
                ..Default::default()
            },
        ],
        tasks: Vec::new(),
    };
    let data = merge_caldav_calendar_at(&path, &cal, vec![series.clone()], &[], true).unwrap();
    assert_eq!(data.events.len(), 2);
    let ids: Vec<String> = data.events.iter().map(|e| e.id.clone()).collect();

    // Second sync, same shape: both rows keep their ids.
    let data = merge_caldav_calendar_at(&path, &cal, vec![series], &[], true).unwrap();
    let after: Vec<String> = data.events.iter().map(|e| e.id.clone()).collect();
    assert_eq!(ids, after);

    // The override is removed upstream: the resource shrinks to one
    // component, and the orphaned local row goes with it.
    let shrunk = parsed_event("https://d/e/s.ics", "\"2\"", "weekly", "2026-07-08T09:00");
    let data = merge_caldav_calendar_at(&path, &cal, vec![shrunk], &[], true).unwrap();
    assert_eq!(data.events.len(), 1);
    assert_eq!(data.events[0].id, ids[0]);
}

#[test]
fn merging_into_a_calendar_that_is_gone_is_an_error_not_a_silent_write() {
    let (_dir, path) = tmp_path();
    assert!(merge_caldav_calendar_at(&path, "no-such-calendar", vec![], &[], true).is_err());
}

/// E3: an event made from a mail keeps its `from_mail` stamp through an
/// edit that leaves it out (or sends `null`) and through a CalDAV merge,
/// even one whose server copy names the key itself.
#[test]
fn a_mail_stamp_survives_edits_and_merges() {
    let (_dir, path) = tmp_path();
    let stamp = serde_json::json!({ "message_id": "INBOX-7", "account_id": "a1" });
    let mut event = CalendarEvent {
        title: "Kick-off".into(),
        start: "2026-10-05T10:00".into(),
        end: "2026-10-05T11:00".into(),
        ..Default::default()
    };
    event.extra.insert(FROM_MAIL_KEY.into(), stamp.clone());
    let created = create_event_at(&path, event).unwrap();
    assert_eq!(created.extra.get(FROM_MAIL_KEY), Some(&stamp));

    let mut edit = created.clone();
    edit.title = "Kick-off (moved)".into();
    edit.extra.remove(FROM_MAIL_KEY);
    let updated = update_event_at(&path, edit.clone()).unwrap();
    assert_eq!(updated.title, "Kick-off (moved)");
    assert_eq!(updated.extra.get(FROM_MAIL_KEY), Some(&stamp), "an edit that leaves it out");
    edit.extra.insert(FROM_MAIL_KEY.into(), serde_json::Value::Null);
    assert_eq!(update_event_at(&path, edit).unwrap().extra.get(FROM_MAIL_KEY), Some(&stamp), "or nulls it");

    // The synced copy: a merge carries the stamp, over the server's own key.
    let cal = caldav_calendar(&path);
    let mut stored = read_data(&path).unwrap();
    let row = stored.events.iter_mut().find(|e| e.id == created.id).unwrap();
    row.calendar_id = cal.clone();
    row.extra.insert(CALDAV_HREF_KEY.into(), serde_json::json!("https://d/e/k.ics"));
    storage::write_json_atomic(&path, &stored).unwrap();
    let mut incoming = parsed_event("https://d/e/k.ics", "\"2\"", "Kick-off (server)", "2026-10-05T10:00");
    incoming.events[0].extra.insert(FROM_MAIL_KEY.into(), serde_json::Value::Null);
    let merged = merge_caldav_calendar_at(&path, &cal, vec![incoming], &[], true).unwrap();
    let row = merged.events.iter().find(|e| e.id == created.id).unwrap();
    assert_eq!(row.title, "Kick-off (server)");
    assert_eq!(row.extra.get(FROM_MAIL_KEY), Some(&stamp));
}

/// An existing `calendar.json` — events and cards written before the stamp
/// existed — reads and writes back without gaining one; a stamped row
/// round-trips it unchanged.
#[test]
fn calendar_json_without_the_mail_stamp_round_trips() {
    let (_dir, path) = tmp_path();
    let old = r##"{"version":2,"calendars":[{"id":"default","name":"Personal","color":"#4aa3df","visible":true}],
            "events":[{"id":"e1","calendar_id":"default","start":"2026-10-05T10:00","end":"2026-10-05T11:00","title":"Old"},
                      {"id":"e2","calendar_id":"default","start":"2026-10-06T10:00","end":"2026-10-06T11:00","title":"Mail",
                       "from_mail":{"message_id":"INBOX-7","account_id":"a1"}}],
            "tasks":[{"id":"t1","calendar_id":"default","title":"Card","mail":{"message_id":"INBOX-7","subject":"Hi"}}]}"##;
    std::fs::write(&path, old).unwrap();
    let data = read_data(&path).unwrap();
    storage::write_json_atomic(&path, &data).unwrap();
    let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(back["events"][0].get("from_mail").is_none(), "{}", back["events"][0]);
    assert_eq!(back["events"][1]["from_mail"], serde_json::json!({"message_id":"INBOX-7","account_id":"a1"}));
    assert_eq!(back["tasks"][0]["mail"]["message_id"], "INBOX-7");
    assert!(back["tasks"][0].get("from_mail").is_none());
}

// ── Unpushed local edits (gap 32) ────────────────────────────────────

/// A synced calendar holding one event and one card, both from the server.
fn synced_pair(path: &Path) -> (String, String, String) {
    let cal = caldav_calendar(path);
    let data = merge_caldav_calendar_at(
        path,
        &cal,
        vec![
            parsed_event("https://d/e/a.ics", "\"1\"", "standup", "2026-07-08T09:00"),
            parsed_task("https://d/e/t.ics", "\"1\"", "card", 0),
        ],
        &[],
        true,
    )
    .unwrap();
    (cal, data.events[0].id.clone(), data.tasks[0].id.clone())
}

fn edit_dirty(path: &Path, event_id: &str, title: &str) {
    let mut e = read_data(path).unwrap().events.into_iter().find(|e| e.id == event_id).unwrap();
    e.title = title.into();
    e.extra.insert(CALDAV_DIRTY_KEY.into(), serde_json::Value::Bool(true));
    update_event_at(path, e).unwrap();
}

#[test]
fn a_failed_push_stays_dirty_and_the_merge_keeps_the_edit() {
    let (_dir, path) = tmp_path();
    let (cal, eid, _) = synced_pair(&path);
    // The window's write marks it; `caldav_push` marks it again before it
    // sends, and nothing clears it because the push failed.
    edit_dirty(&path, &eid, "standup (moved)");
    mark_caldav_dirty_at(&path, "event", &eid).unwrap();

    // A sync whose server copy did not change: kept silently (a push is
    // still owed), nothing reported.
    let (data, kept) = merge_caldav_calendar_kept_at(
        &path,
        &cal,
        vec![parsed_event("https://d/e/a.ics", "\"1\"", "standup", "2026-07-08T09:00")],
        &[],
        true,
        &[],
    )
    .unwrap();
    let e = data.events.iter().find(|e| e.id == eid).unwrap();
    assert_eq!(e.title, "standup (moved)", "the merge never overwrites a dirty row");
    assert!(is_dirty(&e.extra));
    assert!(kept.is_empty(), "{kept:?}");

    // The server changed it too: still kept, and reported as a conflict.
    let (data, kept) = merge_caldav_calendar_kept_at(
        &path,
        &cal,
        vec![parsed_event("https://d/e/a.ics", "\"2\"", "standup (server)", "2026-07-08T09:00")],
        &[],
        true,
        &[],
    )
    .unwrap();
    let e = data.events.iter().find(|e| e.id == eid).unwrap();
    assert_eq!(e.title, "standup (moved)");
    assert_eq!(extra_str(&e.extra, CALDAV_ETAG_KEY), "\"1\"", "still conditional on what it read");
    assert_eq!(kept.len(), 1);
    assert_eq!((kept[0].row_id.as_str(), kept[0].reason.as_str()), (eid.as_str(), "changed"));
    assert_eq!(kept[0].href, "https://d/e/a.ics");

    // "Use the server's": the mark goes in the same write and the server
    // copy lands.
    let (data, kept) = merge_caldav_calendar_kept_at(
        &path,
        &cal,
        vec![parsed_event("https://d/e/a.ics", "\"2\"", "standup (server)", "2026-07-08T09:00")],
        &[],
        true,
        std::slice::from_ref(&eid),
    )
    .unwrap();
    let e = data.events.iter().find(|e| e.id == eid).unwrap();
    assert_eq!(e.title, "standup (server)");
    assert!(!e.extra.contains_key(CALDAV_DIRTY_KEY));
    assert!(kept.is_empty());
}

#[test]
fn a_dirty_row_the_server_deleted_becomes_local_only_and_is_reported() {
    let (_dir, path) = tmp_path();
    let (cal, eid, tid) = synced_pair(&path);
    edit_dirty(&path, &eid, "standup (mine)");
    let mut t = read_data(&path).unwrap().tasks.remove(0);
    t.title = "card (mine)".into();
    t.extra.insert(CALDAV_DIRTY_KEY.into(), serde_json::Value::Bool(true));
    update_task_at(&path, t).unwrap();

    // The card by an explicit 404; the event by its absence from a full
    // listing.
    let (data, kept) =
        merge_caldav_calendar_kept_at(&path, &cal, vec![], &["https://d/e/t.ics".into()], true, &[]).unwrap();
    let e = data.events.iter().find(|e| e.id == eid).expect("event kept");
    let t = data.tasks.iter().find(|t| t.id == tid).expect("card kept");
    for (extra, title) in [(&e.extra, &e.title), (&t.extra, &t.title)] {
        assert!(title.ends_with("(mine)"));
        assert!(!extra.contains_key(CALDAV_HREF_KEY), "local-only now");
        assert!(!extra.contains_key(CALDAV_ETAG_KEY));
        assert!(is_dirty(extra));
    }
    assert_eq!(extra_str(&e.extra, CALDAV_SERVER_DELETED_KEY), "https://d/e/a.ics");
    assert_eq!(extra_str(&t.extra, CALDAV_SERVER_DELETED_KEY), "https://d/e/t.ics");
    let mut reasons: Vec<(String, String)> =
        kept.iter().map(|k| (k.kind.clone(), k.reason.clone())).collect();
    reasons.sort();
    assert_eq!(
        reasons,
        [("event".to_string(), "deleted".to_string()), ("task".to_string(), "deleted".to_string())]
    );

    // A later sync leaves them alone (no href to match); "Use the
    // server's" deletes them here too.
    let (data, _) = merge_caldav_calendar_kept_at(&path, &cal, vec![], &[], true, &[]).unwrap();
    assert_eq!((data.events.len(), data.tasks.len()), (1, 1));
    let (data, _) =
        merge_caldav_calendar_kept_at(&path, &cal, vec![], &[], true, &[eid.clone(), tid.clone()]).unwrap();
    assert!(data.events.is_empty() && data.tasks.is_empty());
}

#[test]
fn a_clean_row_is_still_overwritten_and_deleted_as_before() {
    let (_dir, path) = tmp_path();
    let (cal, eid, _) = synced_pair(&path);
    let (data, kept) = merge_caldav_calendar_kept_at(
        &path,
        &cal,
        vec![parsed_event("https://d/e/a.ics", "\"2\"", "renamed", "2026-07-08T09:00")],
        &["https://d/e/t.ics".into()],
        true,
        &[],
    )
    .unwrap();
    assert_eq!(data.events.iter().find(|e| e.id == eid).unwrap().title, "renamed");
    assert!(data.tasks.is_empty());
    assert!(kept.is_empty());
}

#[test]
fn a_push_clears_the_mark_only_for_the_revision_it_sent() {
    let (_dir, path) = tmp_path();
    let (_, eid, _) = synced_pair(&path);
    let rev_of = |path: &Path| read_data(path).unwrap().events.into_iter().find(|e| e.id == eid).unwrap().rev;

    // Sent, accepted, nothing edited meanwhile: clean.
    let (_, marked) = mark_caldav_dirty_at(&path, "event", &eid).unwrap();
    assert_eq!(marked, rev_of(&path));
    let dirty = set_caldav_identity_at(&path, "event", &eid, "https://d/e/a.ics", "\"2\"", Some(marked)).unwrap();
    assert!(!dirty);
    assert!(!read_data(&path).unwrap().events[0].extra.contains_key(CALDAV_DIRTY_KEY));

    // An edit lands while the write is in flight: the mark stays, so the
    // newer edit is still pushed and never overwritten by a merge.
    let (_, marked) = mark_caldav_dirty_at(&path, "event", &eid).unwrap();
    edit_dirty(&path, &eid, "edited mid-push");
    let dirty = set_caldav_identity_at(&path, "event", &eid, "https://d/e/a.ics", "\"3\"", Some(marked)).unwrap();
    assert!(dirty);
    // The pushed bytes were already stale (`None`): kept as well.
    assert!(set_caldav_identity_at(&path, "event", &eid, "https://d/e/a.ics", "\"4\"", None).unwrap());

    // A server-deleted marker goes once the row is on the server again.
    let mut data = read_data(&path).unwrap();
    data.events[0]
        .extra
        .insert(CALDAV_SERVER_DELETED_KEY.into(), serde_json::Value::String("https://d/e/a.ics".into()));
    write_data(&path, &data).unwrap();
    let rev = rev_of(&path);
    assert!(!set_caldav_identity_at(&path, "event", &eid, "https://d/e/b.ics", "\"5\"", Some(rev)).unwrap());
    assert!(!read_data(&path).unwrap().events[0].extra.contains_key(CALDAV_SERVER_DELETED_KEY));
}

#[test]
fn a_push_gives_the_resources_other_rows_its_etag_so_their_push_is_no_conflict() {
    // A series with an override row: both edited while a push could not get
    // through. The sync pushes the resource once (both rows ride in the
    // body); the override must not keep the old ETag, or its own push is a
    // `412` and the merge reports the server as having changed it.
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let mut over = parsed_event("https://d/e/s.ics", "\"1\"", "series", "2026-07-08T09:00");
    let second = over.events[0].clone();
    over.events.push(CalendarEvent { start: "2026-07-15T10:00".into(), ..second });
    let data = merge_caldav_calendar_at(&path, &cal, vec![over], &[], true).unwrap();
    assert_eq!(data.events.len(), 2);
    let (a, b) = (data.events[0].id.clone(), data.events[1].id.clone());
    edit_dirty(&path, &a, "series (mine)");
    edit_dirty(&path, &b, "override (mine)");
    let (_, rev) = mark_caldav_dirty_at(&path, "event", &a).unwrap();

    assert!(!set_caldav_identity_at(&path, "event", &a, "https://d/e/s.ics", "\"2\"", Some(rev)).unwrap());
    let stored = read_data(&path).unwrap();
    let row_b = stored.events.iter().find(|e| e.id == b).unwrap();
    assert_eq!(extra_str(&row_b.extra, CALDAV_ETAG_KEY), "\"2\"");
    assert!(is_dirty(&row_b.extra), "its own revision was not the one pushed");

    // The server holds what was pushed: nothing to ask about.
    let mut back = parsed_event("https://d/e/s.ics", "\"2\"", "series (mine)", "2026-07-08T09:00");
    let second = back.events[0].clone();
    back.events.push(CalendarEvent { start: "2026-07-15T10:00".into(), ..second });
    let (_, kept) = merge_caldav_calendar_kept_at(&path, &cal, vec![back], &[], true, &[]).unwrap();
    assert!(kept.is_empty(), "{kept:?}");

    // A create (no address before) touches no other row.
    let lone = create_event_at(&path, CalendarEvent { calendar_id: cal.clone(), title: "new".into(), ..Default::default() }).unwrap();
    set_caldav_identity_at(&path, "event", &lone.id, "https://d/e/s.ics", "\"9\"", None).unwrap();
    let stored = read_data(&path).unwrap();
    assert_eq!(extra_str(&stored.events.iter().find(|e| e.id == b).unwrap().extra, CALDAV_ETAG_KEY), "\"2\"");
}

#[test]
fn an_edit_from_a_copy_without_the_mark_cannot_clear_it() {
    let (_dir, path) = tmp_path();
    let (_, eid, tid) = synced_pair(&path);
    mark_caldav_dirty_at(&path, "event", &eid).unwrap();
    mark_caldav_dirty_at(&path, "task", &tid).unwrap();
    let data = read_data(&path).unwrap();
    let mut e = data.events[0].clone();
    e.extra.remove(CALDAV_DIRTY_KEY);
    e.title = "again".into();
    assert!(is_dirty(&update_event_at(&path, e.clone()).unwrap().extra));
    let mut t = data.tasks[0].clone();
    t.extra.remove(CALDAV_DIRTY_KEY);
    assert!(is_dirty(&update_task_at(&path, t).unwrap().extra));
    // A move to another calendar drops it; that calendar's write marks it
    // again if it syncs.
    let other = caldav_calendar(&path);
    e.calendar_id = other.clone();
    e.extra.insert(CALDAV_SERVER_DELETED_KEY.into(), serde_json::Value::String("https://d/e/a.ics".into()));
    let moved = update_event_at(&path, e).unwrap();
    assert!(!is_dirty(&moved.extra));
    assert!(!moved.extra.contains_key(CALDAV_SERVER_DELETED_KEY), "no stale question in the new calendar");
    // An agent's move (`relocate_*`) forgets the same bookkeeping.
    let mut t = read_data(&path).unwrap().tasks.remove(0);
    t.extra.insert(CALDAV_SERVER_DELETED_KEY.into(), serde_json::Value::String("x".into()));
    relocate_task(&mut t, &other);
    assert!(!is_dirty(&t.extra) && !t.extra.contains_key(CALDAV_SERVER_DELETED_KEY));
    assert!(!t.extra.contains_key(CALDAV_HREF_KEY));
}

/// A calendar a CalDAV subscription feeds (its record carries the
/// collection's address), as `subscribe` creates it.
fn subscribed_calendar(path: &Path, href: &str) -> String {
    let mut extra = HashMap::new();
    extra.insert(CALDAV_HREF_KEY.to_string(), serde_json::Value::String(href.into()));
    create_calendar_at(
        path,
        Calendar {
            rev: 0,
            id: String::new(),
            name: "Team".into(),
            color: "#4aa3df".into(),
            visible: true,
            readonly: false,
            extra,
        },
    )
    .unwrap()
    .id
}

#[test]
fn a_row_moved_into_a_local_calendar_drops_its_push_bookkeeping() {
    // Step 7 review item 7: the window's copy of a dirty row still carries
    // `caldav_dirty` when it is moved; into a calendar nothing pushes, the
    // mark (and the server-deleted question) must not come along.
    let (_dir, path) = tmp_path();
    let (_, eid, tid) = synced_pair(&path);
    mark_caldav_dirty_at(&path, "event", &eid).unwrap();
    mark_caldav_dirty_at(&path, "task", &tid).unwrap();
    let data = read_data(&path).unwrap();
    let local = caldav_calendar(&path);

    let mut e = data.events[0].clone();
    assert!(is_dirty(&e.extra));
    e.calendar_id = local.clone();
    e.extra.insert(CALDAV_SERVER_DELETED_KEY.into(), serde_json::Value::String("https://d/e/a.ics".into()));
    let moved = update_event_at(&path, e).unwrap();
    assert!(!is_dirty(&moved.extra), "{:?}", moved.extra);
    assert!(!moved.extra.contains_key(CALDAV_SERVER_DELETED_KEY));

    let mut t = data.tasks[0].clone();
    assert!(is_dirty(&t.extra));
    t.calendar_id = local;
    let moved = update_task_at(&path, t).unwrap();
    assert!(!is_dirty(&moved.extra), "{:?}", moved.extra);

    // Into another CalDAV calendar the window's mark for the new
    // collection stays (its push then creates the row there).
    let team = subscribed_calendar(&path, "https://d/team/");
    let mut e = read_data(&path).unwrap().events.remove(0);
    e.calendar_id = team;
    e.extra.insert(CALDAV_DIRTY_KEY.into(), serde_json::Value::Bool(true));
    e.extra.insert(CALDAV_SERVER_DELETED_KEY.into(), serde_json::Value::String("https://d/e/a.ics".into()));
    let moved = update_event_at(&path, e).unwrap();
    assert!(is_dirty(&moved.extra));
    assert!(!moved.extra.contains_key(CALDAV_SERVER_DELETED_KEY));
}

#[test]
fn an_account_moved_to_https_rewrites_its_rows_same_host_addresses() {
    let (_dir, path) = tmp_path();
    let cal = subscribed_calendar(&path, "http://dav.example.com/cal/");
    let other = subscribed_calendar(&path, "http://dav.example.com/other/");
    let data = merge_caldav_calendar_at(
        &path,
        &cal,
        vec![
            parsed_event("http://dav.example.com/cal/a.ics", "\"1\"", "standup", "2026-07-08T09:00"),
            parsed_event("http://elsewhere.example.net/cal/b.ics", "\"1\"", "far", "2026-07-09T09:00"),
            parsed_task("http://dav.example.com/cal/t.ics", "\"1\"", "card", 0),
        ],
        &[],
        true,
    )
    .unwrap();
    merge_caldav_calendar_at(
        &path,
        &other,
        vec![parsed_event("http://dav.example.com/other/c.ics", "\"1\"", "untouched", "2026-07-10T09:00")],
        &[],
        true,
    )
    .unwrap();
    let gone = data.events.iter().find(|e| e.title == "standup").unwrap().id.clone();
    let mut d = read_data(&path).unwrap();
    let row = d.events.iter_mut().find(|e| e.id == gone).unwrap();
    row.extra.insert(
        CALDAV_SERVER_DELETED_KEY.into(),
        serde_json::Value::String("http://dav.example.com/cal/old.ics".into()),
    );
    write_data(&path, &d).unwrap();

    let origin = url::Url::parse("https://dav.example.com/").unwrap();
    upgrade_caldav_hrefs_at(&path, std::slice::from_ref(&cal), |h| {
        crate::services::caldav::https_twin(h, &origin)
    })
    .unwrap();
    let d = read_data(&path).unwrap();
    let href_of = |title: &str| {
        let e = d.events.iter().find(|e| e.title == title).unwrap();
        extra_str(&e.extra, CALDAV_HREF_KEY)
    };
    assert_eq!(href_of("standup"), "https://dav.example.com/cal/a.ics");
    assert_eq!(href_of("far"), "http://elsewhere.example.net/cal/b.ics", "another host is not ours to rewrite");
    assert_eq!(href_of("untouched"), "http://dav.example.com/other/c.ics", "only the named calendars");
    assert_eq!(extra_str(&d.tasks[0].extra, CALDAV_HREF_KEY), "https://dav.example.com/cal/t.ics");
    let standup = d.events.iter().find(|e| e.title == "standup").unwrap();
    assert_eq!(
        extra_str(&standup.extra, CALDAV_SERVER_DELETED_KEY),
        "https://dav.example.com/cal/old.ics"
    );
    let record = d.calendars.iter().find(|c| c.id == cal).unwrap();
    assert_eq!(extra_str(&record.extra, CALDAV_HREF_KEY), "https://dav.example.com/cal/");
}

#[test]
fn a_row_put_back_into_its_masters_resource_gives_the_master_the_new_etag() {
    // A series the server deleted, both rows dirty: the master was put back
    // first (a create), then "Keep mine" on the override adopts the
    // master's address. The master must take the new ETag, or its next
    // push is a `412` against this machine's own write.
    let (_dir, path) = tmp_path();
    let cal = caldav_calendar(&path);
    let mut series = parsed_event("https://d/e/s.ics", "\"1\"", "series", "2026-07-08T09:00");
    let second = series.events[0].clone();
    series.events.push(CalendarEvent { start: "2026-07-15T10:00".into(), ..second });
    let data = merge_caldav_calendar_at(&path, &cal, vec![series], &[], true).unwrap();
    let (master, over) = (data.events[0].id.clone(), data.events[1].id.clone());
    let mut d = read_data(&path).unwrap();
    let o = d.events.iter_mut().find(|e| e.id == over).unwrap();
    o.extra.remove(CALDAV_HREF_KEY);
    o.extra.remove(CALDAV_ETAG_KEY);
    o.extra.insert(CALDAV_DIRTY_KEY.into(), serde_json::Value::Bool(true));
    write_data(&path, &d).unwrap();

    let (_, rev) = mark_caldav_dirty_at(&path, "event", &over).unwrap();
    let dirty = set_caldav_identity_sent_at(
        &path,
        "event",
        &over,
        "https://d/e/s.ics",
        "\"7\"",
        Some(rev),
        "https://d/e/s.ics",
    )
    .unwrap();
    assert!(!dirty);
    let d = read_data(&path).unwrap();
    for id in [&master, &over] {
        let e = d.events.iter().find(|e| &e.id == id).unwrap();
        assert_eq!(extra_str(&e.extra, CALDAV_ETAG_KEY), "\"7\"", "{id}");
        assert_eq!(extra_str(&e.extra, CALDAV_HREF_KEY), "https://d/e/s.ics");
    }
}

#[test]
fn calendar_json_without_the_dirty_mark_round_trips() {
    let (_dir, path) = tmp_path();
    let old = r##"{"version":2,"calendars":[{"id":"c1","name":"Work","color":"#4aa3df","visible":true}],
            "events":[{"id":"e1","calendar_id":"c1","start":"2026-10-05T10:00","end":"2026-10-05T11:00","title":"Old",
                       "caldav_href":"https://d/e/a.ics","caldav_etag":"\"1\""},
                      {"id":"e2","calendar_id":"c1","start":"2026-10-06T10:00","end":"2026-10-06T11:00","title":"Dirty",
                       "caldav_href":"https://d/e/b.ics","caldav_etag":"\"1\"","caldav_dirty":true}],
            "tasks":[{"id":"t1","calendar_id":"c1","title":"Card","caldav_href":"https://d/e/t.ics"}]}"##;
    std::fs::write(&path, old).unwrap();
    let data = read_data(&path).unwrap();
    storage::write_json_atomic(&path, &data).unwrap();
    let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(back["events"][0].get(CALDAV_DIRTY_KEY).is_none(), "{}", back["events"][0]);
    assert!(back["tasks"][0].get(CALDAV_DIRTY_KEY).is_none());
    assert_eq!(back["events"][1][CALDAV_DIRTY_KEY], serde_json::json!(true));
    assert!(back["events"][0].get(CALDAV_SERVER_DELETED_KEY).is_none());
    // An old row merges as before: overwritten, no report.
    let (data, kept) = merge_caldav_calendar_kept_at(
        &path,
        "c1",
        vec![parsed_event("https://d/e/a.ics", "\"2\"", "New", "2026-10-05T10:00")],
        &[],
        false,
        &[],
    )
    .unwrap();
    assert_eq!(data.events.iter().find(|e| e.id == "e1").unwrap().title, "New");
    assert!(kept.is_empty());
}
