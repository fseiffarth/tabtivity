//! Project-scoped prompt collection (`agent_prompts.json`), the tab-free half
//! of scheduled agent prompts. Kept beside, not inside, `agent_tasks.json`: a
//! prompt has no target, no claims and no receipts, and the schedule file's
//! version/orphan-sweep semantics must not grow a second shape. Lives in the
//! state dir, never in the project tree.

use std::sync::{Mutex, OnceLock};

use crate::{
    schema::agent_prompts::{
        AgentPromptsFile, ProjectAgentPrompt, ProjectAgentPromptInput, PromptLink, PromptLinkInput,
        RecordedAgentPromptInput, SentAgentPrompt, SentAgentPromptInput,
    },
    services::{
        agent_session,
        agent_tasks::{
            self, sanitize_message, validate_id, validate_preface_command, MAX_MESSAGE_BYTES,
            MAX_PREFACE_COMMANDS,
        },
        prompt_blame::{self, RepoHead, MAX_BLAME_FILES},
    },
    storage,
};

const FILE_NAME: &str = "agent_prompts.json";
pub const MAX_PROMPTS_PER_PROJECT: usize = 64;
/// The history is a record, not an archive: it answers "what did I last send
/// where", so it is bounded and the oldest entries fall off rather than growing
/// this file without limit.
pub const MAX_HISTORY_PER_PROJECT: usize = 200;
const MAX_TAB_LABEL_BYTES: usize = 256;
const MAX_AGENT_BYTES: usize = 256;
/// Tags are labels, not sentences: a handful per prompt, each a short token.
/// The frontend's `lib/agents/prompt/tags` normalizes the same way and truncates
/// at 32 characters, so the byte cap here is the guard, not the editor.
pub const MAX_TAGS_PER_PROMPT: usize = 16;
pub const MAX_TAG_BYTES: usize = 64;
const MAX_BLAME_PATH_BYTES: usize = 1024;
/// The delivery outcomes a history entry may carry, mirroring the frontend's
/// `ScheduleResult`. Anything else is refused rather than stored as a word the
/// UI has no pill for.
const RESULTS: [&str; 3] = ["delivered", "missed", "failed"];
const LINK_KINDS: [&str; 2] = ["related", "after"];
const MAX_LINKS_PER_PROJECT: usize = 256;

static LOCK: OnceLock<Mutex<()>> = OnceLock::new();

/// The in-process mutex plus the file's `FileLock`: the Mobile sidecar
/// writes this file too (a fired schedule's history row, headless owner
/// plan H2), so the transaction has to hold across processes.
struct Guard {
    _file: Option<storage::FileLock>,
    _mutex: std::sync::MutexGuard<'static, ()>,
}

fn lock() -> Guard {
    let mutex = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    Guard { _file: storage::FileLock::exclusive(&path()).ok(), _mutex: mutex }
}

/// `<state_dir>/agent_prompts.json`.
pub fn file_path(state_dir: &std::path::Path) -> std::path::PathBuf {
    state_dir.join(FILE_NAME)
}

fn path() -> std::path::PathBuf {
    file_path(&storage::state_dir())
}

fn read_at(path: &std::path::Path) -> Result<AgentPromptsFile, String> {
    if !path.exists() {
        return Ok(AgentPromptsFile::default());
    }
    storage::read_json(path).map_err(|e| format!("read {FILE_NAME}: {e}"))
}

fn write_at(path: &std::path::Path, file: &AgentPromptsFile) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create state directory: {e}"))?;
    }
    storage::write_json_atomic(path, file).map_err(|e| format!("write {FILE_NAME}: {e}"))
}

fn read() -> Result<AgentPromptsFile, String> {
    let path = path();
    if !path.exists() {
        return Ok(AgentPromptsFile::default());
    }
    storage::read_json(&path).map_err(|e| format!("read {FILE_NAME}: {e}"))
}

fn write(file: &AgentPromptsFile) -> Result<(), String> {
    std::fs::create_dir_all(storage::state_dir())
        .map_err(|e| format!("create state directory: {e}"))?;
    storage::write_json_atomic(&path(), file).map_err(|e| format!("write {FILE_NAME}: {e}"))
}

/// One tag as it is stored: trimmed, without a leading `#`, lowercase, and
/// with inner whitespace folded to `-` so a tag is always one token. Empty
/// after that means "no tag", which the caller drops rather than stores.
pub fn normalize_tag(raw: &str) -> String {
    let clean = sanitize_message(raw);
    let trimmed = clean.trim().trim_start_matches('#').trim();
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_lowercase()
}

/// Normalize, drop empties, dedupe in order, and refuse a list or a tag the
/// file has no business holding.
pub fn validate_tags(tags: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for raw in tags {
        let tag = normalize_tag(raw);
        if tag.is_empty() || out.contains(&tag) {
            continue;
        }
        if tag.len() > MAX_TAG_BYTES {
            return Err(format!("a tag may be at most {MAX_TAG_BYTES} bytes"));
        }
        out.push(tag);
    }
    if out.len() > MAX_TAGS_PER_PROMPT {
        return Err(format!(
            "a prompt may carry at most {MAX_TAGS_PER_PROMPT} tags"
        ));
    }
    Ok(out)
}

fn validate_input(input: ProjectAgentPromptInput) -> Result<ProjectAgentPromptInput, String> {
    validate_id("prompt id", &input.id)?;
    let message = sanitize_message(&input.message);
    if message.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("prompt exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    let tags = match &input.tags {
        Some(tags) => Some(validate_tags(tags)?),
        None => None,
    };
    // An empty target is the clear request; anything else must be an id.
    let target = match input.target {
        Some(target) if target.trim().is_empty() => Some(String::new()),
        Some(target) => {
            validate_id("prompt target", &target)?;
            Some(target)
        }
        None => None,
    };
    if let Some(device) = &input.phone_device {
        validate_id("phone device", device)?;
    }
    Ok(ProjectAgentPromptInput {
        id: input.id,
        message,
        tags,
        target,
        phone_device: input.phone_device,
    })
}

/// Pure core of `upsert`, so the cap and the timestamp rules are testable
/// without a state dir.
fn apply_upsert(
    file: &mut AgentPromptsFile,
    project_id: &str,
    input: ProjectAgentPromptInput,
    now: &str,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    let prompts = file.projects.entry(project_id.to_string()).or_default();
    match prompts.iter().position(|item| item.id == input.id) {
        Some(index) => {
            prompts[index].message = input.message;
            prompts[index].updated_at = now.to_string();
            // `None` is an editor that did not speak about tags (the phone),
            // not one that cleared them.
            if let Some(tags) = input.tags {
                prompts[index].tags = tags;
            }
            // Same contract for the aimed tab: silence keeps it, `""` clears.
            if let Some(target) = input.target {
                prompts[index].target = Some(target).filter(|value| !value.is_empty());
            }
            // A phone's edit takes the prompt over (#2348); the desktop's
            // names no phone and keeps the stored one.
            if input.phone_device.is_some() {
                prompts[index].phone_device = input.phone_device;
            }
        }
        None => {
            if prompts.len() >= MAX_PROMPTS_PER_PROJECT {
                return Err(format!(
                    "a project may collect at most {MAX_PROMPTS_PER_PROJECT} prompts"
                ));
            }
            prompts.push(ProjectAgentPrompt {
                id: input.id,
                message: input.message,
                created_at: now.to_string(),
                updated_at: now.to_string(),
                tags: input.tags.unwrap_or_default(),
                target: input.target.filter(|value| !value.is_empty()),
                phone_device: input.phone_device,
            });
        }
    }
    Ok(prompts.clone())
}

