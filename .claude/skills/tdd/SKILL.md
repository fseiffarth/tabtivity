---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

<!-- Adapted for Tabtivity from mattpocock/skills@4ae2317
     skills/engineering/tdd (MIT, see ../THIRD_PARTY_NOTICES.md). -->

# Test-driven development

TDD is the red → green loop. This is the reference that makes it produce
tests worth keeping. Every section applies on every cycle.

Read the subsystem's `docs/context/` file first so test names use the
project's vocabulary.

## What a good test is

Tests verify behaviour through public interfaces, not implementation
details: a good test reads like a specification and survives refactors.
Examples: [tests.md](tests.md); mocking: [mocking.md](mocking.md).

## Seams: where tests go

A **seam** is the public boundary you observe behaviour at. Here, usually:

- a `services::` function (`AppHandle`-free by rule), tested in its module's
  `#[cfg(test)] mod tests` or its `tests.rs`;
- a Tauri command's wire shape (camelCase keys) through a mocked
  `@tauri-apps/api/core` `invoke` (see `src/__tests__/agents/SkillsTarget.test.ts`);
- a component rendered with Testing Library under `src/__tests__/<area>/`;
- a sidecar route in `services::mobile_control` for phone features.

**Test only at agreed seams.** Before writing a test, propose the seams
with AskUserQuestion — recommended first, each with one line on what it
catches and what it misses. No test at an unconfirmed seam.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private
  helpers, or verifies through a side channel. It breaks on refactor while
  behaviour is unchanged.
- **Tautological**: the expected value is recomputed the way the code
  computes it. Expected values come from an independent source: a literal, a
  worked example, a recorded fixture.
- **Horizontal slicing**: all tests first, then all code. Work in vertical
  slices: one test → one implementation → repeat, each a **tracer bullet**.

## Rules of the loop

- **Red before green.** Watch the test fail for the right reason, then write
  only enough code to pass it.
- **One slice at a time.** One seam, one test, one minimal implementation.
- **Refactoring belongs to review** (`/code-review`, `/simplify`), not the
  loop.
- **Done** when every agreed seam has a passing test and
  `scripts/gates.sh` passes (run it in the background).
