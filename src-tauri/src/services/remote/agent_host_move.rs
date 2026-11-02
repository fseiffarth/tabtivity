//! Taking a remote project's agent tab's conversation along when the tab
//! changes where it runs — this machine (the project's mirror) to one of the
//! project's hosts, back, or from one host to another (the tab bar's locality
//! menu, `stores/agents/agentLocationSwitch.ts`). The window stops the tab's
//! CLI, this copies what the CLI needs to find the conversation on the other
//! side, and the window respawns the tab there on its resume args.
//!
//! Only Claude is carried: its conversation is `<id>.jsonl` (with its
//! subagents and tool results in `<id>/` beside it) under
//! `~/.claude/projects/<slug of the folder it runs in>/`, and both sides
//! already resume a tab by that id — `services::agent_session` here (the
//! hook-recorded live id, else the launch id) and `ssh_exec`'s
//! `host_side_resume` on a host (the id the local resolve chose, when a
//! transcript of it is on the host). So the move is a copy into the slug folder
//! of the folder the tab runs in on the other side: the scope's agent home and
//! the mirror here, the login's home and the host's `remote_path` there. The
//! other CLIs start a new conversation on the other side ([`Moved::Fresh`]),
//! as a switch always did.
//!
//! A copy, not a move: a later respawn on the host still resumes by the id the
//! *local* resolve picks, which needs the local transcript to stay. The copy
//! left behind is brought up to date by the next move back: a transcript only
//! grows, so a stale copy is a prefix of the new one and is replaced; one that
//! is not (a conversation that went on there meanwhile) is moved aside to
//! `<id>.jsonl.replaced`, never lost.
//!
//! Which conversation: here the hook's live id (it follows a `/clear`) and the
//! launch id; on a host the running CLI is asked first
//! (`remote_transcript::running_session`, so the tab's tmux session there is
//! ended only after that), else the newest transcript of those two ids. When
//! the tab lands here, its live record is pointed at the conversation brought
//! back, so the local resolve resumes it and not the stale copy.
//!
//! Local reads and writes go through `home_io` handles: the home is the
//! agent's to write. Host paths are relative to the login's home, the names in
//! them uuid-shaped ids or single components the host listed.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use openssh_sftp_client::Sftp;

use crate::services::agent_history::claude_folder_name;
use crate::services::agent_relocate::Moved;
use crate::services::agent_session::is_uuid_shaped;
use crate::services::home_io::HomeDir;
use crate::services::remote::RemotePoolState;
use crate::services::sftp::SyncKind;

/// Where Claude files its conversations, relative to a home.
const PROJECTS: &str = ".claude/projects";
/// The largest transcript (and the largest file of its folder) taken along.
const MAX_BYTES: u64 = 256 * 1024 * 1024;
/// The most files of a session's own folder taken along.
const MAX_SIDE_FILES: usize = 4000;
/// How deep a session's own folder is walked (`subagents/`, `tool-results/`).
const MAX_DEPTH: usize = 4;
/// The most slug folders searched for a transcript filed under another folder.
const MAX_SEARCHED_DIRS: usize = 400;
/// What a destination transcript that is not a prefix of the one brought over
/// is renamed to (plus `.1`, `.2`, … when taken).
const ASIDE: &str = ".replaced";
/// How long a CLI whose tmux session was ended gets to exit.
const SETTLE: std::time::Duration = std::time::Duration::from_millis(500);

/// One conversation read off the side the tab leaves.
struct Session {
    id: String,
    transcript: Vec<u8>,
    /// The files of `<id>/`, by their path below it.
    files: Vec<(Vec<String>, Vec<u8>)>,
    /// When the transcript was last written (seconds), to pick between two.
    modified: u64,
}

/// One side of the move: this machine, or a host of the project. `folder` is
/// the slug folder of the folder the tab runs in there.
enum Side {
    Here { home: PathBuf, folder: String },
    Host { sftp: Arc<Sftp>, folder: String },
}

