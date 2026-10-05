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

use crate::brand::SLUG;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::dev_build::SOURCE_ROOT;

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
    let entries = fs::read_dir(todo_dir(root)).map_err(|e| e.to_string())?;
    let mut groups: Vec<TodoGroup> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = group_path(root, &name).ok()?;
            let text = fs::read_to_string(path).ok()?;
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
    fs::read_to_string(group_path(root, name)?).map_err(|e| e.to_string())
}

/// Replace the group's text with `next` if it still reads `expected`. The new
/// text goes to a sibling temp file first and is renamed over, so an agent
/// reading the file mid-write sees the old text or the new, never half.
pub fn write_in(root: &Path, name: &str, expected: &str, next: &str) -> Result<WriteOutcome, String> {
    let path = group_path(root, name)?;
    let current = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if current != expected {
        return Ok(WriteOutcome::Changed { current });
    }
    let tmp = path.with_file_name(format!(".{name}.{SLUG}-tmp"));
    fs::write(&tmp, next).map_err(|e| e.to_string())?;
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(e.to_string());
    }
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
}
