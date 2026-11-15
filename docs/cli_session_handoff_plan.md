# Continue work with another CLI

Status: proposed implementation plan, 2026-11-15. No feature code implemented.

## Outcome and scope

A user whose agent hits a usage limit can choose **Continue with another CLI…**,
select an installed CLI, and continue the same work with its context. The source
conversation remains available. This creates a new native session linked to the
old one; it does not convert vendor session databases or promise identical memory.

First release: desktop, ordinary local project agent tabs, Claude ↔ Codex, same
scope and exact working directory/worktree. Both directions must pass before
shipping. No source-model call, external summarizer, automatic provider switch,
file synchronization, commit, stash, branch change, or permission-mode transfer.
Exclude root, assistant, boxes, remote projects, containers, VMs, custom CLIs,
local-model launches and externally attached tmux sessions initially. Show a
clear reason when unavailable. Expand only after each source reader and target
launch/prompt adapter has explicit support.

## User flow

1. Add the action to the agent tab menu and Chat header using one shared handler.
   Keep it available independently of quota detection; limits need not be parsed.
2. Show a compact dialog with compatible installed destinations, their existing
   readiness information, and an editable optional instruction. Explain that
   selected conversation context goes to the destination CLI/provider. Show a
   collapsible context preview and any missing/truncated history. Never claim
   that installation proves login or remaining quota.
3. The button says **Continue with <CLI>**. If the source is working, offer
   **Stop and continue** with an interruption explanation; cancellation does
   nothing. Warn about queued work that will be held. Do not silently interrupt
   on opening the picker.
4. Preflight target, transcript availability and current source identity before
   stopping anything. Hold the source's auto-continue, schedules and queued
   prompts while switching. Stop its owned process subtree, including background
   jobs/subagents, and verify termination before taking the final snapshot.
   Idle status alone is insufficient. If termination cannot be established,
   leave the operation blocked and do not launch the successor.
5. Create a fresh destination tab in the same scope and cwd, using its normal
   configured model and CLI permission behavior. Deliver a short bootstrap
   prompt that asks it to read the attached handoff and continue the user's work.
   No copy/paste step. Focus the destination; keep the stopped source readable.
6. Both tabs show a small predecessor/successor link. The source stays stopped
   across layout restore until explicitly resumed. Resuming it while its successor
   works must explain the shared-working-tree collision. Do not automatically
   migrate schedules, queued prompts, approval decisions or draft text.

## Context contract

Store a versioned handoff containing host-observed facts separately from
agent-authored assertions:

- Source tab, resolved live session, CLI, scope, cwd, capture timestamp and
  transcript fingerprint; destination tab and operation id.
- Original user request where recoverable, later corrections and constraints,
  and recent user/assistant exchanges in chronological order with provenance.
- Existing cockpit handoff/progress/blocker/verification/results, clearly marked
  as agent reports with timestamps, not proof of completed work or passed tests.
- Available task decisions, remaining work and failures from recorded context.
  Without a model, do not pretend a deterministic extractor can reliably infer
  these: retain source excerpts and mark absent sections unknown.
- Working-tree status and changed/untracked filenames captured with hardened git;
  no automatic inclusion of every file's contents, ignored files, credentials,
  environment, vendor configuration, raw tool-output dump or hidden reasoning.
  A non-git project remains supported with status marked unavailable.
- History coverage, omissions and truncation. Preserve original request and recent
  corrections preferentially; never silently substitute a transcript tail for a
  complete conversation. Include a bounded normalized transcript for reference.

Initial configurable-in-code limits: 32 KiB bootstrap/context digest, 2 MiB
normalized reference transcript, 200 KiB per retained message. These are byte
limits, not token guarantees. Show omissions in preview; fail before stopping
if no meaningful user context can be recovered. Reuse normalized reader parsing,
but implement bounded traversal for the initial request: the current 6 MiB tail
reader alone cannot guarantee it. Treat compaction and missing early records as
explicit coverage gaps. Images/attachments initially carry an availability note,
not an invented textual replacement or automatic external upload.

## Storage and trust

Canonical operation records and artifacts live under
<state_dir>/sessions/<scope>/handoffs/<operation-id>/, outside the project.
Use opaque host-minted ids and validated scope/tab lookup. Never accept arbitrary
source paths, launch commands or destination cwd from a browser or renderer.
Stage only this operation's context in the destination's per-scope agent home,
through guarded home I/O, where its normal fence can read it. Keep the canonical
record host-owned; the staged copy is context, not authority. Do not mount the
whole session-state directory. Clean up staged copies with the handoff lifecycle.

Historical transcript text is quoted evidence, not new system instructions or
permission grants. The new agent must follow its current instructions and verify
working-tree facts. Credentials, MCP grants, login state and source permission
flags never travel. Respect local-only/provider restrictions before offering a
destination. Retain artifacts while either linked session needs them; deletion
of both allows cleanup, including staged copies. Do not let an age-based sweep
break a pending or retryable operation.

## Transaction and recovery

