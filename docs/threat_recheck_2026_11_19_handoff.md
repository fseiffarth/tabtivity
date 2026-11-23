# Threat recheck — the code of 2026-11-12 to 2026-11-19

> **Status (screened against code 2026-11-22):** REFERENCE (evidence for gaps 115–122). Of its eight findings, 115, 117, 118, 119, 121 and 122 are fixed in develop (see `docs/threat_recheck_2026_11_19_plan.md`); 116 and 120 are open, and 112–114 are as the "Regression check" section says except 114's plain-text paste case (`5d8906dfe`). "No fixes implemented" below is the state at review time. Not live-verified.


## Result and scope

**Eight new findings: one medium, one low-to-medium, six low. No high. No
fixes implemented.** Two read-only reviewers (A: agents, fence, credentials,
MCP lanes, git, local models; B: phone, remote/sync, viewers and links,
platform, supply chain) read the code that landed since the last recheck, with
`docs/threat_model.md` as the blueprint and the method of
`docs/threat_recheck_2026_11_12_plan.md`. This is a source review with a few
synthetic checks, not a live test and not a new audit of every historical row.
No claim of an absence of high-severity bugs follows from it: both reviewers
list a large part of the range as not read (section "Coverage limits").

- Baseline: `214933ab5` (endpoint of the 2026-11-12 review). Evidence cutoff:
  `4cf65018d`, `develop`. 533 non-merge commits, 1,176 changed files.
- The committed tree was reviewed. The checkout held other sessions'
  uncommitted edits (`agent_session.rs`, `agent_transcript.rs`, phone
  transcript files, `ProjectFilesView.tsx`, `ProjectHoverCard.tsx`,
  `ProjectPill.tsx`, `TerminalReaderView.tsx`); no finding sits in one of them.
  Line numbers are those of `4cf65018d` and will drift.
- The main session re-read the cited code for 115, 116, 117, 118, 119, 121 and
  122 at the cutoff commit; each holds as written. 120 was not re-checked and
  rests on the IntersectionObserver contract, not on a browser run.
- The reviewers' full reports (coverage matrices, refutation attempts) are in
  the ignored `tmp/threat_recheck_2026_11_19/A.md` and `B.md`.

| Gap | Severity | Finding | Evidence strength |
|---|---|---|---|
| 115 / A1 | Medium | Checkpoint restore writes and deletes through a folder swapped for a link | Reproduced at the git level (synthetic directories); Rust path read, not run |
| 116 / A2, B7 | Low to medium | The Poetry probe runs on any current `exec_trust` approval, none of which covers what Poetry reads | Read from source by both reviewers independently; Poetry not installed, plugin behaviour from its documentation |
| 117 / A3, B5 | Low | `shell_mask` leaves host paths whole after `>`, `<`, `@`, `;`, glued flags, and inside quoted paths with spaces | Reproduced on a Python port of the pattern by both reviewers independently; Rust not run |
| 118 / B1 | Low | Restoring an archived tab from the phone skips the phone's create rules | Read from source |
| 119 / B2 | Low | Archived-tab rows send the tab's raw `cmd` and every tab's label | Read from source; a test pins the current answer |
| 120 / B3 | Low | The linked-desktop clickjacking guard does not see a frame that is moved or cropped | Read from source; browser behaviour assumed from the API contract |
| 121 / B4 | Low | A tag or manual release can take bundles from a branch run whose tests were skipped | Read from source |
| 122 / B6, Hc | Low | The remote agent folder's stand-in home is created with the default umask and no ownership check | Read from source |

Gaps 112, 113 and 114 are still open and nothing in the range changed their
reach. No fixed gap was found regressed in the code that was re-read.

## Findings

### 115 / A1 — checkpoint restore writes and deletes through a folder swapped for a link (medium)

- **You do:** have per-turn checkpoints on (experimental, off by default), run
  an agent tab in the folder, then click Restore or Undo restore.
- **Attacker:** a prompt-injected agent inside that project's fence, a process
  it left running, or another agent tab of the same folder. It needs write
  access to the project folder only.
