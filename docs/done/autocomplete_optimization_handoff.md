# Autocomplete optimization — handoff

> **Status (screened against code 2026-11-22):** All B1–B12 and A1–A10 commits named below are on `develop` (checked by `git log`). Open items are the "Flagged for the user" list (fenced Copilot run, stay-signed-in against a live account). Current design: `docs/context/copilot_completion.md`. Not live-tested unless the doc/todo says so.

Plan: `docs/done/autocomplete_optimization_plan.md`. Built by two implementers
(backend B1–B12, frontend A1–A10) against the plan's IPC contract, reviewed
on the joined tree, landed on `develop` 2026-11-14. Nothing here was run
live. The shas in the two implementer sections below are the worktree
commits; `develop` holds cherry-picks of them with the same subjects.

## Review and merge

Fixed after the two halves were joined (each with a regression test):

- A malformed `autocomplete_delay_ms` made the whole `settings.json` fail to
  load; the field now reads a bad value as absent.
- Starting a Copilot server without network deleted the remembered sign-in:
  any error reply to `signInWithGithubToken` counted as a refusal. Only a
  `NotSignedIn` reply deletes now.
- A budget-stopped request returned one line fewer than its last preview.
- A stats event that reached the webview after the command's answer was
  lost (the listener was already gone); a finished request listens 500 ms
  more.
- The keychain was read on every `copilot_account` call (the card polls
  every 5 s) and every idle-timer round, whether or not "Stay signed in" was
  on. With the setting off it is never read (`credentials::restorable`);
  `remembered` is false then.
- Sign in started a server while AI was switched off; `session()` in
  `commands/copilot.rs` asks the AI switch first.
- `UsageMetrics.test.ts` now holds the TS usage keys to the Rust mirror.

Open, for the user to judge:

- The inline syntax-coloured ghost never shows: every editor host soft-wraps
  and the plan limited it to unwrapped editors.
