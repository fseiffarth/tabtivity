import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { ApiError, holdPrompt, markupUndoConflict, MAX_INBOX_FILE, previewMarkupUndo, runMarkupUndo, sentName, settleMarkupUndo, submitMarkup, uploadToInbox, viewerFileUrl, type MarkupSource, type MarkupUndoChanges, type OutboxFile, type TabRow, type ViewerScope } from "../api";
import { acceptFrameMessage, MAX_FRAME_PAGES, MAX_RENDER_WIDTH, type FrameFailure, type FromFrame, type ToFrame } from "../markup/frameProtocol";
import { anchorsFor, type Anchor } from "../markup/anchors";
import type { TextRun } from "../markup/findText";
import { readFlag, writeFlag } from "../prefs";
import {
  addMark, approveMark, approveMarks, canAdd, canReplace, clampToPage, clearAll, clearPage, clearSent, commit, eraseAlong, eraseAt, finishStroke, forgetRound, stylusErases, hasSent, inkWidth, isEmpty, MARK_COLORS, markAnchors, markBox, markedPages,
  markSent, mintRound, moveNote, noteAt, redo, replaceMark, round, startHistory, tickedMarks, undo,
  type BoxMark, type History, type InkMark, type Layer, type Mark, type MarkColor, type PageLayer, type TextMark,
} from "../markup/layer";
import { composedPng, drawMark, drawPage, INK, LAYER_WIDTH, layerPng, pagePng, type Paint } from "../markup/rasterize";
import { openMarkupTab, useOpenedTabAgent } from "../markup/newTab";
import { layerKey, loadLayer, moveLayer, saveLayer, stale, type Fingerprint } from "../markup/store";
import { canApply, canUndo, followRound, holdsUndo, nextCheck, startRound, stepRound, undoneRound, undoSummary, type AgentSignal, type Round, type RoundPhase } from "../markup/submitState";
import { DEFAULT_MARKUP_APPLY, DEFAULT_MARKUP_ASK, markupForSubagent, markupUndoNote, readMarkupApply, readMarkupAsk, readMarkupDirect, readMarkupInstruction } from "../markupInstruction";
import { readMarkupOpen } from "../markupOpen";
import { sizeLabel } from "../terminal/fileLabels";
import { AGENT_STATUS_GLYPH } from "./AgentStatusPill";
import type { MarkupNewTab, MarkupSend } from "./OutboxViewer";
import { storageDashKey } from "../../../src/lib/brand";
import { useMarkupAsks } from "../markup/questions";
import { ARRIVAL_GUARD_MS, MarkupQuestionsCard, type QuestionFocus } from "./MarkupQuestionsCard";
import { EraserIcon } from "../markup/EraserIcon";
import { OptionSheet } from "./OptionSheet";

type Tool = "ink" | "box" | "text" | "eraser";
type Size = [number, number];
type Picture = { bitmap: ImageBitmap; width: number };
type Failure = FrameFailure | "tooLarge" | "fetch" | "timeout" | "picture";

/** Room between pages, CSS pixels. */
const GAP = 12;
/** The widest a page fits to before a pinch: an iPad held sideways would
 * otherwise show a third of a page at a time, rendered past the frame's
 * pixel cap. Narrower pages sit centred. */
const FIT_WIDTH = 960;
/** How far the view zooms in. */
const MAX_ZOOM = 4;
/** Page pictures kept alive at once — Safari's canvas memory is the limit. */
const MAX_ALIVE = 6;
/** How long the frame may take to open a document before it is given up,
 * and to draw one page before that page is. */
const OPEN_TIMEOUT = 45_000;
const RENDER_TIMEOUT = 20_000;
/** Remembered once a pen has drawn here: from then on only the pen draws,
 * unless the reader turns "pen only" off again. */
const PEN_KEY = storageDashKey("markup-pen");
/** How far a finger or pen travels on a note before it is a drag, not a tap. */
const DRAG_SLOP = 8;
/** The eraser's reach, CSS pixels. */
const ERASE_PX = 12;
/** How strongly the marks of earlier rounds show — sent, never sent again. */
const SENT_ALPHA = 0.35;
/** How far, CSS pixels, a mark must lie past where the view is for Previous /
 * Next mark to go to it — so a repeated tap moves on rather than landing on
 * the mark it just showed. */
const JUMP_SLACK = 4;
/** A ✓ badge's size, CSS pixels. */
const TICK_BADGE = 26;
/** How soon after one approve a second tap is taken: a double tap must not
 * take whichever badge lies under the finger next. */
const TICK_REPEAT_MS = 350;

/** A ✓ badge's React key: its mark's identity, not its index — an approved
 * mark's badge goes with it, so a second tap never lands on the next mark
 * that slides into its index (as the desktop's `PdfMarkupTicks`). */
const tickIds = new WeakMap<Mark, number>();
let nextTickId = 0;
function tickKey(mark: Mark): number {
  let id = tickIds.get(mark);
  if (id === undefined) {
    id = ++nextTickId;
    tickIds.set(mark, id);
  }
  return id;
}

/** The round pill's words, by phase; `finished` takes the PDF check's. */
const ROUND_KEYS: Record<Exclude<RoundPhase, "finished">, TranslationKey> = {
  sent: "mobile.markup.round.sent",
  queued: "mobile.markup.round.queued",
  working: "mobile.markup.round.working",
  question: "mobile.markup.round.question",
  unconfirmed: "mobile.markup.round.unconfirmed",
};
/** The desktop's glyph the pill wears, where a phase has one. */
const ROUND_GLYPH: Partial<Record<RoundPhase, "working" | "question" | "done">> = { working: "working", question: "question", finished: "done" };

const FAILURE_KEYS: Record<Failure, TranslationKey> = {
  unreadable: "mobile.markup.failed.unreadable",
  encrypted: "mobile.markup.failed.encrypted",
  render: "mobile.markup.failed.unreadable",
  unsupported: "mobile.markup.failed.unreadable",
  tooLarge: "mobile.markup.failed.tooLarge",
  fetch: "mobile.markup.failed.fetch",
  timeout: "mobile.markup.failed.timeout",
  picture: "mobile.markup.failed.picture",
};

/** Why a step of Submit failed, in the reader's words. */
const REASON_KEYS: Record<string, TranslationKey> = {
  file_too_large: "mobile.markup.reason.tooLarge",
  inbox_full: "mobile.markup.reason.inboxFull",
  offline: "mobile.markup.reason.offline",
  timeout: "mobile.markup.reason.timeout",
  files_off: "mobile.markup.reason.filesOff",
  file_not_found: "mobile.markup.reason.gone",
  tab_not_found: "mobile.markup.reason.gone",
  project_unavailable: "mobile.markup.reason.project",
  no_agent: "mobile.markup.reason.noAgent",
  desktop_unavailable: "mobile.markup.reason.desktop",
};

/** Why an asked-for `apply` round runs as `list` (the desktop's `noUndo`). */
const NO_UNDO_KEYS: Record<string, TranslationKey> = {
  not_git: "mobile.markup.noUndo.notGit",
  no_git: "mobile.markup.noUndo.noGit",
  too_big: "mobile.markup.noUndo.tooBig",
  filtered: "mobile.markup.noUndo.filtered",
  git_failed: "mobile.markup.noUndo.gitFailed",
  remote: "mobile.markup.noUndo.remote",
  not_pdf: "mobile.markup.noUndo.notPdf",
};

/** `none`: no pen has drawn here, so a finger draws. `pen`: only the pen
 * draws and fingers scroll. `fingers`: a pen has drawn, but fingers draw too. */
type PenMode = "none" | "pen" | "fingers";

function readPenMode(): PenMode {
  try {
    const stored = localStorage.getItem(PEN_KEY);
    return stored === "1" ? "pen" : stored === "fingers" ? "fingers" : "none";
  } catch { return "none"; }
}
function rememberPenMode(mode: Exclude<PenMode, "none">): void {
  try { localStorage.setItem(PEN_KEY, mode === "pen" ? "1" : "fingers"); } catch { /* a convenience only */ }
}

/** The file name without its extension — what the inbox copies are called after. */
function stemOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A file's fingerprint — what its layer was drawn against. */
function fingerprintOf(file: OutboxFile): Fingerprint {
  return { size: file.size, modified: file.modified };
}

/** Whether `next` is another file than `shown`, or the same one changed. */
function otherFile(shown: OutboxFile, next: OutboxFile): boolean {
  return next.name !== shown.name || next.size !== shown.size || next.modified !== shown.modified;
}

/** The sent marks dimmed, then the unsent ones over them. */
function paintLayer(ctx: Paint, page: PageLayer | undefined, sent: PageLayer | undefined, scale: number) {
  if (sent) {
    ctx.save();
    ctx.globalAlpha = SENT_ALPHA;
    drawPage(ctx, sent, scale);
    ctx.restore();
  }
  if (page) drawPage(ctx, page, scale);
}

/** One page's place in the scroller: its top and height, CSS pixels. */
function layout(sizes: Size[], width: number): { top: number; height: number }[] {
  let top = 0;
  return sizes.map(([w, h]) => {
    const height = width * h / w;
    const place = { top, height };
    top += height + GAP;
    return place;
  });
}

/** The picture of one PDF page, painted from the frame's bitmap. */
function PagePicture({ picture }: { picture: Picture | undefined }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    // A dropped picture gives its backing store back at once — Safari counts
    // canvas memory against the whole page.
    element.width = picture?.bitmap.width ?? 0;
    element.height = picture?.bitmap.height ?? 0;
    if (picture) element.getContext("2d")?.drawImage(picture.bitmap, 0, 0);
  }, [picture]);
  useEffect(() => () => {
    const element = canvas.current;
    if (element) { element.width = 0; element.height = 0; }
  }, []);
  return <canvas ref={canvas} className="markup-page-picture" aria-hidden="true" />;
}

/** The marks of one page, drawn over its picture. */
function LayerCanvas({ size, page, sent, preview, pixelWidth, register, n, handlers }: {
  size: Size;
  page: PageLayer | undefined;
  /** The page's marks from earlier rounds, drawn dimmed under `page`. */
  sent: PageLayer | undefined;
  /** A box being dragged out, drawn on top until it is let go. */
  preview: Mark | null;
  pixelWidth: number;
  register: (n: number, canvas: HTMLCanvasElement | null) => void;
  n: number;
  handlers: {
    onPointerDown: (n: number, event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLCanvasElement>) => void;
  };
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => () => {
    const element = canvas.current;
    if (element) { element.width = 0; element.height = 0; }
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    element.width = pixelWidth;
    element.height = Math.max(1, Math.round(pixelWidth * size[1] / size[0]));
    const ctx = element.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    const scale = pixelWidth / size[0];
    paintLayer(ctx, page, sent, scale);
    if (preview) {
      ctx.save();
      ctx.scale(scale, scale);
      drawMark(ctx, preview);
      ctx.restore();
    }
  }, [page, sent, preview, pixelWidth, size]);
  return <canvas
    ref={(element) => { canvas.current = element; register(n, element); }}
    className="markup-page-layer"
    onPointerDown={(event) => handlers.onPointerDown(n, event)}
    onPointerMove={handlers.onPointerMove}
    onPointerUp={handlers.onPointerUp}
    onPointerCancel={handlers.onPointerUp}
  />;
}

