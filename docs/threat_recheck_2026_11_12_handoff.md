# New-feature threat review — 2026-11-12

## Result and scope

**Five new findings: two medium, three low. No fixes implemented.** This is a
targeted source review with bounded synthetic checks, not a live penetration
test or a new audit of every historical threat-model row. No claim of an absence
of high-severity bugs follows from this result.

Baseline: `b3abe5ba` (the November 4 review). Reviewed endpoint:
`214933ab5fd36cac71836cb26f2acd52c65ccb43`, `develop`. Features added during the
November 5–6 remediation run were included in the inventory. The November 4
plan's fixes and decisions were not reopened wholesale.

The shared checkout also contained unrelated uncommitted edits. The
`assistant_attach.rs` logging change and `sync_handoff.rs` parameter rename were
read as worktree evidence; neither changes the findings below. Frontend table
and resource-display edits and CodeQL suppression edits were not audited as new
features. This task changes documentation only. Source references below are
relative to the repository at the reviewed endpoint; line numbers can drift.

| Gap | Severity | Finding | Evidence strength |
|---|---|---|---|
| 105 / F1 | Low | TensorBoard special property names throw in the viewer | Actual pure frontend function, synthetic input; backend acceptance traced |
| 106 / F2 | Medium | TensorBoard's per-read tag cap does not bound accumulated state | Actual pure frontend function, successive synthetic reads; polling path traced |
| 107 / B1 | Low | A canceled print can still reach native printing after the pending check | Actual layout/print callback with stubbed layout and printer; ordering traced |
| 108 / E1 | Low | Load resolved silently falls back to an older conflict export | Existing backend regression test explicitly exercises fallback; UI drops provenance |
| 109 / A1 | Medium | Privacy activation reports success when detached-agent cleanup fails | Source-confirmed error swallowing; failure injection/live behavior not exercised |

Severity reflects impact and prerequisites. The low findings still matter for
integrity and availability. None demonstrates arbitrary code execution in the
desktop or a direct unauthenticated network compromise.

## Findings

### 105 / F1 — hostile TensorBoard tag names break state accumulation

**Entry and prerequisite:** open an event file or run folder supplied by a
repository author or remote account. An ordinary scalar tag can be named
`__proto__`, `constructor` or `toString`; no executable content is needed.

**Evidence:** `src-tauri/src/services/tfevents.rs:180` limits name length but does
not reserve object-property names. `take_event` at line 440 stores these strings
in a Rust `BTreeMap`; the read result serializes them as ordinary JSON keys.
`src/lib/viewers/tensorboard.ts:174` copies state into `{}` and evaluates
`scalars[tag] ?? []`. For a new special key this finds an inherited object or
function, not an array. `mergeSeries` at line 111 throws. The caller at
`src/components/embed/TensorBoardView.tsx:168` invokes `applyRead` outside the
inner read-error catch; its outer block has `finally` but no catch.

**Observed:** transpiling and running the actual pure frontend module produced:

```text
loss: accepted
__proto__: TypeError: Cannot read properties of undefined (reading '0')
constructor: TypeError: Cannot read properties of undefined (reading '0')
toString: TypeError: existing is not iterable
```

**Impact:** the file stops loading and produces an unhandled rejection; later
polls can hit the same record again. This is viewer availability, not proven
prototype pollution or code execution. No browser/window crash was measured.

**Proposed correction:** use `Map` or null-prototype dictionaries consistently,
or explicit own-property checks for reads and safe own-property writes. Cover
scalar tags and plugin-kind keys in `skipped.series`, including `__proto__` on
both first and later reads. Acceptance: arbitrary tag strings round-trip without
exceptions or prototype changes, and the normal-series result remains correct.

### 106 / F2 — bounded reads become unbounded accumulated tag sets

**Entry and prerequisite:** view a large or continuously appended event file
containing many different scalar tags/plugin names. The author controls file
contents; the viewer follows the file after the user opens it.

**Evidence:** `services/tfevents.rs:29` caps scalar tags at 2,000 **per scan**.
`commands/tfevents.rs:25` limits each read to 24 MiB. In the frontend,
`tensorboard.ts:174–194` retains every key from previous reads and adds new keys;
the point bound is per series, not a total tag/point/byte bound. Other-series
names are unioned too. `TensorBoardView.tsx:151–171` can consume 5,000 chunks per
file in one pass, and further passes continue from that state. The hidden-pane
guard stops work while hidden but does not reduce retained state.

**Observed:** three synthetic answers, each with 2,000 distinct allowed tags,
left 2,000, then 4,000, then 6,000 retained keys in the actual `applyRead` result.
Only one point per tag was used. No memory-exhaustion experiment was performed.

**Impact:** attacker-controlled retained memory and chart/tag processing can
grow with total distinct names despite the per-read caps, potentially exhausting
or freezing the renderer. This concerns aggregate resource policy, not a Rust
memory-safety defect. The finite per-pass iteration limit does not bound the
state retained across passes.

**Proposed correction:** enforce cumulative per-file and per-view budgets for
tags, points and other-series metadata before insertion; surface truncation and
drop counts, and bound how much catch-up work runs in one pass. Acceptance:
successive disjoint batches and many discovered files stay within one explicit
total budget; hidden/show and reset behavior preserve those limits.

### 107 / B1 — print cancellation has a check-to-use window

**Entry and prerequisite:** a user presses Approve & print, then the request is
withdrawn/rejected or its session closes while PDF layout is in progress. The
request was initially valid and user approval is still required.

