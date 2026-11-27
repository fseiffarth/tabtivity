//! Copy a local file or folder into a remote project's host tree over SFTP: the
//! host twin of `commands::fs::import_external_file_blocking`, behind the file
//! tree's OS drop and "Send to project…" when the destination project's files
//! live on a host (a remote-only project, a VM).
//!
//! The source is local and may be a tree an agent wrote, so it is walked the
//! way `tree_copy` walks one: through `home_io` handles, never following a
//! link. Links (which would point at local paths on the host), pipes, sockets,
//! devices and names that are not UTF-8 are left out and counted. Entries,
//! bytes and depth carry `tree_copy`'s bounds. On the host side a collision
//! keeps both under " (n)" (the name `unique_name` picks, as the local import
//! does) unless `replace`, and a failed upload removes the copy it was making.
//! AppHandle-free; the walk and the naming are unit-tested.

use std::path::{Path, PathBuf};

use openssh_sftp_client::Sftp;

use crate::services::home_io::HomeDir;
use crate::services::home_io::HomeFile;
use crate::services::remote_sync::join_remote;
use crate::services::sftp::{self, SyncKind};
use crate::services::tree_copy::{MAX_BYTES, MAX_DEPTH, MAX_ENTRIES};

/// One thing to make on the host, as a `/`-joined path below the copied folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Item {
    Dir(String),
    File(String),
}

