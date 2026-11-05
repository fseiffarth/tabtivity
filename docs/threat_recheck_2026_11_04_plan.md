# Threat recheck 2026-11-04 — fix plan

Gaps 74–104 of `docs/threat_model.md` ("Gaps found 2026-11-04"). Evidence, line
numbers (as of `b3abe5ba`) and each reviewer's suggested fix are in
`docs/threat_recheck_2026_11_04_handoff.md`. Scope chosen by the user on
2026-11-05: **all 31 gaps**, run with the plan → plan review → implementer and
reviewer batches → final review routine (at most five subagents). Steps are not
written yet; this file holds the decisions they must follow.

## Decisions (user, 2026-11-05)

| Gap | Decision |
|---|---|
| 74 bundle import | **Reset to defaults.** Import keeps only descriptive registry keys: `auto_connect` and `key_auth` stripped from the primary and every worker, the container imported off with `dockerfile`, `image` and `spec_source_hash` cleared (so enabling it runs the O#143 confirm), push and schedule levels reset to their defaults. The import report lists what was reset (as `vpnDropped` does). |
| 75 signed mail parts | **Show only the signed part.** A `multipart/signed` root needs exactly two children, the second signature-typed, or the verdict is Unusable (same in `encrypted_part_bytes`); when valid, the pane renders only children[0], never parts beside it. |
| 76 key re-import | **Drop Verified on change.** A re-import whose user-ID set differs from the stored one resets the key to unverified, and the import result says why. |
| 77 limit hand-off | **Never silent, quote the line.** Remove the "never ask" auto-switch; the dialog always asks and quotes the screen line that triggered it. |
| 78 Tabby `@` + web | **Strip URLs after an attachment.** Once a chat has an attachment, that tab's fetches lose query strings and fragments and URL paths are capped; the assistant home also denies the CLI reading the home's login files (check that `@` honours the deny). |
| 79 shell commands to the phone | **Restore the AGENTS.md rule.** Strip running-shell command lines again (bring back `empty_shell_commands`); the phone shows the description plus a "view in Terminal" link. |
| 80 hands-free voice picks | **No voice on permissions.** Voice never answers a dialog that grants a permission or saves a rule; other numbered questions show "Heard: N" and get the same chime-and-cancel window a dictated prompt has. Headset mode ignores a segment that began while the voice was reading (unless it is a barge-in). Desktop and phone. |
| 81 phone model/effort | **Per tab only.** The phone changes only the live tab (types `/model` into it); saved launch defaults are set on the desktop only. The phone's `PUT …/launch-defaults` route goes away. |
| 89 push card dismissal | **Ask the remote.** Confirm with `git ls-remote` (off the UI thread) before settling a card as already pushed; a dismissed card stays listed with its reason until cleared. |
| 91 imported private key bind | **Confirm, stay unverified.** Record whether a secret key was generated here or imported; binding an imported one asks a confirm that names the risk and leaves it unverified until the fingerprint is ticked. |
| 93 probes on the real `$HOME` | **Own home for probes.** `/usage`, `--version`, the warm-up and updates run with a Tabtivity agent home holding the stored login; Update refuses a CLI outside Tabtivity's install home and says so. |
| 99 tmux dim override | **Append, don't overwrite.** Append the override (or take a free index) once per tmux server; the phone rows say attaching sets a tmux option. |
| 103 branches that need a card | **main/master always.** The remote's default branch, `main`, `master` and any branch a release workflow triggers on always get a card at Apply. |
| — daily release check | **Add a switch, on by default** (Models & agents). Off: checks run only on a click. |

## No decision needed

The other gaps take the fix named in their threat-model row: 82, 83, 84, 85, 86,
87, 88, 90, 92, 94, 95, 96, 97, 98, 100, 101, 102, 104. Also from the recheck:
drop the three obsolete `zip` ignores (RUSTSEC-2026-0367/-0368/-0369) from
`.github/workflows/security.yml`.
