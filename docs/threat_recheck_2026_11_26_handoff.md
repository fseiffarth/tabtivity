# Threat recheck — the code of 2026-11-19 to 2026-11-26, and every viewer

> **Status (2026-11-26):** REFERENCE (evidence for gaps 123–155). Nothing is
> fixed. A source review with synthetic checks; nothing was run live.

## Result and scope

**33 new gaps: two high, one medium to high, thirteen medium, seventeen low.
No fixes implemented.** Eleven read-only reviews in three groups, with
`docs/threat_model.md` as the blueprint:

1. **First pass, the range** (`4cf65018d..367e24e9a`, 350 non-merge commits,
   1,176 changed files): four reviewers on Fable — A agents, fence,
   credentials, MCP lanes, local models, checkpoints; B phone, mail, voice;
   C remote hosts, sync, git, VPN, CI and release; D the desktop renderer.
   Each then read its own not-read list in a follow-up.
2. **Second pass, the same four slices**: four independent reviewers on Opus
   (`AO`, `BO`, `CO`, `DO`). Each verified the first reviewer's findings,
   looked for what was missed, and read more of the unread list. Every
   first-pass finding held; several were understated.
3. **Viewers, whole code** (not the range): three reviewers on Opus —
   E PDF, print, PDF markup, deck presenter, pictures, GIF, media;
   F Markdown, notebooks, ODT, HTML/SVG as markup, TeX and SyncTeX, BibTeX,
   links; G the viewer host, the file commands behind every viewer, the code
   editor, YAML/JSON/table/SQLite/TensorBoard/diff.

This is not a claim that no further high-severity bug exists: every reviewer
lists unread code (section "Coverage limits"), and the range review found its
worst bug in code older than the range.

- Baseline `4cf65018d` (end of the 2026-11-19 recheck). Cutoff `367e24e9a`,
  `develop`. Line numbers are those of the cutoff and will drift. One commit
  landed after the cutoff (`615d4b2d6`) and is not covered.
- The committed tree was reviewed. Other sessions' uncommitted edits
  (`commands/ollama.rs`, `lib.rs`, `schema/settings.rs`, `launch_prep.rs`,
  `session_host/route.rs` at various times) were not; no finding sits in one.
- **Re-read by the main session at the cutoff:** 123 (both halves reproduced
  on git 2.53.0: `rev-list --output=` truncates and creates; an injected
  `--pretty=format:` echoes option-shaped lines), 124 (the no-click chain and
  the build environment, read), 125 (read), 126 (`FETCH_HEAD` through a link
  reproduced on git 2.53.0, `--no-write-fetch-head` leaves the target alone;
  bundle path and SFTP calls read), 127 (the `git add -A` call, read), 128
  (`resolve_tex_root`, `resolve_point`, read), 133 (read), 134 (the adoption
  and the code's own comment, read), 136 (suggestion fill, draft check, gate
  and guard, read), 137 (the paste half: xterm 6.0.0's `paste` and the app's
  call, read), 138 (the heading pattern timed in node: 2,000 spaces 1.2 s,
  growing about eightfold per doubling). The rest stands on its reviewer, and
  for the first-pass findings on the Opus verifier as well.
- Raw reports with coverage matrices, refutation attempts and reproduction
  notes: the ignored `tmp/threat_recheck_2026_11_26/` (`A`–`G.md`,
  `A_opus`–`D_opus.md`, the briefs).
- Process note: reviewer A's follow-up started subagents of its own against
  its brief (two ran; it re-read the code behind their claims). It was
  stopped after its report; the claims were then covered by the Opus reviewer
  of slice A.

