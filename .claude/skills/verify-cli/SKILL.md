---
name: verify-cli
description: Re-verify a new version of a CLI the app wraps (Claude, Codex, OpenCode, Antigravity, any registry agent, or another third-party TUI) by running the real binary outside the app beside the previous one. Use when a CLI released, updated, or drifted from its verified version, or the user asks to check, verify or support a new CLI version.
argument-hint: "<cli> [new version]"
---

A verification **round** checks one CLI's new version against everything the
app assumes about it, by running the real binary next to the last verified
one. Tests pin the app's parsers to sample output. Only the real binary shows
what it prints now. The round is done when every assumption in the CLI's
checklist section is **confirmed**, **fixed**, or **reported unverified**.

Two references, read as each step needs them:

- `docs/third_party_update_checklist.md`: what the app assumes, per CLI (find
  the section with `rg -n '^##'`; §1 applies to every agent CLI).
- `scripts/verify-cli/README.md`: how to run a binary for those checks (generic
  driver, stubs, frame replay, per-CLI deep probes).

## Steps

1. **Detect drift.** Run `cargo run --example agent_versions --manifest-path
   src-tauri/Cargo.toml`. It prints installed against verified versions. Settle
   the old and new version for each CLI in the round. The old one is the
   `VERIFIED` row in `services/agent/agent_versions.rs`, not whatever is
   installed. Done when you can name both versions.

2. **Fetch both binaries without installing.** Use an npm tarball (`npm pack`),
   the agent install's `versions/` dir, or a release asset. Put each in its
   own directory under `tmp/verify-cli/<cli>/bin-<version>/`. Make
   self-updating CLIs (Antigravity) read-only there. Never install or update
   the user's copy, because Manage CLIs owns that. Done when `<bin> --version`
   prints the expected version for both.

3. **Read what changed upstream.** Read the release notes or changelog for
   every version between old and new, not just the newest. Then run
   `flags.sh` for both versions and `diff -ru` the two `flags/` folders. Mark
   every assumption in the checklist section that a change could touch. Done
   when you have that list.

4. **Run the probes on both versions.** Use the CLI's deep probes if
   `scripts/verify-cli/` has them. Otherwise use `tui.py` with steps that
   reach each screen the checklist names: approval prompt, model picker,
   status line, resume, sign-in. Use a stub model wherever a call must be
   forced or a turn would cost money. Run the same probe on the baseline:
   something that fails on both versions is an old bug, not a regression.
   Done when each marked assumption has frames or output from both versions.

5. **Replay and compare.** Run `parsers/frames.probe.ts` with `VERIFY_OLD` and
   `VERIFY_NEW` set. Open both frames for every differing field outside
   `live.screen`/`live.context`. Run the section's **Verify** commands
   (`cargo test …`, `npx vitest run …`) as well. Done when every difference has
   a verdict: TUI changed and the reader still right, or the reader is wrong.

6. **Fix what broke.** Fix it where the checklist's **Where** points, and add a
   test next to the existing ones, built from the new frame or payload. Fix
   any old bug the round turned up in the same code. Done when the new
   version reads right and the gates for the touched areas pass
   (`scripts/gates.sh`, backgrounded).

7. **Bump the verified version, all copies in one change.** That means the
   `VERIFIED` row(s) in `agent_versions.rs` (one row per checked surface:
   Codex has several), `FRONTEND_VERIFIED` in
   `src/stores/agents/agentVersionNotice.ts`, the `drift("<cli>", …)` test's
   version, the "verified against" code comments, and the checklist prose. A
   test ties `FRONTEND_VERIFIED` to `VERIFIED`. The rest drift silently. After
   backend edits, run `npm run backend:stale`.

8. **Extend the harness when the round needed something new.** A probe script
   you wrote for this CLI goes into `scripts/verify-cli/<cli>/`, with a
   docstring, no hardcoded paths, and names from `common.py`. Add a line to
   the README for it. The next round starts from it.

9. **Report.** Give every assumption's verdict, everything fixed (with the
   test that holds it), everything left unverified and why, and the exact
   steps the user should click through in a real tab. That covers what only
   a window shows: the Chat card, the phone, a sign-in, a restore after
   restart. Say plainly that the round ran outside the app and not live.

## Traps

- A binary run inside an app tab inherits that tab's identity variables. Run
  it only through these scripts, which unset them, never bare in your own
  shell.
- `rm -rf` on a computed path gets refused. Make fresh dirs per run instead,
  or use literal paths.
- `/tmp` is a small tmpfs. Keep binaries and captures under `tmp/verify-cli/`.
- A CLI with no deep probes and no checklist section still gets steps 1–5 and
  7–9. Add its section to the checklist as part of the round.
