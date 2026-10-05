# Tabtivity — Roadmap

Reviewed **2026-09-15** against **v0.1.68**. This file records direction and
sequencing; [STATUS.md](STATUS.md) describes the implementation and verification
limits. Concrete tasks live in [TODO.md](TODO.md) and [`todo/`](todo/).

## Implemented Foundation

The Rust/Tauri migration is complete. Project/box desktop contexts, tiling and
pop-out tabs, agent resume, remote SSH/SFTP with Git lockstep and byte-sync,
Docker/VM runtimes, mail/calendar/CalDAV, native viewers, and Tabtivity Mobile are
implemented. Windows and macOS have native integration and CI packaging.

Recent work adds the per-project prompt chart, draft board, scheduling and
completion-gated chains, CLI-hook activity, model-aware prompt history, Mobile
Focus transcripts, file sharing to the phone, and print job previews. These are
part of the current baseline; their remaining work is verification and hardening.
The agent's permission mode stays under its own CLI's control.

## Next: Verify and Stabilize the Existing Workflows

1. **Project and session continuity.** Exercise switching projects and boxes,
   detached-window parking/redocking, resize/paste/exit, per-tab Claude/Codex
   resume, continue-latest limits for other CLIs, and remote tmux reconnects.
   Confirm files, app defaults, and time tracking follow the chosen scope.
2. **Prompt delivery.** Live-test draft creation and multi-select moves, schedule
   edits, prefix commands/model choices, closed tabs, missed occurrences, and
   after-links. Check that decisions and new turns postpone follow-ups and that
   hook-free agents' idle heuristic behaves predictably. Schedules currently
   depend on the desktop window being open.
3. **Connected features.** Validate CalDAV pull/push conflicts against a server,
   mail encryption and VPN-gated accounts, Mobile pairing/lock/revocation,
   reconnects after desktop updates, Focus fallback, outbox, and gated writes.
   Verify the opt-in browser live window's permission and IPC boundaries.
4. **Hardware-dependent features.** Run the Deck presenter with a second display,
   printer submission/queue tracking, a real VM boot, and HPC/SLURM workflows on
   a cluster. Test Windows/macOS integrations and KDE Wayland on real desktops.

Track results per item in the existing groups, and remove an `UntestedTag` only
after user confirmation. See [verification](todo/group-y-verification.md),
[sessions](todo/group-f-session.md), [remote/HPC](todo/group-g-remote.md),
[mail](todo/group-j-mail.md), [CalDAV](todo/group-x-caldav.md),
[presenter](todo/group-v-presenter.md), and
[Mobile acceptance work](todo/group-h-crossplatform.md).

## Reliability and Maintenance

- **Runtime and security:** continue PTY/process cleanup, fence/credential
  boundary checks, durable session metadata, and explicit handling of stale
  packaged backends/PWA bundles. Keep Git lockstep and byte-sync ownership
  separate; retain file-backed local-loss notices for destructive background
  moves. See [runtime](todo/group-i-runtime.md) and
  [security](todo/group-o-security.md).
- **Measured responsiveness:** measure UI and remote-probe costs before widening
  polling or adding visual work. Preserve visible-only viewer/terminal work,
  panel snapshots, Fast mode, and Energy Saver; examine remaining background
  sync/lockstep costs. See [performance](todo/group-u-performance.md).
- **Maintainability:** split the largest viewer, tab-store, and project-command
  modules in focused changes behind the existing CI gates. Keep desktop and
  Mobile type-checks, tests, lint/clippy, and the privacy scan mandatory.
  Broad Rust formatting remains deliberately deferred.

## Product Follow-ups

- **Prompt Universe — planned, not built.** Add a global cross-project agent/job
  overlay using the existing project-cloud UI and prompt/activity stores. The
  current prompt chart remains scoped to one project or box. See the
  [Prompt Universe plan](docs/prompt_universe_plan.md).
- **Git hosting:** GitHub and GitLab publishing already ship. A generic remote
  URL flow and reducing the dependence on provider CLIs remain follow-ups.
  See [hosting](todo/group-p-hosting.md).
- **Local agents and models:** finish driver discoverability and restore
  behavior, and separate the local-runtime interface from Ollama assumptions.
  The smart/native shell is still research, not an implemented replacement for
  the PTY. See [local agents](todo/group-s-agents.md) and
  [smart shell](todo/group-t-shell.md).
- **Viewers and presenter:** continue the open editing, performance, and
  presentation work after acceptance checks. Remaining Office formats still
  open externally. See [viewers](todo/group-m-viewers.md) and
  [presenter](todo/group-v-presenter.md).

## Spare-Capacity Backlog

A lookup for weeks with agent budget left over: self-contained improvements
that are worth doing but gate nothing above. Pick from the top of a group;
each entry names where the work lives. Add new groups below as they come up.

### Text viewer autocomplete (#45, `FileViewerPane.tsx` + `commands/ollama.rs`)