| Gap | Severity | Finding | Evidence strength |
|---|---|---|---|
| 123 / C1, CO1 | **High** | A host's ref "sha" is never validated and becomes an option of local `git rev-list` and `git bundle create`: truncates any file; uploads reflog, stashes and amended-away commits to the host | git behaviour reproduced twice (main session and reviewer); path from host output to argv read |
| 124 / DO1 | **High** | Mark up rebuilds agent-edited TeX with no click, on the host, with reads open: any file the user can read lands in a PDF the agent reads | TeX read reproduced with `pdflatex` under the app's flags; no-click chain read |
| 125 / G1 | Medium to high | Extracting a `.zip` checks each entry, then creates it by path with links followed and no cap (known residual #869, now reproduced) | Race reproduced on a Python port (9,921 of 20,000 entries outside); Rust read |
| 126 / C4, CO2 | Medium | Lockstep reads and writes through links in the fence-writable `.git/`: the bundle file and git's `FETCH_HEAD` | `FETCH_HEAD` reproduced (main session and reviewer, incl. shell code via a branch name); bundle read from source |
| 127 / A1, AO2 | Medium | The checkpoint snapshot follows a folder swapped for a link; a linked-worktree folder can be swapped whole | Both reproduced at the git level; Rust read |
| 128 / C2, DO2, G3, F4 | Medium | `resolve_tex_root` and `auto_engine` read a path a file chose, unbounded: opening a `.tex` can exhaust the app's memory | Read end to end by four reviewers; read pattern reproduced on a capped port |
| 129 / F5, DO2 | Medium (Windows) | Paths a `.tex` names reach SMB on open or hover: gap 53's class outside SyncTeX | Read from source and the Win32 contract; not run on Windows |
| 130 / G5 | Medium | File-tree delete, rename, move and create check a path, then act by path | Read from source; same race shape as 125 |
| 131 / AO3 | Medium | Skill Uninstall or overwrite-copy removes a folder by path after a canonical check | Race reproduced on a Python port (22 of 200); Rust read |
| 132 / G2 | Medium | Format runs a project's Prettier plugin or config without the trust prompt in three shapes | Reproduced with Prettier 3.9.10; gate verdict from a port |
| 133 / G4 | Medium | `watch_dir` runs on the main thread and reads `.git` pointer files blocking and uncapped: an agent's FIFO freezes every window | Read (main session too); FIFO pattern reproduced |
| 134 / AO1 | Medium | Claude's shared credentials file holds its MCP OAuth tokens and is placed in every scope | Adoption read; Claude's storage layout assumed, CLI not run |
| 135 / A2, AO5 | Low (medium if the formats are as assumed) | Login files are adopted whole with no real account guard; three carry an API endpoint | Adoption read; three CLIs' file formats assumed |
| 136 / BO1 | Medium | Phone hands-free sends the local model's suggestion as the user's prompt, unread, on any sound | Guard reproduced on the committed module; rest read (main session too) |
| 137 / E5 | Medium | Text copied from a PDF keeps ESC and newlines; the terminal paste does not strip ESC, so it can end bracketed paste and submit a command | Extraction reproduced in pdf.js; copy and paste halves read; not run end to end |
| 138 / F1, F2 | Medium | The Markdown renderer hangs on one heading line and overflows the stack on deep quotes; in the Chat that unmounts the whole UI | Both reproduced in node; unmount read |
| 139 / D1, A6, AO6 | Low (widens 114) | The paste and drop scanner still copies a `file://` target into a tab's inbox, now also to an SSH host's `/tmp`; a dropped project link is followed | Scanner reproduced on a port; clipboard reach assumed; backend read |
| 140 / D2 | Low | A question card built from the transcript alone types a digit into the pane with no on-screen check | Read |
| 141 / D3, DO4 | Low | Screen text raises the app's own controls: the auto-continue, the "Sign in to continue" card | Read |
| 142 / D4, A7 | Low | Local models only: a refusal at project creation still activates the project; Docker projects' container shells are not gated | Read |
| 143 / DO3 | Low | "Resolve all" from a newer window against an older backend acts on the whole mirror | Read at both commits |
| 144 / A3, AO4 | Low | The Claude OTel receiver: no connection cap, no header deadline, no model-name cap, no rate limit | Read |
| 145 / A5 | Low | Box tabs pre-accept Claude's folder trust for every other box root | Read; Claude's use of the key assumed |
| 146 / A9, A8, G7, G8 | Low | Uncapped reads, outside the fence, of files an agent or a project wrote | Read; patterns reproduced |
| 147 / A10, C5 | Low | By-path creates and writes through plantable links: the seeded marker, the gate scripts' files in `.git/` | Read; syscall semantics reproduced |
| 148 / B1 | Low | The mail autocomplete's link filter stops only `://` and `www.` | Filter reproduced on a port; model compliance not tried |
| 149 / C6 | Low | Pairing copies `remote.origin.url`, token included, into the mirror's agent-readable config | Read |
| 150 / CO3 | Low | Remote git command strings are quoted for POSIX shells; a fish login shell parses them differently | Sink reproduced; fish parsing from its documentation |
| 151 / G6 | Low (widens 116) | Viewing a `.py` file runs the `conda`, `pyenv` and Poetry probes | Read |
| 152 / G9 | Low | The SQLite viewer is not on the hardened opener: viewing writes `-wal`/`-shm` into the project | Reproduced with SQLite 3.46.1 read-only |
| 153 / E4 | Low | The markup prompt quotes the PDF's text mapping: zero-width, bidi and tag characters reach the agent's prompt | JS side reproduced; Rust read |
| 154 / E6 | Low | Deck custom fonts go to the engine's font parser; gap 51's fix covers PDFs only | Read |
| 155 / E1–E3, E7, F3, F6, F7, G10 | Low | One file hangs or exhausts the window: PDF image and page budgets, GIF frame count, TeX highlighter, BibTeX, SyncTeX box walk, CSV columns | Mostly reproduced with timings |

Earlier open gaps: 112 and 113 are open and wider than recorded, 114 is
narrower in one way and wider in another (139), 116 is open and reachable by
viewing (151), 120 is open and unchanged. Gaps 115 (write side), 117, 118,
119, 121 and 122 were found closed as the model says, by two reviewers each.

## Findings

Format per finding: what you do, who attacks, the evidence, what limits it,
the correction. `services/` and `commands/` are under `src-tauri/src/`.

### 123 / C1, CO1 — a host's "sha" becomes an option of local git (high)

- **You do:** nothing after switching lockstep on for a remote project (it
  runs on every pass that does not early-out; an HPC-tagged host only on
  "Sync now"); or open "Stop keeping a local copy" (second caller).
- **Attacker:** the SSH host of a paired project, hostile or compromised. It
  prints the refs.
- **Evidence:** `services/git/git_peer.rs` `parse_refs` (375–390) takes the
  text before the first space of each ref line as the sha, any string;
  `parse_probe_block` feeds it. `transfer_and_apply` (push leg, 1710–1753)
  builds `excludes` from the host's branch and tag shas and calls
  `known_shas(&src_peer, &excludes)` with the local mirror as `src_peer`;
  `known_shas` (351–369) runs `git rev-list --no-walk --ignore-missing <every
  string>` through `hookless_git_command_in`, which adds `-c` pairs and
  passes the rest verbatim: no `--`, no screen of a leading `-`. Second
  caller, new in the range: `commands/remote_unpair.rs:264`.
  - *Truncate (C1):* `--output=<path>` makes `rev-list` create or truncate
    the file and exit 0. Reproduced: a 9-byte file became 0 bytes; a missing
    path was created. Relative paths start at the mirror, so `.git/config`,
    `../../projects.json` and any absolute path are in reach, one per ref
    line.
  - *Leak (CO1):* a token `--pretty=format:--not%n--reflog` makes the local
    `rev-list` print the lines `--not` and `--reflog`; ref lines whose "sha"
    is literally `--not` and `--reflog` then pass `known_shas`'s echo filter
    and reach `git bundle create … --branches --tags --not --not --reflog`.
    The bundle uploaded to the host carries commits amended or reset away,
    every stash (untracked files of `stash -u` included), notes and
    remote-tracking refs. Reproduced on a synthetic port: an amended-away key
    and a stashed `.env` came out of the bundle.
- **Limits:** truncation writes no attacker text (with `--do-walk --graph`,
  graph characters only); no option was found that runs a program. The other
  sinks of host-chosen strings (`merge --ff-only`, `update-ref`, `reset
  --hard`, ref names) fail before damage: tested by both C reviewers. The
  code predates the range; only the second caller is new.
- **Standing:** the row "Background git — lockstep" (✅ #151) says the local
  calls are hardened; hardening does not screen arguments.
- **Correction:** keep a ref only if its sha is `is_hex_sha` and its name
  passes `git_hardened::valid_rev`, in `parse_refs` and `parse_head`; filter
  `known_shas`'s result and the excludes of `bundle_create_args` the same
  way; add `--end-of-options` (git ≥ 2.24) as a second layer. Acceptance: a
  ref line `--output=x y` yields no snapshot entry, and no host string
  reaches a local argv unvalidated.

### 124 / DO1 — Mark up rebuilds agent-edited TeX with no click (high)

- **You do:** have Mark up on for a PDF built from TeX in a project where an
  agent works. No click: the build starts when Mark up turns on or the
  round's agent finishes a turn.
- **Attacker:** a prompt-injected agent in the project's fence.
- **Evidence:** since `be29229c0` (2026-11-25),
  `src/components/embed/pdf/usePdfMarkup.ts` `checkTex` (1100–1123) calls
  `rebuildTexSource` when a source is newer than the PDF — once per load
  (`"auto"`) and again when the agent finishes (`"always"`, 1247–1251).
  `lib/viewers/tex/openTexWorkspace.ts:235–247` builds, or opens the
  workspace and queues the build; `TexView.tsx:879` runs it once the file has
  loaded. The build is `compile_tex` on the host, outside the fence, with
  `-no-shell-escape` and `openout_any=p` but `openin_any` at TeX Live's
  default `a`; only hover previews set `openin_any=p` (`commands/tex.rs:568`).
  The reviewer's `pdflatex` run with the app's flags put the content of a
  file outside the document's folder, named by absolute path, into the PDF.
- **Impact:** the agent writes `\input{/home/<user>/.ssh/…}` (or a state-dir
  file, `agent-global`, another project's file), ends its turn, and reads the
  result out of the PDF in its own folder: a read past the fence with no
  click. On a TeX Live older than 2023 without the CVE-2023-32700 patch, a
  document that asks for LuaLaTeX gets command execution the same way.
- **Limits:** needs Mark up active on a TeX-built PDF. Before the commit the
  same read needed the user's own Build (tier 4, the user's call).
- **Correction:** no automatic build — keep the Rebuild button and hold
  Submit until it is pressed; `openin_any=p` for every pdfLaTeX/XeLaTeX
  build; in the end, run Build inside the folder's fence.

### 125 / G1 — archive extraction creates files by path after a check (medium to high)

- **You do:** double-click a `.zip` in the file tree.
- **Attacker:** a fenced agent that wrote the archive and races the click.
- **Evidence:** `commands/fs.rs` `extract_archive_blocking` (1366–1419): each
  entry goes through `enclosed_name` and `enforce_confinement(canonical_or_new)`,
  then `create_dir_all` and `File::create(&out)` by path. The agent swaps a
  folder inside the fresh destination for a link between check and create.
  No entry or byte cap. Port of the steps: 9,921 of 20,000 entries landed
  outside, 1,945 refused.
- **Standing:** the row "Extract archive" (⚠️ #869) already names both the
  race and the missing cap. New here: the reproduction and the rating — the
  bytes are attacker-chosen and land wherever the user can write (`~/.bashrc`),
  so this is code outside the fence. Medium by gap 115's precedent (a click
  and a concurrent writer), high by the reviewer.
- **Correction:** extract through held directory handles
  (`openat(O_NOFOLLOW)`, exclusive create; `checkpoints/install.rs` has the
  walk), with an entry and a byte budget.

### 126 / C4, CO2 — lockstep writes through links in `.git/` (medium)

- **You do:** nothing; lockstep is on and an agent works in the mirror.
- **Attacker:** a fenced agent in the mirror (the fence keeps `.git/config`,
  `config.worktree`, `hooks/` and `commondir` read-only, the rest writable
  for lock files), together with what the host sends.
- **Evidence:**
  - *Bundle (C4):* `git_peer.rs:1644` puts the bundle at
    `<mirror>/.git/<bundle name>`; `services/remote/sftp.rs` downloads with
    `File::create` (936) and uploads with `File::open` (896), both following
    links. A link planted there makes the next host→mirror pull overwrite any
    user-writable file with the bundle's bytes; a FIFO hangs lockstep while
    it holds the project's sync lock; the upload leg can be raced to send any
    readable file to the host. `worker_sync.rs:124–128` already keeps its
    bundle in the state directory.
  - *`FETCH_HEAD` (CO2):* the pull leg's `git fetch` (`git_peer.rs:1784`) has
    no `--no-write-fetch-head`; git opens `.git/FETCH_HEAD` plainly. A link
    there is overwritten with a line that holds the branch name; a branch
    named `x'$(cmd)'y` becomes shell code when the target is an rc file.
    Reproduced by the reviewer end to end and by the main session for the
    overwrite. `git_pull.rs:307`, `:509` and `branch_exchange.rs:413`, `:430`
    fetch the same way.
- **Correction:** the bundle in the state directory; `--no-write-fetch-head`
  (or `fetch.writeFetchHead=false` in the hardened config) on every fetch
  Tabtivity runs in a tree an agent can write.

### 127 / A1, AO2 — the checkpoint snapshot follows a swapped folder (medium)

- **You do:** have checkpoints on (experimental, off by default). The
  snapshot fires on turn edges the agent's own hook record sets — no click;
  the content reaches the agent at a Restore.
- **Attacker:** a fenced agent in the folder.
- **Evidence:** `services/checkpoints/snapshot.rs:274` stages with `git add
  -A --ignore-errors` on the live folder, by path, outside the fence. The
  agent flips a subfolder between a real folder and a link while git reads:
  about half of ~30,000 decoy paths held the outside file's content in two
  runs. The Restore dialog lists every file pre-ticked and shows the path as
  an ordinary modified file. For a linked-worktree folder (AO2)
  `Store::for_bound` checks the folder's real path once; a later swap of the
  whole folder makes every git call run in the link target: an outside
  folder staged whole, past the 25 MiB and 256 MiB caps, with no name
  guessing. A FIFO `.gitignore` in the target blocks git for up to ten
  minutes under the store lock.
- **Standing:** the read-side twin of gap 115; `install.rs` closed the write
  side only. Was an open question of todo 2451.
- **Correction:** stage from a handle-held view (the `install.rs` walk into a
  private stage tree), or run the store's git for the snapshot inside a
  one-shot fence whose only readable project mount is the folder.

### 128 / C2, DO2, G3, F4 — a file chooses a path that is read without a bound (medium)

- **You do:** open a `.tex` file (tier 2), or click in a PDF that has a
  SyncTeX map beside it.
- **Attacker:** a project folder (a cloned repository), a remote host that
  serves the map, or an agent.
- **Evidence:** `commands/tex.rs` `resolve_tex_root_blocking` (2398–2404)
  canonicalizes the path and runs `fs::read_to_string` on it: no regular-file
  check, no cap, no confinement, always on the local machine.
  `tex_auto_engine` → `auto_engine` (`tex.rs:371`) is a second such read.
  Ways in: `paper.tex` as a link to `/dev/zero`; a head line `% !TEX root =
  /dev/zero` (`magic_root`); an `Input:` record of a SyncTeX map —
  `services/synctex.rs` `resolve_point` (995–1006) returns the map's path
  with only the network-path check, `synctex_edit` passes it on, and
  `usePdfReverseSearch.ts` calls `resolveTexRoot` twice (153, 175). Callers
  on open: `openTexWorkspace`, `TexView`, `FileViewerPane:265–278`. The read
  never ends; the app dies with every tab.
- **Standing:** the SyncTeX row's "each `Input:` path is filtered lexically
  before anything touches the disk" is false for the path reverse search
  returns. `scan_tex_includes`, `tex.rs:1318` and `detect_engine_hint` read
  without a bound as well.
- **Correction:** one bounded, regular-file-only reader (`home_io`'s capped
  open) for every TeX source read; confine what `synctex_edit` returns to the
  scope's roots.

### 129 / F5, DO2 — a `.tex` file's paths reach SMB on Windows (medium, Windows)

- **You do:** open or hover in a `.tex` file on Windows.
- **Evidence:** the `\input`/`\bibliography` walk calls `read_file_text`,
  and `open_confined` canonicalizes before its roots check; `magic_root`
  canonicalizes; `detect_engine_hint` calls `is_file()` on preamble names on
  open and in the hover preview. A UNC path makes Windows authenticate to the
  attacker's server (NTLM hash). Gap 53 closed this for SyncTeX only.
- **Evidence strength:** read from source and the Win32 contract; not run.
- **Correction:** the network-path refusal of `synctex::is_network_path`
  before any canonicalize or stat of a path a document named; in
  `open_confined`, the lexical roots check first.

### 130 / G5 — file-tree operations check a path, then act by path (medium)

- **You do:** Delete, rename, move or create in the file tree.
- **Attacker:** a fenced agent racing the action, or a link in the project.
- **Evidence:** `commands/fs.rs:876–1224` and `write_confined`: canonical
  check, then the operation by path. A racing swap turns Delete into
  `remove_dir_all` of a folder outside the project. Without a race, deleting
  or renaming a link inside the project acts on its target (`docs-link` →
  the real `docs/` is removed).
- **Standing:** gap 22's residual understates the unguarded project-write
  commands.
- **Correction:** act through a held parent handle (`unlinkat`, `renameat`),
  and remove a link as a link.

### 131 / AO3 — skill Uninstall removes through a swapped folder (medium)

- **You do:** Uninstall a project skill, or Copy with overwrite into a
  project.
- **Evidence:** `services/skills.rs` (`copy_installed` 446–460,
  `uninstall_skill` 467–470): canonical check of `.claude/skills`, then
  `remove_dir_all(<real>/<name>)` by path. An agent swaps `.claude/skills`
  for a link in between and the outside folder of that name goes (a skill
  named `.ssh`). Port: 22 of 200 trials. The Skills panel offers Uninstall on
  skills an agent authored.
- **Correction:** as 130.

### 132 / G2 — Format runs project code without the trust prompt (medium)

- **You do:** click Format in a project.
- **Evidence:** `services/exec_trust.rs:560–710` decides whether a Prettier
  setup loads project code. Three shapes it does not see: `package.json`
  `overrides[].options.plugins`; a `package.yaml` whose Prettier config is a
  string; a `"plugins"` key written with an escape. All three ran their code
  under Prettier 3.9.10; a port of the gate would not have asked.
- **Standing:** the Format row (✅ #866) is false for these.
- **Correction:** ask whenever any config Prettier would load exists and is
  not provably data-only (parse with a real JSON/YAML parser, walk
  `overrides`), or run Prettier with `--no-config --no-plugin-search` unless
  approved.

### 133 / G4 — a FIFO in `.git` freezes every window (medium)

- **You do:** show the project's file tree.
- **Evidence:** `commands/fs_watch.rs` `find_git_dirs` (109–124) runs
  `read_to_string` on the `.git` pointer file and on `commondir`; `watch_dir`
  is a sync command — the file's own comment says it runs on the main thread
  — and holds the watch lock meanwhile. An agent's FIFO (or `/dev/zero` link)
  there stalls the window, again at each start. Gap 29's FIFO sweep missed
  this caller. In a main `.git` the agent can create `commondir` (the
  recorded residual of #158).
- **Correction:** `async` over a blocking body, the bounded regular-file
  reader, no lock held across the read.

### 134 / AO1 — MCP sign-ins are shared with every scope (medium)

- **You do:** authorise an MCP server in one project's Claude tab.
- **Evidence:** `services/agent/agent_auth.rs` `adoption_of` (477–482) takes
  the home's credentials file whole for every CLI but OpenCode and places it
  in every other home. The module's own comment (259–261) says a `/logout`
  "keeps the file for its MCP tokens". So the access and refresh tokens of an
  MCP server authorised in scope A are readable by the agents of every scope.
- **Standing:** against AGENTS.md "config, skills, hooks and MCP entries are
  per scope". Claude's file layout is assumed; the CLI was not run.
- **Correction:** adopt and place only the login record (`claudeAiOauth`);
  keep every other key of the file per home.

### 135 / A2, AO5 — login adoption with no real account guard (low; medium if the formats hold)

- **Evidence:** `account_of` knows only Codex, `admissible` only OpenCode;
  Cursor's `auth.json` (new in the range) and the other generic CLIs are
  adopted on any change. The Claude/Codex guard compares a value the agent
  itself writes. A hijacked tab can move every scope's login to the
  attacker's account. If the login files of Qwen (`resource_url`), Auggie
  (`tenantURL`) and Plandex (`host`) carry the API endpoint as assumed, it
  can also send every scope's prompts and bearer token to its own server.
- **Standing:** the row "Fenced agent on Linux" claims a changed copy is
  adopted only through the account guard.
- **Correction:** pin the stored identity per CLI and adopt a change only
  after a sign-in the user started; never adopt an endpoint field.

### 136 / BO1 — phone hands-free sends the suggestion unread (medium)

- **You do:** use hands-free on the phone in an agent tab.
- **Attacker:** whatever the local model read in the transcript (a hostile
  file, a web page, a tool result).
- **Evidence:** since `7785c35a7` the "what's next" suggestion is put into
  the phone's composer as draft text (`mobile-web/src/screens/Terminal.tsx`
  2255–2276), with no check that hands-free is on. The send guard's
  `hasDraft` (`screens/terminal/useHandsFree.ts:124`) and the start-word
  gate's `open` (`useVoiceInput.ts:215`) both read "the draft is not empty".
  Heard words are appended (345–351); noise that settles into no words calls
  `settled("")`, which starts the pause (`shared/handsFree.ts:144–148`).
  After the 1.5 s pause, the chime and the 1.5 s cancel window the draft is
  sent. The reviewer's harness on the committed module printed the send at
  3,400 ms. Claude's own on-screen suggestion has been filled the same way
  since `7fc5dc214`.
- **Limits:** the text is one cleaned line (`next_prompt::clean`), and the
  chime and window do run.
- **Correction:** an untouched suggestion is not a draft for `hasDraft`, the
  gate or the landing; dictation replaces it; with voice on, show it as the
  tap-to-take strip only.

### 137 / E5 — copied PDF text can submit a command in a terminal tab (medium)

- **You do:** select text in a PDF (copy-on-select is on by default) and
  paste into a terminal tab.
- **Evidence:** the selection's text comes from the PDF's `/ToUnicode` map,
  so what is copied need not be what is drawn;
  `lib/viewers/textSelection.ts:53–59` strips only NUL. xterm 6.0.0's `paste`
  normalises line ends and adds the bracketed-paste markers but leaves ESC
  (`Clipboard.ts`), and `TerminalView.tsx:1465–1471` hands it the clipboard
  text as is. A PDF that shows `ls` can carry `ESC[201~`, a newline and a
  command: the paste ends early and the rest is typed.
- **Limits:** not run end to end. The paste sink is reachable from any
  clipboard source.
- **Correction:** strip C0 controls except tab and newline (ESC above all)
  from text on its way to `term.paste`, and from text the viewers copy.

### 138 / F1, F2 — one Markdown line hangs the window; deep quotes take the Chat down (medium)

- **You do:** open a `.md` or notebook, or receive an agent's answer or a
  prompt (desktop and phone).
- **Evidence:** `lib/viewers/markdown.ts:649`, the ATX-heading pattern
  `^(#{1,6})\s+(.*?)\s*(?:(?<=\s)#+)?\s*$` backtracks cubically: `# a` + 8,000
  spaces + `b` took 108 s on the UI thread (main session: 2,000 spaces 1.2 s).
  Quadratic siblings: `$$`, link labels, the URL trailing-punctuation
  pattern, the md-graph heading pattern. About 1,500 `>` characters overflow
  the stack in `renderBlocks`; in the Chat `answerHtml` runs outside any
  error boundary, so React unmounts the desktop UI. File viewers contain the
  throw.
- **Correction:** a linear heading split, a nesting cap in `renderBlocks`,
  an error boundary around the Chat's answer rendering.

### 139 / D1, A6, AO6 — the rest of gap 114, and a new target (low)

- **Evidence:** `lib/terminal/terminalDrop.ts:112–119` no longer scans plain
  text or a page's html+plain selection (closed since `5d8906dfe`). Still
  copied: a clipboard whose `text/uri-list` equals its plain text, `Files`
  plus `file://` text, and a dragged link — the app's own Markdown viewer
  renders `file://` links a README can carry. `commands/terminal.rs`
  `pty_drop_files` (388–451) takes any absolute regular file within the size
  cap; it refuses only locked-project files. Since `8b4892f6c` an SSH tab's
  drop uploads the file to the host (`/tmp/<slug>-drop-<128 bit>/`, 0700,
  never removed) — gap 114's row says a remote tab is refused. A dropped
  project file that is a link is followed (AO6).
- **Open:** whether a web page can put `text/uri-list` on the system
  clipboard under WebKitGTK was not settled.
- **Correction:** accept a `file://` reference only with a matching `Files`
  entry; refuse fence-hidden roots in `pty_drop_files`; open with
  `O_NOFOLLOW`; remove the host copy when the tab ends.

### 140 / D2 — an entry-only question card types a digit (low)

- **Evidence:** `lib/agents/liveCardGate.ts:23–69` `answerableByNumber`
  builds an answerable card from the transcript entry alone when the screen
  shows no dialog; `TerminalReaderView.tsx:1896–1907` passes `typePaneKeys`
  only the `stillAsking` hint, not the `canWrite` guard. Entry and lamp are
  both agent-forgeable. When the screen reader misses a real permission
  prompt, a click on row 1 of a forged card answers that prompt. Steering's
  `rawDigit` does the same. What gets approved runs inside the fence.
- **Correction:** let an entry-only card stand only while "decision" comes
  from the CLI's own question hook; same for `rawDigit`.

### 141 / D3, DO4 — screen text raises the app's own controls (low)

- **Evidence:** `components/layout/AgentContinueHost.tsx`: a limit-notice
  line in the last ten rows arms a `continue` send and waives the busy hold
  (opt-in per tab). Any OAuth-looking text in a pane raises the "Sign in to
  continue" card, which never shows the host and types the pasted code into
  the pane that printed the link (`3946f593a` widened the trigger).
- **Correction:** keep the busy hold unless the hook says the turn ended;
  show the link's host on the card and raise it only for a CLI's own sign-in.

### 142 / D4, A7 — Local models only: two holes (low)

- **Evidence:** `components/projects/ProjectDialog.tsx:1158–1226`: a refused
  `set_project_agent_privacy` at creation only records an error;
  `onProject(created)` activates the project, the message comes after. Since
  `7576a3c7a` the switch allows Docker projects; the gate stops agent spawns
  only, and a container shell in scope `All` holds the scope home with cloud
  logins, so a cloud CLI in the image runs on the locked folder (user-typed).
- **Correction:** block the project's agent tabs until the setting applies;
  no cloud logins in a locked project's container home.

### 143 / DO3 — "Resolve all" against an older backend (low)

- **Evidence:** `resolveAll` sends `relPath: ""` plus `relPaths`; a backend
  older than `80328db05` ignores `relPaths` and force-pushes or pulls the
  whole mirror. The window hot-reloads and the backend does not, so the skew
  is the normal state between a frontend change and the next build.
- **Correction:** the backend refuses an empty `relPath` without `relPaths`;
  the window checks `backend:stale`'s capability before it offers the action.

### 144 / A3, AO4 — the Claude OTel receiver's limits (low; experiment off by default)

- **Evidence:** `services/agent/claude_otel.rs`: loopback bind, Host and
  Origin checks, bearer token and body caps hold. Missing: a connection cap
  and a header deadline (a bare `axum::serve`; `mobile_control/limits.rs`
  wraps its listeners for this reason), a cap on distinct model names in the
  ledger (4,000 fresh names per request, persisted and reloaded), a rate
  limit per token. A local process needs no token to exhaust descriptors.
- **Correction:** `GuardedListener`; cap models and keys; refuse an
  oversized ledger on load.

### 145 / A5 — box tabs pre-accept folder trust (low)

- **Evidence:** `agent_home.rs:517–537` writes `hasTrustDialogAccepted` for
  every `--add-dir` root into the box's shared scope home; the next tab whose
  folder is that member starts trusted, so a pulled repository's project
  hooks run with no question (inside the fence).
- **Correction:** seed trust only from what the user trusted themselves.

### 146 / A9, A8, G7, G8 — uncapped reads of agent-written files (low; A9 low to medium)

- **Evidence:** `HomeFile::read` has no size cap and every spawn reads
  agent-written home files through it (a sparse file near RAM size can kill
  the window); `scan_own_history_start` re-reads a whole Codex rollout per
  call; the trust gate reads `.prettierrc`, `package.json`, `.latexmkrc`
  with `std::fs::read` before any prompt; project search re-reads with
  link-following calls after the walk and does not cut result lines.
- **Correction:** the capped, regular-file-only reader everywhere a fenced
  agent or a project chose the file.

### 147 / A10, C5 — by-path writes through plantable links (low)

- **Evidence:** the seeded-marker check and write go by path, so a planted
  link makes Tabtivity create an empty file wherever the user can write (a
  FIFO hangs that scope's spawns under the home lock). The user-run gate
  scripts write `.git/gates.lock.owner`, `gates.last.tmp` and
  `gates.progress.<lane>.tmp` (`scripts/lib/gate_lock.sh:86`,
  `scripts/gates.sh:319–320`, `:422`); a forged `gates.last` makes `gates.sh`
  report "result stands" without running. CI still runs.
- **Correction:** `home_io` handles for the marker; gate state outside the
  work tree's `.git/`, or created exclusively with no link followed.

### 148 / B1 — the mail autocomplete's link filter (low)

- **Evidence:** `services/mail/mail_complete.rs:418` `has_link` drops `://`
  and `www.` only; a bare domain, `mailto:`, an address or an IBAN passes
  into the one-key insert. Body only, never sends; a plain reply goes back to
  the attacker, so harm needs reply-all or a forward. On the desktop the
  right-arrow key at a line end takes the ghost's first word.
- **Correction:** drop a completion that holds a domain-shaped token, an
  address or a long digit run not present in the user's own draft.

### 149 / C6 — the origin URL travels with its token (low)

- **Evidence:** `git_peer.rs:2926–2931` copies the other side's
  `remote.origin.url` verbatim at pairing; a token embedded in it lands in
  the mirror's `.git/config`, which agents can read.
- **Correction:** strip userinfo before writing; warn when one was present.

### 150 / CO3 — remote git strings and a fish login shell (low)

- **Evidence:** `services/remote/ssh_exec.rs` `git_command_string`
  (1449–1470) quotes with POSIX single quotes and its comment says fish is
  fine; in fish `\'` inside single quotes is an escaped quote. A file name
  such as `x\';cmd;#` from a fenced local agent reaches host git calls
  through `retry_ff_clearing_identical` (2177–2212). Fish parsing from its
  documentation; no fish here.
- **Correction:** run remote scripts as `sh -c` with the script on stdin, or
  refuse backslash and quote in interpolated names.

### 151 / G6 — viewing a Python file runs the probes (low; widens 116)

- **Evidence:** the background go-to-definition of the Python editor
  resolves the interpreter, which runs `conda env list`, `pyenv which
  python`, and the Poetry probe when the folder has any trust approval. The
  Python row describes these as steps of the interpreter dialog.
- **Correction:** no probe on view; resolve imports against a remembered
  interpreter only.

### 152 / G9 — the SQLite viewer leaves files behind (low)

- **Evidence:** `commands/sqlite.rs` opens read-only but not through the
  hardened `agent_sqlite` opener: a WAL-mode database gets `-wal`/`-shm`
  written into the project and left; no `NOFOLLOW`, no defensive mode; a FIFO
  parks a worker. Hot journals are not rolled back (holds). Reproduced with
  SQLite 3.46.1.
- **Correction:** the hardened opener (`immutable=1` or a private copy).

### 153 / E4 — invisible characters in the markup prompt (low)

- **Evidence:** the prompt quotes the PDF's text mapping; zero-width,
  bidi-override and tag characters pass `anchors.ts:33` and the Rust check
  (`markup.rs:552`, control characters only). The row's "only words the
  drawn page shows" is weaker than written.
- **Correction:** run quoted page words through `strip_invisible`.

### 154 / E6 — deck fonts reach the font parser (low)

- **Evidence:** `deckFonts.ts:58–124` installs a deck's custom fonts as
  `@font-face` in the main and audience windows. Gap 51's `disableFontFace`
  covers PDFs; the deck-assets row names images only.
- **Correction:** ask before loading a deck's fonts, or render with system
  fonts by default.

### 155 — one file hangs or exhausts the window (low, eight cases)

| Case | Evidence |
|---|---|
| E1 PDF images | `maxImageSize` and `canvasMaxAreaInBytes` unset (`pdfLoad.ts:53`): a 411 KB page took 29 s and 1.1 GB in pdf.js under node |
| E2 PDF pages | no page ceiling; every page measured up front, quadratic on a flat page tree (20,000 pages 17 s; 200,000 in 19.6 MB unfinished after 300 s) |
| E3 canvases | thumbnails, outline preview, markup layer and `layerPng` size a canvas from the page with no cap; `rasterScaleFor`'s 0.1 floor defeats its own 12 MP cap (900 MB per print-preview page at UserUnit 150). Engine limit not measured |
| E7 GIF | the pixel budget does not bound the frame count: 22 MB → 1,000,000 frames, 6.3 s and 338 MB in the decoder alone |
| F3 TeX | the highlighter is quadratic on an unclosed `\cmd{`: 198 KB froze the window 23.6 s, again per keystroke |
| F6 SyncTeX | the box walk copies the ancestor stack per box: O(n²) memory on a nested map (needs a click) |
| F7 BibTeX | `parseBib` rescans from offset 0 per record: 400 KB took 11.9 s, and Cards is the default view |
| G10 CSV | rows are windowed, columns are not: one line with 4,000,000 commas becomes that many cells |

Correction: a budget per viewer before the first draw (pixels, pages,
frames, columns), linear scans, and the two pdf.js limits set.

## Earlier gaps

| Gap | Verdict |
|---|---|
| 105, 106, 111 | In place; 106's 5,000-chunk residual unchanged; 111's parser handles 8 M characters in 9 ms |
| 107 | Holds: the request is claimed before layout |
| 112 | **Open, worse than recorded:** 8 MiB of headers gives 441,505 file entries and `capDiffFiles` keeps them all; the phone's Diffs view uses the same parser |
| 113 | **Open, wider:** the backend caps copies at 99, so the missing ceilings are pages and decoded size; the raster floor (E3) defeats the per-page pixel cap; the user's own Print takes the same path |
| 114 | Plain-text paste closed; see 139 |
| 115 | Write side closed on Unix (`install.rs`, two reviewers could not break it); read side is 127; Windows stays path-based |
| 116 | **Open, unchanged in code; reachable by viewing a `.py` file** (151) |
| 117 | Closed for every natural form tried (~110 command lines on the compiled module). Left as hardening: `$PROJECT/../../x` stays readable; prompt and answer text cross to the phone unmasked anyway |
| 118, 119 | Closed: sidecar and window both check before restoring; no sibling action checks reach after the effect |
| 120 | **Open, unchanged** (no commit touches `mobile-web/src/shell/`) |
| 121 | Closed: only `push` runs on `main` count; a skipped test job cannot happen on `main`. Residual: Windows and macOS clippy are `continue-on-error`; tests needing `tmux` or TeX skip silently there |
| 122 | Closed for the home itself. Residual: a parent folder another account can write; contents planted under an older build are not vetted |
| 29 | One caller missed (133) |
| 41, 51 (PDF part), 22, 23, 28, 37, 38, 47, 62 | Hold as written |
| 53 | Holds for SyncTeX; the class is open for TeX sources (129) |

## Threat-model claims found false or stale

- **Lockstep row (✅ #151):** hardening does not screen host-supplied
  arguments (123) and lockstep writes through links in `.git/` (126).
- **Format row (✅ #866):** false for three Prettier shapes (132).
- **"A project folder you didn't create — nothing else runs until you act":**
  false in part: the watch read (133), the Python probes on view (151).
- **SyncTeX row:** false for the path reverse search returns (128).
- **TeX hover row:** "a preamble reads only below the folder" holds for the
  engine, not for the app's own engine-hint scan (129).
- **Python row:** the probes are not dialog-only (151).
- **Extract archive row:** correct, under-rated (125).
- **Checkpoint row:** names gap 115 as open; the write side is closed, the
  read side open (127).
- **"Fenced agent" row, account guard:** holds for no CLI as written (135).
- **PDF markup row, "only words the drawn page shows":** weaker (153).
- **Gap 113's "caps pixels per page":** false for pages with a large
  UserUnit (155, E3).
- **Gap 114's "a remote tab is refused":** no longer true (139).
- **`.github/codeql/reviewed.json`, `request_body.rs`:** "every route
  authenticates before parsing" is wrong as worded: `pair`, `challenge` and
  `login` parse first by necessity, and `open_ticket` parses before its guard
  and returns the parse error to a caller with no session. All 41
  `parse_json` calls do come after authentication.

## Hardening notes (not gaps)

- **A4, A11:** a fenced agent can write `<uid>.mode`, re-applied as
  `--permission-mode` on resume and at an idle-stop wake; equal to what it
  can do through its own home's `permissions.defaultMode`, but it touches the
  AGENTS.md rule that Tabtivity chooses no mode. Live session ids are checked
  as hex-and-dash only.
- **C3:** "Use remote" waives its dirty-tree refusal on the host's `ls-tree`
  answer; a forged answer needs the hash of bytes the host does not hold. The
  confirm says nothing about uncommitted work.
- **Loopback rule:** `ollama_client.rs:270` accepts any `*.localhost` name by
  literal; the client never follows a redirect.
- **Phone:** `GET …/next-prompt` starts a model run with no origin check;
  leaving every phone ticked in the share dialog writes `devices: null`,
  which also opens the project to phones paired later; tab labels pass bidi
  controls; one completion slot for all phones; `readCursorDialog` does not
  refuse two rows with the same key.
- **Remote hosts:** local disk use per tab is uncapped across readers
  (transcript 512 MB, OpenCode db 512 MB + WAL); the OpenCode locator reads
  `/proc/*/environ` of up to 2,000 of the login's processes over SFTP;
  tmux kill and rename lack `=` for an exact session match.
- **Import:** `apply_mode` masks to `0o777` (no setuid survives), but a
  `0o777` zip mode yields a world-writable file.
- **Printing:** printer names and job ids may start with `-` and reach
  `cancel`, `lpoptions`, `cupsenable` argv (a job id `-a` cancels all jobs);
  the test page goes to a fixed temp path with `fs::write`.
- **Viewers:** Mermaid labels keep `class`, `style` and `data-*`;
  `compile_tex` is not confined to the project roots and a magic root can
  steer Compile to any `.tex` (tier 4); notebook PNG outputs and ODT
  pictures decode with no pixel budget; a file named `constructor` or
  `__proto__` reads an inherited value as its git status in the tree;
  `snapToPointerLine` touches every text span per pointer move.
- **CI:** `gates-job.sh wait|status <dir>` prints any `output.log` the user
  can read; `gate_lock.sh` uses `mktemp -u`.
- **Voice:** hands-free on the desktop (experimental, off) sends after a
  cancel window: ambient audio is input. Piper and STT models are checked by
  SHA-256 at install, by size only at load.

## Open questions

- Which Poetry versions load project plugins on `env info` (gap 116, 151).
- Whether a `copy` event's `setData("text/uri-list")` reaches the system
  clipboard under WebKitGTK (139).
- Claude's credentials file layout for MCP tokens (134), and the login file
  formats of Qwen, Auggie and Plandex (135).
- WebKitGTK's real per-canvas limit (155); whether an HLS manifest named
  `.mp4` makes GStreamer fetch URLs.
- `serde_norway` alias limits; the `zip` crate on overlapping-entry bombs.
- Whether remote agents run unfenced on the host, which would let a
  prompt-injected agent there act as the hostile host of 123.
- Whether the desktop Reader's hands-free has a counterpart to 136.

## Coverage limits

Nothing ran on Windows, macOS, a phone, a live Ollama, an IMAP server or the
server daemon; WebKitGTK itself was never run. Still unread after all passes:

- **Agents (A):** `agent_transcript.rs` parse bodies line by line;
  `opencode_store`, `opencode_session`, `google_chat`, `muse_session*`,
  `copilot_session`, `antigravity_session` beyond greps; the Claude and
  Gemini line parsers of `token_stats.rs`; `checkpoints/mod.rs`, `worker.rs`
  and the rest of `restore.rs`; `agent_auth.rs` import, sign-out and sweep;
  the unload-hold and warm-up paths of `commands/ollama.rs`; `terminal/**`
  (read only by reviewer A's own subagent); `agent_cli_handoff`,
  `agent_relocate`, `agent_versions`, `agent_chats`, `claude_token`;
  `agent_api_keys.rs` beyond its first hunks; `skills.rs` `tree_copy`;
  `brand_migration`; the PowerShell hook bodies; `scripts/verify-cli`.
- **Phone, mail, voice (B):** all tests; `mail_engine.rs`, mail filters and
  PGP, attachment saves; `serve.rs`, `auth.rs`, `config.rs` of
  `mobile_control` (unchanged in the range); the bodies of `Home.tsx`, the
  chat rail, overview and files library, and `Terminal.tsx` outside the
  sections cited; `transcriptTurns.ts`, `chatTurns.ts`, `statusLine.ts`,
  `subagentInput.ts`; the phone's `MarkupView`, `OutboxViewer`, `pdfFrame`,
  `?voiceProbe`; `voice/{capture,vad,piper,tts,ssip}.rs`.
- **Remote, sync, CI (C):** `git_fork.rs`, `git_hosting.rs`; the bulk of
  `remote_sync.rs`, `sync_auto.rs`, `worker_sync.rs`; `slurm.rs` and
  `python.rs` remote scripts beyond their call lines; `agent_host_move.rs`;
  `brand_migration/project.rs`; OpenVPN's Windows and macOS arms, management
  interface and `write_credfiles`; `remote_transcript/{agy,codex,copilot,
  muse}.rs` beyond their write calls; `ssh_common`'s askpass and handshake;
  `ci-skip.sh`, `security.yml`, `test_gates.py`, `schema/**`,
  `subwindow.rs`, `webkit_gpu.rs`, `src-core` beyond `home_prelude`.
- **Desktop renderer (D):** `ProjectFilesView`, `FileTree`, `GitChangeTree`
  bodies; `PromptChart` and the prompt libs; `SettingsPanel`,
  `ExtendToRemoteDialog`, `TabBar`, `AppShell`; `ProjectPill`,
  `MachinesIndicator`, `OllamaPanel`, `ModelsHubSections`, `DetachedApp` in
  part; the stores `restartLocalTabs`, `promptTrail`, `diffNotes`,
  `checkpoints`, `agentModels`, `agentPrompts`, `agentResumeCost`, `boxes`,
  `remote/vpn`; `steeringSidePanel`, `steeringCockpit`; URL handling in the
  browser reader, localhost viewer and TensorBoard view; `lib/voice`.
- **Viewers:** most of `PdfViewer.tsx` and `usePdfMarkup.ts`, the markup
  layer, dock and notes UI; `printImposition.ts`, the print panes,
  `printing.rs`'s IPP/HTTP client (lines 450–770); `markup_rounds.rs`,
  `markup_pdf.rs`; the deck views and presenter; most of the 4,000-line
  `tex.ts`, `beamer.ts`, `hostTexBuild.ts`, `texPdfLink.ts`; `synctex/remote.rs`
  beyond C's read; `services::spell`; most of `CodeEditor.tsx`; the YAML
  tree and grid components and the surgical-edit and CSV-edit code (so
  "edits surgically" is unchecked); the HTML builders of `DiffView` and
  `CompareView`; `SqliteView`; drag-and-drop in the tree; `openFile`,
  `os_open`, `default_apps.rs`, `ide.rs` (gap 21); help docs, hover cards,
  calendar.
