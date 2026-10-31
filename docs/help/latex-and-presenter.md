---
id: latex-and-presenter
title: LaTeX workspaces and the deck presenter
keywords: [latex, tex, compile, pdflatex, xelatex, lualatex, latexmk, synctex, input, include, bibtex, cite, ref, label, beamer, overlay, preview, structure, presenter, presentation, deck, slides, speaker notes, eldeck, second screen, screen sharing, privacy, hide windows, curtain]
related: [pdf-and-markup, files-and-viewers, keyboard]
---

A `.tex` file opens as a **workspace** for its whole document, and a PDF can
become a slide deck you present from Tabtivity.

## The TeX workspace

Opening any `.tex` file of a document opens one workspace tab for that
document (opening another of its files switches inside the same tab):

- The **Structure** sidebar lists the main file's `\input` / `\include`
  children and its graphics; click one to show it in the centre. Hide or show
  the sidebar from its header.
- **New file** creates a `.tex` file (relative to the main file's folder, for
  example `chapters/intro`) and adds the `\input` line for it.
- **Back** and **Up** move between the files you came through, back to the
  main document.
- `\ref` and `\cite` complete from the document's `\label`s and the `.bib`
  entries it uses.
- **Ctrl+Click** on an `\input{…}`-style command opens that file, with no
  compile needed.

## Compiling

**Compile ▸** (or **Ctrl+Shift+B**) builds the PDF with the LaTeX engine
found on your `PATH`; if none is installed, the workspace says so. Install
TeX Live, MiKTeX or MacTeX first. A compile always rebuilds, even when
latexmk thinks nothing changed. **Compiler options** set the output folder and
extra flags. In the file panel, a `.tex` file's menu has **Compile PDF** and
**Compile & View PDF**.

Errors and warnings from the last build show in the workspace; click to jump
to the line. LaTeX shell-escape stays off unless a `latexmkrc` turns it on, and
Tabtivity asks you before it runs a project's `latexmkrc` the first time (and
again when it changes).

The compiled PDF opens as **its own tab**, coupled to the source: put it in
another pane, or pop that pane out to a second screen.

## Jumping between source and PDF (SyncTeX)

- **Ctrl+Click** in the source (outside an `\input` path) shows that spot in
  the PDF (**Cmd+Click** on macOS).
- **Ctrl+Click** in the PDF jumps to the source line that produced it.

This works across tiled and popped-out panes. It needs the SyncTeX data a
compile from Tabtivity writes beside the PDF. If the PDF is older or newer
than that data, or the source changed since the last compile, Tabtivity tells
you and offers **Recompile**.

## Previews and Beamer

Two switches in the project's settings: a **typeset preview** of the
formula or snippet under the pointer, and **Beamer** overlay controls. With
**Beamer** on, a bar wraps the selection in `\only`, `\uncover` or `\alert`
with a slide number, or stamps an overlay on every `\item` of the selected
lines.

## The deck presenter (experimental)

Switch on **Deck presenter** in **Settings → System → Experimental**. Then:

- A PDF's toolbar has **Present**: it opens the PDF as a deck
  (`<name>.eldeck.json` beside it) with editable layers on top — text, shapes,
  icons, images and TeX figures — without changing the PDF.
- **New Presentation** in the file panel starts a deck from a starter LaTeX
  file.
- **Builds** give objects steps (appear, fade in, rise, scale, wipe, draw);
  **Transition** sets how a slide leaves; **Animation after this slide** plays
  a GIF between slides.
- **Speaker notes** are shown only in the presenter view.
- Present in the tab, or across two displays or windows: the audience sees
  the slides fullscreen, you keep the speaker notes and a timer. The finished
  deck exports to PDF.

For a plain PDF without editing, **Fullscreen** in the PDF toolbar is enough
(see `pdf-and-markup`).

## Hiding the other windows while you present

While a PDF is shown fullscreen or a deck's audience window is open, every
other Tabtivity window is covered by a plain panel, "Hidden while
presenting". If you share the wrong window, or the wrong screen, in a video
call, the call shows that panel instead of your mail or terminals. During a
deck talk the main window keeps your presenter view (notes, timer, next
slide), and the panel is only a small chip in its corner.

- Click **Show** in a covered window to see it again. Each window comes back
  on its own click. The panel stays when the presentation ends, because you
  may still be sharing.
- On Windows and macOS the covered windows, and any open browser windows, are
  also hidden from screen capture, so a share shows them black. Linux has no
  way to do that, so there the panel is the only cover.
- After you close a fullscreen PDF, the panel also offers **Back to
  fullscreen**, which reopens it on the sheet you left. Your other windows
  stay covered.
- Desktop calendar reminders wait until the presentation ends. Reminders on
  your phone still arrive at once.
- **Ctrl+Shift+Alt+H** covers every window without presenting, for calls
  where you share something else. Pressed in a covered window, it shows that
  window again. You can rebind it under **Settings → Keyboard**.
- Turn the automatic panel off with **Hide other windows while presenting**
  in **Settings → General**. The shortcut still works.
