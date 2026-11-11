//! The dev build's Todo view (`files/DevTodoView.tsx`): the checkout's
//! `todo/*.md` groups, listed with their open/done task counts, read whole, and
//! written back when a checkbox is clicked.
//!
//! Only a binary built from a checkout has one (`dev_build::SOURCE_ROOT`); a
//! release lists nothing and the view's button never shows.
//!
//! Agents edit these files all day, so a write is a compare-and-swap: it lands
//! only while the file still holds the text the view last read, and otherwise
//! hands back what is on disk now for the view to re-apply its click to. A
//! click never overwrites an edit it did not see.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::dev_build::SOURCE_ROOT;
use super::home_io::{HomeDir, HomeFile};

/// The most one `todo/*.md` is read as: the largest group file is ~100 KB, and
/// a checkout an agent can write must not hand the window a file of any size.
const GROUP_CAP: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoGroup {
    /// The file name inside `todo/`, which is also its id.
    pub name: String,
    /// The file's first heading, or the name without `.md` when it has none.
    pub title: String,
    pub open: usize,
    pub done: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WriteOutcome {
    Written,
    /// The file changed since the view read it; nothing was written.
    Changed { current: String },
}

fn todo_dir(root: &Path) -> PathBuf {
    root.join("todo")
}

/// A bare `*.md` name — the only thing a caller may name, so no path ever
/// leaves `todo/`.
fn group_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let valid = name.ends_with(".md")
        && name.len() > 3
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.');
    if !valid {
        return Err(format!("not a todo group: {name}"));
    }
    Ok(todo_dir(root).join(name))
}

/// A group file, opened the way the host opens a file an agent can write
/// (gap 90): no link at `todo/` or at the file, never blocking on a planted
/// FIFO, a regular file on the opened handle, and no more than [`GROUP_CAP`]
/// bytes. The handle comes back for its mode.
fn open_group(path: &Path) -> Result<fs::File, String> {
    HomeFile::open_below(path, 2)
        .and_then(|file| file.open_read())
        .ok_or_else(|| format!("cannot read {}", path.display()))
}

fn read_group(path: &Path) -> Result<(String, fs::File), String> {
    let file = open_group(path)?;
    let mut bytes = Vec::new();
    (&file).take(GROUP_CAP + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > GROUP_CAP {
        return Err(format!("{} is larger than {} MiB", path.display(), GROUP_CAP >> 20));
    }
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not UTF-8", path.display()))?;
    Ok((text, file))
}

/// Open and done task boxes (`- [ ]` / `- [x]`, unordered bullets only), skipping
/// fenced code — the same lines the markdown preview renders as checkboxes.
pub fn count_tasks(text: &str) -> (usize, usize) {
    let (mut open, mut done) = (0, 0);
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap_or('`');
            match fence {
                None => fence = Some(marker),
                Some(open_marker)
                    if open_marker == marker
                        && trimmed.trim_end().chars().all(|c| c == marker) =>
                {
                    fence = None
                }
                Some(_) => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(['-', '*', '+']) else {
            continue;
        };
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let rest = rest.trim_start();
        let mut chars = rest.chars();
        if chars.next() != Some('[') {
            continue;
        }
        let state = chars.next();
        if chars.next() != Some(']') || !chars.next().is_some_and(char::is_whitespace) {
            continue;
        }
        match state {
            Some(' ') => open += 1,
            Some('x' | 'X') => done += 1,
            _ => {}
        }
    }
    (open, done)
}

fn title_of(text: &str, name: &str) -> String {
    text.lines()
        .find_map(|line| {
            let heading = line.trim_start_matches('#');
            (heading.len() < line.len() && heading.starts_with(' '))
                .then(|| heading.trim().to_string())
        })
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| name.trim_end_matches(".md").to_string())
}

