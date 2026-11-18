use super::*;
use serde_json::json;
use std::fs;

use crate::services::cockpit_meta::{Change, ResultItem};
use crate::services::mobile_control::headless::session_file;
use crate::services::workspace::{self, tab_id};

fn list(entries: Value) -> ProjectsList {
    serde_json::from_value(entries).unwrap()
}

fn entry(id: &str, dir: &Path, extra: Value) -> Value {
    let mut value = json!({"id":id,"name":id,"status":"inactive","position":0,"local_file":"","directory":dir.to_string_lossy()});
    for (key, v) in extra.as_object().cloned().unwrap_or_default() {
        value[key] = v;
    }
    value
}

fn item(label: &str, path: &str) -> ResultItem {
    ResultItem { label: label.into(), relative_path: path.into() }
}

#[test]
fn plain_relative_paths_are_accepted_as_given() {
    for ok in ["plot.png", "out/plot.png", "report v2/final results.pdf", "日本語/ファイル.md", "a/b/c/d.tex", ".hidden/x", "x.tar.gz"] {
        assert_eq!(clean_path(ok).as_deref(), Some(ok), "{ok}");
    }
    assert!(clean_path(&"a".repeat(meta::RESULT_PATH_MAX_CHARS)).is_some());
    assert!(clean_path(&"a".repeat(meta::RESULT_PATH_MAX_CHARS + 1)).is_none());
    assert!(clean_path(&"日".repeat(meta::RESULT_PATH_MAX_CHARS)).is_some(), "the bound counts characters, not bytes");
}

#[test]
fn traversal_absolute_and_foreign_path_forms_are_refused() {
    let own_dir = format!("{}/state.json", crate::brand::PROJECT_DIR);
    let temp = tempfile::tempdir().unwrap();
    let native_absolute = temp.path().join("x.png").to_string_lossy().into_owned();
    let too_long = format!("{}x", "d/".repeat(300));
    for bad in [
        "", " ", "..", "../x", "a/../b", "a/..", "../../etc/passwd", "a/b/../../../c", ".", "./a", "a/./b", "...",
        "/etc/passwd", "//host/share/x", "/", "\\\\host\\share\\x", "\\x", "a\\b", "a\\..\\b", "..\\x",
        "C:/x", "C:x", "c:\\x", "C:", "D:/", "\\\\?\\C:\\x", "\\\\.\\NUL",
        "file:///etc/passwd", "http://example.com/a.png", "https://x/y", "javascript:alert(1)", "data:text/html,x", "mailto:a@b", "ftp://x/y",
        "a/", "a//b", "/a", "a.", "a /b", "a/b ", " a", "a/b.",
        "NUL", "nul.txt", "a/CON", "com1.txt", "LPT9", "a/aux.log", "COM\u{b9}",
        "file.txt:stream", "a*b", "a?b", "a<b", "a>b", "a|b", "a\"b",
        "a\u{202e}b", "a\u{200b}b", "a\u{feff}b", "a\nb", "a\tb", "a\rb", "a\u{1b}[31m", "a\0b",
        own_dir.as_str(), native_absolute.as_str(), too_long.as_str(),
    ] {
        assert!(clean_path(bad).is_none(), "{bad:?}");
    }
}

#[test]
fn a_result_list_is_bounded_and_strict() {
    let one = |label: &str, path: &str| json!({"label":label,"relativePath":path});
    let many = |n: usize| (0..n).map(|i| one("L", &format!("f{i}.png"))).collect::<Vec<_>>();
    assert_eq!(clean_items(&[]), Some(vec![]));
    assert_eq!(clean_items(&many(meta::RESULTS_MAX_ITEMS)).map(|v| v.len()), Some(8));
    assert!(clean_items(&many(meta::RESULTS_MAX_ITEMS + 1)).is_none());
    assert_eq!(
        clean_items(&[one("  Plot  ", "out/plot.png")]),
        Some(vec![item("Plot", "out/plot.png")]),
        "labels are trimmed, paths kept as given"
    );
    assert!(clean_items(&[one(&"x".repeat(meta::RESULT_LABEL_MAX_CHARS), "a")]).is_some());
    assert!(clean_items(&[one(&"日".repeat(meta::RESULT_LABEL_MAX_CHARS), "a")]).is_some(), "characters, not bytes");
    assert!(clean_items(&[one(&"x".repeat(meta::RESULT_LABEL_MAX_CHARS + 1), "a")]).is_none());
    for bad in [
        json!("text"), json!(null), json!(7), json!([]), json!({}), json!({"label":"L"}), json!({"relativePath":"a"}),
        json!({"label":"L","relativePath":"a","extra":1}), json!({"label":1,"relativePath":"a"}),
        json!({"label":"L","relativePath":null}), json!({"label":"","relativePath":"a"}), json!({"label":"  ","relativePath":"a"}),
        json!({"label":"two\nlines","relativePath":"a"}), json!({"label":"bidi\u{202e}","relativePath":"a"}),
        json!({"label":"L","relativePath":"../a"}),
    ] {
        assert!(clean_items(std::slice::from_ref(&bad)).is_none(), "{bad}");
    }
    // One bad entry spoils the list: nothing is half-accepted.
    assert!(clean_items(&[one("ok", "a.png"), one("bad", "/etc/passwd")]).is_none());
}

