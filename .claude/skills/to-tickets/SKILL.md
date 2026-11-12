---
name: to-tickets
description: Break a plan (docs/*_plan.md) or the current conversation into tracer-bullet work items with blocking edges, written as numbered entries in the matching todo/<group>.md.
disable-model-invocation: true
---

<!-- Adapted for Tabtivity from mattpocock/skills@4ae2317
     skills/engineering/to-tickets (MIT, see ../THIRD_PARTY_NOTICES.md). -->

# To tickets

Break a plan into **tickets**: tracer-bullet vertical slices, each naming
the tickets that **block** it, written into `todo/`.

## 1. Gather context

Work from the conversation, or the plan path passed as an argument (read it
whole — plans are short). Grep the file maps for the files it names.

## 2. Draft vertical slices

- Each ticket cuts a narrow but **complete** path through every layer it
  needs (service, command + `command_class` row, store/UI, i18n, tests) and
  is verifiable on its own — usually one commit.
- Each fits one fresh context window.
- Prefactoring (extracting a shared component, a `pub(crate)` helper) comes
  first, as its own ticket.
- **Wide refactors** (a rename across the codebase) go expand → migrate in
  batches → contract, each batch its own ticket blocked by the expand.

## 3. Quiz the user

Show the numbered breakdown: title, blocked by, what it delivers. Ask with
AskUserQuestion whether the granularity, the blocking edges and any
merge/split are right. Iterate until approved.

## 4. Write the entries

Item numbers are global and never reused. Find the next one:

```bash
rg -no '^[0-9]+\. \*\*' todo/*.md | sed 's/.*:\([0-9]*\)\..*/\1/' | sort -n | tail -1
```

Pick the matching `todo/<group>.md` (`ls todo/`). Those files run 50–160 KB:
find the spot with `rg -n`, then read or edit only that range. Append one
entry per ticket, blockers first:

```markdown
2431. **<Title.>** 📝 Planned (<YYYY-MM-DD>), not built: `docs/<feature>_plan.md` §<n>.
    <What it delivers, from the user's side — two to four lines.>
    Blocked by #2430.
    - [ ] 🤖 Automated test
    - [ ] 🖐️ Manual test
      - [ ] ✅ Works on Linux (X11)
      - [ ] ❌ Doesn't work on Linux (X11)
      - [ ] ✅ Works on Linux (Wayland)
      - [ ] ❌ Doesn't work on Linux (Wayland)
      - [ ] ✅ Works on Windows
      - [ ] ❌ Doesn't work on Windows
      - [ ] ✅ Works on macOS
      - [ ] ❌ Doesn't work on macOS
```

A backend-only ticket with nothing to click drops the 🖐️ block. Use no line
numbers or code in entries (they go stale); the plan holds the detail.
Finally add a `Tickets: #<first>–#<last>` line to the plan's status line.

**Done when** every approved ticket has an entry, each blocker points at a
real number, and `git diff --check` is clean.