/// What a source holds, read once before anything is sent.
#[derive(Debug, Default)]
pub struct Plan {
    /// The source is a folder (`items` is its content, parents before children).
    pub is_dir: bool,
    pub items: Vec<Item>,
    /// Entries left out (links, special files, non-UTF-8 names, vanished ones).
    pub skipped: usize,
    entries: usize,
    bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct Limits {
    entries: usize,
    bytes: u64,
    depth: usize,
}

const LIMITS: Limits = Limits { entries: MAX_ENTRIES, bytes: MAX_BYTES, depth: MAX_DEPTH };

/// Read what `src` holds (blocking). The top-level source is taken as given (the
/// user picked it, as `tree_copy` does); everything below is looked at without
/// following a link.
pub fn plan_source(src: &Path) -> Result<Plan, String> {
    plan_with(src, LIMITS)
}

fn plan_with(src: &Path, limits: Limits) -> Result<Plan, String> {
    let meta = std::fs::metadata(src).map_err(|e| e.to_string())?;
    let mut plan = Plan { is_dir: meta.is_dir(), ..Plan::default() };
    if plan.is_dir {
        let root = HomeDir::open_below(src, 0).ok_or_else(|| "the source is not available".to_string())?;
        walk(&root, "", 0, limits, &mut plan)?;
    } else if !meta.is_file() {
        return Err("the source is not a regular file or folder".to_string());
    }
    Ok(plan)
}

fn walk(dir: &HomeDir, rel: &str, depth: usize, limits: Limits, plan: &mut Plan) -> Result<(), String> {
    if depth > limits.depth {
        return Err("too large to copy: the folders are nested too deeply".to_string());
    }
    let (names, odd) = dir.entry_names();
    for _ in 0..odd {
        count_entry(plan, limits)?;
        plan.skipped += 1;
    }
    for name in names {
        count_entry(plan, limits)?;
        let path = join(rel, &name);
        let Some(meta) = dir.file(&name).and_then(|f| f.lstat().ok()) else {
            plan.skipped += 1;
            continue;
        };
        if meta.is_symlink {
            plan.skipped += 1;
        } else if meta.is_dir {
            let Some(child) = dir.open_subdir(&name) else {
                plan.skipped += 1;
                continue;
            };
            plan.items.push(Item::Dir(path.clone()));
            walk(&child, &path, depth + 1, limits, plan)?;
        } else if meta.is_file {
            plan.bytes = plan.bytes.saturating_add(meta.len);
            if plan.bytes > limits.bytes {
                return Err("too large to copy: the copy is larger than the limit".to_string());
            }
            plan.items.push(Item::File(path));
        } else {
            plan.skipped += 1;
        }
    }
    Ok(())
}

fn count_entry(plan: &mut Plan, limits: Limits) -> Result<(), String> {
    plan.entries += 1;
    if plan.entries > limits.entries {
        return Err("too large to copy: the folder holds too many entries".to_string());
    }
    Ok(())
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// Open one source file for reading (blocking): `rel` below the source folder,
/// or the source itself when `None`. Every component is opened through a
/// directory handle without following a link, and only a regular file opens,
/// so an entry swapped for a link or a FIFO since the walk is `None` (skipped).
pub fn open_source_file(src: &Path, rel: Option<&str>) -> Option<std::fs::File> {
    let Some(rel) = rel else {
        return HomeFile::open_below(src, 1)?.open_read();
    };
    let parts: Vec<&str> = rel.split('/').collect();
    let (name, dirs) = parts.split_last()?;
    let mut dir = HomeDir::open_below(src, 0)?;
    for part in dirs {
        dir = dir.open_subdir(part)?;
    }
    dir.file(name)?.open_read()
}

/// The first of `name`, `stem (1).ext`, `stem (2).ext`, … that `taken` does not
/// claim; `name` itself when all 10 000 are taken. A leading-dot name with no
/// other dot (".gitignore") has no extension, so the suffix lands at the end.
/// The one naming rule for both imports (`commands::fs::unique_dest`).
pub fn unique_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(name) {
        return name.to_string();
    }
    let ext = Path::new(name).extension().and_then(|e| e.to_str());
    let stem = match ext {
        Some(e) => &name[..name.len() - e.len() - 1],
        None => name,
    };
    for n in 1..10_000 {
        let candidate = match ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        if !taken(&candidate) {
            return candidate;
        }
    }
    name.to_string()
}

/// Whether `path` exists on the host, for the collision prompt. `Err` when the
/// host could not be asked, never `false`. (A dangling link reads as absent
/// here; the upload's own lstat listing still keeps clear of its name.)
pub async fn exists_on(sftp: &Sftp, path: &str) -> Result<bool, String> {
    Ok(sftp::metadata_attrs_opt_on(sftp, path).await?.is_some())
}

/// Upload a planned source into `dest_dir` (an absolute, already-confined host
/// folder, created if missing) as `file_name`. Returns the name it landed under.
pub async fn upload_on(
    sftp: &Sftp,
    src: PathBuf,
    plan: &Plan,
    dest_dir: &str,
    file_name: &str,
    replace: bool,
) -> Result<String, String> {
    // What the folder already holds, lstat-typed, so a link is replaced as a
    // link and never emptied through.
    let existing = match sftp::is_dir_opt_on(sftp, dest_dir).await? {
        None => Vec::new(),
        Some(true) => sftp::list_dir_raw_on(sftp, dest_dir).await?,
        Some(false) => return Err(format!("'{dest_dir}' is not a folder")),
    };
    let name = if replace {
        file_name.to_string()
    } else {
        unique_name(file_name, |n| existing.iter().any(|e| e.name == n))
    };
    let dest = join_remote(dest_dir, &name);
    sftp::mkdir_on(sftp, dest_dir).await?;
    if replace {
        if let Some(old) = existing.iter().find(|e| e.name == name) {
            match old.kind {
                SyncKind::Dir => sftp::remove_dir_on(sftp, &dest).await?,
                _ => sftp::remove_file_on(sftp, &dest).await?,
            }
        }
    }
    match send(sftp, src, plan, &dest).await {
        Ok(skipped) => {
            if skipped > 0 {
                eprintln!("remote import: {skipped} item(s) not copied from the folder");
            }
            Ok(name)
        }
        Err(error) => {
            // The name was free (or just cleared) when this began: what is there is ours.
            let _ = if plan.is_dir {
                sftp::remove_dir_on(sftp, &dest).await
            } else {
                sftp::remove_file_on(sftp, &dest).await
            };
            Err(error)
        }
    }
}

/// Make the copy; returns how many entries were left out in all.
async fn send(sftp: &Sftp, src: PathBuf, plan: &Plan, dest: &str) -> Result<usize, String> {
    if !plan.is_dir {
        let file = open_blocking(src, None)
            .await?
            .ok_or_else(|| "the source is not available".to_string())?;
        sftp::upload_open_file_on(sftp, file, dest, MAX_BYTES).await?;
        return Ok(0);
    }
    sftp::mkdir_on(sftp, dest).await?;
    let mut skipped = plan.skipped;
    let mut written: u64 = 0;
    for item in &plan.items {
        match item {
            Item::Dir(rel) => sftp::mkdir_on(sftp, &join_remote(dest, rel)).await?,
            Item::File(rel) => {
                let Some(file) = open_blocking(src.clone(), Some(rel.clone())).await? else {
                    skipped += 1;
                    continue;
                };
                let room = MAX_BYTES.saturating_sub(written);
                written += sftp::upload_open_file_on(sftp, file, &join_remote(dest, rel), room).await?;
            }
        }
    }
    Ok(skipped)
}

async fn open_blocking(src: PathBuf, rel: Option<String>) -> Result<Option<tokio::fs::File>, String> {
    let file = app_core::rt::blocking("fs", move || open_source_file(&src, rel.as_deref())).await?;
    Ok(file.map(tokio::fs::File::from_std))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn names(plan: &Plan) -> Vec<Item> {
        plan.items.clone()
    }

    #[test]
    fn unique_name_suffixes_before_the_extension() {
        let taken = ["a.txt", "a (1).txt"];
        assert_eq!(unique_name("a.txt", |n| taken.contains(&n)), "a (2).txt");
        assert_eq!(unique_name("b.txt", |n| taken.contains(&n)), "b.txt");
        assert_eq!(unique_name(".gitignore", |n| n == ".gitignore"), ".gitignore (1)");
        assert_eq!(unique_name("data", |n| n == "data"), "data (1)");
    }

    #[test]
    fn a_file_source_plans_no_items() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        fs::write(&file, "hi").unwrap();
        let plan = plan_source(&file).unwrap();
        assert!(!plan.is_dir);
        assert!(plan.items.is_empty());
        let mut read = String::new();
        std::io::Read::read_to_string(&mut open_source_file(&file, None).unwrap(), &mut read).unwrap();
        assert_eq!(read, "hi");
    }

