# Tab messaging MCP — handoff

Plan: `docs/tab_messaging_mcp_plan.md`. Branch based on `develop` (fe629c117).

## I1 backend lane (plan steps 1–5)

### Commits

- `705bd6468` docs(tabs-mcp): plan — the plan, copied in.
- `899352954` feat(tabs-mcp): service core, lane wiring and token carriers —
  steps 1–3 (+ `agent_turn::note_mail`, the marker writer, needed by the
  service): `services/mcp/tabs_mcp.rs` (+ `tabs_mcp/tests.rs`), `Caller::Tabs`,
  `/mcp/tabs`, `grant_tabs`, `Settings::tabs_mcp`, secret slots, PTY exit.
- `c9f32fa57` feat(tabs-mcp): purge on a privacy flip; the cut relay refuses
  /mcp/tabs — step 4.
- `2c7ebbcf6` feat(tabs-mcp): hook notice and the generic client lane —
  step 5: hook twins, `tabtivity-mcp.{sh,ps1}`, `tools_hint!`.
- this commit: the handoff.

### Deviations from the plan

1. **Reply shapes carry `status`.** `tabs_list` answers
   `{status:"ok", self:{handle,label}, tabs:[{handle,label,cli}]}` and
   `tabs_inbox` answers `{status:"ok", notice, messages:[…], unread:<total>}`
   instead of a bare array: MCP `structuredContent` must be an object, and
   every lane tells refusals by `status`. `notice` is the fixed "written by
   other agent tabs, not by the user" line; `unread` is the total still
   unread (the page holds at most 10).
2. **Acked messages are kept, marked read**, until their 24 h life ends, so
   the window can show them (decision 12, "the user reads everything"). They
   make room first when the 200-per-scope or 2,000-per-process cap is hit; a
   store full of unread answers `inbox_full`.
3. **PTY exit** removes the tab from the listing (`sweep`) but keeps its
   unread for a respawn of the same saved tab (decision 10); what is never
   picked up expires at 24 h. A send to a tab whose spawn is gone answers
   `not_found`.
4. **Grant also requires a registered project entry** (`trusted.entry`) and
   refuses a `box:` scope explicitly; project lanes alone let a box tab
   through to print/markup.
5. **Cut detection at grant**: the gate's record for the tab
   (`agent_privacy::verified_launch(tab).cut`) *or* the project's setting now
   (`local_models_only && cut_network`) — either refuses.
6. **Purge on flip** compares the setting read before `agent_privacy::set`
   with the stored one; an unreadable "before" purges too.
7. Malformed `to` / `replyTo` / `ack` ids answer `invalid` (not
   `not_found`); the three not-found cases (unknown, other project, other
   class — and another state dir) are byte-identical.
8. `RollingWindow::retry_after` added in `root_mcp_security.rs` for
   `retryAfterSecs`.

### Step 2 check (`local_model` / stamp final at `grant_lanes`)

Confirmed final. In `launch_prep::prepare` the gate
(`agent_privacy::gate`, ~line 992) runs before `grant_lanes` (~1110); it is
the only writer of `STAMP_ENV` (a control variable, stripped from renderer
input before the gate) and sets `opts.local_model = true` for a verified
launch. Between `grant_lanes` and the home choice
(`prepare_agent_home(.., opts.local_model)`, ~1485/1535) nothing writes
`local_model` (`agent_defaults::apply` touches args/env only; the only other
writers are tests, the assistant arm before the gate, and `credentials.rs`
test tables). So the class is decided in `grant_lanes`; no late stamping
like `stamp_push_fence_scope` was needed.

### API for I2 (`crate::services::tabs_mcp`)

```rust
pub const SERVER_NAME: &str;            // "<slug>-tabs"
pub const CHANGED_EVENT: &str = "tabs-mcp-changed";
pub const NOTICE: &str;                 // the one sentence a prompt may carry
pub fn set_change_hook(hook: Box<dyn Fn() + Send + Sync>); // once per process
pub fn traffic(scope: &str, tab: Option<&str>) -> Vec<MessageView>; // this process's state dir, oldest first
pub fn traffic_in(state: &Path, scope: &str, tab: Option<&str>) -> Vec<MessageView>;
pub fn unread_count(scope: &str, tab: &str) -> usize;
pub fn purge_scope(scope: &str) -> usize;          // for tabs_mcp_clear too
pub fn wake_claim(scope: &str, tab: &str) -> bool; // step 7: one per unread batch, 6/h per tab
pub fn wake_claim_in(state: &Path, scope: &str, tab: &str, now: Instant) -> bool;
pub fn enabled_in(settings: &Path) -> bool;        // Settings::tabs_mcp, absent = on
pub fn sweep() -> bool;
```

