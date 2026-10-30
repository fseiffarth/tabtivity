//! The host half of creating a **remote-only** project
//! (`docs/remote_only_projects_plan.md`, E6b): the scaffold a local project
//! gets on its own disk, written into the host tree over the pooled SFTP
//! session, then the host repo and its first commit.
//!
//! Called by `commands::projects::remote_project_init_host` after the
//! project's first connect, so a password-auth host works too. Every step is
//! idempotent, so a retry after a dropped connection is safe:
//! - a scaffold file is created **create-new** (`SSH_FXF_EXCL`, which also
//!   refuses a dangling link) and anything already at its name — a file, a
//!   folder, a link, dangling or not — is left alone, as the local
//!   `write_scaffold_file` does;
//! - `git init` only runs where no work tree is (`ssh_exec::remote_git_init`);
//! - the scaffold commit is made only on an unborn `HEAD` of a repo whose top
//!   level is the project root (never into an enclosing repo on the host), and
//!   it stages only the scaffold's own files, never `add -A` over whatever the
//!   host folder already held.
//!
//! The planner ([`plan_scaffold_writes`]) is pure over an `lstat` answer per
//! path, so the no-clobber decisions are unit-tested without a host.

use std::collections::HashMap;

use openssh_sftp_client::Sftp;

use crate::commands::projects::{
    CLAUDE_SETTINGS, GITIGNORE_DEFAULT, SCAFFOLD_COMMIT_IDENTITY, SCAFFOLD_COMMIT_MSG,
    SCAFFOLD_FILES,
};
use crate::services::remote::RemoteTarget;
use crate::services::remote_sync::join_remote;

/// The scaffold's settings folder and the file inside it.
const CLAUDE_DIR: &str = ".claude";
const CLAUDE_SETTINGS_FILE: &str = ".claude/settings.json";

/// What one `lstat` (never following a link) found at a scaffold path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Absent,
    /// A real folder.
    Dir,
    /// A regular file.
    File,
    /// Anything else: a link (dangling or not), a FIFO, a socket, a device.
    Other,
}

/// Which scaffold paths to create on the host, and which to leave alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldWritePlan {
    /// `.claude` is absent and is created first, as a folder.
    pub make_claude_dir: bool,
    /// Project-relative files to create, create-new, with their content.
    pub write: Vec<(String, &'static str)>,
    /// Project-relative scaffold paths left alone: something is already there,
    /// or `.claude` is not a real folder (its `settings.json` is then skipped
    /// rather than written through a link).
    pub kept: Vec<String>,
}

/// What [`write_scaffold`] did, and what the scaffold commit may stage.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScaffoldOutcome {
    pub written: Vec<String>,
    pub kept: Vec<String>,
    /// The scaffold paths that are regular files now — the ones just written
    /// and the ones that were already plain files — so a retry still commits a
    /// file an earlier, interrupted run wrote.
    pub committable: Vec<String>,
}

/// Every path [`plan_scaffold_writes`] asks about, in the order it uses them.
pub fn scaffold_paths(with_git: bool) -> Vec<&'static str> {
    let mut paths: Vec<&'static str> = SCAFFOLD_FILES.iter().map(|(name, _)| *name).collect();
    if with_git {
        paths.push(".gitignore");
    }
    paths.push(CLAUDE_DIR);
    paths.push(CLAUDE_SETTINGS_FILE);
    paths
}