**Evidence:** `src/lib/viewers/print.ts:1314` checks `stillWaiting`, then line
1323 calls the asynchronous native callback. In `printRequest.ts:69–71` that
callback awaits `layoutPrintPdf` and invokes `printPdfNative` without another
check or a backend claim. Only after the print outcome is returned does
`print.ts:1254` invoke `onPrinted`; its rejection is swallowed. The backend's
`services/mcp/print_mcp.rs:231` atomically settles a Pending record, but this is
after the external print side effect. `call_cancel` at line 515 can still turn
the pending request into Withdrawn while layout is running.

**Observed:** the actual callback extracted from `printRequest.ts` was run with
a deferred layout and a recording printer stub. After the initial pending
check, pending was changed to false; releasing layout still called the printer:

```json
{"scenario":"cancel during layout","sent":[{"pendingAtSend":false}]}
```

**Impact:** cancellation/session closure and the final recorded status can
disagree with the print side effect. A concurrent preview in another window is
also not serialized by the backend; duplicate printing is a source-level risk,
not reproduced here. The Zustand `reviewing` flag reduces duplicate review in a
single renderer but is not an atomic backend claim. PDF bytes remain snapshotted;
this does not allow replacing the approved document or printing without a click.

**Proposed correction:** claim Pending atomically before dispatch, with explicit
Preparing/Printing state and defined cancellation semantics. Bind the claim to
the immutable snapshot and approved options. Handle failure/cancel/retry without
leaving a completed side effect recorded as a withdrawn request. Acceptance:
barrier-controlled cancel, close, expiry and two-window approval tests; only the
winner can dispatch. Native print-dialog cancellation needs a user-run check.

### 108 / E1 — a previous conflict's result can be presented as the current one

**Entry and prerequisite:** export conflicts for a path more than once. An older
export has a resolved file and the newest export does not yet have one; press
Load resolved in the current resolver.

**Evidence:** `services/sync_handoff.rs:382–401` searches all `conflicts-*`
directories newest first and returns the first readable resolved file, skipping
newer exports without that result. There is no requested export id or source
fingerprint. The existing passing test
`load_resolved_reads_the_newest_export_that_has_the_file` at line 553 explicitly
expects the old result while the newer export is unresolved.
`src/components/embed/SyncMergeView.tsx:127–134` receives `{id,text}` but discards
the id and displays the generic loaded message. The English title/message at
`src/lib/i18n/en.ts:9150–9152` does not disclose fallback to an older conflict.

**Impact:** a stale result can be mistaken for the latest agent's work and lose
newer changes if accepted. Loading alone does not save or sync: the user must
review and press Resolve. Existing resolver write/push behavior was traced only
far enough to establish this distinction; unrelated resolver races are not
counted as new findings.

**Proposed correction:** bind readback to the selected export and its source
fingerprints. Offer older results explicitly with their export/time and stale
status rather than silently choosing one. Acceptance: create A with a result,
then B with changed sources and no result; loading B must not present A as B's
answer. Also check source changes between export, review and Apply.

### 109 / A1 — privacy activation silently ignores detached-session failures

**Entry and prerequisite:** an unverified cloud agent already runs in detached
tmux, can see the project, and the user enables Local models only. Listing or
killing the relevant tmux session fails. This is a failure-path weakness, not a
claim that the normal activation path leaves every cloud agent running.

**Evidence:** `commands/agent_privacy.rs:43` persists the new policy before
cleanup. `end_detached_agents` at line 116 returns an empty vector when tmux is
unavailable, the listing process cannot start or the listing exits unsuccessfully
(lines 119–125). It also discards kill-command results and returns the intended
`doomed` list without proving termination. `close_unverified_agents` returns
success, and the command reports the enabled policy. A genuine no-server result
and failure to inspect a live server are not distinguished.

**Impact:** the UI can report activation without establishing that the prior
cloud process lost access. It may continue reading and sending project data
after the user believes the restriction applies. The new-spawn gates still hold;
this finding concerns processes that were already running. Confidence is high
in the error propagation, but the operational failure was not injected into the
live app or an actual tmux session.

**Proposed correction:** return structured sweep/termination errors, distinguish
verified absence from failure, verify affected sessions ended, and expose an
incomplete activation state. Keep the restrictive policy for future spawns;
do not silently roll it back on cleanup failure. Acceptance: injected listing,
pane lookup and kill failures must not produce a successful completed activation;
a confirmed empty server must still succeed.

## Other reviewed surfaces and retained limitations