/** What a pointer is doing on a page between down and up. */
type Gesture =
  | { kind: "ink"; n: number; pointerId: number; mark: InkMark; last: [number, number] }
  | { kind: "box"; n: number; pointerId: number; start: [number, number]; end: [number, number] }
  | { kind: "erase"; n: number; pointerId: number; last: [number, number] }
  /** A tap places or edits a note; a drag from a note (`index`) moves it,
   * held where it was grabbed (`grab`, page units from its corner). */
  | { kind: "text"; n: number; pointerId: number; start: [number, number]; clientX: number; clientY: number; index: number; grab: [number, number]; moved: boolean };

/** A note being typed: where it goes, and which existing note it replaces. */
type NoteDraft = { n: number; at: [number, number]; index: number | null; text: string; color: MarkColor; size: number };

/**
 * **Mark up** — a PDF's pages or a picture with a layer to write on that
 * lives only on this phone (`docs/mobile_pdf_markup_plan.md`): handwriting
 * with a pen (Apple Pencil, a stylus), highlighter boxes, typed notes, an
 * eraser that takes whole strokes. Saved on the phone as each stroke ends,
 * never sent anywhere until **Submit**, which uploads each marked page's
 * layer, has the desktop bake a marked copy of a PDF, and puts the prompt it
 * answers into this tab's chat.
 *
 * A PDF is drawn by the sealed pdf.js frame (`pdf-frame.html`) — the PWA
 * never parses it; page pictures come back as bitmaps. A picture is shown by
 * the browser itself.
 *
 * Input, as the phone's own Markup has it: until a pen has drawn here one
 * finger draws and two scroll and pinch; once one has, only the pen draws and
 * fingers scroll — "Draw with the pen only" in the palette's ⋯ turns that
 * back. While a pen is down every finger is ignored (a resting palm). With
 * the note tool a finger may always tap a note to edit it or drag it.
 *
 * With `reader`, the same view first reads a PDF — the outbox viewer's page
 * view, the head carrying the viewer's own actions. The PDF stays inside the
 * app; handed to the phone's own viewer, the installed app could not be got
 * back to. Where marks can be sent (`onSend`), its Mark up switches the
 * markup on in place — same page, same zoom — and Done switches it off,
 * leaving the marks on show. Without `reader` the view opens marking, and
 * Done leaves it (`onClose`). The pen needs no Mark up tap: touching a page
 * switches the markup on and draws, as in the phone's own Markup and Notes.
 * Which mode the reader opens in is this phone's choice (`markupOpen.ts`).
 *
 * Submit keeps the view open (`docs/pdf_markup_rounds_plan.md`): the round's
 * marks move to the layer's sent side, drawn dimmed and never sent again, and
 * a pill follows the agent (`submitState.ts`) — sent / queued / working /
 * asking / finished. Marking goes on meanwhile; the next Submit sends only
 * the new marks. Once the agent has finished, **Reload PDF** draws the file
 * as it is now (or its newer copy, `refresh`) under the same layer.
 */
