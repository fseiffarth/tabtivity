//! The view's half of the markup questions MCP (`services::markup_mcp`), run
//! in the process that serves the lane — the window, or a server daemon for
//! its browser client and phone (`mobile_control::host::markup_here`):
//! list a tab's open ask for the file a markup view shows, answer it (the
//! desktop builds the prompt; the caller queues it into the tab the way the
//! markup Submit does, and reopens the ask with the answer's receipt when
//! queueing fails) or dismiss it. Payloads are camelCase; errors are wire
//! codes (`superseded`, `answered`, `gone`, `invalid_answer`,
//! `invalid_target`, `markup_failed`). The service rings `markup-mcp-changed`
//! through the hook installed here, so it stays context-free.
//!
//! **Two processes.** A tab's asks live in the process that spawned it: the
//! window, or the Mobile host for a tab it started with no window open
//! (`docs/headless_mcp_plan.md`, phase 1b). The window's commands below read
//! its own store and then its peer's — the Mobile host's, over the admin
//! socket ([`use_host_peer`], `AdminRequest::Markup*`) — and merge; an
//! answer, reopen or dismissal goes to whichever process holds the ask. The
//! host and a server daemon set no peer and answer from their own store
//! (the host's phone routes ask the window themselves, `markup_call`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;
use app_core::CoreCtx;

use crate::services::markup_mcp::{self, Answer, AnswerError, AskView, Shown, TickView};
use crate::services::mobile_control::admin;
use crate::services::mobile_control::protocol::{AdminRequest, AdminResponse};

/// Called once from the listener's start (`commands::root_mcp::start`).
pub fn install_change_hook(ctx: &CoreCtx) {
    let ctx = ctx.clone();
    markup_mcp::set_change_hook(Box::new(move || {
        ctx.emit(markup_mcp::CHANGED_EVENT, ());
    }));
}

/// The Mobile host's admin socket, whose store holds the asks of the tabs it
/// spawned. Set by the window only; once.
static HOST_PEER: OnceLock<PathBuf> = OnceLock::new();
pub fn use_host_peer(socket: PathBuf) { let _ = HOST_PEER.set(socket); }
fn host_peer() -> Option<&'static Path> { HOST_PEER.get().map(PathBuf::as_path) }

fn valid_target(project_id: &str, schedule_target_id: &str) -> Result<(), String> {
    crate::services::agent_tasks::validate_id("project", project_id)
        .and_then(|_| crate::services::agent_tasks::validate_id("schedule target", schedule_target_id))
        .map_err(|_| "invalid_target".to_string())
}

/// The project-relative form of the path a view shows: the desktop viewer's
/// absolute path, or the phone bridge's project-relative one. `None` when it
/// does not resolve under the project — the view then gets only the asks
/// bound to no file.
fn shown_rel(project_id: &str, path: &str) -> Option<String> {
    let root = markup_mcp::project_root(project_id)?;
    markup_mcp::resolve_file(&root, path, false).ok()
}

/// Run `read` with the [`Shown`] a view's `path` names: absent or blank is
/// every file, one that does not resolve under the project is
/// [`Shown::Elsewhere`]. Blocking (it may look at the project folder).
fn with_shown<T>(project_id: &str, path: Option<&str>, read: impl FnOnce(Shown) -> T) -> T {
    let shown = path.map(str::trim).filter(|p| !p.is_empty()).map(|p| shown_rel(project_id, p));
    read(match &shown {
        None => Shown::All,
        Some(Some(rel)) => Shown::File(rel),
        Some(None) => Shown::Elsewhere,
    })
}

/// What this process holds, blocking.
fn asks_here(project_id: &str, target: &str, path: Option<&str>) -> Vec<AskView> {
    with_shown(project_id, path, |shown| markup_mcp::list(project_id, target, shown))
}
fn ticks_here(project_id: &str, target: &str, path: Option<&str>) -> Vec<TickView> {
    with_shown(project_id, path, |shown| markup_mcp::ticks(project_id, target, shown))
}

/// One request to the peer. Anything but its answer — no peer, it is not
/// running, an older build that does not know the request — is `None`: the
/// peer holds nothing for this window to show.
async fn ask_peer(peer: Option<&Path>, request: AdminRequest) -> Option<AdminResponse> {
    admin::admin_call(peer?, &request).await.ok()
}

