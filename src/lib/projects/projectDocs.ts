import { invoke } from "@tauri-apps/api/core";

/**
 * The project's root docs and the agent CLIs' memories for it: wrappers for the
 * `commands/project_docs.rs` commands. The renderer sends a project id and a
 * name, never a path.
 */

/** `missing`: nothing is there (a ghost row when `creatable`). `template`: untouched text Tabtivity wrote. `pointer`: an untouched CLAUDE.md/GEMINI.md stub. `edited`: anything else — also a doc that is there but is a link, a FIFO, not UTF-8 or too large (never `missing`, so never offered for creation). */
export type DocState = "missing" | "template" | "edited" | "pointer";

export interface DocStatus {
  /** The leaf name in the project root, e.g. `AGENTS.md`. */
  name: string;
  state: DocState;
  /** The doc this one is shown beneath (`AGENTS.md` for a pointer file); nest only when that doc is itself in the list. */
  nestedUnder: string | null;
  /** The catalog allows creating it from its template. A ghost row is `state === "missing" && creatable`. */
  creatable: boolean;
}

/**
 * Where each catalog doc stands in the project's root folder, in catalog order:
 * every doc that is there, plus the creatable ones that are not (ghost rows).
 * `null` when the project has no local folder (remote-only, mirror not made yet,
 * folder gone). `.gitignore` and `.git` are not in it; the tree lists them.
 */
export function projectDocsStatus(projectId: string): Promise<DocStatus[] | null> {
  return invoke<DocStatus[] | null>("project_docs_status", { projectId });
}

/**
 * Create one doc from its template. Resolves `true` when it was written and
 * `false` when anything already sits at that name (nothing is overwritten).
 * Rejects for a name that is not a creatable catalog entry or a project with no
 * local folder.
 */
export function createProjectDoc(projectId: string, name: string): Promise<boolean> {
  return invoke<boolean>("create_project_doc", { projectId, name });
}

/** Which CLI's memory a file is. */
export type AgentMemoryCli = "claude" | "codex";
/** Which of the project scope's agent homes it is in (`local` = the local-model home). */
export type AgentMemoryHome = "scope" | "local";

export interface AgentMemoryEntry {
  cli: AgentMemoryCli;
  home: AgentMemoryHome;
  /** The file's leaf name, e.g. `MEMORY.md`. */
  name: string;
  bytes: number;
  /** Unix seconds; `null` when the platform gave none. */
  modifiedSecs: number | null;
}

/** The memory files the agent CLIs hold for the project (Claude's, `MEMORY.md` first, then Codex's); empty when there are none. Read-only. */
export function projectAgentMemory(projectId: string): Promise<AgentMemoryEntry[]> {
  return invoke<AgentMemoryEntry[]>("project_agent_memory", { projectId });
}

/** One memory file as text; `cli`, `home` and `name` come from the listing. Rejects when it is not in the listing any more. */
export function projectAgentMemoryRead(projectId: string, entry: Pick<AgentMemoryEntry, "cli" | "home" | "name">): Promise<string> {
  return invoke<string>("project_agent_memory_read", { projectId, cli: entry.cli, home: entry.home, name: entry.name });
}