- The pinned server 1.565.6 has not run inside the fence (not possible from
  an agent's own fence); the command is in "B10 probe" below. "Stay signed
  in" has never run with a real account.
- After a restart the Copilot card reads "Signed out" plus "remembered" until
  the first completion signs in; a line for that state is missing.
- Sign-out stops only that project's server; other projects' servers stay
  signed in until idle or quit.
- An account without Copilot access (`NotAuthorized`) keeps its keychain
  entry; switching AI off keeps it too (both read as a pause, not a sign-out).
- A chat answer starting with a line break on a whitespace-only caret line
  leaves a blank line above the code.
- Chat-template tokens (`<|im_start|>`, `<|im_end|>`) inside a reference are
  not filtered from the raw `qwen2.5-coder` layout.
- `role_not_loaded` counts as a request error on every typing pause while
  the pill shows.
- Diagnostics redact GitHub tokens and Bearer credentials only.
- Ctrl+Right clashes with a macOS default shortcut.

## Autocomplete optimization — backend handoff

Plan: `docs/done/autocomplete_optimization_plan.md` (steps B1–B12), in the main
checkout. This handoff lives in the worktree (untracked, never committed):
the harness refused writes to the main checkout from this agent.

### Where

- Worktree: `.claude/worktrees/agent-a213456e0242a4cda`
- Branch: `worktree-agent-a213456e0242a4cda`
- Base: `develop` at `a70bc3e32c357046e072aab18050b71b4f474b4b`
- Cargo target: the worktree's own `target/` (as `scripts/gates.sh` uses),
  `CARGO_INCREMENTAL=0`.

### Steps

#### B1 — `855013f7e` owner gate and policy block
- New pure `completion_endpoint(settings, locked, project_id, model, refusal,
  gate)` in OL; `complete_text` runs settings load, `completion_locked`, it,
  and the real `completion_refusal`/`owner_gate` in one `rt::try_blocking`,
  uncached, before `text_completion::client()`.
- Test `a_completion_asks_the_owner_gate_before_it_connects` (beside
  `the_owner_gate_judges_loopback_listeners_only`): refusing gate + bound
  nonblocking listener → `ollama_listener_refused`, `accept` is `WouldBlock`;
  a locked refusal comes before the gate.

#### B2 — `b65190571` keep the leading newline
- `keeps_line_break(prefix, sentence)` = sentence stop off and prefix not
  ending in `\n`. `completion_preview` gained `keep_break`: one leading `\n` /
  `\r\n` is set aside, the old wrapper handling (now `chat_preview`) runs on
  the rest, the break is put back (not when the rest is empty or itself starts
  with a break). `trim_context_overlap` gained `keep_break`: after an echoed
  prefix tail it keeps the last line break plus the next line's indentation.
- New `completion_snapshot(raw, fim, done, prefix, suffix, sentence, prose)`
  shared by the stream callback and the final text (was duplicated).
- Choice: the overlap trim keeps the break only under `keep_break` too, so
  the sentence stop never sees a leading break (it would return nothing).
- Tests: `a_chat_answer_keeps_its_leading_line_break_below_a_comment`,
  `the_sentence_stop_still_strips_a_leading_line_break`.

#### B7 — `59bc7c238` stats event
- TC: `stream` returns `Streamed { text, record: Option<FinalRecord> }`;
  `FinalRecord` holds the five Ollama fields (ns). The record is kept whenever
  the `done` record arrived (also if the callback stopped on that record).
- OL: `CompletionStats` (camelCase, the five Ollama fields skipped when
  absent, `firstTokenMs` null when no token came) emitted once on
  `text-completion-stats-<id>` before returning. `stop` is `done` when a
  final record arrived, else `line` (B6 adds `budget`). Timings are per
  attempt, so after a FIM refusal they describe the chat retry.
  Durations are whole milliseconds.
- Tests: TC `a_finished_stream_returns_ollamas_final_record`, the semantic
  stop test asserts `record: None`; OL `completion_stats_serialize_to_the_contract`.

#### B8 — `b75adb437` live bench (ignored)
- `completion_bench` in `ollama/tests.rs`; env var
  `crate::app_env!("COMPLETION_BENCH_MODEL")`. Fails with a clear message when
  the model is not in `/api/ps` (verified). Reads `insert` from `/api/show`.
  Answers run to the final record (no sentence stop, `num_predict` 24, seed 1)
  so the counts arrive.

#### B3 — `7df932017` FIM gate
- `uses_fim(language, insert)` = insert && !prose. Pure `completion_plan(prefix,
  suffix, model, language, mode, references, file_name, fim) -> CompletionPlan
  {endpoint, body, reference_bytes, references_dropped}`; B8 calls it.
- `FIM_LAYOUTS` table (struct `FimLayout`), one row `qwen2.5-coder`;
  `fim_family_key` = lower case between last `/` and `:`; match by
  `starts_with`. Raw prompt exactly as the plan; `suffix` removed; stops = the
  five layout tokens + `<|endoftext|>`, `<|fim_pad|>`, plus `"\n"` when the
  templated body had the line stop.
- References are capped like the chat path (`capped_references`, 6 KB/file,
  24 KB total, shared with `build_context_block`).
- Choices: (a) caret text (prefix/suffix) or the file name holding a control
  token, or a name with a line break, falls back to the templated body without
  references (not raw) — the raw layout would be ambiguous; (b) when every
  reference was filtered out, the templated `suffix` body is sent;
  (c) `referenceBytes` counts reference content bytes actually sent (chat: the
  trimmed, capped bodies; not the `--- name ---` labels).
- `complete_text` takes `file_name: Option<String>` (`fileName`); the FIM
  retry matches `fim_refused`: exactly `ollama HTTP 400`, or the
  "does not support insert" text kept from before.
- Tests: `a_fim_model_always_uses_fim_for_code`,
  `references_travel_in_a_known_familys_raw_layout`,
  `an_unknown_fim_family_drops_references_and_says_so`,
  `a_reference_holding_a_control_token_is_left_out`,
  `only_ollamas_exact_400_retries_on_chat`.

#### B4 — `fc56f404c` chat prompt order
- `Language / [prose line] / references / AFTER / BEFORE / TASK`.
- Rewrote the two order assertions (now `ollama/tests.rs`
  `completion_prompt_includes_prefix_suffix_and_language` and
  `completion_prompt_labels_before_and_after_sections`); added
  `completion_prompt_puts_the_task_last`.

#### B5 — `b22003a2d` sampling
- `completion_body` options: `temperature 0.1, top_k 1, repeat_penalty 1.0,
  presence_penalty 0`; new `sample_candidate(body, candidate)` sets the seed
  and, for alternates, temperature 0.5 and removes `top_k`.
- Test `completion_sampling_has_no_penalties_and_a_greedy_first_candidate`.

#### B6 — `cd3c91095` time budget
- `complete_text` takes `trigger: Option<String>`; only `"auto"` is budgeted.
- `budget_cut(mode, since_first_token, text)`: budget Sentence 1.5 s / Block
  3 s / Scope 6 s; cut at the last line break (the break itself and a `\r`
  before it excluded, so the ghost ends on a complete line) when non-blank text
  precedes it. Checked only on non-final records. The final text gets the
  same cut (`complete_lines_end`), stats `stop: "budget"`.
- Choice: "cut after its last line break" read as "keep the complete lines,
  drop the break" so no dangling empty line lands before the suffix.
- Test `the_time_budget_cuts_after_complete_lines_only`.

#### Follow-up fixes found by the gates
- `5abb96a16` clippy `needless_lifetimes` on `capped_references` (B3).
- `a7404f158` `core_dispatch::USER_CONFINED` row for `complete_text.fileName`
  (`BodyConfined`: a prompt label, never opened). The coverage test
  `every_path_named_core_argument_is_classified` demanded it (B3).
- `5f4f97af4` `src-tauri/examples/copilot_probe.rs` passes the new
  `launch_installed` log argument (B9).

#### B9 — `4d074196b` Copilot fixes (+ `autocomplete_delay_ms`)
- Restart budget: `allow_start` split into `may_start` / `record_start`;
  `get_or_start_with(project, root, launch)` takes the launch as a closure
  `(root, LogSink) -> Result<(Option<ManagedProcess>, R, W)>`; the start is
  recorded only after the launch returned.
- `error_code`: -32802 → `copilot_cancelled`, -32801 →
  `copilot_stale_document`, 1001/1004/1005/1006 → `copilot_sign_in_failed`
  (the 1.565.6 bundle names them DeviceFlowFailed, CodeFlowFailed,
  NoBrowserAvailable, AuthEnvVarConflict; 1002 CopilotNotAvailable stays
  `copilot_server_error`).
- `copilot_complete`: settings → `authorize_in` (a refusal stops the
  project's server, as `session()` did) → new `authorize_file` (document,
  `inside_locked`, prose-by-extension needs text consent) → launch → consent
  re-check (root unchanged, `authorize_file` again on fresh settings).
- Logs: `rpc::LogSink`; `RpcClient::connect_logged` forwards
  `window/logMessage` (`log: …`) and `$/logTrace` (`trace: …`, + `verbose`);
  `Session::start_logged`; `ManagedProcess::launch(_installed)` take
  `Option<LogSink>`; stderr is piped and drained line by line (`stderr: …`)
  by a task that ends with the stream. `Sessions.logs` (per project, 200
  lines, `redact_log_line`: `gh[a-z]_…` and `github_pat_…` → `[redacted]`,
  `Bearer <x>` → `Bearer [redacted]`, then cut to 500 chars).
  `copilot_diagnostics({projectId}) -> {lines}` (sync, memory only),
  registered in `lib.rs`, `Core` in `command_class`, `commandClasses.ts`
  regenerated.
- Fence env: `--clearenv` removed from `fence_args`; the bwrap command gets
  `env_clear()` + `forwarded_env` (8 names). Choice: `NODE_EXTRA_CA_CERTS` /
  `SSL_CERT_FILE` are forwarded as the plan says, but the files they name
  are not bind-mounted into the fence (only `/etc/ssl`, `/etc/pki`,
  `/etc/ca-certificates` are), so a CA file elsewhere is not visible inside —
  flagged below.
- `policy::text_file` (md, markdown, mdx, tex, txt, rst).
- `commands/settings.rs`: pure `copilot_invalidated(prev, next)`, adds "AI
  switch became off" via `ai_switch::off_now`.
- `schema/usage_stats.rs::metric`: `AUTOCOMPLETE_SHOWN/TAB/WORD/LINE/TYPED/
  REJECTED/REQUEST` (no trailing dot, like the other prefixes; `sub()` adds
  it). No Rust↔TS parity test was written: it can pass only on the merged
  tree, and the gates here must pass — the merge should add it.
- `Settings::autocomplete_delay_ms: Option<AutocompleteDelays>`
  (`ollama`/`copilot` `Option<u32>`, flatten `extra`), not compared by
  `copilot_invalidated`. Choice: typed `u32` like the other numeric settings,
  so a non-integer or negative value the frontend might write would fail the
  whole file's parse — the frontend writes only its five choices.
- Tests: session `failed_launches_do_not_spend_the_restart_budget`,
  `server_error_codes_map_to_the_editors_codes`,
  `log_lines_lose_their_credentials_and_length`,
  `the_log_ring_keeps_the_newest_lines`,
  `server_log_messages_reach_the_projects_ring`; process
  `only_proxy_and_ca_variables_are_forwarded` (+ fence test asserts no
  `--clearenv` and no proxy/CA text in the args); policy
  `prose_files_are_judged_by_their_extension`; commands/settings
  `the_ai_switch_turning_off_stops_copilot_and_editor_tuning_does_not`;
  schema `autocomplete_delays_round_trip_and_stay_absent_when_unset`.

- `3f2058685` (B9 follow-up): `agent_privacy` source-scan test
  `the_completion_paths_call_their_guards` now asks for two `authorize_file(`
  calls in `copilot_complete` and the `inside_locked` guard in `authorize_file`.

#### B10 — `c67757d28` pin bump
- npm publish dates: 1.565.6 2026-11-06, 1.567.5 2026-11-13 (one day old),
  1.570.0 2026-11-13 → pinned **1.565.6**.
- Installed under the worktree's ignored `target/copilot-probe/` (the
  worktree's `.claude/` is not ignored there, so the first attempt was moved;
  the main checkout's `.claude/` was off limits to this agent).
- `install_command` installs `@github/copilot-language-server-linux-<arch>`
  alone (159 MB vs ~600 MB: the umbrella now also pulls the Copilot CLI and
  SDK). `server_path` unchanged (same layout).
- Fenced ignored test extended with an anonymous `signIn` that stops at the
  user code, and prints the log ring on a failed start.
- `scripts/copilot-probe.py`: `--sign-in`; HOME/USERPROFILE now point into the
  temp dir (fixed: without HOME the server could fall back to the real home
  and find another tool's sign-in).
- Docs: checklist 2.1, `docs/context/copilot_completion.md`.

#### B11 — `31aa8b5c5` stay signed in
- New `services/copilot/credentials.rs`: `Remembered {user, token}` (Debug
  redacts the token), `TokenStore` trait, `Keychain` (through
  `remote_credentials::get/set`, account `copilot-language-server`, so the
  locked-keyring rules apply), `enabled()`, `remembered`, `remember`,
  `after_sign_in(stay)`, `restore`, `forget`, `setting_changed`.
- Session: `github_token()` (`auth/getGitHubToken`), `sign_in_with_token()`
  (`signInWithGithubToken`; refused = reply status missing/`NotSignedIn` or a
  server error; timeout/closed = `Err`, the entry is kept).
- `Sessions::get_or_start` reads the setting and passes the keychain to
  `get_or_start_with(.., restore, ..)`, which signs the new server in after
  `didChangeConfiguration`; a failure is logged as its code only.
- Commands: `copilot_finish_sign_in` stores (setting on); `copilot_sign_out`
  deletes (only when something is remembered, so a locked keychain is never
  touched by a plain sign-out); `copilot_account` gains `remembered` (also
  when not running). `commands/settings.rs`: `stay_signed_in_switched`, and a
  spawned `credentials::setting_changed` on a switch (keychain I/O off the
  settings write). `Sessions::all_running()`.
- `Settings::copilot_stay_signed_in: Option<bool>`.
- Choice: `NotAuthorized` (token valid, no Copilot access) counts as accepted
  and keeps the entry — flagged below.
- Tests (fake server): `a_finished_sign_in_is_remembered_only_with_the_setting_on`,
  `a_starting_server_is_signed_in_from_the_keychain`,
  `a_refused_token_is_deleted_and_the_server_stays_signed_out`,
  `switching_off_or_signing_out_deletes_the_entry_and_switching_on_keeps_a_live_sign_in`;
  credentials `a_remembered_sign_in_never_prints_its_token`; settings
  `stay_signed_in_acts_only_when_it_switches`; schema
  `copilot_stay_signed_in_is_off_by_default_and_round_trips`.

#### B12 — idle shutdown
- `Sessions.used` (last completion request or start per running project),
  `note_use` called by `copilot_complete` after the consent re-check.
  `reap_idle(now, remembered)`: nothing without a remembered sign-in; else
  stops every server idle ≥ 10 min, judged and removed under one lock.
- `start_reaper(&'static self, store, every, clock)`: one task, started by the
  global `get_or_start` after a successful start, every 60 s, skips the
  keychain read while no server runs; `stop_all` (exit) aborts it.
  `stop`/`stop_all_now` clear `used`.
- Tests: `idle_servers_stop_only_while_a_sign_in_is_remembered` (injected
  instants), `the_idle_timer_ends_with_stop_all` (injected clock fn, leaked
  registry).

### B8 bench

Ollama 0.40.16. `/api/ps` before the run: empty. Pulled `qwen2.5-coder:1.5b`
(`/api/pull`, success; capabilities `completion, tools, insert`). Loaded it and
`gemma4:e4b` by hand for the runs, unloaded both with `keep_alive: 0` after.

Finding: on this Ollama, `prompt_eval_count` counts the whole prompt even when
the prompt cache was reused; `prompt_ms` (prompt_eval_duration) is what shows
the reuse.

#### Before B3/B4 (develop's gate and prompt order)

qwen2.5-coder:1.5b, 0 references (FIM, templated):
prompt_eval 40–46 tokens, prompt_ms 126 first then 29–45, first_ms 36–55
(138 first). Answers sensible (`um(items);`, `map(item => item * 10));`, `x));`).

qwen2.5-coder:1.5b, 2 references (today's gate pushes it to chat):
all `chat`, prompt_eval 409–421, prompt_ms 436 first, then 33–86 with one
miss of 361 at request 10 (`.` typed → TASK text switches), first_ms 45–405.
Answers mostly unusable (code fences, `}`, repeated function header).

gemma4:e4b (no insert, chat), 0 references: prompt_eval 243–254,
prompt_ms 487–843 every request (no visible cache reuse), first_ms 498–1859.
2 references: prompt_eval 456–467, prompt_ms 924–1193, first_ms 934–1203.
Answers sensible.

#### After B3–B6 (second run)

qwen2.5-coder:1.5b, 0 references: `generate`, prompt_eval 40–46,
prompt_ms 68 first then 26–63, first_ms 30–72.

qwen2.5-coder:1.5b, 2 references: now `generate` through the raw layout
(534 bytes sent, not dropped): prompt_eval 204–210, prompt_ms 140 first then
27–53, first_ms 31–59. Answers as sensible as without references and
reference-aware (`x * 100`, `item.price`).

gemma4:e4b (chat), 0 references: prompt_ms 1438 first then 324–426 (was
487–843), first_ms 335–440. 2 references: prompt_ms 698–772 (was 924–1193),
first_ms 722–789. About 25–30 % less prompt time, but not the "tens of tokens"
the plan expected: gemma4:e4b on this Ollama re-reads most of the prompt each
time (prompt time grows with the prompt), so its prompt cache is not reused
the way qwen's is. Answers sensible; it often echoes the suffix
(`return format(value);`), which the final seam trim removes.

#### The `qwen2.5-coder` row stays

Evidence: with references, every request of the trace went `generate` with
`raw: true`, and the answers are the same quality as the no-reference run
(see the table). Expected per the plan: FIM with and without references —
met. The chat-path expectation (second request reads tens of tokens) is met on
qwen2.5-coder through chat before B3 (33 ms vs 436 ms) but not on gemma4:e4b.

#### Raw tables

##### b8_before_qwen
```
model qwen2.5-coder:1.5b, insert true
0 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
  1 | generate |          40 |       126 |        138 | um(items);
  2 | generate |          40 |        45 |         55 | m(items);
  3 | generate |          40 |        30 |         36 | (items);
  4 | generate |          41 |        31 |         40 | items);
  5 | generate |          41 |        29 |         37 | tems);
  6 | generate |          41 |        32 |         40 | ems);
  7 | generate |          42 |        32 |         44 | ms);
  8 | generate |          41 |        33 |         46 | s);
  9 | generate |          41 |        31 |         40 | );
 10 | generate |          42 |        39 |         46 | map(item => item * 10));
 11 | generate |          42 |        31 |         39 | ap(item => item * 100));
 12 | generate |          42 |        29 |         39 | p(item => item * 100));
 13 | generate |          42 |        32 |         39 | (item => item * 100));
 14 | generate |          43 |        29 |         37 | item => item));
 15 | generate |          43 |        29 |         40 | item) => item * 100));
 16 | generate |          44 |        31 |         39 | ) => x));
 17 | generate |          45 |        30 |         41 |  => x));
 18 | generate |          46 |        32 |         39 | => x));
 19 | generate |          46 |        32 |         42 | > x));
 20 | generate |          46 |        32 |         39 |  x));
2 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
  1 | chat     |         415 |       436 |        456 | }
  2 | chat     |         415 |        33 |         47 | }
  3 | chat     |         415 |        33 |         45 | {value}
  4 | chat     |         415 |        33 |         48 | ```⏎```
  5 | chat     |         416 |        34 |         48 | ```typescript⏎export function total(items: numbe
  6 | chat     |         416 |        44 |         62 | ```typescript⏎} as number);⏎```
  7 | chat     |         417 |        55 |         73 | `ms);`
  8 | chat     |         416 |        63 |         95 | ```typescript⏎  return format(value);⏎}⏎```
  9 | chat     |         416 |        47 |         62 | ```typescript⏎export function total(items: numbe
 10 | chat     |         409 |       361 |        405 | ```typescript⏎export function total(items: numbe
 11 | chat     |         417 |        86 |        117 | ```typescript⏎items.length);⏎```
 12 | chat     |         417 |        82 |         96 | }
 13 | chat     |         417 |        82 |        104 | }));
 14 | chat     |         417 |        67 |         88 | ```⏎```
 15 | chat     |         418 |        68 |         91 | export function total(items: number[]): string {
 16 | chat     |         419 |        82 |        103 | ```⏎})); }⏎```
 17 | chat     |         419 |        83 |         99 | }));
 18 | chat     |         420 |        65 |         82 | export function total(items: number[]): string {
 19 | chat     |         420 |        70 |         91 | ```⏎```
 20 | chat     |         421 |        67 |         85 | ```⏎```
```
##### b8_before_gemma
```
model gemma4:e4b, insert false
0 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
  1 | chat     |         246 |      1845 |       1859 | um(items);
  2 | chat     |         246 |       487 |        498 | m(items);
  3 | chat     |         246 |       543 |        554 | (items);
  4 | chat     |         247 |       506 |        517 | items);
  5 | chat     |         248 |       508 |        517 | tems);
  6 | chat     |         248 |       523 |        530 | ems);
  7 | chat     |         248 |       490 |        499 | ms);
  8 | chat     |         248 |       511 |        520 | s);
  9 | chat     |         248 |       536 |        547 | );⏎  return format(value);⏎}
 10 | chat     |         243 |       576 |        586 | length);
 11 | chat     |         250 |       521 |        535 | ethod);
 12 | chat     |         250 |       516 |        527 | trix);
 13 | chat     |         250 |       843 |        851 | (item) => item);
 14 | chat     |         251 |       518 |        527 | item => item);
 15 | chat     |         251 |       620 |        640 | item => item.value));
 16 | chat     |         252 |       625 |        638 | =>x => x);
 17 | chat     |         253 |       498 |        505 | =>x);⏎  return format(value);⏎}
 18 | chat     |         254 |       578 |        587 | =>x);⏎  return format(value);⏎}
 19 | chat     |         254 |       537 |        547 | => x);⏎  return format(value);⏎}
 20 | chat     |         254 |       505 |        517 | x);⏎  return format(value);⏎}
