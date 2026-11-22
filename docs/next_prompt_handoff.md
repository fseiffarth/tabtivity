# Local-model "what's next" — handoff

Plan: `docs/next_prompt_plan.md` (Fixed decisions, Contract, Organisation).
Each agent appends its own section: commit shas, choices made, gotchas,
gate status with test counts, and **Flagged for user**.

## A backend

Commits (branch `worktree-agent-a2c621b6481a3e81b`, on develop 82047262e):
`b248940cd` (step 1, the shared gate) · `a8e215ed9` (step 2, the engine + tests)
· `cb06d7ac6` (step 3: the command, the `command_class` row, the regenerated
`commandClasses.ts`, the phone route + its test) · then this handoff.

**Choices**
- Shared gate `services::ollama_local` (`loopback_endpoint`, `preflight`,
  `embedding_only`, `LocalRefusal`); `mail_ai` maps each refusal to its own
  wording, `mail_ai::resolve_endpoint` stays (agent_privacy, root_mcp_mail call it).
- `services::agent::next_prompt` (also `services::next_prompt`). Turn = from the
  last `prompt` entry (or `cutPrompt`). `final` runs only when the last entry is
  an `answer` that is not `blocking`/`asking`, else `skipped`.
- Entries carry no id, so **`turnKey` is an opaque 32-hex fingerprint** (turn
  prompt + last entry: kind/text/at/role), stable within one process. Compare
  for equality only.
- Rendering: answers in full (≤4000 chars) while the budget lasts, one line past
  it; `agent` (subagent) and `interrupted` entries are always one line (the
  transcript has no tool entries; subagent cards are the tool-like ones). A
  per-session `TurnPrompt` keeps the rendered text and resumes after the last
  entry's fingerprint (works when the read window slid), restarting on a new
  turn. `final` appends the last answer in full only when it went one-line.
- Budget 6000 tokens (chars/4), lowered to `ollama_context_length − 1000`
  (min 1000) when that is set smaller. No `num_ctx` sent (it would reload the model).
- Body: `stream:false`, `keep_alive:"30m"`, temperature 0.2, `num_predict` 1
  (warm) / 48 (final), `think:false` only when `/api/show` lists `thinking`.
  Timeouts: final 60 s, warm 120 s.
- Single flight: one mutex per session, held over the Ollama request. `final`
  waits, then reads the cache. `warm` uses try-lock and answers `busy`, and also
  answers `busy` within 2 s of the session's last warm (a backend rate limit,
  which covers the phone too).
- Statuses: AI switch off → `unavailable`. Transcript unavailable → `unavailable`
  (final) / `skipped` (warm). An unknown `phase` on the command → `unavailable`.
  An Ollama failure other than `not_running` → `unavailable`. Endpoint/model
  refusals → `refused` + `reason`. `not_running` has no reason.
- Command `agent_next_prompt` calls `agent_tab_transcript` itself (limit 400, no
  watch), so `remoteHost` and local-model OpenCode reads match the Chat view.
  **One extra optional arg `since?: number`** (a fresh tab's launch moment, as
  `agent_tab_transcript` takes it), passed through to the transcript read. This
  matches the main agent's contract addendum; leaving it out works too.
  Class `client`, as instructed.
- Phone route: `phase` defaults to `final`. An unknown query param → 400, a bad
  phase → 400 `invalid_phase`, a window `tab_not_found` → 404, any other window
  error → 200 `unavailable`. With no window, the turn comes from
  `headless::transcript`. The Ollama run happens in the sidecar process.

**Gotchas**
- In tests `ollama_client::locality_at` reads the thread-local `test_tags`
  (unset = not_running), so no test reaches a real Ollama. Capabilities and chat
  go through the `next_prompt::Ollama` seam.
- `suggest_with` checks the transcript and turn before the AI switch and the
  settings, so a "nothing to do" answer does not depend on the developer's
  settings.json. The route test relies on that.

**Gates** `scripts/gates-job.sh start` over the whole diff: 10/10 PASS (brand,
whitespace, lint-fe, the three clippy runs, build, vitest `--changed`, `cargo
test -p tabtivity -p app-serverd`, the no-default-features lib +
`server_secrets`). Focused run of the touched modules (`next_prompt`,
`ollama_local`, `mail_ai`, `command_class`, `mobile_control::host`): 187 passed,
0 failed. New tests: 12 in `next_prompt/tests.rs`, 3 in `ollama_local`, 1 route
test (`the_next_prompt_route_answers_text_and_status_only`). `npm run
backend:stale` not run: the app was not touched, and backend changes reach the
user through a commit.

