//! The documents an Antigravity chat wrote for the user — its plans, task
//! lists and walkthroughs — which the CLI keeps in its own state, outside the
//! project: `<home>/.gemini/antigravity-cli/brain/<conversation>/<name>.md`.
//! An answer points at one as `[plan.md](file:///…/brain/<id>/plan.md)`, a
//! path no project link may resolve (`commands::fs::resolve_text_paths` only
//! answers inside the project's folders).
//!
//! The link is the agent's word, so whatever the project fed it. It opens
//! only a file of **this tab's own conversation**, read-only:
//!
//! - the conversation id comes from the tab's hook record
//!   ([`crate::services::google_chat::recorded_tab_conversation`]), never from
//!   the link; a link into another conversation's folder, or outside `brain`,
//!   names nothing;
//! - the target is cut to the part after `brain/<that id>/` and checked name by
//!   name (no `..`, no hidden name — `.system_generated` holds the CLI's logs);
//! - the file is opened by handle below the scope's agent home
//!   (`home_io`: a link at any component is refused) and read with a size cap;
//! - only text comes back, and only as text: the caller shows it, never runs it.
//!
//! AppHandle-free; the phone's `GET /api/v1/tabs/{id}/artifact` and the
//! desktop's Chat both call [`read_for_tab`].

use std::path::Path;

use serde::Serialize;

use crate::services::home_io::HomeDir;

/// The largest document read (a plan is a few KB; a log is not one).
pub const MAX_BYTES: u64 = 1024 * 1024;
/// The deepest the name may nest under the conversation's folder.
const MAX_DEPTH: usize = 4;
/// Where Antigravity keeps a conversation's documents, under an agent home.
const BRAIN: &str = ".gemini/antigravity-cli/brain";
/// Extensions read as text.
const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "log", "json", "yaml", "yml", "toml", "csv", "tsv"];

/// One document: its leaf name and its text.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Artifact {
    pub name: String,
    pub text: String,
}

/// The names below `brain/<conversation>/` that `target` — a `file://` link
/// or an absolute path as the agent wrote it — points at, or `None` when it
/// is not a path into that folder. Pure string work: nothing is opened.
pub fn artifact_names(target: &str, conversation: &str) -> Option<Vec<String>> {
    if conversation.is_empty() || conversation.contains(['/', '\\']) {
        return None;
    }
    let target = target.trim();
    let path = match target.strip_prefix("file://") {
        // `file:///home/x/…` — the authority is empty (a host name is not ours).
        Some(rest) if rest.starts_with('/') => decode(rest)?,
        Some(_) => return None,
        None if target.starts_with('/') => target.to_string(),
        None => return None,
    };
    if path.contains(['\0', '\\']) {
        return None;
    }
    let parts: Vec<&str> = path.split('/').collect();
    let at = parts.iter().position(|part| *part == "brain")?;
    if parts.get(at + 1) != Some(&conversation) {
        return None;
    }
    let names: Vec<String> = parts[at + 2..].iter().map(|part| part.to_string()).collect();
    let plain = |name: &String| !name.is_empty() && !name.starts_with('.') && name.len() <= 255;
    (!names.is_empty() && names.len() <= MAX_DEPTH && names.iter().all(plain)).then_some(names)
}

/// `%XX` escapes in a file URL's path undone; `None` for a bad escape or
/// bytes that are not UTF-8.
fn decode(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The text of the document `target` names in conversation `conversation`'s
/// folder under the agent home `home`; `None` for anything else — no such
/// file, a link, a name that is not text, a file over [`MAX_BYTES`].
pub fn read(home: &Path, conversation: &str, target: &str) -> Option<Artifact> {
    if !crate::services::agent_session::is_uuid_shaped(conversation) {
        return None;
    }
    let names = artifact_names(target, conversation)?;
    let (leaf, folders) = names.split_last()?;
    let extension = leaf.rsplit_once('.')?.1.to_ascii_lowercase();
    if !TEXT_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let mut dir = HomeDir::open_existing(home, BRAIN)?.open_subdir(conversation)?;
    for folder in folders {
        dir = dir.open_subdir(folder)?;
    }
    let bytes = dir.file(leaf)?.read_capped(MAX_BYTES)?;
    Some(Artifact { name: leaf.clone(), text: String::from_utf8(bytes).ok()? })
}

/// The document `target` names for the Antigravity tab launched with id
/// `launch_id` in `tab_dir` under project `project_id`: its conversation is
/// found by the tab's record, so only that conversation's folder is read.
pub fn read_for_tab(project_id: Option<&str>, tab_dir: &str, launch_id: &str, target: &str) -> Option<Artifact> {
    if !Path::new(tab_dir).is_absolute() || project_id.is_some_and(|id| crate::services::remote::remote_target_for(id).is_some()) {
        return None;
    }
    let home = crate::services::agent_home::scope_home(project_id);
    let conversation = crate::services::google_chat::recorded_tab_conversation(&home, tab_dir, project_id, launch_id)?;
    read(&home, &conversation, target)
}

#[cfg(test)]
mod tests;