2 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
  1 | chat     |         459 |      1193 |       1203 | um(items);
  2 | chat     |         459 |      1041 |       1054 | m(items);
  3 | chat     |         459 |       957 |        972 | (items);
  4 | chat     |         460 |      1016 |       1026 | items);
  5 | chat     |         461 |      1118 |       1131 | tems);
  6 | chat     |         461 |      1165 |       1176 | ems);
  7 | chat     |         461 |      1150 |       1160 | ms);
  8 | chat     |         461 |      1141 |       1157 | s);⏎  return format(value);⏎}
  9 | chat     |         461 |       924 |        934 | );⏎  return format(value);⏎}
 10 | chat     |         456 |       984 |       1011 | length);
 11 | chat     |         463 |      1013 |       1047 | embers);
 12 | chat     |         463 |      1009 |       1019 | x);
 13 | chat     |         463 |      1030 |       1040 | (item => item));
 14 | chat     |         464 |      1056 |       1066 | item => item);
 15 | chat     |         464 |      1150 |       1170 | item => item));
 16 | chat     |         465 |       995 |       1007 | =>x => x);⏎  return format(value);⏎}
 17 | chat     |         466 |      1001 |       1013 | x => x);⏎  return format(value);⏎}
 18 | chat     |         467 |      1161 |       1171 | x => x);⏎  return format(value);⏎}
 19 | chat     |         467 |      1107 |       1119 | x => x);
 20 | chat     |         467 |      1064 |       1074 | x);⏎  return format(value);⏎}