- **Evidence** (`src-tauri/src/services/checkpoints/`): `restore.rs` lists the
  differing paths and checks every one with `plain_path` (an `lstat` of each
  leading component), then acts later and by path: `std::fs::remove_file(
  store.folder.join(rel))` for every added-since path, and `git checkout
  <commit> -- :(literal)…` in batches of up to 12 KiB of arguments. No
  directory handle is held between check and use. The module comment names the
  race and leans on git's own leading-link refusal and on "the restore refuses
  while this tab's agent works". That reading is `agent_turn::state_of(uid)`
  (`mod.rs` `restore`), the `.turn` record the agent's own hook writes in the
  fence-writable live-sessions slice: a hijacked agent writes `done` and leaves
  a background process, and another tab needs only the dialog's tick.
- **Reproduction:** git 2.53.0, a store git dir with a separate work tree and
  index as `checkpoint_git_command` sets them; 200 files of 200 KB under `d/`
  plus `d/zz_target`; one `checkout <commit> -- :(literal)d/…`; a second
  process waited for the first file, then ran `mv d d.real; ln -s <outside>
  d`. 144 of the batch's files landed in the outside directory and an existing
  `outside/zz_target` was overwritten. git caches that a leading folder is a
  real folder after the first file, so its refusal does not cover a concurrent
  swap.
- **Impact:** a file whose name and content the agent chose at checkpoint time
  is written wherever the user can write (`d/.bashrc` with `d` → the home
  folder): code execution outside the fence at the next shell or login. The
  removal loop gives deletion by name the same way, with a wider window.
  Medium, not high: it needs the experimental switch, a restore click and a
  concurrent writer; there is no tier 0–2 path.
- **Not reproduced:** a read-side variant during the automatic snapshot's
  `git add -A` (a folder swapped between listing and read could put a file
  from outside the fence into the store under an in-folder name).
- **Correction:** check out into a private directory under the store, then
  install each file through directory handles (`openat`/`O_NOFOLLOW` per
  component, `renameat`; `home_io` has the pattern) and remove through
  `unlinkat` on the held parent; or on Linux run the store's git for restore
  and for the snapshot's `add` inside a one-shot fence whose only writable
  mount is the folder. Independently, stop treating the hook record as proof
  of idleness: end or freeze the folder's agent process trees before a
  restore, or say in the dialog that the check is advisory. Acceptance: the
  synthetic swap, run against the restore function with a barrier between
  check and write, leaves the outside directory untouched.

### 116 / A2, B7 — the Poetry probe runs on any current approval (low to medium)

Reviewer B reported the same path in its second pass and rated it medium if
Poetry's project plugins load on `env info`; that premise is the open point.

- **You do:** open the Python interpreter picker for a local project whose git
  hooks, `latexmkrc` or Prettier you approved once.
- **Attacker:** a prompt-injected agent in the project's fence (it can write
  `pyproject.toml`/`poetry.toml` but not the approved hooks, so the stored
  fingerprint stays current), or an upstream change pulled into an approved
  repository. Needs a Poetry that loads project plugins on the host.
- **Evidence:** `commands/python.rs` gates `poetry env info -p` on
  `exec_trust::approved_for`; its comment says Poetry "can load project-named
  plugins, i.e. run the project's code on the host". `exec_trust.rs`
  `approved_for_in` is true when any of `GitHooks`, `Latexmkrc`, `Prettier`
  has a matching stored approval; none of their subjects includes
  `pyproject.toml`, `poetry.toml` or a plugin path. The probe runs unfenced
  with the project as cwd.
- **Standing:** a changed exposure of the row "Python Run / Debug /
  interpreter dialog" (⚠️ #146), not a new class. Screen fix H8 does what its
  plan says; the gate is coarser than the claim "runs only for a project the
  user approved". The remote probe (`REMOTE_PROBE`) runs `poetry env info -p`
  on the host with no gate, as before.
- **Correction:** a `TrustKind` for Poetry whose subjects are the files it
  reads, or run the probe with plugins off (if the installed Poetry has such a
  switch — unchecked) or inside the project's one-shot fence. Acceptance:
  approved hooks plus a changed `pyproject.toml` → no Poetry run.
- **Open:** which Poetry versions load project plugins on `env info`.

### 117 / A3, B5 — the masked shell line still carries whole host paths (low)