`tab` everywhere is the **saved workspace tab id** (`workspace::tab_id`,
the `TAB_ID_KEY` extra of a `TabEntry`), not the PTY id or handle.

`MessageView` (serde camelCase):

```json
{"id":"m_0123456789abcdef","fromTab":"<saved tab id>","toTab":"<saved tab id>",
 "sentAt":"2026-11-14T10:00:00Z","replyTo":"m_…" /* omitted when none */,
 "text":"…","read":false}
```

- Event: `tabs-mcp-changed` (no payload), rung by the hook on send, ack,
  purge, sweep and expiry. Install it in `commands::root_mcp::serve_everything`
  (`#[cfg(feature = "desktop")]`, as print's `install_change_hook`).
- Settings key: `tabs_mcp` (`Option<bool>`, absent = on;
  `Settings::tabs_mcp()`).
- `wake_claim` does not read the per-project opt-in: the command does, then
  claims; it queues `NOTICE` and nothing else.
- Deliver: the window queues `NOTICE` via `queuePromptForTab`; gate the button
  on `unread_count > 0`.

Agent-facing tool shapes (for docs): `tabs_list {}`;
`tabs_send {to, text, replyTo?}` → `{status:"queued", id}`;
`tabs_inbox {ack?}` → see deviation 1. Refusals
`{status:"refused", category, message}` with `invalid`, `too_large`,
`not_found`, `self`, `inbox_full`, `budget` (+ `retryAfterSecs`), `off`,
`unavailable`.

Wiring facts for the docs: env pair `<APP>_TABS_MCP_URL` / `_TOKEN`
(`root_mcp::TABS_URL_ENV`, `TABS_TOKEN_ENV`), route `POST /mcp/tabs`,
`Caller::Tabs` (lane 8), tmux secret slot 8643, `<slug>-mcp` lane name `tabs`,
hook marker `<live_dir>/<uid>.mail` (`agent_turn::MAIL_SUFFIX`,
`agent_turn::note_mail`), Claude hook twins print `NOTICE` on the next
non-`/clear|/new|/resume` `UserPromptSubmit`.

### Gotchas

- State is in the window process only (`Runtime::serves_tabs`). A Mobile-host
  or headless tab holds no token; the command layer must not try to read the
  Mobile host's store (there is none).
- Handles depend on a per-process key: they change across app restarts; the
  window should never show or store them (it uses saved tab ids).
- A message's sender may be closed; `fromTab` still names its saved tab id.
- The class filter is on read: a tab respawned under another class (cloud ↔
  local home) does not see messages sent under the old one.

### Gate results

`scripts/gates-job.sh start --fresh` on the full I1 diff (before the step
commits, same content): brand PASS, `git diff --check` PASS, clippy (all
targets) PASS, clippy-dlib PASS, clippy-dmn PASS, `cargo test -p tabtivity
-p app-serverd` PASS (≈5,720 tests), test-dlib (`--no-default-features --lib
--test server_secrets`) PASS. Frontend gates not selected (no frontend
change). New tests: 22 in `tabs_mcp/tests.rs`, `tabs_lane_grant_matrix` and
`tabs_tools_are_served_to_the_tabs_identity_alone` (root_mcp),
`tabs_route_is_an_exclusive_lane` (commands::root_mcp),
`mail_notice_rides_the_next_prompt_once_and_spends_the_marker` and
`both_hook_twins_carry_the_mail_block` (agent_session),
`mail_marker_lands_empty_…` (agent_turn); extended: tmux secret slots,
local_lane refusals, `powershell_mcp_twin_matches_the_sh_messages`.

The first full run failed 13 tests in `markup_rounds`,
`mobile_control::host` and `chat_uncommitted` (git/catalog timing under
load; no code path of this lane). They passed alone (144/144) and in the
fresh full run. `tabs_mcp` tests take a module lock: the store and budgets
are process-wide and two tests move the clock an hour or a day on.

Not run: `npm run backend:stale` (main checkout, per the brief); nothing
was run live.

### Flagged for user

- **Grant matrix rows not exercised directly:** remote, worker and
  `local_only`-of-remote tabs. They fall to `grant_lanes`' shared
  `project_lanes` / `Trusted::off_host` predicate (as print and markup); the
  matrix covers container and VM projects and container tabs.
- **Hook hint is Claude-only** (as planned): other CLIs learn of mail only by
  the Deliver button or the wake. The PowerShell twin is checked at string
  level only (it compiles on Windows alone).
- **`unread_count` / `traffic` read this process's `state_dir()`**: correct
  for the window; a server daemon never grants the lane.
- **A whole-registry parse failure reads as `Unreadable`**: one malformed
  `projects.json` entry makes every call `unavailable` (fail closed, as the
  plan asks), not just the locked check.
- **Purge scope:** `purge_scope(scope)` empties that scope in every state dir
  the process holds (one in practice).