/// The scaffold `scaffold_project` writes locally (the docs, `.gitignore` when
/// the project has git, `.claude/settings.json`), planned against what is
/// already on the host. Pure.
pub fn plan_scaffold_writes(with_git: bool, lstat: impl Fn(&str) -> Presence) -> ScaffoldWritePlan {
    let mut plan = ScaffoldWritePlan::default();
    let mut files: Vec<(&'static str, &'static str)> = SCAFFOLD_FILES.to_vec();
    if with_git {
        files.push((".gitignore", GITIGNORE_DEFAULT));
    }
    for (name, content) in files {
        match lstat(name) {
            Presence::Absent => plan.write.push((name.to_string(), content)),
            _ => plan.kept.push(name.to_string()),
        }
    }
    match lstat(CLAUDE_DIR) {
        Presence::Absent => {
            plan.make_claude_dir = true;
            plan.write.push((CLAUDE_SETTINGS_FILE.to_string(), CLAUDE_SETTINGS));
        }
        Presence::Dir if lstat(CLAUDE_SETTINGS_FILE) == Presence::Absent => {
            plan.write.push((CLAUDE_SETTINGS_FILE.to_string(), CLAUDE_SETTINGS));
        }
        _ => plan.kept.push(CLAUDE_SETTINGS_FILE.to_string()),
    }
    plan
}

/// The scaffold paths a commit may stage after `plan` ran: what it wrote, plus
/// what it kept that is a regular file (`lstat` as before the run). Pure.
pub fn committable_paths(plan: &ScaffoldWritePlan, written: &[String], lstat: impl Fn(&str) -> Presence) -> Vec<String> {
    let mut paths: Vec<String> = written.to_vec();
    for kept in &plan.kept {
        if lstat(kept) == Presence::File {
            paths.push(kept.clone());
        }
    }
    paths
}

/// `lstat` one host path over SFTP. A missing path is [`Presence::Absent`];
/// any other failure is an error ("could not check" is never "absent", so
/// nothing is written over a path that could not be looked at).
async fn lstat_on(sftp: &Sftp, path: &str) -> Result<Presence, String> {
    use openssh_sftp_client::error::{Error as SftpClientError, SftpErrorKind};
    let mut fs = sftp.fs();
    match fs.symlink_metadata(path).await {
        Ok(meta) => Ok(match meta.file_type() {
            Some(t) if t.is_dir() => Presence::Dir,
            Some(t) if t.is_file() => Presence::File,
            _ => Presence::Other,
        }),
        Err(SftpClientError::SftpError(SftpErrorKind::NoSuchFile, _)) => Ok(Presence::Absent),
        Err(e) => Err(format!("sftp stat of '{path}' failed: {e}")),
    }
}

/// Create `path` with `content` only if nothing is at its name. `Ok(false)`
/// when something appeared there first (SFTP v3 reports `EEXIST` as a generic
/// failure, so a failed exclusive open is told apart by looking again).
async fn create_new_on(sftp: &Sftp, path: &str, content: &str) -> Result<bool, String> {
    let opened = sftp.options().write(true).create_new(true).open(path).await;
    let mut file = match opened {
        Ok(file) => file,
        Err(e) => {
            return match lstat_on(sftp, path).await {
                Ok(Presence::Absent) | Err(_) => Err(format!("sftp create of '{path}' failed: {e}")),
                Ok(_) => Ok(false),
            };
        }
    };
    file.write_all(content.as_bytes())
        .await
        .map_err(|e| format!("sftp write of '{path}' failed: {e}"))?;
    file.close()
        .await
        .map_err(|e| format!("sftp close of '{path}' failed: {e}"))?;
    Ok(true)
}

