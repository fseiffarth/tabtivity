# Mark up a PDF or picture on the phone and send it to the chat

Status: plan only, 2026-10-01 (settled with the user over several revisions
the same day — see §1). Nothing here is built.

---

## 1. Context

The phone can already open a project's PDF or picture — from the files drawer
(`ProjectFiles`, #31bo; a left→right swipe on a tab's Focus view) or from what
the agent sent (`OutboxViewer`, 🖼 gallery / chat bubbles). Reviewing a draft
paper, a slide deck or a plot there ends in typing "on page 3, the second
paragraph, change…" into the composer by hand.

What the user asked for, in their words:

> on phone a pdf editor to mark what to change inside pdf … edits should only
> live on phone no desktop changes then a submit button that directly sends
> edits tied to pdf to the chat where pdf was opened from

> Editor on phone should not read or able to change pdf it is an additional
> text or graphical layer on top of existing pdf or image

> add text and markers in seperate layer on phone same size as pdf then send
> both to desktop back bake them together (or put them separately) then feed
> into agent with corresponding promt

> Idea is open tabtivity phone eg on ipad write with pencil changes to pdf then
> submit and agent reads and changes it automatically

So the primary device is an **iPad with Apple Pencil** running Tabtivity Mobile
(Safari / Home Screen PWA — every iPad browser is WebKit), handwriting the
changes onto the page; a phone with a finger is the secondary case. The agent
reads the handwriting and applies it to the PDF's *source* by itself.

Settled in the conversation:

- **Showing the page:** pdf.js on the phone, but **in a sealed frame**
  (sandboxed iframe, opaque origin) that has no session cookie, no storage,
  no API and no network — it only turns PDF bytes into page pictures. The PWA
  itself never parses the PDF. Chosen over desktop-rendered page pictures
  because it works the same with a Windows, macOS or Linux desktop and needs
  no per-OS sandbox for a renderer. The browser's own viewer (**Open**,
  `openOutside`) stays for reading; it cannot carry a layer (another tab/app,
  reports no scroll/zoom/page geometry).
- **Hand-off: baked + separate.** The desktop bakes the layer into a *copy*,
  `<stem>-marked.pdf`, as real PDF annotations; the layer pictures and the
  typed notes go along too. The original PDF is never changed.

Non-goals (v1): changing the original PDF; editing PDF text; reading the PDF's
text into the prompt; markup from the project screen (no chat there — no
button); shell tabs.

## 2. Decisions

### 2.1 The layer is the page's size

A layer is per page and lives in that page's own coordinate space: PDF user
units (points) of the page as displayed, i.e. after its `/Rotate`, origin top
left. pdf.js's viewport gives the page size and the transform; the layer
stores marks in those units, so the same numbers draw on the phone and bake on
the desktop (converted to PDF space, undoing `/Rotate`, at bake time). For a
picture source the units are the picture's pixels.

Marks: ✎ ink stroke (points with per-point pressure + base width + colour),
▭ highlighter (translucent stroke or box), **T** typed text note (anchor +
text + size + colour), and ⌫ eraser (removes whole strokes it touches).
Colours from a closed set (red, blue, black, yellow highlighter).

### 2.1a Pencil draws, fingers move the page

On an iPad no tool switching is needed to write:

- `pointerType === "pen"` (Apple Pencil, or an Android stylus) **always
  draws** with the current tool (ink by default); `pressure` sets the width,
  `getCoalescedEvents()` (where the browser has it) feeds every sample so
  fast handwriting stays smooth; strokes are smoothed (quadratic midpoints)
  and stored as points, never as pixels.
- **Fingers scroll and pinch-zoom** the pages; while a pen is down every
  touch pointer is ignored (palm rejection).
- A device with **no pen** seen yet (a phone) gets the ✋ / ✎ toggle: in ✎ a
  single finger draws, two fingers scroll.
- WebKit quirks the layer must handle: the Pencil scrolls the page and starts
  text selection unless `touchstart` / `touchmove` with `touchType ===
  "stylus"` are `preventDefault`ed in a non-passive listener; the page gets
  `-webkit-user-select: none` and `-webkit-touch-callout: none`; the layer
  is a plain element (no input), so Scribble never turns ink into typed text.