/// Take the conversation of the `agent` tab with launch id `launch_id` of the
/// remote project `project_id` from `from` to `to` — each a host id
/// (`"primary"` or a worker's) or `None` for this machine. The window has
/// stopped the tab's terminal; `tmux_session` is the session the tab runs in
/// on a host, ended here on the host it leaves (after asking it which
/// conversation its CLI is on) and on the host it goes to (a stale one there
/// would be attached instead of resumed).
pub async fn move_session(
    pool: &RemotePoolState,
    agent: &str,
    project_id: &str,
    launch_id: &str,
    from: Option<&str>,
    to: Option<&str>,
    tmux_session: Option<&str>,
) -> Result<Moved, String> {
    let project = crate::services::remote::remote_target_for(project_id).ok_or("not a remote project")?;
    if let Some(refusal) = local_side_refusal(&project.spec, from, to) {
        return Err(refusal);
    }
    if from == to {
        return Ok(Moved::Carried);
    }
    if agent != "claude" {
        return Ok(Moved::Fresh);
    }
    if !is_uuid_shaped(launch_id) {
        return Err("no session id".into());
    }
    let source = side(pool, project_id, from, &project.spec.remote_path).await?;
    let target = side(pool, project_id, to, &project.spec.remote_path).await?;

    // Ask the host's running CLI first: ending its tmux session ends it.
    let running = match &source {
        Side::Host { sftp, .. } => crate::services::remote_transcript::running_session(sftp, launch_id)
            .await
            .map(|(id, _)| id),
        Side::Here { .. } => None,
    };
    if let Some(session) = tmux_session {
        for host in [from, to].into_iter().flatten() {
            end_host_session(project_id, host, session, Some(host) == from).await?;
        }
        if from.is_some() {
            // The hung-up CLI's last write.
            tokio::time::sleep(SETTLE).await;
        }
    }

    let live = crate::services::agent_session::read_live_session_for(Some(project_id), launch_id)
        .filter(|id| is_uuid_shaped(id) && id != launch_id);
    let ids: Vec<String> = match running {
        Some(id) => vec![id],
        None => live.into_iter().chain([launch_id.to_string()]).collect(),
    };
    let sessions = read_sessions(&source, &ids).await?;
    // The one the tab goes on with: the running CLI's, else here the live
    // one (the local resolve's pick), else on a host the newest.
    let current = match &source {
        Side::Here { .. } => sessions.first(),
        Side::Host { .. } => sessions.iter().max_by_key(|s| s.modified),
    }
    .map(|s| s.id.clone());
    for session in &sessions {
        write_session(&target, session).await?;
    }
    if let (Side::Here { .. }, Some(current)) = (&target, current) {
        crate::services::agent_session::write_live_session(launch_id, &current)
            .map_err(|e| format!("recording the conversation: {e}"))?;
    }
    for host in [from, to].into_iter().flatten() {
        crate::services::remote_transcript::forget(project_id, host, launch_id).await;
    }
    Ok(Moved::Carried)
}

/// Why a move between `from` and `to` (`None`: this machine) is refused for the
/// project whose primary spec is `spec`, or `None`. A remote-only project (a VM
/// included) has no mirror for a tab to run in here, so neither end may be this
/// machine; a move between two of its hosts is kept.
fn local_side_refusal(spec: &crate::schema::project::RemoteSpec, from: Option<&str>, to: Option<&str>) -> Option<String> {
    (spec.is_remote_only() && (from.is_none() || to.is_none())).then(|| {
        crate::services::remote::remote_only_refusal(
            "this project keeps no local copy, so its agent tabs cannot move to or from this computer.",
        )
    })
}

