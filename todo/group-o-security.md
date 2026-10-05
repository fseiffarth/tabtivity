## Group O — Project Security & Permissions (new feature)
*Files: `src-tauri/src/commands/projects.rs` (create/import), `schema/project.rs`
+ `schema/settings.rs` (new security/permission fields), `ProjectSwitcher.tsx`
(import/add dialog) + a project-settings "Security" area, download-routing in
`services/project_runtime.rs`/`commands/`. Distinct from the SSH "no in-app
passwords" stance — this is per-project policy. Ties into Group G (remote/agent
auth) and the local/remote git push axis (#21).*

58. **Security stages for project import/add.** Offer graded security modes when
    adding/importing a project, stored in project settings:
    - **Highest** — only local models allowed; no git push (optionally no git,
      no scaffolds).
    - **Restricted** — a checkable allow-list of models; no git push (optionally
      no git, no scaffolds).
    - **Lowest** — everything allowed.
    Surface as a "Security" area in project settings and enforce it where agents
    are spawned and where pushes happen.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

59. **Per-project remote-control toggle. (DONE ✅ · 🧪 Untested)** **Shipped
    2026-07-28.** `Project.remote_control: Option<bool>` (`schema/project.rs`)
    overrides the global `agent_remote_control` per project: `Some(true/false)`
    forces `claude` tabs of that project on/off, `None` (untouched — every
    existing project) inherits the global setting. `commands::terminal`'s
    `resolve_agent_remote_control` reads the override the same way
    `services::sandbox` reads a spec: from the `projects.json` entry's
    flattened `extra["remote_control"]` — the state-dir mirror, never
    `project.json` (inside the project tree / a container's rw mount). Written
    by `set_project_remote_control` (mirrors `set_project_python`'s
    write-both-stores shape). Surfaced in the pill's Runtime menu as a
    three-state cycle (inherit → off → on), i18n'd ×5.
    - **The "default off" / "flip the global default" half is deliberately NOT
      done.** Flipping the shipped global default would silently change
      existing users' Claude sessions from steerable to not, with no
      migration and no signal anyone asked for that — a bigger, more
      debatable UX call than "add a working per-project override," and one
      the original item explicitly left open ("a decision on whether the
      global default should flip"). What shipped is the unambiguous, safe
      part: a real per-project override that can force it off, with zero
      behavior change for anyone who never touches it. Revisit the global
      default separately if wanted.
    - [x] 🤖 Automated test — `commands::terminal::tests` (pure
      `agent_remote_control_effective`: no project id / unknown project /
      override-wins-both-directions / no-override-inherits-global) +
      `projects_commands.rs`'s `set_project_remote_control_writes_both_stores_and_clears`
      (both stores written; clearing removes the field rather than storing
      `null`).
    - [ ] 🖐️ Manual test — set a project's remote control to "off", spawn a
      Claude tab, confirm `--remote-control` is absent from its argv even
      with the global setting on; confirm "inherit" goes back to matching the
      global setting.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

87. **Per-tab Plan/Auto agent mode. (REMOVED — the mode is the agent's own.)**
    *(This is group-O's #87; group-M has a different #87.)* Built, then taken
    back out: an agent tab carried an optional `agentMode` (**Plan** =
    `--permission-mode plan`, **Auto** = `acceptEdits`; Gemini via
    `--approval-mode plan`/`auto_edit`) behind the experimental
    `agent_mode_toggle`, surfaced as a clickable badge in the tab strip. Gone
    with it: `components/tabs/agentModes.ts`, `TabEntry.agentMode`, the setting
    on both sides, the badge, and `src/__tests__/AgentMode{,Badge}.test.ts{,x}`.

    Everything now goes through the agent's own CLI. Two things drove that, and
    both are properties of the design rather than bugs in it:
    - **The mode was a launch flag, so a flip respawned the PTY** — the
      conversation resumed, the scrollback and any turn in flight did not. The
      agent's own in-TUI switch restarts nothing.
    - **It made the tab layout a second authority record.** A mode set inside
      the CLI and a persisted `agentMode` are two answers to one question, and
      the layout's was the one re-applied on restart.

    What is kept: `services::agent_session` still re-applies the mode Claude's
    Stop hook recorded onto the `--resume` respawn, so a mode set *in-session*
    survives a relaunch. That is the CLI's answer being preserved, not Tabtivity
    choosing one. Tabtivity Mobile's mode sheet is untouched — it presses Shift+Tab
    and verifies against the TUI's own status line
    (`mobile-web/src/terminal/agentModes.ts`), never a launch flag; only the
    desktop bridge's launch-`modes` list went (now always empty).

    Not reopening this without a mechanism that does not restart the session.
    See `docs/context/agent_authority.md`.

60. **Never manipulate the browser download path. (DONE — removed.)** Tabtivity must
    not touch any browser's download directory. The `commands/downloads.rs` module
    that edited Firefox `prefs.js` / Chromium `Preferences` was removed entirely
    (file, `mod` decl, and handler registration). Routing a download into a project
    is a security risk if the file is then pushed with the project's git, and even
    the "reset to `~/Downloads`" path still wrote into browser config — so we leave
    browser download settings fully alone.

86. **Docker sandbox on Windows (BUILT 2026-09-03 · 🧪 Untested).** *(This is
    group-O's #86; group-G has a different #86.)* Done as described in the
    remaining-work line: `sandbox::container_path` spells every host path for
    Docker Desktop (`C:\x` → `/c/x`) at the argv layer only, `--user` is
    omitted on Windows, the staged Claude/Codex configs point at a POSIX twin
    of the SessionStart hook (`tabtivity_session_start.sh`, written beside the
    PowerShell one) so in-container resume records still land, and the
    frontend gates are lifted. Still needs the real Docker Desktop box below.
    **Two premises below are now stale:**
    `services::sandbox` is **no longer** `#[cfg(unix)]` — it compiles everywhere
    (`services/mod.rs:30-36`), and the refusal lives at the call site
    (`commands/terminal.rs:149-150`). Its `staged_config_mounts_copies_and_shadows_host_originals`
    test is **not** cfg-gated either (`sandbox.rs:1935`), so there is nothing to
    "re-enable". The remaining work is only: host-path→container-path
    translation, the `--user` decision, and a real Docker Desktop box.
    Original text follows. The sandbox was Unix-only:
    `services::sandbox` was `#[cfg(unix)]` and `pty_spawn` returns a clear error on
    Windows rather than silently spawning an agent unsandboxed that the user asked
    to sandbox. It was never actually functional there — `staged_config_mounts` and
    `rw_mounts` bind host paths straight into a **Linux** container, so on Windows
    the container-side destination came out as a Windows host path
    (`C:\Users\…\.claude\settings.json`), which means nothing inside the container
    and whose drive colon also makes the `src:dst` mount string ambiguous;
    `host_uid_gid()` is equally meaningless there. CI only surfaced this by
    accident, through a test assertion rather than the feature itself. To support
    it: translate host paths to Docker Desktop's container view (`C:\x` → `/c/x`,
    or a WSL2 path), decide what `--user` should be on Windows (likely: omit it),
    and re-enable the module plus its `staged_config_mounts` test for Windows.
    Needs a real Docker Desktop box to verify — it cannot be validated from CI or
    from a Linux dev host. Ties into Group H (Windows parity).
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Sandbox-audit follow-ups (2026-07-26)

An adversarial review of the agent-tab container found ten issues (S-1 … S-10).
Eight were fixed in place; the root cause was that Tabtivity's own control files
(`project.json`, `.tabtivity/sessions/terminals.json`) live **inside** the
container's writable project mount while the host reads them back as executable
intent. What is left is listed here.

142. **DONE (2026-07-27) — Move `.tabtivity/sessions/` out of the project tree.**
    The layout and `open_apps` now live at `<state_dir>/sessions/<project key>/
    terminals.json`, keyed by **project id** rather than by the path to a
    `project.json` (that re-keying was the actual work — the whole
    `terminal_service` API took a `local_file`). `load_project` no longer serves
    the layout at all; `CenterPanel` restores from the new `load_tab_session`.
    The project-tree copy is still **written** — so a byte-synced or hand-copied
    folder keeps carrying its tabs — but is never read without an explicit click
    ("Restore layout saved in the folder…" in the pill menu →
    `adopt_folder_tab_layout`, which sanitizes and refuses to adopt `open_apps`).
    Migration is **once per installation**, so a project imported afterwards is
    never adopted from. The invariant is a test now, not a memory:
    `src-tauri/tests/project_tree_intent.rs`. The migration has run against the
    real 27-project workspace: 26 migrated (the 27th had no saved layout at all),
    85 tabs carried, zero neutered by the sanitizer.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — migration verified on the real workspace. Still worth a
      look on the next relaunch: that restored tabs come back where expected, and
      that "Restore layout saved in the folder…" adopts a synced folder's layout.
      - [x] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    <details><summary>Original entry</summary>

    The persisted tab
    layout is now *sanitized* on load (`services::terminal_service::
    sanitize_tab_layout` neutralizes any entry whose `cmd` is not a known tab
    command) and `pty_spawn` no longer trusts the renderer's `sandbox`/
    `local_only` flags (`services::sandbox::enforce_spawn_authority`). But the
    file itself still sits in the container's rw mount and in any cloned repo,
    so a planted layout is still *read* — the sanitizer is what makes it
    harmless. The cleaner fix is `<state_dir>/sessions/<project-id>/
    terminals.json`, which also removes the hostile-repo variant entirely.
    Deliberately **not** done in the audit pass: it drops the "layout travels
    with the folder" property (and with it the byte-sync/multi-host case, where a
    synced project folder currently carries its tab layout) and needs a one-time
    migration read of the old location, both of which are product decisions.
    The layout's *argv* is no longer attacker-controlled either — a persisted
    `resumeArgs` is re-derived from the frontend's `RESUMABLE_AGENTS` table or the
    custom agent's `settings.json` spec (`terminal_service::rebuild_resume_args`)
    — so what is left is the file still being *read* from the mount at all.
    Phased plan (incl. the project-tree-read tripwire that makes the invariant
    checkable rather than remembered):
    [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 1.

    </details>

143. **Confirm before adopting a repo's own `Dockerfile` / devcontainer image.
    (DONE ✅ · 🧪 Untested)** **Shipped 2026-07-28.** Detection and adoption are
    split: `services::sandbox::detect_spec_source` is now pure (reports a
    `DetectedSpecSource{kind,value,hash}`, mutates nothing), and
    `commands::projects::set_project_sandbox` takes an optional
    `source_decision` and returns a `SandboxToggleOutcome` — `Applied{spec}` or
    `NeedsConfirmation{source}`. Enabling a project whose repo currently
    declares a Dockerfile/devcontainer image and hasn't been decided about
    (`SandboxSpec.spec_source_hash` unset or stale) comes back
    `NeedsConfirmation` and writes nothing; the frontend (`ProjectPill.tsx`'s
    toggle, `ProjectDialog.tsx`'s create-time row) shows a `confirm()` dialog
    naming the root-as-build risk (`scaffold.ts`'s `describeDetectedSpecSource`,
    one wording shared by both call sites) and re-invokes with
    `{hash, adopt}`. A hash that doesn't match the live detection — a stale
    dialog, or the file changed between the two calls — is refused the same
    way rather than applied. **Re-asks when the Dockerfile changes**: the
    decision is keyed by a SHA-256 of the file's bytes (or the image string),
    so editing `RUN` steps after an adopt *or* a decline re-triggers the
    dialog; an unchanged decline never re-asks. A `dockerfile`/`image` set to
    something detection wouldn't produce (the knobs dialog, `set_project_sandbox_spec`)
    is always treated as a deliberate manual choice and never second-guessed.
    - [x] 🤖 Automated test — `sandbox::tests` (`detect_spec_sources_prefers_dockerfile_then_devcontainer_image`)
      + `projects_commands.rs` (`set_project_sandbox_preserves_spec_and_confirms_dockerfile`,
      `set_project_sandbox_decline_sticks_until_dockerfile_changes`): first enable
      with a repo Dockerfile comes back `NeedsConfirmation`; a mismatched hash is
      refused; a matching adopt/decline applies and persists; an unchanged
      decision never re-asks; a changed Dockerfile does.
    - [ ] 🖐️ Manual test — enable a project container on a repo with its own
      Dockerfile, confirm the dialog names the root/network risk, decline once
      and confirm no re-ask on an unchanged file, then edit the Dockerfile and
      confirm it re-asks.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

144. **Per-window capability split for `present-*` / `detached-*`.**
    **Re-evaluated 2026-09-18 — the "verify first" question below is answered,
    and the answer is *no*.** `capabilities/browser.json`'s own description
    says it: `build.rs` defines no app ACL manifest, and Tauri 2 checks an app
    (`generate_handler!`) command's ACL only for a **remote** origin — a
    capability file governs plugin permissions only. So a local-origin
    `present-*` webview can invoke every app command whatever
    `capabilities/*.json` says, and splitting `default.json` would narrow
    plugin permissions and nothing else. (An earlier note here claimed the
    opposite; it was wrong.) The two real shapes: declare the commands in
    `build.rs` (`tauri_build::AppManifest::commands(...)`), which puts app
    commands under the ACL for every window and needs the full allowlist for
    `main`/`detached-*` up front; or a runtime `webview.label()` guard that
    refuses everything but the presenter's handful for `present-*` — the
    smaller change, and none exists today. Scoping is by **webview**, not
    window (`capabilities/default.json:5`). Severity unchanged (low): the
    audience window only ever loads the app's own bundle.
    Original text: `capabilities/default.json` was the only capability file and applies to
    `windows: ["main", "detached-*", "present-*"]`, so every one of the ~300
    application commands is reachable from the deck presenter's audience window
    as well as the main one. Tauri v2 supports per-window command permissions.
    Deliberately deferred: detached subwindows legitimately use a wide command
    surface, and an under-specified allowlist breaks them in ways only live QA
    finds. Do the `present-*` window first — it needs almost nothing. **Verify
    first** whether Tauri v2's ACL gates app-defined (`generate_handler!`)
    commands at all, or only plugin ones — the approach changes completely, and a
    `webview.label()` runtime guard is the fallback. Plan:
    [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 5.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

145. **Narrow `~/.claude/projects` to this project's own transcript dir.**
    **PARTIAL — the write half shipped in `b36e731` (2026-07-28) and was never
    recorded here.** `claude_transcript_mounts` (`services/sandbox.rs:1423-1459`)
    now mounts per-directory: this project's own transcript dir `rw`, **every
    other project's `ro`**. `:1340` stages the parent and `:1470`
    `harvest_claude_transcripts` brings new dirs back out after teardown.
    Crucially, `transcript_cwd` (`:1349`) reads the cwd **out of the transcript**
    instead of decoding Claude's lossy directory name, with
    `transcript_name_matches` only as a fallback — which removes the
    "replicate an undocumented encoding, drift fails silently" objection this
    entry was blocked on. **Still open: cross-project *read*** — and not only in
    containers: the bubblewrap fence plans its transcript mounts with the same
    function (`agent_fence.rs:717`), so a fenced agent tab can read every other
    project's conversation history too (re-checked 2026-09-18). Reassess the
    cost note below before doing more; it no longer describes the work.
    Original text: The
    container's `~/.claude` mount is now per-entry with an exclusion list
    (`CLAUDE_UNMOUNTED`: `shell-snapshots/`, `plugins/`, `agents/`, `backups/`,
    `file-history/`, `telemetry/`, `history.jsonl`, `sessions/`, `session-env/`,
    `stats-cache.json`, `daemon.*`), which closes the host-RCE routes. But
    `projects/` is still mounted whole, and Claude keys transcripts by encoded
    cwd rather than by Tabtivity project — so a contained agent can still read and
    write **every** project's conversation history. Narrowing it means
    replicating Claude's cwd encoding on the Rust side and accepting that a
    project whose encoding we get wrong loses resume — an undocumented format
    belonging to another product, whose drift fails *silently*. Weigh that
    recurring cost before starting; needs the drift-detection fallback described
    in [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md)
    Phase 3.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

146. **Don't silently auto-select a repo-planted `.venv` (S-10).**
    `commands::python::find_venvs` (`python.rs:132-158`) offers any directory
    under the project root that holds a `pyvenv.cfg` **and an existing
    `bin/python`** (`:116` — slightly narrower than this entry claims, and it
    predates the entry, so it is not partial credit), shallowest-first, so a
    repo-committed `.venv`
    "wins auto-select" and its interpreter becomes what Run/Debug executes.
    Arguably the expected semantics of "run this project's Python" — the
    *silence* is the problem. Fix: require the candidate to be an executable
    regular file whose `pyvenv.cfg` names a real base interpreter, and ask once
    on a project's first open instead of picking. (`python.rs:177` also runs
    `poetry env info -p` with the untrusted project as cwd.) Low severity: when
    the project's container toggle is on, the run tab is contained anyway.
    **Re-evaluated 2026-09-18 — still open, and now the odd one out.**
    `services::exec_trust` has since put every other project-supplied program
    Tabtivity runs on the host (git hooks, `latexmkrc`, the project's prettier)
    behind an ask-once fingerprint; nothing in `python.rs` touches it, so an
    in-tree `.venv/bin/python` still wins auto-select unprompted and
    `poetry env info -p` still runs with the project as cwd (`python.rs:230`).
    Preferred fix is now a fourth `TrustKind` (the in-tree interpreter +
    `pyvenv.cfg`, and `pyproject.toml` before the poetry probe) rather than the
    bespoke first-open prompt described above.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

147. **Surface "container not applied" for a remote project.** A local project
    that had the container enabled and was later extended to remote keeps its
    `sandbox.enabled` spec while every tab runs unsandboxed on the remote host —
    possibly an HPC login node. The spawn path no longer does this silently
    (`wrap_pty_options_docker` logs it at `services/sandbox.rs:598-617`, and
    `enforce_spawn_authority` clears the flag). **Premise correction:** the pill
    does *not* show the toggle as on — `ProjectPill.tsx:1848` hides the whole
    container section for `project.remote`. A hidden control is precisely what
    makes the retained spec invisible, so restate the ask as a **positive
    warning** that a stale `sandbox.enabled` is being ignored, not as fixing a
    wrong toggle state. Refusing the spawn was rejected because it would break
    exactly the projects that were extended from a container-toggled local one.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

148. **Guard the provider CLI's positional arguments. (NOT A PROBLEM ✅)**
    `commands::git_publish::local_publish` passes `repo_name` to `gh repo create`
    / `glab repo create` as a bare positional, which would be option injection
    for a project named `-something`. It cannot be: `repo_name` is
    `commands::projects::sanitize_name(&project.name)`, which maps every
    non-`[A-Za-z0-9_-]` character to `-` and then joins the non-empty
    `-`-separated parts — so a leading `-` is dropped by construction and the CLI
    never sees an option-shaped positional. Verified by reading the only call
    site (`git_publish.rs:363`); no code change. Kept as a record so the next
    audit does not re-raise it.

150. **DONE (2026-07-27) — Stop keying host-bound authority on a usage-stats env
    var.** `is_host_bound_local_agent(cmd, marker)` now takes a *registered marker*
    instead of the tab's env: a local-model tab mints a uid at creation
    (`src/lib/remote/hostBound.ts` → `register_host_bound_tab`), the backend writes
    `<state_dir>/sessions/<project>/host_bound/<uid>`, and the spawn path checks
    for that file. `TABTIVITY_LOCAL_MODEL` is a usage label again. Markers are pruned
    on every layout save against the uids still in the layout.
    Two corrections to the plan, both worth knowing: the uid is **not** already
    stable across relaunch (`loadFromLayout` re-mints every key *and* the PTY id),
    so it is minted once and persisted as `hostBoundUid`; and with #142 done this
    is mostly a **decoupling** fix, not a containment one — it stops a
    display-only change to a telemetry var from silently granting container
    escapes. It does not defend against a compromised renderer, which can call the
    registration command as easily as it can spawn. That case is the CSP's.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test — open an Ollama/vibe tab in a container-toggled project,
      confirm it still runs on the host, and that it still does after a relaunch.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

    <details><summary>Original entry</summary>

    `services::sandbox::is_host_bound_local_agent` lets a tab skip the container
    when its `cmd` is in `HOST_BOUND_LOCAL_AGENT_CMDS` **and** its env carries
    `TABTIVITY_LOCAL_MODEL` — and both came from the persisted layout, i.e. from
    inside the container's own writable mount. `TABTIVITY_LOCAL_MODEL` was never an
    authority marker: `TabBar.tsx`/`NewTabMenu.tsx` set it so the usage recap can
    break local-agent tabs down by model, so an authority decision was keyed on a
    telemetry label. The **arbitrary-argv half is fixed** (`resumeArgs` is now
    re-derived from `RESUMABLE_AGENTS` / the `settings.json` custom-agent spec by
    `terminal_service::rebuild_resume_args`, so a planted entry gets the agent's
    own resume flag and nothing else) — what remains is a *containment* bypass:
    such a tab runs on the host rather than in the container. Fix: record
    host-bound-ness in `<state_dir>/sessions/<project>/host_bound/<tab uid>` at
    genuine tab creation and require it alongside the cmd allowlist; the tab uid
    is already stable across relaunch, so a legitimate restored Ollama tab is
    unaffected. Do it with #142's Phase 1a, which builds the per-project
    state-dir keying. Plan: [`docs/sandbox_hardening_plan.md`](../docs/sandbox_hardening_plan.md) Phase 2.

    </details>

149. **Confine `pty_spawn`'s `cwd` to the owning project. (DONE ✅ · 🖐️ Untested)**
    **Shipped 2026-07-29.** `commands::terminal::pty_spawn` now rejects a spawn
    whose `project_id` is `Some` and whose (already-resolved) `cwd` sits outside
    that project's sanctioned root, right after the existing `local_only`
    mirror-resolution step and before session/remote-control logic reads
    `project_id`. The root is `services::sandbox::project_dir_for(project_id)`
    for a local project (already the bind-mount root docker uses, so a git
    worktree at `<dir>/.tabtivity/worktrees/<name>` passes as a subdir — no second
    enumeration needed) or `services::remote_sync::mirror_dir(project_id)` for a
    `local_only` tab of a remote project (exactly what that branch had just set
    `cwd` to, so this only ever catches a caller that supplied its own instead).
    A **truly-remote** tab (`is_remote && !local_only`) is exempt outright: its
    `cwd` names a path on the far host, which this process cannot check, and the
    ssh-wrapped command does the `cd` over there. The "run tab on an absolute
    path" case flagged below turned out not to be a counterexample:
    `lib/terminal/pythonRun.ts`'s `runCwd` only falls back to the file's own directory
    when the viewer has **no** project (root-scope tab, `project_id: None`),
    which the gate already exempts. Comparison is component-wise
    (`Path::starts_with`), mirroring `services::sandbox::cwd_is_within`'s shape
    but kept as a separate function (`cwd_within`) since that one only
    classifies a docker mount rw/ro and this one refuses the spawn outright.
    - [x] 🤖 Automated test — `cwd_within_accepts_project_dir_and_subdirs` /
      `_rejects_sibling_and_unrelated_paths` (`commands/terminal.rs`), plus the
      full `cargo test`/`cargo clippy -D warnings` suite stays green.
    - [ ] 🖐️ Manual test — open a shell tab normally (still works), then try
      to reproduce the original exploit shape (a `project_id` paired with an
      unrelated `cwd`) and confirm `pty_spawn` refuses it with the new error.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

151. **A repo's own `.git/config` is executable intent too. (MITIGATED ⚠️ · not
    fully closed)** The same sentence as #142, with git as the executor instead
    of Tabtivity: `services::sandbox` bind-mounts the project directory whole —
    `.git` included — into the container's rw mount, and every host-side git
    call runs in that directory with the repo's config honoured. So a
    contained agent writing `.git/config` gets code execution **on the host**.
    The sharpest is `core.fsmonitor`, whose hook form git runs on a plain
    `git status` — and `git_file_statuses`/`git_status` are polled continuously
    for the file tree, so the chain needs no user action at all. `diff.external`
    and `diff.<driver>.textconv` are the same class via the diff viewer and the
    file-status poll. All three verified to execute against a live repo.
    - **Shipped (exact keys)**: every invocation in `commands::git::run_git`
      (local *and* the SSH path) goes through `hardened_git_args` — `-c
      core.fsmonitor=false`, `-c protocol.ext.allow=never`, plus
      `--no-ext-diff --no-textconv` on the subcommands that accept them. The
      two unattended spawns that build their own `Command`
      (`commands::usage_stats`'s recap `log`, `commands::fs`'s
      `ignored_paths_under` status) use the shared `hardened_git_command_in`.
      Tested in both directions (`a_repos_own_config_cannot_run_a_program_on_the_host`).
    - **Shipped 2026-07-28 (attacker-named keys)** — the structural fix, done
      as the narrower of the two shapes #142 named (not "stop exposing `.git`
      rw", which breaks in-container commits): before every **local** git
      call, `commands::git::sanitize_repo_git_config` reads the project's
      `.git/config` as a plain file (never as a repo — this itself cannot
      trigger a filter/hook) via `git config --file … --list --no-includes`,
      and strips any key matching `CONFIG_DENYLIST` — `filter.*.clean`/
      `.smudge`/`.process`, `diff.*.textconv`/`.command`, and `include.path`/
      `includeif.*.path` (closing the include-laundering bypass a filter/diff
      -only list would otherwise have). Unlike a `-c` override this matches by
      key *shape*, so the attacker's choice of driver name doesn't matter —
      closing the `filter.<driver>.clean` residual this item is named for.
      Wired through the same `hardened_git_command_in` chokepoint as the
      exact-key hardening, so `run_git`'s local branch and both standalone
      spawns get it for free. **Known cost, stated in code**: a repo that
      legitimately uses a content filter (Git LFS is the common case) loses it
      for every local git call this codebase makes — there is no way to keep
      "some filters, but not attacker-chosen ones" here, since the command
      name *is* the filter's entire configuration surface.
    - **Re-evaluated 2026-09-18 — most of the residual below is closed.**
      `services::exec_trust` (`TrustKind::GitHooks`) fingerprints the hook
      files plus `core.hooksPath`, `core.sshCommand` and `credential*.helper`
      and asks once before Commit / Push / Reword / Publish
      (`git.rs` `require_hook_trust` + `push_local`, `git_publish.rs`
      `local_publish`); `git_checkout` and the worktree verbs pin
      `core.hooksPath=` (`NO_HOOKS_CONFIG`); #158 mounts `.git/config` and
      `.git/hooks` read-only for fenced and contained agents. The
      "unhardened" line is stale too: `git_peer` runs local git through
      `hookless_git_command_in`, `git_publish` through
      `hardened_git_command_in`, and no bare `Command::new("git")` is left
      outside tests. **What is actually still open:** remote git calls are not
      sanitized, the Git LFS cost above, and #158's create-a-`commondir`
      residual for a plain `git` in the user's own terminal.
    - **Residual as written on 2026-07-28 (superseded, kept for the
      reasoning)**: `.git/hooks/*` and `core.sshCommand`/
      `credential.helper` fire only on **user-initiated** writes (Commit,
      Push, Checkout) — a repo's own hooks are a feature there, and a config
      denylist can't reach a hook anyway (a file in a well-known directory,
      not a config key). Blocking `credential.helper`/`core.sshCommand` by key
      would also break a legitimate use (a helper or SSH wrapper set from
      inside a container, meant to carry to the host's later push) the same
      way blocking `filter.*` breaks LFS — closing them without that cost
      needs value-level judgment (an allowlist of known-safe values), not
      attempted here. `services::git_peer`/`worker_sync`/`git_publish` remain
      unhardened and out of scope (a *remote* project's mirror, never
      container-mounted), and neither is `sanitize_repo_git_config` run for
      **remote** git calls (a project container is local-only, so the
      container→host escalation this closes has no remote counterpart there).
    - [x] 🤖 Automated test — `sanitize_stops_a_repo_local_filter_clean_driver`
      (the named residual, closed), `sanitize_closes_the_include_laundering_bypass`
      (the bypass a naive filter/diff-only list would have, closed, plus an
      assertion the strip leaves unrelated config — `user.email` — alone),
      `config_denylist_matches_the_named_shapes_and_nothing_else` (the pure
      matcher, both directions).
    - [ ] 🖐️ Manual test — toggle a project's container on, have an agent
      inside it write `filter.evil.clean`/`.gitattributes`, confirm the host
      file tree's git status doesn't run it; confirm a real Git LFS repo's
      filter is (expectedly) inert for host-side status/diff/add while a
      container is active.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

152. **One gate for "this is already a project". (DONE ✅ · 🧪 Untested)** Importing
    or creating a project on a site another project already owns used to be
    refused in exactly one case — a local `keep` import of the same directory
    string — and `create_project` had no check at all. Three consequences, all
    data-shaped rather than cosmetic:
    - A **remote** project's registered `directory` is a per-id state dir, so the
      comparison could never match: the same `host:/path` could be imported any
      number of times, each copy with its own mirror and its own lockstep +
      byte-sync state driving one host tree, none aware of the others.
    - The check ran **after** the mode dispatch had already moved the files, so
      re-importing a registered folder under a different name in `move` mode moved
      the tree out from under the original entry and left it pointing at a path
      that no longer existed.
    - It compared raw strings, so `/a/foo`, `/a/foo/` and a symlink into it read as
      three different projects.
    - **Shipped**: `find_project_conflict` in `commands::projects` is now the one
      resolver, over a `ProjectSite` that is a local directory *or* an SSH
      target + host path (`ssh_target_key` mirrors the frontend's
      `machineSync.sameTarget` — host case-insensitive, default port 22, a
      different login is a different site). `create_project`, `import_project`,
      `finish_import` and `extend_project_to_remote` all route through it;
      `import_project` runs it **before** the move/copy touches the disk. A remote
      project's **mirror** counts as an owned tree, and `remote_mirror_in` now
      avoids a path another project has registered as well as one that exists.
      `copy` mode stays exempt on purpose — it duplicates into a new directory and
      leaves the source registered and intact, which is a real thing to want.
    - The dialog pre-checks via `check_project_site` and names the colliding
      project with an **Open it** button, so a clone/fork no longer downloads a
      whole repository into a destination the backend is about to refuse.
    - Known limit: a host path is compared as typed, so `~/work` and
      `/home/alice/work` are two sites. Only the host can expand `~`, and browsing
      to a folder always yields an absolute path, so this is reachable only by
      hand-typing the path.
    - [x] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

153. **Harden Tabtivity Mobile's local unlock into a cryptographic gate (PROPOSED
     — needs sign-off).** From the 2026-08-28 mobile security re-review. Today
     the phone's app lock (`mobile-web/src/localLock.ts`) is a UI gate: the
     device signing key is a non-exportable `CryptoKey` in IndexedDB usable by
     any script in the Serve origin, and the PIN is a PBKDF2 verifier that
     wraps nothing — so an unlocked, running phone plus origin script (remote
     debugging, or setting the `sessionStorage` unlock flag) bypasses the lock.
     Not a bug: the UI states this posture honestly ("protects against casual
     access to an unlocked phone"). The proposed enhancement uses the WebAuthn
     **PRF extension** to derive a wrapping key from a platform-authenticator
     assertion and store the device key **encrypted at rest**, so no usable key
     exists without a biometric/device-lock assertion where PRF is supported;
     PIN-only and PRF-incapable phones keep today's behavior (no lockout).
     Full spec — enrollment/unlock/migration, the extractable-key tradeoff, and
     the residual it does *not* close (unlocked-and-running) — in
     [`docs/tabtivity_mobile_future_plan.md`](../docs/tabtivity_mobile_future_plan.md)
     §G. Needs the user's sign-off on the extractable-key tradeoff before any
     implementation.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

154. **Screenshots ask before they land in a project — and never auto-file.**
     ✅ Implemented · needs live QA. A capture used to be written straight into
     the active project's `screenshots/` folder, which for a project with a
     public git remote is a private-data leak one `git add -A` away: a screen
     grab holds whatever was on screen (another project's window, mail, a token
     in a terminal), not just the thing being documented. Now the OS region
     tool is directed at a **staging area** outside every project tree
     (`<state_dir>/screenshots-pending/`, so no file watch, git status or sync
     loop sees it), the backend reports the PNG as a `screenshot-captured`
     event, and `layout/ScreenshotSaveOverlay` asks for project / folder / name
     before anything is written (`save_pending_screenshot` moves it,
     `discard_pending_screenshot` deletes it, a 24h sweep collects shots whose
     overlay never got an answer). The clipboard copy is unchanged and
     unconditional — that is what makes Discard cheap. The PDF viewer's in-app
     region crop goes through the same overlay instead of writing itself.
     `screenshots/` is now in `GITIGNORE_DEFAULT`, so scaffold repair adds it to
     existing projects too. Also **Shift+click on the Screenshot button waits
     5 s** before the tool starts (`SCREENSHOT_DELAY_MS`): a region overlay
     grabs the pointer *and* the keyboard, so Alt+Tab is impossible once it is
     up — the delay is the only window in which the target window can be
     brought forward. Countdown rides the existing switch toast.
     - Audit at the time (2026-08-31): no auto-named `Screenshot-*.png` was ever
       committed in any Tabtivity project; the only screenshots in this public
       repo's history are the deliberate README assets.
    - [x] 🤖 Automated test — `src/__tests__/system/ScreenshotDelay.test.ts` (countdown,
      throttled-timer firing, restart, cancel), `commands::screenshot` staging
      confinement + TTL sweep, `scaffold_project_gitignores_screenshots`.
    - [ ] 🖐️ Manual test — needs a backend restart. Press Screenshot: the
      overlay should open on the crop with a preview, Save should land it where
      named, Discard should leave the clipboard paste working. Shift+click
      should count down and let an Alt+Tab land first.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

155. **A bind-mounted config file cannot be rewritten (DONE ✅ · 🖐️ Untested).**
    The fence shadowed `~/.codex/config.toml`, `~/.claude/settings.json`,
    `~/.claude/settings.local.json` and `~/.claude.json` by bind-mounting a
    per-project copy over each one. `rename(2)` onto a mount point is `EBUSY`,
    and all of these agents persist config by writing a sibling temp file and
    renaming it over the original — so Codex died on the very first write a new
    project provokes: `Failed to set trust for <project>: … failed to persist
    config at /home/…/.codex/config.toml (code -32603)`. Verified directly:
    `mv` onto a bind-mounted file returns `Device or resource busy`. Fixed by
    binding the scope's whole staging dir once at
    `agent_fence::STAGE_MOUNT` (`/run/tabtivity-agent-config`) and making each
    shadowed path a `--symlink` into it: an in-place rewrite still lands in the
    throwaway copy, a rename replaces the *link* with a plain file in the home
    tmpfs, and neither reaches the host original.
    **Still open — the same bug in the two places the symlink trick does not
    reach:** (a) project containers still `-v` the copies file-by-file, and
    `~/.codex` there is created root-owned by docker, so a link cannot simply be
    made from inside; (b) the genuinely host-writable per-entry file mounts
    (`~/.codex/auth.json`, `~/.claude/.credentials.json`) hit the same `EBUSY`
    when the agent rotates a token, and they cannot be shadowed — a fix means
    mounting their parent, which is exactly the narrowing
    `CLAUDE_UNMOUNTED`/`CODEX_UNMOUNTED` exist to keep.
    - [x] 🤖 Automated test — `agent_fence::tests::bwrap_argv_orders_home_mounts_roots_and_command`
      (the config path is a `--symlink`, never a mount destination, and the stage
      mount precedes it), `staged_shadow_becomes_a_link_into_the_stage_mount`.
    - [ ] 🖐️ Manual test — needs a backend restart. Open a Codex tab in a
      brand-new project and let it ask to trust the folder: it must record the
      trust without the `failed to persist config` error, and
      `~/.codex/config.toml` on the host must stay unchanged.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

156. **A long-lived agent tab logs itself out (DONE ✅ · 🧪 Untested).** The
    "(b)" of #155, met for real: agent tabs open for a few hours showed
    `● Login expired · Please run /login` while a freshly opened tab and a
    terminal-run `claude` were fine. `~/.claude/.credentials.json` was one of
    the per-entry **file** bind mounts, and a file bind mount pins an *inode*.
    Claude Code rotates the file by atomic rename — temp file + `rename(2)`,
    a new inode at the same path — so the host and every later tab followed
    the path to the fresh token while every tab already running stayed bound
    to the orphaned old inode: stale access token, refresh with a refresh
    token the server had already rotated away, cleared record, "Login
    expired". Measured 2026-09-07: host inode 122169946 with real tokens;
    the same path through `/proc/<pid>/root` of nineteen live fenced tabs,
    inode 122170138, 280 bytes, both tokens empty. And the tab could not
    repair itself: a rename onto a bind-mount point is `EBUSY` (#155).
    Not the symlink trick from #155 — Claude 2.1.263 opens the store with
    `O_NOFOLLOW` and answers `refused-symlink`/`ELOOP` — and not the whole
    `~/.claude` directory, which would fail *open* for every deny-listed
    entry created after spawn. Fixed by `services::agent_creds`: a
    Tabtivity-owned mirror at `<state_dir>/agent-creds/claude/.credentials.json`
    (0600) whose inode never changes is what the fence and the project
    container mount at the real path (`.credentials.json` joined
    `CLAUDE_UNMOUNTED`; `sandbox::claude_credential_mounts` owns the
    destination, like the staged shadows own `settings.json`). A keeper
    thread (`notify` on both parent directories — a watch on the file dies
    with the rename — plus a 60 s poll) rewrites the mirror **in place** when
    the host changes and carries a refresh a tab persisted back to the host
    the same way; identical bytes are a no-op both ways, and a cleared record
    is never pushed host-wards. The later `expiresAt` wins, then mtime, host
    on a tie. The plan seeds the mirror at spawn, so a new tab starts current.
    macOS unchanged (Seatbelt cannot substitute; the real file stays
    writable). Codex left alone on purpose: `~/.codex/auth.json` is written in
    place (a live fenced Codex tab and the host share one inode), so its pin
    is harmless.
    - [x] 🤖 Automated test — `agent_creds::tests`: the mirror keeps its inode
      across a host rename-rotation and a shorter rewrite, stays 0600 in a 0700
      dir; a cleared record is refused host-wards and the pass restores the
      tab's copy instead; identical content is a no-op both ways; a missing
      host file creates nothing in either direction; a fenced refresh reaches
      the host in place; later expiry wins, host wins ties, a host logout
      sticks unless the tab wrote later. `sandbox::tests`: the per-entry
      planner no longer mounts `.credentials.json`; the credential pair is the
      mirror at the real path, seeded at plan time, and absent when logged out.
    - [ ] 🖐️ Manual test — needs a backend restart. Open an agent tab, note
      `stat -c %i ~/.claude/.credentials.json`, wait past the token's
      `expiresAt` (or run `claude` in a plain terminal until it refreshes) and
      confirm the inode changed on the host while the tab keeps working; then
      `stat -c %i <state_dir>/agent-creds/claude/.credentials.json` must not
      have changed and `/proc/<tab pid>/root/$HOME/.claude/.credentials.json`
      must hold the new token. Tabs opened *before* the restart stay bound to
      the old inode and must be reopened once.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

---

157. **Agent fence compatibility-preserving hardening (implemented · untested live).**
    Retry failed tool probes; label status as prospective spawn policy and fix
    macOS/shared-state wording. Hide Cargo registry credential files by default
    with an explicit Settings opt-in. Give Linux Codex tabs private writable
    skills/plugins and fresh shell snapshots; macOS protects the shared content
    read-only. Preserve shared login credentials, token refresh, session stores,
    resume databases and native CLI updates.
    - [x] Automated regression coverage: probe recovery, Cargo mask ordering and
      opt-in, symlink aliases, independent writable content copies, unchanged
      login/resume mount selection, and existing credential/database tests.
    - [ ] Manual: after a deliberate backend restart, open multiple agent tabs
      without logging in again; verify token refresh and resume after relaunch.
    - [ ] Manual: skills/plugins load, shell tools run, native CLI updates work;
      verify macOS startup and skill/plugin update behavior.
    - [ ] Manual: install missing bubblewrap, then open a tab without restarting;
      confirm Cargo publish credentials require the opt-in for a new tab.

158. **A `.git` *file* skips the repo-config sanitizer — and nothing sandboxed
    is kept out of `.git/` (sanitizer part FIXED; read-only `.git` mounts
    implemented, `services::git_guard` — both not live-verified).** Fixed:
    `commands::git::repo_config_files`
    resolves the git dir like git's discovery without running git in the repo
    (walk up to the nearest `.git`, one `gitdir:` hop, `commondir`,
    `config.worktree`), and `HARDENED_CONFIG` pins
    `safe.bareRepository=explicit` against a bare-layout folder.
    `GIT_ATTR_SOURCE`=empty tree was rejected: with `core.autocrlf` unset an
    `eol=crlf` repo then shows every file modified.
    Original report: `sanitize_repo_git_config` reads only
    `<project>/.git/config` and returns early when that is not a file, so a
    project whose `.git` is a pointer (`gitdir: .notgit`) keeps any
    `filter.*`/`diff.*` driver in the redirected config. Reproduced 2026-09-18
    with Tabtivity's exact flags (`-c core.fsmonitor=false -c protocol.ext.allow=never`,
    `--no-ext-diff --no-textconv`): the clean filter executes on `git diff` and
    on `git status` after a same-size edit, i.e. from the file-tree poll with no
    click. Reachable by a downloaded folder added as a project, or by a fenced/
    containerised agent that swaps `.git` for a pointer (the published
    "trust handoff" class — Pillar Security, CSA 2026). Tabtivity's own agent
    worktrees use the pointer layout, so the sanitizer is a no-op there too.
    Fix shapes: resolve the real git dir (and `commondir` + `config.worktree`)
    from the pointer file before sanitizing, without invoking git in the repo;
    or read attributes from the empty tree (`--attr-source` /
    `GIT_ATTR_SOURCE`, git ≥ 2.40) on unattended calls so no in-tree
    `.gitattributes` can bind a filter. Separately: mount `.git/hooks`,
    `.git/config` and `config.worktree` read-only in the agent fence and
    project containers, which is what closes hooks too (#151 residual). See
    `docs/threat_model.md` tiers 0 and 3.
    - [x] 🤖 Automated test — pointer-file repo with a `filter.*.clean` driver:
      `hardened_git_command_in` + `status`/`diff` must not execute it
      (`commands::git` tests: gitdir pointer, linked worktree + `config.worktree`,
      project below the repo root, implicit bare layout).
    - **Read-only `.git` mounts — implemented 2026-09-18 (🧪 untested live).**
      `services::git_guard::guard_paths` names the control files (`config`,
      `config.worktree`, `hooks`, `commondir`, `.git` pointer files, incl. every
      `.tabtivity/worktrees/*`); the fence binds them `--ro-bind` after the root
      grant and binds `.git` onto itself (a mount point can't be renamed away);
      containers get the same as `:ro` volumes, outside the fingerprint so a new
      file can't recreate the container under live tabs. Verified with real
      bubblewrap: commit/branch/stash/gc work; writing config or hooks,
      rewriting a worktree pointer or its `commondir`, and renaming `.git` all
      fail. **Residual**: the agent can still *create* `commondir` in a main
      `.git` (verified to redirect config/hooks for plain git) or `git init`
      a new repo — a read-only bind can't cover a file that doesn't exist yet.
    - [x] 🤖 Automated test — `git_guard` tests (plain repo, Tabtivity worktree,
      hostile pointer, repo outside the roots, no repo) and
      `git_control_files_are_rebound_read_only_after_the_root_grant`.
    - [ ] 🖐️ Manual test — fenced agent tab: `echo x > .git/hooks/post-checkout`
      must fail, and `git commit` must still work.
    - [ ] 🖐️ Manual test — container project: the same two checks inside a
      container tab (docker nests the `:ro` binds; not run live).

159. **Freeze the JS prototype for the IPC bridge (DONE ✅ · 🧪 untested
    live).** Not via `app.security.freezePrototype`: Tauri injects that into
    every webview, the in-app browser's live pages included, and a bare
    `Object.freeze(Object.prototype)` breaks pdf-lib — under it 9 test files
    fail (PDF notes/redaction/save, deck export: `PDFHeader.prototype.toString
    = …`, the "override mistake"). `lib/hardenPrototype.ts` first turns each
    method into an accessor whose setter defines an own property on the target
    (SES-style override taming), then freezes; `main.tsx` calls it before
    bootstrap. The whole suite passes under it.
    - [x] 🤖 Automated test — `HardenPrototype.test.ts`, plus a one-off full
      suite run with the hardened prototype (513/513 files).
    - [ ] 🖐️ Manual test — after a reload, smoke the PDF viewer (add a note,
      save), deck export, mail, terminal, markdown with Mermaid/KaTeX.

160. **Sign release artifacts the updater installs.** `services::app_update`
    pins asset URLs to this repo's GitHub releases but checks no signature or
    checksum, so a compromised GitHub account or CI run ships code straight
    to every user who clicks Install. Sign in CI (minisign or the Tauri
    updater key) and verify before `install` runs the staged file.
    - **Was blocked on the key (2026-09-18).** Planned shape, no new crates: CI
      signs each asset with `openssl dgst -sha256 -sign` (ECDSA P-256, key in
      the `RELEASE_SIGNING_KEY` secret) and uploads `<asset>.sig`; the updater
      hashes while downloading and verifies with the `p256` crate against a
      public key compiled in, refusing an unsigned or mismatched file. The
      maintainer generates the key pair; only the public half enters the repo.
    - **Built 2026-09-24 (not live).** Shape changed from per-asset `.sig`:
      the release job publishes `SHA256SUMS` + `SHA256SUMS.sig` (one DER
      signature, checked in CI against the committed public key) and fails when
      the `RELEASE_SIGNING_KEY` secret is missing. The updater verifies the list,
      requires the asset name to carry the release version (no signed
      downgrade), hashes while downloading and again before `install`.
      Key pair from `scripts/release-signing-keygen.sh`; public half in
      `src-tauri/release-signing.pub.pem`.
    - [x] 🤖 Automated test — openssl signatures (low- and high-S) verify;
      tampered list, foreign key, wrong version, duplicate or missing entry are
      refused (`services::app_update` tests).
    - [ ] 🖐️ Manual test — after the first signed release: Settings → Updates →
      Download on an AppImage build installs it; the release page shows
      `SHA256SUMS` and `SHA256SUMS.sig`.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Threat-model re-evaluation follow-ups (2026-09-24)

Found by the four-way re-read of `docs/threat_model.md` (its "Open gaps"
table). Code-read findings; only #862 was reproduced (scratch repo, git 2.53).

861. **A fenced agent can plant binaries Tabtivity runs on the host.**
    `updatable_install_dirs` (`services/agent_fence.rs`) binds `~/.local/bin`
    and `~/.local/share/<tool>` read-write for a native-installed CLI, and
    `paths::effective_path` prepends `~/.local/bin` to every child's PATH. A
    planted `~/.local/bin/git` runs at the next file-tree poll, unfenced; a
    planted `bwrap` unfences later tabs. Keep the CLI self-update working
    without handing the agent the shared launcher dir, and resolve Tabtivity's
    own `git`/`bwrap`/`tmux`/`ssh` so a user-writable dir can't shadow them.
    - **Fixed 2026-09-24 (not live).** Private per-tab `~/.local/bin` bound over
      the host's; `reconcile_launcher` carries back only the launcher link into
      its share root. `paths::system_executable` / `helper_program`: bwrap only
      from root-owned dirs (fail closed), git/tmux/ssh/rsync prefer them.
      macOS fence: launcher dir read-only, so `claude update` there can't swap
      the link — **your call** whether that matters.
    - [x] 🤖 Automated test — the fence argv binds no user-shared bin dir
      read-write; internal tool resolution ignores a planted `~/.local/bin/git`.
    - [ ] 🖐️ Manual test — fenced native Claude: `touch ~/.local/bin/git`
      fails; `claude update` still works.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

862. **Planted hooks run through Tabtivity's hooks-live git calls.**
    `hardened_git_command_in` leaves hooks live; diff, stage, file diff,
    commit-message generation and the merge-state probe rewrite the index and
    fire `post-index-change`. A fenced agent can *create* `.git/commondir`
    (git_guard can't cover a file that doesn't exist) to redirect hooks, and
    plant `MERGE_HEAD` so opening Git history reaches it. Hooks off by default
    in the hardened helper, on only for the verbs `exec_trust` gates; treat a
    `commondir` inside a main `.git` as hostile. Widens #158's residual.
    - **Fixed 2026-09-24 (not live).** Hooks off on every Tabtivity git call but
      the `exec_trust`-gated verbs (`run_git_hooked`/`hooked_git_command_in`);
      `GIT_COMMON_DIR` pinned to a main `.git`. Tabtivity's stage/checkout/fetch
      no longer run your own `post-*` hooks.
    - [x] 🤖 Automated test — a `commondir`-redirected `post-index-change` does
      not run on diff/stage/merge-state.
    - [ ] 🖐️ Manual test — after the plant, open the Git panel, diff a file,
      stage it: no hook output.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

863. **SFTP entry names escape the mirror.** `sftp.rs` drops only `""`, `.`,
    `..`; `remote_sync::join_rel`/`mirror_local_path` join the rest unconfined
    and `replace_local_atomic` writes there — a hostile remote account returns
    `../../.config/autostart/x.desktop`, auto-sync writes it. Also: parents are
    followed, so a directory symlink planted in the mirror redirects a pull.
    Names must be one component; the local path is confined to the mirror;
    parents must not be symlinks.
    - **Fixed 2026-09-24 (not live).** `sftp::is_single_component_name`;
      `remote_sync::confined_mirror_path`/`confined_mirror_dir`/
      `write_mirror_file`; rsync destination, local delete and
      `hpc_ws_pull_logs` confined too. Residual: check-then-write, no `openat`
      walk; a push can read through a symlinked mirror dir.
    - [x] 🤖 Automated test — traversal names and a symlinked parent are refused.

864. **Secrets in world-readable argv.** `tmux_local.rs` passes MCP tokens as
    `tmux -e K=V`; `sandbox.rs` passes agent API keys as `docker exec -e K=V`.
    `/proc/*/cmdline` is 0444. Move them off argv (tmux environment over the
    socket; `docker exec -e NAME` inheriting the value). Fix the comment that
    says argv is same-uid only.
    - **Fixed 2026-09-24 (not live) for tmux ≥ 3.2** via `update-environment`
      slots 8630–8632 (also stops a tab inheriting another tab's token); docker
      `-e NAME` + client env. tmux < 3.2 still carries tokens on argv.
    - [x] 🤖 Automated test — no spawned argv item contains a token value.

865. **`~/.gemini` is read-write in every fence** (`sandbox.rs`). An
    `mcpServers` command or hook planted there runs at the next unfenced
    Gemini/Antigravity start. Narrow to the credential files, config shadowed
    read-only, as for Claude/Codex. Check OpenCode's `~/.local/share/opencode`.
    - **Fixed 2026-09-24 (not live).** Gemini/Antigravity config staged per
      spawn, instructions/hooks/extensions read-only, IDE/agy executables
      unmounted. **Open:** OpenCode `snapshot/` (shadow git dirs) stays
      writable and `bin/` is only protected once it exists — needs a per-scope
      private store like `prepare_codex_state` (210 MB db: **your call**).
    - [x] 🤖 Automated test — fence argv mounts no Gemini config file writable.

866. **Format runs project-chosen programs ungated.** `rustfmt` is rustup's
    proxy in the project dir, so `rust-toolchain.toml` `path = "./tc"` runs the
    repo's own binary; a `.prettierrc` holding only a module name loads that
    module without `exec_trust`.
    - **Fixed 2026-09-24 (not live).** `RUSTUP_TOOLCHAIN` pinned to `rustup
      default` unless the toolchain file is a plain channel; a string-only
      `.prettierrc` asks.
    - [x] 🤖 Automated test — both cases ask (or are refused) before running.

867. **TeX hover preview relies on the distribution's shell-escape default.**
    Previews (on by default) run the file's preamble in the project; nothing
    passes `-no-shell-escape`. With `shell_escape = t` in `texmf.cnf`,
    `\write18` runs on hover. Pass `-no-shell-escape` (previews always; builds
    unless a trusted option says otherwise), set `openout_any=p`.
    - **Fixed 2026-09-24 (not live).** `-no-shell-escape` on every run incl.
      format dumps; previews run with `openout_any=p`.
    - [x] 🤖 Automated test — `engine_args` carries `-no-shell-escape`.

868. **OpenVPN runs config scripts as root.** No `--script-security 1`, so a
    `.ovpn`'s `up`/`down` run under `pkexec`; an imported bundle can name its
    own config; root writes `--writepid` into user-writable `<state>/openvpn/`.
    - **Fixed 2026-09-24 (not live).** `--script-security 1` after `--config`
      on every connect path, with a clear error when a config needs a script;
      `prepare_root_pidfile` refuses planted symlinks; imports drop every
      OpenVPN tunnel (`transfer.note.vpnDropped`). **Open:** `plugin` and
      `log`/`status`/`cd` directives still act as root; same-user symlink race
      during the polkit prompt. Configs relying on `update-resolv-conf` now
      fail — **your call** on an opt-in.
    - [x] 🤖 Automated test — argv always carries `--script-security 1`;
      imported entries drop `remote.openvpn`.

869. **Hardening batch (not vulnerabilities today).** ODT `unzipSync` and
    `extract_archive` get size/entry caps (zip bomb kills the main window);
    pdf.js `isEvalSupported:false` (the worker is outside the CSP); state dir
    0700 and `storage::write_json` 0600; pin GitHub actions by SHA; CSP
    `base-uri 'none'; form-action 'none'`, drop `script-src blob:` if unused;
    agent API keys only to agent tabs; CalDAV stops sending credentials to
    server-named cross-origin/plain-http hrefs; phone PWA prototype hardening;
    audit the fence's shared network namespace (X11/abstract sockets).
    - **Partly done 2026-09-24:** state dir tightened to 0700 at startup and
      new state files created 0600 (`storage::ensure_private_state_dir`,
      `write_json`; project-folder files keep the umask); every workflow
      action pinned by commit SHA (bump them by hand — no Dependabot).

870. **Any fenced agent could plant code the next local-model tab runs.**
    Threat model gap 7. `agent_fence::local_model_mounts` bound all of
    `<state>/vibe_local` read-write into every fence, whatever the CLI, and
    `register_vibe_hook_in` only appended to a local home's `hooks.toml`; vibe
    also loads MCP servers from `config.toml`, env from `.env`, and code from
    `tools/`/`plugins/`. A Claude tab in one project could so run a hook in
    the next local-model tab — unfenced, or in the root console's fence.
    - **Fixed 2026-09-24 (not live).** Only the spawn's own home is mounted,
      and only when its `VIBE_HOME` is a direct, real child of `vibe_local`
      (`local_model_home`); its control paths (`LOCAL_MODEL_CONTROL`) are
      read-only binds after it (Seatbelt: denied writes), created empty where
      missing, symlinks replaced; a local home's `hooks.toml` is rewritten to
      Tabtivity's hook alone. Residual: same-model tabs share logs, history and
      `trusted_folders.toml`. Vibe saving its own config in a fenced local tab
      now fails (Tabtivity owns that file).
    - [x] 🤖 Automated test — `only_the_spawns_own_local_model_home_is_mounted`,
      `a_symlinked_control_path_is_replaced_not_followed`,
      `a_local_model_home_keeps_only_tabtivitys_hook`; the layering was checked
      once under real bubblewrap (control files unwritable and unrenamable,
      logs/history writable, sibling homes invisible).
    - [ ] 🖐️ Manual test — a fenced local-model (Ollama) tab starts, answers,
      and resumes; from a fenced Claude tab `ls ~/.local/share/tabtivity/vibe_local`
      shows nothing.
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS

### Agent fence reevaluation follow-ups (2026-09-26)

Evidence and the focused fixes are in
`docs/context/agent_authority.md` → “Reevaluation, 2026-09-26”.

- [x] **High: confine host-side agent-home I/O with directory handles.**
  `contained_path` checks followed by path-based open/rename/chmod/unlink
  still race an active agent replacing a directory. Cover global apply,
  hook registration, credential keepers, home migration/preparation and
  cleanup; test concurrent directory replacement. The planted temporary/file
  symlink fixes do not resolve this race.
  - **Fixed 2026-09-26 (not live).** `services::home_io` (`HomeDir`,
    `HomeFile`): `openat(O_DIRECTORY | O_NOFOLLOW)` walk, then reads,
    exclusive-temporary writes, `renameat`, `unlinkat`, `fchmod` relative to
    the handle. `contained_path`/`write_replacing`/`read_plain` are gone;
    global apply, hook registration, both keepers, the scrub, `.cache` and
    the one-time seeding go through it. Tests swap the directory for a link
    between the open and the write.
- [x] **High: remove writable shared CLI payloads from the fence.**
  Host-installed CLIs still get `~/.local/share/<tool>` writable for updates;
  another scope or host shell then executes the modified payload. Plan the
  migration to Tabtivity-owned installs or host-side updates, preserving the
  one-click install flow. The private launcher copy alone is insufficient.
  - **Fixed 2026-09-26 (not live).** Every install is read-only in the
    fence; `updatable_install_dirs`, the Copilot `pkg/` payload and the
    private `~/.local/bin` copy + carry-back (#861) are removed; the
    updater switch is applied to every fenced spawn. Updates: reinstall
    through Manage CLIs (one click, unchanged) or outside Tabtivity.
- [x] **Conditional high: close terminal injection for shell-tab shims.**
  A CLI entered in a shell uses `agent_shim`, outside the direct fenced-tmux
  drain path. Evaluate denying injection ioctls at the Linux fence boundary
  and terminal isolation for macOS; verify with an isolated test PTY, never
  by injecting into the user's live terminal.
  - **Fixed 2026-09-26 (not live), drain only.** The shim runs the fenced
    CLI as a child, waits, and `tcflush`es the terminal's input before the
    shell reads again (the pane drain's twin). A seccomp deny of the
    injecting ioctls was **not** added; macOS keeps the pane drain's limit
    (a process the agent leaves behind). Not verified on a test PTY.
- [x] **Make shared-login integrity explicit or mediate writes.**
  In-place writes through shared credential hard links change every scope,
  including Host, without passing the account-adoption guard. If isolation
  is required, use per-home copies and validated host-side reconciliation;
  cover both in-place updates and rename rotations in tests.
  - **Fixed 2026-09-26 (not live).** Per-home copies; the store records
    what it last placed per home (`.placed/`); every changed copy passes
    the account guard; adopt-all-then-place-all per pass; keeper at 5 s;
    login dirs reconciled file by file (no bind); old hard links replaced
    by copies. Tests: in-place and rename, refused account both ways, Host
    home, migration, directories.

- [x] **High on X11 hosts: fenced agents reached the host's abstract sockets.**
  bubblewrap unshares only the pid namespace, so `@/tmp/.X11-unix/X0`, the
  systemd/D-Bus buses and IDE daemons stayed reachable; with `xhost +local:`
  or `+si:localuser:$USER` (or cookie-less `startx`) a fenced agent could log
  keystrokes and type into unfenced windows. Wayland sockets were already
  hidden by the private `/run`.
  - **Fixed 2026-09-28 (not live).** `services::fence_scope`: the launcher
    runs `tabtivity --fence-scope`, which enters Landlock's
    `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` and execs bwrap. Skipped below
    Landlock ABI 6 (Linux 6.12) and for a setuid bwrap; fails closed where
    used. Checked from a fenced tab: the XWayland socket answered before
    (refused only by its cookie) and gave `EPERM` inside the scope.
  - [x] 🤖 Automated test — `the_scope_refuses_outside_abstract_sockets_only`
    (skips below ABI 6), `the_helper_is_the_running_binary_even_once_replaced`,
    `a_setuid_bwrap_gets_no_helper`, the launcher's helper case.
  - [ ] 🖐️ Manual test — after a restart onto this build, open a new agent
    tab and run `python3 -c 'import socket; socket.socket(1).connect(b"\0/tmp/.X11-unix/X0")'`
    → `PermissionError`; the agent itself starts, signs in and answers, and
    a headless browser/Playwright run inside it still works.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

### Threat-model recheck follow-ups (2026-10-01)

- [x] **Close the Windows phone file-browser path race (BUILT 2026-10-01 · 🧪 not run live).**
  `services::mobile_control::files_windows` now holds the project directory
  open, opens each child with handle-relative `NtCreateFile` and
  `FILE_OPEN_REPARSE_POINT`, rejects every reparse type from handle metadata,
  and enumerates through the held handle. A renamed parent never redirects
  the subsequent file open or listing. Windows tests cover internal/external
  junction refusal, a concurrent parent swap after acquiring its handle, and
  directory enumeration across multiple native batches. The actual helper
  and tests cross-compile and pass Windows clippy from Linux; executing them
  on Windows remains pending, as does live verification.
  - [ ] 🖐️ On Windows, enable phone project files, browse a nested folder and
    read a text/PDF file; a junction under the project must stay hidden and
    unresolvable. Run the Windows Rust tests to exercise the scheduled swap.
    - [ ] ✅ Works on Linux (X11)
    - [ ] ❌ Doesn't work on Linux (X11)
    - [ ] ✅ Works on Linux (Wayland)
    - [ ] ❌ Doesn't work on Linux (Wayland)
    - [ ] ✅ Works on Windows
    - [ ] ❌ Doesn't work on Windows
    - [ ] ✅ Works on macOS
    - [ ] ❌ Doesn't work on macOS

### Threat-model recheck follow-ups (2026-10-04)

Found by the four-way re-read of the code since `e5ad85b5` (gaps 8–14 in
`docs/threat_model.md`). Code-read findings, none reproduced; #2342, #2344
and #2346 were spot-checked against the source.

2342. **Gemini Search grounding is not metered by the API spending limit.**
    `services/api_prices.rs` lists grounding fees as "not priced". A keyed
    Gemini tab — or injected code in its fence, which holds the proxy token —
    can send tiny `generateContent` calls with a `googleSearch` tool. Each
    query costs a grounding fee, but the ledger counts tokens only, so the
    monthly limit never trips. Charge `groundingMetadata.webSearchQueries`
    per query, or strip or refuse grounding tools in `services::api_proxy`.
    (Threat model gap 8.)
    - **Fixed 2026-10-04 (not live).** `api_meter` counts each candidate's
      `groundingMetadata.webSearchQueries` (plain, JSON-array and SSE answers;
      keyed hash per query, max over responses, so repeats are not doubled),
      metadata without queries (Maps) as one; `api_prices` charges $14/1,000
      queries (Gemini 3.x) or $35/1,000 grounded prompts (2.5), unknown models
      $35/1,000 per query, free allowances not deducted; kept in the ledger's
      `web_searches`. A cut-off or unreadable answer whose body may ground
      (`may_ground`: a Search/Maps tool key anywhere, or unparseable) counts
      at least 10 queries. Unit tests in `api_meter`/`api_prices`.
2343. **The API spending limit can be overshot by 64 requests in flight.**
    The budget check in `services::api_proxy` runs before a request and reads
    only finished answers. One hijacked tab can keep 64 large requests open
    (HTTP/1, 64 sockets) and spend a few hundred dollars past the limit. Add a
    per-grant concurrency cap, or reserve each request's estimated cost
    before it is forwarded. (Gap 9.)
    - **Fixed 2026-10-04 (not live).** After the body is read, the proxy
      reserves the request's worst case (`Meter::worst_case`: `max_tokens` or
      the provider's output cap × output rate, body bytes/3 as 1-hour cache
      writes, 10 grounding queries if a Gemini body may ground) through
      `api_usage::Book::reserve`; spent + held + it past the limit → 429
      (`WouldPass`, same shapes, no retry). The `Reservation` sits in
      `Metered` and drops after the actual charge, or on connect error,
      upstream failure or client hang-up — never leaks. Memory-only, in
      micro-dollars; ledger file unchanged. Overshoot is now only what an
      answer costs past its reservation (e.g. Anthropic web searches).
      Near the limit ordinary turns are refused. Tests: `api_usage`
      (reserve/release), `api_proxy` e2e (third concurrent request refused;
      released on success, client hang-up, upstream break, connect error).
2344. **An approved agent push can send commits the user did not see.**
    `git_push_mcp::approve` checks `refs/heads/<b> == head`, then waits on
    `ls_remote` (up to 120 s), then pushes the refspec built by `refspec()`
    (`refs/heads/<b>:refs/heads/<b>`). `.git` refs stay writable in the fence,
    so the agent can move the branch to another fast-forward in that window.
    Push `<approved sha>:refs/heads/<b>` instead. (Gap 10.)
    - **Fixed 2026-10-04 (not live).** `git_push_mcp::refspec(sha, branch)`
      builds `<sha>:refs/heads/<b>` (full hex only); the transport pushes the
      approved card's SHA, or the one Apply's plan validated. A branch moved
      before the click stays `stale_approval`; a move after the check no
      longer matters. A `pre-push` hook that adds commits runs once more on
      the new tip so its stdin line names the pushed SHA (adding commits again
      → `preflight_failed`). `git_release` pushes the tag object it checked
      to peel to the tip (`<object>:refs/tags/<t>`), not the tag by name.
      Tests: refspec shape, moved branch during approval and during Apply
      (bare remote never gets the new commit), hook re-run, re-pointed tag.
2345. **Markup Undo reverts the whole work tree, not only the round.**
    `services::markup_rounds` puts back every change between Submit and the
    last settle, so your own edits, another tab's agent and sibling projects in
    the same repo are reverted too. Files outside the project are only counted,
    not named, and nothing goes through `services::local_loss`. The phone can
    settle late. A phone scoped to project A can revert edits in project B.
    Limit Undo to the project prefix, and name and confirm anything else.
    (Gap 11.)
    - **Fixed 2026-10-04 (not live).** `markup_rounds::undo` conflict-checks
      and writes only paths under the project folder's prefix; changes
      elsewhere in the work tree are left alone and named top-relative in the
      preview and the result (`outside` ≤ 50 + `outsideMore`), shown in the
      confirm dialog on desktop and phone (`undoSummary`). The snapshots still
      cover the whole tree, which naming those needs. Emptied folders are
      removed only below the project folder. Still inherent: edits by you or
      another tab *inside* the project between Submit and settle go back with
      the round (the dialog names them first). Tests: sibling folder and top
      file survive Undo and are named, project files restored, outside
      conflicts ignored, cap + count, empty project folder kept.
      Review: the phone route sends the outside files as a count only
      (`Changes::outside_counted`; a phone may be scoped to the project and
      the names can be a sibling's); a file moved into the project from
      outside is kept, not removed (its original is not put back).
2346. **The phone's drop-box reads open the folder by path.**
    `mobile_control::outbox::drop_dir` proves the inbox/outbox folder with
    `canonicalize`, then `probe_as` opens `dir.join(leaf)` by path. Only the
    leaf is `O_NOFOLLOW`. A fenced agent swapping `.tabtivity` for a symlink
    chain can make the unfenced sidecar serve a host file to the paired phone.
    Open through held directory handles, as `files.rs` does. (Gap 12.)
    - **Fixed 2026-10-04 (not live).** `files::ProjectDir` gained
      `open_root`/`lookup_dir`/`create_dir` (`mkdirat`)/`create_file`
      (`O_CREAT|O_EXCL|O_NOFOLLOW`)/`remove_file` (`unlinkat`); `outbox::drop_dir`
      returns the held folder and every listing, read, probe, delete, sender
      and origin marker (`.<leaf>.tab`/`.src`) and the old-name send marker
      works relative to it; `inbox::store` (phone uploads, markup Submit's
      marked copy and page PNGs) makes and walks `.tabtivity/inbox` the same
      way; `markup::inbox_png` goes through `inbox::kind`. A `.tabtivity`,
      `inbox` or `outbox` link is now refused even when it points inside the
      project. Windows: same operations through `NtCreateFile` relative to the
      held handle (`files_windows.rs`); clippy-checked for
      `x86_64-pc-windows-msvc`, never run there. Tests: linked/file
      `.tabtivity`, linked `outbox`/`inbox` (out of and into the project)
      refused for list/read/delete/write; `.tabtivity` swapped for a link
      after the walk — listing, reads, delete and a create stay in the held
      folder.
2347. **`.git/info/exclude` is written through a symlink.** `git_guard` does not
    cover `.git/info/`. The launch rename sweep (`brand_migration::project`)
    and the project-open `update_exclude` append or rewrite it with
    `std::fs::write`, which follows a planted symlink, e.g. into `~/.profile`.
    The remote script's `>>` does the same on the host. The content is fixed,
    so the risk is corruption, not code execution. Refuse a non-regular
    `info/exclude` (`symlink_metadata` / `O_NOFOLLOW`). (Gap 13.)
    - **Fixed 2026-10-04 (not live).** `git_guard` gained
      `read_info_exclude`/`edit_info_exclude`/`open_info_file`, built on
      `home_io::HomeFile`: `info` opened `O_DIRECTORY|O_NOFOLLOW` relative to
      the git dir, the file `O_NOFOLLOW|O_NONBLOCK` and checked regular on the
      opened inode, a write landing as an exclusive temporary in the held
      `info` renamed over the name. A linked/non-folder `info` or a
      linked/non-regular/non-UTF-8 `exclude` is refused and left as it is.
      Used by `brand_migration::project` (`update_exclude`,
      `exclude_folder_ignored_under_old_name`, `needs_work`), the worktree
      `exclude_app_dir`, and `markup_rounds`' `info/attributes` check (a link
      or FIFO there now means no undo, and never blocks). Both remote scripts
      test `[ -L ]`/`[ -d ]`/`[ -f ]` on `info` and `exclude` first; the
      rename script's rewrite uses `mktemp` instead of `exclude.tmp$$`.
      `info/` is **not** made read-only in the fence: `git sparse-checkout`
      fails outright and every repack (auto-gc) errors on `info/refs`
      (verified, git 2.53). Windows: path-based `symlink_metadata` checks
      behind the same API, unverified. Tests: linked `exclude`, linked `info`,
      FIFO/folder `exclude` refused with targets unchanged; a plain one
      appended once (local and both remote scripts).
2348. **A revoked phone's held prompts and schedules still fire.** Revoke, a
    narrowed access list or Lock down does not cancel the prompts that phone
    held (`mobile_control/host.rs` hold routes) or the schedules it made
    (`scheduler.rs`). They are typed into agent tabs, headless ones too.
    Cancel or flag them on revoke and narrowing. (Gap 14.)
    - **Fixed 2026-10-04 (not live).** Every rule a phone makes records it:
      `ScheduledAgentPrompt::phone_device` (the paired device id; optional,
      kept across edits, absent = unknown origin and left alone). Stamped
      headless in `headless::{schedule_mutate,prompt_mutate,hold_prompt}` and
      in the window from a new `device_id` on `ScheduleMutate`,
      `PromptMutate`, `HoldPrompt`, `MarkupAnswer` (`MobileBridgeHost` →
      `queuePromptForTab`/`sendCollectedPrompt`). `mobile_control::phone_origin`
      cancels a rule whose phone is unpaired or whose scope no longer reaches
      it (`discovery::ScopeAccess`, extracted from the catalog's own rule):
      after admin revoke/forget-all (sidecar), in the window's `mobile_admin`
      and `set_{project,box}_mobile_access`, at sidecar scheduler start, and
      in `agent_tasks` claim (fire-time backstop for both owners:
      `ClaimOutcome::Cancelled` removes the rule instead of typing it; an
      unreadable access holds it back). Cancelled rules leave the lists; one
      log line per pass. No UI added (revoke has no toast). Tests:
      `phone_origin` (revoke, Lock down, narrowing, claim backstop, old rules
      still fire, unreadable access), `admin` forget-all, `headless` stamping,
      `protocol` field, `MobileSchedulePreface.test.tsx`.

2349. **A FIFO in a repo hangs Tabtivity's git calls.** A named pipe at
    `.git/info/exclude` or an in-tree `.gitignore` makes `git status` block
    forever (git 2.53; `timeout 3` exits 124). Found by the #2347 reviewer.
    `commands::git::run_git` has no timeout, so a fenced agent can plant one
    and hang the file-tree / dirty-poll / usage-recap git calls (and any
    window command waiting on them). Put a bounded timeout (kill the whole
    child) on background and window-path git calls, and/or refuse a non-regular
    `info/exclude`, `.gitignore`, `.gitattributes` before running git.
    (Threat model gap 15.)
    - **Fixed 2026-10-04 (not live).** Reproduced (git 2.53): a FIFO
      `info/exclude`, `info/attributes`, top-level or nested `.gitignore` /
      `.gitattributes`, `config`, `HEAD`, `index` or `packed-refs` hangs
      `status`; `.gitattributes` also hangs `diff`; `rev-parse` hangs only on
      `config`/`HEAD`. New `services::git_bounded`: a pre-check `stat`s the
      fixed-name files (top-level `.gitignore`/`.gitattributes`, the git and
      common dir's `info/exclude`, `info/attributes`, `config`, `HEAD`,
      `index`, `packed-refs`, `commondir`) and refuses a FIFO/socket/device
      (logged once per file; a link to `/dev/null` is fine); every run is
      spawned in its own process group and stopped at a ceiling (the subtree
      killed, the child reaped) with a clear error, never an empty "clean"
      output: 2 min for reads and ref verbs, 10 min for index verbs
      (`add`, `commit`, …) and unlisted ones, 1 h for transport/maintenance,
      work-tree writes (`checkout`, `reset`, `merge`, `worktree`, …: an LFS
      smudge may download) and hooks-live calls.
      Wired into `run_git`/`run_git_hooked` (local half), the config
      sanitizer, the push/release lanes' local reads, `git_peer`, the usage
      recap, the file-size breakdown, the phone's git overview and file
      browser (stdin + output cap), `prompt_blame`, `brand_migration`,
      `exec_trust`, worktree repair, the scaffold commit, `git_pull`'s
      viewer merge; `markup_rounds` (already bounded) now reaps the subtree.
      `.git` pointer and `commondir` are read non-blocking, regular files only.
      Fail closed where "no answer" meant "safe": `exec_trust` turns an
      unreadable repo into a subject (asks), `repo_rewrites_urls` counts it
      as a rewrite. Polls stay independent (tokio blocking pool; the dirty
      poll dedups in flight). Left: user-initiated push/fetch/clone keep their
      own handling; a killed write verb can leave `index.lock`.
      Tests: `git_bounded` (6), `commands::git::a_fifo_ignore_file_makes_the_status_polls_fail_fast_not_hang`,
      `exec_trust::an_unreadable_repo_is_a_subject_not_nothing`, the push
      lane's rewrite test.
    - **Review 2026-10-05 (not live).** The switcher's dirty dot now drops an
      errored probe (no entry) instead of writing "clean", and re-runs the old
      two-command spelling only for a backend missing `git_dirty_probe`
      (`stores/gitDirty.ts`, test in `GitDirtyState.test.ts`). Bounded too:
      the provider sniff (`detect_git_providers`) and `git_init`'s Publish
      branch checks. Work-tree writes moved to the 1 h ceiling.

### Safe for everyone — non-expert users (2026-09-24)

Plan: `docs/safe_for_everyone_plan.md`. Goal: every "⚠️ yours" row in
`docs/threat_model.md` becomes a safe default, something Tabtivity handles, or a
warning the user can't miss, so that a typical engineer or a teacher can use
Tabtivity. None of these is started.

2321. **Can a fenced agent type into host windows?** The fence shares the host
    network namespace; `DISPLAY` is not scrubbed and the abstract X11 socket is
    reachable. With `SI:localuser:$USER` (GNOME's default) a same-uid client
    may connect without a cookie and use XTEST. Audit it under real bubblewrap
    on an X11 session. If it works: scrub `DISPLAY`/`XAUTHORITY` and block the
    abstract socket (`--unshare-net` + loopback proxy to the agent's API hosts,
    reusing the VM proxy allowlist). Splits the "shared network namespace"
    line out of #869. **Your call:** `--unshare-net` in Standard only, or
    everywhere. Scrubbing `DISPLAY` alone doesn't fix it: the agent can
    connect to the abstract socket directly. On a Wayland session the exposure
    is limited to Xwayland clients (the Wayland socket under `/run/user` is
    hidden), so audit on a real X11 session.

2322. **tmux < 3.2 still leaks tokens to other users.** Refuse token-carrying
    tabs on an old tmux (or spawn them without tmux) instead of putting the
    token on world-readable argv. Residual of #864.

2323. **One webview script reaches all 630 commands.** Declare app commands
    in `build.rs` (`tauri_build::Attributes::app_manifest`) and grant them per
    window in named sets (`terminal`, `git-write`, `mail-send`, `fs-write`,
    `update-install`, …): `main` keeps what it uses, `detached-*` only its tab
    kind's sets, `present-*` read-only viewer commands, `browser-*` nothing.
    Pin each window's grants in a test beside `tests/capability_scope.rs`.

2324. **Safety profiles and a Safety panel.** `settings.safety_profile`:
    `standard` (new installs) | `developer` (existing installs, today's
    defaults) | `expert`. Standard: fence required, root console can't read
    projects, schedule MCP off, auto-sync off, VPN import off, phone pairing
    hidden, trust prompts per #2325. A profile sets defaults and visibility
    only; it never overrides an explicit user choice. Safety panel: every
    "⚠️ yours" row as on/off with a one-line risk and a link to its setting.
    **Your call:** offer Standard once to existing installs, or not.

2325. **Trust prompts a non-expert can answer.** `exec_trust` dialogs default
    to "Don't run", say in words what would run, and in Standard run the
    approved program in the project container when one exists. Remembered
    answers are listed in the Safety panel and can be revoked.

2326. **Red badge for unfenced + bypass mode.** When an unfenced tab's CLI has
    a bypass/auto-approve mode (recorded by the session hook), badge the tab.
    Display only — Tabtivity still never picks or changes the mode.

2327. **Agents on Windows run with the user's full rights.** No fence exists
    there (`platform_fenceable()`).
    - ✅ (b) The first local agent spawn is refused until the user accepts
      once — `FenceDecision::PlatformUnaccepted`, `UnfencedPlatformDialog`,
      `agent_fence_platform_accepted`; Settings → Agent fence can withdraw it.
      🖐️ Not run live (no Windows box here): open an agent tab on Windows;
      the prompt shows once, Cancel starts nothing, Accept starts the tab and
      the next tab starts without asking. Linux/macOS never show it.
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
    - ❌ AppContainer, rejected: cuts loopback (every Tabtivity MCP endpoint,
      Ollama, agent OAuth callbacks are `127.0.0.1`; exemption is admin-only),
      blocks Credential Manager and `%TEMP%`. Low-IL/restricted tokens don't
      hide reads. Rationale in `docs/context/agent_authority.md`.
    - (a) Project container (Docker Desktop) stays the opt-in stronger boundary;
      needs `C:\` ↔ container path mapping (the same-absolute-path invariant
      can't hold on Windows) and Docker Desktop's licensing.
    - (c) **Candidate real fence: the Linux fence unchanged inside WSL2.**
      Agent tabs run `wsl.exe -d <distro>` with Tabtivity-owned Linux agent
      installs; `services::agent_fence` wraps them as on Linux. Costs: hide
      `/mnt/*` except the project (else `C:\Users\<you>` is readable), kill
      interop, `C:\`↔`/mnt/c/` path mapping wherever paths cross (tabtivity-send,
      git MCP, mobile control), drvfs speed, no Windows toolchain for the
      agent, one-time `wsl --install` (UAC + reboot). **Go/no-go checks, run
      in the default WSL distro before any code:**
      1. `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-user --tmpfs /tmp true; echo $?`
         — must print `0` (unprivileged userns + bwrap work in WSL2).
      2. `bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /run --tmpfs /tmp --unshare-user --unsetenv WSL_INTEROP --unsetenv WSL_DISTRO_NAME bash -c 'cmd.exe /c echo LEAK; powershell.exe -c echo LEAK'`
         — must print no `LEAK` (interop dead inside the fence; if it prints,
         the design is void until interop can be disabled per process, e.g.
         `/proc/sys/fs/binfmt_misc/WSLInterop` is ro-bound to an empty file).
      3. `bwrap --ro-bind / / --tmpfs /mnt/c/Users/$WINUSER --bind /mnt/c/Users/$WINUSER/<project> /mnt/c/Users/$WINUSER/<project> --unshare-user ls /mnt/c/Users/$WINUSER`
         — must list only `<project>`, and a write into it must land on `C:\`.
      4. From WSL: `curl -s http://127.0.0.1:<tabtivity-mcp-port>/mcp/help` —
         reaches Tabtivity only under mirrored networking (`.wslconfig`
         `networkingMode=mirrored`, Win11 22H2+); NAT needs Tabtivity to also
         bind the WSL vEthernet address (token-protected as today).

2328. **Warn about a planted `.git/commondir`.** Tabtivity's own git ignores it
    (#862), but the user's own terminal git follows it. Detect a `commondir`
    inside a main `.git` and offer to remove it.

2329. **Updates: check in the background, sign offline.** The update check runs
    only when the Updates panel opens (`UpdatesPanel.tsx`). Check once a day
    (not when headless connections are off), badge quietly, badge clearly for
    a release marked security. Never install on its own. Move the release
    signing key off GitHub (hardware key or offline step), so a CI compromise
    can't sign. **Your call:** where the key lives, who can sign.

2330. **Warn about an outdated WebKitGTK / GStreamer.** Linux only (WebView2
    updates itself, macOS WebKit comes with the OS). On startup compare
    against a version floor kept in the binary; the warning names the
    package-manager command.

2331. **Hostile-input test suite.** `tests/hostile/`: repos with planted git
    config, hooks, `commondir`, `gitdir:` files, `latexmkrc`,
    `rust-toolchain.toml`, `.prettierrc`; hostile mails, PDFs, ODTs, zip
    bombs, SVGs, notebooks. Each case asserts that opening or viewing it runs
    nothing and writes nothing outside scratch. CI on Linux, Windows, macOS.

2332. **Fuzz the parsers.** `cargo fuzz` targets for mail parsing, iCalendar,
    WebDAV XML, the git-config sanitizer and SFTP name confinement.

2333. **Disclosure policy and an outside audit.** Add `SECURITY.md` (how to
    report, scope, link to the threat model); reproducible release builds; an
    external audit or pentest before telling non-experts Tabtivity is safe.

2336. **`~/.claude/jobs/` and other new entries are writable in every fence.**
    `CLAUDE_UNMOUNTED` (`sandbox.rs`) lists what to hide, so an entry a newer
    Claude Code adds is mounted read-write from the host by default. Seen
    inside a fenced tab (2026-09-25): `jobs/`, `state/`, `cache/`,
    `downloads/`, `plans/`, `statusline-mode/`, `.last-update-result.json`,
    `.last-cleanup` are all host mounts, read-write. `jobs/<id>/state.json`
    carries `respawnFlags`, `cwd`, `providerEnv` and `resumeSessionId`: if a
    host-side Claude (daemon or the user's own terminal) respawns jobs from it,
    a fenced agent can plant one that runs unfenced with its own flags, cwd and
    `ANTHROPIC_BASE_URL`. Not verified; audit what reads `jobs/`. Also readable:
    every session's `jobs/` output and `plans/` across projects. Fix: invert
    to an allowlist (mount only what resume/login need; everything else lands
    in the fence's tmpfs), and do the same for `CODEX_UNMOUNTED`, which has
    the same shape. Stopgap until group S #2335 Phase 1 replaces the host home
    with a per-scope one; drop it if that ships first.