#[test]
fn only_a_local_registered_project_has_a_root() {
    let dir = tempfile::tempdir().unwrap();
    let remote = json!({"remote":{"host":"h.example","remote_path":"/srv/p"}});
    let remote_only = json!({"remote":{"host":"h.example","remote_path":"/srv/p","remote_only":true}});
    let workers = json!({"compute_hosts":[{"id":"w1","host":"gpu.example","remote_path":"/srv/p"}]});
    let vm = json!({"vm":{"name":"v"}});
    let registry = list(json!([
        entry("local", dir.path(), json!({})),
        entry("remote", dir.path(), remote),
        entry("remote-only", dir.path(), remote_only),
        entry("workers", dir.path(), workers),
        entry("vm", dir.path(), vm),
        entry("no-hosts", dir.path(), json!({"compute_hosts":[],"remote":null})),
        entry("missing-dir", &dir.path().join("gone"), json!({})),
        {"id":"relative","name":"r","status":"inactive","position":0,"local_file":"","directory":"relative/dir"},
        {"id":"no-dir","name":"n","status":"inactive","position":0,"local_file":""},
        entry("root", dir.path(), json!({})),
        entry("assistant", dir.path(), json!({})),
    ]));
    let root = project_root_in(&registry, "local").expect("a local project");
    assert_eq!(root.dir, dir.path());
    assert_eq!(root.real, fs::canonicalize(dir.path()).unwrap());
    assert!(project_root_in(&registry, "no-hosts").is_some(), "empty worker list and null remote are local");
    for scope in ["remote", "remote-only", "workers", "vm", "missing-dir", "relative", "no-dir", "unknown", "", "root", "assistant", "Assistant ", "box:b1", "box:"] {
        assert!(project_root_in(&registry, scope).is_none(), "{scope:?}");
    }
    // A file is no folder.
    let file = dir.path().join("a-file");
    fs::write(&file, "x").unwrap();
    assert!(project_root_in(&list(json!([entry("f", &file, json!({}))])), "f").is_none());
}

fn root_of(dir: &Path) -> Root {
    Root { dir: dir.to_path_buf(), real: fs::canonicalize(dir).unwrap() }
}

#[test]
fn reach_tells_inside_missing_and_outside_by_resolution_alone() {
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("proj");
    fs::create_dir_all(project.join("out")).unwrap();
    fs::write(project.join("out").join("plot.png"), "png").unwrap();
    fs::create_dir_all(project.join("sub")).unwrap();
    let root = root_of(&project);
    assert_eq!(reach(&root, "out/plot.png"), Reach::Inside);
    assert_eq!(reach(&root, "out"), Reach::Inside, "a folder exists; the open refuses it");
    assert_eq!(reach(&root, "out/later.png"), Reach::Missing);
    assert_eq!(reach(&root, "not/yet/there.png"), Reach::Missing);
    assert_eq!(reach(&root, "out/plot.png/below"), Reach::Missing, "under a file: nothing there");
}