| Package | Evidence read / defended behavior | Remaining limits |
|---|---|---|
| A: privacy and relay | `agent_privacy` gate, stamp check, registry patch, credential scrub; `launch_prep` control env and gate placement; relay route/model policy, reconstructed HTTP requests, size/deadline/concurrency limits, owned-listener check and private sockets. 24 relay and 57 privacy tests pass. | Gap 109. Activation versus in-flight spawn interleavings were not stress-tested. Ollama's complete upstream handling of URL-valued request fields was not audited; do not infer that allowing a local model proves every upstream field is network-inert. Windows has no equivalent filesystem fence; Cut network is Linux-only. |
| B: cockpit | Spawn-bound binding, session check inside workspace update lock, revisioned metadata and current settings switch; result references use registry roots, reject reserved/remote scopes and recheck stored references on click. | Result opening ultimately hands a path to existing viewers, not a held file descriptor; an end-to-end symlink-race proof was not established. Agent-authored verification notes remain claims, not gate evidence. No cockpit tests were counted: the attempted test filter matched zero. |
| B: print | PDF is read via guarded project-file helpers, sniffed and capped at 24 MiB, held as a snapshot; pending/rate caps checked, client-only commands, no print route on the cut-network allowlist. Seven existing tests pass. | Gap 107; expanded PDF rendering cost/page count was not bounded by this review. Native printer behavior is unverified on every platform. |
| C: Claude token | Keyring storage, bounded token shape, no token in status response, local fallback only without shared login/user-selected credentials; local-only injection skipped; remote carrier rather than argv. Nine tests pass. | Remote transfer defaults on, including settings-read failure (`claude_token.rs:188–191`), and the remote host receives the carrier before deciding whether its own login wins. This is an explicit code policy, not remote opt-in. Removing the stored token does not revoke copies in running agents. Setup watcher tab-reuse/race behavior was not live-tested. |
| C: Muse | Held-directory/file helpers, UUID-shaped sessions, workspace matching, 256 KiB metadata head and 64 MiB log bound; transcript records checked against session id. Six tests pass; real-store probe ignored. | The 512-session cap is applied after `HomeDir::names()` has enumerated/sorted directories; empty directory traversal and aggregate listing work are not bounded by that cap. This is an unresolved resource-hardening concern, not a demonstrated stall. |
| C: Tabby pictures | Attachment marks are set in memory before marker-file write; input/file paths lead to marking; new picture paste stays within the assistant's inbox-reference handling. | Persistence errors keep the restriction for this process but may lose it across restart; this marking behavior predates the new picture feature. Native CLI attachment semantics and complete drop/phone ordering were not live-verified. Existing web URL/query leakage residuals remain. |
| D: links/gallery/share | Shared chat URL allowlist accepts only absolute HTTP(S), refuses userinfo and normalizes host; gallery change is frontend filtering, not a new device authorization boundary. Share uses the existing viewer URLs and asks before oversized whole-file reads. | Sender markers are writable by project agents and must not be treated as authenticated authorship. Full route/device-token re-audit and clipboard/drag-out OS integrations were not performed. Share cache identity across scope changes remains an open question. |
| E: forwarding | Registry-derived target, connected gate, validated remote end, constant `127.0.0.1` bind, no-dial ControlMaster argv, cleanup ownership; confirmation in frontend. 18 service tests pass. | A loopback listener is not per-user authentication. App crash cleanup and a hostile replacement listener were not exercised. Commands are off in server mode; Windows explicitly unsupported. |
| E: host TeX | Quoted argv, registry target/root, plain relative path checks, `-no-shell-escape`, `openout_any=p`, local wait ceiling and optional remote timeout. Ten pure script/parser tests pass. | See the changed trust exposure below. No SSH/build process was launched. Hosts without `timeout` lack the script's remote process ceiling; local SSH timeout alone is not proof that the remote process tree ended. |
| E: handoff | Safe relative components, case-collision validation, 8 MiB/file and 64 MiB/export caps, handle-relative writes/readback, reserved-scope refusal; 14 tests pass. | Gap 108. Export ids use a time plus 16-bit suffix and existing directories are reused, so collision/exclusive-create behavior deserves follow-up. No collision exploit was demonstrated. |
| F: TensorBoard | Checked-slice protobuf/TFRecord parser, CRC checks, bounded records/chunks/discovery, finite scalar checks, hidden-pane and connection gating. Twenty parser tests pass. | Gaps 105–106. Discovery and cumulative UI state are different budgets; a bounded parser does not prove a bounded viewer. |
| F: Hugging Face / Piper | HF roots fixed to the registry/search hosts, query encoding/cursor alphabet, model host restriction; HTTPS and timeouts. Piper downloads have pinned hashes checked before unpacking; program/voice paths are app-owned. | `registry_response` buffers the entire body without a byte cap; inherited registry behavior now used for HF search. Redirect destination/proxy behavior and upstream model-runtime parsers were not audited. Existing Piper files are not rehashed on every use. No installer was executed. |
| G: voice/steering | Phone staged choice checks the question signature and `voicePickable` again at commit; review/grant-like choices are refused by voice. Navigation tracks a generation and cleans up on tab change. Keyboard answers are explicit keystrokes and separately guarded against duplicate delivery. | CLI question classification is heuristic. Full event-order testing across popouts, queued attachments and mobile browser speech APIs remains live QA. No claim of a proven focus/permission bypass from this pass. |

### Changed trust exposure: remote TeX is different from local TeX

`commands/tex.rs:1137–1160` runs remote latexmk directly, whereas the local
latexmk branch at line 1304 calls `exec_trust::require(Latexmkrc, ...)`.
`TexView.tsx:740–752` uses plain `invoke` for the host and `invokeTrusted` for
local compilation. The host guard concerns HPC login-node work, not project
Perl config. `commands/tex/host.rs:62–100` supplies TeX's no-shell-escape flag,
but this does not stop latexmk itself from evaluating a project rc file.

This is explicitly acknowledged in the new code comments: host builds run as
the remote login, where project agents already run. It contradicts the old
threat-model row if that row is read as a guarantee for every Compile button.
The row is corrected to distinguish them. A hostile rc file can execute with
the remote account's authority after Compile; no local execution was shown.
Whether remote builds should gain a content-bound trust prompt is a product
decision. It is recorded as changed tier-4 exposure, not silently called a
regression in the local gate or assumed to have prior user approval.

