# Reader Files view: a Links section and native steering — plan

Status: plan, reviewed 2026-11-10. Nothing built; no code changed.

Part of one run with `docs/reader_diffs_steering_plan.md` (the **umbrella**: the
shared mechanism, Agent steps, Organisation, Base dependency, blocking
questions). This plan owns the **Links section** (agent step A1) and **steering
inside the Files view** (agent step A5). Handoff log:
`docs/reader_steering_handoff.md`.

## Why

- The Files tab (`terminal/TerminalReaderFiles.tsx`) lists the files the
  displayed conversation names. The other thing an agent hands over is a
  **web link** (a claude.ai artifact, a GitHub PR or CI run, docs). Today a
  link is only reachable by scrolling the Chat for it.
- The Files view is mouse-only. Steering's Inside level knows terminals and
  documents (`documentScroll`), not a Reader view with a list and a viewer.

## Fixed decisions

### The user's (reviewers may not undo them)

U1. Enter inside Files stays "Work here", exactly as today (so does Diffs). The
    earlier "Files claims Enter", Shift+Enter/Ctrl+Enter design and `claimsWork`
    are dropped.
U2. **Opening is `o`** (`viewOpen`): a file opens as a tab, Shift+`o` in a new
    subwindow (consistent with Diffs); a link opens through the Chat's confirm
    (Shift+`o` the same). The viewer pane's file is shown with `v`
    (`viewOpenAlt`, "Show here"); the cursor starts on the file already shown, so
    `o` straight away opens "the picked file".
U3. The shared mechanism is the umbrella's: `src/lib/agents/readerSteering.ts`
    (`registerReaderInside`, `useSteeringInside`, `key(action, e) →
    "handled" | "leave" | "pass"`), the `inside` binding scope and the generic
    actions `viewToggle` z, `viewMode` u, `viewOpen` o, `viewOpenAlt` v,
    `viewNew` n. Files uses `viewOpen` and `viewOpenAlt` (own legend labels);
    z/u/n are swallowed. i18n namespace `steering.readerFiles.*`;
    `steering.level.scrollFiles` is the umbrella's. No new rebindable action.
U4. Shared conventions: ↑/↓ walk items, ↑ on the first item → leave (not on key
    repeat), Shift+↑/↓ a bigger step (Files: jump Files↔Links), ←/→ scroll the
    content — **Files claims ←/→ itself** (`terminalScroll.readerList` only
    matches Chat and Diffs, so an unclaimed ←/→ would wheel the hidden xterm).
U5. The earlier open questions, answered: moving the cursor previews nothing;
    links pasted in prompts are included, marked "You"; no kind chips; no in-app
    preview of links (open only after the Chat's own confirm); a phone Links
    group and a row context menu are follow-ups, not in this run; the tab keeps
    the name "Files".

### Links

1. **A link is what the Chat shows as clickable, nothing else.** No second
   parser. The Chat's links come from `renderMarkdown` (Markdown links and bare
   `http(s)://` / `www.` autolinks, none inside code), run through `answerHtml` /
   `promptHtml` (`mobile-web/src/terminal/answerMarkdown.ts`), whose allowlist
   keeps `data-href` only where `chatLinkUrl` accepts it (absolute http/https,
   no user:password, host in punycode; it returns `url.href`). The extractor
   renders each message the same way and reads `.md-link[data-href]`, so the
   section and the Chat can never disagree.
2. **Scope = the displayed conversation**, as the file list (session, open
   subagent, earlier chat; same `scopeNote`), but read from the Reader's
   **`turns`** (`transcriptTurns(levelEntries)`, `TerminalReaderView.tsx`
   l.~1880), not the raw entries, and only the turns the Chat draws through
   `PromptText` / `AnswerText`: `kind === "prompt"` without a `command`, and
   `kind === "answer"` without `questions`. `agent` (a subagent card, plain
   text), `interrupted` and slash-command dividers show no clickable links in
   the Chat, so they have none here. A link the user pasted in a prompt counts.
3. **Dedupe and order match the files list**: newest message first, within one
   message first mention first, first sighting wins. Key = `href` without its
   `#fragment`. Capped at the newest 100 rows.
4. **A row shows the target, never only the label.** Line 1: host (without
   `www.`, punycode as `chatLinkUrl` returns it) in bold, then path + query dim,
   middle-truncated. Line 2 (small): the Markdown label when it differs from the
   address, then who wrote it (You / Agent) and the message's time (`turn.stamp`).
   `title` = the full address. A label such as
   `[https://bank.example](https://evil.example/x)` never stands in for where the
   link goes.