fn validate_sent(input: SentAgentPromptInput) -> Result<SentAgentPromptInput, String> {
    let tab_label = sanitize_message(&input.tab_label).replace('\n', " ");
    let tab_label = tab_label.trim().to_string();
    if tab_label.is_empty() || tab_label.len() > MAX_TAB_LABEL_BYTES {
        return Err("invalid target tab label".into());
    }
    if let Some(session_id) = &input.session_id {
        validate_id("session id", session_id)?;
    }
    if let Some(tab_id) = &input.tab_id {
        validate_id("tab id", tab_id)?;
    }
    let agent = input.agent.as_ref().map(|agent| {
        sanitize_message(agent)
            .replace('\n', " ")
            .trim()
            .to_string()
    });
    let agent = match agent {
        Some(agent) if agent.is_empty() || agent.len() > MAX_AGENT_BYTES => {
            return Err("invalid agent command".into())
        }
        other => other,
    };
    if let Some(result) = &input.result {
        if !RESULTS.contains(&result.as_str()) {
            return Err(format!("invalid delivery result: {result}"));
        }
    }
    if let Some(scheduled_for) = &input.scheduled_for {
        validate_id("scheduled occurrence", scheduled_for)?;
    }
    if input.preface.len() > MAX_PREFACE_COMMANDS {
        return Err(format!(
            "a prompt may carry at most {MAX_PREFACE_COMMANDS} prefix commands"
        ));
    }
    let preface = input
        .preface
        .iter()
        .map(|command| validate_preface_command(command))
        .collect::<Result<Vec<_>, _>>()?;
    if let Some(sent_at) = &input.sent_at {
        if prompt_blame::iso_to_epoch(sent_at).is_none() {
            return Err(format!("invalid sent time: {sent_at}"));
        }
    }
    Ok(SentAgentPromptInput {
        schedule_origin: input.schedule_origin,
        tab_label,
        session_id: input.session_id,
        tab_id: input.tab_id,
        preface,
        agent,
        result: input.result,
        scheduled_for: input.scheduled_for,
        sent_at: input.sent_at,
    })
}

/// Push one entry onto a project's history, replacing an entry with the same
/// id rather than adding a second one — the scheduler records a send-now
/// prompt the collected list already archived under that id, and a delivery
/// must update that record, not duplicate it. The cap drops the oldest.
fn push_history(file: &mut AgentPromptsFile, project_id: &str, sent: SentAgentPrompt) {
    let history = file.history.entry(project_id.to_string()).or_default();
    // Ordering is by when it happened, so an entry that just became a delivery
    // moves to the end with the other recent ones — and a prompt recorded
    // after the fact (adopted from a transcript) lands among its neighbours.
    if let Some(index) = history.iter().position(|item| item.id == sent.id) {
        history.remove(index);
    }
    let at = prompt_blame::iso_to_epoch(&sent.sent_at);
    let index = match at {
        Some(at) => history
            .iter()
            .rposition(|item| prompt_blame::iso_to_epoch(&item.sent_at).is_none_or(|t| t <= at))
            .map_or(0, |i| i + 1),
        None => history.len(),
    };
    history.insert(index, sent);
    if history.len() > MAX_HISTORY_PER_PROJECT {
        let drop = history.len() - MAX_HISTORY_PER_PROJECT;
        history.drain(0..drop);
    }
}

/// Move one collected prompt out of the active list and onto the project's
/// history. Pure core so the move, the cap and the ordering are testable.
///
/// A prompt the caller no longer finds is NOT an error: the send already
/// happened by the time this runs, and failing here would leave the user with a
/// delivered prompt and an error dialog. It records what it can and returns.
fn apply_archive(
    file: &mut AgentPromptsFile,
    project_id: &str,
    prompt_id: &str,
    input: &SentAgentPromptInput,
    head: Option<&RepoHead>,
    roll: Option<&str>,
    now: &str,
) -> Option<SentAgentPrompt> {
    let prompt = file
        .projects
        .get(project_id)
        .and_then(|prompts| prompts.iter().find(|item| item.id == prompt_id))
        .cloned()?;
    // This is a move, not a deletion: keep links alive while the endpoint
    // crosses from `projects` to `history`, then prune against the final file.
    if let Some(prompts) = file.projects.get_mut(project_id) {
        prompts.retain(|item| item.id != prompt_id);
    }
    file.projects.retain(|_, prompts| !prompts.is_empty());
    let sent = SentAgentPrompt {
        schedule_origin: input.schedule_origin.clone(),
        id: prompt.id,
        message: prompt.message,
        created_at: prompt.created_at,
        sent_at: now.to_string(),
        tab_label: input.tab_label.clone(),
        session_id: input.session_id.clone(),
        tab_id: input.tab_id.clone(),
        preface: input.preface.clone(),
        agent: input.agent.clone(),
        result: input.result.clone(),
        scheduled_for: input.scheduled_for.clone(),
        tags: prompt.tags,
        commit: head.map(|head| head.commit.clone()),
        branch: head.and_then(|head| head.branch.clone()),
        files: Vec::new(),
        files_at: None,
        model: None,
    };
    push_history(file, project_id, sent.clone());
    link_session_roll(file, project_id, &sent, roll);
    prune_links(file, project_id);
    Some(sent)
}

/// Write one delivery onto the history. Unlike `apply_archive` there is no
/// collected prompt to retire: a schedule's text lives on the rule, and the
/// entry the history keeps is the only place it is written down once the rule
/// is retired. An entry already there under this id (the send-now prompt the
/// collected list archived at queue time) is updated in place, so a prompt is
/// listed once with the outcome it ended up having.
fn apply_record(
    file: &mut AgentPromptsFile,
    project_id: &str,
    entry: &RecordedAgentPromptInput,
    input: &SentAgentPromptInput,
    head: Option<&RepoHead>,
    roll: Option<&str>,
    now: &str,
) -> SentAgentPrompt {
    // The row this delivery updates, if the send already wrote one. What the
    // collected prompt brought with it — its collection time and its tags —
    // is the send's to keep, not the delivery's to drop.
    let existing = file
        .history
        .get(project_id)
        .and_then(|history| history.iter().find(|item| item.id == entry.id))
        .cloned();
    let created_at = entry
        .created_at
        .clone()
        .or_else(|| existing.as_ref().map(|item| item.created_at.clone()))
        .unwrap_or_else(|| now.to_string());
    // The delivery is when the agent actually started from the tree, so its
    // HEAD is the one that counts; the queue-time stamp stands in only when
    // the delivery could not read one.
    let (commit, branch) = match head {
        Some(head) => (Some(head.commit.clone()), head.branch.clone()),
        None => existing
            .as_ref()
            .map(|item| (item.commit.clone(), item.branch.clone()))
            .unwrap_or_default(),
    };
    let sent = SentAgentPrompt {
        schedule_origin: input.schedule_origin.clone(),
        id: entry.id.clone(),
        message: entry.message.clone(),
        created_at,
        sent_at: input.sent_at.clone().unwrap_or_else(|| now.to_string()),
        tab_label: input.tab_label.clone(),
        session_id: input.session_id.clone(),
        tab_id: input.tab_id.clone(),
        preface: input.preface.clone(),
        agent: input.agent.clone(),
        result: input.result.clone(),
        scheduled_for: input.scheduled_for.clone(),
        tags: existing
            .as_ref()
            .map(|item| item.tags.clone())
            .unwrap_or_default(),
        commit,
        branch,
        files: existing
            .as_ref()
            .map(|item| item.files.clone())
            .unwrap_or_default(),
        model: existing.as_ref().and_then(|item| item.model.clone()),
        files_at: existing.and_then(|item| item.files_at),
    };
    push_history(file, project_id, sent.clone());
    link_session_roll(file, project_id, &sent, roll);
    sent
}

/// The id of the edge the history draws by itself when a tab's session rolls:
/// one per new-session row, so a re-record of that row (a queued send turning
/// into its delivery) updates the edge instead of adding a second.
fn session_roll_link_id(row_id: &str) -> String {
    format!("roll:{row_id}")
}

