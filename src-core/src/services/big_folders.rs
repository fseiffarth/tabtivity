//! Finding the folders that are too big to sync, on **both** sides of a remote
//! project — and doing it *before* the first sync pass rather than after it.
//!
//! Byte-sync's scope is an explicit opt-in manifest and it does **not** read
//! `.gitignore` (`commands::sync::sync_auto_preview` says the same thing one
//! folder at a time). The moment that costs the most is the one where the user
//! has the least information: a project just created, imported, or extended to a
//! host, where a single `node_modules/`, `data/`, `checkpoints/` or `.venv/`
//! decides whether the first pass moves a few MB or a few hundred thousand
//! files. So this module answers one question — *which folders are giant?* — for
//! the local mirror and the host tree alike, and the caller turns the answer into
//! one prompt with one checkbox per folder.
//!
//! The two sides are measured differently but reduced to the SAME shape: a flat
//! list of `(project-relative path, bytes)` per regular file. Everything after
//! that ([`tally_dirs`] + [`pick`]) is pure, side-agnostic and unit-tested, which
//! is what keeps "local says 12 GB, host says 40" from being two heuristics that
//! disagree for reasons nobody can reconstruct.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A folder is worth asking about at this many files, whatever its size: file
/// *count* — not bytes — is what makes a sync pass take minutes and what makes
/// the manifest enormous (`node_modules` is the canonical case: small, endless).
pub const MIN_FILES: u64 = 2_000;

/// …or at this many bytes, however few files (a checkpoint dir is the mirror
/// image: a handful of files, tens of GB).
pub const MIN_BYTES: u64 = 512 * 1024 * 1024;

/// How deep the prompt is willing to point. Past this we name the ancestor and
/// let the user carve inside it from the file tree's own auto-sync menu.
pub const MAX_DEPTH: usize = 4;

/// Descend into a single heavy child instead of reporting its parent when the
/// child accounts for at least this share of it — the difference between saying
/// "exclude `data/`" (which also drops the two scripts beside it) and "exclude
/// `data/raw/`", which is what the user actually meant.
const DOMINANT_SHARE: f64 = 0.8;

/// Stop walking a tree after this many files. A cap, not a sample: the counts
/// stay honest up to it, and a tree that hits it is *by definition* one worth
/// warning about — the numbers only get bigger.
pub const MAX_ENTRIES: usize = 400_000;

/// Cumulative (subtree) totals for one directory.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FolderTally {
    pub files: u64,
    pub bytes: u64,
}

/// One folder the user should be asked about, with the totals behind the ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BigFolder {
    /// Project-relative path, forward slashes, no leading/trailing slash.
    pub rel: String,
    pub files: u64,
    pub bytes: u64,
}

/// Fold a flat file list into cumulative per-directory totals: every ancestor of
/// a file is credited with it, so a parent's totals always contain its children's
/// (which is what lets [`pick`] prune whole subtrees by testing the parent alone).
pub fn tally_dirs(files: &[(String, u64)]) -> HashMap<String, FolderTally> {
    let mut out: HashMap<String, FolderTally> = HashMap::new();
    for (rel, size) in files {
        let mut cur = rel.as_str();
        while let Some(idx) = cur.rfind('/') {
            cur = &cur[..idx];
            let e = out.entry(cur.to_string()).or_default();
            e.files += 1;
            e.bytes += size;
        }
    }
    out
}

fn depth_of(rel: &str) -> usize {
    if rel.is_empty() {
        0
    } else {
        rel.matches('/').count() + 1
    }
}

fn children_of<'a>(tallies: &'a HashMap<String, FolderTally>, parent: &str) -> Vec<&'a str> {
    let want = depth_of(parent) + 1;
    tallies
        .keys()
        .filter(|k| depth_of(k) == want && parent_of(k) == parent)
        .map(|k| k.as_str())
        .collect()
}

fn parent_of(rel: &str) -> &str {
    match rel.rfind('/') {
        Some(idx) => &rel[..idx],
        None => "",
    }
}