### Cross-feature conclusions

- The local-only stamp is checked before key injection, and Cut network's MCP
  allowlist excludes print, web and git. Those checks were read separately from
  the new MCP handlers; passing the relay tests does not prove upstream Ollama
  request semantics or all activation races.
- Print bytes are immutable, but request lifecycle is not claimed before the
  side effect. Snapshot integrity and authorization lifecycle are distinct.
- Handoff confinement prevents path escape but does not bind the result to the
  current conflict. Containment and provenance are distinct.
- A conversation-specific gallery narrows display; it does not introduce a
  stronger device/project boundary or authenticate the sender marker.
- `command_class`: privacy/cockpit-result/print setters are client-only,
  forwarding is off for server mode; host TeX, handoff export/readback and Claude
  token management are core. Their presence in core is not a full audit of
  server identity and dispatch. Gateway/OIDC/key-broker internals were excluded.

## Verification actually performed

Linux, existing unit tests, no app launch:

| Filter (`cargo test -q -p tabtivity --lib <filter>`) | Passed | Ignored |
|---|---:|---:|
| `services::local_lane::` | 24 | 0 |
| `agent_privacy::tests` | 57 | 0 |
| `print_mcp::tests` | 7 | 0 |
| `services::sync_handoff::tests` | 14 | 0 |
| `muse_session::tests` | 6 | 1 |
| `services::tfevents::tests` | 20 | 0 |
| `services::port_forward::tests` | 18 | 0 |
| `commands::tex::host::tests` | 10 | 0 |
| `claude_token::tests` | 9 | 0 |
| **Total** | **165** | **1** |

Initial filters using re-export rather than nested module names matched zero
privacy/print/Muse tests; they were corrected and rerun as listed. A cockpit
filter also matched zero; it supplies no verification evidence.

Two synthetic Node checks transpiled repository TypeScript using the installed
TypeScript package purely to execute functions; this was not a project type
check. The first invoked actual `emptyFileState`/`applyRead` with JSON-parsed
special keys and three disjoint batches of 2,000 tags. The second extracted the
actual `native` callback from `printRequest.ts`, substituted a deferred
`layoutPrintPdf` and recording `printPdfNative`, and withdrew pending state
before resolving layout. It exercised no actual printer or PDF parser.

Runtime status: Linux source/unit checks only. Linux X11/Wayland UI, Windows,
macOS, real SSH, real Muse store, native printing, microphone, phone and server
deployment were not run live. No backend source was edited, so no backend-stale
check or restart was performed.

The preceding planning task's whole-tree gate run passed brand, whitespace,
lint, three clippy gates, build and selected frontend tests. Rust stopped at the
existing YAML alias timing assertion (6.73 s versus 5 s), leaving the final
daemon tests unrun. That is not a failure introduced by this documentation or
proof that it is flaky. Review-task gate results are recorded in the final
response; do not substitute the focused tests above for a full green gate run.

## Inventory exclusions and remaining assurance work

Commit subjects and changed paths were screened from the baseline. Pure chrome,
labels/layout, root-console view rearrangement, tablet layout, performance-only
resource-display work, version bumps and gate-progress scripts were excluded
unless they affected a boundary above. Previously fixed gaps 74–104 were used
as context, not re-audited end to end. The lockfile delta contains rusqlite
0.40.2 → 0.41.1 and libsqlite3-sys 0.38.2 → 0.39.1; npm lock changes only the app
version. No current advisory lookup or independent dependency audit was done.

This pass provides detailed findings and targeted coverage across A–G, with the
limits in the table. It does **not** satisfy an exhaustive all-path or
all-platform assurance claim: full clipboard/drag-out integration, server
dispatch identity, popout event ordering, upstream model URL semantics and
activation/spawn concurrency remain unresolved. No undocumented defense marker
should be inferred for those paths. Follow-up work should address those named
questions rather than repeat the already reproduced findings.

## Proposed remediation order — not implemented

1. Close privacy activation's incomplete-cleanup success path (109); retain the
   restrictive policy and report incomplete enforcement rather than silently
   weakening it.
2. Add cumulative TensorBoard budgets and safe key storage (106, 105), with
   fixtures exercising successive reads, not just individual scans.
3. Add an atomic print claim and explicit cancellation semantics (107).
4. Bind handoff readback to an export/source version and expose staleness (108).
5. Decide whether remote TeX requires a trust prompt and whether remote Claude
   token sharing should remain default-on. Neither decision is changed here.

Each fix needs a regression that fails on this endpoint, updated threat-model
status, applicable gates and separate user-run live checks. Existing tests
passing while these cases remain is a coverage result, not evidence against the
findings.

---

# Second pass — review of the pass above, and its extension (2026-11-12)

Same endpoint (`214933ab5`, `develop`) and the same rules: source review, no
app launch, nothing live. This pass (a) re-derived gaps 105–109 from the code,
(b) checked the pass above against its own plan, and (c) read the surfaces it
left without a disposition. The worktree had moved meanwhile (a same-day
simplify pass touched `commands/agent_privacy.rs`, `TensorBoardView.tsx`,
`SyncMergeView.tsx`, `sync_handoff.rs` and others); those edits are
behaviour-neutral for every finding here and were read as they stand.
**The 165 tests listed above were not re-run by this pass.**

## A. Verdict on gaps 105–109

