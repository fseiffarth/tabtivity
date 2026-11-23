# Local-model "what's next" suggestion — plan

> **Status: plan only** (2026-11-22). Nothing built.

## Why

Claude Code draws a likely next prompt, dimmed, in its empty input box after a
turn; Tabtivity reads it off the screen (`mobile-web/src/terminal/promptSuggestion.ts`)
into `ReaderLive.suggestion` (`src/lib/agents/readerLive.ts`), and the Chat
composer, the steering prompt box (`src/components/layout/SteeringPromptOverlay.tsx`)
and the phone composer (`mobile-web/src/screens/Terminal.tsx`, `promptSuggestion`)
offer it — Tab takes it, nothing sends it. Codex, OpenCode, Copilot,
Antigravity and Muse have no such suggestion, so the slot is always empty
there. A local model can write one from the session's last turn, which
Tabtivity already reads for the Chat view (`agent_tab_transcript`).

## Fixed decisions (user, 2026-11-22)

- **D1 Trigger:** automatically at every turn end, like Claude — only for a
  pane that is shown with an empty composer; one run per turn, cached.
- **D2 Model:** a new **Suggestions** role chip (`ollama_roles.suggest`), next to
  Autocomplete / Tabs / Mail, falling back to `ollama_model` like the others.
- **D3 Surfaces:** desktop (Chat composer + steering prompt box) **and** the
  phone (Focus chat / Terminal composer) in the same change.
- **D4 Claude tabs:** the local model fills in when Claude shows no suggestion
  of its own at turn end (its suggestions off, or it skipped one). Claude's own,
  when present, always wins.

## Rules this has to keep

- **Never leaves the machine.** Same endpoint rules as the mail assistant:
  loopback Ollama only, even with `ollama_allow_remote_host` on, and an Ollama
  cloud model (`*-cloud`, `ollama_client::model_is_local_at`) refused before the
  request (`services/mail/mail_ai.rs` `resolve_endpoint`, cloud check). A
  session is project content. The Suggestions chip is disabled on a cloud model
  like the Mail chip (`ModelsHubSections.tsx`, `cloudMail`).
- **Never sent by itself.** The transcript is attacker-controlled (project
  files, fetched pages), so the model's output is untrusted: it only fills the
  empty box as a placeholder/draft, exactly as Claude's does. One line, control
  characters and ANSI stripped, capped (~200 chars).
- **No model name from the renderer or phone.** The backend resolves the role
  itself; the command takes a tab identity, not a model, so it needs no
  `model_allowlist::MODEL_ARG` row (note that in the module doc).
- **Local-models-only projects** (`agent_privacy`): allowed — the model is local
  by the rule above.
- **Hidden panes do no work** (`PaneVisibleContext`); a dead remote session is
  not probed (gate on connected, as the transcript read already is).
- Async over a `*_blocking` body (`ollama_http` in a sync command is banned).

## Design

### Backend — `services::agent::next_prompt` (new, `AppHandle`-free)

- `prompt_for(turn) -> (system, user)`: pure and **append-only** (see Warm-up
  below). The system prompt — fixed, first — asks for the single most likely
  next message the user would type, in the user's language, or `NONE`. The user
  message is the turn: its prompt, then each recorded entry rendered once
  (tool cards one line, diffs dropped, answers in full) and never re-rendered,
  so an older prompt is always an exact prefix of a newer one. Budget ≈6k
  tokens per turn: past it, later tool entries are rendered as their one-line
  form only (decided per entry when first rendered, so the prefix holds).
- `clean(output) -> Option<String>`: pure; first line, trim quotes, strip
  control/ANSI, cap length, `NONE`/empty → `None`.
- `suggest(stores, tab, turn_key) -> Result<Option<String>, Refusal>`: resolves
  `ollama_roles.suggest ?? ollama_model`, applies the loopback + no-cloud checks
  (shared helper lifted from `mail_ai`, not copied), calls Ollama with a short
  `num_predict` (~48) and a timeout.
- **Cache + single-flight** keyed by `(session id, turn_key)`, where
  `turn_key` = id of the last answer entry. The desktop and the phone both ask;
  only one Ollama run happens per turn, the other waits for or reads its result.
  A small LRU (per session, newest turn only) — memory only.
- Refusals use the existing `not_running` sentinel and a "no model" reason, so a
  missing Ollama just means no suggestion, never an error bubble.

### Warm-up while the turn runs (user, 2026-11-22)

Ollama keeps the last prompt's KV cache per loaded model and reuses the longest
shared prefix (seen in the 2026-10-30 logs: follow-up turns hit 112 cached-out
tokens, 0.6 s). So the prompt is fed while the agent still works:

- On `transcript-changed` for a shown pane whose agent is working, debounced
  (~3 s, at most one in flight per tab), send the prompt so far with
  `num_predict: 1` and a `keep_alive` long enough to outlast a turn. Ollama
  reads only the new entries.
- At turn end the real request is the same prompt plus the final answer, with
  generation on: only the answer's tokens are read cold (≈1–3 s) plus ~1 s of
  output, instead of 5–8 s.
- The transcript sits last in the last message and the instruction in the
  system prompt, so the template's closing tokens are the only part a warm
  request and the next one do not share.
- **No warm-up while the same Ollama serves a local-model agent turn** (a
  `ollama`/local-model tab working): it would slow that agent; such tabs get one
  cold run at turn end. Cloud-model CLIs leave the GPU idle during the turn, so
  warming is free there.
- A new turn starts a new user block; only the system prompt is shared across
  turns.

Caveats to measure, not assume:
- **Hybrid / recurrent models** (Nemotron's Mamba layers) restore only
  checkpoints at or below the shared prefix and were seen forcing full
  re-processing; a warm request's generated token may push the state past the
  prefix. Expect the gain on attention-only models; measure both, and if hybrid
  models re-read every time, say so in the Suggestions chip's hint.
- Anything else on the same model (autocomplete pinned to it) evicts the cache;
  a dedicated small model on the Suggestions chip keeps its own runner, if
  `OLLAMA_MAX_LOADED_MODELS` lets both stay loaded.
- Confirm in `journalctl -u ollama` that warm requests show `cached n_tokens`
  close to the previous prompt length.

### Commands and routes

- `agent_next_prompt` (`src-tauri/src/commands/agents.rs`, beside
  `agent_tab_transcript`, same tab-identity arguments incl. `remote_host`):
  `#[cfg_attr(feature = "desktop", tauri::command)]`, async over a blocking
  body, takes `tauri_host::Ctx`. `command_class` row `client`; regenerate
  `src/lib/transport/commandClasses.ts`.
- Phone: `GET /api/v1/tabs/{tab_id}/next-prompt`
  (`services/mobile_control/host.rs`, beside `/transcript`), answering
  `{ "text": "…" | null }` — plain text only, no ids or paths. Headless (no
  window): the same service call, since it reads the transcript itself.

### Desktop frontend

- `src/lib/agents/nextPrompt.ts` (new): `useLocalNextPrompt(tab, { visible,
  idle, composerEmpty, screenSuggestion })`. Fires when the turn has ended
  (transcript's last entry is an answer and `ReaderLive.working` is null),
  keyed by the turn; for Claude only after a settle window (~1.5 s) with
  `screenSuggestion === ""`, and a later screen suggestion replaces it.
  Dropped on the first keystroke, a new turn, or a hidden pane.
- Feed it into the existing `suggestion` slot in `TerminalReaderView.tsx`
  (`ReaderComposer`'s `suggestion` prop) and `SteeringPromptOverlay.tsx`
  (`shownSuggestion`), so Tab / → take it unchanged.
- `MODEL_ROLES` gains `{ key: "suggest", labelKey: "localModel.role.suggest" }`;
  cloud models disabled for it like `mail`.
- i18n: `localModel.role.suggest` (+ the cloud-disabled title) in `en.ts` and
  the other dictionaries.
- `UntestedTag` id `agents.localNextPrompt` in `src/lib/untested.ts`, shown
  where `steering.promptSuggestions` already is.

### Phone

- `mobile-web/src/screens/Terminal.tsx`: when `readPromptSuggestion` gives ""
  (any non-Claude CLI, or Claude without one after the settle window) and the
  turn has ended, fetch `/next-prompt` once per turn and use it as
  `promptSuggestion` — the existing fill-once/clear-when-gone effect handles
  the rest. Rebuild with `npm run mobile:bundle`.

## Contract (fixed before the parallel run)

Desktop command `agent_next_prompt`, camelCase args, same identity meaning as
`agent_tab_transcript`: `agent: string`, `projectId?: string`,
`tabDir?: string`, `sessionId: string`, `localModel?: boolean`,
`remoteHost?: string`, plus `phase: "warm" | "final"`. Returns

```ts
type NextPrompt = {
  text: string | null;      // final only; null on warm or when the model says NONE
  turnKey: string | null;   // id of the turn's last entry the answer was built from
  status: "ok" | "warmed" | "skipped" | "busy" | "not_running" | "no_model" | "refused" | "unavailable";
  reason?: string;          // human text for refused/no_model, never shown as an error bubble
  model?: string;           // the model that wrote `text` (ok with text only): the "suggested by" chip
};
```

- `warm`: feed the prompt so far (`num_predict: 1`), return `warmed`; `skipped`
  when `localModel` is true (a local agent owns the GPU) or the transcript has
  no turn yet; `busy` when a request for this session is already in flight.
- `final`: build from the finished turn; the same `turnKey` returns the cached
  text without a new Ollama request; a concurrent caller waits for the
  in-flight run (single-flight per session).
- Ollama down / no model / remote host / cloud model never throw: a status.

Phone route `GET /api/v1/tabs/{tab_id}/next-prompt?phase=warm|final` →
`{ "text": string | null, "status": …, "model"?: string }` (no `turnKey`, ids
or paths; `model` beside text only, one inert capped line), the tab
resolved like `/api/v1/tabs/{tab_id}/transcript`.

Frontend side: the desktop skips `warm` while any local-model agent tab is
working; both clients call `final` once per ended turn (Claude: only after
~1.5 s settle with no screen suggestion; Claude's own replaces it later).

## Organisation

Disjoint subsystems once the contract above is fixed → **two parallel
implementers** in separate worktrees (A backend, B frontend: desktop + phone),
then **one reviewer** over the merged range; the main agent merges (cherry-pick
onto develop). Three Opus subagents in all (user, 2026-11-22).

| Agent step | Plan steps | Files |
|---|---|---|
| A backend | 1–3, backend part of 7 | `services/mail/mail_ai.rs`, new `services/agent/next_prompt.rs` (+ tests), `commands/agents.rs`, `services::command_class` + regenerated `src/lib/transport/commandClasses.ts`, `services/mobile_control/host.rs`, `model_allowlist.rs` doc line, `docs/filemap_backend.md` |
| B frontend | 4–6, frontend part of 7 | `ModelsHubSections.tsx`, `src/lib/i18n/*`, new `src/lib/agents/nextPrompt.ts`, `TerminalReaderView.tsx`, `SteeringPromptOverlay.tsx`, `mobile-web/src/screens/Terminal.tsx`, `src/lib/untested.ts`, tests, `docs/filemap_frontend.md`, `docs/context/agent_reader.md` |
| R review | whole range | bugs only, each with a regression test |

Handoff: `docs/next_prompt_handoff.md`.

## Steps

1. Lift the loopback + no-cloud endpoint check out of `mail_ai` into a shared
   helper (`ollama_client` or a small `local_only` module); mail keeps its
   wording. Tests stay green.
2. `services::agent::next_prompt`: append-only prompt builder, cleaner,
   cache/single-flight, warm-up scheduler (debounce, one in flight, skipped
   while a local-model agent turn runs), with unit tests (cleaning, `NONE`,
   injection-shaped output stays one inert line, every later prompt has the
   earlier one as an exact prefix — including past the budget, cache dedupe,
   cloud model refused, remote host refused).
3. `agent_next_prompt` command + `command_class` row + regenerated
   `commandClasses.ts`; phone route + a route test.
4. Suggestions chip (`MODEL_ROLES`, i18n, cloud-disabled).
5. Desktop hook + wiring into the Reader composer and steering box; tests
   beside `src/__tests__/agents/AgentPromptSuggestion.test.ts`.
6. Phone wiring; tests beside `src/__tests__/mobile/MobilePromptSuggestion.test.tsx`;
   `npm run mobile:bundle`.
7. UntestedTag row; file-map rows (`docs/filemap_backend.md`,
   `docs/filemap_frontend.md`); a paragraph in `docs/context/agent_reader.md`.
8. Gates (`scripts/gates-job.sh start`); `npm run backend:stale`.

## Open / measured later

- Latency on the 890M: cold, ≈1.5k prompt tokens at 230–415 t/s ≈ 4–7 s plus
  ~1 s output; warmed (above), only the final answer's tokens. Measure
  turn-end-to-suggestion with an attention-only small model and with a hybrid
  one; competes with a local-model agent tab or autocomplete on the same Ollama.
- Prompt quality per CLI (Codex answers are long; tool-heavy turns): tune the
  tail selection with real transcripts.

## Verification (manual, not run)

On Linux (X11) — then Wayland, Windows, macOS — with a local model on the
Suggestions chip:
1. Codex tab, Chat view: finish a turn → within ~10 s a dim suggestion appears
   in the empty composer; Tab takes it; typing first means it never appears.
2. Same in the steering prompt box.
3. Claude tab with its prompt suggestions turned off in `/config` → the local one appears;
   with it on → Claude's own shows, no Ollama request (`journalctl -u ollama`).
4. Phone Focus chat on the Codex tab → the same text is filled once.
5. Point `ollama_host` at a non-loopback host, or pin a `*-cloud` model →
   no suggestion, no outgoing request.
6. Hide the pane before a turn ends → no request until it is shown.