Implemented **2026-09-18**, pending live verification: a debounced (600 ms)
ghost from a loaded Ollama model, Sentence/Block/Scope modes, hand-picked
reference files, and Tab / → / Esc to accept, walk, or dismiss.

1. **Implemented: bound the window sent.** IPC carries at most 4,096 UTF-16
   units before and 1,024 after the caret, cut at line boundaries where possible
   without splitting Unicode pairs. The backend independently caps input too.
2. **Implemented: native fill-in-the-middle.** Models advertising `insert` use
   `/api/generate` with `suffix`. Unknown/non-insert models, reference-file
   requests, and an empty suffix use chat. An unsupported insert request falls
   back to chat before publishing any text. Native whitespace is preserved.
3. **Implemented: cancel for real.** A reservation makes cancel-before-start
   race-free; cancellation drops the HTTP response/socket. Typing, navigation,
   blur, hiding/disabling, context changes and unmount cancel stale generation.
4. **Implemented: stream into the ghost.** NDJSON tokens update the ghost via a
   per-request event targeted only at the editor window. Old streams cannot overwrite a newer draft; errors
   discard partial ghosts. Requests have an overall timeout and bounded output.
5. **Implemented: type-through keeps the ghost.** Matching insertions consume
   only the typed prefix; replacements, deletions and mismatches dismiss it.
   Typing/accepting part of a stream cancels generation and keeps its remainder.

