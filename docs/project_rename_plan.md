# Lossless project rename — plan

Status: plan only (2026-10-06). Nothing below is implemented.

## Goal
Any project can get a new name and a new folder name without losing
anything. Afterwards everything works as before:
- every agent conversation: `--resume`, "continue last", Claude memory,
  prompt history, token totals;
- worktrees, git hooks, exec approvals;
- tabs and layout;
- box links;
- the project's venv.

The first real use is this checkout: `ProjectEldrun` /
`~/eldrun/projects/projecteldrun` → `Tabtivity` / `~/eldrun/projects/tabtivity`
(see "First use" below).

The feature already half exists. The project pill's Rename window
(`RenameWindow`, `src/components/projects/ProjectPill.tsx:224`) changes the
display name (`set_project_name`, `commands/projects.rs:1397`). Its untested
"Also rename folder" switch renames the folder: `plan_project_dir_rename` /
`rename_project_dir` (`projects.rs:1544,1599`), via `renameProjectFolder`
(`stores/projects.ts:1587`), which closes and reopens an open project. The
dialog itself warns that it is lossy: "Agent conversations started in the old
folder can't be resumed from the new one" (`pill.folderRenameAgentNote`).
This plan makes that same window lossless. There is no second rename feature
(one dialog, one command, extended).

## Scope
- **In:** local projects, closed or open (it is closed and reopened, as
  today), renaming the folder within its parent. Remote projects: the name and
  the local mirror folder (`move_remote_mirror`, `projects.rs:2863`), through
  the same engine.
- **Out (v1):**
  - VM projects (stay `unsupported`);
  - renaming the folder *on a remote host*: remote agents keep their history
    in the host's home, which the app does not own;
  - moving to another parent folder: that is Phase M's tree move, which
    reuses this engine;
  - renaming the git hosting repo (GitHub/GitLab) — a later, separate
    option.

## What a rename has to carry
`rename_project_dir` already re-points:
- `projects.json` (all string values, `storage::rewrite_path_prefix`);
- the project's `project.json`;
- saved tabs (`terminal_service::rewrite_session_paths`);
- linked worktrees whose `.git/worktrees/*/gitdir` named the old folder
  (`repair_moved_worktrees`, hardened git).

Already path-free, keyed by project id: session dirs, agent homes, scheduled
prompts, byte-sync manifests (`remote_sync::manifest_path`), the phone API.
Worker sync ships to the worker's `remote_path` and never sends the local
path.

Missing (counts in brackets are this checkout's on 2026-10-06, to size the
work):

| Holder | Where | Without a carry |
|---|---|---|
| Claude transcripts + memory | every agent home's `.claude/projects/<encoded cwd>` for the folder and anything under it (worktrees, `target/freeze-tree`) [15 dirs, 1.7 GB, 167 memory files] | `--resume` fails, memory gone |
| Claude config | `.claude.json` `projects["<dir>"]`, `.claude/history.jsonl` `project` [1,746 lines] | trust/allowed tools asked again, up-arrow history empty |
| Token stats | `token_stats.json` cursor keys (home-relative transcript paths, `token_stats.rs:10-16`) | totals counted twice, or moved to `retired` |
| Codex | `config.toml` `[projects."<dir>"]`; rollout `session_meta.cwd`; `state_<n>.sqlite` threads | trust asked again; resume **unverified** |
| Cursor | `.cursor/projects/<encoded>/`; `.cursor/chats/<md5(dir)>/` (md5 matched here) | trust asked again; chats unreachable |
| Copilot | `config.json` trusted folders; `session-state/*/workspace.yaml` | trust asked again; resume **unverified** |
| Antigravity, Gemini, Qwen, opencode, Grok, Droid, Vibe | per-CLI cwd stores (**unverified**) | "continue last" may start fresh |
| Exec approvals | `exec_trust.json` keys `"<kind>:<dir>"` (`exec_trust.rs:147`) | hook/latexmk/prettier approvals asked again |
| Repo git config | `.git/config` path values naming the folder: `core.hooksPath` (this checkout has an absolute one), `include.path`, worktree `config.worktree` | **hooks silently stop running** |
| Venvs inside the folder | `bin/*` shebangs, `bin/activate*` `VIRTUAL_ENV` | scripts and `pip` break until recreated |
| Boxes | member link named after the project + absolute root in the doc block (`boxes.rs:263-290`) | stale/broken link until `refresh_box_agent_docs` |
| Project container | mounts are in the spec fingerprint (`sandbox.rs`), so the next `up` recreates it | its writable layer (packages installed outside the folder) is lost |
| Frontend `localStorage` | possible absolute-path keys (recent files, viewer snapshots) — **survey** | per-file view state reset |
| Inside the folder, not app-owned | `.claude/settings*.json` allow rules, editor workspaces, scripts with absolute paths | rules stop matching |
| cargo `target/` and similar caches | absolute paths in fingerprints | not lost: a full rebuild |

