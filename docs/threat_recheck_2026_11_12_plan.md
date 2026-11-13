# Threat analysis extension — new features, 2026-11-12

## Status and authorization

**Plan only. No review findings, implementation changes or fixes are authorized
by this document.** The user requested an extension of the existing threat
analysis covering new features, then requested that this detailed plan be
written down. The inventory below comes from repository history, file maps and
subsystem documentation; it is not evidence that a vulnerability exists or that
a documented defense holds in the implementation.

Execution of the review is a subsequent task. Its output is an analysis and a
proposed remediation plan, not automatic implementation. Work is sequential by
default; this plan does not request subagents or import the delegation/model
instructions from earlier threat-recheck plans.

## Baseline and scope

- Existing analysis: `docs/threat_model.md`, including its tier definitions,
  legend and gaps 1–104.
- Last broad review: `b3abe5ba`, 2026-11-04. Evidence and previous fix decisions:
  `docs/threat_recheck_2026_11_04_handoff.md` and
  `docs/threat_recheck_2026_11_04_plan.md`.
- Previous fix completion: `1416bba3`, 2026-11-06, as recorded in that plan.
- Inventory endpoint: `214933ab5fd36cac71836cb26f2acd52c65ccb43` on `develop`.
  Use `b3abe5ba..214933ab5` for the initial feature inventory, not just commits
  after fix completion: features landed during the previous remediation run.
- Include added capabilities and changes to security-relevant behavior,
  whatever their commit labels. A refactor or fix can add an entry point or
  invalidate a defense. Pure layout changes need only a documented exclusion
  unless they affect consent, target selection or disclosure.
- Recheck an old mechanism only where a new feature calls it, changes it or
  relies on its guarantee. Do not reopen the entire historical backlog, repeat
  an unrelated infrastructure audit or treat earlier accepted residuals as new
  findings without a changed attack path.

The checkout already had unrelated edits when this plan was prepared:
`.github/codeql/reviewed.json`, `docs/filemap_frontend.md`,
`services/agent/assistant_attach.rs`, `services/sync_handoff.rs` (both under
`src-tauri/src/`), frontend resource-display and Reader tests, `TableView.tsx`,
`AppResourceDisplay.tsx`, and an untracked `TableViewEfficiency.test.tsx`.
Record these separately at execution time; do not attribute them to the pinned
commit or overwrite them. A suppression-list change is not evidence that a
security finding was fixed.

## Step 1 — Freeze the review inventory

1. Record the actual review HEAD, branch, worktree status and date. Keep the
   baseline above even if HEAD has advanced. List later commits as a separately
   identified delta; do not silently move the evidence cutoff while reviewing.
2. Inspect the complete changed-path list and commit history, not only `feat`
   subjects. Include command registration, dispatch, transport, schemas,
   configuration defaults, dependency/lockfile changes and installer scripts.
3. Map each material change to a work package below, an existing threat-model
   row, or an exclusion with a reason. Deduplicate previous remediation commits
   against the November 4 plan, while retaining their interactions with new code.
4. Locate entry points using `rg` in the file maps; read only relevant ranges.
   Treat documentation as a statement to verify against code. Start at
   `docs/server.md` for server routes and read `docs/remote_sync_guide.md` before
   tracing byte-sync or git lockstep.
5. Make a coverage matrix with columns: feature/change, commit(s), entry point,
   attacker-controlled input, asset, trust boundary, runtime/platform, existing
   model row, work package, evidence reference, disposition and remaining work.

**Exit:** every material new surface is assigned; excluded changes have reasons;
committed evidence and optional worktree evidence are distinguishable.

## Step 2 — Review the feature packages

Priority means review order and potential blast radius, not a severity verdict.
Paths below are starting points at the inventory endpoint. Follow callers,
registration and sinks to establish the actual boundary; do not stop at a helper
whose caller can bypass it.

### A. Local models only and Cut network — first priority

Start with `docs/context/local_models_only.md`,
`src-tauri/src/commands/agent_privacy.rs`,
`src-tauri/src/services/agent/agent_privacy.rs`, `agent/agent_fence.rs`,
`services/local_drivers.rs` and all of `services/local_lane/`.

Trace:

- Registry-owned privacy state, malformed/legacy values, stale whole-store
  saves, imported settings and unauthorized setters. Confirm project files
  cannot weaken the policy.
- Every launch route: desktop, phone/headless, restore/resume, scheduler, shell
  shim, root/box scope, worker/remote/container routes and unsupported platforms.
  Follow validation through argv rewrites to the final spawned process.
- Activation while agents are already running, detached tmux sessions, crash
  recovery, overlapping roots, symlink aliases, and parent/box/root visibility.
  Inspect ordering and races between checking, revoking and spawning.
