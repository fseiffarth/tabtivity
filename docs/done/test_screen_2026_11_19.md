# Faulty-test screen — 2026-11-19

> **Status (screened against code 2026-11-22):** ARCHIVE. Every item was fixed on 2026-11-19 (`d4886c0e3`): `test_util::skip_or_fail` + `CI_REQUIRE_TOOLS` in
> `src-tauri/src/test_util.rs` and `.github/workflows/ci-cd.yml`. Open: nothing but running the suites on all three OSes in CI. Not live-tested unless the doc/todo says so.

A read-only screen of the test suites for tests that pass while the behaviour
they name is broken, never run, or fail for reasons unrelated to the code.
Three agents, one per slice: TS `src/__tests__/{mobile,shell,terminal,agents}`;
the rest of `src/__tests__` plus `scripts/`, `mobile-web/`, `shared/` and the
include glob; Rust (`src-tauri`, `src-core`, `src-gateway`, `src-serverd`).
Heuristic grep/scan first, then the hits read against the code under test.
~85 TS files and ~40 Rust files read closely; no full suite or cargo run.
Screened on the working tree at `4cf65018d` plus uncommitted edits.

All items below were fixed on 2026-11-19 (test code and CI only, plus a
behaviour-identical `ruleset_attr()` split in `fence_scope.rs`). Deviations
from the suggested fixes: the Landlock kernel test still skips below ABI 6
(CI kernels are older), with a no-kernel test of the ruleset it asks for
instead; `MobileSwCacheName` builds into the project `tmp/` rather than moving
to a gate script; tool-gated tests fail rather than skip on the `test-ubuntu`
job through `test_util::skip_or_fail` and its `CI_REQUIRE_TOOLS` list, and the
Python tests run in `security.yml`'s workflows job. "Confirmed" = read and verified; "plausible" = the
mechanism is real but no failure was reproduced.

Clean: no `.only`/`.skip`/`.todo`, no empty or assertion-free tests, no
unawaited `resolves`/`rejects`/`waitFor`/`findBy`, no swallowing try/catch, no
unreachable Rust test modules, every test-like TS file matches the vitest
include glob, `src/test-setup.ts` and `helpers/testGuards.ts` sound, the
`emptyAgentTab` deletion leaves no references. The existing source-scan guards
(git, projects, browser, CSP, TextSafety, FileMove, NoTailwind) are not vacuous.

## Tier 1 — pass while the guarded property is broken

- [x] **TeX confinement tests skip on every CI OS** — confirmed.
  `src-tauri/src/commands/tex/tests.rs:200-360`
  (`a_hover_preview_runs_no_shell_command_even_where_the_default_allows_it`,
  `a_hover_preview_reads_only_below_the_document`,
  `a_build_engine_run_confines_luatex_writes`) `return` with an `eprintln` when
  no TeX engine is on PATH, and also when the engine ignores
  `shell_escape`/`openout_any` (lines ~236, ~351). `ci-cd.yml`'s apt lists
  install no TeX; macOS/Windows runners have none. A dropped `NO_SHELL_ESCAPE`
  / `OPENOUT_PARANOID` / paranoid-input env would stay green.
  Fix: install `texlive-latex-base` on the Linux job and `panic!` instead of
  `return` when `CI` is set; or assert on the constructed env/args.
- [x] **Frame-message validator loop accepts-or-skips** — confirmed.
  `src/__tests__/mobile/MobileMarkupQuestionsCard.test.tsx:172-173`:
  `if (accepted) expect(keys…) else expect(accepted).toBeNull()`. Only the last
  `bad` entry (extra `html` key) may be accepted; `acceptFrameMessage`
  (`mobile-web/src/markup/frameProtocol.ts:110`) could start accepting page 4
  of 3, `w: -1`, `NaN`, `"10"`, a fractional id or too many rects and the test
  passes. Fix: `toBeNull()` for each bad entry; the `html` case gets its own
  `toEqual` with the stripped shape.
- [x] **`update_settings` is not a command** — confirmed.
  `src/__tests__/root/RootOverlay.test.tsx:305` and
  `src/__tests__/remote/VpnTerminalHandoff.test.ts:113` assert it was never
  invoked; the store invokes `save_settings` (`src/stores/settings.ts:565`).
  Fix: assert on `save_settings`.
