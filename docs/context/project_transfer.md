# Full project export / import

Moving one Tabtivity project to another computer. Backend:
`src-tauri/src/commands/project_transfer.rs`. UI:
`src/components/projects/ProjectExportDialog.tsx` (pill menu → "Export
project…") and `src/components/projects/ProjectImportBundleDialog.tsx`
(＋ menu → "Import Project File").

## Why it exists

A project is not a folder. Copying the folder to a second machine and importing
it there gives you the files and **nothing else** — every question Tabtivity ever
asked about that project has to be answered again, because the answers live in
four other places, all keyed by project id:

| What | Where it lives |
|------|----------------|
| git label, remote spec, compute hosts, container spec, interpreter, run host, categories, panel prefs | `projects.json` entry |
| description, created-at, default apps, everything else descriptive | `<dir>/project.json` |
| tab layout, active tab, agent session ids | `<state_dir>/sessions/<key>/terminals.json` |
| time tracking | `<state_dir>/time_summary.json` |
| box membership | `<state_dir>/boxes.json` |

Export packs all five; import puts them back and re-points every path. On
request it also packs a sixth: the project's agent conversations (below).

## The bundle

A `.tabtivityproj` file is a zip (the `zip` crate was already in the tree for
`commands::fs`'s dropped-archive extraction):

```
tabtivity-export.json   the manifest — everything that is not a file
dir/…                a local project's folder
state/…              a remote project's local state dir (project.json only)
mirror/…             a remote project's local mirror tree
agents/home/…        the conversations in the project's agent home (opt-in)
agents/local/…       the same from its local-model home
```

The extension is distinct from `.zip` on purpose: a bundle that lands inside a
project tree must not be double-clicked into `extract_archive`.

`format` in the manifest is checked on import and a **newer** bundle is refused
rather than read partially. Dropping a section an older build does not know
about is exactly how a "full" export quietly stops being full. A bundle is
written in the oldest format that holds what it carries (`format_for`): format
2 added `agents/`, so only a bundle that carries conversations is 2, and every
other export stays readable by the builds before it.

## The trust split — the one design decision here

The manifest is written by Tabtivity. But a bundle is a *file*: it can be mailed,
dropped in a shared folder, fetched from anywhere. So "written by Tabtivity" is a
claim, and import treats the whole file as untrusted:

- the tab layout goes through the same sanitizer a cloned repository's does
  (`terminal_service::adopt_untrusted_session` → `sanitize_tab_layout`): a tab
  naming a command this installation does not know keeps its label, kind and
  cwd but loses its `cmd`, `resumeArgs`, `env`, `location` and `sessionId`;
  every tab, known command or not, loses its `env` and `embedExec`
  (`sanitize_untrusted_layout`, gap 17) — the window rebuilds `TAB_UID` from
  `sessionId` and a custom agent gets its `settings.json` env back;
- `open_apps` — a list of host commands launched on every activation — is
  dropped outright, upholding the invariant that it is never adopted from
  anywhere outside the state dir;
- the same session fields are stripped from the imported `project.json`, so a
  later `adopt_folder_tab_layout` cannot smuggle back what import refused;
- `project.json` is **rewritten from the manifest**, not adopted from the
  unpacked tree — it is read back for the container spec and the interpreter,
  and the tree half of a bundle is attacker-controlled like any project folder;
- zip entries are confined with `enclosed_name`, and symlink entries are created
  only **after** every directory and file, so a link in the archive can never
  become the path a later file is written through.

What import *does* adopt is the registry entry's settings. That is the feature,
and it is a different risk class: none of those fields is executed by importing.
The user still has to switch to the project and press something.

## What deliberately does not travel

- **Phone access** (`MOBILE_ACCESS_KEY`, its per-phone list
  `MOBILE_DEVICES_KEY`, and the access key's old-brand spelling). Mobile
  access is consent given on one machine to the phones paired with it, and a
  per-phone list names device ids that mean nothing elsewhere. Export strips
  them from the manifest's entry and import drops them from the entry and the
  rewritten `project.json` (`project_transfer::mobile_keys`) — before this,
  import adopted the entry's extras wholesale, so a bundle exported with
  Mobile on opened the project to every phone here without being asked.
- **Passwords and access tokens.** They live in the OS keychain keyed by host
  (`services::remote_credentials`), never in a file Tabtivity writes. The remote
  spec travels; the secret is re-entered on the far side. The export dialog says
  so before the file is written.
- **Host-bound sync state** (`sync.json`, `git_peer.json`). Both describe a
  relationship between *this* machine's mirror and a host. Carrying them to a
  different mirror produces the false-green failure
  `commands::projects::clear_host_bound_state` documents: `push_decision` sees
  `ever_synced = true` against a file that is not there, refuses to push, and
  the file tree paints it green. A remote import therefore starts with no sync
  history at all. The remote state dir is packed by **allowlist**
  (`REMOTE_STATE_FILES`), not skip list, so a file dropped beside them later
  does not start travelling because nobody remembered to exclude it.
- **`host_bound/` markers**, which pin a tab to a machine that is not the
  destination. They live under the session dir and are not packed.
- **A project VM's overlay disk.** So a VM project is refused up front
  (`export_blocker`) rather than exported into something that cannot boot.

## Agent conversations

A project's agents keep their conversations in its agent home
(`<state_dir>/agent-homes/<key>`, `services::agent_home`), not in the tree.
Without them the tab layout carries session ids that resume nothing on the far
side. The "Agent conversations" switch is **off by default**: a transcript holds
whatever the agents read or printed, secrets included.

What travels is an allowlist, `services::agent_history::ROOTS`: per CLI, the
folders and files that hold conversations — Claude's `projects/` (transcripts
and the per-folder `memory/`), Codex's rollouts, `session_index.jsonl` and
thread store (`state_<n>.sqlite`), Copilot's `session-state/`,
`session-store.db` and prompt history, OpenCode's `opencode.db`, old JSON
`storage/` and prompt history, Gemini's and Qwen's `tmp/<project>/chats` and
logs (never `tmp/bin`, which holds a downloaded ripgrep), Antigravity's
conversations, Cursor's `chats/`, Droid's `sessions/` (minus each session's
`.settings.json`, which holds its autonomy level), and the session folders of
Pi, CodeBuddy, Kimi, Cline, Continue, Goose, Vibe and Auggie. Everything else
in a home — logins, settings, hooks, MCP servers, skills — is what an agent
tab runs or signs in with and never travels, in either direction; the
allowlist is checked again on import against the bundle's own entry names.
A root a home does not have contributes nothing. Layouts checked against a
live home (2026-10-12): Claude, Codex, Copilot, OpenCode, Antigravity; the
rest follow each CLI's docs and are tagged untested (`transfer.agentHistory`).

**Databases are never copied byte for byte.** A CLI writes its store while an
export runs, with the newest pages in a `-wal` beside it. The file and its WAL
are copied through `home_io` handles into a private scratch dir under the
state dir (copied again if they change meanwhile), opened there, emptied of
every table not listed as conversation (`agent_history::DATABASES`: OpenCode's
`account`, `credential`, `control_account`, `session_share` and `permission`
rows, Codex's remote-control enrollments, Copilot's skill proposals), and
written out with `VACUUM INTO` — one consistent file, no sidecar, no freed
page still holding a deleted token. Import strips again (a crafted bundle must
not plant an account the user's agent would then sign in with) and blanks
OpenCode's per-session permission grants. Every connection to such a file has
triggers off, the defensive flag on and the schema untrusted, so re-pointing a
row never runs the file's own SQL. Codex's `thread_history_<n>.sqlite` is left
behind on purpose: it indexes the rollouts by byte offset, re-pointing a
rollout moves those offsets, and Codex rebuilds it.

Export reads the home through `home_io` handles (an agent may be rewriting it;
a link swapped in is refused, and links are never carried). Import writes only
regular files the allowlist names, through the same handles, never over a file
already there, and caps one file at 1 GiB.

Paths are re-pointed — project folder, mirror, both homes — in three places:
inside each file (`.jsonl` line by line, a line naming none of them staying
byte-identical; `.json` whole, object keys included; `.yaml` as text), inside
every text cell of a database, and in the name of the folder a CLI files a
project's sessions under (`agent_history::repoint_rel`): a slug of the path
(Claude, CodeBuddy, Droid — a `-` matches any non-alphanumeric character,
which covers older Claude encodings), Pi's `--path--`, or a hash of it
(SHA-256: Gemini, Qwen; MD5: Cursor, Kimi). A path is replaced only where it
stands whole, so `/a/proj` never rewrites `/a/project`. Binary formats
(Antigravity's protobufs, Cursor's blobs) travel as they are. The memory in
`memory/` is instructions in the same trust class as a `CLAUDE.md` in the tree
itself, which a bundle carries anyway.

Not carried: `.claude.json` (folder trust must be re-granted here), Claude's
`file-history/` (rewind snapshots), OpenCode's `snapshot/` git store, Codex's
memories and logs, and the stores of CLIs whose layout is not known here
(Kilo, Grok, Junie, Amp, OpenClaw, Muse, Plandex, SWE-agent). Aider, Crush and
mini-SWE-agent keep theirs inside the project folder, which travels anyway.

## The host's copy

A remote project has two copies of its tree: this machine's mirror (what has
been synced down) and the host's. The dialog's "Pack the files from" picks
which one becomes `mirror/`; import treats both alike, and the manifest
records `mirrorFromHost`. The host's copy is offered only while the project is
connected — an SSH command against a dead session can hang the dialog — and is
measured only once picked (`preview_host_export`, one `run_remote_script` of
`du`/`find`: apparent bytes with GNU `du -b`, 1 KiB blocks on BSD/macOS).

Export streams it: one `tar -cf - .` over SSH, read by `services::tar_stream`
(ustar, GNU long names, pax headers, base-256 sizes; every header's checksum
checked) straight into the zip, with nothing landing on this machine's disk but
the bundle. A connection that breaks mid-archive fails the export rather than
packing a shorter tree; what the host's `tar` says it could not read lands in
the skip report; a hard link is copied from the member already in the bundle.
The host is asked to leave out `./.git` and the always-rebuildable names, and
the same filter runs again on the stream for nested ones. Folders whose
rebuildability needs a proof (`build`, `dist`, `target`, venvs) travel from
the host: an archive arrives in no order that could show the tool beside them.
Both calls are user gestures (`ssh_common::user_dial`).

## Nothing left out without a word

The walk visits every entry it cannot carry as `TreeItem::Skipped` — an
unreadable folder or file, a FIFO/socket/device (reading a FIFO would hang the
export), a folder past `MAX_DEPTH`, a link inside an agent home. The preview
counts them, the export report names them (`skipped`, capped at 200, plus
`skippedCount`), and the manifest records the count so the import dialog says
the bundle is short. Files are opened with `home_io::open_regular` (no link at
the last component, no blocking open) and streamed into the zip, never read
whole into memory; a read that fails partway takes its entry back out
(`abort_file`) and is reported.

## Sizes, and why the dialog has toggles

"Export the project" has no single right answer. A tree with a 3 GB
`node_modules` and a 900 MB `.git` is mostly things the far side can rebuild or
re-clone. So `preview_project_export` walks the tree once and classifies every
file as plain / git / rebuildable (`Class`, sticky on the way down — a
`node_modules` inside a `.git` is still history), and each switch in the dialog
shows what it costs. The estimate updates live; nothing is written until the
save dialog returns a path.

`REBUILDABLE_DIRS` is a near-twin of `commands::search`'s and `commands::fs`'s
skip lists and deliberately not shared with them: those two also skip `.git` and
`.tabtivity` unconditionally, and both of those must be exportable.

The skip is on by default, so a name alone is not enough: `build`, `dist`,
`target`, `.cache` and `venv` are often the user's own work (a paper's build
output, a release). Each entry carries a `Proof` — the tool's manifest beside
the folder (`package.json`, `Cargo.toml`, `pyproject.toml`, …) or its marker
inside (`pyvenv.cfg`); only unambiguous names (`node_modules`, `__pycache__`, …)
match by name. The preview lists every matched folder with its size
(`rebuildable_dirs`), and the dialog lets the user untick one to carry it
(`keep_rebuildable`).

## Identity on the far side

The exported project **id is reused** when it is free. That is what makes a
moved project the same project: its agent session directories, its time history
and any box that still lists it all key off the id. When the id is already
registered here (importing a copy beside the original) a fresh one is minted and
the dialog says so.

Paths are re-pointed with `storage::rewrite_path_prefix` — the same function the
folder rename uses — over the registry entry, the `project.json` and the session
layout, so a tab's cwd follows the folder instead of naming a directory that
exists only on the other machine. An absolute path *outside* the project folder
(a pinned conda interpreter, a data mount) cannot be re-pointed and does not
survive the move; relative ones do.

Box membership travels as **names**, not ids — an id means nothing elsewhere.
Import joins boxes that already exist here and reports the names that matched
nothing. It never creates a box: a box is a meta-project with its own folder and
agent docs, and a file should not be able to add entries to the strip.

Time is merged, not added: a day is raised to the imported figure and a day this
machine already recorded more on keeps its own number, so re-importing the same
bundle twice cannot double a total.

## Known gaps

- Export is refused for VM projects (above). Carrying a qcow2 overlay is a
  separate feature if it is ever wanted.
- The host's copy of a remote project carries `build`/`dist`/`target`/venv
  folders even with the skip on (no proof is possible on a stream), and its
  progress denominator comes from a `find` that ran a moment earlier.
- A remote project's agents run on the host, in the host's own `$HOME`; their
  conversations are not in a Tabtivity agent home and do not travel.
- Progress is emitted per 64 files (`project-export` event); there is no cancel.
- A file name that is not valid UTF-8 travels under its lossy spelling (the
  zip stores names as text).