- Provider-key and fallback-token removal, local-home isolation, inherited
  environment, global config, model switching and host API-proxy access.
- Relay socket permissions and binding, tab identity, request framing, duplicate
  headers/JSON keys, route and model allowlists, redirects, upstream ownership,
  streaming limits, timeouts and teardown of the entire child subtree.
- Every host-mediated exit: allowed MCP calls, web/model helpers, result opening,
  file attachments, print, root tools and cross-project reads. Distinguish the
  documented network-on limitations from promises made by Cut network.

Proposed verification cases: malformed policy, forged launch metadata, stale
session, sibling-root alias, cloud/unknown model, foreign listener, disallowed
MCP tool, malformed HTTP, relay startup failure and relay orphan cleanup.
Use synthetic inputs/stubs; do not launch an actual agent or change user policy.

### B. Cockpit metadata and agent print MCP — first priority

Read `docs/context/cockpit_mcp.md` and `docs/context/print_mcp.md`. Start at
`services/mcp/cockpit_mcp.rs`, `services/cockpit_meta.rs`,
`services/cockpit_results.rs`, `services/mcp/print_mcp.rs`, their commands,
`src/lib/viewers/printRequest.ts`, `print.ts` and `printImposition.ts`.

Trace:

- Token grant, lane separation, spawn-bound identity, revoke/respawn behavior,
  server/headless exposure and command-class enforcement. A caller must not
  select another tab by supplying a saved id.
- Revision checks, stale updates, shared-window merges, rate limits and expiry.
  Agent-authored names, notes and verification claims must remain attributable
  to the agent rather than becoming trusted app assertions or permission UI.
- Result references from registration to explicit opening: traversal, absolute
  paths, reserved scopes, remote roots, missing files and symlink swaps. Check
  both storage-time validation and click-time authorization.
- Print snapshot acquisition, PDF sniffing and byte limits, pending budgets,
  options bounds, preview loading, cancellation/expiry and session closure.
  Establish exactly which bytes and user-adjusted options reach the native
  printer, and whether concurrent approval can print a request twice.
- Confirm the absence of unintended print grants in headless/server runtimes
  and the Cut network lane; check all token environment/scrub paths.

Proposed cases: another tab's id, old spawn token, stale revision, swapped result
symlink, changed source PDF, concurrent approve/cancel, expired request, excessive
copies/pages and malformed PDF. Native printing remains a user-run live check.

### C. Credentials, Muse sessions and Tabby attachments — first priority

Start at `services/agent/claude_token.rs`, `agent_auth.rs`, `agent_home.rs`,
`agent_exec.rs`, `muse_session.rs`, `agent_chats.rs`, `agent_transcript.rs`,
`assistant_attach.rs`, and the corresponding launch, phone and Reader callers.
Read `docs/context/assistant.md`, `agent_sessions.md` and `agent_reader.md`.

- Follow the Claude fallback token from setup/paste to storage, fallback
  selection, local launch, remote opt-in, SSH/tmux transfer, removal and errors.
  Check that it cannot leak through logs, argv, transcript previews, unrelated
  scopes or local-only launches. Verify the setup-output watcher identifies the
  intended tab and does not adopt unrelated terminal text as a credential.
- Review Muse session path construction, UUID/session selection, workspace
  matching, no-follow reads, total parsing bounds and malformed/truncated JSONL.
  Trace desktop/phone transcript and Resume callers for cross-scope disclosure.
- Follow typed, pasted, dropped and phone-uploaded Tabby attachments through
  attachment marking, persistence/restart and web-lane restrictions. Check
  ordering when Enter immediately follows a picture paste, error handling when
  marking fails, and consistency across supported CLIs.
- Identify any newly reachable credential read or exfiltration path; carry
  forward the older attachment/web residuals only with their original limits.

Proposed cases use dummy credentials and temporary session stores only: stale
setup watcher, opt-out remote launch, token removal, traversal/symlink session,
wrong workspace, oversized records and attachment-marker failure.

### D. Phone, Reader, markup and file delivery — second priority

Start with `mobile-web/src/components/ChatLinksIndex.tsx`,
`components/ShareSizeSheet.tsx`, `terminal/chatLinks.ts`, `outboxShare.ts`,
Reader file/link callers, backend gallery/outbox routes and attachment input
paths. Read the relevant sections of `docs/context/mobile_access.md`,
`mobile_sidecar.md`, `phone_markup.md` and `agent_reader.md`.

- Prove backend project/device authorization separately from UI filtering by
  sender or conversation. Check saved/reopened tabs, subagents and reused ids.
- Trace extracted links to their opener: schemes, credentials in URLs, local
  paths, escaping, redirects, remote localhost forwarding and rendered labels.