/// An answer the window sent the peer whose reply never came: the peer may
/// have closed the ask and handed back a prompt nobody will queue. Its
/// receipt reopens exactly that answer ([`markup_mcp::reopen`]), so it is
/// kept until the peer gives a definite reply to the reopen — tried at once,
/// then before every later list, answer or reopen against it.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Undelivered { peer: PathBuf, project_id: String, target: String, ask_id: String, receipt: String }

/// At most this many are kept; the oldest go first (the ask expires anyway).
const MAX_UNDELIVERED: usize = 64;

static UNDELIVERED: std::sync::Mutex<Vec<Undelivered>> = std::sync::Mutex::new(Vec::new());

fn note_undelivered(entry: Undelivered) {
    let mut list = UNDELIVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    list.retain(|e| e.peer != entry.peer || e.ask_id != entry.ask_id || e.project_id != entry.project_id || e.target != entry.target);
    list.push(entry);
    let over = list.len().saturating_sub(MAX_UNDELIVERED);
    list.drain(..over);
}

/// Reopen every undelivered answer the peer still might hold closed. A
/// definite reply (reopened, or refused because something else closed or
/// replaced the ask since) settles an entry; no reply keeps it and stops the
/// round, so a peer that is down costs one timeout, not one per entry. The
/// lock is never held across the call.
async fn settle_undelivered(peer: Option<&Path>) {
    let Some(peer) = peer else { return };
    loop {
        let next = UNDELIVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().find(|e| e.peer == peer).cloned();
        let Some(entry) = next else { return };
        let request = AdminRequest::MarkupReopen {
            project_id: entry.project_id.clone(),
            target: entry.target.clone(),
            ask_id: entry.ask_id.clone(),
            receipt: entry.receipt.clone(),
        };
        match ask_peer(Some(peer), request).await {
            Some(AdminResponse::Ok | AdminResponse::MarkupRefused { .. }) => {
                UNDELIVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).retain(|e| e != &entry);
            }
            _ => return,
        }
    }
}

impl Undelivered {
    fn new(peer: Option<&Path>, project_id: String, target: String, ask_id: String, receipt: String) -> Self {
        Undelivered { peer: peer.map(Path::to_path_buf).unwrap_or_default(), project_id, target, ask_id, receipt }
    }
}

/// The error a peer's reply other than the one asked for comes to: its
/// refusal code, or `gone` from an older peer that does not know the request
/// (nothing taken).
fn peer_refusal(reply: AdminResponse) -> String {
    match reply {
        AdminResponse::MarkupRefused { code } => code,
        _ => AnswerError::Gone.code().to_string(),
    }
}

#[cfg(test)]
fn undelivered_for(peer: &Path) -> usize {
    UNDELIVERED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().filter(|e| e.peer == peer).count()
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    app_core::rt::spawn_blocking(work).await.map_err(|_| "markup_failed".to_string())
}

/// [`markup_mcp_list`] against a given peer.
pub async fn list_with(peer: Option<&Path>, project_id: String, schedule_target_id: String, path: Option<String>) -> Result<Vec<AskView>, String> {
    valid_target(&project_id, &schedule_target_id)?;
    let (p, t, pa) = (project_id.clone(), schedule_target_id.clone(), path.clone());
    let here = blocking(move || asks_here(&p, &t, pa.as_deref())).await?;
    settle_undelivered(peer).await;
    let theirs = match ask_peer(peer, AdminRequest::MarkupList { project_id, target: schedule_target_id, path }).await {
        Some(AdminResponse::MarkupAsks { asks }) => asks,
        _ => Vec::new(),
    };
    Ok(markup_mcp::merge_asks(here, theirs))
}

/// [`markup_mcp_ticks`] against a given peer.
pub async fn ticks_with(peer: Option<&Path>, project_id: String, schedule_target_id: String, path: Option<String>) -> Result<Vec<TickView>, String> {
    valid_target(&project_id, &schedule_target_id)?;
    let (p, t, pa) = (project_id.clone(), schedule_target_id.clone(), path.clone());
    let here = blocking(move || ticks_here(&p, &t, pa.as_deref())).await?;
    let theirs = match ask_peer(peer, AdminRequest::MarkupTicks { project_id, target: schedule_target_id, path }).await {
        Some(AdminResponse::MarkupTicks { ticks }) => ticks,
        _ => Vec::new(),
    };
    Ok(markup_mcp::merge_ticks(here, theirs))
}