- [x] **`mail_send` is not a command** — confirmed.
  `src/__tests__/mail/MailAgentDrafts.test.tsx:101`; the send command is
  `mail_draft_send` (`src/lib/mail.ts:749`). "✓ only files the draft" passes
  even if ✓ sent. Fix: assert on `mail_draft_send`.
- [x] **Negative query on text that exists nowhere** — confirmed.
  `src/__tests__/root/OverlayAgentColumn.test.tsx:171`:
  `queryByText("Shown in the root console")` — no such string in `src/` or
  `en.ts` (only `overlayAgent.shownInPopout`). Fix: assert the real console
  state (e.g. the pane's test id is absent).
- [x] **"Hides a pill once stamped" tests its own fixture** — confirmed.
  `src/__tests__/shell/UntestedRegistry.test.ts:30-38` asserts the `tested`
  field it just set; `isUntested` (`src/lib/untested.ts:1259`) is never called
  on a stamped row, and `isUntested(first.id) === !first.tested` restates the
  implementation. Fix: run a stamped row through the real function and expect
  `false`.
- [x] **DST checks only run in Europe/Berlin** — confirmed.
  `src/__tests__/agents/AgentSchedule.test.ts:56-63`: gap/fold asserts sit in
  `if (zone === "Europe/Berlin")`; CI sets no `TZ`. Fix: pin `TZ` at module
  top with a canary and `skipIf` on Windows, as
  `AgentPromptTimelineDst.test.ts` does.
- [x] **Two Python test files never run** — confirmed.
  `scripts/test_gate_job.py`, `scripts/test_fresh_vm.py`: no CI step,
  `gates.sh` or npm script runs them (`security.yml` runs only
  `test_codeql_reviewed.py`; also noted in
  `docs/whole_project_screen_2026_11_12.md:94`). Both pass by hand (4 and 28
  tests). Fix: add `python3 -m unittest discover -s scripts -p <file>` next to
  the CodeQL step, or to `gates.sh`.

## Tier 2 — skips and coverage holes

- [x] **More tool-gated silent skips** — plausible.
  - `src-core/src/services/fence_scope.rs:155-205`
    `the_scope_refuses_outside_abstract_sockets_only` returns when
    `abi() < SCOPE_ABI` (Linux ≥ 6.12); runner kernel unverified.
  - `src-tauri/src/services/mobile_control/pty_bridge.rs:2056-2075`
    `keeping_dim_appends_once_and_never_overwrites_the_users_entries` returns
    without tmux (not in the apt lists; real-tmux counterparts are `#[ignore]`).
  - `src-tauri/src/services/iso9660.rs:321-325` — the only `isoinfo`
    cross-check of the Rock Ridge reader.
  - `src-tauri/src/commands/mobile_control.rs:1900-1920`
    `python3_and_jq_give_the_same_answers` asserts nothing with neither tool.
  - `src-tauri/src/commands/ollama/tests.rs:2008-2050`
    `prepare_local_agent_integration_if_ollama_running` depends on a live
    Ollama and its models; not `#[ignore]`d.
  Fix: install tmux/genisoimage on the Linux job and fail on `CI=1` when a
  required tool is missing; `#[ignore = "needs a running Ollama"]`; for the
  Landlock test also unit-test the built ruleset.
- [x] **Asserts only inside `if let`** — plausible.
  `src-tauri/src/commands/agents.rs:2966-2976`
  `an_npm_installed_agent_checks_the_package_it_installs`. Fix: count compared
  pairs, `assert!(compared > 0)`.
- [x] **Chained npm installs unchecked** — plausible.
  `src-tauri/src/commands/agents.rs:2857-2875` only checks commands starting
  `npm install -g`. Fix: check any command containing it.
- [x] **Lane-token scan misses non-`pub` consts** — plausible.
  `src-tauri/src/services/root_mcp/tests.rs:839-850` uses
  `strip_prefix("pub const ")`; a `pub(crate) const FOO_TOKEN_ENV` escapes
  `LANE_TOKEN_ENVS`. Fix: match `const <NAME>_TOKEN_ENV` after any visibility.
- [x] **Path filter on the absolute path** — plausible.
  `src-tauri/src/services/agent/agent_privacy/tests.rs:551-556` skips any file
  whose absolute path contains `tests` (a checkout under such a dir → false
  red; `foo_tests_helper.rs` skipped). Fix: filter relative to `src/` by stem.
- [x] **Weak "stores nothing" check** — confirmed, low.
  `src/__tests__/security/HardenPrototype.test.ts:57-60` only asserts
  `not.toThrow`, and `setter?.` passes when there is no accessor. Fix: assert
  the setter is a function and nothing was stored.
- [x] **"Renders nothing" asserted before the answer lands** — plausible.
  `src/__tests__/system/ServerSecrets.test.tsx:27-33`: the component is also
  empty while loading (`ServerSecrets.tsx:106`). Fix: wait for the settled
  state before asserting empty.
- [x] **Negatives on removed class names** — confirmed. Each
  `querySelector(".x")).toBeNull()` names a class no longer in `src/` or
  `mobile-web/src`, so it passes whatever the UI does:
  `BarHiddenStrip.test.tsx:77` (`.bar-hidden-chip`),
  `BoxRendering.test.tsx:505` (`.project-box-member-count`),
  `BoxRendering.test.tsx:528,1390` and `BoxUx.test.tsx:364` (`.box-fold-pill`),
  `BoxSearch.test.tsx:172` (`.project-box-badge`),
  `BoxSheet.test.tsx:101` (`.box-editor-target`),
  `assistant/AssistantView.test.tsx:192` (`.assistant-chat-row`).
  Fix: delete, or assert the replacement element.
- [x] `tests/no_foreign_config_writes.rs` scans only `src-tauri/src`, not
  `src-core/src` where services are moving.

## Tier 3 — flakes and isolation

- [x] **Tight real-timer sleeps** — plausible.
  - Steering tests' `settle()` (60 ms real sleep, e.g.
    `SteeringConfirm.test.tsx:42-45`, ~45 uses in `SteeringOverlays`) vs the
    50 ms `placeCursorSoon` retry (`src/hooks/useSteering.ts:227`).
  - `src/__tests__/pdf/PdfZoomRaster.test.tsx:236-243`: 60 ms sleeps against
    the 120 ms commit window (`PdfViewer.tsx:161`).
  - `src-gateway/src/broker/tests.rs:127-131`: fixed 100 ms sleep before the
    usage assert; the file's `month()` helper polls up to 2 s.
  - `src-tauri/src/services/api/api_proxy/tests.rs:610-625`: trickle test's
    `elapsed < idle * 3` (already a known load flake).
  Fix: `waitFor` / fake timers advanced by multiples of the production
  constant; poll until the deadline.