Every agent home is scanned, not only the project's own: the root console's
home (`agent-homes/root`) and other scopes can hold sessions whose cwd was
inside this folder.

## Decisions (recommendations; the user confirms)
1. **One engine, three callers.**
   - `services::relocate` (re-point state) and `services::agent_history_move`
     (carry histories), both AppHandle-free.
   - They are called by `rename_project_dir`, `move_remote_mirror`, and
     later Phase M (`docs/rename_plan.md`), which needs exactly this per
     folder.
2. **Nothing is deleted or overwritten.**
   - Dirs are renamed, not copied.
   - A merge into an existing target moves files in without replacing any.
   - Every file rewritten is first copied to
     `<state>/relocate-backups/<timestamp>-<project id>/`, home-relative
     paths kept, plus a `manifest.json` (old, new, what changed).
   - SQLite stores are never written. If the probe shows a CLI needs one
     rewritten to resume, that CLI's carry is a separate, backed-up step the
     user opts into.
3. **Trust keys are added, not moved.** In `.claude.json`, Codex, Cursor and
   Copilot, the old key stays next to the new one. It is harmless, and the
   rename back then needs nothing.
4. **Claude dirs are matched by real cwd, never by the lossy encoded name.**
   Use `transcript_cwd` (`sandbox.rs:1576`), so `/p/a-b` and `/p/a/b`, or a
   sibling `projecteldrun-x`, are never confused.