- Handwriting stays handwriting: there is no on-device recognition (the web
  has none); the agent reads it from the marked PDF and the layer pictures.
  The typed **T** note is for when typing is easier.

### 2.2 The sealed frame

- A second page in the mobile bundle, `mobile-web/pdf-frame.html`, loaded as
  `<iframe sandbox="allow-scripts" src="/pdf-frame.html">` — no
  `allow-same-origin`, so the frame is an opaque origin: no cookie is sent
  with its requests (and the session cookie is `SameSite=Strict` anyway), no
  `localStorage`, no access to the PWA's DOM, and the sidecar's
  `exact_origin` refuses anything it might POST.
- Its own headers from the sidecar: CSP `default-src 'none'; script-src
  'self'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none';
  frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` — the one page
  that may be framed (everything else keeps `DENY` / `frame-ancestors 'none'`,
  `host.rs:330/342`). No `wasm-unsafe-eval`: pdf.js's wasm image decoders
  (JPX/JBIG2) stay off and such images render blank, as on the desktop.
- Its script is built as a **classic** (IIFE) script, not a module: a module
  script from an opaque origin is a CORS request the static route does not
  answer. pdf.js runs **without a Worker** inside the frame (an opaque origin
  cannot start a same-server worker): the worker module is bundled in and
  exposed as `globalThis.pdfjsWorker`, pdf.js's main-thread fallback. One page
  renders at a time, so the cost is a short pause per page.
- **Protocol** (`postMessage`, transferables, nothing else):
  PWA → frame `{ open, bytes: ArrayBuffer }`, `{ render, page, width }`;
  frame → PWA `{ meta, pages: [{ w, h }] }`, `{ page, n, bitmap: ImageBitmap }`,
  `{ failed, code }`. The PWA accepts a message only when
  `event.source === frame.contentWindow`, and only those shapes, numbers
  range-checked; it never inserts anything from the frame as HTML.
- Canvas only: no text layer, no annotation layer, no links, no forms — PDF
  content never becomes DOM. The frame is removed on close, which ends pdf.js
  and frees everything (the `pdfLoad.ts` worker-leak concern does not arise —
  there is no Worker; a failed load still destroys its loading task).
- The PWA fetches the bytes itself from the existing raw routes
  (`viewerFileUrl(scope, file)`, 24 MiB cap via `MAX_OUTBOX_FILE`) and
  transfers them in.

### 2.3 What the agent gets

Per Submit, in the project inbox (`.tabtivity/inbox/`):

- `<stamp>-<stem>-marked.pdf` — a copy of the PDF with the layer baked in as
  annotations: `/Ink` for pen strokes, `/Highlight` (QuadPoints from the box)
  for boxes, `/FreeText` for text notes, each with an `/AP` appearance stream
  so every viewer (and an agent looking at the rendered page) sees them the
  same, `/Contents` holding the note text, `/T` "Tabtivity Mobile". Original
  untouched.
- `<stamp>-<stem>-p<N>-layer.png` — each marked page's layer alone,
  transparent, at the page's aspect (1200 px wide), drawn on the phone.

and one chat message, built by the sidecar:

```
I marked these changes by hand on `docs/paper/draft.pdf`.
Marked copy with my handwriting and marks as annotations:
@.tabtivity/inbox/…-draft-marked.pdf
My markup layers, one per page, each the size of that page:
Page 3: @.tabtivity/inbox/…-draft-p3-layer.png
Page 7: @.tabtivity/inbox/…-draft-p7-layer.png
My typed notes:
- p3: "use the 2024 numbers here"
Read every mark (strike-throughs, insertions, circled parts, margin notes)
and list the changes they ask for, and any mark you could not read. Do not
change any file yet — not this one, not the sources it is built from, not
any other file — until I tell you which changes to make.
Once you have rebuilt the PDF, send it to me with `tabtivity-send <file>`.
```

The paragraph after the notes is the phone's **Mark up prompt** setting
(Home → This phone; `markupInstruction.ts`), worded there and nowhere else,
sent with a Submit only once changed. Its default asks first (2026-10-02):
the earlier "make the changes in the sources and rebuild" had an agent edit
the `.tex` beside a marked PDF unasked.