- [x] **Sleep-then-"nothing happened" negatives** — plausible. Only meaningful
  while the sleep exceeds the production timer:
  `MobileLocalUnlock.test.tsx:127,161,193`,
  `SessionPickerRemembered.test.tsx:97,158`,
  `MobilePromptSuggestion.test.tsx:195`. Fix: fake timers past the constant
  imported from the source.
- [x] **Unlocked env mutation in parallel lib tests** — plausible.
  `src-tauri/src/services/browser_engine.rs:1755-1761` (`HTTPS_PROXY`, not
  needed: reqwest adds the system proxy matcher anyway) and
  `src-tauri/src/services/mcp/git_push_mcp.rs:2410,2429,2436,2536`
  (`<APP>_GIT_TOKEN`, `HOOK_ALWAYS`, `HOOK_EXIT`). Two token tests can remove
  each other's var, making the "token not leaked to the hook" check pass
  trivially. Fix: drop the `browser_engine` set; pass env on the hook
  `Command` via a seam, or one shared env mutex.
- [x] **Two full `vite build`s inside a unit test** — plausible.
  `src/__tests__/mobile/MobileSwCacheName.test.ts:55` (180 s timeout,
  `os.tmpdir()` — tmpfs fills). Fix: move to a build-time gate script.
- [x] **Fake timers without try/finally or `afterEach` restore** — confirmed,
  low. `PdfMarkupViewer.test.tsx:283-298`, `MachinesView.test.tsx:171-177`:
  one failure cascades into timeouts in the rest of the file.
- [x] **Fixed temp dir** — plausible, low.
  `src-tauri/src/services/openvpn/tests.rs:328` (`<tmp>/<slug>-mgmt-detect`).
  Fix: `tempfile::tempdir()`.

Minor, no action: `MobileDiverged.test.ts:78` and `AgentCronRun.test.ts:12-13`
spy on `console.*` without restore (vitest isolates files). Bare `#[ignore]`s
at `copilot/session.rs:1132`, `api_proxy/tests.rs:790,824`,
`server/vault/tests.rs:611` carry doc comments explaining them.