5. **App-owned files are rewritten. The project's own files are only listed,
   with three bounded exceptions.** Rewritten:
   - `project.json` (as today);
   - `.git/config` path values that point into the folder (git's repo config
     the app already manages via `worktree repair`);
   - venv `bin/` shebangs and activate scripts, but only in dirs that have a
     `pyvenv.cfg`, never following symlinks, through `home_io`-style
     no-follow writes, since the folder is attacker-controlled.

   Anything else in the folder that names the old path (e.g.
   `.claude/settings.json`, which is Claude's config — the app never edits
   another app's config) is shown in the preview as "mentions the old path —
   not changed", with the file list.
6. **Containers:** the preview says the container will be recreated and its
   writable layer lost. An opt-in "keep container changes" (`docker commit` to
   a tagged image the new container starts from) is a later step, not v1.
7. **No link at the old path by default.** A per-rename "leave a link at the
   old name" checkbox exists for outside things the app cannot fix (other
   machines' `remote_path`, launchers, scripts). Off by default, because a
   link hides missed holders. The preview recommends it when it finds such
   holders.
8. **The display-name rename refreshes box links too** (the member link is
   named after the project), and does nothing else that touches paths.
9. **The name and the folder stay one Save**, as today, with the folder leaf
   following the name until edited.

## Design

### Backend
- `plan_project_dir_rename` keeps its fast status answer for the live line.
  A new `project_rename_preview(projectId, leaf)` (read-only, off-thread)
  returns the holder report:
  - per CLI: history dirs/sessions found, and carried / starts fresh once /
    not found;
  - worktrees (inside, outside);
  - approvals;
  - git config values;
  - venvs;
  - box;
  - container;
  - in-folder files that mention the path (bounded scan: `.claude/`, `.vscode/`,
    `.idea/`, top-level dotfiles; size cap; no symlink follow);
  - outside holders the app knows of.

  Payload keys are camelCase.
- `rename_project_dir_blocking` keeps its order: rename the folder, patch the
  registry, roll back the folder if the registry fails. It then calls
  `relocate::run(old, new, project_id)`, whose steps are:
  1. `project.json` (moved from today's code);
  2. `terminals.json`;
  3. `exec_trust` keys;
  4. `.git/config` values, then `worktree repair` with the moved worktree
     paths. This covers repos *outside* the folder that have a worktree
     inside it too, read from `.git/worktrees/*/gitdir` only, never by
     walking the folder;
  5. venv fix-ups;
  6. box refresh;
  7. `agent_history_move::run` over every agent home and the agent-global
     layer;
  8. `token_stats` key move in the same pass as the Claude dirs;
  9. write the backup manifest.

  Each step is idempotent: an already-rewritten prefix no longer matches. A
  failed step is reported (not fatal, as today), and the result lists it.
- A crash mid-carry: the backup manifest is written first with
  `state: started`. The next launch finishes or reports it (one launch step,
  like `brand_migration`'s). The folder rename itself is already atomic.
- Rename back = the same command in the other direction, and it works because
  of decisions 2 and 3.

### Frontend
- `RenameWindow`: when the folder switch is on, show the preview under the
  path line, grouped:
  - **Carried:** sessions per CLI, memory, approvals, worktrees, hooks.
  - **Starts fresh once:** CLIs with no proven carry.
  - **Not changed:** in-folder files, outside holders, with the link checkbox.
  - **Will rebuild / recreate:** caches, container.

  The lossy `pill.folderRenameAgentNote` goes away. The close-and-reopen note
  stays.
- After Save, a short result note: "Renamed; N conversations carried; see
  details", where details shows failures and the backup path.
- All strings via `useT()` in every dictionary. The existing pill
  `pill.alsoRenameFolder` stays, and a new `UntestedTag id="pill.renameCarry"`
  gets a row in `src/lib/untested.ts`. Shared dialog scheme, explicit `color`.
- If the survey finds absolute paths in `localStorage`, rewrite them in
  `renameProjectFolder` after the invoke.

## Implementation phases (one fresh subagent each if asked)
- **P0 Probe the CLIs** (no product code; this is Phase M's M0).
  - For each CLI, in a scratch copy of an agent home, with
    `env -u TABTIVITY_TAB_UID -u ELDRUN_TAB_UID`: make a session in `/tmp/a`,
    rename to `/tmp/b`, apply the candidate carry, then test resume,
    "continue last" and trust.
  - Find stores by grepping the literal path, Claude's encoding, md5, sha256.
  - Output: the minimal carry per CLI, and fixtures in
    `src-tauri/test-fixtures/relocate/`.
  - Also survey `localStorage` keys for absolute paths.
- **P1 `services::relocate` + preview.** Move the re-point half out of
  `rename_project_dir_blocking`, add exec_trust / git config / venv / box /
  backups, and `project_rename_preview`. `move_remote_mirror` calls it for
  the mirror.
  - Tests: every holder rewritten; `/p/foobar` untouched when renaming
    `/p/foo`; nested and outside worktrees repaired; venv shebangs fixed and a
    planted symlink not followed; a rerun is a no-op; the backup manifest
    restores byte for byte.
- **P2 `services::agent_history_move`.** The Claude dir rename/merge,
  `.claude.json`, `history.jsonl`, token-stats keys, and P0's carries for
  the others. All writes through `home_io`, all homes scanned.
  - Tests: lossy names; merge into an existing dir; memory files byte for
    byte; token totals unchanged after a rescan; a home with no matches is
    untouched.
- **P3 Dialog.** The preview, result note, i18n, untested row, store
  wiring, `localStorage` rewrite if needed. Vitest for the preview groups,
  the link checkbox, the result note, and failure display. Update the
  `docs/filemap_*.md` rows for the new services and
  `docs/context/project_transfer.md` (import could reuse the carry).
- **P4 Crash resume + docs.** The launch step that finishes a `started`
  manifest, and help docs (Projects → Rename). Point Phase M in
  `docs/rename_plan.md` at the engine.

Each phase runs the six `AGENTS.md` gates, `git diff --check`, and
`npm run backend:stale`.

## Verification
- Unit tests per phase (above).
- **Copy run:** extend `scripts/brand-copy-run.sh` / `copy_run.rs` with
  `--project-rename <id> <leaf>`. It copies the state dir, the homes and the
  project into a scratch home, runs the rename, and lists leftover holders of
  the old path, literal and Claude-encoded. Pass:
  - only prose in transcripts, the kept trust keys and logs remain;
  - every Claude/Codex session id is found under its new cwd.

  The user runs it from their own terminal (a fenced tab sees a stub state
  dir).
- **Live, on the frozen dev build, clicked through by the user,** first on a
  throwaway project with a Claude, a Codex and a shell tab, a worktree, a venv
  and a box membership:
  1. Rename (name + folder) while it is open: the preview lists what it
     should, and the project reopens with its tabs.
  2. Claude resumes and knows its memory, up-arrow history is there; Codex
     resumes.
  3. A commit asks no new approval and runs the hooks; the venv's `pip`
     works; the box link opens.
  4. Today's token totals are unchanged.
  5. Rename it back: everything still works.

## First use: this checkout
After P0–P3 are on `develop` and in the frozen dev build. This checkout has
extras no ordinary project has, because it is the app's own source.
- **Before:**
  - every agent tab of this project is done and committed (including
    concurrent sessions and `.claude/worktrees/hosted`);
  - `scripts/package-dev-auto.sh --status` is idle, then pause the build;
  - `git bundle create ~/projecteldrun-pre-rename.bundle --all` (unpushed
    commits);
  - outside terminals and editors in the folder are closed.
- **Rename:** Rename window → name `Tabtivity`, folder `tabtivity`. Check the
  preview:
  - 15 Claude dirs with 167 memory files carried;
  - `core.hooksPath` rewritten (set the relative `.githooks`, as `AGENTS.md`
    prescribes);
  - `.claude/settings.json` / `settings.local.json` listed as "not changed":
    edit their allow rules by hand afterwards.
- **Tick "leave a link at the old name".** The running dev binary has
  `TABTIVITY_DEV_SOURCE_ROOT` compiled in (`dev_build.rs:28`), and the Dev and
  HotReload `.desktop` entries (`package-dev.sh:299`, `package-local.sh:62`)
  name the old path.
- **Then:**
  - unpause the dev build;
  - the next commit (or "Build now") builds with the new source root and
    rewrites `TabtivityDev.desktop`;
  - run `scripts/package-local.sh` for the HotReload entry;
  - quit and start the new dev build;
  - expect a full cargo rebuild;
  - one small commit retitles `DOCUMENTATION.md` and `docs/filemap*.md`
    ("ProjectEldrun — …"). `test-fixtures/` and the `app_update.rs` test URLs
    stay: they are old-shape fixtures.
- **Holder scan** (your own terminal), then `rm` the link:
  ```
  grep -rlF ~/eldrun/projects/projecteldrun <state> ~/.local/share/applications \
    ~/eldrun/projects/tabtivity/.git --exclude-dir=relocate-backups
  ```
- Your own CLIs outside the app (`~/.claude/projects/-home-<you>-eldrun-projects-projecteldrun*`)
  are never touched. Move them by hand if you want them.

## Open decisions for the user
1. In-folder rewrites limited to `.git/config` and venvs, the rest listed
   (decision 5)?
2. Old trust keys kept (decision 3)?
3. Link at the old name: opt-in checkbox, off by default (decision 7)?
4. Container writable layer: warn only in v1 (decision 6)?
5. A CLI whose resume needs its SQLite or rollouts rewritten: opt-in backed-up
   step, or "starts fresh once"?
6. Should renaming the hosting repo (GitHub/GitLab) join this dialog later?

## Unverified assumptions
- Claude `--resume <id>` looks only under the cwd's encoded dir.
- Codex, Copilot, Antigravity and the other CLIs resume from a new cwd (P0).
- Cursor's `chats/` dir name is md5 of the cwd (it matches here).
- `git worktree repair <moved paths>` fixes both sides when the repo and its
  worktrees moved together.
- No `localStorage` value holds an absolute project path that matters (P0
  survey).
- Windows: renaming a folder another process holds open fails cleanly
  (`rename_dir_no_replace`). The Cursor/Claude encodings of `C:\…` paths are
  untested. macOS is uncompiled here.