```
##### b8_after_qwen
```
model qwen2.5-coder:1.5b, insert true
0 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
    references sent: 0 bytes, dropped: false, raw: false
  1 | generate |          40 |        68 |         72 | um(items);
  2 | generate |          40 |        34 |         41 | m(items);
  3 | generate |          40 |        26 |         30 | (items);
  4 | generate |          41 |        28 |         32 | items);
  5 | generate |          41 |        27 |         30 | tems);
  6 | generate |          41 |        26 |         30 | ems);
  7 | generate |          42 |        26 |         31 | ms);
  8 | generate |          41 |        26 |         30 | s);
  9 | generate |          41 |        27 |         31 | );
 10 | generate |          42 |        26 |         30 | map(item => item * 100));
 11 | generate |          42 |        27 |         31 | ap(item => item * 100));
 12 | generate |          42 |        27 |         31 | p(item => item * 100));
 13 | generate |          42 |        63 |         72 | (item => item * 100));
 14 | generate |          43 |        52 |         58 | item => item * 10));
 15 | generate |          43 |        27 |         32 | item) => item * 10));
 16 | generate |          44 |        27 |         30 | ) => x));
 17 | generate |          45 |        27 |         31 |  => x));
 18 | generate |          46 |        27 |         31 | => x));
 19 | generate |          46 |        28 |         33 | > x));
 20 | generate |          46 |        27 |         32 |  x));
2 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
    references sent: 534 bytes, dropped: false, raw: true
  1 | generate |         204 |       140 |        146 | um(items);
  2 | generate |         204 |        32 |         43 | m(items);
  3 | generate |         204 |        27 |         32 | (items);
  4 | generate |         205 |        28 |         33 | items);
  5 | generate |         205 |        27 |         32 | tems);
  6 | generate |         205 |        53 |         59 | ems);
  7 | generate |         206 |        49 |         56 | ms);
  8 | generate |         205 |        27 |         33 | s);
  9 | generate |         205 |        27 |         33 | );
 10 | generate |         206 |        33 |         38 | map(item => item * 100));
 11 | generate |         206 |        28 |         33 | ap(item => item.price));
 12 | generate |         206 |        28 |         33 | p(item => item * 100));
 13 | generate |         206 |        48 |         54 | (item => item * 100));
 14 | generate |         207 |        32 |         44 | item => item * 100));
 15 | generate |         207 |        27 |         31 | item) => item * 100));
 16 | generate |         208 |        27 |         31 | ) => x * 100));
 17 | generate |         209 |        28 |         32 |  => x * 100));
 18 | generate |         210 |        27 |         33 | => x * 100));
 19 | generate |         210 |        27 |         35 | > x * 100));
 20 | generate |         210 |        27 |         33 |  x * 100));
```
##### b8_after_gemma
```
model gemma4:e4b, insert false
0 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
    references sent: 0 bytes, dropped: false, raw: false
  1 | chat     |         246 |      1438 |       1446 | um(items);
  2 | chat     |         246 |       324 |        335 | m(items);
  3 | chat     |         246 |       344 |        359 | (items);
  4 | chat     |         247 |       389 |        401 | items);⏎  return format(value);⏎}
  5 | chat     |         248 |       373 |        386 | ts);⏎  return format(value);⏎}
  6 | chat     |         248 |       412 |        427 | ems);
  7 | chat     |         248 |       426 |        440 | ms);⏎⏎  return format(value);⏎}
  8 | chat     |         248 |       374 |        391 | s)⏎  return format(value);⏎}
  9 | chat     |         248 |       382 |        401 | );⏎  return format(value);⏎}
 10 | chat     |         243 |       396 |        412 | length);⏎  return format(value);⏎}
 11 | chat     |         250 |       396 |        409 | ap);⏎  return format(value);⏎}
 12 | chat     |         250 |       391 |        402 | x);⏎  return format(value);⏎}
 13 | chat     |         250 |       381 |        396 | (item => item);
 14 | chat     |         251 |       409 |        428 | item => item.value));⏎  return format(value);⏎}
 15 | chat     |         251 |       399 |        429 | item => item.value));⏎  return format(value);⏎}
 16 | chat     |         252 |       386 |        405 | ) => x);⏎  return format(value);⏎}
 17 | chat     |         253 |       396 |        412 | =>x);⏎  return format(value);⏎}
 18 | chat     |         254 |       365 |        385 | => x);⏎  return format(value);⏎}
 19 | chat     |         254 |       380 |        398 | x => x);
 20 | chat     |         254 |       401 |        418 | x * 10);⏎  return format(value);⏎}
2 reference files
  # | endpoint | prompt_eval | prompt_ms |   first_ms | answer
    references sent: 534 bytes, dropped: false, raw: false
  1 | chat     |         459 |       772 |        789 | um(items);
  2 | chat     |         459 |       763 |        787 | m(items);
  3 | chat     |         459 |       729 |        751 | (items);
  4 | chat     |         460 |       731 |        753 | items);
  5 | chat     |         461 |       729 |        746 | tems);
  6 | chat     |         461 |       732 |        755 | ems);
  7 | chat     |         461 |       735 |        760 | ms);
  8 | chat     |         461 |       727 |        746 | s);
  9 | chat     |         461 |       725 |        745 | );
 10 | chat     |         456 |       716 |        742 | values);
 11 | chat     |         463 |       725 |        744 | ean);
 12 | chat     |         463 |       733 |        752 | x);
 13 | chat     |         463 |       730 |        747 | (item => item));
 14 | chat     |         464 |       711 |        733 | item => item));
 15 | chat     |         464 |       726 |        743 | item => item));⏎  return format(value);⏎}
 16 | chat     |         465 |       704 |        725 | ) * 100);
 17 | chat     |         466 |       729 |        750 | => x);⏎  return format(value);⏎}
 18 | chat     |         467 |       698 |        722 | => x);⏎  return format(value);⏎}
 19 | chat     |         467 |       705 |        727 | x => x);⏎  return format(value);⏎}
 20 | chat     |         467 |       728 |        745 | x);⏎  return format(value);⏎}