- **You do:** nothing (paired or stolen phone); an agent has a running shell.
- **Evidence:** `mobile_control/shell_mask.rs`, pass 3: `PATH` accepts a path
  only at the line start or after whitespace, a quote, `=`, `:`, `(` or `,`;
  `WINDOWS_PATH` uses the same boundary set. On a Python port of the pattern
  these came back unchanged: `make 2>/home/alice/private/build.log`,
  `sort </home/alice/in.txt >/home/alice/out.txt`, `curl -d
  @/home/alice/private/body.json`, `gcc -I/home/alice/sdk/include`,
  `ls;/home/alice/bin/tool`, `xdg-open file:///home/alice/Documents/x.pdf`;
  `cp {/home/alice/a/b,…}` kept its first path, and `cat "/home/alice/My
  Documents/secret plan/file.txt"` kept everything after the first space.
  `shell_mask/tests.rs` has no such case.
- **Impact:** the account name and folder names outside the project cross the
  browser API, against the `mobile_control` invariant and gap 79's row ("every
  other absolute or `~/` path keeps only its leaf"). Bounded: path names only,
  and a phone that can attach reads the same line off the Terminal view.
- **Correction:** find a path by content, not by what precedes it (any `/`,
  `~/` or `file://` that starts a run of components and does not follow a
  path character), and mask a quoted span as one path. Add the lines above to
  the tests.

### 118 / B1 — restoring an archived tab from the phone skips the phone's create rules (low)

- **Evidence:** `mobile_control/host.rs` `restore_archived_tab` checks the
  session, exact origin, id shape and project, then sends
  `RestoreArchivedTab` to the window: no `shells_open`, no create verdict, no
  kind check. `MobileBridgeHost.tsx` `restoreMobileArchivedTab` restores the
  entry first and consults `phoneReachesTab`/`phoneListsTab` only afterwards,
  to choose between `created` and `activated`. The siblings check first:
  `create_tab` refuses a shell with `shells_off`, and the reopen handler
  returns `not_attachable` on `phoneMayCreate`/`phoneReachesTab` before
  reopening.
- **Impact:** with "No shells on the phone" on, a paired phone can start every
  archived shell tab of a reachable project, and archived tabs in container
  and VM projects or on the remote host. It cannot type into what it cannot
  attach to; a shell restores idle and argv passes `sanitize_loaded_layout`.
  Widens gap 67 by one route.
- **Correction:** read the entry first and refuse before `take` unless the
  phone could have created it; or list and restore agent tabs only on the
  phone (product decision).

### 119 / B2 — archived-tab rows send the raw `cmd` and every tab's label (low)

- **Evidence:** `host.rs` `archived_tab_rows`: `agent` is
  `clean(&entry.tab.cmd)` for an agent tab, and rows of kinds `shell` and
  `other` carry their labels with no `shells_open` or `files_open` condition.
  The live list maps the binary to the registry's name and never sends the
  command (`discovery.rs` `agent_label_of`). `host/tests.rs` pins the current
  answer.
- **Impact:** for a built-in CLI the value is its name; for an agent the
  registry does not list it is whatever was configured (a path, a wrapper
  script). Viewer labels are file names shown with "Project files on the
  phone" off. The `mobile_control` invariant, broken at low value.
- **Correction:** build the row with the live list's mapping and list only the
  kinds the phone's switches allow, which also narrows 118.

### 120 / B3 — the framed page's clickjacking guard misses a moved or cropped frame (low)

- **You do:** open desktop A's phone app and switch to linked desktop B.
- **Attacker:** script on A's phone origin (a compromised linked desktop).
- **Evidence:** `mobile-web/src/shell/frameGuard.ts`: the guard is clear when
  the last entry has `isIntersecting && isVisible`, observed at thresholds
  `[0, 1]`, for 500 ms; the ratio need not be 1. A frame re-positioned by
  layout or scroll while it stays unoccluded crosses no threshold, so the
  settle is not reset; a frame clipped by an ancestor's `overflow` stays
  "visible" with the attacker's text around one button. `main.tsx`: the
  `?voiceProbe` page renders outside the guard.