- Review clipboard/drag-out, pasted file/image answers, shared markup and large
  file delivery. Establish what leaves the project, where it is staged, what
  the confirmation covers and what happens if the tab or file changes meanwhile.
- Check path containment, content origin, MIME handling, hidden names, sealed
  token bindings, streaming/resource bounds, interrupted transfers and cleanup.
- Verify new desktop paths and phone paths enforce equivalent boundaries where
  they share data; do not assume a per-conversation gallery is an access control.

Proposed cases: cross-tab/device request, stale conversation, hostile link,
renamed/symlinked source, oversized share, canceled share and spoofed sender.

### E. Remote forwarding, background TeX and sync handoff — second priority

Read `docs/context/port_forwards.md` and `docs/remote_sync_guide.md` before tracing
sync. Start at `commands/port_forward.rs`, `services/port_forward.rs`,
`commands/tex/host.rs`, `src/lib/viewers/tex/hostTexBuild.ts`,
`commands/sync_handoff.rs` and `services/sync_handoff.rs`.

- Forwarding: registry-derived host identity, connected-only/no-dial behavior,
  loopback bind address, port/URL parsing, SSH argv construction, existing-port
  collisions, cross-tab ownership, disconnect/exit cleanup and unsupported
  runtime refusal. Check that a remote localhost link cannot open an unrelated
  service on the user's own machine.
- TeX: execution-trust decision, registry-derived working directory and host,
  shell-escape restrictions, repo-controlled configuration, argument quoting,
  output paths, bounded logs/timeouts, cancellation and child cleanup. Moving a
  build out of a tab must not remove a trust gate or make it immortal.
- Handoff: source/target agent scope, safe relative names, held directory
  handles, export collision/retention behavior, remote content bounds and
  resolved-file readback. Trace the later Apply operation for stale sources,
  conflict checks, user edits and required local-loss records. Preserve the
  tracked-file/byte-sync ownership split.

Proposed cases: disconnected host, malicious URL/filename, simultaneous owners,
untrusted build config, canceled build, export id collision, symlinked resolved
file, source changed after export and resolution aimed at another project.

### F. TensorBoard, model sourcing, Piper and new file readers — second priority

Start at `src/components/embed/TensorBoardView.tsx`,
`src/lib/viewers/tensorboard.ts`, its backend event-reading commands,
`src-tauri/src/commands/ollama/hf.rs`, `services/voice/piper.rs`, relevant
installation scripts and dependency changes. Include Python site-packages
navigation and changed table/diff parsing if the inventory shows a new boundary.

- Untrusted event lengths, records, nesting, numeric extremes, truncated files,
  append/restart behavior, memory/CPU bounds and cumulative live-polling growth.
- Remote range-read limits, disconnected hosts and hidden-pane work suppression.
- User-supplied model identifiers/URLs, redirects, authentication forwarding,
  destination paths, archive extraction where used, executable provenance,
  integrity checks, partial downloads and concurrent installs.
- Distinguish loading model/voice data from executing a downloaded program;
  trace any repo-controlled configuration or external process involved.
- File navigation beyond the project: establish the intended interpreter/source
  authority and ensure a link is not an unintended read or execution primitive.

Proposed cases: corrupt event stream, oversized record/count, growing file,
hostile identifier, redirect to an unintended host, invalid download digest,
interrupted installation and crafted navigation target. No live downloads or
installer execution are needed for the initial code review.

### G. Voice, steering, queued input and popouts — second priority

Read `docs/context/voice.md` and `phone_steering.md`. Start at
`src/hooks/useSteering.ts`, `src/lib/shortcuts/steering*.ts`, Reader prompt/voice
handlers, `src/lib/voice/`, `mobile-web/src/steering/`, and the terminal voice
hooks under `mobile-web/src/screens/terminal/`.

- Bind every delayed action to its intended tab, window, session and device;
  trace focus transfer, blur, closed/reopened tabs, popout reseeding and queued
  prompts across navigation.
- Separate CLI choices from app permissions and saved-rule dialogs. Voice and
  steering changes must not bypass the earlier no-voice-on-permissions decision.
- Check echo/read-aloud suppression, start-word/navigation state, cancellation
  windows, spoken draft edits, duplicate delivery and stale numbered menus.
- Check attachment-bearing answers, suggestions and slash-command UI for text
  being executed or submitted without the action the user actually chose.

Proposed cases: focus switches during recognition, read-aloud echo, canceled
prompt, stale digit choice, closed target, two windows delivering one action,
queued prompt edited before send and a permission dialog appearing mid-command.

## Step 3 — Cross-feature review

After A–G, trace combinations that isolated reviews can miss:

1. Local-only/Cut network with fallback credentials, cockpit results, print,
   attachments and all allowed host MCP capabilities.
2. Phone/headless launches and restored sessions with privacy activation,
   attachment restrictions and new conversation stores.