All five hold as written. Additions that change what a fix has to cover:

| Gap | Verdict | What the first write-up left out |
|---|---|---|
| 105 | Confirmed by reading `applyRead` and `mergeSeries`. | The throw happens before `setLoaded(true)`, so the view also never leaves its loading state, and each Live tick repeats it. `series[kind]` (plugin kinds) has the same inherited-property read. |
| 106 | Confirmed. | "Medium" is generous beside the model's other viewer resource rows (a hostile file the user opens, own renderer only); it sits with 105 as one fix. The budget must be per view, not per file: `allTags` unions every file's tags, and a run folder can hold many files. |
| 107 | Confirmed (`print.ts` `onPrint` → `native` → `printRequest.ts`). | The same window is open to **expiry** (`prune`, `RETENTION`) and to the **tab-exit sweep** (`terminal/mod.rs`, `print_mcp::sweep`), not only `print_cancel`. `decide` already compare-and-sets Pending; what is missing is a claim *before* the side effect. |
| 108 | Confirmed (`load_resolved_in`). | See 108b below: the readback is not only stale-prone, its "newest" is a name sort over folders the project's agents can create. |
| 109 | Confirmed (`end_detached_agents`, `close_unverified_agents`). | `tmux ls` exits non-zero when **no server runs**, which is the normal empty case; a fix must tell that apart (tmux's "no server running" / missing socket) from a listing that failed, or it turns every activation on a machine without sessions into an error. The PTY half also discards the `kill-session` result for held sessions. |

### 108b — any agent of the project chooses what "Load resolved" shows

`load_resolved_in` filters on `starts_with("conflicts-")` and sorts by name; it
does not apply `is_export_id` (which `export_dir_in` does) and takes no export
id from the caller. The hand-over folder is inside the scope's agent home, so
every agent tab of the project — not only the one the conflict was handed to —
can create `handoff/conflicts-<any high-sorting name>/resolved/<rel>`. That
folder is then "the newest export" for every later Load resolved of that path,
and `prune` (oldest first by the same sort) never removes it. Same severity as
108 (the text lands in the Result column; saving still needs Resolve), same
fix: the window passes the id of the export it made, the backend checks it with
`is_export_id` and reads only that folder. Not reproduced; read from source.

## B. New findings

### 110 / A2 — a spawn in flight when the switch turns on escapes the sweep (Low)

**Entry and prerequisite:** Local models only is switched on for a project
while a cloud agent that can see its folder is between its last privacy check
and its registration — a tab the user just opened, one the phone started, a
scheduled start, a restore.

**Evidence:** the spawn reads the policy twice: `agent_privacy::gate`
(`launch_prep.rs`, "Local models only" block) and `fence_gate` inside
`wrap_pty_options_bwrap` / `_sandbox_exec` (`agent_fence.rs`). Nothing reads it
after that. The PTY enters the registry in `terminal::spawn_pty` → `launch`,
and its fence view is attached to the live spawn only then
(`note_live_fence_view`). `set_project_agent_privacy` persists the policy and
then takes **one** snapshot (`registry.ai_ids()`, `live_fence_views()`,
`live_tmux_tabs()`, one `tmux ls`). A spawn past `fence_gate` but not yet in
that snapshot is neither refused nor ended; it is unstamped, unverified, has
its API keys, and keeps running in a project that now reports the switch on.
The headless path (`mobile_control/host.rs`, `prepare` then a detached tmux
session) has the same shape.

**Impact:** as 109 — a cloud agent keeps reading a folder the UI says is
local-only — but on the success path, with no failure needed. The window is
the tail of `prepare` plus the spawn (tmux wrap, hooks, home preparation), so
it needs a coincidence; hence Low. Not reproduced: no barrier test exists.

**Proposed correction:** re-check once the spawn is registered: if the agent is
subject to a locked project (`subjects` over `locked_now()`) and is not that
project's verified tab, end it with its subtree and fail the spawn with the
gate's refusal. With the sweep running after the policy is persisted, every
interleaving is then caught by one side or the other. Acceptance: a barrier
test that persists the policy between `fence_gate` and registration and finds
no surviving PTY or tmux session.

### Hardening (no gap number)

| # | Where | What |
|---|---|---|
| H1 | `commands/ollama.rs` `registry_response` | Reads the whole body (`response.bytes()`) with only a time limit. Now also used for the Hugging Face search. Cap it (stream, refuse past a fixed size); manifests and search pages are small. Carried from the first pass's table, where it had no action. |
| H2 | `services/mcp/git_push_mcp.rs` (pre-push hook env) | The scrub list names six lane tokens and omits the cockpit and web lanes'. The hook command is built from the app's own environment, which normally holds none of them, so this is defence in depth only — but three hand-kept token lists (`terminal/mod.rs` exit path, `SpawnTokenGuard`, this one) is how a lane gets forgotten. One table in `root_mcp`. |
| H3 | `services/sync_handoff.rs` `export_in` | `root.subdir(&id)` reuses an existing folder; the id is a second-resolution stamp plus 16 bits. Create the export folder exclusively and retry with a new suffix on collision, so an export never writes into a folder an agent (or an earlier export) already filled. |
| H4 | `services/agent/muse_session.rs` | `HomeDir::names()` lists and sorts every entry before the 512-session cap applies. Bound the enumeration itself. Carried from the first pass. |

## C. The first pass against its own plan

1. **Inventory gaps.** Step 1 asked for every material change to be assigned
   or excluded with a reason. These features in `b3abe5ba..214933ab5` got
   neither: the send skill written into agent homes; Python go-to-definition
   into `site-packages`; the Reader's Sign in button; the discovered Codex
   model list; file drag-out and Copy-as-files; the markup lane served by the
   Mobile host (#2339 phase 1b); pasted files in a typed answer; the diff
   viewer's new parser; print imposition (n-up, booklet); "close the non-agent
   paths to a cloud model". Section D gives the first five a disposition and
   names the rest as still open.
2. **Missing deliverables.** No coverage matrix (Step 1.5), no runtime matrix
   (Step 3), no `todo/` items (Step 5.4). The todo items are added by this
   pass (`todo/group-o-security.md`, "Threat-model recheck follow-ups
   (2026-11-12)"). The two matrices are still not written; section E is the
   honest substitute.
3. **Cockpit has no test evidence.** The filter matched zero tests and was
   not corrected, so package B's cockpit half rests on reading alone.
4. **Activation races were deferred as "not stress-tested".** Reading the
   spawn order was enough to find 110; no stress test was needed.
5. Findings, evidence labels and the refusal to call anything "secure" are
   sound. No finding was overstated; 106's severity is the only rating this
   pass would have set one step lower.

## D. Surfaces the first pass left open, read by this pass

| Surface | Read | Disposition |
|---|---|---|
| Send skill in agent homes (`agent_hint.rs`) | Static text, written through `HomeFile` (a linked config dir is skipped), rewritten at every spawn so an agent's edit does not persist, placed after the `agent_global` layer, not in the assistant's or the probe's home, no `allowed-tools` grant. | Defended (source). |
| Python go-to-definition (`pythonLinks.ts`, `python.ts`, `pythonRun.ts`) | Library roots come from the backend's interpreter choice and directory listings; the interpreter is never run; candidate files are read with `readFileText(path, projectId)`, so an environment outside the project is simply not readable; off for remote projects. | Defended (source). The link opens a viewer, never a program. |
| Reader "Sign in" button | Shown when the last answer's text matches an expired-login phrase, so an agent's own words can make it appear. A click types the CLI's fixed sign-in command or opens its sign-in tab; no text from the answer is sent. Not in Tabby, subagents or browsed chats. | Accepted: a spoofed button only starts the real sign-in. |
| Discovered Codex models (`agent_defaults.rs`) | Guarded, 8 MiB-capped read of `.codex/models_cache.json` per agent home; slugs ≤ 256 chars, no leading `-`, no control characters, ≤ 256 entries; the newest cache wins. | Defended as an argv source. Residual: any scope's Codex home can supply the list the Settings dropdown offers everywhere (names only; the user picks). |
| Drag-out and Copy-as-files (`commands/clipboard.rs`, `fileTreeDrag.ts`) | Client-class commands; absolute, existing paths, ≤ 1000; a host (SFTP) listing never exports. Paths are the renderer's, like every client command. | By design under "the main window's IPC reaches the whole backend". OS-side behaviour (what a drop target does with the URI list) is not something this review can see. |

## E. Still open after both passes

Named so nobody reads silence as coverage:

- The markup lane in the Mobile host (admin-socket peer, undelivered-answer
  receipts): design and function list read, authorization not traced.
- Pasted files/images in a typed answer; the diff parser; print imposition's
  page-count and render cost; the non-agent cloud-model paths
  (`copilot.rs`, `terminal.rs`, `root_mcp.rs` in `53eb50905`).
- Server dispatch identity for the new `core` commands (host TeX, hand-over,
  Claude token); popout event ordering; Ollama's handling of URL-valued
  request fields behind the relay.
- Runtime matrix: everything is Linux source/unit level. Windows, macOS,
  phone and server were not run.
- The two product decisions from the first pass stand unanswered: a trust
  prompt for remote `latexmkrc`, and remote Claude-token transfer default-on.

## F. Remediation packaging

Three disjoint packages, so they can be built side by side in one checkout:

1. **Privacy** — 109, 110. `commands/agent_privacy.rs`,
   `services/agent/agent_privacy.rs`, the spawn path, the headless spawn, the
   privacy dialog's result.
2. **Viewer and print** — 105, 106, 107. `lib/viewers/tensorboard.ts`,
   `TensorBoardView.tsx`; `services/mcp/print_mcp.rs`, `commands/print_mcp.rs`,
   `printRequest.ts`, `print.ts`.
3. **Hand-over and hardening** — 108 (+108b), H1–H4.
   `services/sync_handoff.rs`, `commands/sync_handoff.rs`, `SyncMergeView.tsx`;
   `commands/ollama.rs`; `git_push_mcp.rs` / `root_mcp.rs`; `muse_session.rs`.

Each fix carries a regression that fails at `214933ab5`. Status of the fixes
is recorded in `docs/threat_model.md`, not here.

## G. Findings from the two follow-up reviewers

Two read-only reviewers took section E's list. Their findings are recorded
here as they come in; code references were re-checked against the tree
before a gap number was given.

### Viewers, print, server dispatch, forwarding, relay

**111 / V1 — a quadratic regex in the diff parser freezes the window (Medium,
reproduced).** Open a `.diff`/`.patch` file from a repository. In
`src/lib/viewers/diff.ts`, `parseUnifiedDiff` hands every line that does not
start with `+`, `-`, space or `\` to `parseMeta`, which tries
`/^Binary files (.+) and (.+) differ$/`. A line
`"Binary files " + "a and ".repeat(k) + "x"` (no trailing ` differ`)
backtracks quadratically, and no line-length cap applies before parsing
(`DIFF_MAX_LINE_CHARS` only shortens what is drawn). Measured on the real
parser, transpiled unchanged: 24 KB 86 ms, 48 KB 338 ms, 96 KB 1.24 s,
200 KB 5.3 s; the viewer reads text up to 8 MiB, which extrapolates to hours.
The renderer's one thread hangs, so every terminal view and dialog of the
window freezes until the app is killed. Nothing runs and nothing leaves. The
Reader's Diffs view caps a change at 200,000 characters (`agent_changes.rs`),
about 5 s at worst. **Correction:** a linear parse (`startsWith` / `endsWith`,
split on the first ` and `) and no `parseMeta` for very long lines.
Acceptance: `"Binary files " + "a and ".repeat(50000) + "x"` parses in under
50 ms and the existing binary-file cases still parse.

**112 / V2 — the diff viewer's file list is not capped (Low, source-traced).**
`capDiffFiles` (`diffBudget.ts`) returns early when the total line count is
within budget, and a file without hunks counts zero lines, so a patch of
only `diff --git` headers keeps every file; the file index
(`DiffView.tsx`, `full.map`) and the headers (`shown.map`) draw one row each,
uncapped, also when the line cap is active. An 8 MiB patch holds on the order
of 10⁵ files: a long freeze or a renderer out of memory. The parse itself is
fast (300k empty files in 190 ms). **Correction:** cap or virtualise the file
rows and the index, and count a file header against the budget.

**113 / V3 — no ceiling on what an agent's print request costs to preview
and lay out (Low; pdf-lib cost measured, pdf.js cost inferred).** Within the
24 MiB cap an agent chooses the PDF and up to 99 copies. Review renders every
page to a PNG data URL held in memory (`printRequest.ts`,
`renderPdfPagesToImages`; `rasterScaleFor` caps pixels per page, not pages).
Approve runs `layoutPrintPdf` (`pdfPrintLayout.ts`) over `copies × sheets`
with no bound. A re-implementation of that loop with pdf-lib took 1.3 s for
4,000 output pages, 9.7 s for 16,000, and did not finish 198,000 in 120 s; a
408 KB PDF with one 400 MB flate stream took 12 s and 925 MB. Impact is a hung
or crashed renderer; the bytes sent to the printer are re-built by pdf-lib, so
no active content of the original reaches it. Reject works without opening
the review. **Correction:** refuse a snapshot above a page limit or a flate
expansion bound when the request is made, and bound `copies × sheets` before
layout.

**Hardening.** H5: `sync_handoff_load_resolved` and `sync_handoff_reveal` do
not require a remote project as the export does, and `project_key` folds any
string, so a scope id such as the Host session's reaches that home's
hand-over folder (read of `resolved/<rel>` text only). H6: the Cut-network
relay lets `/api/show` through, whose Modelfile names the host's absolute
blob path.

**Read and found defended** (reviewer's table, condensed): the 20 commands
added since `b3abe5ba` all carry a class, `cfg_attr(feature = "desktop", …)`
and an async or `*_blocking` body, and every new path argument has a
`USER_CONFINED` row; `compile_tex_host` (record-derived host and root,
confined `.tex` path, allow-listed engine, quoted argv); the Claude token
commands (shape check, never returned, not injected for admin keys, locked
projects, local-model tabs or containers); `tfevents_read`/`_discover`
(confined opens, bounded no-follow walk); the Hugging Face search (fixed
host, encoded query, allow-listed cursor and sort); cockpit result opening
(index and revision from the window, never a path); the diff views apart from
111–112 (React text nodes only, no `innerHTML`, `Map`/`Set` keyed, bounded
word marks); print options and the native hand-off apart from 113 and 107
(clamped enums, digits-only range, private spool file, no argv or shell);
port forwarding (off in server mode, `-L` on `127.0.0.1` only, never dials,
http/https only, owner-scoped cleanup); the Cut-network relay (15 exact
routes, no pull/push/create/copy/delete/blobs, request rebuilt, duplicate or
case-variant `model` keys refused); keyboard steering's answer path (explicit
digit on the active tab, held-key and in-flight guards, cross-window messages
carry navigation only).

**Unresolved, with the evidence that would settle each:**

1. A forwarded remote page runs at `http://127.0.0.1:<port>`, next to the
   user's other loopback services; cookies are shared across ports and a
   local Ollama's default CORS may accept that origin. Needs a browser
   request from a page on a forwarded port to the local Ollama API.
2. Whether the pinned Ollama accepts URL-valued image fields on the
   `/v1/*` routes the relay allows. Needs
   `src-tauri/examples/local_lane_harness.rs` with a canary listener.
3. pdf.js worker memory on a flate-bomb page (113's pre-approval half).
4. Whether agent output can make `readReaderLive` read a look-alike dialog
   as a question; the worst case seen is one digit typed into that agent's
   own session.

### Markup lane in the Mobile host, cockpit, pasted answers, non-agent cloud paths

**114 / P1 — pasted text that contains a `file://` address copies that file
into the agent's inbox (Low; scan reproduced, backend read from source).**
Since `de5ce4f23` the Reader's composer and the typed-answer field route a
paste through `pasteIntoAgentBox` (`src/lib/terminal/terminalDrop.ts`), which
calls `parseDroppedFiles`. That scanner (`src/lib/files/droppedFiles.ts`)
was written for drops and looks for `file://…` in `text/uri-list`,
**`text/plain` and `text/html`**. A hit cancels the text paste and calls
`pty_drop_files` (`commands/terminal.rs`), which accepts any absolute path
with no size or origin check and stores a copy in the tab's inbox, inside the
agent's fence. So text the user copied from a web page, a README, a mail or an
agent's answer — `see file:///…/.ssh/id_ed25519`, or a link whose `href` is a
`file://` address — becomes a copy of that file, including files the fence
otherwise hides (the state directory, credentials). Before the commit the
composer left any paste with `text/plain` alone. The only sign is an `@`
reference in the draft where the pasted words should be; the copy stays if the
reference is deleted, and a cloud agent reads it once the draft is sent. The
Local-models-only refusal (`agent_privacy::drop_refused`) only covers paths
inside a locked project. Run against the real scanner, transpiled unchanged: a
plain-text sentence with a `file:///tmp/../home/…` address returns the
normalised path with `size: null`; so does a "click here" whose HTML carries
the address. **Correction:** on paste, take files only from
`clipboardData.files` or a `text/uri-list` type, never from `text/plain` or
`text/html`; and have `drop_files` refuse, for an agent tab, a canonical path
under the state directory (`agent_fence::private_state_paths`) or a credential
directory. Acceptance: a paste carrying only `text/plain`
`file:///etc/hostname` calls neither `preventDefault` nor `pty_drop_files`; an
agent-tab drop of a path under a temporary state directory, or of a link into
it, is refused.

**Known residuals the reviewer met again (not new):** `complete_text` judges
Local models only by the window's `project_id`, so a locked project nested
under an unlocked one is completed under the parent's id
(`docs/local_models_only_handoff.md` already says so; `copilot_complete`
checks the document path with `inside_locked`). Switching Local models only on
does not stop a parent project's Copilot language server; whether it reuses
documents it was sent earlier is not known.

**Read and found defended** (condensed): the admin socket (0600, peer uid
checked, hidden from every fence; the Windows pipe branch was not read); the
markup lane's ask, answer, reopen and dismiss (project and target come from
the token's identity, never an argument; 64-bit ids and receipts; the
undelivered queue is capped, in memory, keyed by peer, project, target and
ask); headless token lifetime (three missed looks per generation, in-process
only); the headless listener (same handler and checks, no root route); the
phone's markup routes; cockpit self-only binding, revision compare-and-swap,
rate limit, result opening and note rendering (React text only, control and
bidi characters stripped); the assistant's attachment marking; the phone's
answer attachments; Copilot and the root MCP tools under Local models only.
**Cockpit now has test evidence:** `cargo test -q -p tabtivity --lib cockpit`
83 passed, `… --lib markup` 123 passed.

**Unresolved:** a window-side timeout can send a reopen that the host handles
before the answer it belongs to, losing the user's answer (not a security
issue; needs the handler ordering in `admin::serve`); the Copilot question
above; the Windows admin pipe; phone steering and its K/L queue keys were not
traced.

## H. Fix status (2026-11-12, uncommitted, nothing run live)

Three implementers built section F's packages side by side in the shared
checkout. Each ran its own focused tests; the whole-tree gate result is in
the session's final report, not here.

| Item | Status | Where | What a live check still owes |
|---|---|---|---|
| 105, 106 | Fixed | `lib/viewers/tensorboard.ts`, `TensorBoardView.tsx` | Open a file with a `__proto__` tag and one past 2,000 tags. |
| 107 | Fixed | `services/mcp/print_mcp.rs`, `commands/print_mcp.rs`, `lib/viewers/print.ts`, `printRequest.ts`, `lib/window/printMcp.ts` | Cancel the system print dialog (request pending again); a real print per platform. |
| 108, 108b, H3 | Fixed | `services/sync_handoff.rs`, `commands/sync_handoff.rs`, `services/home_io.rs`, `SyncMergeView.tsx`, `SyncHandoffButton.tsx` | Export twice, Load resolved with no result, the older offer, the stale warning. |
| 109 | Fixed | `commands/agent_privacy.rs`, `services/agent/agent_privacy.rs`, `AgentPrivacyDialog.tsx` | Switch on with a detached cloud agent; with no tmux server at all. |
| 110 | Fixed | `services/launch_prep.rs`, `commands/terminal.rs`, `services/mobile_control/host.rs` | None practical: the interleaving is tested through the pure decision. |
| H1 | Fixed | `commands/ollama.rs` (2 MiB default), `ollama/hf.rs` (8 MiB for the search) | — |
| H2 | Fixed | `services/root_mcp.rs` `LANE_TOKEN_ENVS`, `git_push_mcp.rs` | `terminal/mod.rs`'s exit path still lists the tokens by hand. |
| H4 | Fixed | `services/agent/muse_session.rs` | — |
| 111–114, H5, H6 | **Open** | — | Found after the packages were handed out. |

Corrections the implementers made to this document's account: the window for
110 runs until `prepared.commit()`, where the fence view and session the
sweep reads are recorded, not only until `spawn_pty`; `SpawnTokenGuard`
already covered every lane (its gap was revoking the root *or* the schedule
token, not both); the TensorBoard backend caps tags per kind but not the
number of kinds, and `TensorBoardView.tsx` had two more name-indexed lookups
(`KIND_KEYS`, the per-group pages).