```



### B10 probe

- `scripts/copilot-probe.py` (unfenced, isolated HOME/XDG, no GitHub token
  variables) against 1.565.6, both the umbrella install and the native
  package alone: initialize `1.565.6` (node 22.23.4), `textDocumentSync`
  `change: 2`, unauthenticated completion 1000, cancelled -32800.
- Anonymous `signIn` (`--sign-in`, native package): no error,
  `status: PromptUserDeviceFlow`, user code of 9 characters,
  `verificationUri` `https://github.com/login/device`, `command`
  `github.copilot.finishDeviceFlow` — matches `Session::sign_in`'s parser.
  Never finished; no token or credential on the machine was used.
- **Fenced ignored test: not run successfully.** This agent's shell is itself
  inside a fence: `bwrap` fails with "No permissions to create a new
  namespace" (nested unprivileged user namespaces unavailable; the new stderr
  capture showed it in the test failure). I did not try to get around that
  (no sandbox override). So the fence's network binds for `signIn`, and
  1.565.6 under the fence at all, are unverified. The harness did not refuse
  running the binary, so the pin was bumped and B11/B12 were built.
- To finish it from a normal shell:
  `npm install --prefix <dir> --ignore-scripts --no-audit --no-fund @github/copilot-language-server-linux-x64@1.565.6`
  then `TABTIVITY_COPILOT_INSTALL=<dir> cargo test -p tabtivity --lib fenced_server_initializes -- --ignored --nocapture`.
- Bundle reading (umbrella `dist/main.js`): `auth/getGitHubToken` params `{}`
  → `{credentialType:"github", resource, token, scopes?}` or null;
  `signInWithGithubToken` params `{githubToken, user, githubAppId?}` →
  `signInEditor(...)`'s `{status, user}`; error codes 1000 NoCopilotToken,
  1001 DeviceFlowFailed, 1002 CopilotNotAvailable, 1003 NoGitHubToken,
  1004 CodeFlowFailed, 1005 NoBrowserAvailable, 1006 AuthEnvVarConflict.
  1.565.6 also sends new notifications (`copilot/customAgent/didChange`,
  `copilot/customSkill/didChange`, `copilot/hook/didChange`,
  `copilot/plugins/didChange`, `didChangeStatus/v2`, `statusNotification`);
  `Session` ignores unknown notifications, so they are harmless.
- Scratch installs left in the worktree's ignored
  `target/copilot-probe/{full,solo}-1.565.6` (~760 MB); delete at will.

### Gates

See the end of this file (final run).

### File-map rows to update

- `docs/filemap_backend.md` row `copilot/{rpc,policy,process,documents,session}.rs`
  → add `credentials` to the set and mention: per-project log ring +
  `copilot_diagnostics`, proxy/CA env forwarding, opt-in keychain "stay
  signed in", idle shutdown while a sign-in is remembered.
- Row `ollama.rs` → "FIM for every code request of an insert model (raw
  repo layout with references for `qwen2.5-coder`), chat prompt with the
  changing text last, stats event `text-completion-stats-<id>`, time budget
  for automatic requests, owner gate before connecting".
- Row `text_completion.rs` → "returns Ollama's final record with the text".
- `scripts/copilot-probe.py` (if mapped) → `--sign-in`.

### Plan statements found wrong

- Line anchors drifted as expected (e.g. the B4 order tests were at
  `ollama/tests.rs:1230`/`:1249`, not `:1066`/`:1084`).
- B9: "four failing launches return the launch error four times" — the budget
  is 3 starts, so the test uses `MAX_STARTS + 1` (= 4) launches; consistent.
- B10: "Install to a scratch prefix under the repo's ignored `.claude/`
  directory": in a worktree `.claude/` is not ignored (and the main
  checkout's was out of reach for this agent); used the worktree's ignored
  `target/` instead.
- B10: the fenced test cannot run from inside an agent fence (nested bwrap);
  the plan assumed it could.
- Contract/B8: Ollama 0.40.16 reports the whole prompt in
  `prompt_eval_count` even on a prompt-cache hit; only `prompt_eval_duration`
  shows reuse. The plan's "reads tens of tokens" expectation cannot be read
  off `promptEvalCount`; use `promptEvalMs`.
- Not in the plan but needed: `core_dispatch::USER_CONFINED` row for the new
  path-named `complete_text.fileName`, the `copilot_probe` example, and the
  `agent_privacy` guard source scan.
