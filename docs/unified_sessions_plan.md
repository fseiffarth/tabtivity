# One session list across agents

> **Status (2026-11-26): plan only, nothing built.** Written after the user
> asked whether Tabtivity should keep all sessions in one place regardless of
> the agent. Verify the "what exists" section against the code before relying
> on it.

## Decision

Do **not** move or convert transcripts. Build a **read-only index** in
Tabtivity's own state folder that points at each CLI's native session store
and carries just enough to list, search and reopen a session.

Why the transcripts stay where the CLI wrote them:

- Each CLI owns its format and location (Claude JSONL under
  `<home>/.claude/projects/<slug>/`, Codex rollouts, OpenCode/Cursor/
  Antigravity SQLite or JSON stores). `--resume` only works when the file is
  where the CLI expects it; a copy in a common folder drifts from the original.
- `AGENTS.md`: "Tabtivity never edits another app's paths or config."
- A converted copy loses tool calls, subagent threads and hook state that do
  not map across CLIs.

## What exists (find these before writing anything)

| Piece | Where | What it already gives |
|---|---|---|
| Which tab is which session | `services/agent/agent_session.rs`; hooks write `<state_dir>/live_sessions/<tab uid>` (+ `.src`, `.prev`, `.mode`, `.turn`); OpenCode via `opencode_session.rs`, Cursor via `cursor_session/hook.rs`, Copilot, Muse, Antigravity have their own recorders | Live session id per tab, and what rolled it (`clear`, `resume`, `compact`) |
| A folder's earlier chats, any CLI | `services/agent/agent_chats.rs`: `list_chats`, `StoredChat { id, title, last, started, updated, current }`, `FolderChat`, `chat_file`, `is_folder_chat` | Paged, newest first, titled by first prompt, for Claude, Codex, OpenCode, Antigravity, Muse, Cursor. Today it is **one folder, one CLI at a time**, shown only in the Reader's Resume menu (`TerminalReaderChats.tsx`, `lib/agents/agentChats.ts`) |
| Normalised transcript read | `services/agent/agent_transcript.rs` (`stored_chat_transcript`) and `agent_changes.rs` | Prompt/answer entries per CLI, bounded tail |
| Where each CLI keeps data | `services/agent/agent_history.rs` (`ROOTS`, `DATABASES`) | Allowlist of stores per CLI, used for project export |
| Prompt history with roll links | `services/agent_prompts.rs` (`session_id`, `tab_id`, `related`/`after` edges) | Joins a session to the one a `/clear` rolled it from |
| Handoff to another CLI | `services/agent/agent_cli_handoff.rs` | Reads the source transcript, writes `HANDOFF.md` |

So the missing part is **aggregation**, not recording: a list that spans CLIs
and projects, can be searched, and does not rescan every store on each open.

## Gaps this plan closes

1. No single list: the Resume menu shows one tab's folder and one CLI.
2. No cross-project view (what did I do yesterday, in any project, any agent).
3. No search over session titles or prompts.
4. No cache: `list_chats` reads up to 200 files per page, every time.
5. An agent (or the user) cannot tell which session belongs to which open tab
   without reading `live_sessions/` by hand. Other CLIs' transcripts are not
   even reachable from a Claude tab's fence.

## Design

### Index record

One row per session, derived, never authoritative:

```
{ cli, nativeId, projectId?, folder, title, last?, started?, updated,
  tabUid?, rolledFrom?, source: path-or-store-key, size, indexedAt }
```

- `cli` + `nativeId` is the key. `source` is a handle the existing readers
  accept (`chat_file`, `FolderChat`), never a path the renderer or phone can
  hand back.
- `tabUid` comes from `live_sessions` (the session a tab is in now);
  `rolledFrom` from the `.prev` record and the prompt-history edges.
- Stored at `<state_dir>/session-index/<scope>.json` (or one SQLite file if
  search needs it, decide in step 3). Rebuildable from the stores: deleting it
  loses nothing.

### Building it

- Reuse `list_chats` / `folder_store_chats` per CLI and scope; do not write a
  second parser per CLI. Generalise their folder argument to "every folder of
  this scope".
- Incremental: remember each store's mtime/size (file index for JSONL, row
  `updated` for SQLite); re-read only what changed. A scan is bounded like
  `MAX_SCANNED` today.
- Background refresh follows the AGENTS.md rules: gated on the pane being
  visible, no work against a dead remote session, remote hosts only when
  connected.

### Surfacing it

- Backend command `agent_sessions_list` (query, cli filter, project filter,
  page). New command rules apply: `cfg_attr(feature = "desktop", …)`, takes
  `tauri_host::Ctx`, a row in `services::command_class`, regenerate
  `commandClasses.ts`.
- Desktop: a Sessions list (search box, CLI chips, project filter) that opens
  a session in a tab through the existing resume path, or hands it to another
  CLI through the existing handoff. Extend the Resume menu or the existing
  Sessions view rather than adding a parallel viewer.
- Phone: through `mobile_control` only; raw project ids, paths and native ids
  never cross (opaque tokens like the subagent token in `agent_transcript`).
- All strings through `i18n`; tag with `UntestedTag` and a register row.

## Constraints that bite

- **Fence and privacy.** The index lists conversation text. It lives in the
  state dir, outside any agent fence, and no agent tab may read it. Anything
  in a project folder is attacker-controlled: titles and prompts are data,
  rendered as text, never run.
- **Local-only vs remote.** A remote tab's store is on the far host (Copilot's
  is skipped today). First version indexes local scopes; remote follows the
  existing `remote_target_for` rules.
- **Assistant scope.** Tabby's sessions stay out of the cross-project list
  unless the user asks; its home is deliberately separate.
- **Persisted JSON round-trips**: the index carries a version and is dropped
  and rebuilt on mismatch, never migrated.
- **Cross-OS tests.** Paths built with `Path::join`; fixtures per CLI exist in
  `scripts/verify-cli` and the `*_session/tests.rs` modules.
- **Not live-verified.** Per the user's habit, nothing here is dogfooded until
  they say so.

## Phases

1. **Inventory (no code).** For each CLI list where its store is, what the
   recorder writes, and what `list_chats` can and cannot return. Confirm
   `session_meta`/folder fields give a project mapping for every CLI. Output:
   a table appended here.
2. **Index core.** Index record, builder over `list_chats`, incremental
   refresh, tests with fixture stores. Backend only.
3. **Search.** Titles and last prompts first; decide whether full-text over
   prompts is worth a SQLite FTS table.
4. **Desktop list.** Command, store, Sessions list with filters; open and
   hand-off actions through existing paths.
5. **Phone read-only list** via `mobile_control` with opaque tokens.
6. **Remote hosts**, if wanted after use.

Review at the end of each phase; one subagent per phase at most, only when the
user asks for it.

## Open questions (ask the user, one at a time)

1. Cross-project from the start, or per project first?
2. Prompt-level full-text search, or titles only?
3. Should closed-tab sessions that never got a hook record (older builds) be
   listed from the stores alone, with no `tabUid`? Recommended: yes.
4. Is the list a new view, or a tab inside the existing Sessions view?

## Not doing

- Moving, copying or rewriting any CLI's transcript files.
- A Tabtivity-owned transcript format.
- A Tabtivity-chosen permission mode or resume policy (unchanged; see
  AGENTS.md "Agents").