/// Write the scaffold into the host folder `root` (which must already be a
/// folder) on an open session, never over anything already there.
pub async fn write_scaffold(sftp: &Sftp, root: &str, with_git: bool) -> Result<ScaffoldOutcome, String> {
    let mut fs = sftp.fs();
    let root_meta = fs
        .metadata(root)
        .await
        .map_err(|e| format!("sftp stat of the project folder failed: {e}"))?;
    if !root_meta.file_type().is_some_and(|t| t.is_dir()) {
        return Err(format!("'{root}' on the host is not a folder"));
    }
    let mut seen: HashMap<&'static str, Presence> = HashMap::new();
    for rel in scaffold_paths(with_git) {
        seen.insert(rel, lstat_on(sftp, &join_remote(root, rel)).await?);
    }
    let lstat = |rel: &str| seen.get(rel).copied().unwrap_or(Presence::Other);
    let plan = plan_scaffold_writes(with_git, lstat);

    let mut kept = plan.kept.clone();
    let mut written = Vec::new();
    let mut claude_ok = true;
    if plan.make_claude_dir {
        let dir = join_remote(root, CLAUDE_DIR);
        if let Err(e) = fs.create_dir(&dir).await {
            // Raced by something else at that name: a real folder is fine,
            // anything else leaves `settings.json` alone.
            match lstat_on(sftp, &dir).await? {
                Presence::Dir => {}
                Presence::Absent => return Err(format!("sftp mkdir of '{dir}' failed: {e}")),
                _ => claude_ok = false,
            }
        }
    }
    for (rel, content) in &plan.write {
        if rel == CLAUDE_SETTINGS_FILE && !claude_ok {
            kept.push(rel.clone());
            continue;
        }
        if create_new_on(sftp, &join_remote(root, rel), content).await? {
            written.push(rel.clone());
        } else {
            kept.push(rel.clone());
        }
    }
    let committable = committable_paths(&plan, &written, lstat);
    Ok(ScaffoldOutcome { written, kept, committable })
}

/// What [`init_host_repo`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RepoOutcome {
    /// The scaffold commit was made by this call.
    pub committed: bool,
}

