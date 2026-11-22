# CLI overview — plan

Status: implemented 2026-10-28 (uncommitted, never live). Desktop side panel
view + phone Home section.

## Why

Each agent CLI's account state is spread across places: Claude's 5-hour and
weekly windows show only inside one Reader tab's facts row or the phone's
per-tab status sheet, Codex's only in a Codex tab's transcript, and the
subscription plan nowhere. The user wants one overview of the CLIs in use:
plan, signed-in account, usage windows with reset countdowns, open tabs.

## Fixed decisions

1. **Desktop placement: a new side panel view, `clis`** (user's choice,
   2026-10-28), beside Files/Git/Apps/Agents/Tabby, with its rail entry from
   the same `SIDE_PANEL_VIEWS` table. Available in every scope: the data is
   per account, not per project. Separate from the Agents view because that
   one is the *scope's* tabs and prompts.
2. **Phone: a Home section** (`CliOverviewSection`), the Local models
   section's twin: one row with a caption, opening a sheet with the cards.
3. **One backend reading, `services::cli_overview`**, AppHandle-free:
   - *Plan*, read from Tabtivity's own login store copies
     (`agent_auth::store_path_in`), never from an agent home: Claude
     `.claude/.credentials.json` → `claudeAiOauth.subscriptionType` +
     `rateLimitTier`; Codex `.codex/auth.json` → the `id_token` JWT payload's
     `https://api.openai.com/auth.chatgpt_plan_type` (+ `…active_until`). Only
     those fields leave the function; no token is ever returned or logged.
     Other CLIs: no plan ("not reported").
   - *Claude windows*: the existing `agent_usage` panel read (client-side,
     zero quota, 60 s cache, refresh floor 10 s) — passed on raw and parsed by
     `shared/usageReport.ts` like everywhere else.
   - *Codex windows*: the newest `token_count.rate_limits` in the newest
     rollouts across every agent home (`.codex/sessions/Y/M/D/rollout-*.jsonl`,
     via `home_io`, no symlinks, at most 6 files tail-read), through
     `agent_transcript::codex_usage`. Carries the rollout's mtime as
     `read_at`; a window whose `resets_at` has passed is dropped by the reader
     (`sessionLimits`), never shown as still-used.
   - *Account*: `agent_auth::status()`'s `account` (desktop only).
4. **Which CLIs are listed**: every registry CLI that is signed in, has a
   plan or limits reading, or (desktop) has an open tab. Nothing else.
5. **Phone route is sidecar-answered**: `GET /api/v1/clis[?refresh=1]` runs
   `cli_overview` in the sidecar process itself, with or without a window —
   no `DesktopRequest`, no `MobileBridgeHost` case. The phone row omits the
   account (an e-mail address) and anything path-shaped (`mobileUsageText`
   rule applied in Rust: the raw Claude panel is filtered the same way).
6. **Pacing**: read when the view/sheet opens and every 5 minutes while it is
   visible (hidden-pane gate: `PaneVisibleContext` on desktop); ⟳ forces a
   re-read, still floored by `agent_usage::REFRESH_FLOOR`.
7. **Plan names** are formatted from the raw values in one shared function
   (`shared/cliOverview.ts` `planLabel`): `max` + `…_max_5x` → `Max 5x`,
   `pro` → `Pro`, `plus` → `Plus`; an unknown value is title-cased, never
   dropped.
8. `UntestedTag` rows `clis.overview` (desktop) and `mobile.clis` (phone).

## Steps

1. `src-tauri/src/services/agent/cli_overview.rs` (+ `services/agent/mod.rs`,
   `services/mod.rs` re-export): types `CliPlan`, `CliLimits`, `CliOverviewRow`;
   `claude_plan(bytes)`, `codex_plan(bytes)`, `codex_limits_in(state_dir)`,
   `rows_in(state_dir, logins)`; unit tests (plan parsing, JWT decoding,
   newest rollout wins, passed rollouts skipped, symlink not followed).
   `agent_transcript::codex_usage` becomes `pub(crate)`.
2. Command `agent_overview(refresh)` in `commands/agents.rs`: blocking part
   on `spawn_blocking`, then `agent_usage("claude", refresh)` when Claude is
   signed in. Registered in `lib.rs`, `command_class` row (`Core`, like
   `agent_usage`), `commandClasses.ts` regenerated.
3. `shared/cliOverview.ts`: wire types, `planLabel`, `overviewMeters(row,
   now)` (Claude: every parsed meter; Codex: `sessionLimits`).
4. Desktop: `components/agents/CliOverviewView.tsx` + CSS; `FilesPanelView`
   gains `"clis"`; `SIDE_PANEL_VIEWS` row + `RailClisIcon`; render in
   `ProjectFilesView`; open-tab counts from the tabs store (`cmd` →
   `cmdToKind`).
5. Phone: `mobile_control/cli_overview.rs` (route handler + sanitising) and
   one `.route` line in `host.rs`; `mobile-web/src/api.ts`
   `getCliOverview`; `mobile-web/src/screens/CliOverviewSheet.tsx`
   (section + sheet) mounted in `Home.tsx`.
6. i18n keys in `en.ts` (`cliOverview.*`, `mobile.clis.*`), filemap rows,
   `docs/context/usage_stats.md` paragraph, untested rows.

## Organisation

Main loop, no subagents (none were asked for). Small, mostly additive:
one backend service, one view, one sheet.

## Verification

Gates per `scripts/gates.sh`. Live (not run here): open the side panel →
CLIs: Claude shows `Max …` with two bars and countdowns; Codex shows its plan
and, after one Codex turn anywhere, its windows with the "as of" time. Phone:
Home → CLIs row → sheet with the same cards, no e-mail address.