/// The groups in `root/todo`, `group-*` by name and anything else (`done.md`)
/// after them.
pub fn list_in(root: &Path) -> Result<Vec<TodoGroup>, String> {
    let dir = HomeDir::open_below(&todo_dir(root), 1).ok_or("the todo folder is missing or is a link")?;
    let mut groups: Vec<TodoGroup> = dir
        .names()
        .into_iter()
        .filter_map(|name| {
            let path = group_path(root, &name).ok()?;
            let (text, _) = read_group(&path).ok()?;
            let (open, done) = count_tasks(&text);
            Some(TodoGroup {
                title: title_of(&text, &name),
                name,
                open,
                done,
            })
        })
        .collect();
    groups.sort_by(|a, b| {
        (!a.name.starts_with("group-"), &a.name).cmp(&(!b.name.starts_with("group-"), &b.name))
    });
    Ok(groups)
}

pub fn read_in(root: &Path, name: &str) -> Result<String, String> {
    read_group(&group_path(root, name)?).map(|(text, _)| text)
}

/// Replace the group's text with `next` if it still reads `expected`. The new
/// text goes to a fresh sibling temp file first and is renamed over, so an
/// agent reading the file mid-write sees the old text or the new, never half.
pub fn write_in(root: &Path, name: &str, expected: &str, next: &str) -> Result<WriteOutcome, String> {
    let path = group_path(root, name)?;
    let (current, file) = read_group(&path)?;
    if current != expected {
        return Ok(WriteOutcome::Changed { current });
    }
    // A tracked repo file keeps the mode it has (the staging write is
    // owner-only otherwise).
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        file.metadata().map_err(|e| e.to_string())?.permissions().mode() & 0o7777
    };
    // Windows refuses to rename over a file that is still open: close it first.
    #[cfg(not(unix))]
    let mode = {
        drop(file);
        0o600
    };
    crate::storage::write_private_atomic_mode(&path, next.as_bytes(), mode)?;
    Ok(WriteOutcome::Written)
}

fn root() -> Option<&'static Path> {
    SOURCE_ROOT.map(Path::new)
}

/// `None` outside a dev build — the view's cue to show no button.
pub fn list() -> Option<Result<Vec<TodoGroup>, String>> {
    root().map(list_in)
}

pub fn read(name: &str) -> Result<String, String> {
    read_in(root().ok_or("not a dev build")?, name)
}