/// `markup_mcp_list({ projectId, scheduleTargetId, path? })` → the open asks
/// (`[{ id, file, fileName, createdAt, questions }]`; at most one per tab).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markup_mcp_list(project_id: String, schedule_target_id: String, path: Option<String>) -> Result<Vec<AskView>, String> {
    list_with(host_peer(), project_id, schedule_target_id, path).await
}

/// `markup_mcp_ticks({ projectId, scheduleTargetId, path? })` → the marks
/// the tab's agent ticked off with `markup_done` for the file `path` shows
/// (`[{ round, page, mark }]`, oldest first; every file's without `path`).
/// The view maps each onto the mark it sent in that round.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markup_mcp_ticks(project_id: String, schedule_target_id: String, path: Option<String>) -> Result<Vec<TickView>, String> {
    ticks_with(host_peer(), project_id, schedule_target_id, path).await
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct MarkupAnswered {
    pub prompt: String,
    /// Hands back to `markup_mcp_reopen` when `prompt` could not be queued.
    pub receipt: String,
}

/// [`markup_mcp_answer`] against a given peer: this process's ask first; one
/// it does not hold (`gone`) is the peer's to take.
pub async fn answer_with(
    peer: Option<&Path>,
    project_id: String,
    schedule_target_id: String,
    ask_id: String,
    answers: Vec<Answer>,
) -> Result<MarkupAnswered, String> {
    valid_target(&project_id, &schedule_target_id)?;
    let (p, t, a, ans) = (project_id.clone(), schedule_target_id.clone(), ask_id.clone(), answers.clone());
    let here = blocking(move || markup_mcp::answer(&p, &t, &a, &ans)).await?;
    match here {
        Ok(taken) => Ok(MarkupAnswered { prompt: taken.prompt, receipt: taken.receipt }),
        Err(AnswerError::Gone) => {
            if peer.is_none() { return Err(AnswerError::Gone.code().to_string()); }
            settle_undelivered(peer).await;
            // Minted here, so a reply lost on the way back still leaves the
            // window able to undo the answer the peer may have taken.
            let receipt = markup_mcp::mint_receipt();
            let request = AdminRequest::MarkupAnswer {
                project_id: project_id.clone(),
                target: schedule_target_id.clone(),
                ask_id: ask_id.clone(),
                answers,
                receipt: Some(receipt.clone()),
            };
            match ask_peer(peer, request).await {
                Some(AdminResponse::MarkupAnswered { prompt, receipt }) => Ok(MarkupAnswered { prompt, receipt }),
                Some(other) => Err(peer_refusal(other)),
                None => {
                    note_undelivered(Undelivered::new(peer, project_id, schedule_target_id, ask_id, receipt));
                    settle_undelivered(peer).await;
                    Err("markup_failed".to_string())
                }
            }
        }
        Err(other) => Err(other.code().to_string()),
    }
}

/// `markup_mcp_answer({ projectId, scheduleTargetId, askId, answers:
/// [{ options: number[], other? }] })` → `{ prompt, receipt }`, one answer
/// per question in order. The ask is closed before the prompt is returned; a
/// caller that then fails to queue the prompt reopens it with `receipt`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markup_mcp_answer(project_id: String, schedule_target_id: String, ask_id: String, answers: Vec<Answer>) -> Result<MarkupAnswered, String> {
    answer_with(host_peer(), project_id, schedule_target_id, ask_id, answers).await
}

/// [`markup_mcp_reopen`] against a given peer.
pub async fn reopen_with(peer: Option<&Path>, project_id: String, schedule_target_id: String, ask_id: String, receipt: String) -> Result<(), String> {
    valid_target(&project_id, &schedule_target_id)?;
    let (p, t, a, r) = (project_id.clone(), schedule_target_id.clone(), ask_id.clone(), receipt.clone());
    let here = blocking(move || markup_mcp::reopen(&p, &t, &a, &r)).await?;
    match here {
        Ok(()) => Ok(()),
        Err(AnswerError::Gone) if peer.is_some() => {
            settle_undelivered(peer).await;
            let request = AdminRequest::MarkupReopen {
                project_id: project_id.clone(),
                target: schedule_target_id.clone(),
                ask_id: ask_id.clone(),
                receipt: receipt.clone(),
            };
            match ask_peer(peer, request).await {
                Some(AdminResponse::Ok) => Ok(()),
                Some(other) => Err(peer_refusal(other)),
                // No reply: the ask may still be closed there; keep trying.
                None => {
                    note_undelivered(Undelivered::new(peer, project_id, schedule_target_id, ask_id, receipt));
                    Err("markup_failed".to_string())
                }
            }
        }
        Err(other) => Err(other.code().to_string()),
    }
}

