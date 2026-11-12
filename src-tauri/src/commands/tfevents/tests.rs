use super::*;
use crate::services::tfevents::{masked_crc32c, scan};

fn varint(mut v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

fn len_field(number: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = varint(number << 3 | 2);
    out.extend(varint(payload.len() as u64));
    out.extend_from_slice(payload);
    out
}

/// One record holding `tag = value` at `step`.
fn scalar_record(step: u64, value: f32) -> Vec<u8> {
    let mut v = len_field(1, b"loss");
    v.extend(varint(2 << 3 | 5));
    v.extend(value.to_bits().to_le_bytes());
    let mut ev = varint(1 << 3 | 1);
    ev.extend(1.0f64.to_bits().to_le_bytes());
    ev.extend(varint(2 << 3));
    ev.extend(varint(step));
    ev.extend(len_field(5, &len_field(1, &v)));
    let len = (ev.len() as u64).to_le_bytes();
    let mut out = len.to_vec();
    out.extend(masked_crc32c(&len).to_le_bytes());
    out.extend_from_slice(&ev);
    out.extend(masked_crc32c(&ev).to_le_bytes());
    out
}

/// What `tfevents_read` does, against an in-memory "file".
fn read_step(file: &[u8], cursor: Option<&TfCursor>) -> TfRead {
    let size = file.len() as u64;
    let (reset, offset, max) = plan_window(cursor, size);
    let start = (offset as usize).min(file.len());
    let end = (start + max).min(file.len());
    finish(size, 7, reset, offset, &file[start..end])
}

fn steps(r: &TfRead) -> Vec<i64> {
    r.scalars.get("loss").map(|p| p.iter().map(Point::step).collect()).unwrap_or_default()
}

#[test]
fn the_first_read_starts_at_zero_and_a_cursor_resumes() {
    let (reset, offset, max) = plan_window(None, 1000);
    assert_eq!((reset, offset, max), (false, 0, 1000));
    let c = TfCursor { offset: 400, size: 900, mtime: 1 };
    assert_eq!(plan_window(Some(&c), 1000), (false, 400, 600));
    let at_end = TfCursor { offset: 400, size: 400, mtime: 1 };
    assert_eq!(plan_window(Some(&at_end), 400), (false, 400, 0));
}

#[test]
fn a_shrunk_file_starts_over() {
    let c = TfCursor { offset: 900, size: 900, mtime: 1 };
    assert_eq!(plan_window(Some(&c), 500), (true, 0, 500));
}

#[test]
fn a_cursor_beyond_the_end_waits() {
    let c = TfCursor { offset: 5000, size: 900, mtime: 1 };
    assert_eq!(plan_window(Some(&c), 1000), (false, 5000, 0));
}

#[test]
fn one_read_is_bounded_and_says_when_more_remains() {
    let huge = 10 * CHUNK;
    assert_eq!(plan_window(None, huge), (false, 0, CHUNK as usize));
    let one = scalar_record(0, 1.0);
    let r = finish(one.len() as u64 * 3, 1, false, 0, &one);
    assert!(r.truncated, "two records are still unread");
    let r = finish(one.len() as u64, 1, false, 0, &one);
    assert!(!r.truncated);
}

#[test]
fn a_torn_tail_never_loops_the_caller() {
    let a = scalar_record(0, 1.0);
    let b = scalar_record(1, 2.0);
    let mut file = a.clone();
    file.extend_from_slice(&b[..b.len() - 3]);
    let r = read_step(&file, None);
    assert_eq!(r.cursor.offset, a.len() as u64);
    assert!(r.truncated, "bytes remain beyond the cursor");
    // Asking again from that cursor moves nothing and must say so: this is
    // the answer that stops the viewer's catch-up loop.
    let again = read_step(&file, Some(&r.cursor));
    assert_eq!(again.cursor.offset, a.len() as u64);
    assert!(!again.truncated);
    assert!(steps(&again).is_empty());
}

#[test]
fn following_a_growing_file_yields_each_point_once() {
    let recs: Vec<Vec<u8>> = (0..5).map(|i| scalar_record(i, i as f32)).collect();
    let mut file = Vec::new();
    let mut cursor: Option<TfCursor> = None;
    let mut seen = Vec::new();
    for (i, rec) in recs.iter().enumerate() {
        // Half of the record lands first, then the rest.
        file.extend_from_slice(&rec[..rec.len() / 2]);
        let r = read_step(&file, cursor.as_ref());
        seen.extend(steps(&r));
        cursor = Some(r.cursor);
        file.extend_from_slice(&rec[rec.len() / 2..]);
        let r = read_step(&file, cursor.as_ref());
        seen.extend(steps(&r));
        assert!(!r.reset);
        cursor = Some(r.cursor);
        assert_eq!(seen.len(), i + 1);
    }
    assert_eq!(seen, vec![0, 1, 2, 3, 4]);
}

#[test]
fn a_replaced_smaller_file_restarts_from_byte_zero() {
    let long: Vec<u8> = (0..4).flat_map(|i| scalar_record(i, 1.0)).collect();
    let r = read_step(&long, None);
    assert_eq!(steps(&r), vec![0, 1, 2, 3]);
    let short = scalar_record(9, 3.0);
    let r2 = read_step(&short, Some(&r.cursor));
    assert!(r2.reset);
    assert_eq!(steps(&r2), vec![9]);
}

#[test]
fn resuming_agrees_with_one_full_scan() {
    let file: Vec<u8> = (0..50).flat_map(|i| scalar_record(i, i as f32)).collect();
    let full = scan(&file, 0);
    let cut = scalar_record(0, 0.0).len() * 20 + 5; // mid-record
    let first = read_step(&file[..cut], None);
    let rest = read_step(&file, Some(&first.cursor));
    let mut both = steps(&first);
    both.extend(steps(&rest));
    let want: Vec<i64> = full.scalars["loss"].iter().map(Point::step).collect();
    assert_eq!(both, want);
}

#[test]
fn event_files_are_matched_by_name_prefix() {
    assert!(is_event_file("events.out.tfevents.1700000000.host.123.0"));
    assert!(!is_event_file("events.out.tfevents"));
    assert!(!is_event_file("my.events.out.tfevents.1"));
    assert!(!is_event_file("loss.csv"));
}

fn touch(dir: &std::path::Path, rel: &[&str], name: &str) {
    let mut p = dir.to_path_buf();
    for part in rel {
        p = p.join(part);
    }
    std::fs::create_dir_all(&p).unwrap();
    std::fs::write(p.join(name), b"x").unwrap();
}

#[test]
fn discovery_finds_event_files_to_a_bounded_depth() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    touch(root, &[], "events.out.tfevents.1.a");
    touch(root, &["run1"], "events.out.tfevents.2.a");
    touch(root, &["run1", "val"], "events.out.tfevents.3.a");
    touch(root, &["a", "b", "c"], "events.out.tfevents.4.a");
    touch(root, &["a", "b", "c", "d"], "events.out.tfevents.too_deep");
    touch(root, &["run1"], "notes.txt");
    let found = discover_walk(root.to_path_buf()).unwrap();
    let names: Vec<_> = found.iter().map(|f| f.path.rsplit(['/', '\\']).next().unwrap().to_string()).collect();
    assert_eq!(found.len(), 4, "{names:?}");
    assert!(names.iter().all(|n| n.starts_with("events.out.tfevents.")));
    assert!(!names.iter().any(|n| n.ends_with("too_deep")));
    assert!(found.windows(2).all(|w| w[0].path <= w[1].path), "sorted");
}

