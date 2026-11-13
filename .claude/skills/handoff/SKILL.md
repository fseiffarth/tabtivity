---
name: handoff
description: Compact the current conversation into a handoff document (docs/<feature>_handoff.md) for another agent or session to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

<!-- Adapted for Tabtivity from mattpocock/skills@4ae2317
     skills/productivity/handoff (MIT, see ../THIRD_PARTY_NOTICES.md). -->

Write a handoff so a fresh agent can continue this work. Save it to
`docs/<feature>_handoff.md` (add a letter suffix if one exists), or to
project `tmp/` when the user says it is throwaway. Never `/tmp` or
`$TMPDIR` — the user cannot see them and they are a small tmpfs here.

Sections, each only if it has content:

- **Goal** — one or two lines; the plan's path if there is one.
- **State** — branch; commits made (hashes); files changed but uncommitted
  that are *this* session's (the tree is shared with other sessions — list
  paths, never "everything in `git status`"); gates run and their result;
  what was and was not verified live.
- **Decisions** — taken by the user (say so) vs. defaults still open.
- **Next steps** — ordered, each with its completion criterion.
- **Traps** — what cost time and how it was resolved.
- **Suggested skills** — which skills the next agent should call.

Reference plans, todo entries, commits and diffs by path, number or hash;
do not copy their content. Redact secrets and personal data. If the user
passed an argument, tailor the document to that next focus.

Do not commit it unless asked. Tell the user the path.