#[cfg(unix)]
#[test]
fn a_link_leading_out_of_the_project_is_outside_and_a_link_within_is_not() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("proj");
    let outside = temp.path().join("outside");
    fs::create_dir_all(project.join("real")).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "s").unwrap();
    fs::write(project.join("real").join("a.txt"), "a").unwrap();
    symlink(outside.join("secret.txt"), project.join("leak.txt")).unwrap();
    symlink(&outside, project.join("leakdir")).unwrap();
    symlink(project.join("real").join("a.txt"), project.join("fine.txt")).unwrap();
    symlink(project.join("real"), project.join("finedir")).unwrap();
    symlink(outside.join("not-there"), project.join("dangling-out")).unwrap();
    symlink(project.join("real").join("not-yet"), project.join("dangling-in")).unwrap();
    symlink(project.join("loop-b"), project.join("loop-a")).unwrap();
    symlink(project.join("loop-a"), project.join("loop-b")).unwrap();
    let root = root_of(&project);
    assert_eq!(reach(&root, "leak.txt"), Reach::Outside);
    assert_eq!(reach(&root, "leakdir/secret.txt"), Reach::Outside);
    assert_eq!(reach(&root, "leakdir/not-there.txt"), Reach::Outside, "a missing file below an out-linking folder");
    assert_eq!(reach(&root, "leakdir/new/deeper.txt"), Reach::Outside);
    assert_eq!(reach(&root, "dangling-out"), Reach::Outside);
    assert_eq!(reach(&root, "loop-a"), Reach::Outside, "a link cycle resolves nowhere");
    assert_eq!(reach(&root, "fine.txt"), Reach::Inside);
    assert_eq!(reach(&root, "finedir/a.txt"), Reach::Inside);
    assert_eq!(reach(&root, "dangling-in"), Reach::Missing, "a link to a missing in-project target");
}

/// A scope `p` with one agent tab and a registry naming `project` as its folder.
struct Fixture {
    state: tempfile::TempDir,
    project: PathBuf,
    id: String,
}
impl Fixture {
    fn new() -> Self {
        let state = tempfile::tempdir().unwrap();
        let project = state.path().join("proj");
        fs::create_dir_all(project.join("out")).unwrap();
        let fixture = Self { project, id: String::new(), state };
        fixture.registry(json!({}));
        let path = session_file(fixture.state.path(), "p");
        let tab = serde_json::from_value(json!({"key":"mine","label":"mine","cmd":"claude","cwd":"w","kind":"agent"})).unwrap();
        let id = tab_id(&workspace::create_tab_in(&path, "p", tab, None).unwrap().tab).unwrap().to_string();
        Self { id, ..fixture }
    }
    fn registry(&self, extra: Value) {
        crate::storage::write_json(&self.state.path().join("projects.json"), &json!([entry("p", &self.project, extra)])).unwrap();
    }
    fn path(&self) -> PathBuf { session_file(self.state.path(), "p") }
    fn publish(&self, expected: u64, items: Vec<ResultItem>) -> u64 {
        meta::update_in(&self.path(), "p", &self.id, expected, 1_000, &Change::Results(items), || Ok(())).unwrap().meta.revision
    }
    fn open(&self, index: usize, revision: u64) -> ResultTarget { open_in(self.state.path(), "p", &self.id, index, revision) }
}

fn is_unavailable(t: &ResultTarget) -> bool { matches!(t, ResultTarget::Unavailable) }
fn is_refused(t: &ResultTarget) -> bool { matches!(t, ResultTarget::Refused) }

#[test]
fn a_click_opens_an_existing_file_and_a_missing_one_is_unavailable() {
    let f = Fixture::new();
    fs::write(f.project.join("out").join("plot.png"), "png").unwrap();
    let revision = f.publish(0, vec![item("Plot", "out/plot.png"), item("Later", "out/later.png"), item("Folder", "out")]);
    match f.open(0, revision) {
        ResultTarget::Open { entry, project_dir } => {
            assert_eq!(Path::new(&entry.path), f.project.join("out").join("plot.png"));
            assert_eq!(entry.name, "plot.png");
            assert!(!entry.is_dir);
            assert_eq!(Path::new(&project_dir), f.project);
        }
        other => panic!("{other:?}"),
    }
    assert!(is_unavailable(&f.open(1, revision)), "a missing file");
    assert!(is_unavailable(&f.open(2, revision)), "a folder is no result");
    assert!(is_unavailable(&f.open(3, revision)), "no such item");
    // The file appears afterwards: the same reference now opens (nothing was generated or remembered).
    fs::write(f.project.join("out").join("later.png"), "png").unwrap();
    assert!(matches!(f.open(1, revision), ResultTarget::Open { .. }));
}