/// The side `host` names (`None`: this machine), with the slug folder of the
/// folder the tab runs in there: the mirror here, the host's `remote_path`
/// there — resolved as Claude sees it (`process.cwd()` is the real path).
async fn side(pool: &RemotePoolState, project_id: &str, host: Option<&str>, primary_path: &str) -> Result<Side, String> {
    let Some(host) = host else {
        let mirror = crate::services::remote_sync::mirror_dir_opt(project_id)
            .ok_or_else(|| crate::services::remote::remote_only_refusal("this project keeps no local copy."))?;
        let real = std::fs::canonicalize(&mirror).unwrap_or(mirror);
        return Ok(Side::Here {
            home: crate::services::agent_home::scope_home(Some(project_id)),
            folder: claude_folder_name(&real.to_string_lossy()),
        });
    };
    let target = crate::services::remote::remote_target_for_host(project_id, host).ok_or("unknown host")?;
    let sftp = crate::services::remote::pooled_sftp_host(pool, project_id, host)
        .await
        .ok_or("the host is not connected")?;
    let path = if target.spec.remote_path.is_empty() { primary_path } else { target.spec.remote_path.as_str() };
    let real = sftp
        .fs()
        .canonicalize(path)
        .await
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| path.to_string());
    Ok(Side::Host { sftp, folder: claude_folder_name(real.trim_end_matches('/')) })
}

/// End the tab's tmux session on `host`. Failing to end it on the host the
/// tab leaves fails the move (its CLI would go on writing there); a stale one
/// on the host it goes to is only tried.
async fn end_host_session(project_id: &str, host: &str, session: &str, leaving: bool) -> Result<(), String> {
    let target = crate::services::remote::remote_target_for_host(project_id, host).ok_or("unknown host")?;
    let script = crate::services::ssh_exec::tmux_kill_session_script(session);
    let ended = app_core::rt::try_blocking("remote", move || {
        let output = crate::services::ssh_exec::run_remote_script(&target.spec, &script)?;
        if output.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&output.stderr).trim().to_string()) }
    })
    .await;
    match ended {
        Err(e) if leaving => Err(format!("ending the session on the host: {e}")),
        _ => Ok(()),
    }
}

/// Every conversation of `ids` on `side`, in that order; an id with no
/// transcript there is skipped.
async fn read_sessions(side: &Side, ids: &[String]) -> Result<Vec<Session>, String> {
    match side {
        Side::Here { home, folder } => {
            let (home, folder, ids) = (home.clone(), folder.clone(), ids.to_vec());
            app_core::rt::spawn_blocking(move || {
                ids.iter().filter_map(|id| read_here(&home, &folder, id).transpose()).collect::<Result<Vec<_>, _>>()
            })
            .await
            .map_err(|e| e.to_string())?
        }
        Side::Host { sftp, folder } => {
            let mut out = Vec::new();
            for id in ids {
                if let Some(session) = read_host(sftp, folder, id).await? {
                    out.push(session);
                }
            }
            Ok(out)
        }
    }
}

/// `id`'s conversation in the agent home `home`: in `folder`, else in any
/// slug folder (by handle; a linked folder is another scope's, not this one's).
fn read_here(home: &Path, folder: &str, id: &str) -> Result<Option<Session>, String> {
    let Some(projects) = HomeDir::open_existing(home, PROJECTS) else {
        return Ok(None);
    };
    let name = format!("{id}.jsonl");
    let mut folders = projects.names();
    folders.retain(|f| f != folder);
    folders.insert(0, folder.to_string());
    for dir in folders.iter().take(MAX_SEARCHED_DIRS).filter_map(|f| projects.open_subdir(f)) {
        let Some(file) = dir.file(&name).filter(|f| f.is_file()) else { continue };
        if file.metadata().is_some_and(|m| m.len > MAX_BYTES) {
            return Err("the conversation is too large to take along".into());
        }
        let transcript = file.read().ok_or("reading the conversation")?;
        let modified = std::fs::symlink_metadata(file.path())
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs());
        let mut files = Vec::new();
        if let Some(own) = dir.open_subdir(id) {
            collect_here(&own, &mut Vec::new(), &mut files)?;
        }
        return Ok(Some(Session { id: id.to_string(), transcript, files, modified }));
    }
    Ok(None)
}

