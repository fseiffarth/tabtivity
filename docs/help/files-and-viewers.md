---
id: files-and-viewers
title: Files, viewers and editing
keywords: [file, viewer, editor, open, code, markdown, yaml, json, bibtex, csv, table, image, gif, notebook, ipynb, spreadsheet, xlsx, sqlite, html, svg, audio, video, autocomplete, spell check, dictionary, autosave, python, run, debug, text size, copilot, remarks]
related: [pdf-and-markup, latex-and-presenter, tabs-and-panels, local-models, git]
---

Tabtivity opens most project files in its own viewers, inside a tab of the
current project. Types it has no viewer for open in your system's default app.

## Open a file

- **Double-click** a file in the file panel, or **drag** it onto a subwindow's
  tab bar to open it in that pane. The viewer is chosen by the file's
  extension.
- The file panel's context menu also has **Open with** (another app) and
  copy path, reveal, rename, delete and properties.
- A hit in the file panel's **Search** view jumps straight to that line in the
  viewer.
- Which external app opens a type you have no viewer for: **Settings →
  Workspace & apps → File Type Apps** (per type), and per project in the
  project's settings. Otherwise your system's default app is used.

Every viewer remembers where you were: scroll position, PDF and image zoom and
image pan come back when you reopen the file or restart Tabtivity.

## Which viewer opens what

| Viewer | Files | What you can do |
|---|---|---|
| Text / code | `.txt`, `.py`, `.ts`, `.rs`, `.cpp`, `.toml` and many more, plus `Dockerfile` and similar | Edit with syntax highlighting, find, find and replace, save |
| Markdown | `.md`, `.markdown`, `.mdx` | Rendered preview with an Edit/Preview toggle; `mermaid` diagrams and `$…$` math; links to local files open them |
| YAML / JSON | `.yaml`, `.yml`, `.json` | Edit as a tree (Tree/Source toggle) |
| BibTeX | `.bib`, `.bibtex` | One card per entry, editable fields, filter, duplicate keys flagged |
| LaTeX | `.tex` | A workspace tab per document — see `latex-and-presenter` |
| PDF | `.pdf` | Zoom, find, contents, arrange pages, black out text, mark up, print — see `pdf-and-markup` |
| Presentation deck | `.eldeck.json` | Slides over a PDF or LaTeX base (experimental) |
| Images | `.png`, `.jpg`, `.webp`, `.bmp`, … | Zoom to the cursor, pan, **✎ Annotate** |
| Animated GIF | `.gif` | Play/pause, step frames, scrub, speed, loop |
| Table | `.csv`, `.tsv` | Edit cells and headers, add/delete rows, filter, sort, resize columns |
| Jupyter notebook | `.ipynb` | Read-only: cells and their outputs |
| Diff / patch | `.diff`, `.patch` | Coloured additions and deletions |
| OpenDocument text | `.odt` | Read-only |
| Spreadsheet | `.xlsx`, `.xls`, `.xlsm` | Read-only grid with a sheet picker, sort and filter |
| SQLite | `.db`, `.sqlite`, `.sqlite3` | Read-only table list and rows |
| HTML / SVG | `.html`, `.htm`, `.svg` | Edit the source beside a preview that runs no scripts |
| Audio / video | `.mp3`, `.mp4`, `.webm`, `.wav`, … | Built-in player |

Word, PowerPoint and other office files (`.docx`, `.pptx`, `.ods`, …) open in
their external app.

## The text editor

- **Ctrl+S** saves, **Ctrl+Z** / **Ctrl+Shift+Z** undo and redo, **Ctrl+F**
  finds, **Ctrl+R** finds and replaces (with a case toggle), Tab / Shift+Tab
  indent. Lines you have changed but not saved are marked in the gutter.
- If the file changes on disk (an agent edited it), a banner offers to reload
  it; nothing you typed is thrown away without asking.
- **A−** / **A+** in the header (or Ctrl + / Ctrl − and Ctrl+0) change the text
  size for that file type; the Markdown preview follows.
- **Autosave edits** is a switch in the project's settings under **Native
  Viewers**.

## Editing YAML, JSON, BibTeX and tables safely

The tree, card and table editors change the file's own text, not a
re-formatted copy: comments, quoting, key order, alignment and line endings
survive an edit. Where a construct cannot be rewritten safely (a YAML anchor or
merge key, a BibTeX `@string` macro or `#` concatenation) the editor shows it
read-only instead of guessing. **Source** always opens the full text editor.

## Annotating images

**✎ Annotate** in the image viewer adds pen, rectangle, arrow and text marks
with colour and width controls, undo and clear. Saving flattens them into a
copy (`<name>-annotated.png`), or overwrites a `.png` if you choose.

## Autocomplete and spell check

Both are **off by default** and are switched per tab from the editor's header;
the defaults per file type are in the project's settings under **Native
Viewers**.

- **Autocomplete** (Ctrl+Space) asks a local Ollama model for one completion;
  **Tab** accepts it, **Esc** dismisses it. Pick how long it should be:
  Sentence, Block or Scope. Nothing leaves this computer, and if Ollama is not
  running it simply does nothing. Set up Ollama and pick the model in
  `local-models`.
- **GitHub Copilot** can be a second provider for code files: switch on
  **GitHub Copilot autocomplete** in **Settings → System → Experimental**, then
  let one project opt in. Copilot is a cloud service, so the code you edit in
  that project leaves the computer; its language server runs sandboxed and
  read-only in that project only.
- **Spell check** uses Hunspell dictionaries on this computer and skips code
  and TeX commands. While it is on, the header shows the language; **＋
  Language** downloads another dictionary and switches to it. Words you add go
  into your personal dictionary.

## Python run and debug

Experimental: switch on **Python Run/Debug in the code viewer** in **Settings →
System → Experimental**. A `.py` file with a `__main__` guard then gets a ▶
button: run it, or debug it with breakpoints and `pdb`. It uses the interpreter
Tabtivity ranks first for the project (the project's virtual environment
before the others).

## More experimental viewer features

In **Settings → System → Experimental**:

- **Markdown link graph** adds a Graph mode to the Markdown viewer: a map of
  the files a document links to. Click a node to open that file.
- **Project file remarks** lets you attach review notes to project files, kept
  in a git-friendly `REMARKS.md`.

## Remote projects

On a remote (SSH) project the viewers read and write the files on the host
through the SSH connection, with no mount. Large or binary files may take a
moment to arrive. See `remote-projects`.
