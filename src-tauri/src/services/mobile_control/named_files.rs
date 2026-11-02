//! The files an agent tab's chat names, for the phone —
//! `GET /api/v1/tabs/{id}/named-files`: the desktop Chat's path links
//! (`commands::fs::resolve_text_paths`), answered as the 📁 library's sealed
//! rows, so the phone draws a picture or PDF the agent named and opens it.
//!
//! The paths come from the phone, which picked the path-shaped words out of
//! answers it was already sent (`lib/terminal/pathCandidates`). They are the
//! agent's words, so whatever the project fed it: a path counts only if it
//! lies inside the tab's folder or the project once links are resolved, and
//! only a file the library would list crosses (the route's `file_row`, which
//! proves that again). Nothing crosses as a host path: an answer carries the
//! words asked about and the row, whose place is project-relative. A file the
//! library does not list — in a linked worktree, a box's — is left out, as in
//! the Diffs view.

use std::path::Path;

use serde::Serialize;

use super::chat_uncommitted::relative_to;
use super::protocol::MobileMarkupFile;
use crate::commands::fs::resolve_text_paths_blocking;

/// Paths one request looks at, a batch of the phone's: each is a canonicalize
/// and a stat.
pub const MAX_PATHS: usize = 64;

/// A path the phone asked about that names a file the library lists.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NamedFile {
    /// The words asked about, unchanged: the phone keys its answer by them.
    pub path: String,
    pub file: MobileMarkupFile,
}

/// `paths` (newline-separated, as the route's query carries them), at most
/// `MAX_PATHS`.
pub fn asked_paths(paths: &str) -> Vec<String> {
    paths.split('\n').filter(|path| !path.is_empty()).take(MAX_PATHS).map(str::to_string).collect()
}

/// The files among `paths`, looked up under the tab's folder `cwd` and then
/// the project folder `root`, as `row` answers for a path relative to `root`.
/// Blocking.
pub fn resolve(root: &Path, cwd: &str, paths: Vec<String>, mut row: impl FnMut(&str) -> Option<MobileMarkupFile>) -> Vec<NamedFile> {
    let mut bases = vec![cwd.to_string(), root.to_string_lossy().into_owned()];
    bases.dedup();
    let found = resolve_text_paths_blocking(bases, paths.clone());
    paths
        .into_iter()
        .zip(found)
        .filter_map(|(path, entry)| {
            let entry = entry.filter(|entry| !entry.is_dir)?;
            let relative = relative_to(root, Path::new(&entry.path))?;
            Some(NamedFile { file: row(&relative)?, path })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn row(relative: &str) -> Option<MobileMarkupFile> {
        Some(MobileMarkupFile {
            token: format!("sealed:{relative}"),
            name: relative.rsplit('/').next().unwrap_or(relative).to_string(),
            kind: "application/pdf".to_string(),
            size: 1,
            modified: 1,
            folder: None,
            place: String::new(),
        })
    }

    fn tokens(answer: &[NamedFile]) -> Vec<(&str, &str)> {
        answer.iter().map(|named| (named.path.as_str(), named.file.token.as_str())).collect()
    }

    fn asked(paths: &[&str]) -> Vec<String> {
        paths.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn a_path_is_answered_project_relative_under_the_words_asked_about() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("figs")).unwrap();
        fs::write(root.join("figs").join("plot.pdf"), "x").unwrap();
        let absolute = root.join("figs").join("plot.pdf").to_string_lossy().into_owned();
        let cwd = root.to_string_lossy().into_owned();

        let answer = resolve(root, &cwd, asked(&["figs/plot.pdf", absolute.as_str(), "missing.pdf"]), row);

        assert_eq!(tokens(&answer), vec![("figs/plot.pdf", "sealed:figs/plot.pdf"), (absolute.as_str(), "sealed:figs/plot.pdf")]);
    }

    #[test]
    fn a_path_is_tried_under_the_tabs_folder_before_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("paper")).unwrap();
        fs::write(root.join("paper").join("main.pdf"), "x").unwrap();
        fs::write(root.join("top.pdf"), "x").unwrap();
        let cwd = root.join("paper").to_string_lossy().into_owned();

        let answer = resolve(root, &cwd, asked(&["main.pdf", "top.pdf"]), row);

        assert_eq!(tokens(&answer), vec![("main.pdf", "sealed:paper/main.pdf"), ("top.pdf", "sealed:top.pdf")]);
    }

    #[test]
    fn nothing_outside_the_project_a_folder_or_a_file_without_a_row_is_answered() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::write(dir.path().join("secret.pdf"), "x").unwrap();
        fs::write(root.join("hidden.pdf"), "x").unwrap();
        let outside = dir.path().join("secret.pdf").to_string_lossy().into_owned();
        let cwd = root.to_string_lossy().into_owned();

        let answer = resolve(&root, &cwd, asked(&["../secret.pdf", outside.as_str(), "docs", "hidden.pdf"]), |relative| {
            (relative != "hidden.pdf").then(|| row(relative)).flatten()
        });

        assert!(answer.is_empty(), "{answer:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_link_out_of_the_project_is_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        fs::create_dir_all(&root).unwrap();
        fs::write(dir.path().join("secret.pdf"), "x").unwrap();
        std::os::unix::fs::symlink(dir.path().join("secret.pdf"), root.join("link.pdf")).unwrap();
        let cwd = root.to_string_lossy().into_owned();

        assert!(resolve(&root, &cwd, asked(&["link.pdf"]), row).is_empty());
    }

    #[test]
    fn the_query_is_split_on_lines_and_bounded() {
        assert_eq!(asked_paths("a.pdf\n\nb c.png\n"), vec!["a.pdf".to_string(), "b c.png".to_string()]);
        let many = vec!["a.pdf"; MAX_PATHS + 5].join("\n");
        assert_eq!(asked_paths(&many).len(), MAX_PATHS);
    }
}