/// `markup_mcp_reopen({ projectId, scheduleTargetId, askId, receipt })`: the
/// prompt of the answer `receipt` names never reached the tab — open the ask
/// again so its card stays usable. Refused (`answered`, `superseded`, `gone`)
/// when anything else closed or replaced it since.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markup_mcp_reopen(project_id: String, schedule_target_id: String, ask_id: String, receipt: String) -> Result<(), String> {
    reopen_with(host_peer(), project_id, schedule_target_id, ask_id, receipt).await
}

/// [`markup_mcp_dismiss`] against a given peer: both processes close it (an
/// ask id is held by at most one, and dismissing an unknown one is not an
/// error).
pub async fn dismiss_with(peer: Option<&Path>, project_id: String, schedule_target_id: String, ask_id: String) -> Result<(), String> {
    valid_target(&project_id, &schedule_target_id)?;
    let (p, t, a) = (project_id.clone(), schedule_target_id.clone(), ask_id.clone());
    blocking(move || markup_mcp::dismiss(&p, &t, &a)).await?.map_err(|e| e.code().to_string())?;
    ask_peer(peer, AdminRequest::MarkupDismiss { project_id, target: schedule_target_id, ask_id }).await;
    Ok(())
}

/// `markup_mcp_dismiss({ projectId, scheduleTargetId, askId })`: **Answer in
/// chat instead**. Idempotent.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markup_mcp_dismiss(project_id: String, schedule_target_id: String, ask_id: String) -> Result<(), String> {
    dismiss_with(host_peer(), project_id, schedule_target_id, ask_id).await
}

