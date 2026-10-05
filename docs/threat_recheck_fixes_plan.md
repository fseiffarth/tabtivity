# Threat-model recheck fixes (2026-10-04)

Fixes for gaps 8–14 of `docs/threat_model.md` ("Gaps found 2026-10-04"),
filed as #2342–#2348 in `todo/group-o-security.md` (section "Threat-model
recheck follow-ups (2026-10-04)" — read that section for each item's detail).
One fresh implementer per step, then a reviewer; steps run one after another.
Progress and hand-over notes go in `docs/threat_recheck_fixes_handoff.md`.

Rules for every step: other sessions edit the same tree (markup tick work in
`mobile_control/host.rs`, `markup_mcp.rs`, `usePdfMarkup.ts`, …) — edit around
their uncommitted hunks, never revert, stash, checkout or commit. Never start
the app. Backend edits: finish with `npm run backend:stale` and report it.
Each fixed gap: tick its todo entry ("**Fixed 2026-10-04 (not live).** …"), and
in the threat model mark the gap row "**Fixed, not live-verified.**" and
adjust the rows that cite it.

| Step | Todo | Gap | Area | Fix |
|---|---|---|---|---|
| 1 | #2342, #2343 | 8, 9 | `services::api_proxy`, `services::api_prices` | Charge Gemini grounding per search query at the documented rate; reserve each request's worst-case cost before forwarding (settle on finish) so requests in flight count against the monthly limit. |
| 2 | #2344 | 10 | `services::git_push_mcp` | An approved push sends `<approved sha>:refs/heads/<b>`, never the branch by name; same for Apply's own plan. Keep fast-forward-only and every existing refusal. |
| 3 | #2345 | 11 | `services::markup_rounds` | Undo restores only paths under the project folder; changes elsewhere in the work tree are left alone and named in the result. |
| 4 | #2346 | 12 | `services::mobile_control::{outbox,inbox}` | Drop-box reads and listings go through held directory handles (`openat(O_NOFOLLOW)` per component, as `files.rs`); Windows keeps its handle-based path. |
| 5 | #2347 | 13 | `brand_migration::project`, `update_exclude`, remote exclude script | Refuse a non-regular `.git/info/exclude` (and a symlinked `info/`); write without following links. |
| 6 | #2348 | 14 | `mobile_control` revoke/narrow, held prompts, `scheduler` | Revoking a phone, narrowing its access or Lock down cancels the prompts it held and the schedules it made for scopes it lost. |
| 7 | #2349 | 15 | `commands::git::run_git` and callers | Found in step 5's review: a FIFO ignore/attributes file hangs git. Bounded timeout (reap the child subtree) on background and window-path git calls; refuse non-regular `info/exclude`/`.gitignore`/`.gitattributes` where cheap. |

Final: full gates (`AGENTS.md` → Gates) and `backend:stale`.