"Automatically" means the agent works the prompt like any other: whether it
asks before editing is its own CLI's permission mode — Tabtivity injects none
(`AGENTS.md` invariant). The `tabtivity-send` line closes the loop: the rebuilt
PDF lands as a bubble in the same chat (`from_tab`), where it can be opened
and marked up again. (Shell-less tabs without `tabtivity-send` — ollama-launch,
plain shells — just skip that line.)

If baking fails (encrypted PDF, malformed file, copy over 24 MiB), the message
goes without the marked copy and says why in one line — the layers and notes
still carry everything.

For a **picture** source there is nothing to bake into: the phone draws the
picture plus layer onto a canvas and uploads that as `<stem>-marked.png`
(browser decoders, which already show the picture) beside the layer; the
desktop never decodes the picture.

### 2.4 Baking on the desktop — `lopdf`, no extra program

`lopdf` (pure Rust, MIT) loads the PDF from the bytes `files::read` /
`outbox` already return, adds the annotations to each marked page's `/Annots`,
writes a new file. Memory-safe parsing; the input is capped at 24 MiB, the
work runs in `spawn_blocking` under `catch_unwind` with a deadline, and a
failure is just "no marked copy". Same code on Windows, macOS and Linux.

### 2.5 The source's path

The phone names the file by what it already holds — the sealed files token or
the outbox leaf. The sidecar resolves it and writes the project-relative path
into the prompt it returns: the inbox's existing exception (project-relative,
no host component), and the same text reaches the phone's chat transcript once
sent anyway. No absolute path leaves the desktop.

### 2.6 Submit sends at once

The phone sends the returned prompt through the Terminal screen's
`submitDraft(text, false)` — a busy agent gets it held like a typed message,
and it shows as the user's bubble.

### 2.7 The layer on the phone

**IndexedDB**, one record per source keyed
`<projectId>:<files:token | outbox:name>` — handwriting is many points, and
Safari gives `localStorage` only ~5 MB for the whole PWA. Vector marks in page
units, points rounded to 0.1 unit and simplified (Ramer–Douglas–Peucker) as
each stroke ends; the file's `size` + `modified` as a fingerprint ("This file
changed since you marked it"). Saved as each stroke ends, so a closed PWA or
a reload loses at most the stroke in progress. Nothing reaches the desktop
before Submit; cleared after a successful Submit. Every access in try/catch
(private mode, evicted storage → the layer works unsaved and says so). Caps:
5 000 strokes and 200 000 points per file, 2 000 chars of typed text per page.

## 3. Shape

```
Terminal (agent tab)
 ├─ ProjectFiles drawer ─► OutboxViewer (PDF / picture) ─► [Mark up] ┐
 └─ 🖼 gallery / chat bubble ─► OutboxViewer (PDF / picture) ─► [Mark up] ┤
                                                                        ▼
 MarkupView (PWA)
   fetch bytes ─► <iframe sandbox="allow-scripts" pdf-frame.html>  pdf.js, no worker,
                  ◄── page sizes, ImageBitmaps                     canvas only
   page pictures + SVG layer (pen / box / text)  ⇄ IndexedDB (phone only)
 [Submit]
   1. per marked page: layer → transparent PNG            POST /tabs/{tab}/inbox (existing)
      (picture source: also picture+layer → PNG)
   2. POST /api/v1/tabs/{tab}/markup   { source, pages: [{ n, size, marks, layer ref }] }
      desktop: read source → lopdf bake → inbox::store(<stem>-marked.pdf)
      ◄── { prompt }
   3. submitDraft(prompt, false)
   4. clear the layer, close → the chat with the new bubble
```

## 4. Steps

### 4.0 Spike first: the sealed frame and the Pencil on the iPad