/// The files below `dir` (a session's own folder), links and the rest skipped.
fn collect_here(dir: &HomeDir, at: &mut Vec<String>, out: &mut Vec<(Vec<String>, Vec<u8>)>) -> Result<(), String> {
    for name in dir.names() {
        let Some(entry) = dir.file(&name) else { continue };
        let Some(meta) = entry.metadata() else { continue };
        at.push(name.clone());
        if meta.is_dir && at.len() < MAX_DEPTH {
            if let Some(sub) = dir.open_subdir(&name) {
                collect_here(&sub, at, out)?;
            }
        } else if meta.is_file && meta.len <= MAX_BYTES {
            if out.len() >= MAX_SIDE_FILES {
                return Err("the conversation's folder has too many files to take along".into());
            }
            if let Some(bytes) = entry.read() {
                out.push((at.clone(), bytes));
            }
        }
        at.pop();
    }
    Ok(())
}

/// `id`'s conversation on the host: in `folder`, else in any slug folder.
async fn read_host(sftp: &Sftp, folder: &str, id: &str) -> Result<Option<Session>, String> {
    use crate::services::sftp::{list_dir_raw_on, metadata_opt_on, read_file_on};
    let name = format!("{id}.jsonl");
    let mut found = None;
    let own = format!("{PROJECTS}/{folder}/{name}");
    if let Some((size, modified)) = metadata_opt_on(sftp, &own).await? {
        found = Some((folder.to_string(), size, modified));
    } else if let Ok(dirs) = list_dir_raw_on(sftp, PROJECTS).await {
        for dir in dirs.iter().filter(|e| matches!(e.kind, SyncKind::Dir)).take(MAX_SEARCHED_DIRS) {
            if let Ok(Some((size, modified))) = metadata_opt_on(sftp, &format!("{PROJECTS}/{}/{name}", dir.name)).await {
                found = Some((dir.name.clone(), size, modified));
                break;
            }
        }
    }
    let Some((dir, size, modified)) = found else {
        return Ok(None);
    };
    if size > MAX_BYTES {
        return Err("the conversation is too large to take along".into());
    }
    let transcript = read_file_on(sftp, &format!("{PROJECTS}/{dir}/{name}")).await?;
    let mut files = Vec::new();
    collect_host(sftp, &format!("{PROJECTS}/{dir}/{id}"), &mut Vec::new(), &mut files).await?;
    Ok(Some(Session { id: id.to_string(), transcript, files, modified: modified.unwrap_or(0) }))
}

/// The files below the host folder `path` (a session's own folder). A missing
/// folder has none; links and the rest are skipped.
async fn collect_host(sftp: &Sftp, path: &str, at: &mut Vec<String>, out: &mut Vec<(Vec<String>, Vec<u8>)>) -> Result<(), String> {
    let Ok(entries) = crate::services::sftp::list_dir_raw_on(sftp, path).await else {
        return Ok(());
    };
    for entry in entries {
        let child = format!("{path}/{}", entry.name);
        at.push(entry.name.clone());
        match entry.kind {
            SyncKind::Dir if at.len() < MAX_DEPTH => Box::pin(collect_host(sftp, &child, at, out)).await?,
            SyncKind::File if entry.size <= MAX_BYTES => {
                if out.len() >= MAX_SIDE_FILES {
                    return Err("the conversation's folder has too many files to take along".into());
                }
                out.push((at.clone(), crate::services::sftp::read_file_on(sftp, &child).await?));
            }
            _ => {}
        }
        at.pop();
    }
    Ok(())
}

