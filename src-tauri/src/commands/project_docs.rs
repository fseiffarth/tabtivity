//! The project's root docs as the file listing shows them (status per catalog
//! entry, create one on demand) and the agent CLIs' memories for the project
//! (listed and read, read-only). Plan: `docs/done/scaffold_files_plan.md` §4, §5.
//!
//! The renderer sends a project id and a *name* — a catalog entry, or a memory
//! file's `(cli, home, name)` — never a path. `*_blocking` bodies on a worker:
//! they read the project tree and the agent home (see AGENTS.md).

use std::path::PathBuf;

use crate::commands::projects::scaffold_target_for_entry;
use crate::services::agent_home;
use crate::services::agent_memory::{self, MemoryEntry, Source};
use crate::services::scaffold::{self, DocStatus};

/// The local folder of a project that has one (`None`: unknown project, a
/// remote-only one, a mirror not made yet, a folder that is gone).
fn local_dir(project_id: &str) -> Result<Option<PathBuf>, String> {
    let Some(entry) = crate::services::remote::projects()?.iter().find(|p| p.id == project_id).cloned() else {
        return Ok(None);
    };
    Ok(scaffold_target_for_entry(&entry).map(|(dir, _)| dir).filter(|dir| dir.is_dir()))
}

/// Where each catalog doc stands in the project's root folder, in catalog
/// order: every doc that is there, plus the `creatable` ones that are not
/// (ghost rows). `None` when the project has no local folder to look at
/// (remote-only, mirror not made yet, folder gone). A doc that is there but
/// not a plain readable file (link, FIFO, non-UTF-8, over the cap) is
/// `edited`, never `missing`. `.gitignore` and `.git` are not in the list.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn project_docs_status(project_id: String) -> Result<Option<Vec<DocStatus>>, String> {
    app_core::rt::try_blocking("project", move || project_docs_status_blocking(&project_id)).await
}

fn project_docs_status_blocking(project_id: &str) -> Result<Option<Vec<DocStatus>>, String> {
    Ok(local_dir(project_id)?.map(|dir| scaffold::docs_status_at(&dir)))
}

/// Create one catalog doc from its template in the project's root folder.
/// `name` must be a `creatable` catalog entry (a leaf name; anything else —
/// a path, an unknown name, a pointer file, `REMARKS.md` — is refused).
/// Returns whether the file was written: `false` when anything already sits at
/// that name (never overwritten, never followed).
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn create_project_doc(project_id: String, name: String) -> Result<bool, String> {
    app_core::rt::try_blocking("project", move || create_project_doc_blocking(&project_id, &name)).await
}

fn create_project_doc_blocking(project_id: &str, name: &str) -> Result<bool, String> {
    let doc = scaffold::doc(name)
        .filter(|d| d.creatable)
        .ok_or_else(|| format!("'{name}' is not a doc that can be created"))?;
    let dir = local_dir(project_id)?.ok_or_else(|| "this project has no local folder to create it in".to_string())?;
    scaffold::create_doc_at(&dir, doc).map_err(|e| e.to_string())
}

/// The agent homes of a project's scope and the project folders to look under.
type MemorySources = (Vec<Source>, Vec<PathBuf>);

fn memory_sources(project_id: &str) -> Result<Option<MemorySources>, String> {
    let Some(dir) = local_dir(project_id)? else {
        return Ok(None);
    };
    let sources = vec![
        Source { kind: agent_memory::HOME_SCOPE, home: agent_home::scope_home(Some(project_id)) },
        Source { kind: agent_memory::HOME_LOCAL, home: agent_home::local_model_home(Some(project_id)) },
    ];
    Ok(Some((sources, vec![dir])))
}

/// The memory files the agent CLIs hold for the project, read from the
/// project scope's agent home (and its local-model home): Claude's auto memory
/// (`MEMORY.md` first) then Codex's memories. Empty when the project has no
/// local folder, no memory, or a CLI keeps it somewhere this does not look.
/// Read-only; the user edits these through the CLI.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn project_agent_memory(project_id: String) -> Result<Vec<MemoryEntry>, String> {
    app_core::rt::try_blocking("project", move || project_agent_memory_blocking(&project_id)).await
}

fn project_agent_memory_blocking(project_id: &str) -> Result<Vec<MemoryEntry>, String> {
    Ok(memory_sources(project_id)?.map(|(sources, dirs)| agent_memory::list(&sources, &dirs)).unwrap_or_default())
}

/// One memory file as text. `cli`, `home` and `name` are echoed from the
/// listing; a name that is not in it (or not readable any more) is an error.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn project_agent_memory_read(
    project_id: String,
    cli: String,
    home: String,
    name: String,
) -> Result<String, String> {
    app_core::rt::try_blocking("project", move || project_agent_memory_read_blocking(&project_id, &cli, &home, &name))
        .await
}

fn project_agent_memory_read_blocking(project_id: &str, cli: &str, home: &str, name: &str) -> Result<String, String> {
    let (sources, dirs) = memory_sources(project_id)?.ok_or_else(|| "this project has no local folder".to_string())?;
    agent_memory::read(&sources, &dirs, cli, home, name).ok_or_else(|| "that memory file is not there".to_string())
}

#[cfg(test)]
mod tests;