- **Impact:** a compromised A steers real taps into B's phone UI. Bounded by
  the two-sided link and the same tailnet.
- **Correction:** require `intersectionRatio === 1` and a minimum inner size;
  treat a change of the frame's on-screen offset between pointer events as
  covered; mount the guard above every page of the bundle.
- **Open:** whether an in-frame script can see a layout-only move in Chromium.
  A two-page browser test settles it.

### 121 / B4 — a release can be cut from a branch run whose tests were skipped (low)

- **You do:** push a `v*` tag or run the release workflow by hand (or approve
  an agent's `git_release` card).
- **Evidence:** `scripts/ci-skip.sh`: on a push to any branch but `main`, an
  OS's tests are skipped when the push's `CI-Only:` trailers leave it out and
  it was green before; branch pushes also run only related vitest files, and
  the package jobs count a skipped test job as passed. `release.yml`: the gate
  takes the newest green push run of the commit on any branch
  (`runs?head_sha=$SHA&event=push`, only `v*` branches filtered out) and a tag
  is accepted on any commit `main` holds.
- **Path:** a commit on `develop` with `CI-Only: macos` leaves Linux and
  Windows untested and "green"; after the PR merge, a tag on that commit
  releases that run's bundles, and `main`'s own run of the merge commit is
  never consulted. The automatic path (a green push to `main`) is unaffected.
- **Impact:** a build whose pinning tests (`capability_scope.rs`, the source
  scans) did not run on that content can be signed. Nothing is injected by
  this alone.
- **Correction:** in `wait_green`, count only `ci-cd.yml` runs with
  `head_branch == RELEASE_BRANCH`, or have `ci-plan` write a "full run" marker
  and require it.

### 122 / B6, Hc — the remote agent folder's stand-in home (low)

- **You do:** set an agent folder for a remote host and start an agent there.
- **Attacker:** another account on that host.
- **Evidence:** `src-core/src/services/remote_agents.rs` `home_prelude`:
  `export HOME=<dir>/<slug>-agent-home; mkdir -p "$HOME"`, then links `.ssh`,
  `.gitconfig`, `.config/git` from the real home and puts `$HOME/.local/bin`
  first on `PATH`. No `umask`, `chmod` or ownership test; `clean_agent_dir`
  checks only the path's shape.
- **Impact:** (a) on a scratch area whose default mode is world-readable,
  agent state that sat in a 0700 home becomes readable by others; (b) in a
  folder others can write, another account creates the home first and the
  user's agent runs with a `HOME` that account owns — planted hooks,
  `.gitconfig`, or a binary first on `PATH`, run as the user.
- **Correction:** `umask 077` for the `mkdir`, then refuse unless `$HOME` is a
  directory the login owns, not a link and not group/other-writable; say so in
  the setting's help.

## Regression check and open gaps

- **112, 113, 114:** open, unchanged. For 113: the page-range edit
  (`5d11c28e6`) splices the user's own page arrangement in the dialog and does
  not change what an agent's request can make Review render or Approve print.
- **3, 46, 86** (mirror confinement, held-handle push, pull caps): hold. The
  transfer and confinement functions are not in the range diff and every
  caller still goes through them; the new parallel host walk (`sync_pool.rs`)
  is tested against a copy of the old one. **107:** the claim path is the only
  change to `printRequest.ts` besides a preset. **108:** only its own fix
  touched `sync_handoff.rs`.
- **65:** fixed as recorded. **66:** holds (all 70 write handlers reach an
  origin guard, scripted scan); `/healthz` now answers a linked origin with a
  CORS header (no credentials). **67:** widened by 118. **69:** widened: the
  home page can delegate the microphone to a linked desktop's frame.
- **79:** mitigation incomplete, see 117. **#146:** narrowed, not closed, see
  116.
- **18:** unchanged on Linux and macOS; deliberately changed on Windows
  (`10233e756`): an accepted unfenced tab's `pre-push` hook runs on the host
  once `exec_trust` approved it. **19:** revival restores the recorded
  `git_at_spawn`, never recomputes. **109, 110:** both registration sites
  still call the privacy recheck; the sweep body was not re-derived.
- **Perimeter:** no change in range to `src-tauri/capabilities/`,
  `src-tauri/patches/`, `hardenPrototype.ts`, `tests/capability_scope.rs` or
  the CSP. Workflows: no `pull_request_target`, every `uses:` pinned by SHA.
  CodeQL suppressions: two new entries, both justified by the code.
- **Screen fixes confirmed by reading:** H1, H2, H3, H4 (`fetch_local`
  requires the git-hooks approval, `protocol.ext.allow=never` is pinned, the
  fingerprint covers `url.*.insteadOf`), H6, H7, H9 (`=<name>` exact tmux
  targets), H11 (one rerun flag per worker; still push-only, the "never `git
  clean`" test kept), H12, H13. H8 does what its plan says (see 116). H5 and
  H10 were not read.
- **Read and found defended:** idle-stop and wake (a wake is a normal
  `pty_spawn`), MCP stamp and revival, tab messages, the cockpit's uid
  binding, `HANDOFF.md`, skills copy, the fresh-install import question,
  per-host git tokens, branch exchange and single-file staging, Copilot remote
  buffers and keychain, the three new Ollama commands, in-app links
  (navigation only), take-the-newer-copy, the tab archive store, Antigravity
  plan links, project docs create, app-update recovery, the scaffold's
  `.gitignore` detection, the run-without-container card. The 45 new command
  rows have fitting classes; three new `dangerouslySetInnerHTML` sites all
  feed `answerHtml`/`renderMarkdown`.

## Hardening (no attack shown)

| # | Where | What |
|---|---|---|
| H1 | `checkpoints/restore.rs`, `snapshot.rs` | A file the pre-restore snapshot left out for the 256 MB budget is overwritten by the restore with no undo copy. Refuse such a path. |
| H2 | checkpoint retention | The store keeps every captured file, a secret that was not ignored included, for 14 days after it left the folder. State it; offer "forget this file". |
| H3 | `scripts/tabtivity-mcp.sh` | The loopback glob also matches `http://127.0.0.1:1@other/mcp`; the PowerShell twin's regex does not. The URL is the tab's own env, so nothing is gained today. |
| H4 | `commands/git.rs`, `git_hosting::hosts_auth` | A hooked user push has up to eight host tokens in its environment where it had one. Pass only the grant of the remote's origin. |
| H5 | `mobile-web` `DesktopFrame.tsx` | Sandbox the linked frame without `allow-top-navigation`. |
| H6 | `host.rs` `permissions_policy` | A linked frame can use the microphone under the home origin's grant. Delegate only while dictating, or not at all. |
| H7 | `DesktopShell.tsx` | A framed desktop names itself in the picker and can pick the home's name. Show the origin first. |
| H8 | `release.yml` | The release job runs `scripts/release-cli-notes.mjs` before the step that holds the signing key. Move it to a job without that environment. |
| H9 | `app_update.rs` `launch_installer` | Windows starts the staged setup elevated from a user-writable folder; hold a deny-write handle from the hash to the launch. |
| H10 | `tab_archive::list_at` | The sidecar reads the archive unsanitized (labels only today). |
| H11 | `home_io::create_subdir` | Path-based `create_dir` on Windows where Unix uses `mkdirat` on the held handle; the export folder it makes sits in an agent-writable home. |
| H12 | `commands/root_mcp.rs`, `root_mcp_reattach::PEER_CHECK` | A revived MCP token is checked against the pane's process tree only on Linux; elsewhere it is accepted unchecked, on the ground that the git and tabs lanes are not revived there. Confirm which lanes a revived token reaches on macOS and Windows. |
| H13 | `paths::die_with_parent` | Now a `setpriv` wrapper instead of `pre_exec`; where `setpriv` is missing a child gets no death signal. |

## Coverage limits

Neither reviewer ran anything on Windows, macOS, a phone or the server daemon.
Not read in the first pass, so no disposition is claimed:

- **Agents (A):** `session_host/*`, `session_mux/*`, `terminal/host_pty.rs`,
  `local_pipe.rs` beyond its head; the macOS Seatbelt and Windows shim
  commits; `agent_global.rs`/`agent_home.rs`/`home_io.rs` diffs (the Codex
  hooks and Antigravity plugins import, `062bcb539`); the hook bodies of
  Muse, Antigravity, Copilot and OpenCode; `agent_turn.rs` and
  `agent_transcript.rs` bodies; `copilot/{session,process,policy,rpc}.rs`;
  `git_peer.rs`, `git_pull.rs`, `git_release.rs`, `git_ci.rs`,
  `git_publish.rs`, `git_fork.rs`; the Hugging Face pull path; `scaffold.rs`,
  `cockpit_meta.rs`, `print_mcp.rs`, `markup_mcp.rs`, `schedule_mcp.rs`,
  `web_lane.rs`; `commands/boxes.rs`, `box_store.rs` (H5); the one-click
  install recipes; all frontend of these features.
- **Phone, remote, viewers, platform (B), after its second pass:**
  - Not read: the Windows session host and mux internals
    (`session_host/{table,screen,launch,route,copies,client}.rs`,
    `win/{conpty,job}.rs`, `session_mux/*`, `terminal/host_pty.rs`,
    `terminal/mod.rs`, `terminal/pty_child.rs`); the print commit `ee60bd72c`;
    the Data view's TeX switch and sender grouping, unread marks, editor
    `gotoLine`, autocomplete ghost rendering, the steering files, the phone's
    Mail/Calendar/To-do screens, the Machines view; the rest of `paths.rs`
    and the `fix(windows)`/`fix(macos)` commits as a set; the contents of
    `package-lock.json`, the new `vt100` crate and its three dependencies,
    `scripts/gates-job.sh`, `scripts/verify-cli/`, `pages.yml`.
  - Read only as moves (grep and function level, not line by line):
    `git_peer.rs`, `commands/sync.rs`, the loop body of `sync_auto.rs`, most
    of `git_pull.rs` after fetch and preview, `synctex.rs`, `commands/tex.rs`,
    `tfevents.rs`, `commands/apps.rs`, the second half of `pty_bridge.rs`, the
    desktop PDF viewer split and the phone `MarkupView.tsx` outside the sealed
    frame's message path.

### What the second pass of reviewer B added

The first pass left much of B's slice unread, so the same reviewer read its own
list in priority order. No new gap beyond the independent report of 116. Read
and found defended: the remote-sync refactor (above); `commands/ssh.rs` (probe
and connect time limits, no new argv from host-controlled strings); the phone
backend's move onto `session_mux` and `local_pipe` (on Windows the admin pipe
and the desktop bridge pipe now get the protected owner-only DACL and the peer
check, where they had default security before); the phone's wake of a stopped
tab (only inside `activate`, for a tab the catalog already resolved); the
Windows session host's hello, framing and token layers (pre-auth frame ≤ 8 KiB
with a 5 s timeout, constant-time token, an empty token refuses everyone, the
peer must be the same SID, not an AppContainer, same integrity); the sealed
PDF frame's message checks after the markup refactor (`event.source` and
`origin === "null"`, the frame still `sandbox="allow-scripts"`, `markup_ask`
text is React text); diff-line notes (text into the draft only), the
slash-command inbox picture and the task name in the tab strip (React text);
`mail_pgp.rs`, the gateway's `units.rs`, `commands/fs.rs`, `sheet_reader.rs`,
the two `tabtivity-mcp` scripts and `release-cli-notes.mjs` (no exec, no
network). Steering: no path found from agent or remote text to terminal
keystrokes, by commit list and a grep for terminal writers.

Open questions: Poetry's plugin loading on `env info` (116); whether
`restart_ollama_server` without systemd applies the gap-50 owner gate;
whether `agent_cli_handoff::gate` with no project id can name a Host-session
conversation; the read-side variant of 115; whether PRs into `main` are always
merge commits (121); whether the phone should restore non-agent tabs (118).

## Proposed remediation order — not implemented

1. **115** (the only path to code outside the fence), with H1.
2. **116** (decide: own trust kind, or probe inside the fence).
3. **118 + 119** together (one change to the archive rows and route), then
   **117** (the mask pattern and its tests).
4. **122**, **121**, **120** with H5–H7.
5. Hardening H2–H4, H8–H13.

Tracked in `todo/group-o-security.md`, "Threat-model recheck follow-ups
(2026-11-19)", #2443–#2451.