/// Write `session` into the slug folder of `side`.
async fn write_session(side: &Side, session: &Session) -> Result<(), String> {
    match side {
        Side::Here { home, folder } => {
            let (home, folder) = (home.clone(), folder.clone());
            let (id, transcript, files) = (session.id.clone(), session.transcript.clone(), session.files.clone());
            app_core::rt::spawn_blocking(move || write_here(&home, &folder, &id, &transcript, &files))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| format!("writing the conversation: {e}"))
        }
        Side::Host { sftp, folder } => write_host(sftp, folder, session).await,
    }
}

fn write_here(home: &Path, folder: &str, id: &str, transcript: &[u8], files: &[(Vec<String>, Vec<u8>)]) -> std::io::Result<()> {
    let dir = HomeDir::open(home, &format!("{PROJECTS}/{folder}")).ok_or_else(|| std::io::Error::other("the session folder"))?;
    let file = dir.file(&format!("{id}.jsonl")).ok_or_else(|| std::io::Error::other("the session"))?;
    if let Some(held) = file.metadata().filter(|m| m.is_file).and_then(|_| file.read()) {
        if !transcript.starts_with(&held) {
            file.rename_aside(ASIDE)?;
        }
    }
    file.write(transcript)?;
    for (rel, bytes) in files {
        let Some((name, parents)) = rel.split_last() else { continue };
        let mut at = dir.subdir(id).ok_or_else(|| std::io::Error::other("the session's folder"))?;
        for part in parents {
            at = at.subdir(part).ok_or_else(|| std::io::Error::other("the session's folder"))?;
        }
        at.file(name).ok_or_else(|| std::io::Error::other("a file of the session"))?.write(bytes)?;
    }
    Ok(())
}

async fn write_host(sftp: &Sftp, folder: &str, session: &Session) -> Result<(), String> {
    use crate::services::sftp::{metadata_opt_on, read_file_on, rename_on, write_file_on};
    let base = format!("{PROJECTS}/{folder}");
    let path = format!("{base}/{}.jsonl", session.id);
    if metadata_opt_on(sftp, &path).await?.is_some() {
        let held = read_file_on(sftp, &path).await?;
        if !session.transcript.starts_with(&held) {
            rename_on(sftp, &path, &free_name(sftp, &format!("{path}{ASIDE}")).await?).await?;
        }
    }
    write_file_on(sftp, &path, &session.transcript).await?;
    for (rel, bytes) in &session.files {
        write_file_on(sftp, &format!("{base}/{}/{}", session.id, rel.join("/")), bytes).await?;
    }
    Ok(())
}