Implement a persisted, revisioned operation with states:
preparing → source_stopped → snapshot_ready → destination_created →
prompt_pending → delivered; also failed/cancelled with a recoverable phase.
Use a per-source claim and client request id to prevent double-click/concurrent
handoffs. Revalidate the live session after stopping: a clear/resume during the
picker must rebuild the preview or refuse stale context.

Persist the destination identity before launch and reuse it on retries. Persist
prompt delivery intent and its receipt; distinguish queued, written and observed
as accepted where the CLI supports that evidence. Do not equate spawning a PTY
with successful context delivery. On ambiguous delivery after a crash, present
an explicit retry decision rather than silently sending twice. The UI may offer
retry delivery or resume the original; never automatically run both.

Failure before stopping leaves the source alone. Failure after stopping keeps
its history and cwd intact and offers explicit resume/retry. A destination that
fails login, readiness or quota keeps the prepared handoff available. On restart,
reconcile recorded operations with saved tabs and process ownership before any
resume or prompt delivery; incomplete operations must not resurrect both agents.
Hold source scheduling/auto-continue until explicit resolution, with visible
state and recovery controls. Bound waits and show phase-specific errors.

## Existing seams and proposed implementation

Verified in the repository during planning:

- `src/stores/agents/agentLocationSwitch.ts`: host movement carries Claude only;
  useful UX precedent, not a cross-CLI conversion API.
- `src/stores/agents/agentWorktreeSwitch.ts`: shared `stopAgentTab`; its exit wait
  currently has a timeout, so audit/strengthen termination evidence for handoff
  rather than assuming a returned success proves quiescence.
- `src-tauri/src/services/agent/agent_session.rs` and `agent_transcript.rs`:
  resolve live sessions and normalize conversation records. Reuse their guarded
  readers; preserve provenance/coverage in a handoff-specific collector.
- `src/stores/agents/agentPrompts.ts`: inspect existing prompt queue receipts and
  readiness rules before extending delivery. Reuse the standard tab creation
  and launch preparation paths; never build shell command strings from history.
- `services::cockpit_meta`, `workspace`, `launch_prep`, `agent_home` and `home_io`:
  existing metadata, tab persistence, authority/fence and safe staging seams.

Add an AppHandle-free `services/agent/agent_handoff.rs` for collection, lifecycle,
validation and recovery, plus a frontend `stores/agents/agentCliHandoff.ts`
orchestrator and shared picker. Prefer backend-owned transitions for persistence
and race safety. New commands use Ctx and cfg_attr, receive camelCase payloads,
get command-class rows and regenerated TS classes. Keep v1 operations desktop
only; do not expose raw paths or transcripts through a phone route accidentally.

Add English i18n keys for every display string, shared dialog styling and an
`UntestedTag` register entry `agent.cli-handoff`. Update file-map rows for added
load-bearing files and the session context doc when implementation lands.

## Delivery sequence

1. Fixtures and collector: Claude/Codex live resolution, normalization, bounded
   first/recent history, coverage markers, artifact preview; no process mutation.
2. Durable lifecycle: operation claims, guarded storage/staging, source stop and
   continuation hold, restart reconciliation and failure recovery.
3. Destination adapters: fresh session creation, readiness and prompt delivery,
   predecessor/successor persistence, idempotent retry and source resume controls.
4. Desktop UI and integration: picker, preview, progress, links, recovery, i18n
   and untested pill; verify both directions including an exhausted source.
5. Later: additional CLI adapters, phone/headless controls using opaque ids,
   same-host remote support, and a shortcut beside reliable limit notices.
   Cross-host plus cross-CLI switching remains a separate composed operation;
   read the remote-sync guide before designing any file transfer.

## Verification and acceptance

Unit/integration tests must cover both directions; original request outside the
reader tail; source compaction/clear; malformed, oversized and missing transcripts;
non-git projects; unusual paths; no-follow staging; forged scope/tab/path inputs;
active jobs; stop timeout; target login/quota failure; double click; stale source;
crash at every persisted phase; ambiguous delivery; and retry without duplicate
sessions/prompts. Include scheduling/auto-continue and restoration regressions.
Cross-platform paths use component joins; avoid platform-specific executable
comparisons. Fixture assertions must exercise user-visible behavior, not merely
mirror implementation.

Acceptance scenario: a source changes a tracked file, creates an untracked file,
records a correction and a failing test, then reaches a limit. Switch without
another source API response. Destination reads the correction, sees the existing
files and failure, and continues in the same cwd. Source history remains readable;
no permission mode, secret, schedule or queued prompt was silently transferred.
Repeat with launch failure and app interruption; recovery never runs both agents
or silently resends the bootstrap. Verify actual CLI interactions manually on
Linux X11/Wayland, Windows and macOS before clearing the pill.

Implementation gates: `scripts/gates-job.sh start`, then its saved final status;
`git diff --check`; after Rust edits `npm run backend:stale`. Do not launch or
restart Tabtivity for verification. This documentation-only plan needs no build
or test gate run.
