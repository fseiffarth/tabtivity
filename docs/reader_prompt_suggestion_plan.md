# Reader: show Claude's prompt suggestion — plan

Status: implemented 2026-10-24 on develop (uncommitted at the time of writing),
never live. Probed on Claude Code 2.1.310.

## Goal

Claude Code, after a turn, offers a **prompt suggestion**: the likely next
message, drawn dimmed in its empty input box (Tab accepts it there). In the
desktop Reader's Chat view the box is hidden behind the Reader's own composer,
so the suggestion was invisible. Show it in the chat, one click to fill the
composer.

## What the CLI does (probed, not guessed)

Driven in a pty under a scratch `CLAUDE_CONFIG_DIR` (a throwaway login copy,
deleted after), replayed through `@xterm/headless`, 100×30, after
"Create a small python script hello.py … tell me what to do next":

```
27 ❯ make it ask for my name         ← ❯ row, text after the marker
      ..dddd dd ddd ddd dd dddd      ← cell.isDim() on every suggestion char
cursor 2 27                          ← the cursor sits at the START of the text
```

- It is **not** in the session transcript (no record type carries it), so the
  transcript-driven Chat cannot see it; it exists only on the screen.
- Source (2.1.310 bundle): `promptSuggestion: { status: "generated", text }`,
  set by `suggestDraft` only when the draft is empty and no turn is loading;
  any keystroke in the box resets it (`promptSuggestion.reset()`). Disabled by
  the `promptSuggestionEnabled` setting (`false` = off) and after a streak of
  unused suggestions (`promptSuggestionUnusedStreak`).
- A typed draft is drawn **not dim**, so dim-after-the-marker tells a
  suggestion from a draft. The empty box's own hints are dim too and must be
  excluded: `Try "…"` (the example placeholder) and `Press up to edit queued
  messages`.

## Design

1. `mobile-web/src/terminal/promptSuggestion.ts` — `readPromptSuggestion(lines,
   agentLabel)`: pure, over `readableScreen` lines (spans carry the `d` class).
   Claude only; the input row found with `inputFrameStart`; the row must be
   `❯` + text, **every** non-blank span after the marker dim, and the text not
   one of the box's own hints. Returns the text or `""`.
2. `lib/agents/readerLive.ts` — `ReaderLive.suggestion` filled in the
   no-dialog branch (a dialog replaces the box), compared in `sameReaderLive`.
   The phone's Focus chat reads the same lines (`Terminal.tsx`
   `promptSuggestion`, Focus view only, idle, no dialog): a "Claude suggests"
   row in the `/` menu's look over the empty field; a tap fills the field,
   never sends (2026-10-25, `MobilePromptSuggestion.test.tsx`).
3. `TerminalReaderView.tsx` — `ReaderComposer` gets `suggestion`; a one-row
   panel in the slash menu's look (`terminal-reader-slash*` classes — copy the
   working sibling, no new CSS) shows it above the box while the composer is
   empty and idle. Click **only fills** the composer (the user still sends,
   edits, or ignores it) — never auto-sent. Typing anything hides it: it is
   the CLI's suggestion for an empty box.
4. `UntestedTag` `terminal.reader.promptSuggestion` + register row; strings in
   `i18n.ts` and the four dictionaries.

## Non-goals

- Not accepting through the CLI's own Tab (the composer fills; sending goes
  through the normal `sendSteeringPrompt`, so queueing/held-prompt logic is
  unchanged).
- No setting: if the user turns suggestions off in Claude, nothing is drawn
  and the panel never shows.
- Codex/OpenCode/Gemini: their placeholders are not suggestions; Claude only.

## Tests

`src/__tests__/agents/AgentPromptSuggestion.test.ts`: the captured screen
(dim mask as probed) → the text; a typed (non-dim) draft → none; `Try "…"` and
the queued hint → none; a dialog on screen → none; non-Claude label → none;
`readReaderLive` carries it and `sameReaderLive` notices a change.

## Live check (for the user)

Open a Claude tab in Chat mode, let it finish a turn so the terminal view shows
a dimmed suggestion; switch to Chat: the panel "Claude suggests" appears above
the composer with the same text. Click: the text lands in the composer. Type a
letter: the panel goes. Setting `promptSuggestionEnabled: false` in Claude:
never appears.
