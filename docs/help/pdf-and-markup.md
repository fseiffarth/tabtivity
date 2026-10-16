---
id: pdf-and-markup
title: PDF viewer, redaction and marking up PDFs for an agent
keywords: [pdf, viewer, zoom, find, contents, chapters, arrange pages, insert pdf, merge, reorder, redact, black out, print, fullscreen, present, mark up, markup, pen, highlighter, submit, round, apply marks directly, undo, subagent, markup_ask, markup_done, tick, approve]
related: [files-and-viewers, latex-and-presenter, mobile, workspace-apps]
---

PDFs open in Tabtivity's own viewer. Besides reading, you can rearrange
pages, black out text for real, print, and mark the PDF up with a pen so an
agent makes the changes for you.

## Reading

The toolbar has zoom and **Fit page width**, **Go to page**, **Find** (Enter
and Shift+Enter step through matches, with **Match case**) and **Contents**
(the PDF's chapters, when it has them). **Fullscreen** shows the PDF in a
window of its own: ← and → turn the page, Esc closes it. With two or more
screens, **S** (or the bar's screen button) moves it to the next screen; the
screen it ends on is remembered for the next time. **Open in external app**
hands the file to your system's PDF reader.

## Arranging pages

**Arrange pages** lets you reorder and delete pages, and **Insert PDF** adds
the pages of another PDF from the same project (in a box, from any member —
see `containers-boxes`). Undo and Redo work on these changes. Nothing is
written until you press **Save**.

## Blacking out text (redaction)

**Black out text** is a real redaction, not a black rectangle on top. Drag
over what must go, or search and use **Black out all N matches**. When you
save, the pages you marked are rewritten as images, so the covered text — and
all other text on those pages — is gone from the file. Pages you did not
mark keep their text. Marks follow their page if you reorder it and can be
undone until you confirm **Black out and save**.

## Printing

**Print** (or Ctrl+P) opens a preview with the copy count and the document's
own settings, then follows the job through the printer queue. The printers and
their queues are in the print manager (`workspace-apps`).

## Marking up a PDF for an agent

**✎ Mark up** in the PDF toolbar (also on the PDF of a TeX workspace) opens the
markup strip: pen, highlighter, typed notes and an eraser over the pages.
Write what should change, as you would on paper, then **Submit**:

1. Tabtivity saves a marked copy, `<name>-marked.pdf`, into the project's
   `.tabtivity/inbox/` folder.
2. It sends a prompt with the file, the marked copy and your notes to an agent
   tab of the same project — the strip shows which; click it to pick another.
   If the agent is busy, the prompt waits in its queue.
3. The strip stays open. Each Submit is a **round**; you can keep marking
   while the agent works.

Your marks live only in this window until you submit — never in the project
folder. When the agent rebuilds the PDF, Tabtivity loads the new pages under
your marks (or offers **Reload PDF**, if you turned that off). Marking works
on local projects in the main window, on the PDF as saved (save page changes
first), one pane per file.

Each group of marks that belong together is one **remark**, with its own small
**Submit** to send just that remark. The model chip beside the agent opens that
tab's own model list, to run the next round on another model.

## Apply directly, or list first

Settings → Agents → **PDF markup**:

- **Apply marks directly** (on by default): the agent makes the changes right
  away and **Undo** in the strip restores every file the round changed (a
  dialog lists them first). Where no undo is possible — for example the
  project is not a git repository — the agent lists the changes first.
- With it off, the agent first lists what your marks ask for; **Make these
  changes** tells it to go ahead.
- **Questions about your marks**: how often the agent stops to ask — from
  **Ask always** to **Never ask**.
- **Hand each Submit to a new subagent**: each round goes to a new background
  subagent, so rounds run side by side (for CLIs that have subagents, such as
  Claude Code).
- **Mark up prompt** and **"Make these changes" prompt** are the texts sent to
  the agent; **Use the default** restores them. The phone keeps its own.

## The agent's questions and ticks

A local Claude, Codex or tool-capable Local Model tab can ask you about an
unclear mark: the question appears as a card under the markup strip, with a
numbered pin on the page; pick an answer and **Send answers** (it becomes the
agent's next prompt). After making a change it can tick the mark off: a green
**✓** appears on the remark — click it to approve and remove those marks, or
**Approve all**. Nothing is removed without your click, and **Undo** brings
approved marks back. Details, and how to switch this off, are in `mobile`
(sections "The agent's questions about your marks" and "Marks the agent has
done").

## On the phone

The same markup — finger or Apple Pencil — is in Tabtivity Mobile, with the
same rounds, questions and ticks. See `mobile`.