/// Pick the folders worth prompting about: the **shallowest** directories that
/// cross either threshold, except that a directory whose weight is concentrated
/// in one child is skipped in favour of that child (recursively, to `max_depth`).
/// Sorted heaviest-first so the prompt leads with the decision that matters.
///
/// Never returns nested pairs — excluding a reported folder always excludes
/// everything it reports, so no checkbox in the prompt can shadow another.
pub fn pick(
    tallies: &HashMap<String, FolderTally>,
    min_files: u64,
    min_bytes: u64,
    max_depth: usize,
) -> Vec<BigFolder> {
    let mut out = Vec::new();
    let mut queue: Vec<String> = children_of(tallies, "")
        .iter()
        .map(|s| s.to_string())
        .collect();
    while let Some(rel) = queue.pop() {
        let Some(t) = tallies.get(&rel).copied() else {
            continue;
        };
        if t.files < min_files && t.bytes < min_bytes {
            // Totals are cumulative, so a folder under both thresholds cannot
            // contain one over them — the whole subtree is done.
            continue;
        }
        let kids = children_of(tallies, &rel);
        // Descend only into a child that *explains* the parent: it must still cross
        // a threshold on its own, and carry the bulk of whichever metric put the
        // parent over one. (A parent flagged for its 40 GB isn't made more precise
        // by a child holding 90% of its *file count* but none of the bytes.)
        let by_files = t.files >= min_files;
        let by_bytes = t.bytes >= min_bytes;
        let dominant = (depth_of(&rel) < max_depth)
            .then(|| {
                kids.iter().find(|k| {
                    let kt = tallies.get(**k).copied().unwrap_or_default();
                    (kt.files >= min_files || kt.bytes >= min_bytes)
                        && (!by_files || kt.files as f64 >= t.files as f64 * DOMINANT_SHARE)
                        && (!by_bytes || kt.bytes as f64 >= t.bytes as f64 * DOMINANT_SHARE)
                })
            })
            .flatten();
        match dominant {
            Some(child) => queue.push(child.to_string()),
            None => out.push(BigFolder {
                rel,
                files: t.files,
                bytes: t.bytes,
            }),
        }
    }
    out.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| b.files.cmp(&a.files)));
    out
}

// ── Local side ──────────────────────────────────────────────────────────────

/// Walk `root` and return every regular file as `(project-relative path, bytes)`.
///
/// Symlinks are never followed (the host walk in `remote_sync` makes the same
/// promise, for the same reason: a `link -> /` must not be measured as project
/// data), and `.git`/`.tabtivity` are skipped — git's bytes are lockstep's business
/// and Tabtivity's runtime dir is nobody's. Stops at [`MAX_ENTRIES`].
pub fn walk_local_files(root: &Path) -> Vec<(String, u64)> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, String)> = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, rel)) = stack.pop() {
        if out.len() >= MAX_ENTRIES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == ".git" || crate::brand::is_project_dir(&name) {
                continue;
            }
            let child_rel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            // `symlink_metadata`: a symlink is neither walked nor billed.
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push((entry.path(), child_rel));
            } else if meta.is_file() {
                out.push((child_rel, meta.len()));
                if out.len() >= MAX_ENTRIES {
                    break;
                }
            }
        }
    }
    out
}

// ── Host side ───────────────────────────────────────────────────────────────