5. **Click / `o` = the Chat's own open path**: `TerminalReaderView`'s `onOpenUrl`
   prop, which `TerminalView` wires to `openLinkRef` (`routeLink` by tab locality
   → the "Open link?" confirmation naming the exact URL → `open_external_url`; a
   remote tab's loopback link is forwarded, a container's refused). No
   `linkTarget.ts` route: the Chat does not use it for agent links, and
   `routeUri` would send an agent link to the in-app browser's reader mode, a
   fetch the Chat never makes. Without `onOpenUrl` the Links section is not
   drawn.
6. **Open only, no preview.** The right pane keeps the picked *file*; a link has
   no pane. Previewing means fetching a page an agent (which may have read
   anything) named: a request out with the user's IP, a tracking or exfiltration
   channel. So also no favicons, no title or Open Graph lookup, no prefetch, no
   `<a href>` in the DOM (rows are `<button>`s, so nothing navigates, prefetches
   or leaks a referrer on its own).
7. **Tab and empty state.** The tab keeps its name "Files". It is enabled when
   there is a file *or* a link (`onFilesKnown(hasFiles || hasLinks)`). Empty
   text: "has not named any file or link yet". The "Files" and "Links" headings
   appear only once both exist; with only files the list looks as it does today.
   Only links: the viewer pane says links open in the browser after asking.
8. **Phone**: `SentFilesIndex` has no list of links. The extractor lives in
   `mobile-web/src/terminal/chatLinks.ts` so a later phone commit can add a
   "Links" group (opening through `LinkSheet`). **Not in this run.**

### Steering inside Files