/// The Mobile host's answer to the window's markup requests
/// (`AdminRequest::Markup*`): this process's own store only, never its
/// peer's. Blocking (it may look at the project folder).
pub fn admin_markup(request: &AdminRequest) -> AdminResponse {
    let refused = |code: &str| AdminResponse::MarkupRefused { code: code.to_string() };
    let checked = |project: &str, target: &str| valid_target(project, target).is_ok();
    match request {
        AdminRequest::MarkupList { project_id, target, path } if checked(project_id, target) => {
            AdminResponse::MarkupAsks { asks: asks_here(project_id, target, path.as_deref()) }
        }
        AdminRequest::MarkupTicks { project_id, target, path } if checked(project_id, target) => {
            let mut ticks = ticks_here(project_id, target, path.as_deref());
            // Oldest first, so the newest are what stays.
            let over = ticks.len().saturating_sub(markup_mcp::MAX_PEER_TICKS);
            ticks.drain(..over);
            AdminResponse::MarkupTicks { ticks }
        }
        AdminRequest::MarkupAnswer { project_id, target, ask_id, answers, receipt } if checked(project_id, target) => {
            match markup_mcp::answer_as(project_id, target, ask_id, answers, receipt.as_deref()) {
                Ok(taken) => AdminResponse::MarkupAnswered { prompt: taken.prompt, receipt: taken.receipt },
                Err(error) => refused(error.code()),
            }
        }
        AdminRequest::MarkupReopen { project_id, target, ask_id, receipt } if checked(project_id, target) => {
            match markup_mcp::reopen(project_id, target, ask_id, receipt) {
                Ok(()) => AdminResponse::Ok,
                Err(error) => refused(error.code()),
            }
        }
        AdminRequest::MarkupDismiss { project_id, target, ask_id } if checked(project_id, target) => {
            match markup_mcp::dismiss(project_id, target, ask_id) {
                Ok(()) => AdminResponse::Ok,
                Err(error) => refused(error.code()),
            }
        }
        AdminRequest::MarkupList { .. } | AdminRequest::MarkupTicks { .. } | AdminRequest::MarkupAnswer { .. }
        | AdminRequest::MarkupReopen { .. } | AdminRequest::MarkupDismiss { .. } => refused("invalid_target"),
        _ => AdminResponse::Error { message: "not a markup request".into() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_are_bounded_and_answers_are_camel_case_and_closed() {
        assert!(valid_target("p", "t").is_ok());
        assert_eq!(valid_target("", "t"), Err("invalid_target".into()));
        assert_eq!(valid_target("p", "a\nb"), Err("invalid_target".into()));
        let answers: Vec<Answer> = serde_json::from_str(r#"[{"options":[1]},{"options":[],"other":"x"},{}]"#).unwrap();
        assert_eq!(answers[0], Answer { options: vec![1], other: None });
        assert_eq!(answers[1].other.as_deref(), Some("x"));
        assert_eq!(answers[2], Answer::default());
        for bad in [r#"[{"options":[-1]}]"#, r#"[{"options":[0],"extra":1}]"#, r#"[{"option":[0]}]"#] {
            assert!(serde_json::from_str::<Vec<Answer>>(bad).is_err(), "{bad}");
        }
        assert_eq!(serde_json::to_value(MarkupAnswered { prompt: "p".into(), receipt: "r".into() }).unwrap(), serde_json::json!({"prompt": "p", "receipt": "r"}));
        use app_core::rt::block_on;
        assert_eq!(block_on(markup_mcp_answer("p".into(), "t".into(), "ask-none".into(), vec![])), Err("gone".into()));
        assert_eq!(block_on(markup_mcp_dismiss("p".into(), "t".into(), "ask-none".into())), Ok(()));
        assert_eq!(block_on(markup_mcp_reopen("p".into(), "t".into(), "ask-none".into(), "r".into())), Err("gone".into()));
        assert_eq!(block_on(markup_mcp_reopen("p".into(), "".into(), "ask-none".into(), "r".into())), Err("invalid_target".into()));
    }

    #[test]
    fn ticks_are_read_per_target_and_refuse_a_bad_one() {
        let run = |project: &str, target: &str, path: Option<&str>| {
            app_core::rt::block_on(markup_mcp_ticks(project.into(), target.into(), path.map(str::to_string)))
        };
        assert_eq!(run("", "t", None), Err("invalid_target".into()));
        assert_eq!(run("p", "a\nb", None), Err("invalid_target".into()));
        assert_eq!(run("p-cmd-ticks", "t-cmd-ticks", None), Ok(vec![]));
        assert_eq!(run("p-cmd-ticks", "t-cmd-ticks", Some("  ")), Ok(vec![]), "blank is every file");
        // (A path is resolved under `projects.json`'s folder, which a unit
        // test does not read; `markup_mcp::ticks` is tested per `Shown`.)
        assert!(with_shown("p-cmd-ticks", Some(" "), |shown| shown == Shown::All));
        assert!(with_shown("p-cmd-ticks", None, |shown| shown == Shown::All));
    }

    /// The window and the Mobile host are two processes, each with its own
    /// asks and ticks (`markup_mcp::as_host` models the second store here):
    /// the window's commands read, answer, reopen and dismiss the host's
    /// through its admin socket, and its own through memory.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_window_reaches_the_asks_and_ticks_the_host_holds() {
        use crate::services::markup_mcp::{as_host, test_open_ask, test_tick};
        use crate::services::mobile_control::auth::AuthStore;
        use std::sync::{Arc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let auth = AuthStore::open(&dir.path().join("mobile-control"), "https://desk.example".into()).expect("auth store");
        let (shutdown, _watch) = tokio::sync::watch::channel(false);
        let socket = dir.path().join("admin.sock");
        let context = admin::AdminContext {
            auth: Arc::new(Mutex::new(auth)),
            port: 8443,
            origin: None,
            shutdown,
            agent_tab: None,
            presence: None,
            state_dir: None,
            markup: Some(Arc::new(|request: &AdminRequest| as_host::run(|| admin_markup(request)))),
        };
        let served = socket.clone();
        let server = tokio::spawn(async move { let _ = admin::serve(&served, context).await; });
        while !socket.exists() { tokio::time::sleep(std::time::Duration::from_millis(10)).await; }

        let project = "p-two-processes";
        let (host_tab, window_tab) = ("t-two-host", "t-two-window");
        let questions = |question: &str| serde_json::json!([{ "question": question, "options": [{ "label": "Figure" }, { "label": "Paragraph" }] }]);
        // The host's tab asked and ticked; so did the window's. (A tab holds one
        // session per lane, so the ticking sessions are other tabs of the same target.)
        let host_ask = as_host::run(|| test_open_ask("two-host", project, host_tab, questions("Which, host?")));
        let window_ask = test_open_ask("two-window", project, window_tab, questions("Which, window?"));
        let files = tempfile::tempdir().unwrap();
        std::fs::write(files.path().join("draft.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
        let ticked = as_host::run(|| test_tick("two-host-ticks", project, host_tab, files.path(), "draft.pdf", "k3x9a0b1", &[(2, 1), (3, 2)]));
        assert_eq!(ticked["count"], 2, "{ticked}");
        test_tick("two-window-ticks", project, window_tab, files.path(), "draft.pdf", "k3x9a0b2", &[(1, 1)]);

        let peer = Some(socket.as_path());
        async fn list(peer: Option<&Path>, target: &str) -> Result<Vec<AskView>, String> {
            list_with(peer, "p-two-processes".into(), target.into(), None).await
        }
        async fn ticks(peer: Option<&Path>, target: &str) -> Result<Vec<TickView>, String> {
            ticks_with(peer, "p-two-processes".into(), target.into(), None).await
        }
        // Window open (a peer): both tabs' asks and ticks show.
        let seen = list(peer, host_tab).await.unwrap();
        assert_eq!(seen.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), [host_ask.as_str()]);
        assert_eq!(list(peer, window_tab).await.unwrap()[0].id, window_ask);
        assert_eq!(ticks(peer, host_tab).await.unwrap().len(), 2);
        assert_eq!(ticks(peer, window_tab).await.unwrap().len(), 1);
        // No Mobile host running (no peer, a socket nobody listens on): the
        // window shows what it holds itself, and nothing breaks.
        assert!(list(None, host_tab).await.unwrap().is_empty());
        let nobody = dir.path().join("nobody.sock");
        let nobody = nobody.as_path();
        assert!(list(Some(nobody), host_tab).await.unwrap().is_empty());
        assert!(ticks(Some(nobody), host_tab).await.unwrap().is_empty());
        assert_eq!(list(Some(nobody), window_tab).await.unwrap()[0].id, window_ask);
        assert_eq!(list(peer, "a\nb").await, Err("invalid_target".into()));

        // The host's answer: the prompt comes back for the window to queue;
        // the host's ask is closed; the window's own is untouched.
        let one = || vec![Answer { options: vec![1], other: None }];
        let answered = answer_with(peer, project.into(), host_tab.into(), host_ask.clone(), one()).await.unwrap();
        assert!(answered.prompt.contains("Paragraph"), "{}", answered.prompt);
        assert!(as_host::run(|| markup_mcp::list(project, host_tab, Shown::All)).is_empty());
        assert_eq!(list(peer, window_tab).await.unwrap().len(), 1);
        assert_eq!(answer_with(peer, project.into(), host_tab.into(), host_ask.clone(), one()).await, Err("answered".into()));
        // The prompt never reached the tab: reopening goes back to the host.
        reopen_with(peer, project.into(), host_tab.into(), host_ask.clone(), answered.receipt.clone()).await.unwrap();
        assert_eq!(list(peer, host_tab).await.unwrap().len(), 1, "open again");
        assert_eq!(reopen_with(peer, project.into(), host_tab.into(), host_ask.clone(), "wrong".into()).await, Ok(()), "already open is not an error");
        // The answer needs the host: without one the ask is `gone` here.
        assert_eq!(answer_with(None, project.into(), host_tab.into(), host_ask.clone(), one()).await, Err("gone".into()));
        assert_eq!(answer_with(peer, project.into(), host_tab.into(), host_ask.clone(), vec![]).await, Err("invalid_answer".into()), "the host checks the answers");
        // The window's own ask is answered in memory, never through the peer.
        let own = answer_with(Some(nobody), project.into(), window_tab.into(), window_ask.clone(), one()).await.unwrap();
        assert!(own.prompt.contains("Paragraph"));
        // Dismissing closes whichever holds it; an unknown ask is no error.
        dismiss_with(peer, project.into(), host_tab.into(), host_ask.clone()).await.unwrap();
        assert!(as_host::run(|| markup_mcp::list(project, host_tab, Shown::All)).is_empty());
        dismiss_with(peer, project.into(), host_tab.into(), "ask-unknown".into()).await.unwrap();
        // A request the host does not take: not a markup request, a bad target.
        assert!(matches!(admin_markup(&AdminRequest::Status), AdminResponse::Error { .. }));
        let bad = AdminRequest::MarkupDismiss { project_id: "p".into(), target: "a\nb".into(), ask_id: "x".into() };
        assert!(matches!(admin_markup(&bad), AdminResponse::MarkupRefused { code } if code == "invalid_target"));
        server.abort();
    }

    /// The host took the window's answer but its reply never arrived (the
    /// connection dropped, the 5 s deadline passed): the ask must not stay
    /// closed with its prompt lost. The window minted the receipt, so it
    /// reopens that answer — at once, or, while the host does not answer at
    /// all, on its next contact.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lost_reply_to_a_host_answer_reopens_the_ask() {
        use crate::services::markup_mcp::{as_host, test_open_ask};
        use std::sync::atomic::{AtomicU8, Ordering};
        use std::sync::Arc;
        // 0: a working host. 1: answers are taken, their replies dropped;
        // everything else is dropped unread (a host that stopped answering).
        let mode = Arc::new(AtomicU8::new(1));
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("lossy.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let served = mode.clone();
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let Ok(request) = admin::read_frame::<AdminRequest>(&mut stream).await else { continue };
                let lossy = served.load(Ordering::SeqCst) == 1;
                if lossy && !matches!(request, AdminRequest::MarkupAnswer { .. }) { continue; }
                let response = as_host::run(|| admin_markup(&request));
                if lossy { continue; }
                let _ = admin::write_frame(&mut stream, &response).await;
            }
        });
        let peer = Some(socket.as_path());
        let (project, tab) = ("p-lost-reply", "t-lost-reply");
        let questions = serde_json::json!([{ "question": "Which?", "options": [{ "label": "Figure" }, { "label": "Paragraph" }] }]);
        let ask = as_host::run(|| test_open_ask("lost-reply", project, tab, questions));
        let held = || as_host::run(|| markup_mcp::list(project, tab, Shown::All)).len();
        let one = || vec![Answer { options: vec![0], other: None }];

        // Taken, reply lost, and the reopen gets no answer either: the window
        // says it failed and keeps the receipt.
        assert_eq!(answer_with(peer, project.into(), tab.into(), ask.clone(), one()).await, Err("markup_failed".into()));
        assert_eq!(held(), 0, "the host closed the ask");
        assert_eq!(undelivered_for(&socket), 1);
        // The host answers again: the next list reopens the answer first, so
        // the card comes back and a retry is not told `answered`.
        mode.store(0, Ordering::SeqCst);
        let seen = list_with(peer, project.into(), tab.into(), None).await.unwrap();
        assert_eq!(seen.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), [ask.as_str()]);
        assert_eq!(undelivered_for(&socket), 0, "settled");
        let answered = answer_with(peer, project.into(), tab.into(), ask.clone(), one()).await.unwrap();
        assert!(answered.prompt.contains("Figure"), "{}", answered.prompt);

        // Lost again; this time the next contact is a reopen of another ask:
        // that settles the pending one too.
        as_host::run(|| markup_mcp::reopen(project, tab, &ask, &answered.receipt)).unwrap();
        mode.store(1, Ordering::SeqCst);
        assert_eq!(answer_with(peer, project.into(), tab.into(), ask.clone(), one()).await, Err("markup_failed".into()));
        assert_eq!((held(), undelivered_for(&socket)), (0, 1));
        mode.store(0, Ordering::SeqCst);
        let other = reopen_with(peer, project.into(), tab.into(), "ask-unrelated".into(), "r".repeat(16)).await;
        assert_eq!(other, Err("gone".into()));
        assert_eq!((held(), undelivered_for(&socket)), (1, 0), "open again, settled");

        // A receipt the window did not mint the host's way is refused.
        let planted = AdminRequest::MarkupAnswer { project_id: project.into(), target: tab.into(), ask_id: ask.clone(), answers: one(), receipt: Some("a/b".into()) };
        assert!(matches!(admin_markup(&planted), AdminResponse::MarkupRefused { code } if code == "invalid_answer"));
        server.abort();
    }

    /// A peer answer carries at most the newest ticks that fit its frame.
    #[test]
    fn the_hosts_tick_answer_keeps_the_newest_ticks_that_fit_a_frame() {
        use crate::services::mobile_control::protocol::MAX_CONTROL_MESSAGE;
        let one = serde_json::to_string(&TickView { round: "k3x9a0b1".into(), page: 100_000, mark: 9_999 }).unwrap().len() + 1;
        assert!(markup_mcp::MAX_PEER_TICKS * one < MAX_CONTROL_MESSAGE, "{one} bytes a tick");
    }
}