pub fn write(name: &str, expected: &str, next: &str) -> Result<WriteOutcome, String> {
    write_in(root().ok_or("not a dev build")?, name, expected, next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::SLUG;

    fn checkout(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("todo")).unwrap();
        for (name, text) in files {
            fs::write(dir.path().join("todo").join(name), text).unwrap();
        }
        dir
    }

    #[test]
    fn counts_task_boxes_outside_fences() {
        let text = "# G\n- [ ] a\n  - [x] b\n* [X] c\n+ [ ] d\n1. [ ] numbered\n-[ ] tight\n```\n- [ ] code\n```\n~~~\n- [x] code\n~~~\n- [ ]\n";
        assert_eq!(count_tasks(text), (2, 2));
    }

    #[test]
    fn lists_groups_before_the_rest_with_titles() {
        let dir = checkout(&[
            ("done.md", "# Done\n- [x] a\n"),
            ("group-b.md", "## Group B — Two\n- [ ] a\n- [x] b\n"),
            ("group-a.md", "no heading\n- [ ] a\n"),
            ("notes.txt", "- [ ] ignored\n"),
        ]);
        let groups = list_in(dir.path()).unwrap();
        let names: Vec<_> = groups.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["group-a.md", "group-b.md", "done.md"]);
        assert_eq!(groups[0].title, "group-a");
        assert_eq!(groups[1].title, "Group B — Two");
        assert_eq!((groups[1].open, groups[1].done), (1, 1));
    }

    #[test]
    fn names_never_leave_the_todo_dir() {
        let dir = checkout(&[("group-a.md", "x")]);
        for name in ["../AGENTS.md", "sub/x.md", ".hidden.md", "group-a.txt", ".md", "a b.md"] {
            assert!(read_in(dir.path(), name).is_err(), "{name}");
            assert!(write_in(dir.path(), name, "x", "y").is_err(), "{name}");
        }
        assert_eq!(read_in(dir.path(), "group-a.md").unwrap(), "x");
    }

    #[test]
    fn write_is_compare_and_swap() {
        let dir = checkout(&[("group-a.md", "- [ ] a\n")]);
        assert_eq!(
            write_in(dir.path(), "group-a.md", "- [ ] a\n", "- [x] a\n").unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(
            write_in(dir.path(), "group-a.md", "- [ ] a\n", "- [ ] b\n").unwrap(),
            WriteOutcome::Changed { current: "- [x] a\n".into() }
        );
        assert_eq!(read_in(dir.path(), "group-a.md").unwrap(), "- [x] a\n");
        let leftovers: Vec<_> = fs::read_dir(dir.path().join("todo")).unwrap().flatten().collect();
        assert_eq!(leftovers.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn write_keeps_the_tracked_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let dir = checkout(&[("group-a.md", "- [ ] a\n")]);
        let path = dir.path().join("todo").join("group-a.md");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        write_in(dir.path(), "group-a.md", "- [ ] a\n", "- [x] a\n").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o644);
    }

    /// Each write stages under a fresh name: an entry at one fixed staging
    /// name (a crashed write's, or a planted one) cannot block it.
    #[test]
    fn write_does_not_depend_on_a_fixed_staging_name() {
        let dir = checkout(&[("group-a.md", "- [ ] a\n")]);
        fs::create_dir(dir.path().join("todo").join(format!(".group-a.md.{SLUG}-tmp"))).unwrap();
        assert_eq!(
            write_in(dir.path(), "group-a.md", "- [ ] a\n", "- [x] a\n").unwrap(),
            WriteOutcome::Written
        );
        assert_eq!(read_in(dir.path(), "group-a.md").unwrap(), "- [x] a\n");
    }

    /// Gap 90: the checkout is writable by a fenced agent working on the app
    /// itself, so a planted link must not show another file's text and a
    /// planted FIFO must not park a worker.
    #[cfg(unix)]
    #[test]
    fn a_planted_link_or_fifo_is_never_read_listed_or_written_through() {
        let dir = checkout(&[("group-a.md", "# Real\n- [ ] a\n")]);
        let secret = dir.path().join("secret.txt");
        fs::write(&secret, "# Secret title\n- [ ] hidden\n").unwrap();
        let todo = dir.path().join("todo");
        std::os::unix::fs::symlink(&secret, todo.join("group-link.md")).unwrap();
        super::super::home_io::mkfifo(&todo.join("group-fifo.md"));
        let root = dir.path().to_path_buf();
        let listed = super::super::home_io::within_deadline({
            let root = root.clone();
            move || list_in(&root)
        })
        .unwrap();
        let names: Vec<_> = listed.iter().map(|g| g.name.as_str()).collect();
        assert_eq!(names, ["group-a.md"], "neither the link nor the FIFO is a group");
        for name in ["group-link.md", "group-fifo.md"] {
            let root = root.clone();
            let read = super::super::home_io::within_deadline(move || read_in(&root, name));
            assert!(read.is_err(), "{name} must not be read");
        }
        let root2 = root.clone();
        let write = super::super::home_io::within_deadline(move || write_in(&root2, "group-link.md", "# Secret title\n- [ ] hidden\n", "x"));
        assert!(write.is_err(), "a write never starts from a link's text");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "# Secret title\n- [ ] hidden\n", "and never lands in the link's target");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_todo_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::write(elsewhere.path().join("group-a.md"), "# Elsewhere\n- [ ] a\n").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), dir.path().join("todo")).unwrap();
        assert!(list_in(dir.path()).is_err());
        assert!(read_in(dir.path(), "group-a.md").is_err());
    }

    #[test]
    fn a_group_past_the_cap_is_refused_not_read() {
        let big = "x".repeat(GROUP_CAP as usize + 1);
        let dir = checkout(&[("group-a.md", big.as_str()), ("group-b.md", "- [ ] b\n")]);
        assert!(read_in(dir.path(), "group-a.md").unwrap_err().contains("larger"));
        assert!(write_in(dir.path(), "group-a.md", "x", "y").is_err());
        let names: Vec<_> = list_in(dir.path()).unwrap().into_iter().map(|g| g.name).collect();
        assert_eq!(names, ["group-b.md"]);
        let ok = "x".repeat(GROUP_CAP as usize);
        fs::write(dir.path().join("todo").join("group-a.md"), &ok).unwrap();
        assert_eq!(read_in(dir.path(), "group-a.md").unwrap().len(), ok.len());
    }
}