#[test]
fn an_open_of_a_changed_list_or_an_unknown_tab_opens_nothing() {
    let f = Fixture::new();
    fs::write(f.project.join("a.png"), "png").unwrap();
    let first = f.publish(0, vec![item("A", "a.png")]);
    let second = f.publish(first, vec![item("B", "b.png"), item("A", "a.png")]);
    assert!(matches!(f.open(0, first), ResultTarget::Stale), "the window drew the earlier list");
    assert!(is_unavailable(&f.open(0, second)), "b.png is missing");
    assert!(matches!(f.open(1, second), ResultTarget::Open { .. }));
    assert!(is_unavailable(&open_in(f.state.path(), "p", "no-such-tab", 0, second)));
    assert!(is_unavailable(&open_in(f.state.path(), "other-scope", &f.id, 0, second)));
    // Cleared: nothing to open at all.
    let cleared = f.publish(second, vec![]);
    assert!(is_unavailable(&f.open(0, cleared)));
}

#[cfg(unix)]
#[test]
fn a_target_replaced_by_an_escaping_link_after_publish_is_refused_at_open() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.state.path().join("outside.txt");
    fs::write(&outside, "secret").unwrap();
    fs::write(f.project.join("report.txt"), "report").unwrap();
    fs::create_dir_all(f.project.join("gen")).unwrap();
    let revision = f.publish(0, vec![item("Report", "report.txt"), item("Generated", "gen/data.csv")]);
    assert!(matches!(f.open(0, revision), ResultTarget::Open { .. }));
    // Swap the file for a link out of the project.
    fs::remove_file(f.project.join("report.txt")).unwrap();
    symlink(&outside, f.project.join("report.txt")).unwrap();
    assert!(is_refused(&f.open(0, revision)));
    // The folder of a not-yet-existing file becomes a link out.
    fs::remove_dir(f.project.join("gen")).unwrap();
    symlink(f.state.path(), f.project.join("gen")).unwrap();
    assert!(is_refused(&f.open(1, revision)));
}

#[test]
fn a_stored_reference_that_no_longer_passes_the_checks_is_refused_at_open() {
    let f = Fixture::new();
    // A record a hand edit (or another build) wrote past the publish-time rules.
    let revision = f.publish(0, vec![item("Ok", "ok.png")]);
    workspace::edit_in(&f.path(), "p", |session| {
        // project-tree-read: ok — the state-dir session file, read/edited by scope id (never the project tree).
        let tab = session.tab_layout.iter_mut().find(|t| tab_id(t) == Some(f.id.as_str())).unwrap();
        tab.extra.get_mut("cockpitMeta").unwrap()["results"]["items"][0]["relativePath"] = json!("../outside.txt");
        Ok(())
    })
    .unwrap();
    assert!(is_refused(&f.open(0, revision)));
}

#[test]
fn a_project_that_stopped_being_local_opens_nothing() {
    let f = Fixture::new();
    fs::write(f.project.join("a.png"), "png").unwrap();
    let revision = f.publish(0, vec![item("A", "a.png")]);
    assert!(matches!(f.open(0, revision), ResultTarget::Open { .. }));
    f.registry(json!({"remote":{"host":"h.example","remote_path":"/srv/p"}}));
    assert!(is_unavailable(&f.open(0, revision)));
    f.registry(json!({"compute_hosts":[{"id":"w1","host":"gpu.example","remote_path":"/srv/p"}]}));
    assert!(is_unavailable(&f.open(0, revision)));
    f.registry(json!({}));
    assert!(matches!(f.open(0, revision), ResultTarget::Open { .. }));
    fs::remove_dir_all(&f.project).unwrap();
    assert!(is_unavailable(&f.open(0, revision)), "the folder is gone");
    fs::remove_file(f.state.path().join("projects.json")).unwrap();
    assert!(is_unavailable(&f.open(0, revision)), "no registry, no root");
}

#[test]
fn the_answer_is_plain_data_for_the_window() {
    let f = Fixture::new();
    fs::write(f.project.join("a.png"), "png").unwrap();
    let revision = f.publish(0, vec![item("A", "a.png"), item("B", "b.png")]);
    let open = serde_json::to_value(f.open(0, revision)).unwrap();
    assert_eq!(open["status"], "open");
    assert_eq!(open["entry"]["name"], "a.png");
    assert_eq!(open["entry"]["is_dir"], false);
    assert!(open["projectDir"].is_string());
    assert_eq!(serde_json::to_value(f.open(1, revision)).unwrap(), json!({"status":"unavailable"}));
    assert_eq!(serde_json::to_value(f.open(0, revision + 1)).unwrap(), json!({"status":"stale"}));
}