/// Draw the edge a `/clear` (or `/resume`) leaves behind: `sent` is the first
/// row the tab wrote under a NEW session id, and `roll` is how the hook says
/// that session started. The tab's newest earlier row under another session
/// becomes the source — the chart shows the two session cards of one tab
/// joined, an `after` edge carrying `/clear` when that is what happened,
/// a plain `related` one when the session was resumed or the hook did not
/// say. Nothing is drawn for a row without a tab id or session id, for a
/// tab's first session, or when the project's links are full — the record
/// itself must never fail over its decoration.
fn link_session_roll(
    file: &mut AgentPromptsFile,
    project_id: &str,
    sent: &SentAgentPrompt,
    roll: Option<&str>,
) {
    let (Some(tab_id), Some(session_id)) = (sent.tab_id.as_deref(), sent.session_id.as_deref())
    else {
        return;
    };
    let Some(history) = file.history.get(project_id) else {
        return;
    };
    let Some(index) = history.iter().position(|row| row.id == sent.id) else {
        return;
    };
    let mut earlier = history[..index]
        .iter()
        .filter(|row| row.tab_id.as_deref() == Some(tab_id));
    // Only the first row of a session gets the edge; the rest of the session
    // fold into the same card on the chart.
    if earlier.clone().any(|row| row.session_id.as_deref() == Some(session_id)) {
        return;
    }
    let Some(previous) = earlier.rfind(|row| row.session_id.is_some()) else {
        return;
    };
    let (kind, preface) = match roll {
        Some("clear") => ("after", vec!["/clear".to_string()]),
        _ => ("related", Vec::new()),
    };
    let link = PromptLink {
        id: session_roll_link_id(&sent.id),
        from: previous.id.clone(),
        to: sent.id.clone(),
        kind: kind.to_string(),
        target: None,
        preface,
    };
    let _ = apply_link_upsert(file, project_id, link);
}

/// Resolve the tab's launch id the frontend sent as `session_id` to the live
/// session the hook recorded for it — the conversation the prompt actually
/// reached — keeping the launch id as `tab_id`. Returns how that session
/// started, for [`link_session_roll`]. A tab without a record (an agent that
/// fires no hooks, a remote tab, an id that is already the live one) keeps
/// what it sent.
fn resolve_live_session(
    project_id: &str,
    mut input: SentAgentPromptInput,
) -> (SentAgentPromptInput, Option<String>) {
    let Some(launch) = input.session_id.clone() else {
        return (input, None);
    };
    if input.tab_id.is_none() {
        input.tab_id = Some(launch.clone());
    }
    match agent_session::read_live_session_and_source_for(Some(project_id), &launch) {
        Some((live, source)) => {
            input.session_id = Some(live);
            (input, source)
        }
        None => (input, None),
    }
}

/// Write the files a delivered prompt touched, and the model that answered it,
/// onto its history row. Pure core of `blame`, so what is recorded is testable
/// without git or a transcript. `None` when the row is gone — the agent
/// finished, but the user cleared the history first. A model the transcript
/// could not name leaves whatever the row already holds.
fn apply_blame(
    file: &mut AgentPromptsFile,
    project_id: &str,
    entry_id: &str,
    files: Vec<String>,
    model: Option<String>,
    now: &str,
) -> Option<SentAgentPrompt> {
    let entry = file
        .history
        .get_mut(project_id)?
        .iter_mut()
        .find(|item| item.id == entry_id)?;
    entry.files = files;
    entry.files_at = Some(now.to_string());
    if model.is_some() {
        entry.model = model;
    }
    Some(entry.clone())
}

/// Put a project's collected prompts into the order the caller names.
///
/// The list is an ordered one — the prompt to send first belongs at the top —
/// and the order is the file's own, so a drag has to be written down somewhere
/// to survive a reload.
///
/// Ids the project does not have are ignored, and prompts the caller did not
/// name keep their relative order at the END: the caller reordered the list it
/// had, and a prompt collected (or arriving from another window) between that
/// read and this write must not be dropped just because the drag never saw it.
fn apply_reorder(
    file: &mut AgentPromptsFile,
    project_id: &str,
    ids: &[String],
) -> Vec<ProjectAgentPrompt> {
    let Some(prompts) = file.projects.get_mut(project_id) else {
        return Vec::new();
    };
    let mut ordered: Vec<ProjectAgentPrompt> = Vec::with_capacity(prompts.len());
    for id in ids {
        if ordered.iter().any(|item| &item.id == id) {
            continue;
        }
        if let Some(found) = prompts.iter().find(|item| &item.id == id) {
            ordered.push(found.clone());
        }
    }
    for prompt in prompts.iter() {
        if !ordered.iter().any(|item| item.id == prompt.id) {
            ordered.push(prompt.clone());
        }
    }
    *prompts = ordered;
    prompts.clone()
}

fn endpoint_ids(file: &AgentPromptsFile, project_id: &str) -> std::collections::HashSet<String> {
    file.projects
        .get(project_id)
        .into_iter()
        .flatten()
        .map(|item| item.id.clone())
        .chain(
            file.history
                .get(project_id)
                .into_iter()
                .flatten()
                .map(|item| item.id.clone()),
        )
        .collect()
}

fn prune_links(file: &mut AgentPromptsFile, project_id: &str) {
    let endpoints = endpoint_ids(file, project_id);
    if let Some(links) = file.links.get_mut(project_id) {
        links.retain(|link| endpoints.contains(&link.from) && endpoints.contains(&link.to));
    }
    file.links.retain(|_, links| !links.is_empty());
}

fn apply_delete(file: &mut AgentPromptsFile, project_id: &str, prompt_id: &str) {
    if let Some(prompts) = file.projects.get_mut(project_id) {
        prompts.retain(|item| item.id != prompt_id);
    }
    file.projects.retain(|_, prompts| !prompts.is_empty());
    prune_links(file, project_id);
}

fn validate_link(input: PromptLinkInput) -> Result<PromptLink, String> {
    validate_id("link id", &input.id)?;
    validate_id("link source", &input.from)?;
    validate_id("link target", &input.to)?;
    if input.from == input.to {
        return Err("a prompt link cannot point to itself".into());
    }
    if !LINK_KINDS.contains(&input.kind.as_str()) {
        return Err(format!("invalid prompt link kind: {}", input.kind));
    }
    if let Some(target) = &input.target {
        validate_id("schedule target", target)?;
    }
    if !input.preface.is_empty() && input.kind != "after" {
        return Err("only an after link can carry commands".into());
    }
    // The same rules a schedule's preface obeys, since this one becomes one.
    let preface = agent_tasks::validate_preface(input.preface)?;
    Ok(PromptLink {
        id: input.id,
        from: input.from,
        to: input.to,
        kind: input.kind,
        target: input.target,
        preface,
    })
}

/// The refusal an `after` edge gets when its target already leads back to its
/// source: two prompts each waiting on the other never start. Exact string —
/// the frontend matches it.
pub const LINK_CYCLE_ERROR: &str = "prompt_link_cycle";
/// The refusal when its target already waits on another prompt: a prompt goes
/// after ONE turn, and two sources finishing would queue it twice.
pub const LINK_JOIN_ERROR: &str = "prompt_link_join";

fn is_session_roll_link(id: &str) -> bool {
    id.starts_with("roll:")
}

/// Whether an edge may be written, as `lib/agents/prompt/links`' `afterLinkRefusal`
/// decides it: only `after` edges are judged, the edge's own id is skipped so
/// an existing edge can be re-saved, and the history's `roll:` edges are
/// exempt on both sides. Those are written by [`link_session_roll`], which
/// discards the result — a refusal there would silently drop the `/clear`
/// edge the history exists to draw — and they are not counted against a
/// manual edge either, since they join session cards, not queued prompts.
/// A re-save of an `after` edge already stored with the same ends (only its
/// preface or tab changes) adds no edge, so it is never refused: data written
/// before this check existed can hold a join, and editing one of its edges
/// must not demand the other be deleted first.
fn after_link_refusal(links: &[PromptLink], link: &PromptLink) -> Option<&'static str> {
    if link.kind != "after" || is_session_roll_link(&link.id) {
        return None;
    }
    let unchanged = links.iter().any(|item| {
        item.id == link.id && item.kind == "after" && item.from == link.from && item.to == link.to
    });
    if unchanged {
        return None;
    }
    let after: Vec<&PromptLink> = links
        .iter()
        .filter(|item| item.kind == "after" && item.id != link.id && !is_session_roll_link(&item.id))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![link.to.as_str()];
    while let Some(node) = stack.pop() {
        if node == link.from {
            return Some(LINK_CYCLE_ERROR);
        }
        if seen.insert(node) {
            stack.extend(after.iter().filter(|edge| edge.from == node).map(|edge| edge.to.as_str()));
        }
    }
    after
        .iter()
        .any(|edge| edge.to == link.to)
        .then_some(LINK_JOIN_ERROR)
}