9. **Keys** (defaults; all rebindable through the umbrella's actions):
   - **↑ / ↓** (E/D, arrows): previous / next row of **Files then Links** as one
     list (headings skipped). ↑ on the first row → `leave` (to the tabs; not on
     key repeat — `handled`). ↓ on the last stays.
   - **Shift+↑ / Shift+↓**: first row of the previous / next *section* (Files ↔
     Links); an empty section is skipped; with one section nothing moves.
   - **← / →** (S/F): scroll the picked file's viewer half a screen back /
     forward (Shift: a whole screen); nothing for a picture or a viewless file.
   - **`o`**: file → open as a tab (the ↗ button, `onOpenTab(entry, false)`;
     nothing for a viewless file, as the button is hidden); link → `onOpenLink`
     (asks first). **Shift+`o`**: file → new subwindow (`onOpenTab(entry,
     true)`); link → same as `o`. Ignored on key repeat.
   - **`v`**: file → show it in the viewer pane (`onPick`, a row click); link →
     nothing. **z, u, n**: swallowed.
   - **Enter** = Work here, **Space** = prompt box, **1–9** answer a question,
     **Esc** leaves steering — all unchanged (`work`/`agentPrompt` → `pass`).
10. **The cursor is the view's own state**, a *key* (path or URL), not an index
    (the list grows while the agent talks). Drawn with `.steer-cursor` driven by
    React, `aria-current`, `data-steer-row` for tests; shown only while
    `useSteeringInside(steerId)`. Effective cursor = `cursor ?? startKey` (the
    shown file's row, else the first row); a cursor whose row vanished snaps to
    the start. Moving it opens nothing (a PDF per keypress is too heavy). The
    row scrolls into view (`scrollIntoView({block:"nearest"})`, guarded for
    jsdom).
11. **Hidden panes do nothing**: the view registers its target only while
    `visible && steerId` (`PaneVisibleContext` rule) and drops it on hide or
    unmount. No "active" callback and no extra pill in the view: the
    `steering.readerFiles` pill sits in the cheat-sheet heading.

## Steps (commit units, in order)

Steps F1–F3 are agent step **A1** (shippable alone: Links without steering);
F4–F7 are agent step **A5** (after the umbrella's A3 has landed); F8 is split
across both.

1. **F1 Pure extractor.** New `mobile-web/src/terminal/chatLinks.ts`:
   `chatLinksOf(turns: readonly {kind; text; stamp?; command?: unknown;
   questions?: unknown}[], max = 100): ChatLink[]` (structurally a
   `TranscriptTurn[]`), `ChatLink = { url, host, rest, label?: string, from:
   "you" | "agent", at?: string }`. Keep a turn only per decision 2; skip text
   with no `/https?:\/\/|www\./i` before rendering. Per kept turn: `prompt` →
   `promptHtml(text)`, `answer` → `answerHtml(text)` into a detached
   `<template>`; for each `.md-link[data-href]` (outermost only, which
   `answerHtml` guarantees) take `chatLinkUrl(data-href)`; `label` = its text
   when it is not itself an address (`/^(https?:\/\/|www\.)/i`). Walk turns
   newest to oldest, links within a message in document order, dedupe by `href`
   minus fragment. A module-level `Map<"kind|text", ChatLink[]>` (bounded,
   ~500) memoizes the per-text render so a live transcript does not re-render
   every message each tick.
2. **F2 Reader wiring** (`TerminalReaderView.tsx`, next to `readerFiles`,
   l.~2355): `const readerLinks = useMemo(() => onOpenUrl ? chatLinksOf(turns) :
   [], [turns, !!onOpenUrl])` (`turns` is declared above, l.~1880). `hasFiles` →
   `hasItems = readerFiles.length > 0 || readerLinks.length > 0` for the
   `onFilesKnown` effect (rename the local, keep the prop name). Pass
   `links={readerLinks}` and `onOpenLink={onOpenUrl}` to `TerminalReaderFiles`.
   `filesOffered` / `learnPaths` untouched. (`steerId` is plumbed by the
   umbrella's S4.)
3. **F3 Links section UI** (`TerminalReaderFiles.tsx`): new props `links`,
   `onOpenLink`; a second `role="listbox"` group under the file list in the same
   `.terminal-changes-files` column (rows `<button role="option">`, `LinkIcon`
   from `components/common/icons/Icon`), headings per decision 7, empty/pick
   texts, `<UntestedTag id="terminal.reader.links" />` on the Links heading.
   CSS in `src/styles/subwindows.css` beside `.terminal-changes-files` (l.~3476;
   reuse its row rules; add `.terminal-files-link` two-line layout,
   `.terminal-files-heading`). No new global state.
4. **F4 Scoped scroller.** `src/lib/shortcuts/documentScroll.ts`: pull the
   breadth-first search into `largestScroller(root: HTMLElement)` (also returns
   `root` itself if it scrolls and nothing below does), export it, plus
   `scrollBox(box, pages)` shared with `scrollDocument`. The Files target scrolls
   `largestScroller(.terminal-files-viewer)`, never the list column (which also
   scrolls). Existing behaviour of `documentScroller` unchanged.
5. **F5 Pure steering model.** New `src/lib/terminal/readerFilesSteer.ts`: `type
   Row = {kind:"file", key:string} | {kind:"link", key:string}`; `rowsOf(files,
   links)`, `stepCursor(rows, cursorKey, delta)` (a key, or `"out"` for ↑ on the
   first row), `jumpSection(rows, cursorKey, delta)`, `startKey(rows,
   pickedPath)`, and `decide(rows, cursorKey, action, mods)` → `{ cursor?:
   string; effect?: "show"|"openTab"|"openTabNew"|"openLink"|"scroll"|"out";
   pages?: number }` where `action` is `up|down|left|right|viewOpen|viewOpenAlt`
   and `mods = { shift, repeat }`. No React, no DOM: this is what the unit tests
   drive.
6. **F6 Component glue** (`TerminalReaderFiles.tsx`): `cursor` state; an effect
   registers `registerReaderInside(steerId, { view: "files", key })` while
   `visible && steerId`, whose `key(action, e)` runs `decide`, applies
   `setCursor`, and performs the effect through the props (`onPick`,
   `onOpenTab`, `onOpenLink`) or the scoped scroller; `work`/`agentPrompt` →
   `pass`; other actions → `handled`; `"out"` → `leave` (`handled` on repeat).
   Rows wear `steer-cursor` / `aria-current` / `data-steer-row` per decision 10.
7. **F7 Legend rows and strings.** In the umbrella's "Inside Files" block of
   `STEERING_KEYS` (`src/lib/shortcuts/shortcuts.ts`; `when: "inFiles"`, levels
   `["scroll"]`): `up/down` pair `steering.readerFiles.walk`; `up/down` pair
   with `shift: true` `steering.readerFiles.section`; `left/right` pair
   `steering.readerFiles.scroll` (own labels — a second row with the document
   row's `actions|labelKey` would duplicate a React key in the cheat sheet);
   `viewOpen` `steering.readerFiles.open`; `viewOpenAlt`
   `steering.readerFiles.show`. Every `.desc` starts "In Files, …". The umbrella
   provides the conditions (`inFiles`), the `intoReader` row and the ladder
   label `steering.level.scrollFiles`. Cheat-sheet pill `steering.readerFiles`
   beside `steering.scroll` (`ShortcutHelpOverlay.tsx`).
8. **F8 Docs and register.** Filemap rows (below), `docs/help/keyboard.md` (a
   short "Inside the Reader's Files" list next to the umbrella's Inside Diffs
   list), one line in `docs/context/agent_reader.md` (Links = the Chat's
   clickable links; open-only rationale), `src/lib/untested.ts` rows, and a
   `todo/group-s-agents.md` entry with a 🖐️ manual box plus the four platform
   child pairs (`Linux (X11)`, `Linux (Wayland)`, `Windows`, `macOS`; tick only
   where checked). A1 does the Links parts, A5 the steering parts.

## i18n (English in `src/lib/i18n/en.ts`; de, es, fr, it get the same keys)

A1 (anchor: after `terminal.readerFiles.close`):
- `terminal.readerFiles.filesHeading` "Files"
- `terminal.readerFiles.linksHeading` "Links"
- `terminal.readerFiles.linksList` "Links this conversation names"
- `terminal.readerFiles.linkOpen` "Open this link in your browser (asks first)"
- `terminal.readerFiles.linkFromYou` "You" / `...linkFromAgent` "Agent" (reuse the
  Chat's role labels if they are already keys; grep first)
- `terminal.readerFiles.onlyLinks` "No file named yet. A link opens in your
  browser once you confirm."
- Changed values (all locales): `terminal.readerFiles.empty` and
  `terminal.reader.filesNone` become "...any file or link yet".

A5 (anchor: just before `steering.scroll.label`; the umbrella's A4 uses the
anchor after `steering.scrollOutDocument.desc`):
- `steering.readerFiles.walk.label` / `.desc` "Walk files and links" / "In
  Files, move the highlight through the files, then the links; up from the first
  row goes back to the tabs."
- `steering.readerFiles.section.label` / `.desc` "Files / Links" / "In Files,
  jump to the first row of the other section."
- `steering.readerFiles.scroll.label` / `.desc` "Scroll file" / "In Files, half a
  screen up or down the shown file; with Shift, a whole screen."
- `steering.readerFiles.open.label` / `.desc` "Open" / "In Files, open the file
  in a tab (Shift: in a new subwindow), or open the link (it asks first)."
- `steering.readerFiles.show.label` / `.desc` "Show here" / "In Files, show the
  file in the viewer beside the list."

No literal app name anywhere (`brand-check.sh`).

## Untested register (`src/lib/untested.ts`)

- `terminal.reader.links` (A1) — area `agents`: Agent pane · Files tab · Links
  section under the files: the web links the conversation names (target host and
  path, newest first); click/O asks first, then opens in the browser; nothing is
  fetched.
- `steering.readerFiles` (A5) — area `lib`: steering · Inside the Reader's Files
  view: ↑/↓ walk files and links, Shift+↑/↓ jump sections, ←/→ scroll the
  viewer, O opens the file in a tab (Shift: new subwindow) or the link (asks
  first), V shows the file in the viewer; Enter stays Work here.

## Tests (vitest, `src/__tests__/`)

- `terminal/ChatLinks.test.ts` (pure): bare URL, `www.` autolink, Markdown link,
  label ≠ target (label kept, target wins), link inside a code block absent,
  `javascript:` / `file:` / user:password / relative refused, punycode host,
  fragment dedupe, order (newest message first, first mention first), prompt vs
  answer `from`, an `agent` / `interrupted` / command / `questions` turn
  skipped, the 100 cap, cache returns equal rows.
- `terminal/ReaderFilesLinks.test.tsx`: both headings when both exist, none when
  files only; a click calls `onOpenLink` with the exact URL; no `a[href]` in the
  list and `fetch` never called; links-only state; section absent without
  `onOpenLink`. Extend `TerminalReaderView.test.tsx`: the Files tab is enabled by
  a link alone and `onOpenUrl` receives the URL.
- `terminal/ReaderFilesSteer.test.ts` (pure): `stepCursor` clamps, ↑ on the first
  row is `"out"`, `jumpSection` skips an empty section, the cursor key survives
  rows being added above it, `decide` maps `viewOpen` / Shift+`viewOpen` /
  `viewOpenAlt` per row kind, repeat ignored.
- `shell/SteeringReaderFiles.test.tsx` (modelled on `SteeringScroll.test.tsx`;
  the tabs store holds an active tab whose `scope:key` is the `steerId`, the
  steering store is `active/level: "scroll"`): ↓ on an agent tab whose Reader
  shows Files enters Inside *without* scrolling the xterm; E/D move the
  highlighted row; `o` calls `onOpenTab(.., false)`, Shift+`o` `(.., true)`, `v`
  calls `onPick`, `o` on a link calls `onOpenLink`; Enter is Work here (leaves
  steering, opens nothing); ←/→ move the viewer box's `scrollTop`; ↑ at the first
  row returns to the tabs (held ↑ does not); no target registered when
  `visible` is false; the legend lists the Files rows.
- `SteeringScroll.test.tsx` additions for `largestScroller(root)`.
- Shared legend/binding tests live in the umbrella (no new action here).

## Filemap rows to update (`docs/filemap_frontend.md`, one line each)

- `terminal/TerminalReaderFiles.tsx`: add "Links section (the Chat's clickable
  links, open-only through `onOpenUrl`); steering target while Inside".
- new `mobile-web/src/terminal/chatLinks.ts`: "`chatLinksOf`: the conversation's
  web links read from `answerHtml`/`promptHtml` output (the set the Chat makes
  clickable); newest first, deduped; shared by the desktop Files view (phone
  later)".
- new `lib/terminal/readerFilesSteer.ts`: "pure cursor/row/action model for the
  Files view's steering".
- `lib/shortcuts/documentScroll.ts`: "`largestScroller(root)` also scopes to an
  element".
- `lib/shortcuts/shortcuts.ts` / `steeringBar.ts`: covered by the umbrella's
  rows.

## Verification

Gates (AGENTS.md): `scripts/gates.sh` in the background (frontend only: `npm run
build`, `npm test`, `npm run lint`, `scripts/brand-check.sh`; no Rust touched).
`git diff --check`. Zero new lint warnings, no new `any`.

Manual (never run live by an agent; give the user these):
1. Open an agent tab, have the agent print a claude.ai artifact link, a GitHub
   PR link and a file path. Reader → Files: the file under Files, the two links
   under Links with host and path, newest first, each once.
2. Click a link: the "Open link?" box names the exact URL; Cancel opens nothing;
   confirm opens the browser. Confirm no network request left before that.
3. Steering (the mode chord) → ↓ into the Files view: the legend shows the Files
   rows and "Inside Files". E/D walk files then links; Shift+D jumps to Links and
   Shift+E back; `V` shows a file; S/F scroll a long Markdown file; `O` opens the
   file as a tab; Shift+`O` in a new subwindow; `O` on a link asks first (the
   box is an overlay region: its keys walk it, Enter confirms). Enter leaves
   steering with the keys in the view. ↑ on the first row returns to the tabs;
   Esc leaves steering.
4. `Tab` Inside Files cycles to Terminal (and Shift+`Tab` to Diffs); the level
   stays Inside.
5. Check on Linux (X11), Linux (Wayland), Windows, macOS (todo child pairs).
6. A remote project tab: a `localhost:` link forwards, not opens this machine's
   port.

## Uses the shared mechanism (replaces the earlier "Depends on" guesses)

Reconciled with the umbrella (2026-11-10):

- D1 (the Reader view is the Inside target, ahead of the xterm): the umbrella's
  scroll-branch hook (S3) asks `readerInsideFor(pty)` first; Chat and Terminal
  views keep today's behaviour.
- D2 (registry): `lib/agents/readerSteering.ts`, not
  `lib/shortcuts/steeringReader.ts`; the target is `{ view: "changes" | "files";
  key(action, e) }`, results `"handled" | "leave" | "pass"` (this plan's earlier
  `"out"` is `"leave"`); keyed by the `TerminalView` id passed down as `steerId`.
- D3 (legend feed): `SteeringLegendState.reader = { view }`, conditions
  `inChanges` / `inFiles` / `intoReader`, `ladder({ reader })` — the umbrella's.
- D4 (level transitions): `Tab` re-targets Inside; `releaseTerminalScroll` is not
  involved for a Reader target (its `moved`/`owed` sets stay empty).
- D5 (Enter claim): **dropped** (user decision U1).
- D6 (cursor drawing): the view's own, `.steer-cursor`; a mouse press still
  resets steering to the tabs.
- D7 (conventions): U4 above.
- D8 (view-switch keys): `Tab` is resolved before the target is asked; Files
  never sees it.