#[test]
fn discovery_stops_at_the_file_limit() {
    let tmp = tempfile::tempdir().unwrap();
    for i in 0..(DISCOVER_FILES + 20) {
        touch(tmp.path(), &[], &format!("events.out.tfevents.{i}.h"));
    }
    assert_eq!(discover_walk(tmp.path().to_path_buf()).unwrap().len(), DISCOVER_FILES);
}

#[cfg(unix)]
#[test]
fn discovery_does_not_follow_links() {
    let tmp = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    touch(outside.path(), &[], "events.out.tfevents.9.secret");
    std::os::unix::fs::symlink(outside.path(), tmp.path().join("link")).unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("events.out.tfevents.9.secret"),
        tmp.path().join("events.out.tfevents.8.link"),
    )
    .unwrap();
    assert!(discover_walk(tmp.path().to_path_buf()).unwrap().is_empty());
}

#[test]
fn discovery_of_a_missing_folder_is_an_error() {
    let tmp = tempfile::tempdir().unwrap();
    assert!(discover_walk(tmp.path().join("nope")).is_err());
}

#[test]
fn the_local_window_read_is_confined_and_ranged() {
    use crate::commands::fs::{open_confined, read_range_opened, Confined};
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let file = root.join("events.out.tfevents.1.h");
    std::fs::write(&file, b"0123456789").unwrap();
    let roots = vec![root.clone()];

    let open = || open_confined(&file, &roots, Confined::Read).unwrap();
    let r = read_range_opened(open(), |size, _| (size - 4, 100)).unwrap();
    assert_eq!((r.size, r.bytes.as_slice()), (10, &b"6789"[..]));
    let r = read_range_opened(open(), |_, _| (2, 3)).unwrap();
    assert_eq!(r.bytes, b"234");
    // At or past the end, or a zero-length window: nothing, and no error.
    assert!(read_range_opened(open(), |size, _| (size, 5)).unwrap().bytes.is_empty());
    assert!(read_range_opened(open(), |size, _| (size + 9, 5)).unwrap().bytes.is_empty());
    assert!(read_range_opened(open(), |_, _| (0, 0)).unwrap().bytes.is_empty());

    // Outside every root the file does not open at all.
    let other = tempfile::tempdir().unwrap();
    let outside = other.path().canonicalize().unwrap().join("events.out.tfevents.2.h");
    std::fs::write(&outside, b"x").unwrap();
    assert!(open_confined(&outside, &roots, Confined::Read).is_err());
}
