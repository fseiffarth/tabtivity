---
id: checkpoints
title: Per-turn checkpoints — put an agent's files back
keywords: [checkpoint, checkpoints, restore, undo, rewind, revert, turn, agent edits, files back, since checkpoint, diffs, experimental]
related: [agent-clis, claude-code, codex, git, talking-to-an-agent]
---

An agent's turn can leave a project in a state you do not want. Per-turn
checkpoints save the project's files as each turn begins and ends, so you can
put them back. It is an experiment: off until you turn it on in **Settings →
Experimental → Per-turn checkpoints**. They need git 2.40 or later; with an
older git the switch stays off and says which version it found.

## What is saved, and where

Tabtivity takes a checkpoint of a local project's folder when an agent tab's turn
starts and when it ends. This needs the agent's hooks, so it works for Claude
and Codex tabs. Remote projects, the root console and the Tabby assistant get
none.

The files go into a store of their own in Tabtivity's state folder, not into the
project's `.git`, so the agent cannot reach or change its own undo history, and a
folder that is not a git repository works too. Files that git would ignore
(`.gitignore`, the repo's `info/exclude`) are neither saved nor touched by a
restore, and a file over 25 MiB is skipped and named. A repository nested inside
the project is recorded as one entry; its files are not saved.

A folder keeps checkpoints for 14 days, at most 300, and at most about 2 GiB:
past that the oldest go first. Settings shows each folder's size and a
**Clear** button. A folder whose `.gitignore` is not a regular file (a named
pipe) would make git wait forever, so it is left out of the checkpoint and
named on it. When a checkpoint fails, the Chat's **Checkpoint** button says
so, and hovering it says why.

## Putting files back

Hover one of your prompts in the Chat and press **Restore files to before this**.
A dialog lists every file that differs now, all ticked: files the agent added are
removed, the rest are put back. Files another tab's turn changed are flagged.
Nothing is restored while the tab's agent is working. An agent that doesn't
report its turns (a Codex tab whose hooks aren't trusted yet, or a tab you
haven't prompted since it opened) can't be told working or not: the dialog then
asks you to tick that you know it isn't.

Only the files go back. The conversation stays as it is, so a box is ticked to put
a short note into the message box ("files were restored to ..."), for you to send
or delete.

A restore saves the current files first. When it is done, **Undo restore** puts
everything back as it was.

If the agent may already have started writing when a checkpoint was taken, the
dialog says so and offers the end of the previous turn instead.

## Looking before you restore

In the **Diffs** tab, switch the scope from *Agent's edits* to *Since
checkpoint* and pick a checkpoint: you see every file that differs from it now,
whoever changed it. **Restore files...** is there too. The **Checkpoint** chip
beside Commit in the Chat saves the files right now.