/// `path`, or `path.1`, `path.2`, … — the first that is not taken on the host.
async fn free_name(sftp: &Sftp, path: &str) -> Result<String, String> {
    for n in 0..1000u32 {
        let name = if n == 0 { path.to_string() } else { format!("{path}.{n}") };
        if crate::services::sftp::metadata_opt_on(sftp, &name).await?.is_none() {
            return Ok(name);
        }
    }
    Err("no free name to move the old conversation aside to".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "11111111-2222-3333-4444-555555555555";

    fn spec(extra: serde_json::Value) -> crate::schema::project::RemoteSpec {
        let mut base = serde_json::json!({ "host": "h.example", "remote_path": "/srv/p" });
        base.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    /// A remote-only project (a VM included) refuses either end being this
    /// machine, with the sentinel; host ⇄ worker moves, and every move of a
    /// plain Remote project, are let through.
    #[test]
    fn a_remote_only_project_never_moves_a_tab_to_or_from_this_machine() {
        let sentinel = concat!(crate::app_upper!(), "_REMOTE_ONLY:");
        let pinned = [
            spec(serde_json::json!({ "remote_only": true })),
            spec(serde_json::json!({ "vm": true })),
            // A VM outranks a stray `remote_only: false` (hand edit, bundle).
            spec(serde_json::json!({ "vm": true, "remote_only": false })),
        ];
        for pinned in pinned {
            for (from, to) in [(None, Some("primary")), (Some("primary"), None), (Some("w1"), None), (None, None)] {
                let refusal = local_side_refusal(&pinned, from, to).expect("refused");
                assert!(refusal.starts_with(sentinel), "{refusal}");
            }
            assert_eq!(local_side_refusal(&pinned, Some("primary"), Some("w1")), None);
            assert_eq!(local_side_refusal(&pinned, Some("w1"), Some("primary")), None);
        }
        let plain = spec(serde_json::json!({}));
        for (from, to) in [(None, Some("primary")), (Some("primary"), None), (Some("primary"), Some("w1"))] {
            assert_eq!(local_side_refusal(&plain, from, to), None);
        }
    }

    fn home() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn put(home: &Path, rel: &[&str], bytes: &[u8]) {
        let path = rel.iter().fold(home.join(".claude").join("projects"), |p, part| p.join(part));
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    fn get(home: &Path, rel: &[&str]) -> Option<Vec<u8>> {
        std::fs::read(rel.iter().fold(home.join(".claude").join("projects"), |p, part| p.join(part))).ok()
    }

    #[test]
    fn a_conversation_is_read_with_its_folder_from_any_slug_folder() {
        let h = home();
        put(h.path(), &["-elsewhere", &format!("{ID}.jsonl")], b"a\n");
        put(h.path(), &["-elsewhere", ID, "subagents", "agent-1.jsonl"], b"s\n");
        let session = read_here(h.path(), "-mirror", ID).unwrap().unwrap();
        assert_eq!(session.transcript, b"a\n");
        assert_eq!(session.files, vec![(vec!["subagents".to_string(), "agent-1.jsonl".to_string()], b"s\n".to_vec())]);
        assert!(read_here(h.path(), "-mirror", "66666666-7777-8888-9999-000000000000").unwrap().is_none());
    }

    #[test]
    fn the_own_folder_wins_over_another() {
        let h = home();
        put(h.path(), &["-a", &format!("{ID}.jsonl")], b"other\n");
        put(h.path(), &["-mirror", &format!("{ID}.jsonl")], b"own\n");
        assert_eq!(read_here(h.path(), "-mirror", ID).unwrap().unwrap().transcript, b"own\n");
    }

    #[test]
    fn a_stale_copy_is_replaced_and_a_diverged_one_kept_aside() {
        let h = home();
        let name = format!("{ID}.jsonl");
        put(h.path(), &["-mirror", &name], b"one\n");
        write_here(h.path(), "-mirror", ID, b"one\ntwo\n", &[]).unwrap();
        assert_eq!(get(h.path(), &["-mirror", &name]).unwrap(), b"one\ntwo\n");
        assert!(get(h.path(), &["-mirror", &format!("{name}{ASIDE}")]).is_none(), "a prefix is not kept");

        write_here(h.path(), "-mirror", ID, b"one\nthree\n", &[(vec!["tool-results".into(), "x.txt".into()], b"r".to_vec())]).unwrap();
        assert_eq!(get(h.path(), &["-mirror", &name]).unwrap(), b"one\nthree\n");
        assert_eq!(get(h.path(), &["-mirror", &format!("{name}{ASIDE}")]).unwrap(), b"one\ntwo\n");
        assert_eq!(get(h.path(), &["-mirror", ID, "tool-results", "x.txt"]).unwrap(), b"r");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_session_folder_is_not_followed() {
        let h = home();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret"), b"x").unwrap();
        put(h.path(), &["-mirror", &format!("{ID}.jsonl")], b"a\n");
        std::os::unix::fs::symlink(outside.path(), h.path().join(".claude").join("projects").join("-mirror").join(ID)).unwrap();
        let session = read_here(h.path(), "-mirror", ID).unwrap().unwrap();
        assert!(session.files.is_empty());
    }
}
