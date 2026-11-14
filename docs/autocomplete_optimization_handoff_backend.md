# Autocomplete optimization — backend handoff

Plan: `docs/autocomplete_optimization_plan.md` (steps B1–B12), in the main
checkout. This handoff lives in the worktree (untracked, never committed):
the harness refused writes to the main checkout from this agent.

## Where

- Worktree: `.claude/worktrees/agent-a213456e0242a4cda`
- Branch: `worktree-agent-a213456e0242a4cda`
- Base: `develop` at `a70bc3e32c357046e072aab18050b71b4f474b4b`
- Cargo target: the worktree's own `target/` (as `scripts/gates.sh` uses),
  `CARGO_INCREMENTAL=0`.

## Steps

### B1 — `855013f7e` owner gate and policy block
- New pure `completion_endpoint(settings, locked, project_id, model, refusal,
  gate)` in OL; `complete_text` runs settings load, `completion_locked`, it,
  and the real `completion_refusal`/`owner_gate` in one `rt::try_blocking`,
  uncached, before `text_completion::client()`.
- Test `a_completion_asks_the_owner_gate_before_it_connects` (beside
  `the_owner_gate_judges_loopback_listeners_only`): refusing gate + bound
  nonblocking listener → `ollama_listener_refused`, `accept` is `WouldBlock`;
  a locked refusal comes before the gate.

### B2 — `b65190571` keep the leading newline
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

### B7 — `59bc7c238` stats event
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

### B8 — `b75adb437` live bench (ignored)
- `completion_bench` in `ollama/tests.rs`; env var
  `crate::app_env!("COMPLETION_BENCH_MODEL")`. Fails with a clear message when
  the model is not in `/api/ps` (verified). Reads `insert` from `/api/show`.
  Answers run to the final record (no sentence stop, `num_predict` 24, seed 1)
  so the counts arrive.

### B3 — `7df932017` FIM gate
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

### B4 — `fc56f404c` chat prompt order
- `Language / [prose line] / references / AFTER / BEFORE / TASK`.
- Rewrote the two order assertions (now `ollama/tests.rs`
  `completion_prompt_includes_prefix_suffix_and_language` and
  `completion_prompt_labels_before_and_after_sections`); added
  `completion_prompt_puts_the_task_last`.

### B5 — `b22003a2d` sampling
- `completion_body` options: `temperature 0.1, top_k 1, repeat_penalty 1.0,
  presence_penalty 0`; new `sample_candidate(body, candidate)` sets the seed
  and, for alternates, temperature 0.5 and removes `top_k`.
- Test `completion_sampling_has_no_penalties_and_a_greedy_first_candidate`.

### B6 — `cd3c91095` time budget
- `complete_text` takes `trigger: Option<String>`; only `"auto"` is budgeted.
- `budget_cut(mode, since_first_token, text)`: budget Sentence 1.5 s / Block
  3 s / Scope 6 s; cut at the last line break (the break itself and a `\r`
  before it excluded, so the ghost ends on a complete line) when non-blank text
  precedes it. Checked only on non-final records. The final text gets the
  same cut (`complete_lines_end`), stats `stop: "budget"`.
- Choice: "cut after its last line break" read as "keep the complete lines,
  drop the break" so no dangling empty line lands before the suffix.
- Test `the_time_budget_cuts_after_complete_lines_only`.

### Follow-up fixes found by the gates
- `5abb96a16` clippy `needless_lifetimes` on `capped_references` (B3).
- `a7404f158` `core_dispatch::USER_CONFINED` row for `complete_text.fileName`
  (`BodyConfined`: a prompt label, never opened). The coverage test
  `every_path_named_core_argument_is_classified` demanded it (B3).
- `5f4f97af4` `src-tauri/examples/copilot_probe.rs` passes the new
  `launch_installed` log argument (B9).

### B9 — `4d074196b` Copilot fixes (+ `autocomplete_delay_ms`)
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

### B10 — `c67757d28` pin bump
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

### B11 — `31aa8b5c5` stay signed in
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

### B12 — idle shutdown
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

## B8 bench

Ollama 0.40.16. `/api/ps` before the run: empty. Pulled `qwen2.5-coder:1.5b`
(`/api/pull`, success; capabilities `completion, tools, insert`). Loaded it and
`gemma4:e4b` by hand for the runs, unloaded both with `keep_alive: 0` after.

Finding: on this Ollama, `prompt_eval_count` counts the whole prompt even when
the prompt cache was reused; `prompt_ms` (prompt_eval_duration) is what shows
the reuse.

### Before B3/B4 (develop's gate and prompt order)

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

### After B3–B6 (second run)

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

### The `qwen2.5-coder` row stays

Evidence: with references, every request of the trace went `generate` with
`raw: true`, and the answers are the same quality as the no-reference run
(see the table). Expected per the plan: FIM with and without references —
met. The chat-path expectation (second request reads tens of tokens) is met on
qwen2.5-coder through chat before B3 (33 ms vs 436 ms) but not on gemma4:e4b.

### Raw tables

#### b8_before_qwen
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
#### b8_before_gemma
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
#### b8_after_qwen
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
#### b8_after_gemma
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



## B10 probe

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

## Gates

See the end of this file (final run).

## File-map rows to update

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

## Plan statements found wrong

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

## Flagged for the user

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

## Gates (final run, HEAD `039a7b317`, `--base a70bc3e32`)

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