**Flagged for user**
1. **Two runs per turn are possible.** The cache is per process. The window
   (desktop command) and the phone sidecar (`/next-prompt`) are separate
   processes, so a turn both of them ask about runs once in each. A shared run
   would mean routing the phone through the desktop bridge (a new
   `DesktopRequest` plus a handler in `MobileBridgeHost.tsx`), which is outside
   A's files. The sidecar now talks to Ollama itself. That breaks the "the
   sidecar never talks to Ollama" pattern of `mobile_control::local_models`,
   but the plan's headless clause asks for it.
2. **`client` class**: with this class a server daemon never exposes the
   command to a browser client. The phone route still runs on a server daemon,
   against the shared Ollama and through the allowlist. Confirm this is intended.
3. **"No warm-up while a local-model agent turn runs"** is enforced in the
   backend only for the asking tab (`localModel`). Checking the other tabs is the
   desktop frontend's job. A phone `warm` is not checked against other
   local-model tabs.
4. **`keep_alive: "30m"`** is sent on every request. For the Suggestions model
   it overrides the user's `ollama_keep_alive`, so it can shorten a longer or
   infinite setting.
5. Not run live: latency, KV-cache reuse (`journalctl -u ollama`), hybrid models.

## B frontend

Commits (on 82047262e): 3cfa57bc0 Suggestions chip + i18n · b0a1f1f6a shared
hook + desktop wiring + untested row + tests · 4f4f8b938 phone wiring ·
8b4972a1c docs. Committed by the main agent after the implementer handed back
with a green tree (gates job `/tmp/gates-job.PuoaJu`: brand, whitespace,
lint-fe, build, vitest `--changed` all PASS; the earlier full run counted 9743
tests, 9 phone tests failing on an unmocked `/next-prompt` fetch, fixed by
`SIDE_READS` in `src/__tests__/helpers/mobileTerminalHost.ts`). Intermediate
commits were not gated one by one; the tip was.

Choices:
- Shared timing core in `mobile-web/src/terminal/nextPrompt.ts`
  (`useNextPrompt`, `cleanNextPrompt`, `useWorkEndKey`, `usePageShown`), used by
  desktop and phone. Warm ≤ 1 per 3 s, one in flight, coalescing; final once
  per ended turn after 400 ms (Claude 1.5 s and only with no screen
  suggestion). Dropped on keystroke / new turn / hide; a dropped turn is never
  asked again; only `status: "ok"` shows.
- Desktop `src/lib/agents/nextPrompt.ts` (`useLocalNextPrompt`,
  `endedTurnKey`, `localAgentWorking`, `nextPromptArgs`): same identity as
  `readerRequest`, **plus `since`**. No warm while any `local_agent` tab works
  or for a local-model tab itself.
- Reader turn key = last prompt + closing answer; warm on transcript version
  changes; `ReaderComposer` got `onDraftEmpty`.
- Steering box asks `final` on each idle while open. Phone: local text joins
  `promptSuggestion`; `getNextPrompt` in `mobile-web/src/api.ts` (30 s timeout
  on final). `localModel.role.suggest`, `localModel.suggestCloudTitle`,
  `terminal.reader.localSuggestion` in all 5 dictionaries.
- Tests: `AgentNextPrompt.test.tsx` (19), `ReaderNextPrompt.test.tsx` (3),
  `MobileNextPrompt.test.tsx` (8), +1 in `SteeringPromptSuggestions.test.tsx`,
  `LocalModelMenu.test.tsx` updated.

Flagged for user:
1. Never live.
2. Args carry `since` beyond the contract — backend must accept or ignore it.
3. `commandClasses.ts` untouched here; tests mock `invoke`.
4. Steering box and phone Terminal view read no transcript, so they never warm;
   only the Chat view warms.
5. The phone sends one warm at turn start even before its session record moves.
6. The existing `localModelMenu.mailCloud` untested pill now also covers the
   Suggestions chip.

## R review

Reviewed `82047262e..8215df915` (merged on `worktree-agent-a35b84a50ca2d9ee5`).
Fixes are on `worktree-agent-a1322a530e76ea652`. Each has a regression test.

**Fixed**
- `ca9517878` **A turn could lose its suggestion when `final` came back
  `skipped`.** Steering's box and the phone key a turn by the screen going idle,
  not by the transcript. If the CLI had not yet written the answer to its
  transcript, the one `final` came back `skipped`, and no later key ever asked
  again. Now `useNextPrompt` asks a skipped final again up to 3 times, 1.5 s
  apart (`NEXT_PROMPT_RETRY_MS`, `NEXT_PROMPT_FINAL_RETRIES`).