3. Reader links and file delivery with remote forwarding, content-origin rules
   and interpreter-based navigation outside the project.
4. Voice/keyboard actions with print approval, large-share confirmation, queued
   input and sync-resolution Apply.
5. New command registrations with desktop/client/core/off classification,
   daemon dispatch, raw-path confinement, model-argument allowlists and
   per-device policy. Classify unsupported routes explicitly.

Build a runtime matrix: Linux desktop, Windows desktop, macOS desktop,
phone with window, phone with headless owner, and server/browser client. Mark
each applicable boundary as code-reviewed, test-supported, live-verified,
unsupported or unresolved. Do not infer runtime verification from a Linux build
or from a platform conditional that merely compiles.

## Step 4 — Findings and evidence standard

Each candidate receives a temporary package-local id (A1, A2, B1, ...). Record:

- Feature, pinned revision and whether evidence includes worktree changes.
- Attacker and prerequisites; required user action and existing model tier.
- Asset and violated guarantee; entry point → checks → privileged sink.
- Exact file/symbol/line references, realistic attack sequence and impact.
- Existing defenses and why they do or do not stop the sequence.
- Severity with rationale, distinct from confidence and verification status.
- Reproduction or bounded test proposal; observed result versus inference.
- Proposed mitigation, compatibility/data-loss concerns, residual risk and any
  user decision needed. Do not silently replace an earlier product decision.

Dispositions: confirmed new gap; changed exposure of an existing gap;
documented accepted limitation; defense supported by reviewed evidence;
unresolved question; or excluded with reason. A missing test alone is not a
vulnerability, and a passing test alone does not establish the whole boundary.
Deduplicate before allocating permanent gap ids; start after 104 only if no
other review has since allocated ids. Never renumber historical findings.

Use synthetic examples in the public repository. Do not include actual tokens,
session contents, user paths, private hostnames or sensitive reproduction data.

## Step 5 — Documentation deliverables after the review

1. `docs/threat_recheck_2026_11_12_handoff.md`: actual review revision/date,
   coverage and runtime matrices, package evidence, findings, exclusions,
   unresolved questions and proposed live checks. This file is not created by
   the planning task.
2. `docs/threat_model.md`: dated scope statement, new feature rows in the
   existing tier structure, changed old rows only where justified, and a new
   gap section if findings exist. Preserve prior decisions, residuals and
   not-live-verified labels. Do not present this as a full re-audit.
3. A separate remediation plan if gaps warrant changes: dependency-ordered
   fixes, acceptance checks and explicit product decisions. No implementation
   is part of the analysis task.
4. New actionable backlog items in the matching `todo/` group, with links back
   to evidence and no duplicate historical items. Any manual test checkbox gets
   the required Works/Doesn't work child pair for Linux (X11), Linux (Wayland),
   Windows and macOS; tick only platforms actually checked.

## Verification and operating constraints

- Never start, stop or restart Tabtivity. Do not change live settings, pair a
  device, launch agents, send messages, submit print jobs or run installers to
  validate a hypothesis. Supply exact user click-through steps for live checks.
- Review tests already present first. If review execution includes bounded
  experiments, use temporary synthetic fixtures and isolated state, record the
  exact command/result, and leave implementation/test sources unchanged.
  Testing a dangerous path through production credentials or user data is not
  necessary to establish a finding.
- Validate new documentation paths, symbols, revision claims, links and finding
  ids. Run `git diff --check` and the applicable `scripts/gates.sh` checks,
  started in the background as AGENTS.md requires. In a shared dirty checkout,
  report broader gate selection and unrelated failures honestly; do not fix
  unrelated work or present whole-tree checks as proof of security.
- No backend implementation edits are planned, so no app restart or
  `backend:stale` invocation is needed for this documentation task. A later fix
  task must follow the normal backend-stale and gate rules.
- Do not commit or push as part of planning. Leave previous reports, generated
  artifacts and other sessions' edits intact.

## Completion criteria and handoff

The analysis is complete when every inventoried feature has a supported
disposition; every applicable runtime boundary is covered or explicitly left
unresolved; cross-feature interactions have been traced; findings have evidence,
impact and proposed verification; and the threat-model extension agrees with the
handoff. Open questions must name the missing evidence and next action, not be
hidden behind a defended marker. Any uncovered material surface makes coverage
partial and must be stated in the final report.

The final report should state the exact reviewed revision, whether worktree
changes were included, confirmed findings by severity, remaining uncertainty,
tests actually run, platforms not run live, and links to the resulting documents.
Do not label the application secure merely because no new gap was confirmed.

**Next action when review execution is requested:** Step 1, then A–G, then the
cross-feature pass, evidence consolidation and documentation extension. Writing
this plan completes only the planning task.
