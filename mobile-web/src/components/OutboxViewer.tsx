import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { useT } from "../../../src/lib/i18n";
import { openOutside, refreshProjectFile, sentName, viewerFileUrl, type OutboxFile, type TabRow, type ViewerScope } from "../api";
import { layerKey } from "../markup/store";
import { shareAs, useOutboxShare } from "../outboxShare";
import { sizeLabel } from "../terminal/fileLabels";
import { isUntested } from "../../../src/lib/untested";
import { MarkupView } from "./MarkupView";
import type { AgentSignal } from "../markup/submitState";
import { openingOutsideStrands } from "../platform";

/** How a markup prompt left: into the agent's queue (it was working), typed
 * straight in, or not at all. */
export type MarkupSend = "queued" | "sent" | false;

/** What the viewer needs to offer **Mark up** (an agent tab's chat): the tab
 * the prompt goes to, the project the phone-side layer is kept under, a
 * project file's folder trail, the send into the chat, what the agent is
 * doing now (the round's pill), and how to find the file's newest version
 * for **Reload** (`docs/pdf_markup_rounds_plan.md` §2.2–2.3). */
export type MarkupTarget = {
  tabId: string;
  projectId: string;
  place?: string;
  onSend: (text: string) => MarkupSend;
  agent?: AgentSignal;
  /** The file as it is now — a fresh listing row, or a newer copy — or
   * `null` when it is gone. */
  refresh?: (file: OutboxFile) => Promise<OutboxFile | null>;
};

/** **Mark up** where no agent tab is open to send to (the project screen, a
 * shell tab): Submit opens a new tab of the desktop's default agent in
 * `projectId`, hands it the prompt, and `show`s it (`markup/newTab.ts`).
 * `place` and `refresh` are a project file's, as in `MarkupTarget`. */
export type MarkupNewTab = {
  projectId: string;
  place?: string;
  show: (tab: TabRow) => void;
  refresh?: (file: OutboxFile) => Promise<OutboxFile | null>;
};

const INLINE_LIMIT = 1024 * 1024;
/** How much of a text **Open the whole file** reads into the app itself. */
const WHOLE_LIMIT = 8 * 1024 * 1024;

/** Read only the preview bytes; cancel the stream once the inline cap is met. */
export async function readTextPreview(response: Response, limit = INLINE_LIMIT): Promise<string> {
  if (!response.ok || !response.body) throw new Error("read_failed");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let remaining = limit;
  let text = "";
  try {
    while (remaining > 0) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, remaining);
      text += decoder.decode(part, { stream: true });
      remaining -= part.length;
    }
    return text + decoder.decode();
  } finally { await reader.cancel(); }
}

/** How far a finger has to travel sideways, in CSS pixels, before a swipe on
 * the picture steps to the next one rather than reading as a wobbly tap. */
const SWIPE = 48;
/** How far in a pinch may go, and where a double tap lands. */
const MAX_SCALE = 8;
const TAP_SCALE = 2.5;
/** Two taps this close in time and place are one double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

/** The picture's zoom and pan: `scale` about the stage's centre, then shifted
 * by `x`, `y` CSS pixels. `scale` 1 is the whole picture letterboxed. */
export type PictureView = { scale: number; x: number; y: number };
export const FIT: PictureView = { scale: 1, x: 0, y: 0 };
type Size = { width: number; height: number };

/** Keeps the zoom in range and the picture over the stage: a picture smaller
 * than the stage on an axis stays centred on it, a larger one can be dragged
 * until its edge meets the stage's, never past. `shown` is the picture's
 * letterboxed size at scale 1. */
export function clampView(view: PictureView, stage: Size, shown: Size): PictureView {
  const scale = Math.min(MAX_SCALE, Math.max(1, view.scale));
  const spanX = Math.max(0, (shown.width * scale - stage.width) / 2);
  const spanY = Math.max(0, (shown.height * scale - stage.height) / 2);
  return {
    scale,
    x: Math.min(spanX, Math.max(-spanX, view.x)),
    y: Math.min(spanY, Math.max(-spanY, view.y)),
  };
}

/** Zooms `from` to `scale` about `point` (stage coordinates, origin at the
 * stage's centre), so what was under `point` stays under it — and, for a
 * pinch whose fingers moved, under `to`. */
export function zoomAbout(from: PictureView, scale: number, point: { x: number; y: number }, to = point): PictureView {
  const ratio = scale / from.scale;
  return { scale, x: to.x - ratio * (point.x - from.x), y: to.y - ratio * (point.y - from.y) };
}