- `6d7f434d7` **Local-model tabs and the folder agents never got a
  suggestion.** `agent_next_prompt` answered `unavailable` for an empty
  `sessionId`. But `readerRequest` sends `""` for a `local_agent` tab and for
  OpenCode, Antigravity and Muse, and the Chat view reads those by folder and
  launch moment. The session key (`next_prompt::desktop_key`) now also names
  `tabDir` and `since`. It is refused only when both the id and the folder are
  missing.
- `c28c0fea3` **Handoff A item 4 confirmed: `keep_alive: "30m"` cut short a
  longer choice.** A request's keep-alive replaces the model's expiry, so the
  fixed value cut an `ollama_keep_alive` of `1h` or `-1` down to 30 minutes. It
  did the same to a model pinned with Load (`keep_alive: -1`). Now
  `keep_alive_for` sends `-1` for a pinned model (read from `/api/ps` at the
  gated loopback endpoint, after the preflight) or for an infinite setting,
  `1h` for `1h`, and `30m` otherwise.

**Checked, no change needed**
- The command's args match the Rust parameters, and `since` is `Option<i64>`
  like `agent_tab_transcript`'s. The status strings match the snake_case enum.
- The phone sends only `?phase=`. The 400 on an unknown param does not trip.
- The frontend never reads or stores the backend `turnKey`.
- The loopback and no-cloud checks run before any Ollama socket, on both the
  command and the route. The route answers `{text, status}` only.
- Nothing sends the suggestion by itself. Hidden panes gate on `enabled`.
- The command is async over `spawn_blocking`.
- The `command_class` row is there, and so is the `commandClasses.ts` line. The
  three i18n keys are in all five dictionaries, and the untested row exists.
- brand-check and privacy-check (range) are clean. There are no TODOs.

**Flagged for user**
1. **A `final` can wait behind a cold `warm`.** One mutex per session, and a
   warm's timeout is 120 s. A first warm of a long turn can hold the slot for
   tens of seconds, and the phone's `final` gives up at 30 s
   (`NEXT_PROMPT_TIMEOUT`). The desktop waits with no limit. Options: lower the
   warm timeout, or let `final` cancel or skip a running warm.
2. **A `skipped` answer can't always be told apart from a stale transcript.**
   The retry covers a transcript that lags by a few seconds. If the
   transcript is still a whole turn behind (the new prompt not written yet),
   the backend answers from its cache with the *previous* turn's suggestion,
   and the phone or steering box shows that one. Rare, and still only a
   placeholder.
3. **An `OLLAMA_KEEP_ALIVE` set outside the setting** (a hand-written systemd
   env, or a value other than `30m`/`1h`/`-1`) is still not known to the
   request. That case still gets `30m` unless the model is pinned.
4. **`/api/ps` is read once per request** (warm and final) to see whether the
   model is pinned. This is cheap on loopback, but it is one extra request.
   Cache it if it shows up.
5. Handoff A items 1–3 and 5 and B items 1–6 stand as written. None is a bug
   I could confirm in code. Nothing has been run live.

## Follow-ups (main agent, 2026-11-22, user decisions)

- **Final ends a running warm** (R flag 1): `ollama_client::Abort` +
  `ollama_http_abortable`; a `final` shuts the warm's socket (Ollama stops a
  request whose client left), the aborted warm answers `skipped`, and a warm
  arriving while a final waits answers `busy` (`Slot::finals`). Test
  `a_final_ends_a_warm_up_in_flight_instead_of_waiting_behind_it`.
- **Phone through the window** (A flag 1): `DesktopRequest::AgentNextPrompt` /
  `DesktopResponse::AgentNextPrompt { text, outcome }`; the window answers with
  the Reader's `nextPromptArgs`, so one session and one run per turn for both
  screens, and the sidecar no longer calls Ollama while a window is open. The
  route re-cleans the text and lets only a known status word through. Tests:
  the rewritten `the_next_prompt_route_answers_text_and_status_only`,
  `src/__tests__/mobile/MobileBridgeNextPrompt.test.tsx` (3).
- Checks run: `cargo test -p tabtivity --lib -- next_prompt protocol mail_ai
  ollama_local` (80 passed), `cargo clippy -p tabtivity --lib --tests -D
  warnings` clean, tsc clean, eslint on the changed files clean, the 5
  next-prompt / bridge vitest files (37) passed. Not run: the full gate set,
  the other two clippy variants, `cargo test --workspace`. Never live.
