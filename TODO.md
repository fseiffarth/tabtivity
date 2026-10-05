# Tabtivity Plan — Grouped & Numbered Open Ideas

## Context

This is the index into the plan of open implementation work. Each group lives
in its own file under [`todo/`](todo/); this file only tracks group letters,
one-line descriptions, and status, plus the context that applies across all of
them (status legend, competitive evaluation, sequencing, verification
approach). The raw idea dump lives in `open_ideas.md` (51 loose ideas spanning
the right file-tree panel, the bottom project switcher, X11/KDE workspace
switching, project import/publishing, git tooling, drag-and-drop reordering,
remote/SSH projects, branding, session restore, in-app file/text/tex viewers,
tab renaming/mapping, per-project security & remote-control toggles, a native
browser, keyboard-driven navigation, and right-panel polish); cross-platform
Windows/macOS follow-ups (#30–#31), backend runtime follow-ups (#32), and the
global-app URI-routing item (#33) were consolidated here from the former
separate plan file and the old `TODO.md`. The goal of this plan is **not** to
implement everything at once, but to organize the ideas into coherent groups
with stable numbers so you can say "do #14" and I can act on a well-scoped
unit.

Exploration confirmed several ideas are partially built already — those notes
are called out per item so we don't rebuild existing infrastructure.

Numbering is **append-only and stable** — existing references never shift — but
it is **not globally unique**: ten numbers were reused across group files
(#55 in L+M, #65 in J+R, #66 in J+M+R, #80 in G+M, #82/#83/#84/#85 in G+L,
#86 in G+O, #87 in M+O). Always qualify a reused number with its group letter
(`L#55`, not `#55`) — a bare number is ambiguous for those ten. Code comments
predating this note use bare numbers. Open groups are lettered A, B, C…
(roughly in suggested sequence); completed groups are collected in
[`todo/done.md`](todo/done.md), renumbered D.1, D.2… where that's already
happened (a couple of done groups — N, U — are still under their original
letter, not yet renumbered; see that file). You can pick any item in any
order.

## Status legend — Done ≠ Tested

Three independent axes are tracked per item:

- **✅ Done** — code-complete: written, type-checks (`npx tsc --noEmit`) and/or
  compiles (`cargo test`/`cargo build`). Says nothing about whether it actually
  works.
- **🤖 Automated** — an automated test (vitest under `src/__tests__/` or a Rust
  `cargo test`) exercises the behavior and passes on the current code.
- **🖐️ Manual** — runtime QA in a live Tabtivity confirms the behavior by hand.

Each done feature carries two checkboxes — one per verification axis — with an
example test in words to guide both. A feature is fully **🧪 Tested** only when
**both** boxes are ticked.

> ✅ **Automated coverage complete; 🖐️ manual QA still pending** for every done
> group (see [`todo/done.md`](todo/done.md) for the current exception list —
> a couple of items are visual-only or partial-coverage). No 🖐️ Manual box is
> ticked yet — nothing has been runtime-QA'd in a live Tabtivity, so treat each
> feature as fully 🧪 Tested only once its manual box also flips.

---

## Evaluation — Idea & Current State vs. Competitors

*Strategic assessment of Tabtivity's concept and current feature set against the
competitive landscape (as of 2026-06). Not a numbered work item — context for
prioritization. Competitor specifics are current to ~early 2026; that field
moves monthly.*

### The core bet

Tabtivity's thesis: **"you don't open apps, you open projects"** — switching a
project swaps the *entire desktop context* (windows, downloads folder,
default-app mappings, time tracking) as one unit, with built-in agent terminals
riding on top. The bet targets a real, under-served pain (window/context sprawl
across many concurrent projects) and sits in a gap no single competitor fills.
The README's positioning is honest and basically correct — but the bet has
structural vulnerabilities that matter more than the feature checklist suggests.

### Competitive map

- **Agent orchestrators — the gold rush Tabtivity opts out of.** Vibe Kanban,
  Conductor, Claude Squad, Crystal, the Claude Code desktop/web app, Cursor
  background agents, plus cloud players (Devin, OpenAI Codex cloud, Google
  Jules, Sculptor). These parallelize agents across git worktrees with task
  queues, diff review, and merge flow. Tabtivity's "agent cockpit" is just
  `claude`/`codex`/`gemini` in PTY tabs — i.e. *running the CLI*, nothing more.
  This is where funding and momentum are, and Tabtivity explicitly doesn't play.
  **Verdict: complementary, not competitive — and the right call.** You can run
  Vibe Kanban *inside* a Tabtivity project terminal. Building a weak orchestrator
  here would be a mistake.
- **AI IDEs/editors — Cursor, Windsurf, Zed, VS Code+Copilot, JetBrains.** Where
  developers actually live. Tabtivity's center surface is a *terminal*, and it
  pushes the editor out to an external `xdg-open`'d window. **Biggest conceptual
  gap:** Tabtivity is a shell *around* the dev experience, not the dev experience.
- **Terminal/session restorers — tmux+tmuxinator/tmuxp, Zellij, Warp, WezTerm.**
  tmux restores terminal layouts; Warp adds AI to the terminal. **Tabtivity wins on
  scope (whole desktop, not just the terminal), but these are far more mature
  and cross-platform.**
- **Desktop context tools — KDE Activities, GNOME workspaces, i3/sway
  scratchpads, Arc Spaces, Workona.** Each solves one slice (Activities move
  windows but have no project model/restore; Workona/Arc are browser-tabs only).
  **Tabtivity's "context as one unit" (windows + downloads + default apps + time)
  is more complete than any of these** — the downloads-rerouting and per-project
  default-app remapping are genuinely novel touches nobody bundles.
- **Dev-env managers — devcontainers, Gitpod/Coder, DevPod, Nix/direnv, mise.**
  Reproducible per-project *environments*, no desktop/window layer. Orthogonal
  (and the #38 Docker work moves Tabtivity partway into this space).

### Honest strengths

- The gap is real and defensible: (desktop context switching) × (built-in agent
  terminals) on Linux is genuinely under-served.
- Thoughtful, concrete differentiators: per-project downloads routing,
  default-app remapping, time tracking, sticky cross-project app toolbar.
- Local/privacy posture: Ollama-backed local tabs + sshfs remote projects +
  all-local state, a real counter-position to the cloud-agent wave.
- Strategic honesty: positioning as complementary to orchestrators avoids a
  losing fight.

### Honest weaknesses / risks

- **Linux-X11/KDE-only is the dominant constraint.** The entire value prop hinges
  on window management that works on only a couple of compositors; Windows/macOS
  ship the differentiator missing. This caps the audience to roughly "the author
  and people like him." Cross-compositor support (Hyprland, Sway, GNOME) is
  make-or-break for adoption beyond personal use.
- **The editor gap (above):** without a first-class editor story, Tabtivity risks
  being a layer people immediately tab away from.
- **Maturity vs. a fast-moving field:** ~75h logged, v0.1.0, single developer,
  and the entire "AI roadmap" (semantic search, startup suggestions, terminal
  hints) is unbuilt while funded orchestrator teams ship weekly.
- **Single-user, local-only** while the market trend is cloud/async/team agents.
- **Existential risk:** if an orchestrator or IDE grows a "workspaces" feature
  that manages windows/context (e.g. Cursor or the Claude Code desktop app adding
  project-scoped desktop state), Tabtivity's gap closes from above. Its moat is
  desktop-integration depth — which is also its portability ceiling.

### Strategic take

Tabtivity is best understood **not as an agent tool but as a project-context OS
layer**, and should lean all the way into that: *Tabtivity is the desktop shell;
inside each project you run whatever the best orchestrator/IDE is.* That framing
turns its biggest "weakness" (not being an orchestrator) into the product.

Two priorities worth weighing **above** the AI-roadmap items:

1. **Portability** — at least Hyprland/Sway/GNOME (ties into Group C #18/#19 and
   Group H #30/#31). Without it the idea can't escape its author.
2. **A real editor/IDE integration story** — even just first-class "this
   project's editor window" treatment rather than embedding.

The idea is good and the gap is real. The execution risk is that it's a deep,
narrow, single-developer Linux tool competing for attention in a field racing
toward broad, cloud, team-scale agent automation — and the defensibility
(desktop depth) is in direct tension with the growth lever (portability).

---

## Open groups

| Group | File | Description |
| --- | --- | --- |
| A | [`todo/group-a-boxes.md`](todo/group-a-boxes.md) | Bottom Panel: Meta-Project Grouping — "project boxes" to group related pills into one (#13 core UI, #41 multi-project merge). |
| B | [`todo/group-b-detached.md`](todo/group-b-detached.md) | **Detached Windows: Parity & Cross-Window Correctness (#224–#240) — implemented 2026-09-01, untested live.** Created the same day from a two-agent code audit of L#42's popouts, and fixed in one pass. A popout is a second React root with its own store heap, and every place that forgot this was a silent no-op or a silent overwrite. Three seams carry the fix: `stores/detachedContext` lets the STORE ACTIONS forward a popout pane's write to the main window (#231, and with it #239's per-tab persistence), so a pane behaves the same in either window; the host subscribes to the tabs/projects/remote-status stores and reseeds what a change touches (#238); and `WindowEvent::Destroyed` reports every popout death so a surviving record is docked back rather than stranded (#224). Also: two query keys so a `box:<id>` scope can seed at all (#224), orphaned popouts destroyed at startup (#225), a `SETTINGS_CHANGED` broadcast plus a re-read before any popout write (#226), Close-all reaping popout PTYs (#228), root/box scopes persisting like any other (#229), one shared `reseedDetached` (#230), the project entry seeded into the popout's own projects store (#232), the HPC guard and the screenshot overlay mounted in `DetachedApp` (#233), activity/usage streamed to the classifier and its verdict mirrored back (#234), a bounded `pty_scrollback` so an attaching terminal is not blank (#235), respawn geometry validated against live monitors (#236), and **the dock-back gesture back**: a ⤓ in the popout's title bar and a dock-or-close question on the WM ✕ (#237). #240's two-heap harness is built and holds 20 cases. Every 🖐️ box is still open. |
| C | [`todo/group-c-workspace.md`](todo/group-c-workspace.md) | Workspace Switching / Platform Stability — X11/KDE hidden-workspace hardening, window z-order, i3-style tiling mode, cross-OS verification. |
| E | [`todo/group-e-worktree.md`](todo/group-e-worktree.md) | Git Worktree (#23) — phases 0–2 of [`docs/worktree_improvement_plan.md`](docs/worktree_improvement_plan.md) done (blocking defects, data loss, locality/containment), untested; worktree-aware tab groups and "open worktree as project" (phases 3–4) deferred. |
| F | [`todo/group-f-session.md`](todo/group-f-session.md) | Session Restore — wire up unused `active_session.json` startup restore on top of existing terminal/tab persistence. |
| G | [`todo/group-g-remote.md`](todo/group-g-remote.md) | Remote / SSH & Containerized Projects — largest net-new backend surface: work-remote axis, SSH/SFTP-native projects, Docker sandboxing, VPN. |
| H | [`todo/group-h-crossplatform.md`](todo/group-h-crossplatform.md) | Cross-Platform: Windows & macOS Support — follow-ups on the already-landed platform foundations. |
| I | [`todo/group-i-runtime.md`](todo/group-i-runtime.md) | Backend Runtime Follow-Ups — hardening on top of the first `services/` runtime boundary pass. |
| J | [`todo/group-j-mail.md`](todo/group-j-mail.md) | Web & Mail Surfaces — URI routing to external apps (#33), plus in-app mail (#65) and browser (#61) counterparts, mail at-rest/OpenPGP encryption (#66), the IMAP session pool (#167), OAuth 2.0 / `XOAUTH2` (#168), and the mail task a local model would run (#202 — the 🧠 menu's **Mail** role tag ships, its consumer does not; **built out in Group Q**). **Mail security audit (#847–#858, 2026-09-17) — fixed the same day, untested live:** partial-signature spoofing, save-to-project symlink write (fence escape), decrypted attachments persisted, untimed IMAP stream drains, plus lower-severity credential/link/store findings. |
| Q | [`todo/group-q-mail-ai.md`](todo/group-q-mail-ai.md) | **Local-Model Mail Assistant (on-device, #203–#208) — implemented 2026-07-30, untested live** (toggles are per account behind `mail_ai_allow`). The consumer of J#202's Mail role tag: summarize a message, auto-file it Important/Urgent (distinct from keyword filters), formalize a reply from notes, and extract a calendar event or to-do card (review-before-create by default; full automation opt-in, off). The AI path is **loopback-only — stricter than `ollama_allow_remote_host`**; nothing about a message leaves the machine. |
| L | [`todo/group-l-tabs.md`](todo/group-l-tabs.md) | Center Panel: Tabs, Subwindows & Navigation — detach-to-window, tab UX fixes, keyboard nav, on top of the done tiling split model. **Installs in the root console** (#215, 2026-09-17, untested live): every one-click install opens its root tab in the root console — the separate install overlay was merged into it; closing the console leaves the install running. |
| M | [`todo/group-m-viewers.md`](todo/group-m-viewers.md) | In-App Viewers — text/TeX/image enhancements (Phase 2+) on top of the done file→tab viewer infrastructure. |
| N | [`todo/group-n-i18n.md`](todo/group-n-i18n.md) | Internationalization (i18n) — full app-wide translation coverage. **DONE** (6233 keys, 5-language parity, 2026-09-14). |
| O | [`todo/group-o-security.md`](todo/group-o-security.md) | Project Security & Permissions — per-project policy for downloads, agent spawn, and git-push guardrails, plus the **sandbox-audit follow-ups** (#142–#151: move `.tabtivity/sessions/` out of the project tree, confirm a repo-supplied Dockerfile, per-window capabilities, narrow `~/.claude/projects`, drop the env-var host-bound marker, stop the mounted `.git/config` from executing on the host). Phased plan: [`docs/sandbox_hardening_plan.md`](docs/sandbox_hardening_plan.md). |
| R | [`todo/group-r-panel.md`](todo/group-r-panel.md) | Right Panel: Polish & App-Window Tracking — follow-on polish + a tracking-display bug on the done pin toggle. |
| S | [`todo/group-s-agents.md`](todo/group-s-agents.md) | Local Agents via Ollama — generalize the local `vibe` model tab into a family of local Ollama-backed agent tabs. Also the two things the local-model stack must stop *assuming*: the GPU (#200, done) and the runtime itself (**#201** — Ollama is wired in across 33 commands and a hardcoded `127.0.0.1:11434`; the survey says keep it as the default, since `ollama launch` has no equivalent, but put a seam behind it — starting with `ollama_host`, a setting that is read by nothing). |
| T | [`todo/group-t-shell.md`](todo/group-t-shell.md) | Smart / Native Shell Terminal — research done, not yet built; shell-completion via a new Ollama command. |
| U | [`todo/group-u-performance.md`](todo/group-u-performance.md) | **Interface Cost & Responsiveness (#210, #214)** — what Tabtivity spends to show what it shows. **Fast mode** ships (done 2026-08-26, untested live): one global toggle that withdraws the display aids whose cost is a directory walk, a standing poll or a read of every file in view — folder sizes, the pills' git dots, both hover cards, the header CPU/RAM row, the Python ▶ scan, the tree's remote re-stat, and every animation. Composes with Energy Saver rather than replacing it: that one widens timers off a battery reading, this removes features off a standing preference. Open: the backend sync/lockstep loops are untouched, and nothing is measured yet. **The side panel repopulates from a snapshot** (#214, done 2026-08-30, untested live): a closed panel unmounts its tree, so every reveal used to rebuild from nothing — listing, git statuses, one recursive walk per folder. `lib/projects/fileViewSnapshots` keeps the last state of each (project, root, folder) in module scope, the reveal seeds its first committed frame from it, and the upgrade goes out a frame later. Also the group's **appearance** strand (#217–#220, all untested live): derived accent tokens, the accent/corner overrides, an accent-colored seam under the top bar with a shared `--bg-subheader` for the subwindow tab bars and the file panel's header rows, and the **Theme Customizer** — every color variable editable in a window of its own, with the accent picker and the corner style folded in. |
| P | [`todo/group-p-hosting.md`](todo/group-p-hosting.md) | Git Hosting: Multi-Host Publishing — generalize the GitHub-only publish flow to GitLab + generic remote URLs. |
| V | [`todo/group-v-presenter.md`](todo/group-v-presenter.md) | Native Presenter ("Deck") — post-Phase-7 hardening. **V.1 + V.2 (#93–#122) ✅ done:** both data-loss defects, the first-real-use failures, the anchoring rework (SyncTeX line anchors now exist at runtime), and real font embedding. V.3 (#123–#141 — performance and the differentiated bet) mostly open, but **not untouched**: #131 (deck i18n) is complete, #126 is 4/6 done, #124 partly paid. Follows Group M #90. |
| W | [`todo/group-w-skills.md`](todo/group-w-skills.md) | Agent Skills (MVP) — browse/preview/one-click-install `SKILL.md` bundles into a project's `.claude/skills/`, Claude-only. Plan: [`docs/skills_plan.md`](docs/skills_plan.md). |
| Y | [`todo/group-y-verification.md`](todo/group-y-verification.md) | **Verification, Release Gates & Code Health (#161–#166)** — gaps in the machinery that checks the work: the 2476-test frontend suite never runs in CI, `privacy-check.sh` is mandated but wired to nothing on a public repo, no lint/clippy gate, the first live-QA session, promoted security items, and the three god-files. Created 2026-07-28 from a full-repo evaluation; **#161–#164 outrank feature work**. #161/#162 done and #163 mostly done 2026-07-28 (CI now runs vitest, the privacy scan, ESLint and clippy); #164 needs a human at the keyboard, #166 is unblocked. |
| X | [`todo/group-x-caldav.md`](todo/group-x-caldav.md) | CalDAV Accounts — calendars synced from a server the user has an account on (typed URL + login, scheduled read-only sync, identity-based merge that preserves board placement). Phases 0–3 done/untested — including two-way push (opt-in per account, default off), the conflict dialog, the redirect-credential fix and the pre-import `.ics` review. Rationale: [`docs/context/caldav.md`](docs/context/caldav.md). |
| Z | [`todo/group-z-server.md`](todo/group-z-server.md) | **Tabtivity Server — plan only, nothing built.** One Linux server running every user's projects, terminals and agents, with desktop browsers and the phone as thin clients: a daemon per user under their own uid, a gateway grown from the Mobile host, and the React app over a `__TAURI_INTERNALS__` WebSocket shim. Each user signs in to their own agent CLIs. Shared projects are a bare hub repo with a clone per member. Mail, calendar and todo are per user: mail is private, and calendars and todo lists can be shared. P1 first moves live state out of the window into the Mobile sidecar, planned separately as desktop work in [`docs/headless_owner_plan.md`](docs/headless_owner_plan.md). Only the old design's prerequisites #169–#172 remain listed; every §12 question is answered (2026-09-29). Design: [`docs/tabtivity_hosted_plan.md`](docs/tabtivity_hosted_plan.md). |

Completed groups (code-complete, automated tests green, manual QA pending
across the board) live in [`todo/done.md`](todo/done.md).

## Suggested sequencing

Group-wise — tackle whole groups in this order, since items within a group
share files and context:

- **Before anything else: Y (#161–#163)** — three near-zero-effort fixes
  (~5 lines total) that close the largest unguarded risks: the frontend suite
  isn't in CI, and the public repo's secret scan isn't in the pre-push hook.
  Then **Y#164**, the first live-QA session, which unblocks all 145 manual
  boxes.

- **Quick wins next:** ~~J #33 URI routing~~ — **shipped** (`src/lib/linkTarget.ts:124`
  `routeUri`, `:341` `openRoutedUri`, tests `src/__tests__/browser/LinkTarget.test.ts`).
  The in-app mail J#65 / browser #61 in the same group are the larger net-new
  surfaces, weigh security first and pair with #60. Real quick wins now:
  R #64 (the liveness helper `commands/apps.rs:1669 check_pid_alive` already
  exists and is simply never called from `src/`) and S #78.
- **Then correctness/stability:** C (X11/KDE workspace switching) — the
  highest-risk area; do #15/#16/#17 together.
- **Then larger features:**
  A (project boxes, builds on the done drag-drop) → E (git worktree) →
  F (session restore) → G (remote/SSH projects, largest net-new backend).
- **Center panel:** L (#42 detach, #55–#57 tab UX, #62 keyboard nav) — builds on
  the done D.11 tiling work; start with the #55 mapping bug (correctness), pairs
  with C since detached windows reuse the per-project parking path.
- **In-app viewers (incremental):** M (#43–#54) — small, mostly-independent
  enhancements on the done D.14 viewer; the link pair #49/#50 and the autosave
  pair #43/#47 are best done together.
- **Native presenter hardening:** V (#93–#141) — follows Group M #90, which is
  code-complete but has never been run live. **#93/#94 jump the queue**: both
  lose authored work with no prompt, and the 148 deck tests cover only the pure
  modules, not the effects where they live. Then #95–#100 (the first-real-use
  failures, all small) before any live QA of #90.
- **Project policy:** O (#58–#60) — per-project security/permission model;
  touches the create/import dialog and the agent-spawn + git-push paths.
- **Right-panel polish:** R (#63 needle contrast, #64 app-window tracking bug).
- **Local agents:** S — **mostly shipped, never recorded.** #72 (registry,
  `commands/ollama.rs:2211 LOCAL_DRIVERS`), #73 (`prepare_local_launch` /
  `list_local_drivers`, `lib.rs:1103`) and #75 (picker in `TabBar.tsx:223` /
  `NewTabMenu.tsx:190`) are done. Remaining: **#78** (nothing surfaces this in
  the Ollama panel — the feature is invisible), **#77** (a fallback driver tab
  carries `cmd: "codex"`/`"opencode"`, which collide with `RESUMABLE_AGENTS`
  at `src/stores/tabs.ts:4043`), plus the #74/#76 remainders. `hermes` was
  dropped; `codex`+`droid` added instead.
- **Git hosting:** P (#79) — multi-host publishing (GitLab + generic remote URL)
  on top of the done GitHub-only flow (D.10 #22); self-contained, pickable anytime.
- **Cross-platform (parallel track):** H (Windows #30 / macOS #31 follow-ups) —
  validate builds & packaging per OS; can proceed alongside the above.
- **Backend runtime (ongoing):** I (#32) — backend-owned runtime hardening
  (PTY resurrection, `.tabtivity/` promotion, durable window metadata, tests);
  pairs with F (session restore).

- **Multi-person (largest net-new concept, plan only):** Z (#169–#199) — the
  self-hosted Tabtivity server. **Do not start it at #173.** Its first four items
  are pre-existing debt worth paying regardless of whether the server is ever
  built: **#169** is now down to *live-testing* the CalDAV push work (it is
  code-complete with the conflict dialog, and `todo/group-x-caldav.md` #160 plus
  `docs/context/caldav.md` describe that state — but nothing in the stack has
  ever spoken to a real server), **#170** is Group P #79's one open bullet, and **#171/#172** fix two
  real single-machine defects — `calendar.json` writes have no compare-and-swap,
  so two Tabtivity windows already lose an edit silently today, and
  `write_json_atomic` has no `fsync`. Then the calendar/board track (Z.1–Z.3),
  which is the half that actually delivers what was asked and is largely
  configuration over the existing CalDAV client. **Read-only project sharing
  (Z.4) is shippable; writable sharing (Z.5) is gated** and may correctly never
  ship — see the plan's §9. Overlaps to respect rather than rebuild: G (fenced
  off — the shared axis must not touch the work-remote axis), O (#58 should
  *gate* the join flow, not be duplicated; #151 is the blocker; #145 gets worse),
  P (#79 is a prerequisite), X (this feature is the answer to the question that
  deferred #160).

## Verification approach (per item, when implemented)

- Frontend changes: `npx tsc --noEmit`, plus existing/added tests under
  `src/__tests__/` (e.g. the session-restore test for Group F).
- Backend changes: `cargo test --manifest-path src-tauri/Cargo.toml`.
- Runtime validation: Claude **must not** launch Tabtivity (user, 2026-07-29), and
  must not stop an instance it did not start. The user runs the app; Claude
  either asks them to click through and report back, or reuses an already-open
  window (`src/` edits hot-reload into it). See `AGENTS.md` § Running.

---

*This is an organizational plan. Pick a group or item number and I'll produce a
focused implementation plan + changes for just that item.*