/** The picture's size letterboxed into the stage (`object-fit: contain`). */
function shownSize(img: HTMLImageElement | null, stage: Size): Size {
  if (!img || !img.naturalWidth || !img.naturalHeight) return stage;
  const fit = Math.min(stage.width / img.naturalWidth, stage.height / img.naturalHeight);
  return { width: img.naturalWidth * fit, height: img.naturalHeight * fit };
}

/**
 * One file the desktop sent, full screen. A picture opened from the gallery
 * steps through the gallery's other pictures in place — ‹ ›, a sideways swipe,
 * or the arrow keys — rather than making the reader close it, find the next
 * tile and open that: a run of plots is looked at one after another. Only the
 * pictures are stepped through; a text or a PDF is a different kind of look.
 *
 * The picture itself zooms and pans in the stage — a pinch, a double tap, a
 * drag once zoomed — rather than leaving the pinch to the browser, which
 * zooms the whole page and then cannot pan it. A swipe steps only while the
 * picture is at its fitted size; zoomed in, a drag moves the picture.
 */
export function OutboxViewer({ scope, file, pictures, onStep, onClose, markup, newTab }: {
  /** Where the bytes come from: the outbox, or the project's own tree (the
   * read-only file browser, `ProjectFiles`) — the same viewer for both. */
  scope: ViewerScope;
  file: OutboxFile;
  /** The pictures to step through, in the gallery's order (newest first).
   * Left out, or when `file` is not among them, the viewer shows one file. */
  pictures?: readonly OutboxFile[];
  /** Shows another of `pictures` in place of this one. */
  onStep?: (file: OutboxFile) => void;
  onClose: () => void;
  /** Given, a PDF or a picture carries **Mark up** (`MarkupView`). */
  markup?: MarkupTarget;
  /** With no `markup`: Mark up still shows, and Submit opens a new agent tab. */
  newTab?: MarkupNewTab;
}) {
  const t = useT();
  const [marking, setMarking] = useState(false);
  const url = viewerFileUrl(scope, file);
  const isImage = file.kind.startsWith("image/");
  const steps = isImage && onStep ? pictures ?? [] : [];
  const index = steps.findIndex((picture) => (picture.ref ?? picture.name) === (file.ref ?? file.name));
  // Newest first, so "next" is the older picture — the way the grid reads.
  const previous = index > 0 ? steps[index - 1] : null;
  const next = index >= 0 && index < steps.length - 1 ? steps[index + 1] : null;
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const [view, setView] = useState<PictureView>(FIT);
  // Pointer events can outrun a render; the handlers read the view from here.
  const live = useRef<PictureView>(FIT);
  const show = (next: PictureView) => { live.current = next; setView(next); };
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    /** The view and finger(s) when the current gesture last changed shape. */
    startView: PictureView;
    start: { x: number; y: number };
    distance: number;
    /** Whether this gesture ever had two fingers — a pinch is never a swipe. */
    pinched: boolean;
    lastTap: { at: number; x: number; y: number } | null;
  }>({ pointers: new Map(), startView: FIT, start: { x: 0, y: 0 }, distance: 0, pinched: false, lastTap: null });
  const [text, setText] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const isText = file.kind.startsWith("text/");
  // The whole of a long text is read in here, not handed to the browser's
  // own tab: on an iPhone or iPad the installed app could not be got back to
  // from there. Only a text too big for that still goes out — where it can.
  const [wholeOf, setWholeOf] = useState<string | null>(null);
  const whole = wholeOf === url;
  const strands = openingOutsideStrands();
  const sharing = useOutboxShare(scope);
  const { prepare } = sharing;
  const shareable = shareAs(file) !== null;
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setFailure("");
    if (isText) void fetch(url, { signal: controller.signal }).then((response) => readTextPreview(response, whole ? WHOLE_LIMIT : INLINE_LIMIT)).then(
      (body) => { if (!controller.signal.aborted) setText(body); },
      () => { if (!controller.signal.aborted) setFailure(t("mobile.outbox.error")); },
    );
    return () => controller.abort();
  }, [url, isText, whole, t]);
  // Fetch the bytes on opening, so a tap on Share shares at once rather than
  // after the radio — the button itself does not wait for them.
  useEffect(() => { prepare(file); }, [prepare, file]);
  useEffect(() => {
    // Marking up, the arrow keys belong to the note being typed.
    if (!onStep || marking || (!previous && !next)) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.key === "ArrowLeft" ? previous : event.key === "ArrowRight" ? next : null;
      if (!target) return;
      event.preventDefault();
      onStep(target);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onStep, marking, previous, next]);
  useEffect(() => {
    // Warm the neighbours, so a step lands on a picture rather than a blank
    // while it loads over the phone's radio.
    for (const neighbour of [previous, next]) {
      if (neighbour) new Image().src = viewerFileUrl(scope, neighbour);
    }
  }, [scope, previous, next]);

  useEffect(() => {
    // A turned phone reshapes the stage; start the picture over, fitted.
    const onResize = () => { live.current = FIT; setView(FIT); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /** The stage's size, and a pointer's position relative to its centre. */
  const measure = () => {
    const rect = stage.current?.getBoundingClientRect();
    const size = { width: rect?.width ?? 0, height: rect?.height ?? 0 };
    const at = (pointer: { x: number; y: number }) => ({
      x: pointer.x - (rect?.left ?? 0) - size.width / 2,
      y: pointer.y - (rect?.top ?? 0) - size.height / 2,
    });
    return { size, at, clamp: (next: PictureView) => clampView(next, size, shownSize(image.current, size)) };
  };
  /** Restarts the gesture from the fingers now down, so adding or lifting a
   * finger mid-gesture carries on from where the picture is. */
  const rebase = (current: PictureView) => {
    const g = gesture.current;
    const points = [...g.pointers.values()];
    g.startView = current;
    g.start = points.length === 2
      ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
      : points[0] ?? { x: 0, y: 0 };
    g.distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
  };
  const onPointerDown = (event: PointerEvent) => {
    // ‹ › are buttons on the stage; their taps are theirs.
    if ((event.target as Element).closest("button")) return;
    const g = gesture.current;
    if (g.pointers.size >= 2) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (g.pointers.size === 0) g.pinched = false;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (g.pointers.size === 2) g.pinched = true;
    rebase(live.current);
  };
  const onPointerMove = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const { at, clamp } = measure();
    const points = [...g.pointers.values()];
    if (points.length === 2) {
      const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
      const scale = Math.min(MAX_SCALE, Math.max(1, g.startView.scale * (g.distance ? distance / g.distance : 1)));
      show(clamp(zoomAbout(g.startView, scale, at(g.start), at(middle))));
    } else if (g.startView.scale > 1) {
      show(clamp({ ...g.startView, x: g.startView.x + event.clientX - g.start.x, y: g.startView.y + event.clientY - g.start.y }));
    }
  };
  const onPointerUp = (event: PointerEvent) => {
    const g = gesture.current;
    if (!g.pointers.has(event.pointerId)) return;
    g.pointers.delete(event.pointerId);
    if (g.pointers.size > 0) { rebase(live.current); return; }
    if (g.pinched || event.type === "pointercancel") return;
    const dx = event.clientX - g.start.x;
    const dy = event.clientY - g.start.y;
    if (Math.abs(dx) < DOUBLE_TAP_PX && Math.abs(dy) < DOUBLE_TAP_PX) {
      // A double tap zooms in on where it landed, or back out to the fit.
      const last = g.lastTap;
      if (last && event.timeStamp - last.at < DOUBLE_TAP_MS
        && Math.abs(event.clientX - last.x) < DOUBLE_TAP_PX && Math.abs(event.clientY - last.y) < DOUBLE_TAP_PX) {
        g.lastTap = null;
        const { at, clamp } = measure();
        const current = live.current;
        show(current.scale > 1 ? FIT : clamp(zoomAbout(current, TAP_SCALE, at({ x: event.clientX, y: event.clientY }))));
      } else {
        g.lastTap = { at: event.timeStamp, x: event.clientX, y: event.clientY };
      }
      return;
    }
    // A sideways swipe steps; one mostly up or down is left alone, and a
    // zoomed picture's drag was a pan.
    if (live.current.scale > 1 || !onStep) return;
    if (Math.abs(dx) < SWIPE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const target = dx < 0 ? next : previous;
    if (target) onStep(target);
  };
  const zoomed = view.scale > 1;
  const stepping = index >= 0 && steps.length > 1;
  const isPdf = file.kind === "application/pdf";
  /** Without an agent tab, the new-tab Submit (`newTab`). */
  const fresh = markup ? undefined : newTab;
  const markable = (markup || fresh) && isImage && file.kind !== "image/gif";
  /** The project the marks are kept under — a real one, not the `tab:<id>`
   * stand-in a tab without a project gets. */
  const target = markup?.projectId ?? fresh?.projectId;
  const row = file.file_row;
  /** An outbox copy of a project file the drawer would list (`file_row`):
   * the PDF reader and Mark up open that file itself, through the drawer's
   * door, so one project file has one layer wherever it is opened from — the
   * drawer, the chat, the gallery, the Focus banner — and Submit's SyncTeX
   * lines and Reload see the file, not a copy of it. The copy's own marks
   * move over once (`adoptFrom`). Plain viewing — a picture, its stepping,
   * Save and Share — stays on the copy. */
  const inFiles = "files" in scope;
  const shared = useMemo(() => {
    if (!row || inFiles || !target || target.startsWith("tab:")) return null;
    const projectFile: OutboxFile = { name: row.name, kind: row.kind, size: row.size, modified: row.modified, ref: row.token };
    return {
      scope: { files: target } as ViewerScope,
      file: projectFile,
      place: row.place,
      refresh: refreshProjectFile(target, row.folder),
      adoptFrom: layerKey(target, { outbox: file.name }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the row's fields, not its object: a listing poll hands a new one
  }, [row?.token, row?.name, row?.kind, row?.size, row?.modified, row?.place, row?.folder, inFiles, target, file.name]);
  /** What Mark up (and a PDF's reader) shows: the project file, or the file. */
  const marked = shared ?? { scope, file, place: markup?.place ?? fresh?.place, refresh: markup?.refresh ?? fresh?.refresh, adoptFrom: undefined };
  if (marking && (markup || fresh)) {
    return <MarkupView tabId={markup?.tabId} projectId={target} scope={marked.scope} file={marked.file} place={marked.place}
      onSend={markup?.onSend} newTab={fresh} agent={markup?.agent} refresh={marked.refresh} adoptFrom={marked.adoptFrom} onClose={() => setMarking(false)} />;
  }
  const actions = <>
    {markable && <button className="outbox-action" onClick={() => setMarking(true)} aria-label={t("mobile.markup.openFile", { name: sentName(file) })}>{t("mobile.markup.open")}</button>}
    <a className="outbox-action" href={viewerFileUrl(scope, file, true)} download={sentName(file)}>{t("mobile.outbox.save")}</a>
    {shareable && <button className="outbox-action" disabled={sharing.busy === file.name} onClick={() => void sharing.share(file)}>
      {t(sharing.ready === file.name ? "mobile.outbox.shareReady" : "mobile.outbox.share")}
    </button>}
    {shareable && isUntested("mobile.outbox.share") && <span className="untested">{t("mobile.outbox.untested")}</span>}
  </>;
  // A PDF's pages are drawn here, by the sealed pdf.js frame, and Mark up
  // switches on in that same view.
  if (isPdf) {
    return <MarkupView tabId={markup?.tabId} projectId={target} place={marked.place} onSend={markup?.onSend}
      newTab={fresh} agent={markup?.agent} refresh={marked.refresh} scope={marked.scope} file={marked.file} adoptFrom={marked.adoptFrom} onClose={onClose}
      reader={{ actions, alert: sharing.failed === file.name ? t("mobile.outbox.shareError") : undefined }} />;
  }
  return <div className={`outbox-viewer${isText ? " outbox-text-sheet" : ""}`} role="dialog" aria-modal="true" aria-label={sentName(file)}>
    <div className="outbox-viewer-head">
      <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")}>✕</button>
      <div className="outbox-viewer-title">
        <h2>{sentName(file)}</h2>
        <small>
          {stepping && `${t("mobile.outbox.position", { index: index + 1, count: steps.length })} · `}{sizeLabel(file.size)}
          {((stepping && isUntested("mobile.outbox.step")) || (isImage && isUntested("mobile.outbox.zoom"))
            || (isText && file.size > INLINE_LIMIT && isUntested("mobile.outbox.wholeText")))
            && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </small>
      </div>
      {actions}
    </div>
    {(failure || sharing.failed === file.name) && <p role="alert">{failure || t("mobile.outbox.shareError")}</p>}
    {isText ? <div className="outbox-text-body">
      <pre>{text ?? (failure ? "" : t("mobile.outbox.loading"))}</pre>
      {file.size > INLINE_LIMIT && !whole && (file.size <= WHOLE_LIMIT || !strands) && <button className="outbox-open"
        onClick={() => { if (file.size <= WHOLE_LIMIT) setWholeOf(url); else void openOutside(url); }}>{t("mobile.outbox.whole")}</button>}
    </div> : isImage ? <div ref={stage} className={`outbox-viewer-stage${zoomed ? " zoomed" : ""}`}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <img ref={image} src={url} alt={sentName(file)} draggable={false}
        style={zoomed ? { transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` } : undefined} />
      {previous && <button className="outbox-step outbox-step-previous" onClick={() => onStep?.(previous)} aria-label={t("mobile.outbox.previous")}><span aria-hidden="true">‹</span></button>}
      {next && <button className="outbox-step outbox-step-next" onClick={() => onStep?.(next)} aria-label={t("mobile.outbox.next")}><span aria-hidden="true">›</span></button>}
    </div> : null}
  </div>;
}