Additional improvements: chat prompts preserve the document's natural language;
completion disables thinking and skips known non-completion models. Automated
coverage includes split UTF-8 streams, socket cancellation, early cancellation,
stale replies, input bounds and type-through. Live quality/latency comparison
with actual models remains open (Group M #45).

6. **Implemented: cache model discovery.** Concurrent editors share a five-second
   model-list cache, keyed by endpoint/policy. Errors retry immediately; loaded
   model changes are picked up on the next trigger after expiry.
7. **Implemented: automatic context.** Attached files have priority, followed by
   LaTeX label/bib keys, static local imports/`\input`s and other open text tabs
   in the same project. Optional disk reads are capped at 16; UTF-8 context stays
   within 6,000 bytes per reference / 24,000 total, including before IPC. Missing
   references are skipped; reference changes invalidate cached completions.
8. **Implemented: prose awareness.** Markdown/LaTeX/plain text use chat with an
   explicit document-language/markup instruction. Sentence mode cuts at the first
   line/sentence boundary and closes the stream; decimal periods are preserved.
   Block/Scope and code-intent completions retain their longer output budget.
9. **Implemented: suggestion controls and feedback.** Alt+→ accepts a line;
   Alt+[ / Alt+] cycle three on-demand seeded candidates. A per-editor, bounded
   60-second memory cache includes prefix/suffix, model, mode and references.
   Accept/dismiss outcomes are recorded once per candidate in local `usage_stats`
   and shown by mode/model in the usage recap. No document text is recorded.

Items 6–9 implemented **2026-09-18**, pending live verification. Check imports,
open-tab context and TeX keys; a German paragraph in Sentence mode; Alt+→ and
candidate cycling; undo/revisit reuse; and the usage recap. UntestedTag remains.

### Mail AI (Group Q #203–#208, `services/mail_ai.rs`, `MailAi*.tsx`)

Today: loopback-only Ollama; on-demand summary, event and to-do extraction,
draft-from-notes in the composer, and subject/sender/preview triage into
Important/Urgent at sync. All of it is per-account opt-in and untested live.
Every idea below has to keep the Group Q invariants: loopback only, nothing
decrypted persisted, review before create, and a model verdict never shown as
a filter hit.

1. **Live QA first.** Run the five checks in `todo/group-q-mail-ai.md` and
   remove the tags. Most of the items below tune prompts, and that only makes
   sense against real mail.
2. **Thread-aware summary.** Summarize the whole conversation (the thread the
   message belongs to), not the one message, and lead with the open question
   or request addressed to the user.
3. **Suggested replies.** From the open message, offer 2–3 one-line reply
   intents ("accept", "decline politely", "ask for the agenda") that feed the
   existing *Draft from notes* path. The same rule holds: it fills the
   composer, never sends.
4. **Reply in the sender's language.** Detect the original's language and draft
   in it by default. Add tone presets (formal / friendly / short) and a
   per-account signature and name for the draft.
5. **Rewrite a selection in the composer.** Shorten, make it more formal, fix
   grammar. Reuse the grammar role's model and the editor's
   `GRAMMAR_SYSTEM`-style JSON so it is one mechanism, not two.
6. **Triage quality.** Add a per-account "who matters" hint (VIP senders or
   domains) to the classify prompt. Let the user correct a verdict
   ("not urgent"), and keep recent corrections as few-shot examples. Show the
   `priority_reason` inline in the list, not only in the message.
7. **Deadline and action digest.** A local "needs a reply / has a deadline"
   view across the inbox, built from the same extraction prompts. It feeds the
   daily recap and the to-do board's intake column with review before create.
8. **Multiple events and attachments.** Extract more than one event per mail
   (conference programmes, schedules), and read `.ics` attachments directly
   instead of asking the model. Summarize a PDF attachment's text with the
   same ephemeral rule.
9. **Search by meaning.** Local embeddings of subject+preview (an
   embedding-role model is already a refusal case here, so the role split
   exists). They must live inside the sealed store, never as plaintext.

### Security review (mail, agent fence, MCP)

A periodic pass over the three places where outside input meets local
authority. Each item is a check or a hardening step, not a known hole. Confirmed
holes are fixed before they are written down. The last pass (2026-09-18)
removed two: the root console's MCP token no longer reaches the tmux launcher
script on disk, and a fenced agent's tmux pane drains the terminal's input
queue before handing it to the unfenced login shell.

1. **Dependency audit in CI — done 2026-09-18.** `.github/workflows/security.yml`
   runs `cargo audit` and `npm audit --omit=dev` on every push/PR and weekly,
   as a blocking job, beside CodeQL (JS/TS, Rust, Actions → Security tab). A
   full-history gitleaks scan (`.gitleaksignore` holds triaged false
   positives) runs in `ci-cd.yml`, where the release job waits on it. The first findings (h2, rustls, quick-xml via
   calamine/plist/xcb/wayland-scanner, dompurify, mermaid) were cleared when
   it landed. This matters
   most for the parsers facing untrusted input: ammonia/html5ever, the
   MIME/IMAP stack, pdf.js.
2. **Fence escape suite.** Make the probe run by hand in the last pass a
   script: run the real `bwrap_args` output and assert that from inside,
   `~/.ssh`, the keyring, `/run/user/<uid>` (D-Bus, X authority), other
   projects and the state dir are invisible, and that the X server refuses a
   client. Run it after every fence change and on each distro in the matrix.
3. **Inventory what fenced agents can reach.** The fence shares the host
   network namespace by design, so every loopback listener is within reach.
   Keep a list (root MCP, Mobile sidecar, Ollama, dev server, anything a
   project starts) with each one's authentication. Ollama has none, which is
   accepted today; write down that decision.
4. **Defence in depth for the fence.** Landlock abstract-Unix-socket and
   signal scoping (kernel ≥ 6.12) as a second layer beside bubblewrap. A
   seccomp filter for `TIOCSTI`/`TIOCLINUX` as the source-level fix behind the
   tmux input drain.
5. **MCP: narrower authority.** Per-tab root tokens that die with the tab, and
   a read-only tool set as the default, with write tools as an opt-in. Add a
   local audit log of every write (tab, tool, row), and a trash or undo for
   `todo_delete` / `calendar_delete_event` instead of a permanent delete.
6. **MCP: label where data came from.** Rows a root agent reads can come from
   outside: a CalDAV server, or a card extracted from mail. Tool output should
   say so (`source: caldav|mail|user`), so that text from outside is never
   presented as the user's own instruction. Add a test that the project
   scaffold never pre-approves a repo's own MCP servers.
7. **Mail: re-verify the boundaries on every bump.** Run ammonia's three
   guarantees against a current mXSS corpus when html5ever or ammonia update.
   Keep pdf.js attachment previews canvas-only, and keep `unsafe-eval` out of
   the app CSP, which is what keeps pdf.js's font-compiling `eval` path inert.
   Confirm the sealed store leaves no plaintext behind (caches, logs, crash
   reports, the summary path).
8. **Mail AI: tighten automation.** Keep `auto_create` off for senders the
   user has never written to, cap the length of extracted titles, and show
   mail provenance on every card or event made without review.

## Longer-Term Direction

- **Tabtivity Server — plan only.** One Linux server running every user's
  projects, terminals and agents, with desktop browser and phone as thin
  clients. Each user gets a daemon under their own uid and signs in to their
  own agent CLIs. Shared projects are a bare hub repo with a clone per member.
  Mail, calendar and todo are per user; mail stays private, while calendars
  and todo lists can be opened to others. The first step is moving live state
  out of the desktop window into the headless Mobile sidecar, which pays off
  on the desktop alone. See the
  [server plan](docs/tabtivity_hosted_plan.md).
- **Broader desktop integration.** Linux X11 remains the reference. Validate the
  implemented KDE Wayland, Windows, and macOS backends before claiming parity
  from real use. Other Wayland compositors still need their own backends; macOS
  app-level parking has platform limits. See [platform work](todo/group-h-crossplatform.md)
  and [workspace work](todo/group-c-workspace.md).
- **Complete project context.** Extend the existing terminal/file/app/machine
  context with richer notes, task metadata, and workflow state. Pluggable
  compositor backends and an eventual Tabtivity-native compositor remain long-term
  direction, not current delivery commitments. See [VISION.md](docs/VISION.md).