fn apply_link_upsert(
    file: &mut AgentPromptsFile,
    project_id: &str,
    link: PromptLink,
) -> Result<Vec<PromptLink>, String> {
    let endpoints = endpoint_ids(file, project_id);
    if !endpoints.contains(&link.from) || !endpoints.contains(&link.to) {
        return Err("prompt link endpoint not found".into());
    }
    let existing = file.links.get(project_id).map(Vec::as_slice).unwrap_or_default();
    if let Some(refusal) = after_link_refusal(existing, &link) {
        return Err(refusal.into());
    }
    let links = file.links.entry(project_id.to_string()).or_default();
    if let Some(index) = links.iter().position(|item| item.id == link.id) {
        links[index] = link;
    } else {
        if links.len() >= MAX_LINKS_PER_PROJECT {
            return Err(format!(
                "a project may carry at most {MAX_LINKS_PER_PROJECT} prompt links"
            ));
        }
        links.push(link);
    }
    Ok(links.clone())
}

fn apply_link_delete(
    file: &mut AgentPromptsFile,
    project_id: &str,
    link_id: &str,
) -> Vec<PromptLink> {
    if let Some(links) = file.links.get_mut(project_id) {
        links.retain(|link| link.id != link_id);
    }
    file.links.retain(|_, links| !links.is_empty());
    file.links.get(project_id).cloned().unwrap_or_default()
}

pub fn list(project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    Ok(read()?
        .projects
        .get(project_id)
        .cloned()
        .unwrap_or_default())
}

/// [`list`] read from `state_dir` by a process that only reads this file —
/// the Mobile sidecar answering a phone with no window open.
pub fn list_at(state_dir: &std::path::Path, project_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let path = state_dir.join(FILE_NAME);
    let file: AgentPromptsFile = if path.exists() {
        storage::read_json(&path).map_err(|e| format!("read {FILE_NAME}: {e}"))?
    } else {
        AgentPromptsFile::default()
    };
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

pub fn upsert(
    project_id: &str,
    input: ProjectAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let input = validate_input(input)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_upsert(&mut file, project_id, input, &storage::iso_now())?;
    write(&file)?;
    Ok(result)
}

/// [`upsert`] on `state_dir`'s file by a process that shares it (the Mobile
/// sidecar editing a phone's collected prompt with no window open, headless
/// owner plan H3), under the file's lock alone.
pub fn upsert_at(
    state_dir: &std::path::Path,
    project_id: &str,
    input: ProjectAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let input = validate_input(input)?;
    let path = file_path(state_dir);
    let _lock = storage::FileLock::exclusive(&path).ok();
    let mut file = read_at(&path)?;
    let result = apply_upsert(&mut file, project_id, input, &storage::iso_now())?;
    write_at(&path, &file)?;
    Ok(result)
}

/// [`archive`] on `state_dir`'s file by a process that shares it (the
/// sidecar's send-now with no window open), under the file's lock alone.
/// The live session and the repo head are still read where the process's
/// own state dir says (the sidecar's is the same one).
pub fn archive_at(
    state_dir: &std::path::Path,
    project_id: &str,
    prompt_id: &str,
    input: SentAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let input = validate_sent(input)?;
    let (input, roll) = resolve_live_session(project_id, input);
    let head = prompt_blame::head(project_id);
    let path = file_path(state_dir);
    let _lock = storage::FileLock::exclusive(&path).ok();
    let mut file = read_at(&path)?;
    apply_archive(&mut file, project_id, prompt_id, &input, head.as_ref(), roll.as_deref(), &storage::iso_now());
    write_at(&path, &file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

pub fn delete(project_id: &str, prompt_id: &str) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let _guard = lock();
    let mut file = read()?;
    apply_delete(&mut file, project_id, prompt_id);
    write(&file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

pub fn links(project_id: &str) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    let mut file = read()?;
    prune_links(&mut file, project_id);
    Ok(file.links.get(project_id).cloned().unwrap_or_default())
}

pub fn link_upsert(project_id: &str, input: PromptLinkInput) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    let link = validate_link(input)?;
    let _guard = lock();
    let mut file = read()?;
    prune_links(&mut file, project_id);
    let result = apply_link_upsert(&mut file, project_id, link)?;
    write(&file)?;
    Ok(result)
}

pub fn link_delete(project_id: &str, link_id: &str) -> Result<Vec<PromptLink>, String> {
    validate_id("project id", project_id)?;
    validate_id("link id", link_id)?;
    let _guard = lock();
    let mut file = read()?;
    let result = apply_link_delete(&mut file, project_id, link_id);
    write(&file)?;
    Ok(result)
}

/// Persist a new order for a project's collected prompts. Every id is
/// validated before anything is written, so a malformed list is refused rather
/// than half-applied.
pub fn reorder(project_id: &str, ids: Vec<String>) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    for id in &ids {
        validate_id("prompt id", id)?;
    }
    let _guard = lock();
    let mut file = read()?;
    let result = apply_reorder(&mut file, project_id, &ids);
    write(&file)?;
    Ok(result)
}

pub fn history(project_id: &str) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    Ok(read()?.history.get(project_id).cloned().unwrap_or_default())
}

