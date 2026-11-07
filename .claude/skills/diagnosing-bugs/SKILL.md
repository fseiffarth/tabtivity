---
name: diagnosing-bugs
description: Diagnosis loop for hard bugs and performance regressions. Use when the user says "diagnose"/"debug this", or reports something broken, throwing, failing, freezing or slow.
---

<!-- Adapted for Tabtivity from mattpocock/skills@4ae2317
     skills/engineering/diagnosing-bugs (MIT, see ../THIRD_PARTY_NOTICES.md). -->

# Diagnosing bugs

A discipline for hard bugs. Skip a phase only with a stated reason.

Before reading code, open the subsystem's file in `docs/context/` (`ls` it)
and grep the file maps for the files involved.

## Redact

Write `<REDACTED>` for every secret in commands, output and captured logs;
pass credentials through env vars. Quote only the lines that carry the signal.

## Phase 1: build a feedback loop

**This is the skill.** With a **tight** loop that goes **red** on this bug,
the cause will be found; without one, staring at code will not find it.

The user's running window holds their live tabs: the loop runs beside it,
never through starting, stopping or restarting it. Ways, roughly in order:

1. **Failing test** at the seam that reaches the bug —
   `cargo test -p tabtivity --lib <name>` (`services/` is `AppHandle`-free so
   it is unit-testable), `npm test -- <file>` for the frontend, a source-scan
   test for a rule the code must keep.
2. **Daemon build**: `cargo test -p tabtivity --no-default-features --lib`
   when the bug may differ without Tauri.
3. **Engine question** (does WebKitGTK really do X?): an offscreen
   `WebKit2.WebView` via `python3-gi` loading the real `src/styles/*.css`,
   reading values back with `evaluate_javascript`. Measure; specs and MDN
   have been wrong for this engine.
4. **Wrapped CLI behaviour** (Claude, Codex, OpenCode…): a stub or captured
   transcript replayed through the parser, in project `tmp/` (gitignored).
5. **Replay a captured artifact**: a saved JSON state file, event log or
   PTY byte stream fed through the code path in a test.
6. **Bisection**: `git bisect run <loop>` inside a **git worktree**, never in
   the shared checkout — other sessions edit it; never stash or switch
   branches there.
7. **Differential**: the same input through two versions or two configs,
   diffed.
8. **Human in the loop**, last resort: give the user numbered click steps in
   their running window and say exactly what to report back (text of an
   error, a screenshot, a yes/no). `src/` hot-reloads; `src-tauri/` does not —
   after backend edits run `npm run backend:stale` and report it. Cross-OS
   bugs: ask for the platform's result, since local runs are Linux only.

Then **tighten** it: faster (narrow the test filter), sharper (assert the
user's exact symptom, not "didn't crash"), more deterministic (pin time, seed
randomness, use a tempdir). Flaky bug: raise the reproduction rate (loop it,
add stress, narrow the timing window) until it is debuggable.

No loop possible: stop, list what was tried, and ask for an environment, a
redacted artifact (log, core dump, `scripts/crash-symbolize.sh` output,
screen recording), or permission for temporary instrumentation.

**Done when** you can name one command, already run with its output shown,
that is red-capable on the user's symptom, deterministic, takes seconds, and
runs unattended (or is the structured human step above). No such command, no
Phase 2 — reading code to build a theory first is the failure this prevents.

## Phase 2: reproduce and minimise

Confirm the loop shows **the user's** failure, not a neighbour's, and
capture the exact symptom. Then cut inputs, config, state and steps one at a
time, re-running after each, until every remaining element is load-bearing.

## Phase 3: hypothesise

Write 3–5 ranked, falsifiable hypotheses: "If X is the cause, changing Y
makes it disappear." Show the list to the user before testing (they often
re-rank instantly); proceed with your ranking if they are away.

## Phase 4: instrument

One variable per probe, each tied to a hypothesis. Debugger first, then
targeted logs tagged with a unique prefix (`[DEBUG-a4f2]`) so cleanup is one
`rg`. **Performance**: baseline first — `scripts/perf-numbers.sh` from a host
shell (an agent fence hides host processes), timing in a test, or the dev
perf monitor — then bisect. Measure, then fix.

## Phase 5: fix and regression test

Write the regression test **before** the fix, at a seam that exercises the
real bug pattern. If the only seam is too shallow to replicate it, record
that as a finding instead of a false-confidence test.

1. Turn the minimised repro into a failing test; watch it fail.
2. Fix; watch it pass.
3. Re-run the Phase 1 loop on the original scenario.
4. Run `scripts/gates.sh` (in the background).

## Phase 6: cleanup

- [ ] Original repro no longer reproduces.
- [ ] Regression test passes, or the missing seam is documented.
- [ ] `rg '\[DEBUG-'` is empty.
- [ ] Throwaway harnesses deleted or kept in project `tmp/`.
- [ ] The confirmed hypothesis is in the commit message
      (`fix(<area>): …`), so the next debugger learns it.
- [ ] Not verified live? Say so, and give the user the click steps.
