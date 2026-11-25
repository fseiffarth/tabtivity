# Continue in a new session (same CLI, optional summary) — plan

> **Status (2026-11-24):** planned and built in one pass; not live-tested.
> Extends "Continue with another CLI" (`docs/done/cli_session_handoff_plan.md`,
> `services::agent_cli_handoff`, `components/agents/CliHandoffDialog.tsx`).

## Why

A long session resent on every turn is the expensive part of agent work: the
median Claude session here ends at 166k–230k context tokens, a fresh one starts
at ~57k (system prompt, tools, instructions). Continuing the work in a fresh
session of the **same** CLI from the chat text saves about 65% per request.

## What the research settled (2026-11-24, three read-only agents)

Measured from ~400 local Claude transcripts (token fields only):

- 99.7% of cache writes use the 1-hour lifetime; Tabtivity already reads it per
  tab (`agent_transcript::PromptCache {lastAtMs, ttlSecs, contextTokens}`).
- Returns after the cache expired: ~0.5% of long-session turns, but about one
  per three sessions. Cold is a normal case, not an edge case.
- A summary turn asked while warm costs about two ordinary turns; cold, about
  ten times that.

Options rejected:

- **Memory kept current every turn** (hook nudge): +7–20% on every turn of every
  long session, paid whether or not the session is ever continued; agents skip
  such nudges; per-CLI hook work beyond Claude/Codex.
- **Local-model summary:** minutes of prefill on the 890M under load; loses paths,
  exact errors and rejected alternatives, can state things that never happened.
  At most later: an opt-in summary of only the turns the file omits.
- **Automatic summary before the cache expires:** with a 1 h lifetime it fires
  for nothing almost every time.
- **Summary at the limit notice:** a limited session cannot answer.
- **Summary written as a file by the agent:** a write outside the project would
  stall on the CLI's permission prompt. The summary is a chat answer instead.

## Design

1. **Same-CLI target (default for the tab menu).** The dialog's targets include
   the source's own CLI, labelled "<CLI> (new session)", preselected when opened
   from the tab menu. The usage-limit notice keeps excluding it (a fresh session
   hits the same limit). Menu entry renamed "Continue in a new session…". Same
   `HANDOFF.md`, no model call; the bootstrap prompt says "an earlier <CLI>
   session".
2. **Optional summary while the cache is warm.** When the preview reports the
   source's prompt cache with at least 2 minutes left (Claude, Codex) and the
   dialog was not opened from a limit notice, a checkbox "Ask <CLI> for a
   summary first" shows (on by default) with the minutes left.
   - Continue sends the source tab one prompt (`sendSteeringPrompt`) carrying a
     random marker `[handoff-summary <nonce>]`: reply with a summary, no tools.
   - The dialog polls `agent_cli_handoff_prepare` (preview only, with
     `summaryNonce`) every 3 s until the preview reports `summary: true` and the
     source tab is not busy, then prepares for real and opens the tab.
   - The backend finds the prompt holding the marker and takes the answers after
     it, up to the next prompt (`MEMORY_CAP_CHARS`, middle cut). That prompt and
     its answers leave the recent conversation, whose budget drops to 16 KiB.
     The section is headed as the previous agent's own unchecked claims, fenced.
   - After 3 minutes without one, the dialog says so and Continue goes on from
     the chat text alone. A failed send unticks the box and says why.
3. **Cold cache, limit, no cache data, local model:** no checkbox; the dialog
   says the summary is not offered because the cache has expired (when it has).

## Steps

- **Backend** (`agent_cli_handoff.rs` + tests): `Request.summary_nonce`
  (checked: 8–32 hex chars), `Gathered.summary`, `Preview.summary` and
  `Preview.cache`; render section; smaller budget; target label "(new session)"
  wording only in the UI. Command takes `summary_nonce: Option<String>`.
- **Frontend:** `cliHandoff.ts` (request field, nonce, warm check),
  `CliHandoffDialog.tsx` (targets, checkbox, wait state), `CliHandoffMenuItem`
  label, i18n in all five locales, untested row `agent.cliHandoffSummary`.
- **Docs:** `docs/context/agent_sessions.md` section, file-map rows.

## Verification (by hand, never run live by the agent)

1. Claude tab, a few turns, idle < 1 h → tab menu → Continue in a new session…
   → the checkbox shows minutes left → Continue: the source tab answers the
   summary prompt, then a new Claude tab opens and reads `HANDOFF.md`, whose
   "Summary" section holds that answer.
2. Same with the box unticked: no prompt reaches the source; the new tab opens
   at once.
3. A tab idle > 1 h: no checkbox, the cold-cache line shows.
4. Limit notice: the source's CLI is not offered and there is no checkbox.