/// `git init` on the host (only where no work tree is), then — on a fresh,
/// unborn repo whose top level is the project root — one scaffold commit of
/// `commit_paths` (project-relative; nothing staged when empty). Every git
/// call after the init goes through `git_hardened::run_git` (hardened args,
/// hooks off) and is bounded. `Err` only when the repo could not be made; the
/// commit is best-effort, as the local `git_scaffold_commit` is. Blocking.
pub fn init_host_repo(target: &RemoteTarget, commit_paths: &[String]) -> Result<RepoOutcome, String> {
    crate::services::ssh_exec::remote_git_init(&target.spec)?;
    let mut outcome = RepoOutcome { committed: false };
    if commit_paths.is_empty() {
        return Ok(outcome);
    }
    let git = |args: &[&str]| crate::services::git_hardened::run_git(Some(target), "", args);
    // The project root must be the repo's own top level: `remote_git_init`
    // leaves a folder inside an enclosing repo alone, and a commit there would
    // land in that other repository.
    let at_top = git(&["rev-parse", "--show-prefix"])
        .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).trim().is_empty());
    let unborn = git(&["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok_and(|o| !o.status.success());
    if !(at_top && unborn) {
        return Ok(outcome);
    }
    let mut add = vec!["add", "--"];
    add.extend(commit_paths.iter().map(String::as_str));
    let _ = git(&add);
    let ok = |args: &[&str]| git(args).is_ok_and(|o| o.status.success());
    outcome.committed = ok(&["commit", "-m", SCAFFOLD_COMMIT_MSG]) || {
        let mut args = SCAFFOLD_COMMIT_IDENTITY.to_vec();
        args.extend(["commit", "-m", SCAFFOLD_COMMIT_MSG]);
        ok(&args)
    };
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn presence<'a>(map: &'a [(&'a str, Presence)]) -> impl Fn(&str) -> Presence + 'a {
        move |rel| map.iter().find(|(p, _)| *p == rel).map(|(_, v)| *v).unwrap_or(Presence::Absent)
    }

    fn written(plan: &ScaffoldWritePlan) -> Vec<&str> {
        plan.write.iter().map(|(p, _)| p.as_str()).collect()
    }

    /// An empty host folder gets the whole local scaffold: every doc, the
    /// `.gitignore` when the project has git, `.claude/settings.json` after
    /// its folder — the same set `scaffold_project` writes.
    #[test]
    fn an_empty_host_folder_gets_the_whole_scaffold() {
        let plan = plan_scaffold_writes(true, presence(&[]));
        assert!(plan.make_claude_dir);
        assert!(plan.kept.is_empty());
        let mut expected: Vec<&str> = SCAFFOLD_FILES.iter().map(|(n, _)| *n).collect();
        expected.extend([".gitignore", ".claude/settings.json"]);
        assert_eq!(written(&plan), expected);
        let gitignore = plan.write.iter().find(|(p, _)| p == ".gitignore").unwrap();
        assert_eq!(gitignore.1, GITIGNORE_DEFAULT);

        let no_git = plan_scaffold_writes(false, presence(&[]));
        assert!(!written(&no_git).contains(&".gitignore"), "no .gitignore without git");
        assert!(!scaffold_paths(false).contains(&".gitignore"));
    }

    /// Anything already at a scaffold name — a file, a folder, a link (dangling
    /// or not), a FIFO — is left alone, and a `.claude` that is not a real
    /// folder never has `settings.json` written through it.
    #[test]
    fn nothing_already_on_the_host_is_overwritten() {
        for found in [Presence::File, Presence::Dir, Presence::Other] {
            let plan = plan_scaffold_writes(true, presence(&[("CLAUDE.md", found), (".gitignore", found)]));
            assert!(!written(&plan).contains(&"CLAUDE.md"), "{found:?}");
            assert!(!written(&plan).contains(&".gitignore"), "{found:?}");
            assert!(plan.kept.contains(&"CLAUDE.md".to_string()));
            assert!(written(&plan).contains(&"README.md"), "the rest is still written");
        }
        for claude in [Presence::File, Presence::Other] {
            let plan = plan_scaffold_writes(true, presence(&[(".claude", claude)]));
            assert!(!plan.make_claude_dir, "{claude:?}");
            assert!(!written(&plan).contains(&".claude/settings.json"), "{claude:?}");
            assert!(plan.kept.contains(&".claude/settings.json".to_string()));
        }
        let real_dir = plan_scaffold_writes(true, presence(&[(".claude", Presence::Dir)]));
        assert!(!real_dir.make_claude_dir);
        assert!(written(&real_dir).contains(&".claude/settings.json"));
        let has_settings = plan_scaffold_writes(
            true,
            presence(&[(".claude", Presence::Dir), (".claude/settings.json", Presence::Other)]),
        );
        assert!(!written(&has_settings).contains(&".claude/settings.json"));
    }

    /// A rerun over a finished scaffold writes nothing (the command is safe to
    /// retry), and still commits the plain files an interrupted run left.
    #[test]
    fn a_rerun_writes_nothing_and_still_commits_the_scaffold() {
        let mut done: Vec<(&str, Presence)> = scaffold_paths(true).into_iter().map(|p| (p, Presence::File)).collect();
        done.retain(|(p, _)| *p != ".claude");
        done.push((".claude", Presence::Dir));
        let lstat = presence(&done);
        let plan = plan_scaffold_writes(true, &lstat);
        assert!(plan.write.is_empty() && !plan.make_claude_dir, "{plan:?}");
        let commit = committable_paths(&plan, &[], &lstat);
        assert!(commit.contains(&"PROJECT.md".to_string()));
        assert!(commit.contains(&".claude/settings.json".to_string()));
        assert!(!commit.contains(&".claude".to_string()), "a folder is never staged by name");

        // Something that is not a plain file at a scaffold name is never staged.
        let lstat = presence(&[("AGENTS.md", Presence::Other), ("TODO.md", Presence::Dir)]);
        let plan = plan_scaffold_writes(true, &lstat);
        let fresh: Vec<String> = plan.write.iter().map(|(p, _)| p.clone()).collect();
        let commit = committable_paths(&plan, &fresh, &lstat);
        assert!(!commit.contains(&"AGENTS.md".to_string()));
        assert!(!commit.contains(&"TODO.md".to_string()));
        assert!(commit.contains(&"README.md".to_string()));
    }
}