/// Parse `du -ak <root>` output into the same `(project-relative path, bytes)`
/// list the local walk produces.
///
/// `du -a` prints every file *and* every directory, so directory-ness is derived
/// from the listing itself — a path is a directory exactly when another path is
/// beneath it — rather than from a second round trip. Sizes are `du`'s 1 KiB
/// blocks (allocated, not apparent): a rounding we accept, because a threshold
/// prompt asks "is this folder huge", not "how huge to the byte".
pub fn parse_du_files(root: &str, out: &str) -> Vec<(String, u64)> {
    let root = root.trim_end_matches('/');
    let mut rows: Vec<(String, u64)> = Vec::new();
    for line in out.lines().take(MAX_ENTRIES) {
        let mut parts = line.splitn(2, '\t');
        let (Some(kb), Some(path)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(kb) = kb.trim().parse::<u64>() else {
            continue;
        };
        let path = path.trim_end_matches('/');
        let rel = if path == root {
            String::new()
        } else if let Some(stripped) = path.strip_prefix(root).and_then(|p| p.strip_prefix('/')) {
            stripped.to_string()
        } else {
            continue;
        };
        if rel.is_empty()
            || rel == ".git"
            || rel.starts_with(".git/")
            || rel.split('/').next().is_some_and(crate::brand::is_project_dir)
        {
            continue;
        }
        rows.push((rel, kb.saturating_mul(1024)));
    }
    // A path with anything beneath it is a directory; only the leaves are files.
    let dirs: std::collections::HashSet<String> = rows
        .iter()
        .map(|(rel, _)| parent_of(rel).to_string())
        .collect();
    rows.into_iter()
        .filter(|(rel, _)| !dirs.contains(rel))
        .collect()
}

/// The whole local-side answer: walk the mirror, tally, pick.
pub fn scan_local(root: &Path) -> Vec<BigFolder> {
    let files = walk_local_files(root);
    pick(&tally_dirs(&files), MIN_FILES, MIN_BYTES, MAX_DEPTH)
}

/// The whole host-side answer, given a `du -ak` capture from the host.
pub fn scan_host(remote_root: &str, du_output: &str) -> Vec<BigFolder> {
    let files = parse_du_files(remote_root, du_output);
    pick(&tally_dirs(&files), MIN_FILES, MIN_BYTES, MAX_DEPTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(specs: &[(&str, u64)]) -> Vec<(String, u64)> {
        specs.iter().map(|(p, s)| (p.to_string(), *s)).collect()
    }

    #[test]
    fn tallies_are_cumulative_over_every_ancestor() {
        let t = tally_dirs(&files(&[("a/b/c.txt", 10), ("a/d.txt", 5)]));
        assert_eq!(
            t["a"],
            FolderTally {
                files: 2,
                bytes: 15
            }
        );
        assert_eq!(
            t["a/b"],
            FolderTally {
                files: 1,
                bytes: 10
            }
        );
        assert!(!t.contains_key(""), "the project root is never a candidate");
    }

    #[test]
    fn small_folders_are_never_offered() {
        let t = tally_dirs(&files(&[("src/a.rs", 100), ("src/b.rs", 100)]));
        assert!(pick(&t, MIN_FILES, MIN_BYTES, MAX_DEPTH).is_empty());
    }

    #[test]
    fn many_small_files_qualify_on_count_alone() {
        let specs: Vec<(String, u64)> = (0..MIN_FILES)
            .map(|i| (format!("node_modules/p{i}/index.js"), 10))
            .collect();
        let got = pick(&tally_dirs(&specs), MIN_FILES, MIN_BYTES, MAX_DEPTH);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].rel, "node_modules");
        assert_eq!(got[0].files, MIN_FILES);
    }

    #[test]
    fn a_few_huge_files_qualify_on_bytes_alone() {
        let got = pick(
            &tally_dirs(&files(&[("ckpt/a.bin", MIN_BYTES), ("ckpt/b.bin", 1)])),
            MIN_FILES,
            MIN_BYTES,
            MAX_DEPTH,
        );
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].rel, "ckpt");
    }

    #[test]
    fn descends_into_a_dominant_child_but_not_a_split_parent() {
        // `data` is heavy only because `data/raw` is: point at `data/raw`.
        let dominant = tally_dirs(&files(&[
            ("data/raw/big.bin", MIN_BYTES),
            ("data/notes.md", 10),
        ]));
        assert_eq!(
            pick(&dominant, MIN_FILES, MIN_BYTES, MAX_DEPTH)[0].rel,
            "data/raw"
        );

        // Two comparable children: naming either would understate the ask.
        let split = tally_dirs(&files(&[
            ("data/a/big.bin", MIN_BYTES),
            ("data/b/big.bin", MIN_BYTES),
        ]));
        assert_eq!(pick(&split, MIN_FILES, MIN_BYTES, MAX_DEPTH)[0].rel, "data");
    }

    #[test]
    fn results_never_nest() {
        let t = tally_dirs(&files(&[
            ("data/a/big.bin", MIN_BYTES),
            ("data/b/big.bin", MIN_BYTES),
        ]));
        let got = pick(&t, MIN_FILES, MIN_BYTES, MAX_DEPTH);
        for a in &got {
            for b in &got {
                assert!(
                    a.rel == b.rel || !b.rel.starts_with(&format!("{}/", a.rel)),
                    "{} shadows {}",
                    a.rel,
                    b.rel
                );
            }
        }
    }

    #[test]
    fn du_output_becomes_leaf_files_only() {
        let out = "4\t/srv/proj/data\n2048\t/srv/proj/data/big.bin\n8\t/srv/proj/data/small\n\
                   4\t/srv/proj/data/small/x.txt\n12\t/srv/proj\n";
        let got = parse_du_files("/srv/proj", out);
        assert_eq!(
            got,
            vec![
                ("data/big.bin".to_string(), 2048 * 1024),
                ("data/small/x.txt".to_string(), 4 * 1024),
            ]
        );
    }

    #[test]
    fn du_output_skips_git_and_foreign_paths() {
        let out = "4\t/srv/proj/.git/objects/aa\n4\t/elsewhere/x\n4\t/srv/proj/keep.txt\n";
        assert_eq!(
            parse_du_files("/srv/proj", out),
            vec![("keep.txt".to_string(), 4096)]
        );
    }
}