    #[test]
    fn a_folder_plans_parents_before_children() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("sub").join("x.txt"), "x").unwrap();
        let plan = plan_source(&src).unwrap();
        assert!(plan.is_dir);
        assert_eq!(names(&plan), vec![Item::Dir("sub".into()), Item::File("sub/x.txt".into())]);
        assert!(open_source_file(&src, Some("sub/x.txt")).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn links_inside_the_folder_are_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret");
        fs::create_dir(&secret).unwrap();
        fs::write(secret.join("key"), "k").unwrap();
        let src = dir.path().join("src");
        fs::create_dir(&src).unwrap();
        fs::write(src.join("ok.txt"), "ok").unwrap();
        std::os::unix::fs::symlink(&secret, src.join("dir-link")).unwrap();
        std::os::unix::fs::symlink(secret.join("key"), src.join("file-link")).unwrap();
        let plan = plan_source(&src).unwrap();
        assert_eq!(names(&plan), vec![Item::File("ok.txt".into())]);
        assert_eq!(plan.skipped, 2);
        // A name that became a link after the walk does not open either.
        assert!(open_source_file(&src, Some("file-link")).is_none());
        assert!(open_source_file(&src, Some("dir-link/key")).is_none());
    }

    #[test]
    fn the_bounds_refuse_an_oversized_folder() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        fs::create_dir_all(src.join("a").join("b")).unwrap();
        fs::write(src.join("big.bin"), vec![0u8; 64]).unwrap();
        let few = Limits { entries: 1, bytes: u64::MAX, depth: MAX_DEPTH };
        assert!(plan_with(&src, few).unwrap_err().contains("too many entries"));
        let small = Limits { entries: 100, bytes: 10, depth: MAX_DEPTH };
        assert!(plan_with(&src, small).unwrap_err().contains("larger than the limit"));
        let shallow = Limits { entries: 100, bytes: u64::MAX, depth: 0 };
        assert!(plan_with(&src, shallow).unwrap_err().contains("nested too deeply"));
    }
}