- The usage-key parity test "passes only on the merged tree": not written here
  (it would fail this branch's gates); the merge should add it.

### Flagged for the user

1. **Fenced Copilot run of 1.565.6 not done** (nested bwrap impossible in the
   agent sandbox). Run the ignored fenced test from a normal shell before the
   pin ships (command above).
2. **Stay signed in is unverified without a live account.** Request shapes
   come from the bundle only; `NotAuthorized` (valid token, no Copilot
   access) is treated as accepted and keeps the keychain entry — say if it
   should delete instead.
3. **Keychain write on sign-out** only happens when something is remembered;
   on a locked keyring a remembered entry cannot be deleted and sign-out then
   reports the keyring error (the server itself is stopped either way).
4. **CA files are forwarded by name only**: `NODE_EXTRA_CA_CERTS` /
   `SSL_CERT_FILE` reach the fenced server, but a file outside `/etc/ssl`,
   `/etc/pki`, `/etc/ca-certificates` is not mounted, so it is invisible
   inside. Binding it read-only would widen the fence (a product/security
   choice).
5. **Diagnostics content**: server log/trace lines may include file names
   or fragments the server chooses to log; only GitHub tokens and Bearer
   credentials are redacted. Shown only to the local user via
   `copilot_diagnostics`.
6. **gemma4:e4b chat path**: B4 cut its prompt time by ~25–30 %, not to "tens
   of tokens": that model on this Ollama does not reuse its prompt cache the
   way qwen does. The automatic-request budget (B6) and FIM models matter more
   for it.
7. `autocomplete_delay_ms` is typed `u32` per provider: a non-integer or
   negative value written by any client would make `settings.json` fail to
   parse; the frontend writes only its five choices.
8. `qwen2.5-coder:1.5b` was pulled into the user's Ollama (986 MB, kept);
   both bench models were unloaded afterwards (`/api/ps` empty before and
   after).

### Gates (final run, HEAD `039a7b317`, `--base a70bc3e32`)

All selected gates passed: brand, whitespace, lint-fe, clippy (workspace
crates, `--all-targets -D warnings`), clippy-dlib (`--no-default-features
--lib`), clippy-dmn, `npm run build`, vitest `--changed`, `cargo test -p
app-core -p tabtivity -p app-serverd` (367 s), test-dlib (`--no-default-features
--lib --test server_secrets`, 460 s). gates.sh deletes its logs on a pass, so
the final counts were not kept; the last counted run (after B9, before the
guard-scan fix) had 5,728 tabtivity lib tests passing, 1 failing (fixed in
`3f2058685`), 14 ignored; B11/B12 added 9 more tests, all passing in the
targeted runs. Earlier gate runs caught three issues, fixed in their own
commits (see "Follow-up fixes"). `npm run backend:stale`: the open window
predates the current build (expected; nothing here was run live).

## Autocomplete optimization — frontend handoff

Plan: `docs/done/autocomplete_optimization_plan.md` (main checkout), steps A1–A10. Commit order: A4, A10,
A3, A2, A1, A7, A5, A6 (two), A8, A9.

This file lives uncommitted in the worktree: the agent's isolation refused a
write to the main checkout. Copy it there when merging.

- Base: `a70bc3e32` (`develop` tip when the worktree was reset)
- Worktree: `.claude/worktrees/agent-aa2984ffc0dc6ae3c`
- Branch: `worktree-agent-aa2984ffc0dc6ae3c` (not pushed, not merged)

### Steps

#### A4 — trigger hygiene — `633a60131`

- `autocomplete.ts`: `EditKind` (`insert | delete | accept | external`) and
  `editKind(before, after)` (common prefix/suffix; new text in = insert, even
  over a selection).
- CE: `edit()` records the kind; `acceptSuggestion`/`acceptWord` overwrite it
  with `accept`; the external-change effect (draft changed without `edit()`:
  undo, redo, reload, first load) sets `external`. The idle timer is armed only
  when the last change was `insert`, and checks an IME-composition ref when it
  fires; `compositionend` bumps a counter in the timer's deps so the pause after
  a composition still asks.
- `useTabAiPrefs` memoises `ac`.
- `OllamaCompletionProvider` sends `trigger` (`auto` for the idle timer, else
  `manual`).
- Coordinator addition (user decision): `COPILOT_AUTO_AC_DEBOUNCE_MS` 1200 → 200.
  Copilot's default trigger stays "on request"; the local debounce stays 600 ms.
  No test or frontend comment named 1200 ms besides the constant's own comment.
- Choice: a reload and the initial load count as `external` (no automatic
  request until the user types).
- Tests added (`Autocomplete.test.tsx`): trigger auto/manual; no auto request
  after a deletion (typing asks again); none after Tab accept; none after undo;
  IME composition holds it until `compositionend`; `editKind` unit test;
  `useTabAiPrefs().ac` keeps identity across re-renders.

#### A3 — window — `5c7f1142d`

- `completionWindow`: start = 0 up to a 4096-character caret, else
  `ceil((caret − 4096) / 1024) × 1024`, then snapped to the next line boundary
  before the caret (surrogate-safe when there is none). Suffix 2048.
- Choice: on a single line longer than the window, the fallback start is the
  same quantised step (≤ 4096 characters, no split surrogate pair) rather than
  today's sliding `caret − 4096`; it satisfies the plan's stated bounds and
  keeps the start stable on long lines too.
- Tests: the two window tests rewritten (2048 suffix; the emoji slice is now
  3000 emoji); new "two nearby carets share the window start".

#### A10 — delay in the menu — `71b512f66`

- `editorPrefs.tsx`: `AC_DELAY_CHOICES` (100/200/400/600/1200),
  `AC_DEFAULT_DELAY_MS` (`ollama` 600, `copilot` 200), `acDelayMs(stored,
  copilot)` (a value outside the choices → default). `EditorAiControls` shows a
  "Delay" `Dropdown` (same `file-viewer-ai-mode` class as the trigger) while the
  effective trigger is Auto; it writes `autocomplete_delay_ms` for the provider
  serving the tab, keeping the other provider's value.
- CE: the two debounce constants are gone; the timer reads `acDelayMs` from the
  settings store.
- `Settings.autocomplete_delay_ms?: { ollama?: number; copilot?: number }`
  in `src/types/index.ts`.
- Tests: stored 100 ms fires within 350 ms; a stored 250 uses 600; `acDelayMs`
  unit cases; the Delay choice writes `{ copilot: 400, ollama: 100 }`; no Delay
  choice while the trigger is On request.

#### A2 — references — `1beb53ceb`

- `completionContext.ts`: `AUTO_REFERENCE_BYTES` (4000), `referenceBudget`,
  `trimReferences`, `referenceSetId` (cyrb53 over names + contents),
  `ReferenceReads` (per-editor frozen reads, misses remembered, keyed on file +
  root + import list; `explicit` reads afresh). `completionContext` gains
  `explicit` and `reads`: automatic = manual + TeX keys + imports, explicit adds
  open tabs sorted by path. Cap: 16 files that exist, 64 candidate paths tried.
- `OllamaCompletionProvider`: lookup, gathering and `prepare_text_completion`
  run in `Promise.all`; a reservation that lands after abort/finish/cache hit is
  cancelled. References trimmed to the model's budget (`context_length` from
  `list_ollama_models_detailed`). Cache key uses the set id (and model name +
  insert flag instead of the whole model object). Sends `fileName` (omitted when
  the file is outside the project). Listens to `text-completion-stats-<id>` and
  reports it via `onStats(stats, model)`.
- CE: `acReads`, `acDropsReferences` (model names); `referencesDropped` →
  that model gets no references from this editor.