Before anything else, a throwaway `pdf-frame.html` with a fixed test PDF
and a bare ink layer, opened **on the iPad as a Home Screen PWA** and on the
user's Android Chrome, answers the unknowns the design rests on: (1) the
classic-script frame loads under its CSP from an opaque origin
(`script-src 'self'` there); (2) pdf.js renders without a Worker; (3) how
long a dense page blocks the UI (a sandboxed same-site frame shares the
PWA's main thread — WebKit has no per-frame process); (4) ImageBitmap
transfer back works; (5) Apple Pencil ink: no page scroll or text selection
while writing, pressure arrives, palm rejection holds, latency acceptable;
(6) Safari's canvas memory ceiling with a few pages rendered at iPad width.
Also confirm the PWA itself pairs and runs on the iPad at all — it has been
used on Android so far. If (3) is bad (> ~1 s per page), fall
back to desktop-rendered page pictures before building the rest: a
`tabtivity --render-pdf-page` helper (PDFium, bytes in on stdin, JPEG out on
stdout) under each OS's sandbox — bubblewrap, `sandbox-exec`, a
capability-less AppContainer — with the layer, bake and Submit unchanged.

### 4.1 Phone — the sealed frame

- `mobile-web/pdf-frame.html` + `mobile-web/src/pdfFrame/main.ts`: pdf.js
  (main-thread fallback, `globalThis.pdfjsWorker`), message handling per §2.2,
  render to `OffscreenCanvas` → `transferToImageBitmap` (fallback: canvas →
  `createImageBitmap`).
- `vite.mobile.config.ts`: the `pdfjs-dist` alias `vite.config.ts` carries
  (`pdf.mjs`), and a second build of the frame entry as a classic IIFE into
  `mobile-dist/` (a small separate `vite build` step in `mobile:bundle`, or a
  rollup output with `format: "iife"` for that input). The service worker's
  precache list (`stampServiceWorker`) leaves the frame out — it is fetched
  when first used.
- Sidecar static serving (`host.rs` `static_asset` / `asset_response`): the
  frame-specific headers of §2.2 for `/pdf-frame.html` only; a test asserts
  every other path keeps `DENY`.

### 4.2 Phone — pure helpers (`mobile-web/src/markup/`, unit-tested)

`layer.ts` (mark types in page units, undo stack, `isEmpty`, numbering),
`store.ts` (load/save/clear, fingerprint, caps, throwing storage),
`rasterize.ts` (draw a layer onto a 2D context of a given size — mocked
context in tests), `frameProtocol.ts` (`acceptFrameMessage(event, frame)` —
the shape and range checks, tested with forged messages).

### 4.3 Phone — `mobile-web/src/components/MarkupView.tsx` (new, `React.lazy`)

- Full screen, `OutboxViewer`'s head. Pages in a vertical scroller: a canvas
  per page painted from the frame's ImageBitmap at screen width ×
  min(DPR, 2), capped at 2 048 px wide (Safari's canvas memory), at most
  ~4 page canvases alive, requested near the viewport and released far
  away; an SVG layer over each drawing the marks. A picture source skips
  the frame. Pinch zoom re-renders the visible page sharper once settled.
- Input per §2.1a. Toolbar: ✎ ink, highlighter, ⌫ eraser, **T** text,
  colour, Undo / Redo, Clear page, **Submit**; on a pen-less device also
  ✋ / ✎. Large touch targets — it is used with a Pencil in one hand.
- Submit: disabled while empty or offline; progress ("Sending page 3…"); a
  failure keeps the layer, sends nothing to the chat, says which step failed
  (inbox codes reuse `UPLOAD_FAILURES` wording).

### 4.4 Sidecar — `POST /api/v1/tabs/{tab_id}/markup` (`markup.rs`, new)

- AppHandle-free: `MarkupRequest { source, pages: [{ n, size, marks, layer,
  notes }] }`; `validate` (≤ 300 pages, sizes positive and sane, coordinates
  inside the page, closed sets of kinds and colours, ≤ 5 000 strokes and 200 000 points, text ≤
  2 000 chars, layer refs `INBOX_DIR/<name>` with a name `inbox::safe_name`
  would produce, present below the root, PNG by magic bytes);
  `bake(pdf_bytes, pages) -> Result<Vec<u8>, BakeError>` (lopdf, §2.4);
  `prompt(source_rel, marked_ref, pages, bake_failure) -> String`
  (deterministic).
- Handler shaped like `inbox_upload`: `authenticate`, `exact_origin`,
  `catalog.tab(tab_id)` → project; resolve the source (token unsealed with
  that project's `raw_id` — another project's token fails — or outbox leaf);
  read with `files::read` / the outbox reader; for a PDF bake and
  `inbox::store(root, "<stem>-marked.pdf", …)`; answer `{ prompt }`. Body
  limit 4 MiB. Nothing writes the source.
- `Cargo.toml`: `lopdf` (check license/size; `cargo tree` for what it pulls
  in).

### 4.5 Phone — wiring

- `OutboxViewer.tsx`: optional `markup?: { tabId; onSend(text): boolean }`;
  with it, PDFs and pictures get **Mark up** beside Open / Save.
- `ProjectFiles.tsx`: passes `markup` through (the project screen passes none).
- `Terminal.tsx`: for agent tabs, both the files drawer's viewer and the
  outbox viewer get `markup = { tabId: tab.id, onSend: (text) =>
  submitDraft(text, false) }`; after a send, close viewer and drawer.
- `api.ts`: `submitMarkup(tabId, body)`, `MarkupSource = { files: string } |
  { outbox: string }`.
- i18n `mobile.markup.*` in `src/lib/i18n.ts` + `de/es/fr/it`; untested ids
  `mobile.markup` (layer + phone-only storage), `mobile.markup.frame` (sealed
  pdf.js frame), `mobile.markup.send` (Submit → marked copy + layers + prompt
  → chat) in `src/lib/untested.ts`.
- CSS in `mobile-web/src/style.css`, reusing the outbox viewer and
  option-sheet classes.

### 4.6 Docs

One row each in `docs/filemap_frontend.md` (MarkupView, `markup/`,
`pdfFrame/`) and `docs/filemap_backend.md` (`markup.rs`); a paragraph in
`DOCUMENTATION.md`'s mobile section; a `todo/group-h-crossplatform.md` entry
with the 🖐️ phone checks (and the Linux/Windows/macOS desktop pairs for the
bake) when implementing.

## 5. Verification

Gates at zero warnings: `npm run build`, `npm test`,
`cargo test --manifest-path src-tauri/Cargo.toml`, `npm run lint`,
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`;
`cargo check --target x86_64-pc-windows-msvc` for the new crate; then
`npm run mobile:bundle` and `npm run backend:stale`.

Tests:
- `markup.rs` — validation drops bad refs / non-PNG layers / out-of-page
  coordinates; bake of a fixture PDF (built with lopdf in the test) adds the
  expected `/Annots` with appearance streams on the right pages, honours
  `/Rotate`, leaves the input bytes unchanged; an encrypted or garbage input
  gives `BakeError`, never a panic; prompt text deterministic.
- `host.rs` — `/pdf-frame.html` gets the frame headers, every other path keeps
  `DENY`; files switch off → `files_off`; foreign-project token → 404; outbox
  leaf with `/` or `..` refused; the marked copy lands under `.tabtivity/inbox/`;
  no answer carries an absolute path; bad origin / oversized body refused; the
  source's bytes and mtime unchanged.
- Phone — `layer.ts`, `store.ts`, `rasterize.ts`, `frameProtocol.ts`
  (forged source, wrong shapes, out-of-range numbers rejected), and
  `MarkupView`'s Submit order with `api` mocked (layer uploads → `/markup` →
  `onSend(prompt)`; a failed upload sends nothing).

Live, on the phone (not runnable from here):

1. Desktop: Settings → Mobile → Project files on the phone **on**.
2. iPad (Home Screen PWA): an agent tab on a LaTeX project → swipe right from
   the left third → open the built PDF → **Mark up**; pages render (no Mark
   up on the project screen's drawer).
3. With the Pencil: strike a word and write its replacement above, circle a
   figure and write "smaller" beside it, highlight a sentence; the page never
   scrolls while writing, a resting palm draws nothing, fingers scroll and
   zoom. Close, reopen — the ink is still there. Desktop: nothing new in
   `.tabtivity/inbox/`, the PDF's mtime unchanged.
4. Submit → the chat shows the prompt naming the PDF; the inbox holds
   `…-marked.pdf` (the handwriting visible as ink annotations in the desktop
   viewer and in another PDF reader) and one layer PNG per marked page. Reopen
   — the layer is gone. The agent edits the `.tex`, rebuilds, and the rebuilt
   PDF arrives as a bubble in the same chat via `tabtivity-send`.
5. Same on a picture (`…-marked.png` + layer), and on a PDF the agent sent with
   `tabtivity-send`.
6. Submit while the agent works → held and delivered like a typed message.
7. A 100+ page PDF scrolls without the tab reloading; a PDF with JPX images
   renders with those images blank, nothing else broken.
8. Desktop on Windows and macOS: the same Submit produces the marked copy.