export function MarkupView({ tabId: givenTabId = "", projectId = "", scope, file: givenFile, place, onSend, newTab, agent: givenAgent = "idle", refresh, onClose, reader, adoptFrom }: {
  tabId?: string;
  /** The project the file belongs to — the phone-side layer's key. */
  projectId?: string;
  scope: ViewerScope;
  file: OutboxFile;
  /** A project file's folder trail (names), for its layer's key: a file
   * token is sealed afresh with every listing. */
  place?: string;
  /** Sends the desktop's prompt into the chat: `"queued"` behind the
   * agent's current step, `"sent"` straight in, `false` when it could not.
   * Absent, nothing can be marked — unless `newTab` is given. */
  onSend?: (text: string) => MarkupSend;
  /** No agent tab to send to: Submit opens one of the default agent and
   * hands it the prompt; the view stays, following that tab, and offers to
   * show it (`markup/newTab.ts`). */
  newTab?: MarkupNewTab;
  /** What the agent is doing now, for the round's pill. */
  agent?: AgentSignal;
  /** The file as it is now, for Reload — its fresh row or a newer copy; the
   * view keeps the file it shows itself, so its host never remounts it. */
  refresh?: (file: OutboxFile) => Promise<OutboxFile | null>;
  onClose: () => void;
  /** Opens reading: the head's actions (Save, Share), and what went wrong
   * with one of them. */
  reader?: { actions: ReactNode; alert?: string };
  /** The layer key of the outbox copy this project file is shown in place of
   * (`OutboxViewer`): marks drawn on the copy before the swap move over once,
   * while the project file has none of its own — never merged into some. */
  adoptFrom?: string;
}) {
  const t = useT();
  /** The file shown — the host's, until a Reload finds a newer one. */
  const [file, setFile] = useState(givenFile);
  const isPdf = file.kind === "application/pdf";
  const reading = reader !== undefined;
  const canMark = onSend !== undefined || newTab !== undefined;
  const url = viewerFileUrl(scope, file);
  const source = useMemo<MarkupSource>(() => ("files" in scope ? { files: file.ref ?? "" } : { outbox: file.name }), [scope, file.ref, file.name]);
  const keyOf = useCallback(
    (name: string) => layerKey(projectId, "files" in scope ? { files: `${place ?? ""}/${name}` } : { outbox: name }),
    [projectId, scope, place],
  );
  const key = useMemo(() => keyOf(file.name), [keyOf, file.name]);
  const fingerprint = useMemo<Fingerprint>(() => ({ size: file.size, modified: file.modified }), [file.size, file.modified]);
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const stem = stemOf(sentName(file));

  const [sizes, setSizes] = useState<Size[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [pictures, setPictures] = useState<Record<number, Picture>>({});
  const [pageFailures, setPageFailures] = useState<Set<number>>(() => new Set());
  const [history, setHistory] = useState<History>(() => startHistory());
  const [scratch, setScratch] = useState<Layer | null>(null);
  const [preview, setPreview] = useState<{ n: number; mark: Mark } | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storage, setStorage] = useState<"saved" | "unsaved">("saved");
  const [changed, setChanged] = useState(false);
  const [tool, setTool] = useState<Tool>("ink");
  const [color, setColor] = useState<MarkColor>("red");
  /** The reader opens marking where this phone asks for it: always, or —
   * Automatic — once only the pen draws, where fingers scroll all the same. */
  const [marking, setMarking] = useState(() => {
    if (!canMark) return false;
    if (!reading) return true;
    const open = readMarkupOpen();
    return open === "markup" || (open === "auto" && readPenMode() === "pen");
  });
  /** Automatic also opens marking when the saved layer has marks not yet
   * submitted — a round under way. Looked at once, as the layer loads. */
  const opensOnMarks = useRef(reading && canMark && readMarkupOpen() === "auto");
  const [penMode, setPenMode] = useState(readPenMode);
  const [popover, setPopover] = useState<"colors" | "more" | null>(null);
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const [sendFailure, setSendFailure] = useState<string | null>(null);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  const [viewWidth, setViewWidth] = useState(360);
  const [viewHeight, setViewHeight] = useState(640);
  const [scrollTop, setScrollTop] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [settledZoom, setSettledZoom] = useState(1);
  /** The last Submit's round, as the agent has taken it; `null` until one
   * went out from this view, or the agent is seen at work over sent marks. */
  const [submitted, setSubmitted] = useState<Round | null>(null);
  /** The tab a `newTab` Submit opened, and the key its create went out with:
   * a retry after a later step failed, and every later round, sends to that
   * tab, not a second one. The ref is read mid-Submit; the state renders. */
  const markupTab = useRef<TabRow | null>(null);
  const markupTabKey = useRef(crypto.randomUUID());
  const [openedTab, setOpenedTab] = useState<TabRow | null>(null);
  const openedAgent = useOpenedTabAgent(newTab?.projectId ?? projectId, onSend ? undefined : openedTab?.id);
  /** What the agent the marks go to is doing: the host's, or the opened tab's. */
  const agent: AgentSignal = onSend || !openedTab ? givenAgent : openedAgent;
  const [roundTick, setRoundTick] = useState(0);
  /** What the look at the file found when the agent finished. */
  const [check, setCheck] = useState<"changed" | "unchanged" | null>(null);
  const [showSent, setShowSent] = useState(true);
  /** Bumped by Reload: the sealed frame opens once, so it is remounted. */
  const [generation, setGeneration] = useState(0);
  /** The reloaded document has not told its pages yet — the old sizes stand
   * in, so the scroll holds, but no page is asked for. */
  const [reopening, setReopening] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadNote, setReloadNote] = useState<TranslationKey | null>(null);
  /** Reloaded since the agent last finished: Reload steps back to secondary. */
  const [reloaded, setReloaded] = useState(false);
  /** A PDF the agent changed loads under the marks once it finishes, without
   * a tap on Reload — this phone's choice, on unless turned off in ⋯. */
  const [autoReload, setAutoReload] = useState(() => readFlag("markupAutoReload", true));
  // Subagent mode: each Submit's prompt asks the agent to hand the round to a
  // new subagent of its own (`markupForSubagent`), off unless switched on.
  const [subagents, setSubagents] = useState(() => readFlag("markupSubagents"));
  /** The agent's markup questions (`markup_ask`) for this file: an agent
   * tab's view, or the tab a new-tab Submit opened — the card answers into
   * that tab. Polled while the view
   * is up and the page visible, and on each agent edge. */
  const askTab = onSend !== undefined ? givenTabId : openedTab?.id ?? "";
  const asksOn = askTab !== "";
  const [questionBusy, setQuestionBusy] = useState(false);
  const { asks, ticks, refresh: refreshAsks, drop: dropAsk } = useMarkupAsks(asksOn ? askTab : undefined, source, asksOn, agent, questionBusy);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  /** Which Submit's round id an `apply` round's undo id belongs to: an undone
   * round leaves the log, so its ticks badge nothing. Only the newest
   * round's undo can run (`holdsUndo`), so each Submit starts it afresh. */
  const undoRounds = useRef(new Map<string, string>());
  /** When each shown ✓ badge first appeared (`ARRIVAL_GUARD_MS`), and the
   * newest of them; when the last approve was taken. */
  const tickSeen = useRef(new Map<Mark, number>());
  const tickArrived = useRef(0);
  const lastApprove = useRef(0);
  /** Where each question's quote was found on its page (`findText`), by
   * `page\nquote`; absent while the frame has not answered. */
  const [found, setFound] = useState<Record<string, { x: number; y: number; w: number; h: number }[]>>({});
  const findAsked = useRef(new Map<string, number>());
  const findKeys = useRef(new Map<number, string>());
  const findId = useRef(0);
  /** Submit's own questions to the frame (`snapshot`, `text`), by id. */
  const frameCalls = useRef(new Map<number, (answer: FromFrame | null) => void>());
  const frameCallId = useRef(0);
  /** A pin tapped: the card opens at its question. */
  const [questionFocus, setQuestionFocus] = useState<QuestionFocus | null>(null);
  /** **Apply marks directly** (`docs/pdf_markup_direct_apply_plan.md`): the
   * tab the last Submit went to — its undo snapshot is that tab's — why an
   * asked-for `apply` round runs as `list`, the confirm sheet with what an
   * undo would put back, and how the last undo went. */
  const undoTab = useRef("");
  const [noUndo, setNoUndo] = useState<string | null>(null);
  /** The sheet carries the undo id it was read for: a new Submit meanwhile
   * replaces the round, never what the sheet's Undo runs. */
  const [undoSheet, setUndoSheet] = useState<{ id: string; changes: MarkupUndoChanges } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  /** Set at once on a tap, before the render that disables the button — a
   * double tap sends one request. */
  const undoBusyRef = useRef(false);
  const [undoNote, setUndoNote] = useState<{ text: string; alert: boolean } | null>(null);
  const submittedRef = useRef(submitted);
  submittedRef.current = submitted;
  /** An outbox view: the copy the last Submit's marks were drawn on — what an
   * undo puts the PDF back to — and, once an undo went through, the newest
   * copy the agent had sent by then. Copies up to that one show the undone
   * edits, so Reload (and the look after a finish) passes over them. A
   * project file needs neither: it is the file the undo restored. */
  const roundFile = useRef<OutboxFile | null>(null);
  const undoneUpTo = useRef<OutboxFile | null>(null);
  /** The view is up: an undo that answers after it closed tells the agent
   * still, but reloads (and moves the layer) no more. */
  const viewUp = useRef(true);
  useEffect(() => {
    viewUp.current = true;
    return () => { viewUp.current = false; };
  }, []);
  /** A question's chip tapped: its words on the page light up a moment. */
  const [pinFlash, setPinFlash] = useState<string | null>(null);

  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const pictureImage = useRef<HTMLImageElement>(null);
  const overlays = useRef(new Map<number, HTMLCanvasElement>());
  const gesture = useRef<Gesture | null>(null);
  const penDown = useRef(false);
  const touches = useRef(new Set<number>());
  const bytes = useRef<ArrayBuffer | null>(null);
  const frameReady = useRef(false);
  const opened = useRef(false);
  const inFlight = useRef<number | null>(null);
  const [renderTick, setRenderTick] = useState(0);
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number; mid: [number, number]; left: number; top: number } | null>(null);
  const pageCount = useRef(MAX_FRAME_PAGES);
  const skipSave = useRef(false);
  /** The key a Reload moved the layer to: the marks in hand are the ones to
   * keep there, not read back. */
  const movedTo = useRef<string | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const fileRef = useRef(file);
  fileRef.current = file;
  const awaitingMeta = useRef(true);
  const renderTimer = useRef<number | undefined>(undefined);
  const sizesRef = useRef<Size[] | null>(null);
  sizesRef.current = sizes;
  const picturesRef = useRef(pictures);
  picturesRef.current = pictures;
  const scratchRef = useRef<Layer | null>(null);
  const zoomRef = useRef(zoom);
  const markingRef = useRef(marking);
  markingRef.current = marking;
  const fingerDrawsRef = useRef(false);
  fingerDrawsRef.current = marking && penMode !== "pen";
  /** Reading, the pen on a page would switch the markup on and draw. */
  const penSwitchesRef = useRef(false);
  penSwitchesRef.current = canMark && !marking && loaded && sending === null;

  const layer = scratch ?? history.present;
  const baseWidth = Math.max(160, Math.min(FIT_WIDTH, viewWidth - 2 * GAP));
  const cssWidth = baseWidth * zoom;
  /** The pages' left margin at zoom `z`: centred while they fit. */
  const insetAt = (z: number) => Math.max(GAP, (viewWidth - baseWidth * z) / 2);
  const insetRef = useRef(insetAt);
  insetRef.current = insetAt;
  const settledWidth = baseWidth * settledZoom;
  const dpr = Math.min(2, typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const pixelWidth = Math.min(MAX_RENDER_WIDTH, Math.max(1, Math.round(settledWidth * dpr)));
  const places = useMemo(() => (sizes ? layout(sizes, cssWidth) : []), [sizes, cssWidth]);
  const contentHeight = places.length ? places[places.length - 1].top + places[places.length - 1].height : 0;

  // The pages around the visible ones — what gets a picture and a layer.
  const near = useMemo(() => {
    const result: number[] = [];
    places.forEach((spot, i) => {
      if (spot.top + spot.height >= scrollTop - viewHeight && spot.top <= scrollTop + 2 * viewHeight) result.push(i + 1);
    });
    return result;
  }, [places, scrollTop, viewHeight]);
  const current = useMemo(() => {
    const middle = scrollTop + viewHeight / 2;
    const index = places.findIndex((spot) => middle <= spot.top + spot.height + GAP);
    return index >= 0 ? index + 1 : Math.max(1, places.length);
  }, [places, scrollTop, viewHeight]);
  /** The near pages that get a picture and a layer canvas: the closest to
   * the reader, ties to the earlier page — one ranking for what is kept,
   * what is drawn and what is asked for, so none of them disagree. */
  const alive = useMemo(
    () => [...near].sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b).slice(0, MAX_ALIVE),
    [near, current],
  );

  // The saved layer, once per file — not again when a Reload gives the same
  // file a new fingerprint, which would call the marks drawn on it stale.
  useEffect(() => {
    if (!canMark) return;
    if (movedTo.current === key) { movedTo.current = null; return; }
    let live = true;
    void loadLayer(key).then(async (stored) => {
      if (stored === null && adoptFrom && adoptFrom !== key) {
        // The copy's marks, once: moved under this file's key (`moveLayer`
        // takes the record off the copy). Stamped with this file when the
        // copy was the same size, else with the copy's — so a file that has
        // changed since says so.
        const copy = await loadLayer(adoptFrom);
        if (copy && copy !== "unavailable" && (!isEmpty(copy.layer) || hasSent(copy.layer))) {
          const now = fingerprintRef.current;
          const fingerprint = copy.fingerprint.size === now.size ? now : copy.fingerprint;
          if (await moveLayer(adoptFrom, key, fingerprint)) stored = { ...copy, fingerprint };
        }
      }
      if (!live) return;
      if (stored === "unavailable") setStorage("unsaved");
      else if (stored) {
        // Not saved straight back: that would stamp the file's new
        // fingerprint on marks drawn against its old one.
        skipSave.current = true;
        setHistory(startHistory(stored.layer));
        setChanged(stale(stored, fingerprintRef.current));
        if (opensOnMarks.current && !isEmpty(stored.layer)) setMarking(true);
      }
      opensOnMarks.current = false;
      setLoaded(true);
    });
    return () => { live = false; };
  }, [canMark, key, adoptFrom]);

  // Saved as each change lands — never before the saved one was read.
  useEffect(() => {
    if (!loaded || !canMark) return;
    if (skipSave.current) { skipSave.current = false; return; }
    void saveLayer(key, history.present, fingerprint).then((ok) => setStorage(ok ? "saved" : "unsaved"));
  }, [loaded, canMark, key, history.present, fingerprint]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => {
      if (element.clientWidth > 0) setViewWidth(element.clientWidth);
      if (element.clientHeight > 0) setViewHeight(element.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useLayoutEffect(() => {
    const element = scroller.current;
    const target = pendingScroll.current;
    if (!element || !target) return;
    pendingScroll.current = null;
    element.scrollLeft = target.left;
    element.scrollTop = target.top;
  }, [zoom]);

  useEffect(() => {
    // Pages are re-drawn sharper only once a pinch has settled.
    const timer = window.setTimeout(() => setSettledZoom(zoom), 250);
    return () => window.clearTimeout(timer);
  }, [zoom]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);

  // --- The sealed frame (PDF only) ------------------------------------------
  const post = useCallback((message: unknown, transfer: Transferable[] = []) => {
    frame.current?.contentWindow?.postMessage(message, "*", transfer);
  }, []);
  /** The page in flight could not be drawn (or never answered): it is marked
   * failed so the queue moves on to the next one. */
  const renderFailed = useCallback((n = inFlight.current) => {
    window.clearTimeout(renderTimer.current);
    if (n === null) return;
    if (inFlight.current === n) inFlight.current = null;
    setPageFailures((known) => new Set(known).add(n));
    setRenderTick((tick) => tick + 1);
  }, []);
  const openIfReady = useCallback(() => {
    if (opened.current || !frameReady.current || !bytes.current) return;
    opened.current = true;
    const data = bytes.current;
    bytes.current = null;
    post({ type: "open", bytes: data }, [data]);
  }, [post]);

  /** One question to the frame for Submit; `null` when it does not answer in
   * time or the frame is remounted meanwhile. */
  const askFrame = useCallback((message: ToFrame & { id: number }): Promise<FromFrame | null> => new Promise((resolve) => {
    const timer = window.setTimeout(() => settle(null), RENDER_TIMEOUT);
    const settle = (answer: FromFrame | null) => {
      window.clearTimeout(timer);
      frameCalls.current.delete(message.id);
      resolve(answer);
    };
    frameCalls.current.set(message.id, settle);
    post(message);
  }), [post]);
  // A remounted frame answers nothing it was asked before.
  useEffect(() => () => {
    for (const settle of [...frameCalls.current.values()]) settle(null);
  }, [generation]);

  useEffect(() => {
    if (!isPdf) return;
    if (file.size > MAX_INBOX_FILE) { setFailure("tooLarge"); return; }
    const controller = new AbortController();
    void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error("fetch"))))
      .then((data) => {
        if (data.byteLength > MAX_INBOX_FILE) { setFailure("tooLarge"); return; }
        bytes.current = data;
        openIfReady();
      }, () => { if (!controller.signal.aborted) setFailure("fetch"); });
    const timer = window.setTimeout(() => { if (awaitingMeta.current) setFailure((was) => was ?? "timeout"); }, OPEN_TIMEOUT);
    return () => { controller.abort(); window.clearTimeout(timer); };
    // `generation`: a Reload fetches the bytes again, for the new frame.
  }, [isPdf, url, file.size, openIfReady, generation]);

  useEffect(() => {
    if (!isPdf) return;
    const onMessage = (event: MessageEvent) => {
      const message = acceptFrameMessage(event, frame.current?.contentWindow, pageCount.current);
      if (!message) {
        // A page the checks refused still came from the frame: give its
        // bitmap back and let the queue move on rather than wait forever.
        const data = event.data as { type?: unknown; bitmap?: unknown } | null;
        if (frame.current && event.source === frame.current.contentWindow && data && typeof data === "object" && data.type === "page") {
          if (typeof ImageBitmap !== "undefined" && data.bitmap instanceof ImageBitmap) data.bitmap.close();
          renderFailed();
        }
        return;
      }
      if (message.type === "ready") {
        frameReady.current = true;
        openIfReady();
      } else if (message.type === "meta") {
        pageCount.current = message.pages.length;
        awaitingMeta.current = false;
        setReopening(false);
        setSizes(message.pages.map(({ w, h }) => [w, h]));
      } else if (message.type === "page") {
        window.clearTimeout(renderTimer.current);
        inFlight.current = null;
        setPictures((known) => {
          known[message.n]?.bitmap.close?.();
          return { ...known, [message.n]: { bitmap: message.bitmap, width: message.width } };
        });
        setRenderTick((tick) => tick + 1);
      } else if (message.type === "snapshot" || message.type === "text") {
        const answer = frameCalls.current.get(message.id);
        if (answer) answer(message);
        else if (message.type === "snapshot") message.bitmap?.close();
      } else if (message.type === "found") {
        const key = findKeys.current.get(message.id);
        if (key !== undefined) setFound((known) => ({ ...known, [key]: message.rects }));
      } else if (message.n !== undefined) {
        renderFailed(message.n);
      } else {
        setFailure(message.code);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isPdf, openIfReady, renderFailed]);

  // One page in flight at a time, the nearest to where the reader is first;
  // pictures far away are let go.
  useEffect(() => {
    if (!isPdf || !sizes || failure || reopening) return;
    const keep = new Set(alive);
    setPictures((known) => {
      const drop = Object.keys(known).map(Number).filter((n) => !keep.has(n));
      if (!drop.length) return known;
      const next = { ...known };
      for (const n of drop) { next[n].bitmap.close?.(); delete next[n]; }
      return next;
    });
    if (inFlight.current !== null) return;
    const wanted = alive.find((n) => !pageFailures.has(n) && (!pictures[n] || pictures[n].width < pixelWidth * 0.9));
    if (wanted === undefined) return;
    inFlight.current = wanted;
    post({ type: "render", n: wanted, width: pixelWidth });
    // A frame that never answers (wedged on a hostile page) must not hold
    // up every other page.
    window.clearTimeout(renderTimer.current);
    renderTimer.current = window.setTimeout(() => renderFailed(wanted), RENDER_TIMEOUT);
  }, [isPdf, sizes, failure, reopening, alive, pictures, pageFailures, pixelWidth, post, renderTick, renderFailed]);

  // Each question's quote is looked for once per document: the sealed frame
  // reads the page's text and answers boxes (`findText`), never the text.
  useEffect(() => {
    if (!isPdf || !sizes || failure || reopening) return;
    for (const ask of asks) {
      for (const question of ask.questions) {
        if (!question.quote || question.page === undefined || question.page > sizes.length) continue;
        const key = `${question.page}\n${question.quote}`;
        if (findAsked.current.has(key)) continue;
        const id = ++findId.current;
        findAsked.current.set(key, id);
        findKeys.current.set(id, key);
        post({ type: "findText", id, page: question.page, quote: question.quote });
      }
    }
  }, [isPdf, sizes, failure, reopening, asks, post]);

  useEffect(() => () => {
    // Bitmaps are GPU memory; hand them back as the view goes.
    for (const picture of Object.values(picturesRef.current)) picture.bitmap.close?.();
    window.clearTimeout(renderTimer.current);
  }, []);

  // --- Touch: palm rejection, finger drawing, two-finger pan and pinch -------
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const isStylus = (event: TouchEvent) => [...event.changedTouches].some((touch) => (touch as Touch & { touchType?: string }).touchType === "stylus");
    // A finger that came down on a note to move it (its pointerdown fires
    // first) must not scroll the page instead.
    const holdsNote = () => { const g = gesture.current; return g?.kind === "text" && g.index >= 0; };
    const onTouchStart = (event: TouchEvent) => {
      // The Pencil would scroll the page and start a text selection. With the
      // markup off it scrolls like a finger — except on a page it can mark,
      // where it switches the markup on and draws (`onPointerDown`).
      const penSwitches = penSwitchesRef.current && (event.target as Element).closest?.(".markup-page-layer");
      if ((markingRef.current || penSwitches) && (penDown.current || isStylus(event))) { event.preventDefault(); return; }
      if (event.touches.length === 2) {
        const [a, b] = [event.touches[0], event.touches[1]];
        const rect = element.getBoundingClientRect();
        pinch.current = {
          distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom: zoomRef.current,
          mid: [(a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top],
          left: element.scrollLeft,
          top: element.scrollTop,
        };
        event.preventDefault();
        return;
      }
      if (event.touches.length === 1 && (holdsNote() || (fingerDrawsRef.current && (event.target as Element).closest?.(".markup-page-layer")))) event.preventDefault();
    };
    const onTouchMove = (event: TouchEvent) => {
      if (markingRef.current && (penDown.current || isStylus(event))) { if (event.cancelable) event.preventDefault(); return; }
      const start = pinch.current;
      if (start && event.touches.length === 2) {
        if (event.cancelable) event.preventDefault();
        const [a, b] = [event.touches[0], event.touches[1]];
        const rect = element.getBoundingClientRect();
        const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const next = Math.min(MAX_ZOOM, Math.max(1, start.zoom * (start.distance ? distance / start.distance : 1)));
        const mid: [number, number] = [(a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top];
        // What was under the fingers stays under them, and follows them —
        // measured from the pages' own edge, which moves while they are centred.
        const ratio = next / start.zoom;
        const inset = insetRef.current;
        const target = {
          left: (start.left + start.mid[0] - inset(start.zoom)) * ratio + inset(next) - mid[0],
          top: (start.top + start.mid[1]) * ratio - mid[1],
        };
        if (next === zoomRef.current) {
          // A plain two-finger drag: nothing re-renders, so scroll now.
          element.scrollLeft = target.left;
          element.scrollTop = target.top;
        } else {
          pendingScroll.current = target;
          zoomRef.current = next;
          setZoom(next);
        }
        return;
      }
      if (gesture.current && (fingerDrawsRef.current || holdsNote()) && event.cancelable) event.preventDefault();
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) pinch.current = null;
    };
    element.addEventListener("touchstart", onTouchStart, { passive: false });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
    };
  }, []);
  // --- Drawing ---------------------------------------------------------------
  const pageSize = (n: number): Size | null => sizes?.[n - 1] ?? null;
  const toPage = (n: number, canvas: HTMLCanvasElement, clientX: number, clientY: number): [number, number] => {
    const size = pageSize(n)!;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || cssWidth;
    const height = rect.height || cssWidth * size[1] / size[0];
    return clampToPage((clientX - rect.left) * size[0] / width, (clientY - rect.top) * size[1] / height, size);
  };
  const unitsPerPixel = (n: number, canvas: HTMLCanvasElement) => pageSize(n)![0] / (canvas.getBoundingClientRect().width || cssWidth);

  const add = (n: number, mark: Mark) => {
    const size = pageSize(n);
    if (!size) return;
    if (!canAdd(history.present, n, mark)) { setLimitHit(true); return; }
    setLimitHit(false);
    setHistory((now) => commit(now, addMark(now.present, n, size, mark)));
  };

  const onPointerDown = (n: number, event: ReactPointerEvent<HTMLCanvasElement>) => {
    const size = pageSize(n);
    if (!size || sending || !loaded) return;
    if (!marking) {
      // The pen marks without a Mark up tap first, as in the phone's own
      // Markup and Notes; the stroke it began is kept.
      if (event.pointerType !== "pen" || !canMark) return;
      markingRef.current = true;
      setMarking(true);
    }
    setPopover(null);
    if (event.pointerType === "pen") {
      penDown.current = true;
      if (penMode === "none") { setPenMode("pen"); rememberPenMode("pen"); }
    } else if (event.pointerType === "touch") {
      touches.current.add(event.pointerId);
      // A resting palm while the pen writes; a second finger is a pinch.
      if (penDown.current) return;
      if (touches.current.size > 1) {
        // The stroke a first finger began gives way to the pinch.
        const abandoned = gesture.current;
        gesture.current = null;
        setPreview(null);
        scratchRef.current = null;
        setScratch(null);
        if (abandoned) overlayRedraw(abandoned.n);
        return;
      }
      // Where only the pen draws, a finger still taps and drags notes; one
      // that turns out to scroll is cancelled by the browser.
      if (!fingerDrawsRef.current && tool !== "text") return;
    }
    const canvas = event.currentTarget;
    canvas.setPointerCapture?.(event.pointerId);
    const at = toPage(n, canvas, event.clientX, event.clientY);
    if (tool === "eraser" || stylusErases(event)) {
      gesture.current = { kind: "erase", n, pointerId: event.pointerId, last: at };
      scratchRef.current = eraseAt(history.present, n, at[0], at[1], ERASE_PX * unitsPerPixel(n, canvas), showSent);
      setScratch(scratchRef.current);
    } else if (tool === "ink") {
      const pressure = event.pointerType === "pen" && event.pressure > 0 ? event.pressure : 0.5;
      gesture.current = { kind: "ink", n, pointerId: event.pointerId, last: at, mark: { kind: "ink", color, width: round(Math.min(100, Math.max(0.1, size[0] / 350))), points: [[at[0], at[1], pressure]] } };
      paintPiece(n, at, at, pressure);
    } else if (tool === "box") {
      gesture.current = { kind: "box", n, pointerId: event.pointerId, start: at, end: at };
    } else {
      const index = noteAt(history.present.pages[n], at[0], at[1]);
      const grabbed = index >= 0 ? (history.present.pages[n].marks[index] as TextMark) : null;
      gesture.current = {
        kind: "text", n, pointerId: event.pointerId, start: at, clientX: event.clientX, clientY: event.clientY,
        index, grab: grabbed ? [at[0] - grabbed.at[0], at[1] - grabbed.at[1]] : [0, 0], moved: false,
      };
    }
  };

  /** Draws one piece of the stroke in progress straight onto the page's layer
   * canvas — the whole layer is redrawn, curved, when the stroke ends. */
  const paintPiece = (n: number, from: [number, number], to: [number, number], pressure: number) => {
    const canvas = overlays.current.get(n);
    const size = pageSize(n);
    const g = gesture.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !size || !ctx || g?.kind !== "ink") return;
    const scale = canvas.width / size[0];
    ctx.save();
    ctx.scale(scale, scale);
    ctx.lineCap = "round";
    ctx.strokeStyle = INK[g.mark.color];
    ctx.lineWidth = inkWidth(g.mark.width, pressure);
    ctx.beginPath();
    ctx.moveTo(from[0], from[1]);
    ctx.lineTo(to[0], to[1]);
    ctx.stroke();
    ctx.restore();
  };
  const overlayRedraw = (n: number) => {
    const canvas = overlays.current.get(n);
    const size = pageSize(n);
    const ctx = canvas?.getContext("2d");
    if (!canvas || !size || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    paintLayer(ctx, history.present.pages[n], showSent ? history.present.sent?.pages[n] : undefined, canvas.width / size[0]);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const canvas = event.currentTarget;
    if (g.kind === "ink") {
      const native = event.nativeEvent as PointerEvent;
      const samples = native.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [native]) {
        const at = toPage(g.n, canvas, sample.clientX, sample.clientY);
        const pressure = sample.pointerType === "pen" && sample.pressure > 0 ? sample.pressure : 0.5;
        paintPiece(g.n, g.last, at, pressure);
        g.mark.points.push([at[0], at[1], pressure]);
        g.last = at;
      }
    } else if (g.kind === "box") {
      g.end = toPage(g.n, canvas, event.clientX, event.clientY);
      setPreview({ n: g.n, mark: boxOf(g.start, g.end, color) });
    } else if (g.kind === "erase") {
      const at = toPage(g.n, canvas, event.clientX, event.clientY);
      scratchRef.current = eraseAlong(scratchRef.current ?? history.present, g.n, g.last, at, ERASE_PX * unitsPerPixel(g.n, canvas), showSent);
      g.last = at;
      setScratch(scratchRef.current);
    } else if (g.kind === "text" && g.index >= 0) {
      if (!g.moved && Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < DRAG_SLOP) return;
      g.moved = true;
      const size = pageSize(g.n);
      const grabbed = history.present.pages[g.n]?.marks[g.index];
      if (!size || grabbed?.kind !== "text") return;
      const at = toPage(g.n, canvas, event.clientX, event.clientY);
      scratchRef.current = replaceMark(history.present, g.n, g.index, moveNote(grabbed, [at[0] - g.grab[0], at[1] - g.grab[1]], size));
      setScratch(scratchRef.current);
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === "pen") penDown.current = false;
    if (event.pointerType === "touch") touches.current.delete(event.pointerId);
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    const size = pageSize(g.n);
    if (!size) return;
    if (event.type === "pointercancel" && g.kind !== "erase") {
      // A gesture the browser took over (a scroll) is not a mark, nor a move.
      setPreview(null);
      if (g.kind === "text") { scratchRef.current = null; setScratch(null); }
      overlayRedraw(g.n);
      return;
    }
    if (g.kind === "ink") {
      add(g.n, finishStroke(g.mark, size));
    } else if (g.kind === "box") {
      setPreview(null);
      const box = boxOf(g.start, g.end, color);
      if (box.rect[2] >= 2 && box.rect[3] >= 2) add(g.n, box);
    } else if (g.kind === "erase") {
      const erased = scratchRef.current;
      scratchRef.current = null;
      setScratch(null);
      if (erased) setHistory((now) => commit(now, erased));
    } else if (g.moved) {
      const moved = scratchRef.current;
      scratchRef.current = null;
      setScratch(null);
      if (moved) setHistory((now) => commit(now, moved));
    } else if (Math.hypot(event.clientX - g.clientX, event.clientY - g.clientY) < 12) {
      // A tap: edit the note under it, or start a new one there.
      const existing = g.index >= 0 ? (history.present.pages[g.n].marks[g.index] as TextMark) : null;
      const index = g.index;
      setNote(existing
        ? { n: g.n, at: existing.at, index, text: existing.text, color: existing.color, size: existing.size }
        : { n: g.n, at: [round(g.start[0]), round(g.start[1])], index: null, text: "", color, size: Math.min(200, Math.max(4, Math.round(size[0] / 40))) });
    }
  };
  const handlers = { onPointerDown, onPointerMove, onPointerUp };

  /** `text` null deletes the note being edited. Gives the layer it leaves. */
  const saveNote = (text: string | null): Layer => {
    const draft = note;
    setNote(null);
    if (!draft) return history.present;
    // Every control character but the line break — the desktop refuses them.
    const clean = (text ?? "").replace(/(?!\n)\p{Cc}/gu, "").trim();
    const mark: TextMark | null = clean ? { kind: "text", color: draft.color, at: draft.at, size: draft.size, text: clean } : null;
    if (draft.index !== null) {
      if (mark && !canReplace(history.present, draft.n, draft.index, mark)) { setLimitHit(true); return history.present; }
      const next = replaceMark(history.present, draft.n, draft.index, mark);
      setHistory((now) => commit(now, next));
      return next;
    }
    if (!mark) return history.present;
    const size = pageSize(draft.n);
    if (!size || !canAdd(history.present, draft.n, mark)) { if (size) setLimitHit(true); return history.present; }
    setLimitHit(false);
    const next = addMark(history.present, draft.n, size, mark);
    setHistory((now) => commit(now, next));
    return next;
  };

  /** Done: a note still open is kept, as the phone's own Markup keeps it. */
  const done = () => {
    gesture.current = null;
    setPreview(null);
    setPopover(null);
    const next = note ? saveNote(note.text) : history.present;
    if (reading) { setMarking(false); return; }
    // The view goes away before the save effect would run.
    if (note && loaded) void saveLayer(key, next, fingerprint).finally(onClose);
    else onClose();
  };

  // --- Submit ----------------------------------------------------------------
  /** The marked pages a Submit carries: a page past the end of the PDF (it
   * shrank on a Reload) keeps its marks, but they are not drawn or sent. */
  const sendable = markedPages(history.present).filter((n) => !isPdf || !sizes || n <= sizes.length);
  const leftOut = markedPages(history.present).length - sendable.length;
  const reason = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : "";
    return REASON_KEYS[code] ? t(REASON_KEYS[code]) : t("mobile.markup.reason.other", { code: code || "error" });
  };
  const submit = async () => {
    const marked = sendable;
    if (!marked.length || sending) return;
    setSendFailure(null);
    let tabId = givenTabId;
    if (!onSend) {
      if (!newTab) return;
      if (!markupTab.current) {
        setSending(t("mobile.markup.openingTab"));
        try {
          markupTab.current = await openMarkupTab(newTab.projectId, markupTabKey.current);
          setOpenedTab(markupTab.current);
        } catch (error) {
          setSending(null);
          setSendFailure(t("mobile.markup.sendFailed.tab", { reason: reason(error) }));
          return;
        }
      }
      tabId = markupTab.current.id;
    }
    const refs = new Map<number, string>();
    const composed = new Set<number>();
    const anchors = new Map<number, Anchor[]>();
    // The frame draws each page and reads its words while it holds the
    // document; past a failure, the marks go alone.
    let frameUp = isPdf && frameReady.current && opened.current && sizes !== null && !failure && !reopening;
    for (const n of marked) {
      setSending(t("mobile.markup.sendingPage", { n }));
      const page = history.present.pages[n];
      try {
        let png: Blob | null = null;
        if (frameUp) {
          const shot = await askFrame({ type: "snapshot", id: ++frameCallId.current, n, width: LAYER_WIDTH });
          if (shot?.type === "snapshot" && shot.bitmap) {
            try { png = await pagePng(shot.bitmap, page); } catch { png = null; } finally { shot.bitmap.close(); }
          }
          const text = shot ? await askFrame({ type: "text", id: ++frameCallId.current, page: n }) : null;
          const runs: TextRun[] = text?.type === "text" ? text.runs : [];
          const found = anchorsFor(page, runs);
          if (found.length) anchors.set(n, found);
          // A frame that stopped answering is not waited on page after page.
          if (!shot || !text) frameUp = false;
        }
        if (png) composed.add(n);
        refs.set(n, (await uploadToInbox(tabId, png ?? await layerPng(page), `${stem}-p${n}-${png ? "marked" : "layer"}.png`)).reference);
      } catch (error) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.layer", { n, reason: reason(error) }));
        return;
      }
    }
    let picture: string | undefined;
    if (!isPdf) {
      setSending(t("mobile.markup.sendingPicture"));
      try {
        const image = pictureImage.current;
        if (!image) throw new Error("picture");
        picture = (await uploadToInbox(tabId, await composedPng(image, history.present.pages[1]), `${stem}-marked.png`)).reference;
      } catch (error) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.picture", { reason: reason(error) }));
        return;
      }
    }
    setSending(t("mobile.markup.sendingMarks"));
    let prompt: string;
    const instruction = readMarkupInstruction();
    const ask = readMarkupAsk();
    const direct = readMarkupDirect();
    let answer: Awaited<ReturnType<typeof submitMarkup>>;
    // This Submit's id: the prompt names its marks under it, and the agent's
    // ticks (`markup_done`) come back with it.
    const roundId = mintRound();
    const present = history.present;
    try {
      answer = await submitMarkup(tabId, {
        source,
        pages: marked.map((n) => ({
          n, size: history.present.pages[n].size, marks: history.present.pages[n].marks, layer: refs.get(n)!,
          ...(composed.has(n) ? { composed: true } : {}),
          ...(anchors.has(n) ? { anchors: anchors.get(n) } : {}),
        })),
        ...(picture ? { picture } : {}),
        ...(instruction ? { instruction } : {}),
        ...(ask !== DEFAULT_MARKUP_ASK ? { ask } : {}),
        mode: direct ? "apply" : "list",
        round: roundId,
      });
      prompt = answer.prompt;
      if (subagents) prompt = markupForSubagent(prompt);
    } catch (error) {
      setSending(null);
      setSendFailure(t("mobile.markup.sendFailed.marks", { reason: reason(error) }));
      return;
    }
    let sent: MarkupSend;
    if (!onSend && markupTab.current) {
      // Held, not typed: the new CLI may still be starting, and the desktop
      // types a held prompt once the tab has started.
      try {
        await holdPrompt(markupTab.current.id, prompt);
      } catch (error) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.newTab", { reason: reason(error) }));
        return;
      }
      sent = agent !== "idle" ? "queued" : "sent";
    } else {
      sent = onSend?.(prompt) ?? false;
      if (!sent) {
        setSending(null);
        setSendFailure(t("mobile.markup.sendFailed.chat"));
        return;
      }
    }
    // The round's marks go to the sent side — dimmed, never sent again, past
    // undo — and the view stays open for the next round; the save effect
    // keeps the record. The round is logged with the marks as the request
    // listed them, which the agent's ticks index — unless a page changed
    // meanwhile (then its ticks would point at the wrong marks: none kept).
    setHistory((now) => {
      const asSent = marked.every((n) => now.present.pages[n]?.marks === present.pages[n].marks);
      return startHistory(markSent(now.present, marked, asSent ? roundId : undefined));
    });
    setShowSent(true);
    setCheck(null);
    setReloadNote(null);
    // The mode the desktop gave the round decides its follow-up — Undo or
    // Make these changes — never this phone's switch.
    const undo = answer.mode === "apply" && typeof answer.undo === "string" && answer.undo ? answer.undo : null;
    undoRounds.current.clear();
    if (undo) undoRounds.current.set(undo, roundId);
    undoTab.current = tabId;
    roundFile.current = fileRef.current;
    setNoUndo(direct && !undo ? answer.noUndo ?? null : null);
    setUndoNote(null);
    setUndoSheet(null);
    setSubmitted(startRound(sent === "queued", Date.now(), false, undo ? { id: undo, state: "ready" } : undefined));
    setSending(null);
  };

  /** A line into the agent's chat that is not a round — the note after an
   * Undo: sent as **Make these changes** sends its prompt. */
  const sendNote = async (text: string): Promise<boolean> => {
    if (onSend) return onSend(text) !== false;
    if (!markupTab.current) return false;
    try {
      await holdPrompt(markupTab.current.id, text);
      return true;
    } catch {
      return false;
    }
  };

  /** Why an undo call failed, as the pill's line: the files changed since
   * (nothing was changed), an undo the desktop no longer holds (offered no
   * more), or a plain failure — which may have put some files back. */
  const undoFailed = (error: unknown, step: "preview" | "undo", id: string) => {
    const conflict = markupUndoConflict(error);
    if (conflict) {
      const named = conflict.files.map((path) => `\`${path}\``).join(", ");
      const files = conflict.more > 0 ? t("mobile.markup.undo.andMore", { files: named || "…", count: conflict.more }) : named || "…";
      setUndoNote({ text: t("mobile.markup.undo.conflict", { files }), alert: true });
      return;
    }
    const code = error instanceof ApiError ? error.code : "";
    if (code === "undo_gone" || code === "round_not_found") {
      setSubmitted((was) => was && undoneRound(was, id));
      setUndoNote({ text: t("mobile.markup.undo.gone"), alert: true });
      return;
    }
    setUndoNote({ text: t(step === "preview" ? "mobile.markup.undo.previewFailed" : "mobile.markup.undo.failed", { reason: reason(error) }), alert: true });
  };

  /** **Undo**: first what it would put back, in the confirm sheet — not when
   * a new Submit replaced the round meanwhile. */
  const askUndo = async () => {
    const id = submitted?.undo?.id;
    const tab = undoTab.current;
    if (!id || undoBusyRef.current || !tab) return;
    undoBusyRef.current = true;
    setUndoNote(null);
    setUndoBusy(true);
    try {
      const changes = await previewMarkupUndo(tab, id);
      if (holdsUndo(submittedRef.current, id)) setUndoSheet({ id, changes });
    } catch (error) {
      if (holdsUndo(submittedRef.current, id)) undoFailed(error, "preview", id);
    }
    undoBusyRef.current = false;
    setUndoBusy(false);
  };

  /** The sheet's **Undo**: the files go back, the PDF is drawn again (the
   * Reload path), and the agent is told — a note, not a new round. The sent
   * marks stay: only the reader removes marks. */
  const runUndo = async () => {
    const id = undoSheet?.id;
    const tab = undoTab.current;
    setUndoSheet(null);
    if (!id || undoBusyRef.current || !tab) return;
    undoBusyRef.current = true;
    setUndoBusy(true);
    let done: MarkupUndoChanges;
    try {
      done = await runMarkupUndo(tab, id);
    } catch (error) {
      undoFailed(error, "undo", id);
      undoBusyRef.current = false;
      setUndoBusy(false);
      return;
    }
    setSubmitted((was) => was && undoneRound(was, id));
    // Its ticks mean nothing now: the round leaves the log (the marks stay).
    const undoneId = undoRounds.current.get(id);
    if (undoneId) {
      undoRounds.current.delete(id);
      const forget = (entry: Layer) => forgetRound(entry, undoneId);
      setHistory((now) => ({ past: now.past.map(forget), present: forget(now.present), future: now.future.map(forget) }));
    }
    // The files went back, whatever else happened since: the agent is told.
    const told = await sendNote(markupUndoNote(done.files.map((file) => file.path), done.more));
    setUndoNote(told ? { text: t("mobile.markup.undo.done"), alert: false } : { text: t("mobile.markup.undo.noteFailed"), alert: true });
    undoBusyRef.current = false;
    setUndoBusy(false);
    if (!isPdf || !viewUp.current) return;
    if ("files" in scope) {
      // The project file itself: the undo put it back (or says it kept it).
      void reloadRef.current();
      return;
    }
    // An outbox copy: the agent's copies so far show the undone edits — the
    // copy the round's marks were drawn on is the PDF as it is again.
    const shown = fileRef.current;
    let newest: OutboxFile = shown;
    try {
      const latest = await refreshRef.current?.(roundFile.current ?? shown);
      if (latest && latest.modified >= newest.modified) newest = latest;
    } catch {
      // The listing failed: the copy shown stands for the agent's newest.
    }
    const floor = undoneUpTo.current;
    undoneUpTo.current = floor && floor.modified > newest.modified ? floor : newest;
    const before = roundFile.current;
    if (before && viewUp.current && otherFile(fileRef.current, before)) void reloadRef.current(false, before);
  };

  /** The file as it is now (`refresh`), minus the copies an undo made out of
   * date (`undoneUpTo`): one of those answers as the file shown. */
  const freshFile = async (shown: OutboxFile): Promise<OutboxFile | null> => {
    const next = (await refreshRef.current?.(shown)) ?? null;
    const floor = undoneUpTo.current;
    if (next && floor && (next.name === floor.name || next.modified < floor.modified)) return shown;
    return next;
  };
  const freshFileRef = useRef(freshFile);
  freshFileRef.current = freshFile;

  /** **Make these changes**: the agent listed what the marks ask for (the
   * default instruction edits nothing until told) — one tap tells it to go
   * ahead, worded in the phone's settings (`markupInstruction.ts`). */
  const apply = async () => {
    if (sending !== null) return;
    const text = readMarkupApply() ?? DEFAULT_MARKUP_APPLY;
    setSendFailure(null);
    let sent: MarkupSend = false;
    if (onSend) sent = onSend(text);
    else if (markupTab.current) {
      // The tab a new-tab Submit opened: held, as that Submit's prompt was.
      try {
        await holdPrompt(markupTab.current.id, text);
        sent = agent !== "idle" ? "queued" : "sent";
      } catch (error) {
        setSendFailure(t("mobile.markup.sendFailed.newTab", { reason: reason(error) }));
        return;
      }
    }
    if (!sent) {
      setSendFailure(t("mobile.markup.sendFailed.chat"));
      return;
    }
    setCheck(null);
    setReloadNote(null);
    // Why the Submit got no undo is past: this round makes the changes.
    setNoUndo(null);
    setSubmitted(startRound(sent === "queued", Date.now(), true));
  };

  // --- The round: what the agent does with the last Submit -------------------
  const sentShown = hasSent(layer);
  useEffect(() => {
    if (!submitted) {
      // Opened again over sent marks: the pill shows once the agent works.
      if (sentShown && agent !== "idle") setSubmitted(followRound(agent, Date.now()));
      return;
    }
    const now = Date.now();
    const next = stepRound(submitted, agent, now);
    if (next !== submitted) { setSubmitted(next); return; }
    const wait = nextCheck(submitted, agent, now);
    if (wait === null) return;
    const timer = window.setTimeout(() => setRoundTick((tick) => tick + 1), wait);
    return () => window.clearTimeout(timer);
  }, [submitted, agent, sentShown, roundTick]);

  // Finished: one look at the file — changed under the marks, or not — so
  // Reload can say whether it is worth it. No polling.
  const finishedAt = submitted?.phase === "finished" ? submitted.since : null;
  // An `apply` round's snapshot is settled each time the round finishes —
  // a later turn (an answered question) moves it on, and the last one wins.
  // A failure is quiet: the undo's preview settles again.
  const settleId = submitted?.undo?.state === "ready" ? submitted.undo.id : null;
  useEffect(() => {
    const tab = undoTab.current;
    if (finishedAt === null || !settleId || !tab) return;
    void settleMarkupUndo(tab, settleId).catch(() => {});
  }, [finishedAt, settleId]);
  useEffect(() => {
    setCheck(null);
    setReloaded(false);
    if (finishedAt === null || !isPdf || !refreshRef.current) return;
    let live = true;
    const shown = fileRef.current;
    void freshFileRef.current(shown).then(
      (now) => { if (live && now) setCheck(otherFile(shown, now) ? "changed" : "unchanged"); },
      () => {},
    );
    return () => { live = false; };
  }, [finishedAt, isPdf]);

  /** **Reload PDF**: the file as it is now — or the newer copy the agent
   * sent — under the same layer. The sealed frame opens one document, so it
   * is remounted; the old page sizes stand in until the new ones arrive, so
   * the scroll holds. Unsent marks stay where they are; the sent ones point
   * at the old text, so they hide (⋯ shows them again). `target`: this
   * file, not a look for the newest — the copy an undo put the PDF back to. */
  const reload = async (auto = false, target?: OutboxFile) => {
    if (!isPdf || reloading || sending) return;
    setReloading(true);
    setReloadNote(null);
    let next = target ?? file;
    try {
      if (!target) next = (await freshFile(file)) ?? file;
    } catch {
      // The listing failed: the same file, fetched again, is still a reload.
    }
    const nextKey = keyOf(next.name);
    if (nextKey !== key && canMark) {
      // Before `file` changes: the save effect then writes the marks in hand
      // under the new key, and the load effect leaves them be.
      await moveLayer(key, nextKey, fingerprintOf(next));
      movedTo.current = nextKey;
    }
    if (!otherFile(file, next)) {
      setReloadNote(refreshRef.current && !("files" in scope) ? "mobile.markup.noNewer" : "mobile.markup.unchanged");
    } else if (auto) {
      setReloadNote("mobile.markup.autoReloaded");
    }
    window.clearTimeout(renderTimer.current);
    frameReady.current = false;
    opened.current = false;
    inFlight.current = null;
    bytes.current = null;
    pageCount.current = MAX_FRAME_PAGES;
    awaitingMeta.current = true;
    setPictures((known) => {
      for (const picture of Object.values(known)) picture.bitmap.close?.();
      return {};
    });
    setPageFailures(new Set());
    // The new document's text is looked through afresh.
    findAsked.current.clear();
    findKeys.current.clear();
    setFound({});
    setFailure(null);
    setChanged(false);
    setCheck(null);
    setReloaded(true);
    setReopening(true);
    setFile(next);
    setGeneration((was) => was + 1);
    setReloading(false);
  };

  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  // The agent finished and the PDF changed: its new pages load under the
  // marks now — not while a note is open or a Submit is going out (they
  // wait for it), and once per finish.
  useEffect(() => {
    if (!autoReload || check !== "changed" || reloaded || reloading || sending || note) return;
    void reloadRef.current(true);
  }, [autoReload, check, reloaded, reloading, sending, note]);
  const toggleAutoReload = () => {
    setAutoReload((was) => {
      writeFlag("markupAutoReload", !was);
      return !was;
    });
  };
  const toggleSubagents = () => {
    setSubagents((was) => {
      writeFlag("markupSubagents", !was);
      return !was;
    });
  };

  /** Previous / Next mark (a PDF's): every mark on show as the scroll top
   * that puts it on the reading line a third of the way down — the line
   * `showPin` scrolls a question's words to — clamped to the pages' extent,
   * so a mark the scroll cannot bring that far up still lands exactly. */
  const markStops = useMemo(() => {
    if (!isPdf || !sizes) return [];
    const last = Math.max(0, contentHeight - viewHeight);
    return markAnchors(layer, showSent).flatMap(({ page, y }) => {
      const spot = places[page - 1];
      const size = sizes[page - 1];
      return spot && size ? [Math.min(last, Math.max(0, spot.top + y * cssWidth / size[0] - viewHeight / 3))] : [];
    });
  }, [isPdf, sizes, layer, showSent, places, cssWidth, contentHeight, viewHeight]);
  const previousStop = [...markStops].reverse().find((top) => top < scrollTop - JUMP_SLACK);
  const nextStop = markStops.find((top) => top > scrollTop + JUMP_SLACK);
  const jumpShown = canMark && loaded && markStops.length > 0;
  /** Scrolls exactly as `showPin` does. */
  const jumpTo = (top: number | undefined) => {
    const element = scroller.current;
    if (top === undefined || !element) return;
    if (typeof element.scrollTo === "function") element.scrollTo({ top });
    else element.scrollTop = top;
  };
  const empty = isEmpty(history.present);
  const untested = (reading && isUntested("mobile.outbox.pdf")) || (isPdf && isUntested("mobile.markup.frame"))
    || (canMark && (isUntested("mobile.markup") || isUntested("mobile.markup.send") || isUntested("mobile.markup.native") || isUntested("mobile.markup.anchors")
      || (reading && (isUntested("mobile.markup.penSwitch") || isUntested("mobile.markup.opensIn")))))
    || (adoptFrom !== undefined && isUntested("mobile.markup.sharedLayer")) || (jumpShown && isUntested("mobile.markup.jump"));
  const roundUntested = isUntested("mobile.markup.rounds");
  /** Nothing to reload: the look after the agent finished found the file as
   * shown, or it was reloaded since and nothing finished again. */
  const nothingNew = check === "unchanged" || (reloaded && check === null);
  /** Reload is offered once anything went out from here, or was before —
   * never when there is known to be nothing new. */
  const canReload = isPdf && canMark && (submitted !== null || sentShown) && !nothingNew;
  const roundWords = submitted && (submitted.phase === "finished"
    ? t(check === "changed" ? "mobile.markup.round.finishedChanged" : check === "unchanged" ? "mobile.markup.round.finishedUnchanged" : "mobile.markup.round.finished")
    : t(ROUND_KEYS[submitted.phase]));
  /** Reload as the pill's own button: the agent is done, or nothing says
   * what it does — primary unless the file is known to be unchanged. */
  const pillReload = canReload && submitted && (submitted.phase === "finished" || submitted.phase === "unconfirmed");
  // Not while the agent waits on its own questions: those are answered first.
  const applyNow = canMark && canApply(submitted) && asks.length === 0;
  const undoNow = canMark && canUndo(submitted) && asks.length === 0;
  const reloadPrimary = submitted?.phase === "finished" && check !== "unchanged" && !reloaded && (!applyNow || check === "changed");
  const glyph = submitted ? ROUND_GLYPH[submitted.phase] : undefined;
  /** The questions' pins, by page: at the quote's first box once the frame
   * found it, else in the page's top margin, one slot each. A picture has
   * no text to find, so its questions stay in the card. */
  const pinsByPage = useMemo(() => {
    const byPage = new Map<number, { askId: string; index: number; rects: { x: number; y: number; w: number; h: number }[]; slot: number }[]>();
    if (!isPdf) return byPage;
    for (const ask of asks) {
      ask.questions.forEach((question, index) => {
        if (question.page === undefined) return;
        const rects = question.quote ? found[`${question.page}\n${question.quote}`] ?? [] : [];
        const list = byPage.get(question.page) ?? [];
        const slot = rects.length ? 0 : list.filter((pin) => !pin.rects.length).length;
        list.push({ askId: ask.id, index, rects, slot });
        byPage.set(question.page, list);
      });
    }
    return byPage;
  }, [isPdf, asks, found]);
  const cardShown = asksOn && asks.some((ask) => ask.questions.length > 0);
  /** A question's chip: the page scrolls to its pin, whose words light up. */
  const showPin = (askId: string, index: number) => {
    const question = asks.find((ask) => ask.id === askId)?.questions[index];
    const element = scroller.current;
    if (question?.page === undefined || !element || !sizes) return;
    const place = places[question.page - 1];
    const size = sizes[question.page - 1];
    if (!place || !size) return;
    const hit = question.quote ? found[`${question.page}\n${question.quote}`]?.[0] : undefined;
    const top = Math.max(0, place.top + (hit ? hit.y * cssWidth / size[0] : 0) - viewHeight / 3);
    if (typeof element.scrollTo === "function") element.scrollTo({ top });
    else element.scrollTop = top;
    setPinFlash(`${askId}/${index}`);
  };
  useEffect(() => {
    if (!pinFlash) return;
    const timer = window.setTimeout(() => setPinFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [pinFlash]);
  /** Taken by the desktop and queued: the pill follows the agent's turn, as
   * after a Submit, keeping the round's applied mark. */
  const questionsAnswered = (askId: string) => {
    dropAsk(askId);
    setCheck(null);
    setReloadNote(null);
    setSubmitted((was) => startRound(agent !== "idle", Date.now(), was?.applied ?? false, was?.undo));
  };
  const pinLayer = (n: number, size: Size) => {
    const pins = pinsByPage.get(n);
    if (!pins?.length) return null;
    const scale = cssWidth / size[0];
    return pins.map((pin) => {
      const key = `${pin.askId}/${pin.index}`;
      const at = pin.rects[0];
      const left = at ? Math.max(0, at.x * scale - 12) : 6 + pin.slot * 32;
      const top = at ? Math.max(0, at.y * scale - 26) : 6;
      return <Fragment key={key}>
        {pinFlash === key && pin.rects.map((rect, i) => <span key={i} className="markup-pin-hit" aria-hidden="true"
          style={{ left: rect.x * scale, top: rect.y * scale, width: rect.w * scale, height: rect.h * scale }} />)}
        <button className="markup-pin" style={{ left, top }} aria-label={t("mobile.markup.questions.pinTitle", { n: pin.index + 1 })}
          onClick={() => setQuestionFocus({ askId: pin.askId, index: pin.index, nonce: Date.now() })}>?{pin.index + 1}</button>
      </Fragment>;
    });
  };
  // --- The agent's ticks: a ✓ on each sent mark it says it handled ----------
  /** The ticked sent marks (`markup_done`, `docs/markup_tick_approve_plan.md`
   * §4), while the sent marks show. A tap on a badge approves its mark — it
   * leaves the layer, undoably — and nothing else ever removes one: ticks
   * that vanish (the agent's session ended, a day passed) take the badge
   * only. */
  const ticked = useMemo(
    () => (canMark && showSent ? tickedMarks(history.present, ticks) : []),
    [canMark, showSent, history.present, ticks],
  );
  const tickBadges = useMemo(() => {
    const byPage = new Map<number, { index: number; mark: Mark; box: [number, number, number, number] }[]>();
    for (const { page, index } of ticked) {
      const mark = history.present.sent?.pages[page]?.marks[index];
      if (!mark) continue;
      const list = byPage.get(page) ?? [];
      list.push({ index, mark, box: markBox(mark) });
      byPage.set(page, list);
    }
    return byPage;
  }, [ticked, history.present]);
  // Each badge's arrival, before paint: a pen or finger already on its way
  // down where one appears must not approve it. A badge that went and comes
  // back arrives anew.
  useLayoutEffect(() => {
    const now = Date.now();
    const next = new Map<Mark, number>();
    for (const badges of tickBadges.values()) {
      for (const { mark } of badges) {
        const seen = tickSeen.current.get(mark);
        next.set(mark, seen ?? now);
        if (seen === undefined) tickArrived.current = now;
      }
    }
    tickSeen.current = next;
  }, [tickBadges]);
  /** Whether a tap may approve now: not while a Submit goes out or a stroke
   * is under way, not in the moment after `mark` (or, for Approve all, any
   * badge) appeared, and not as the second tap of a double one. */
  const approvable = (mark: Mark | null): boolean => {
    if (sending !== null || gesture.current) return false;
    const now = Date.now();
    const arrived = mark ? tickSeen.current.get(mark) : tickArrived.current;
    if (arrived === undefined || now - arrived < ARRIVAL_GUARD_MS || now - lastApprove.current < TICK_REPEAT_MS) return false;
    lastApprove.current = now;
    return true;
  };
  /** Approves the mark the badge was drawn for — only while it is still that
   * mark and still ticked in the layer the change lands on. */
  const approveTicked = (page: number, index: number, mark: Mark) => {
    if (!approvable(mark)) return;
    setHistory((now) => {
      if (now.present.sent?.pages[page]?.marks[index] !== mark) return now;
      const still = tickedMarks(now.present, ticksRef.current).some((entry) => entry.page === page && entry.index === index);
      return still ? commit(now, approveMark(now.present, page, index)) : now;
    });
  };
  const approveAllTicked = () => {
    if (!approvable(null)) return;
    setHistory((now) => {
      const marks = tickedMarks(now.present, ticksRef.current);
      return marks.length ? commit(now, approveMarks(now.present, marks)) : now;
    });
  };
  /** One page's ✓ badges, centred on each ticked mark's top-right corner and
   * kept on the page — placed as the question pins are. */
  const tickLayer = (n: number, size: Size) => {
    const badges = tickBadges.get(n);
    if (!badges?.length) return null;
    const scale = cssWidth / size[0];
    const maxLeft = Math.max(0, cssWidth - TICK_BADGE);
    const maxTop = Math.max(0, size[1] * scale - TICK_BADGE);
    return badges.map(({ index, mark, box }) => {
      const [x, y, w] = box;
      const left = Math.min(maxLeft, Math.max(0, (x + w) * scale - TICK_BADGE / 2));
      const top = Math.min(maxTop, Math.max(0, y * scale - TICK_BADGE / 2));
      return <button key={`${tickKey(mark)}:${index}`} className="markup-pin is-tick" style={{ left, top }} disabled={sending !== null}
        aria-label={t("mobile.markup.ticks.approveTitle")} title={t("mobile.markup.ticks.approveTitle")}
        onClick={(event) => { if (event.detail <= 1) approveTicked(n, index, mark); }}>✓</button>;
    });
  };
  const register = useCallback((n: number, canvas: HTMLCanvasElement | null) => {
    if (canvas) overlays.current.set(n, canvas);
    else overlays.current.delete(n);
  }, []);
  const pickTool = (name: Tool) => {
    setTool(name);
    setPopover(null);
    if (name === "box" && color !== "yellow") setColor("yellow");
    if (name === "ink" && color === "yellow") setColor("red");
  };
  const togglePenOnly = () => {
    const next = penMode === "pen" ? "fingers" : "pen";
    setPenMode(next);
    rememberPenMode(next);
  };
  const editNote = (text: string) => setNote((draft) => draft && { ...draft, text });
  const layerCanvas = (n: number, size: Size) => canMark
    && <LayerCanvas n={n} size={size} page={layer.pages[n]} sent={showSent ? layer.sent?.pages[n] : undefined} preview={preview?.n === n ? preview.mark : null}
      pixelWidth={pixelWidth} register={register} handlers={handlers} />;
  const noteEditor = (n: number, size: Size) => note?.n === n
    && <NoteEditor note={note} size={size} width={cssWidth} onChange={editNote} onSave={saveNote} onCancel={() => setNote(null)} />;

  return <div className={`outbox-viewer markup-view${reading ? " markup-reader" : ""}${marking ? " marking" : ""}${cardShown ? " has-questions" : ""}`} role="dialog" aria-modal="true"
    aria-label={marking ? t("mobile.markup.title", { name: sentName(file) }) : sentName(file)}>
    <div className="outbox-viewer-head">
      {(reading || !marking) && <button className="sheet-close" onClick={onClose} aria-label={t("mobile.outbox.close")} disabled={sending !== null}>✕</button>}
      <div className="outbox-viewer-title">
        <h2>{sentName(file)}</h2>
        <small>
          {marking
            ? t("mobile.markup.subtitle")
            : `${sizes && isPdf ? `${t("mobile.outbox.pdfPage", { n: current, count: sizes.length })} · ` : ""}${sizeLabel(file.size)}`}
          {untested && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </small>
      </div>
      {marking ? <>
        <button className="markup-submit" disabled={!sendable.length || sending !== null || reloading || !online} onClick={() => void submit()} title={t("mobile.markup.submitTitle")}>
          {t("mobile.markup.submit")}
        </button>
        <button className="outbox-action markup-done" onClick={done} disabled={sending !== null}>{t("mobile.markup.done")}</button>
      </> : <>
        {canMark && <button className={`outbox-action markup-toggle${empty ? "" : " has-marks"}`} onClick={() => setMarking(true)}
          aria-label={t("mobile.markup.openFile", { name: sentName(file) })}>{t("mobile.markup.open")}</button>}
        {reader?.actions}
      </>}
    </div>
    <div className="markup-notes">
      {submitted && roundWords && <div className={`markup-round ${submitted.phase}`} role="status">
        {glyph && <span className={`agent-status ${glyph}`} aria-hidden="true"><span className="agent-status-glyph">{AGENT_STATUS_GLYPH[glyph]}</span></span>}
        <span className="markup-round-words">{roundWords}</span>
        {roundUntested && <span className="untested">{t("mobile.outbox.untested")}</span>}
        {applyNow && <button className={reloadPrimary ? "outbox-action markup-apply" : "markup-submit markup-apply"} disabled={reloading || sending !== null || !online}
          onClick={() => void apply()} title={t("mobile.markup.applyTitle")}>{t("mobile.markup.apply")}{isUntested("mobile.markup.apply") && <span className="untested">{t("mobile.outbox.untested")}</span>}</button>}
        {undoNow && <button className={reloadPrimary ? "outbox-action markup-apply" : "markup-submit markup-apply"} disabled={undoBusy || reloading || sending !== null || !online}
          onClick={() => void askUndo()} title={t("mobile.markup.undoRoundTitle")} aria-label={t("mobile.markup.undoRoundTitle")}>{t("mobile.markup.undoRound")}{isUntested("mobile.markup.undo") && <span className="untested">{t("mobile.outbox.untested")}</span>}</button>}
        {pillReload && <button className={reloadPrimary ? "markup-submit markup-reload" : "outbox-action markup-reload"} disabled={reloading || sending !== null}
          onClick={() => void reload()}>{t("mobile.markup.reload")}</button>}
      </div>}
      {ticked.length > 0 && <div className="markup-round markup-ticks" role="status">
        <span className="agent-status done" aria-hidden="true"><span className="agent-status-glyph">{AGENT_STATUS_GLYPH.done}</span></span>
        <span className="markup-round-words">{t("mobile.markup.ticks.done", { count: ticked.length })}</span>
        {isUntested("mobile.markup.ticks") && <span className="untested">{t("mobile.outbox.untested")}</span>}
        <button className="outbox-action markup-approve-all" disabled={sending !== null} onClick={approveAllTicked}
          title={t("mobile.markup.ticks.approveAllTitle")}>{t("mobile.markup.ticks.approveAll")}</button>
      </div>}
      {noUndo && submitted && <p role="status">{t("mobile.markup.noUndo", { reason: t(NO_UNDO_KEYS[noUndo] ?? "mobile.markup.noUndo.other") })}</p>}
      {undoNote && <p role={undoNote.alert ? "alert" : "status"}>{undoNote.text}</p>}
      {reloadNote && <p role="status">{t(reloadNote)}</p>}
      {storage === "unsaved" && <p role="status">{t("mobile.markup.unsaved")}</p>}
      {changed && <p role="status">{t("mobile.markup.changed")}</p>}
      {marking && !onSend && newTab && !openedTab && <p role="status">{t("mobile.markup.newTabNote")}{isUntested("mobile.markup.newTab") && <span className="untested">{t("mobile.outbox.untested")}</span>}</p>}
      {!onSend && newTab && openedTab && <p role="status" className="markup-opened-tab">
        {t("mobile.markup.newTabOpened", { label: openedTab.label })}
        <button className="outbox-action" onClick={() => newTab.show(openedTab)}>{t("mobile.markup.openNewTab")}</button>
        {isUntested("mobile.markup.newTab") && <span className="untested">{t("mobile.outbox.untested")}</span>}
      </p>}
      {marking && leftOut > 0 && <p role="status">{t(leftOut === 1 ? "mobile.markup.leftOutOne" : "mobile.markup.leftOut", { count: leftOut })}</p>}
      {limitHit && <p role="alert">{t("mobile.markup.limit")}</p>}
      {sending && <p role="status">{sending}</p>}
      {sendFailure && <p role="alert">{sendFailure}</p>}
      {failure && <p role="alert">{t(FAILURE_KEYS[failure])}</p>}
      {reader?.alert && <p role="alert">{reader.alert}</p>}
    </div>
    <div ref={scroller} className={`markup-scroller${fingerDrawsRef.current ? " finger-draws" : ""}`}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} onPointerDown={() => setPopover(null)}>
      {isPdf ? <>
        {!sizes && !failure && <p className="markup-loading">{t("mobile.markup.loading")}</p>}
        {sizes && <div className="markup-pages" style={{ width: cssWidth, height: contentHeight, marginLeft: insetAt(zoom) }}>
          {sizes.map((size, i) => {
            const n = i + 1;
            const spot = places[i];
            const shown = alive.includes(n);
            return <div key={n} className="markup-page" style={{ top: spot.top, width: cssWidth, height: spot.height }} aria-label={t("mobile.markup.page", { n })}>
              {shown && <>
                <PagePicture picture={pictures[n]} />
                {!pictures[n] && <span className="markup-page-note">{t(pageFailures.has(n) ? "mobile.markup.pageFailed" : "mobile.markup.pageLoading", { n })}</span>}
                {layerCanvas(n, size)}
              </>}
              {tickLayer(n, size)}
              {pinLayer(n, size)}
              {noteEditor(n, size)}
            </div>;
          })}
        </div>}
        {!failure && <iframe key={generation} ref={frame} className="markup-frame" title="pdf" sandbox="allow-scripts" src="/pdf-frame.html" />}
      </> : <div className="markup-pages markup-picture" style={{ width: cssWidth, marginLeft: insetAt(zoom) }}>
        <div className="markup-page" style={sizes ? { width: cssWidth, height: cssWidth * sizes[0][1] / sizes[0][0] } : { width: cssWidth }}>
          <img ref={pictureImage} src={url} alt={sentName(file)} draggable={false}
            onLoad={(event) => {
              const { naturalWidth, naturalHeight } = event.currentTarget;
              if (naturalWidth > 0 && naturalHeight > 0) setSizes([[naturalWidth, naturalHeight]]);
              else setFailure("picture");
            }}
            onError={() => setFailure("picture")} />
          {sizes && layerCanvas(1, sizes[0])}
          {sizes && tickLayer(1, sizes[0])}
          {sizes && noteEditor(1, sizes[0])}
        </div>
      </div>}
    </div>
    {(marking || cardShown || jumpShown) && <div className="markup-palette">
      {/* Previous / Next mark: a pair at the right edge, above the card and
          the tools — the toolbar's own look, stood on end. */}
      {jumpShown && <div className="markup-toolbar markup-jump" role="group" aria-label={t("mobile.markup.jump")}>
        <button onClick={() => jumpTo(previousStop)} disabled={previousStop === undefined}
          aria-label={t("mobile.markup.prevMark")} title={t("mobile.markup.prevMark")}><span aria-hidden="true">↑</span></button>
        <button onClick={() => jumpTo(nextStop)} disabled={nextStop === undefined}
          aria-label={t("mobile.markup.nextMark")} title={t("mobile.markup.nextMark")}><span aria-hidden="true">↓</span></button>
      </div>}
      {cardShown && <MarkupQuestionsCard tabId={askTab} asks={asks} online={online} focus={questionFocus}
        onShowPin={isPdf ? showPin : undefined} onAnswered={questionsAnswered} onClosed={dropAsk} onRefresh={refreshAsks} onBusy={setQuestionBusy} />}
      {marking && <>
      {popover === "colors" && <div className="markup-popover markup-colors" role="group" aria-label={t("mobile.markup.color")}>
        {MARK_COLORS.map((name) => <button key={name} className={`markup-color${color === name ? " selected" : ""}`} aria-pressed={color === name}
          style={{ background: INK[name] }} onClick={() => { setColor(name); setPopover(null); }} aria-label={t(`mobile.markup.color.${name}` as TranslationKey)} />)}
      </div>}
      {popover === "more" && <div className="markup-popover markup-more">
        <button onClick={() => { setHistory((now) => commit(now, clearPage(now.present, current, showSent))); setPopover(null); }}
          disabled={!history.present.pages[current] && !(showSent && history.present.sent?.pages[current])}>
          <span aria-hidden="true">⌧</span>{t("mobile.markup.clearPage", { n: current })}
        </button>
        {/* Every page at once — one step, so Undo brings it all back. */}
        <button onClick={() => { setHistory((now) => commit(now, clearAll(now.present, showSent))); setPopover(null); }}
          disabled={isEmpty(history.present) && !(showSent && hasSent(history.present))}>
          <span aria-hidden="true">⌧</span>{t("mobile.markup.clearAll")}
          {isUntested("mobile.markup.clearAll") && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </button>
        {penMode !== "none" && <button role="switch" aria-checked={penMode === "pen"} onClick={togglePenOnly}>
          <span aria-hidden="true">✎</span>{t("mobile.markup.penOnly")}<span className="markup-switch" aria-hidden="true" />
        </button>}
        {canReload && <button onClick={() => { setPopover(null); void reload(); }} disabled={reloading || sending !== null}>
          <span aria-hidden="true">⟳</span>{t("mobile.markup.reload")}{roundUntested && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </button>}
        {isPdf && <button role="switch" aria-checked={autoReload} onClick={toggleAutoReload}>
          <span aria-hidden="true">⟳</span>{t("mobile.markup.autoReload")}<span className="markup-switch" aria-hidden="true" />
          {isUntested("mobile.markup.autoReload") && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </button>}
        <button role="switch" aria-checked={subagents} onClick={toggleSubagents}>
          <span aria-hidden="true">⑂</span>{t("mobile.markup.subagents")}<span className="markup-switch" aria-hidden="true" />
          {isUntested("mobile.markup.subagents") && <span className="untested">{t("mobile.outbox.untested")}</span>}
        </button>
        {sentShown && <button role="switch" aria-checked={showSent} onClick={() => setShowSent((shown) => !shown)}>
          <span aria-hidden="true">◌</span>{t("mobile.markup.showSent")}<span className="markup-switch" aria-hidden="true" />
        </button>}
        {sentShown && <button onClick={() => { setHistory((now) => commit(now, clearSent(now.present))); setPopover(null); }}>
          <span aria-hidden="true">⌧</span>{t("mobile.markup.clearSent")}
        </button>}
      </div>}
      {!popover && tool === "text" && !note && <p className="markup-hint">{t("mobile.markup.textHint")}</p>}
      {!popover && tool === "eraser" && <p className="markup-hint">{t("mobile.markup.eraserHint")}{isUntested("mobile.markup.eraser") && <span className="untested">{t("mobile.outbox.untested")}</span>}</p>}
      <div className="markup-toolbar" role="toolbar" aria-label={t("mobile.markup.tools")}>
        {(["ink", "box", "text", "eraser"] as Tool[]).map((name) => <button key={name} aria-pressed={tool === name} className={tool === name ? "selected" : ""}
          onClick={() => pickTool(name)} aria-label={t(`mobile.markup.tool.${name}` as TranslationKey)} title={t(`mobile.markup.tool.${name}` as TranslationKey)}>
          {name === "eraser" ? <EraserIcon /> : <span aria-hidden="true">{name === "ink" ? "✎" : name === "box" ? "▭" : "T"}</span>}
        </button>)}
        <button className="markup-color-well" aria-expanded={popover === "colors"} onClick={() => setPopover((open) => (open === "colors" ? null : "colors"))}
          aria-label={t("mobile.markup.colorOf", { color: t(`mobile.markup.color.${color}` as TranslationKey) })}>
          <span style={{ background: INK[color] }} />
        </button>
        <span className="markup-toolbar-rule" aria-hidden="true" />
        <button onClick={() => setHistory(undo)} disabled={!history.past.length} aria-label={t("mobile.markup.undo")} title={t("mobile.markup.undo")}><span aria-hidden="true">↶</span></button>
        <button onClick={() => setHistory(redo)} disabled={!history.future.length} aria-label={t("mobile.markup.redo")} title={t("mobile.markup.redo")}><span aria-hidden="true">↷</span></button>
        <button aria-expanded={popover === "more"} onClick={() => setPopover((open) => (open === "more" ? null : "more"))}
          aria-label={t("mobile.markup.more")} title={t("mobile.markup.more")}><span aria-hidden="true">⋯</span></button>
      </div>
      </>}
    </div>}
    {undoSheet && <OptionSheet
      title={t("mobile.markup.undo.confirmTitle")}
      note={{ text: undoSummary(undoSheet.changes, t) }}
      options={[{ key: "undo", label: t("mobile.markup.undo.confirm"), current: false }]}
      waiting=""
      busy={undoBusy}
      onPick={() => void runUndo()}
      onClose={() => setUndoSheet(null)}
    />}
  </div>;
}

function boxOf(a: [number, number], b: [number, number], color: MarkColor): BoxMark {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { kind: "box", color, rect: [round(x), round(y), round(Math.abs(a[0] - b[0])), round(Math.abs(a[1] - b[1]))] };
}

/** The typed note, edited where it sits on the page. */
function NoteEditor({ note, size, width, onChange, onSave, onCancel }: {
  note: NoteDraft; size: Size; width: number; onChange: (text: string) => void; onSave: (text: string | null) => void; onCancel: () => void;
}) {
  const t = useT();
  const text = note.text;
  const scale = width / size[0];
  return <div className="markup-note-editor" style={{ left: Math.min(note.at[0] * scale, Math.max(0, width - 220)), top: note.at[1] * scale }}>
    <textarea autoFocus value={text} maxLength={2000} placeholder={t("mobile.markup.notePlaceholder")} onChange={(event) => onChange(event.target.value)}
      style={{ color: INK[note.color] }} aria-label={t("mobile.markup.notePlaceholder")} />
    <div>
      {note.index !== null && <button onClick={() => onSave(null)}>{t("mobile.markup.noteDelete")}</button>}
      <button onClick={onCancel}>{t("mobile.markup.noteCancel")}</button>
      <button onClick={() => onSave(text)} disabled={!text.trim()}>{t("mobile.markup.noteDone")}</button>
    </div>
  </div>;
}