/// Retire a collected prompt to the history. Returns the remaining active
/// prompts, matching `delete` — the caller reloads the history separately.
pub fn archive(
    project_id: &str,
    prompt_id: &str,
    input: SentAgentPromptInput,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let input = validate_sent(input)?;
    let (input, roll) = resolve_live_session(project_id, input);
    // Read before the lock: it spawns git (local projects only), and nothing
    // in the file depends on it.
    let head = prompt_blame::head(project_id);
    let _guard = lock();
    let mut file = read()?;
    apply_archive(
        &mut file,
        project_id,
        prompt_id,
        &input,
        head.as_ref(),
        roll.as_deref(),
        &storage::iso_now(),
    );
    write(&file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

/// Record one delivery straight onto the history. Returns the project's
/// history, since — unlike `archive` — nothing on the active list moved.
pub fn record(
    project_id: &str,
    entry: RecordedAgentPromptInput,
) -> Result<Vec<SentAgentPrompt>, String> {
    let (entry, input, head, roll) = prepare_record(project_id, entry)?;
    let _guard = lock();
    let mut file = read()?;
    apply_record(&mut file, project_id, &entry, &input, head.as_ref(), roll.as_deref(), &storage::iso_now());
    write(&file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

/// [`record`] on `state_dir`'s file by a process that shares it — the Mobile
/// sidecar writing the history row of a schedule it fired with no window
/// open (headless owner plan, H2) — under the file's lock alone. The live
/// session and the repo head are still read where the process's own state
/// dir says (the sidecar's is the same one).
pub fn record_at(
    state_dir: &std::path::Path,
    project_id: &str,
    entry: RecordedAgentPromptInput,
) -> Result<Vec<SentAgentPrompt>, String> {
    let (entry, input, head, roll) = prepare_record(project_id, entry)?;
    let path = file_path(state_dir);
    let _lock = storage::FileLock::exclusive(&path).ok();
    let mut file = read_at(&path)?;
    apply_record(&mut file, project_id, &entry, &input, head.as_ref(), roll.as_deref(), &storage::iso_now());
    write_at(&path, &file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

/// [`delete`] on `state_dir`'s file (the sidecar retiring the collected
/// prompt a fired one-time rule carried), under the file's lock alone.
pub fn delete_at(
    state_dir: &std::path::Path,
    project_id: &str,
    prompt_id: &str,
) -> Result<Vec<ProjectAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("prompt id", prompt_id)?;
    let path = file_path(state_dir);
    let _lock = storage::FileLock::exclusive(&path).ok();
    let mut file = read_at(&path)?;
    apply_delete(&mut file, project_id, prompt_id);
    write_at(&path, &file)?;
    Ok(file.projects.get(project_id).cloned().unwrap_or_default())
}

type PreparedRecord = (RecordedAgentPromptInput, SentAgentPromptInput, Option<RepoHead>, Option<String>);

/// The validation and the reads outside the lock that [`record`] and
/// [`record_at`] share.
fn prepare_record(project_id: &str, entry: RecordedAgentPromptInput) -> Result<PreparedRecord, String> {
    validate_id("project id", project_id)?;
    validate_id("history entry id", &entry.id)?;
    let message = sanitize_message(&entry.message);
    if message.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    if message.len() > MAX_MESSAGE_BYTES {
        return Err(format!("prompt exceeds {MAX_MESSAGE_BYTES} bytes"));
    }
    let input = validate_sent(entry.sent.clone())?;
    let (input, roll) = resolve_live_session(project_id, input);
    let entry = RecordedAgentPromptInput { message, ..entry };
    let head = prompt_blame::head(project_id);
    Ok((entry, input, head, roll))
}

/// Record which files a delivered prompt touched, from the delivery (or
/// `since`, when the caller knows the moment the text was submitted better
/// than the row's `sent_at`) until now. Called once, when the scheduler sees
/// the tab idle again. Git runs OUTSIDE the lock — it is the slow part — and
/// the row is re-read afterwards, so a history cleared in between is not
/// resurrected. Returns the project's history.
pub fn blame(
    project_id: &str,
    entry_id: &str,
    since: Option<&str>,
) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    validate_id("history entry id", entry_id)?;
    let (commit, sent_at, agent, launch_id) = {
        let _guard = lock();
        let file = read()?;
        let entry = file
            .history
            .get(project_id)
            .and_then(|history| history.iter().find(|item| item.id == entry_id))
            .ok_or_else(|| "history entry not found".to_string())?;
        (
            entry.commit.clone(),
            entry.sent_at.clone(),
            entry.agent.clone(),
            // The launch id names the transcript; a row from before `tab_id`
            // was recorded carried the launch id as its session id.
            entry.tab_id.clone().or_else(|| entry.session_id.clone()),
        )
    };
    let since = match since {
        Some(value) if prompt_blame::iso_to_epoch(value).is_some() => value.to_string(),
        _ => sent_at,
    };
    let files = prompt_blame::files_touched(project_id, commit.as_deref(), &since);
    let files = files
        .into_iter()
        .filter(|path| path.len() <= MAX_BLAME_PATH_BYTES && !path.chars().any(char::is_control))
        .take(MAX_BLAME_FILES)
        .collect();
    // The tab is idle again, so the transcript's last answer is this prompt's:
    // the one moment the model that answered it can be read. A transcript
    // tail read, outside the lock like git.
    let model = agent.zip(launch_id).and_then(|(agent, launch_id)| {
        crate::services::agent_session::agent_session_model(&agent, Some(project_id), &launch_id)
    });
    let _guard = lock();
    let mut file = read()?;
    if apply_blame(&mut file, project_id, entry_id, files, model, &storage::iso_now()).is_some() {
        write(&file)?;
    }
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

/// Drop one history entry, or the whole project's history when `entry_id` is
/// `None`.
pub fn clear_history(
    project_id: &str,
    entry_id: Option<&str>,
) -> Result<Vec<SentAgentPrompt>, String> {
    validate_id("project id", project_id)?;
    let _guard = lock();
    let mut file = read()?;
    match entry_id {
        Some(entry_id) => {
            validate_id("history entry id", entry_id)?;
            if let Some(history) = file.history.get_mut(project_id) {
                history.retain(|item| item.id != entry_id);
            }
        }
        None => {
            file.history.remove(project_id);
        }
    }
    file.history.retain(|_, history| !history.is_empty());
    prune_links(&mut file, project_id);
    write(&file)?;
    Ok(file.history.get(project_id).cloned().unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(id: &str, message: &str) -> ProjectAgentPromptInput {
        ProjectAgentPromptInput {
            id: id.into(),
            message: message.into(),
            tags: None,
            target: None,
            phone_device: None,
        }
    }

    fn aimed(id: &str, message: &str, target: &str) -> ProjectAgentPromptInput {
        ProjectAgentPromptInput {
            target: Some(target.into()),
            ..input(id, message)
        }
    }

    fn tagged(id: &str, message: &str, tags: &[&str]) -> ProjectAgentPromptInput {
        ProjectAgentPromptInput {
            tags: Some(tags.iter().map(|t| t.to_string()).collect()),
            ..input(id, message)
        }
    }

    fn link(id: &str, from: &str, to: &str, kind: &str) -> PromptLinkInput {
        PromptLinkInput {
            id: id.into(),
            from: from.into(),
            to: to.into(),
            kind: kind.into(),
            target: Some("target-1".into()),
            preface: Vec::new(),
        }
    }

    fn head(commit: &str, branch: Option<&str>) -> RepoHead {
        RepoHead {
            commit: commit.into(),
            branch: branch.map(str::to_string),
        }
    }

    #[test]
    fn tags_are_normalized_deduped_and_capped() {
        let tags = validate_tags(&[
            " #Refactor ".into(),
            "unit tests".into(),
            "refactor".into(),
            "".into(),
            "#".into(),
        ])
        .unwrap();
        assert_eq!(tags, vec!["refactor", "unit-tests"]);
        assert!(validate_tags(&["x".repeat(MAX_TAG_BYTES + 1)]).is_err());
        let many: Vec<String> = (0..MAX_TAGS_PER_PROMPT + 1)
            .map(|i| format!("t{i}"))
            .collect();
        assert!(validate_tags(&many).is_err());
        assert!(validate_tags(&many[..MAX_TAGS_PER_PROMPT]).is_ok());
    }

    #[test]
    fn upsert_keeps_tags_unless_the_editor_names_them() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper", "tex"]), "t1").unwrap();
        // The phone edits the text and says nothing about tags: they stay.
        let prompts = apply_upsert(&mut file, "p", input("a", "two"), "t2").unwrap();
        assert_eq!(prompts[0].tags, vec!["paper", "tex"]);
        // An editor that names an empty list clears them.
        let prompts = apply_upsert(&mut file, "p", tagged("a", "two", &[]), "t3").unwrap();
        assert!(prompts[0].tags.is_empty());
        // A new prompt without tags starts untagged.
        let prompts = apply_upsert(&mut file, "p", input("b", "x"), "t4").unwrap();
        assert!(prompts[1].tags.is_empty());
    }

    #[test]
    fn upsert_keeps_target_unless_the_editor_names_it() {
        let mut file = AgentPromptsFile::default();
        let aimed_at = validate_input(aimed("a", "one", "tab-1")).unwrap();
        let prompts = apply_upsert(&mut file, "p", aimed_at, "t1").unwrap();
        assert_eq!(prompts[0].target.as_deref(), Some("tab-1"));
        // The phone edits the text and says nothing about the target: it stays.
        let prompts = apply_upsert(&mut file, "p", input("a", "two"), "t2").unwrap();
        assert_eq!(prompts[0].target.as_deref(), Some("tab-1"));
        // An editor that names an empty target clears it, and the cleared row
        // serializes without the key so older builds read it as before.
        let cleared = validate_input(aimed("a", "two", " ")).unwrap();
        assert_eq!(cleared.target.as_deref(), Some(""));
        let prompts = apply_upsert(&mut file, "p", cleared, "t3").unwrap();
        assert_eq!(prompts[0].target, None);
        assert!(!serde_json::to_string(&prompts[0]).unwrap().contains("target"));
        // A new prompt aimed with an empty target starts unaimed, and a target
        // that is not an id is refused before it reaches the file.
        let prompts = apply_upsert(&mut file, "p", aimed("b", "x", ""), "t4").unwrap();
        assert_eq!(prompts[1].target, None);
        assert!(validate_input(aimed("c", "x", "bad\u{1}id")).is_err());
    }

    /// #2348: a phone's create or edit names the phone (it takes a desktop
    /// prompt over); a desktop edit names none and keeps it.
    #[test]
    fn a_phone_edit_takes_a_prompt_over_and_a_desktop_edit_keeps_it() {
        let by = |id: &str, message: &str, phone: &str| ProjectAgentPromptInput {
            phone_device: Some(phone.into()),
            ..input(id, message)
        };
        let mut file = AgentPromptsFile::default();
        let prompts = apply_upsert(&mut file, "p", input("desk", "one"), "t1").unwrap();
        assert_eq!(prompts[0].phone_device, None);
        assert!(!serde_json::to_string(&prompts[0]).unwrap().contains("phone_device"));
        let prompts = apply_upsert(&mut file, "p", by("desk", "two", "phone-a"), "t2").unwrap();
        assert_eq!(prompts[0].phone_device.as_deref(), Some("phone-a"));
        let prompts = apply_upsert(&mut file, "p", input("desk", "three"), "t3").unwrap();
        assert_eq!(prompts[0].phone_device.as_deref(), Some("phone-a"), "the desktop's edit keeps it");
        let prompts = apply_upsert(&mut file, "p", by("desk", "four", "phone-b"), "t4").unwrap();
        assert_eq!(prompts[0].phone_device.as_deref(), Some("phone-b"));
        let prompts = apply_upsert(&mut file, "p", by("new", "x", "phone-a"), "t5").unwrap();
        assert_eq!(prompts[1].phone_device.as_deref(), Some("phone-a"));
        assert!(validate_input(by("c", "x", "bad\u{1}id")).is_err());
        // An older build's row (no field) reads back as desktop-made.
        let old: ProjectAgentPrompt = serde_json::from_str(
            r#"{"id":"o","message":"m","created_at":"t","updated_at":"t"}"#,
        )
        .unwrap();
        assert_eq!(old.phone_device, None);
    }

    #[test]
    fn prompt_links_validate_upsert_and_prune_with_endpoints() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_upsert(&mut file, "p", input("b", "two"), "t1").unwrap();
        let stored = apply_link_upsert(
            &mut file,
            "p",
            validate_link(link("l", "a", "b", "after")).unwrap(),
        )
        .unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].target.as_deref(), Some("target-1"));
        assert!(validate_link(link("x", "a", "a", "related")).is_err());
        assert!(validate_link(link("x", "a", "b", "unknown")).is_err());
        apply_delete(&mut file, "p", "b");
        assert!(!file.links.contains_key("p"));
    }

    #[test]
    fn an_after_link_carries_commands_and_a_related_one_cannot() {
        let with = |kind: &str, preface: &[&str]| PromptLinkInput {
            preface: preface.iter().map(|c| c.to_string()).collect(),
            ..link("l", "a", "b", kind)
        };
        let stored = validate_link(with("after", &[" /clear "])).unwrap();
        assert_eq!(stored.preface, vec!["/clear"]);
        assert!(serde_json::to_string(&stored).unwrap().contains("\"preface\""));
        // No commands: the key is omitted, so an older build reads the edge as before.
        let plain = validate_link(link("l", "a", "b", "after")).unwrap();
        assert!(!serde_json::to_string(&plain).unwrap().contains("preface"));
        assert!(validate_link(with("related", &["/clear"])).is_err());
        assert!(validate_link(with("after", &["clear"])).is_err());
        let many: Vec<&str> = vec!["/clear"; agent_tasks::MAX_PREFACE_COMMANDS + 1];
        assert!(validate_link(with("after", &many)).is_err());
    }

    #[test]
    fn an_after_link_that_closes_a_loop_or_joins_is_refused() {
        let mut file = AgentPromptsFile::default();
        for id in ["a", "b", "c", "d"] {
            apply_upsert(&mut file, "p", input(id, id), "t1").unwrap();
        }
        let put = |file: &mut AgentPromptsFile, id: &str, from: &str, to: &str, kind: &str| {
            apply_link_upsert(file, "p", validate_link(link(id, from, to, kind)).unwrap())
        };
        put(&mut file, "ab", "a", "b", "after").unwrap();
        assert_eq!(put(&mut file, "ba", "b", "a", "after"), Err(LINK_CYCLE_ERROR.to_string()));
        put(&mut file, "bc", "b", "c", "after").unwrap();
        assert_eq!(put(&mut file, "ca", "c", "a", "after"), Err(LINK_CYCLE_ERROR.to_string()));
        assert_eq!(put(&mut file, "dc", "d", "c", "after"), Err(LINK_JOIN_ERROR.to_string()));
        // A related edge is no sequence, and re-saving an edge is not a join with itself.
        put(&mut file, "dc", "d", "c", "related").unwrap();
        put(&mut file, "ca", "c", "a", "related").unwrap();
        put(&mut file, "bc", "b", "c", "after").unwrap();
        // Moving an existing edge onto a prompt that already waits is a join.
        assert_eq!(put(&mut file, "ab", "a", "c", "after"), Err(LINK_JOIN_ERROR.to_string()));
        assert_eq!(file.links["p"].len(), 4);
    }

    #[test]
    fn an_edge_of_a_join_written_before_the_check_can_still_be_edited() {
        let mut file = AgentPromptsFile::default();
        for id in ["a", "b", "c", "d"] {
            apply_upsert(&mut file, "p", input(id, id), "t1").unwrap();
        }
        // Stored before joins were refused: a and b both lead into c.
        let joined = ["ac", "bc"].map(|id| validate_link(link(id, &id[..1], "c", "after")).unwrap());
        file.links.insert("p".into(), joined.to_vec());
        let preface = PromptLinkInput {
            preface: vec!["/clear".into()],
            ..link("bc", "b", "c", "after")
        };
        let stored = apply_link_upsert(&mut file, "p", validate_link(preface).unwrap()).unwrap();
        let bc = stored.iter().find(|edge| edge.id == "bc").unwrap();
        assert_eq!(bc.preface, vec!["/clear".to_string()]);
        // Only an unchanged edge is exempt: a new edge or a changed end still joins.
        let put = |file: &mut AgentPromptsFile, id: &str, from: &str| {
            apply_link_upsert(file, "p", validate_link(link(id, from, "c", "after")).unwrap())
        };
        assert_eq!(put(&mut file, "dc", "d"), Err(LINK_JOIN_ERROR.to_string()));
        assert_eq!(put(&mut file, "bc", "d"), Err(LINK_JOIN_ERROR.to_string()));
        assert_eq!(file.links["p"].len(), 2);
    }

    #[test]
    fn a_session_roll_draws_its_edge_beside_a_manual_after_edge() {
        let mut file = AgentPromptsFile::default();
        let on = |id: &str, session: &str, sent_at: &str| RecordedAgentPromptInput {
            sent: SentAgentPromptInput {
                session_id: Some(session.into()),
                tab_id: Some("launch".into()),
                sent_at: Some(sent_at.into()),
                ..sent("Claude")
            },
            ..recorded(id, id, "delivered")
        };
        let a = on("a", "launch", "2026-09-15T08:00:00Z");
        apply_record(&mut file, "p", &a, &a.sent, None, Some("startup"), "t");
        let b = on("b", "launch", "2026-09-15T08:05:00Z");
        apply_record(&mut file, "p", &b, &b.sent, None, Some("startup"), "t");
        let c = on("c", "cleared", "2026-09-15T08:10:00Z");
        apply_record(&mut file, "p", &c, &c.sent, None, None, "t");
        // The user already made `c` wait on `a`…
        apply_link_upsert(&mut file, "p", validate_link(link("manual", "a", "c", "after")).unwrap()).unwrap();
        // …and the hook then says the session rolled by `/clear`: the history's
        // own edge into `c` is still drawn, though it counts as a second incoming one.
        apply_record(&mut file, "p", &c, &c.sent, None, Some("clear"), "t");
        let roll = file.links["p"].iter().find(|edge| edge.id == "roll:c").unwrap();
        assert_eq!((roll.from.as_str(), roll.kind.as_str()), ("b", "after"));
        assert!(file.links["p"].iter().any(|edge| edge.id == "manual"));
    }

    #[test]
    fn archive_keeps_a_link_when_the_endpoint_moves_to_history() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_upsert(&mut file, "p", input("b", "two"), "t1").unwrap();
        apply_link_upsert(
            &mut file,
            "p",
            validate_link(link("l", "a", "b", "after")).unwrap(),
        )
        .unwrap();
        apply_archive(&mut file, "p", "a", &sent("Claude"), None, None, "t2").unwrap();
        assert_eq!(file.links["p"].len(), 1);
    }

    #[test]
    fn archive_carries_tags_and_stamps_the_head() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper"]), "t1").unwrap();
        let moved = apply_archive(
            &mut file,
            "p",
            "a",
            &sent("Claude"),
            Some(&head("abcdef0123456789", Some("develop"))),
            None,
            "t2",
        )
        .unwrap();
        assert_eq!(moved.tags, vec!["paper"]);
        assert_eq!(moved.commit.as_deref(), Some("abcdef0123456789"));
        assert_eq!(moved.branch.as_deref(), Some("develop"));
        assert!(moved.files.is_empty());
        // Without a repo there is no blame, and no fake one either.
        apply_upsert(&mut file, "p", input("b", "two"), "t3").unwrap();
        let plain = apply_archive(&mut file, "p", "b", &sent("Claude"), None, None, "t4").unwrap();
        assert!(plain.commit.is_none() && plain.branch.is_none());
    }

    #[test]
    fn a_delivery_keeps_the_send_row_tags_and_takes_the_fresher_head() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", tagged("a", "one", &["paper"]), "t1").unwrap();
        apply_archive(
            &mut file,
            "p",
            "a",
            &sent("Claude"),
            Some(&head("1111111", Some("main"))),
            None,
            "t2",
        )
        .unwrap();
        let entry = recorded("a", "one", "delivered");
        // Delivered from a later commit: that is the one the agent started from.
        let row = apply_record(
            &mut file,
            "p",
            &entry,
            &entry.sent,
            Some(&head("2222222", None)),
            None,
            "t3",
        );
        assert_eq!(row.tags, vec!["paper"]);
        assert_eq!(row.commit.as_deref(), Some("2222222"));
        assert!(row.branch.is_none());
        // A delivery that could not read HEAD keeps what the send stamped.
        let row = apply_record(&mut file, "p", &entry, &entry.sent, None, None, "t4");
        assert_eq!(row.commit.as_deref(), Some("2222222"));
        // The blame lands on the row and survives a later re-record.
        let blamed = apply_blame(
            &mut file,
            "p",
            "a",
            vec!["src/a.rs".into()],
            Some("claude-opus-4-1-20250805".into()),
            "t5",
        )
        .unwrap();
        assert_eq!(blamed.files, vec!["src/a.rs"]);
        assert_eq!(blamed.files_at.as_deref(), Some("t5"));
        assert_eq!(blamed.model.as_deref(), Some("claude-opus-4-1-20250805"));
        let row = apply_record(&mut file, "p", &entry, &entry.sent, None, None, "t6");
        assert_eq!(row.files, vec!["src/a.rs"]);
        assert_eq!(row.model.as_deref(), Some("claude-opus-4-1-20250805"));
        // A blame whose transcript names no model keeps the one recorded.
        let blamed = apply_blame(&mut file, "p", "a", vec![], None, "t6").unwrap();
        assert_eq!(blamed.model.as_deref(), Some("claude-opus-4-1-20250805"));
        // A row that is gone records nothing.
        assert!(apply_blame(&mut file, "p", "missing", vec![], None, "t7").is_none());
        assert_eq!(file.history["p"].len(), 1, "still one prompt, one row");
    }

    #[test]
    fn upsert_keeps_created_at_and_moves_updated_at() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        let prompts = apply_upsert(&mut file, "p", input("a", "two"), "t2").unwrap();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].message, "two");
        assert_eq!(prompts[0].created_at, "t1");
        assert_eq!(prompts[0].updated_at, "t2");
    }

    #[test]
    fn projects_are_isolated_and_capped() {
        let mut file = AgentPromptsFile::default();
        for index in 0..MAX_PROMPTS_PER_PROJECT {
            apply_upsert(&mut file, "p", input(&format!("id-{index}"), "x"), "t").unwrap();
        }
        assert!(apply_upsert(&mut file, "p", input("overflow", "x"), "t").is_err());
        // Another project starts at zero.
        assert_eq!(
            apply_upsert(&mut file, "q", input("first", "x"), "t")
                .unwrap()
                .len(),
            1
        );
        apply_delete(&mut file, "q", "first");
        assert!(!file.projects.contains_key("q"));
        assert_eq!(file.projects["p"].len(), MAX_PROMPTS_PER_PROJECT);
    }

    #[test]
    fn reorder_follows_the_named_order_and_keeps_the_rest() {
        let mut file = AgentPromptsFile::default();
        for id in ["a", "b", "c"] {
            apply_upsert(&mut file, "p", input(id, id), "t").unwrap();
        }
        // A drag that moved `c` to the top, named against the list as read.
        let prompts = apply_reorder(&mut file, "p", &["c".into(), "a".into(), "b".into()]);
        assert_eq!(
            prompts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        // An unknown id is ignored, and a prompt the caller never saw — one
        // collected between its read and this write — survives at the end.
        apply_upsert(&mut file, "p", input("d", "d"), "t").unwrap();
        let prompts = apply_reorder(&mut file, "p", &["b".into(), "gone".into(), "b".into()]);
        assert_eq!(
            prompts.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["b", "c", "a", "d"]
        );
        // Another project is untouched, and an unknown one is not created.
        assert!(apply_reorder(&mut file, "q", &["a".into()]).is_empty());
        assert!(!file.projects.contains_key("q"));
    }

    fn sent(label: &str) -> SentAgentPromptInput {
        SentAgentPromptInput {
            schedule_origin: None,
            tab_label: label.into(),
            session_id: Some("session-1".into()),
            tab_id: None,
            preface: vec!["/clear".into()],
            agent: Some("claude".into()),
            result: None,
            scheduled_for: None,
            sent_at: None,
        }
    }

    #[test]
    fn a_prompt_recorded_after_the_fact_keeps_its_time_and_place() {
        let mut file = AgentPromptsFile::default();
        let at = |id: &str, sent_at: Option<&str>| RecordedAgentPromptInput {
            sent: SentAgentPromptInput {
                result: Some("delivered".into()),
                sent_at: sent_at.map(str::to_string),
                ..sent("Claude")
            },
            ..recorded(id, id, "delivered")
        };
        let input = at("late", None);
        apply_record(&mut file, "p", &input, &input.sent, None, None, "2026-09-15T08:30:00+00:00");
        let input = at("early", Some("2026-09-15T08:21:48.991Z"));
        apply_record(&mut file, "p", &input, &input.sent, None, None, "2026-09-15T08:31:00+00:00");
        let history = &file.history["p"];
        assert_eq!(history.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(), ["early", "late"]);
        assert_eq!(history[0].sent_at, "2026-09-15T08:21:48.991Z");
        assert!(validate_sent(SentAgentPromptInput { sent_at: Some("yesterday".into()), ..sent("Claude") }).is_err());
    }

    #[test]
    fn a_rolled_session_links_the_new_rows_to_the_tabs_previous_session() {
        let mut file = AgentPromptsFile::default();
        let on = |id: &str, session: &str, sent_at: &str| RecordedAgentPromptInput {
            sent: SentAgentPromptInput {
                session_id: Some(session.into()),
                tab_id: Some("launch".into()),
                sent_at: Some(sent_at.into()),
                ..sent("Claude")
            },
            ..recorded(id, id, "delivered")
        };
        let links = |file: &AgentPromptsFile| file.links.get("p").cloned().unwrap_or_default();
        // The tab's first session: nothing to join.
        let a = on("a", "launch", "2026-09-15T08:00:00Z");
        apply_record(&mut file, "p", &a, &a.sent, None, Some("startup"), "t");
        let b = on("b", "launch", "2026-09-15T08:05:00Z");
        apply_record(&mut file, "p", &b, &b.sent, None, Some("startup"), "t");
        assert!(links(&file).is_empty());
        // `/clear` rolled the id: the first row under the new one is joined to
        // the tab's newest earlier row by an `after` edge carrying `/clear`.
        let c = on("c", "cleared", "2026-09-15T08:10:00Z");
        apply_record(&mut file, "p", &c, &c.sent, None, Some("clear"), "t");
        let drawn = links(&file);
        assert_eq!(drawn.len(), 1);
        assert_eq!((drawn[0].from.as_str(), drawn[0].to.as_str(), drawn[0].kind.as_str()), ("b", "c", "after"));
        assert_eq!(drawn[0].preface, vec!["/clear".to_string()]);
        // The rest of the session fold into the same card: no second edge, and
        // a re-record of the first row updates its edge rather than doubling it.
        let d = on("d", "cleared", "2026-09-15T08:15:00Z");
        apply_record(&mut file, "p", &d, &d.sent, None, Some("clear"), "t");
        apply_record(&mut file, "p", &c, &c.sent, None, Some("clear"), "t");
        assert_eq!(links(&file).len(), 1);
        // A `/resume` (or a hook that did not say) joins with a plain edge.
        let e = on("e", "resumed", "2026-09-15T08:20:00Z");
        apply_record(&mut file, "p", &e, &e.sent, None, Some("resume"), "t");
        let drawn = links(&file);
        assert_eq!(drawn.len(), 2);
        assert_eq!((drawn[1].from.as_str(), drawn[1].to.as_str(), drawn[1].kind.as_str()), ("d", "e", "related"));
        assert!(drawn[1].preface.is_empty());
        // Another tab's session is not this tab's: no edge across tabs, and a
        // row without a tab id draws nothing.
        let other = RecordedAgentPromptInput {
            sent: SentAgentPromptInput {
                session_id: Some("elsewhere".into()),
                tab_id: Some("other-launch".into()),
                ..sent("Codex")
            },
            ..recorded("f", "f", "delivered")
        };
        apply_record(&mut file, "p", &other, &other.sent, None, Some("clear"), "t");
        let untagged = on("g", "fresh", "2026-09-15T08:30:00Z");
        let untagged = RecordedAgentPromptInput {
            sent: SentAgentPromptInput { tab_id: None, ..untagged.sent },
            ..untagged
        };
        apply_record(&mut file, "p", &untagged, &untagged.sent, None, Some("clear"), "t");
        assert_eq!(links(&file).len(), 2);
        // The edge lives on the history: a row that is gone takes its edge.
        file.history.get_mut("p").unwrap().retain(|row| row.id != "e");
        prune_links(&mut file, "p");
        assert_eq!(links(&file).len(), 1);
    }

    #[test]
    fn archive_moves_the_prompt_and_keeps_its_created_at() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        let moved = apply_archive(&mut file, "p", "a", &sent("Claude"), None, None, "t2").unwrap();
        assert_eq!(moved.created_at, "t1");
        assert_eq!(moved.sent_at, "t2");
        assert_eq!(moved.tab_label, "Claude");
        assert_eq!(moved.session_id.as_deref(), Some("session-1"));
        assert!(!file.projects.contains_key("p"));
        assert_eq!(file.history["p"].len(), 1);
        // A prompt that is already gone records nothing and does not panic.
        assert!(apply_archive(&mut file, "p", "a", &sent("Claude"), None, None, "t3").is_none());
    }

    #[test]
    fn history_is_capped_oldest_first() {
        let mut file = AgentPromptsFile::default();
        for index in 0..MAX_HISTORY_PER_PROJECT + 3 {
            let id = format!("id-{index}");
            apply_upsert(&mut file, "p", input(&id, "x"), "t").unwrap();
            apply_archive(&mut file, "p", &id, &sent("Claude"), None, None, "t").unwrap();
        }
        let history = &file.history["p"];
        assert_eq!(history.len(), MAX_HISTORY_PER_PROJECT);
        assert_eq!(history[0].id, "id-3");
        assert_eq!(
            history[history.len() - 1].id,
            format!("id-{}", MAX_HISTORY_PER_PROJECT + 2)
        );
    }

    fn recorded(id: &str, message: &str, result: &str) -> RecordedAgentPromptInput {
        RecordedAgentPromptInput {
            id: id.into(),
            message: message.into(),
            created_at: None,
            sent: SentAgentPromptInput {
                result: Some(result.into()),
                scheduled_for: Some("2026-09-02T09:00".into()),
                ..sent("Claude")
            },
        }
    }

    #[test]
    fn a_delivery_updates_the_entry_its_send_already_wrote() {
        let mut file = AgentPromptsFile::default();
        apply_upsert(&mut file, "p", input("a", "one"), "t1").unwrap();
        apply_archive(&mut file, "p", "a", &sent("Claude"), None, None, "t2").unwrap();
        // Queued: on the history, with no outcome yet.
        assert_eq!(file.history["p"].len(), 1);
        assert!(file.history["p"][0].result.is_none());

        let entry = recorded("a", "one", "delivered");
        let recorded = apply_record(&mut file, "p", &entry, &entry.sent, None, None, "t3");
        assert_eq!(file.history["p"].len(), 1, "one prompt, one row");
        assert_eq!(recorded.result.as_deref(), Some("delivered"));
        assert_eq!(recorded.sent_at, "t3");
        // The collection time survives the update; the send time moves.
        assert_eq!(recorded.created_at, "t1");
        assert_eq!(recorded.scheduled_for.as_deref(), Some("2026-09-02T09:00"));
        assert_eq!(recorded.agent.as_deref(), Some("claude"));
    }

    #[test]
    fn a_schedule_that_was_never_collected_records_a_new_row() {
        let mut file = AgentPromptsFile::default();
        let first = recorded("s1@2026-09-02T09:00", "daily standup", "delivered");
        apply_record(&mut file, "p", &first, &first.sent, None, None, "t1");
        let second = recorded("s1@2026-09-03T09:00", "daily standup", "missed");
        apply_record(&mut file, "p", &second, &second.sent, None, None, "t2");
        let history = &file.history["p"];
        assert_eq!(history.len(), 2, "each occurrence is its own row");
        assert_eq!(history[1].result.as_deref(), Some("missed"));
        assert!(file.projects.is_empty(), "nothing was collected");
    }

    #[test]
    fn send_facts_are_validated() {
        assert!(validate_sent(SentAgentPromptInput {
            tab_label: "   ".into(),
            ..sent("x")
        })
        .is_err());
        assert!(validate_sent(SentAgentPromptInput {
            tab_label: "Claude".into(),
            preface: vec!["clear".into()],
            ..sent("x")
        })
        .is_err());
        // A result the UI has no pill for is refused rather than stored.
        assert!(validate_sent(SentAgentPromptInput {
            result: Some("queued".into()),
            ..sent("Claude")
        })
        .is_err());
        assert!(validate_sent(SentAgentPromptInput {
            result: Some("delivered".into()),
            ..sent("Claude")
        })
        .is_ok());
        let clean = validate_sent(SentAgentPromptInput {
            tab_label: "Claude\u{1b}[31m".into(),
            session_id: None,
            preface: vec!["  /clear ".into()],
            ..sent("x")
        })
        .unwrap();
        assert_eq!(clean.tab_label, "Claude[31m");
        assert_eq!(clean.preface, vec!["/clear".to_string()]);
    }

    #[test]
    fn validation_sanitizes_and_rejects_empty_or_oversized() {
        assert!(validate_input(input("a", "  \r\n ")).is_err());
        assert!(validate_input(input("", "hello")).is_err());
        assert!(validate_input(input("a", &"x".repeat(MAX_MESSAGE_BYTES + 1))).is_err());
        let clean = validate_input(input("a", "one\r\ntwo\u{1b}[31m  ")).unwrap();
        assert_eq!(clean.message, "one\ntwo[31m");
    }
}