- Choices: Alt+[/] and Shift+Tab re-requests count as explicit (they are
  `trigger: manual` too) and read afresh. The explicit budget is used as
  computed even when it is below 4 KB (a model loaded with < 5.3 K context).
  A cache hit now costs one reservation + cancel round trip, because the
  reservation starts before the cache is consulted (the plan's parallel start).
- Tests: `CompletionContext.test.ts` (automatic scope/order/4 KB, frozen reads,
  cap counts existing files, budgets, trim + id); `Autocomplete.test.tsx`
  (second automatic request reads no file and sends `fileName`; parallel start;
  `referencesDropped` stops references). The existing explicit-refresh test and
  the cache-revisit test pass unchanged.

#### A1 — measurement — `f0f821c85`

- `METRIC`: `AUTOCOMPLETE_SHOWN/TAB/WORD/LINE/TYPED/REJECTED/REQUEST`
  (`autocomplete.shown` … `autocomplete.request`); old ACCEPT/DISMISS kept for
  reading only.
- `completion/completionTimings.ts`: the ring (200, module scope, not
  persisted; `startCompletionTiming`, `completionTimings`,
  `clearCompletionTimings`) and `CompletionOffers`, the per-editor tracker.
- Choices: each take kind counts **at most once per offer** (so `tab + word +
  line + typed` per identity can exceed `shown`, but each is a share of
  offers); `shown` is counted at the first take or at the offer's end if it
  was visible ≥ 750 ms (no timer). A stream's token updates and a partly taken
  ghost are one offer (keyed on the candidate id). An offer ends when the ghost
  is consumed, dismissed, replaced (new request, Alt+[/] on Copilot) or
  invalidated by an edit or an external change. Request outcome `cache` is a
  completion-cache hit; aborted and `copilot_cancelled`/`copilot_stale_document`
  requests count nothing. Copilot's model segment is `copilot`
  (`copilot/copilot`), as the old keys had it.
- CE: `acOffers` replaces `acOutcome`/`recordAcOutcome`; `acAccepting` keeps
  accept keys from booking as typed; `acLastEditAt` feeds the ring's keystroke.
- `StatsRecap`: `autocompleteOffers(counters)` (exported for its test) and one
  Metric row per identity with the new `stats.autocompleteOffers` line, before
  the old history rows.
- `DevPerfHost`: a "Completions" table (newest 12): model, trigger, endpoint
  (+ `−ref` when references were dropped), ms to context-ready / first event /
  done, keystroke→done, prompt tokens, outcome. Reset clears the ring. English
  only, as the rest of the panel.
- Tests: rewritten the two old-key assertions (now `rejected` + `shown` +
  `request.ok/cache` after a skewed 750 ms; and `shown, line, tab` for Alt+Right
  then Tab); added typed-through (one char no accept, three = `typed`), request
  outcomes incl. `ollama/none`, the ring's milestones and stats, and
  `CompletionTimings.test.ts` (tracker with an injected clock, ring cap, recap
  reader).
- No parity test between `usageMetrics.ts` and `schema/usage_stats.rs` exists
  in the tree; none was added (the Rust half is the backend's).

#### A7 — keys — `81ca1628d`

- Plain Right: no longer handled while a ghost shows, so it falls to the
  generic arrow branch (dismiss) and the native caret move. Ctrl+Right (no
  other modifier) accepts a word; Alt+Right the line, as before.
- `AC_KEY_LABELS.ctrlRight` (`chordLabel`, reads ⌃→ on macOS); the hint strings
  `fileViewer.autocompleteControls` / `copilotControls` in all five languages
  now say `{ctrlRight}: word` instead of `→: word`.
- Tests: the word-accept test uses Ctrl+Right and checks the hint; new "plain
  Right dismisses the ghost and inserts nothing" (default not prevented).

#### A6 — ghost rendering — `d2b30a08b` (frame/scroll/gutter), `8934a0769` (inline ghost, revertable alone)

- First commit: `requestCompletion` wraps the provider's `publish` so a burst
  of stream events renders once per `requestAnimationFrame` with the newest
  text; `settle(result)` after `provider.complete` cancels a pending frame and
  publishes the final answer at once; `settle()` in `finally` drops a pending
  frame on abort/error. Ghost scroll alignment moved to `useLayoutEffect`. The
  line-number gutter cells are a `useMemo` (deps: line count, wrap, line
  heights, breakpoints, match lines, caret line, unclosed lines, breakpoint
  handler, `t`). Tests: the stream test waits a frame; new "a burst of streamed
  tokens renders once, on the next frame; the final text lands at once". The
  gutter memo has no dedicated test (pure render-cost change).
- Second commit: `inlineGhostTail(draft, at, ghost, {highlighted, wrapped})`
  decides; CE renders `pre.file-viewer-ghost.is-inline` (transparent text and
  background) with `span.file-viewer-ghost-cover` (`--bg-panel`, text colour)
  holding the ghost span and the shifted tail; otherwise the unchanged opaque
  projection. The cover holds the background because `.file-viewer-ghost-text`
  has `opacity: 0.85`, which would let the original closers show through.
  Tail rule: spaces, tabs and closers only (stricter than `caretAtLineEnd`'s
  `\s`); a CRLF `\r` stays outside the tail.
- **Plan statement found wrong in effect:** "wrap is off" — all four
  `CodeEditor` hosts (TextView, MarkdownView, TexView ×2) pass `wrap`
  unconditionally, so the inline path is never reached in the app today. Kept
  conservative as instructed; see Flagged.
- Tests: the inline branch through a bare unwrapped `CodeEditor` harness (cover
  text `42)`, whole document in the layer); the real text view (wrapped) keeps
  the opaque projection for a one-line ghost; a multi-line ghost stays opaque;
  `inlineGhostTail` unit cases.

#### A5 — model clarity — `e7e02ab36`

- `autocomplete.ts`: `missingRoleModel(loaded, lang, role, proseRole)`,
  `RECOMMENDED_AUTOCOMPLETE_MODEL`, `autocompleteModelAdvice(models, role)`;
  `completionModels.clear()`.
- `useTabAiPrefs().ac.role` = the bare `ollama_roles.autocomplete`.
- Provider: for an automatic request, a role (code role; for prose the prose
  role then the code role) naming models none of which is resident throws
  `role_not_loaded:<model>`. Explicit requests keep today's fallback.
- CE: that error shows the status pill "`<model>` not loaded — [Load]"
  (`.file-viewer-ac-status.has-action` takes pointer events; the button keeps
  the caret by preventing mousedown). Load → `loadOllamaModel`, clears the
  model cache, asks again automatically. The hint pill now starts with the
  model that answered (`fileViewer.autocompleteFrom`), local models only.
- Models hub (overlay page only): a "Fill-in" capability chip on models
  reporting `insert` (both lists, via `CapabilityChips`); a banner (copied from
  the context-too-short notice: `local-model-igpu-notice` + `settings-btn sm`)
  when the role holds a model that reports no `insert`, or no role is set and
  no installed model reports `insert`. Button: "Download qwen2.5-coder:1.5b for
  autocomplete" (`pull_ollama_model`, then `assignRole` once the pull resolved)
  or "Use … for autocomplete" when installed. `useModelsHub` gains
  `assignRole` (set, never toggle, against fresh settings) and `pullIntoRole`.
- Choices: "automatic mode" read as *automatic requests* (an explicit
  Ctrl+Space still falls back and names the model). The pill does not
  auto-dismiss (the 4 s timer is for `acStatus` only); typing hides it, and the
  next pause shows it again. The banner is in the overlay page only, not the
  header hover dropdown. A model with an empty capability list never triggers
  the banner.
- Tests: automatic request with role unloaded → no `complete_text`, pill,
  Load → `load_ollama_model` → request on the role model with `insert: true`,
  pill names it; Ctrl+Space falls back and names `llama3.2:3b`;
  `missingRoleModel` and `autocompleteModelAdvice` unit tests. The hub banner
  and chip are covered only through the pure function (no render test).

#### A8 — Copilot in the editor and card — `559971b89`

- Card: signed in only for `account.status` `OK`/`MaybeOK` (user present
  too); `NotAuthorized` gets "Signed in as {user}, but this GitHub account has
  no Copilot access." with Sign out (to switch accounts); a sign-in that rejects
  with `copilot_sign_in_failed` gets "The sign-in did not finish" instead of
  the generic error. A missing/unknown `account.status` reads as not signed in
  (strict reading of the plan).
- Card "Details": the shared `SettingsAdvanced` fold (its classes; unmounted
  while closed, so `copilot_diagnostics` is called only on open and on
  Refresh); lines in `pre.ollama-install-log` (the card's sibling log style);
  shown when provider is Copilot and the project consented. A backend without
  the command → "This build cannot show the server log."
- Editor: after a Copilot request that returned nothing, one
  `copilot_account` call; an outer `status.kind === "Inactive"` message shows
  as "Copilot: {message}" unless a newer request or edit happened. The
  Copilot hint uses `fileViewer.copilotControlsSingle` (no Alt+[/]) unless more
  than one candidate came back.
- Tests: new `src/__tests__/editor/CopilotCard.test.tsx` (verdicts, failed
  sign-in line, Details open/Refresh, missing command); two editor tests
  (single-candidate hint, Inactive status with exactly one account call).

#### A9 — stay signed in — `9e5a0bf3e`

- `Settings.copilot_stay_signed_in?: boolean`; a `settings-toggle-card-row`
  Toggle (copied from the consent rows) shown once the server is installed,
  plus one help line. `CopilotAccount.remembered?: boolean`: true → "This
  sign-in is remembered in the OS keychain." replaces
  `settings.copilotSessionOnly`; absent/false keeps the old note.
- Tests (card file): off by default, writes `{ copilot_stay_signed_in: true }`,
  session-only note without `remembered`; `remembered: true` swaps the note.

### Gates

Midway (`--base a70bc3e32`, after A1/A2/A3/A4/A10 work): brand, whitespace,
lint-fe, build, vitest all PASS (Rust gates skipped: no Rust change).
Final (`scripts/gates-job.sh start --base a70bc3e32`, tree at `79407dd9a`):
brand, whitespace, lint-fe, build, vitest (`--changed a70bc3e32`) all PASS;
Rust gates skipped (no Rust change). The first final run failed `npm run
build` on two type errors from earlier steps (optional `wrap` passed as a
boolean in A6; `Array.prototype.at` in two A1 tests, not in the TS lib target);
fixed in `79407dd9a`. So `f0f821c85` and `8934a0769` do not type-check on
their own; the branch tip does.

Changed-set vitest run during A5: 878 files, 8943 tests passed (the gate's
own count is not printed in its summary).

### New i18n keys (all five dictionaries; the parity test requires it)

- `fileViewer.autocompleteDelayTitle`, `fileViewer.autocompleteDelayOption`
- `fileViewer.autocompleteFrom`, `fileViewer.autocompleteRoleNotLoaded`,
  `fileViewer.autocompleteLoadModel`, `fileViewer.autocompleteLoadingModel`,
  `fileViewer.autocompleteLoadFailed`
- `fileViewer.copilotControlsSingle`, `fileViewer.copilotInactive`
- `stats.autocompleteOffers`
- `localModel.insertChip`, `localModel.insertTitle`,
  `localModel.autocompleteNoInsert`, `localModel.autocompleteNoFim`,
  `localModel.autocompleteGet`, `localModel.autocompleteUse`,
  `localModel.autocompleteDownloading`, `localModel.autocompletePullFailed`
- `settings.copilotNotAuthorized`, `settings.copilotSignInFailed`,
  `settings.copilotDetails`, `settings.copilotDetailsEmpty`,
  `settings.copilotDetailsUnavailable`, `settings.copilotDetailsRefresh`
- `settings.copilotStaySignedIn`, `settings.copilotStaySignedInHelp`,
  `settings.copilotRemembered`
- Changed text: `fileViewer.autocompleteControls` / `copilotControls` (`→` →
  `{ctrlRight}`) in all five.

The merge: other sessions hold uncommitted edits to `en.ts` and `untested.ts`
in the main checkout (per the plan); these are pure additions after existing
anchor keys.

### New UntestedTag ids (rows in `src/lib/untested.ts`)

`fileViewer.autocompleteDelay`, `fileViewer.autocompleteRoleNotLoaded`,
`localModel.insertChip`, `localModel.autocompleteAdvice`,
`settings.copilotDetails`, `settings.copilotAccountStatus`,
`settings.copilotStaySignedIn`.

### File-map rows to update (`docs/filemap_frontend.md`)

- 555 `lib/viewers/completion/autocomplete.ts`: + stepped window, `editKind`,
  `missingRoleModel`, `inlineGhostTail`, `autocompleteModelAdvice` /
  `RECOMMENDED_AUTOCOMPLETE_MODEL`, `completionModels.clear()`.
- 556 `completionContext.ts`: + frozen per-editor reads (`ReferenceReads`),
  automatic 4 KB vs explicit budgets (`referenceBudget`), `trimReferences`,
  set id (`referenceSetId`).
- new row `lib/viewers/completion/completionTimings.ts`: the 200-request
  timings ring (dev perf monitor) and `CompletionOffers` (usage keys per offer).
- 559 `ollamaCompletionProvider.ts`: + parallel start, budgets per model,
  stats event (`CompletionStats`), trigger/fileName, role rule for automatic
  requests.
- 370 `CodeEditor.tsx`: + per-frame ghost publish, inline ghost, role-not-loaded
  pill, edit-kind/IME trigger hygiene.
- 372 `editorPrefs.tsx`: + Delay choice (`autocomplete_delay_ms`), memoised `ac`.
- 243/244 `useModelsHub.ts` / `ModelsHubSections.tsx`: + `assignRole`,
  `pullIntoRole`; Fill-in chip, autocomplete-model banner.
- 446 `StatsRecap.tsx`: "accept/dismiss" → offers (shown/Tab/word/line/typed/
  rejected) plus old history.
- 651 `lib/usageMetrics.ts`: + offer and request prefixes.
- `CopilotCompletionCard.tsx` and `dev/DevPerfHost.tsx` have no row; add one
  if wanted (Details fold + stay signed in; completions table).

### Plan statements found wrong

- A6: "wrap is off" as a condition — every `CodeEditor` host (TextView,
  MarkdownView, TexView ×2) passes `wrap` unconditionally, so the inline ghost
  never renders in the app. Implemented as written (conservative).
- A1: "`StatsRecap` … `:494-503`, `:627-635` matches only the two old
  prefixes" — correct. "A parity test between the two passes only on the
  merged tree": there is no such test in the tree today (only a comment in
  `schema/usage_stats.rs`); none was added.
- A2: `completionImports` capped candidate *paths* at 16 (as the plan says);
  now 64 candidates are allowed and 16 *existing files* counted.
- Minor: line anchors had drifted by a few lines (expected).

### Click-through for the user

1. A4: TypeScript file, automatic autocomplete on: type, pause → a ghost.
   Backspace, pause → none. Tab-accept, pause → none. Ctrl+Z, pause → none.
   With an IME, nothing fires until the composition is committed.
2. A10: in the editor's AI controls, with "Auto", a Delay choice
   (100–1200 ms) sits beside it; pick 100 ms → suggestions come sooner in
   every local-model tab; switch the tab to "On request" → the choice hides.
   With Copilot serving and Auto chosen, the default reads 200 ms.
3. A3/A2: type in a long file with imports; the perf monitor (Ctrl+Alt+P) →
   Completions table: after the first automatic request, later ones show a
   short "ctx" time (no reference reads); Ctrl+Space re-reads.
4. A1: perf monitor rows show model, trigger, path (`generate`/`chat` once the
   backend lands), ms columns, prompt tokens, result. Stats recap (day view)
   shows "N shown · Tab … · rejected" per mode/model, old accept/dismiss rows
   still listed below.
5. A7: with a ghost, plain → moves the caret and the ghost goes; Ctrl+→ takes
   one word; Alt+→ a line; the hint reads "Ctrl+→: word".
6. A5: set the autocomplete role to an unloaded model, type and pause → pill
   "<model> not loaded — Load"; Load → it loads, then a ghost from it, the pill
   naming it. Ctrl+Space before loading → a ghost from another resident model,
   named. Models hub: Fill-in chip on FIM models; with a chat-only model in the
   role, the banner offers "Download qwen2.5-coder:1.5b for autocomplete" →
   download shows in Downloads, then the role moves to it.
7. A6: streamed ghosts render smoothly; a multi-line ghost (Shift+Tab to
   Block) lines up when scrolled. The syntax-coloured inline ghost cannot be
   seen yet (all editors soft-wrap; see Flagged).
8. A8: Settings → Experimental → Copilot card: an account without Copilot
   access says so (and offers Sign out); "Details" lists server log lines
   (empty/unavailable text against an old backend); a request that returns
   nothing on an inactive plan shows "Copilot: <server message>" in the editor;
   with a single candidate the hint has no Alt+[/].
9. A9: Copilot card: "Stay signed in (OS keychain)" off by default; on, sign
   in, quit, reopen → the card shows the account and "remembered" without a new
   sign-in (needs B11/B12); sign out → asks again after the next restart.

### Flagged for the user

- **A6 inline ghost is unreachable today.** All editor hosts soft-wrap. To
  make it reachable needs either an unwrapped editor or a reflow check (does
  the caret line plus the ghost still fit its wrapped rows?) that must be judged
  on screen. Product/visual decision; the commit is revertable alone.
- **A5 "automatic mode" read as automatic *requests*.** Ctrl+Space with the
  role model unloaded still falls back to another resident model (named in the
  pill). If you meant "a tab whose trigger is Auto never falls back", that is a
  one-line change in the provider.
- **A5 nagging:** the "not loaded — Load" pill reappears after every typing
  pause until the model is loaded or the role changes.
- **A5 banner** is on the Models & agents overlay page only, not in the header
  hover dropdown.
- **A7 on macOS:** Ctrl+→ (⌃→) is a Mission Control shortcut by default;
  Option+→ might suit macOS better. Not decided here.
- **A2 explicit budget** below 4 KB for a model loaded with a small context
  (< ~5.3 K tokens) is used as computed (smaller than the automatic budget).
- **A2 cost of a cache hit:** the reservation now starts with the lookup, so a
  cache hit costs one `prepare_text_completion` + `cancel_text_completion`.
- **A8:** an account reply without `account.status` reads as not signed in.
- **Recap row** (`stats.autocompleteOffers`) and the Inactive editor status
  carry no `UntestedTag` (plain text lines in existing surfaces).
- `Autocomplete.test.tsx` "automatically includes imports and refreshes
  context…" failed once in a full-file run early on (its last `invoke` was a
  `file_mtime` poll, not `cancel_text_completion`) and passed on every rerun:
  a pre-existing ordering flake, watch it.
- The commit hook prints "MOBILE BUNDLE IS STALE / EMBEDDED PWA IS STALE"; no
  `mobile-web/` file was touched. `backend:stale` not run (no Rust change).
- This handoff could not be written to the main checkout (agent isolation);
  it is untracked in the worktree at the same relative path.
