/**
 * The deck editor's shell: load the sidecar and its base PDF, re-anchor, host the
 * rail and the stage, and autosave.
 *
 * **Why this owns its own I/O instead of using `useEditableFile`.** That hook is
 * string-typed end to end and writes on *every* change while dirty — correct for
 * a text editor, wrong for a document mutated by dragging, where it would issue a
 * disk write per pointer frame. It also cannot create a file, and `write_file_text`
 * refuses a path that does not exist. So the deck debounces its own writes and
 * goes through `writeFileBytes`, which may create.
 *
 * **Why there is no save button.** Tabtivity has no unsaved-work prompt anywhere —
 * `closeTabWithConfirm` is literally `removeTab` — so a deck must never *hold*
 * unsaved state. It is small, it is text, and it is under git, which is where the
 * durable undo belongs. Ctrl+Z is the in-session undo; git is the real one.
 *
 * That last paragraph is a promise the code has to keep, and for a while it did
 * not: the debounce's cleanup cancelled the pending write, so closing the tab
 * inside 800 ms of an edit discarded it silently while the toolbar said "Saved"
 * (TODO V #93). The rule now is `dirtyRef` + `deckRef` + a **flush** on unmount
 * and on window close, and the label reads from `dirtyRef` rather than from the
 * in-flight write.
 *
 * **When the deck must NOT be written.** Three cases, all of them ones where an
 * autosave would destroy something (TODO V #94, #100):
 *
 *  - the file declared a newer deck version, or carried an object kind this build
 *    cannot model — writing it back would silently downgrade the file;
 *  - the load produced a parse error — the deck on screen is a blank fallback;
 *  - re-anchoring had to place several content-bearing slides by *order alone*,
 *    which on a manually reordered deck can put layers on the wrong pages.
 *
 * In all three the deck opens read-only-ish behind a banner, and only the
 * author's explicit "open anyway" arms the autosave. Merely *looking* at a deck
 * also no longer rewrites it: `loadedRef` is armed by the first real edit, not by
 * the load.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeTrusted } from "../../../lib/execTrust";
import { open } from "@tauri-apps/plugin-dialog";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { UntestedTag } from "../../common/UntestedTag";
import {
  describeFileErrorKey,
  fileMtime,
  readFileBytes,
  readFileText,
  useFileScope,
  usePaneVisible,
  writeFileBytes,
} from "../fileAccess";
import { openLinkedFile, useViewerState } from "../FileViewerPane";
import { useProjectsStore } from "../../../stores/projects";
import {
  type Deck,
  type DeckObject,
  type ImageObject,
  type ObjectList,
  type Slide,
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  DUPLICATE_OFFSET,
  alignObjects,
  footerObject,
  duplicateObjects,
  insertSlide,
  lowerObjects,
  moveObjects,
  moveSlides,
  sequence,
  newInterstitialId,
  newObjectId,
  newSlideId,
  raiseObjects,
  removeObjects,
  removeSlides,
  blankSlide,
  distributeObjects,
  slidePageBox,
  toBack,
  toFront,
  updateObjects,
  updateSlide,
} from "../../../lib/viewers/deck/model";
import {
  type BasePage,
  parseDeck,
  pdfPathForDeck,
  serializeDeck,
  reattach,
  reconcile,
} from "../../../lib/viewers/deck/sidecar";
import { type TextMetrics, loadMetrics, unencodableIn } from "../../../lib/viewers/deck/fonts";
import type { IconDef } from "../../../lib/viewers/deck/icons";
import { exportDeck, exportPathFor } from "../../../lib/viewers/deck/export";
import {
  starterTex,
  starterTexFigure,
  texPathForDeck,
  titleFromPath,
} from "../../../lib/viewers/deck/template";
import { getTexCapability, type TexCompileResult } from "../../../lib/viewers/tex/tex";
import { loadBase, renderPage, renderPdfPageToPng } from "./deckBase";
import {
  dirOf,
  gifKey,
  interstitialsOf,
  resolveRel,
  useDeckGifs,
  useDeckImages,
} from "./deckAssets";
import { useDeckFonts } from "./deckFonts";
import { DeckStage } from "./DeckStage";
import { DeckInspector } from "./DeckInspector";
import { DeckAnimate } from "./DeckAnimate";
import { DeckNotes } from "./DeckNotes";
import { DeckTexPanel } from "./DeckTexPanel";
import { DeckPresenter } from "./DeckPresenter";
import { DeckThemePanel } from "./DeckThemePanel";
import { IconPicker } from "./IconPicker";
import { slideStopIndex } from "../../../lib/viewers/deck/present";
import { posterPng } from "./gifPlayback";
import { useT } from "../../../lib/i18n";
import { useUnsavedWork } from "../../../lib/window/unsavedWork";
import { ArrowUpRightIcon, PlayIcon } from "../../common/icons/Icon";

/** Bounds for the rail's user-resizable width (px). Wide enough at the max that
 *  a thumbnail is actually legible, narrow enough at the min to stay a rail. */
export const DECK_RAIL_MIN_WIDTH = 84;
export const DECK_RAIL_MAX_WIDTH = 260;
export const DECK_RAIL_DEFAULT_WIDTH = 112;

export function clampRailWidth(w: number): number {
  return Math.min(DECK_RAIL_MAX_WIDTH, Math.max(DECK_RAIL_MIN_WIDTH, Math.round(w)));
}

/** How often a TeX-figure's compiled PDF is checked for a newer mtime — i.e. a
 *  recompile the author ran from the source tab this view opened. Matches the
 *  PDF viewer's own external-change poll (`PdfViewer.RELOAD_POLL_MS`); there is
 *  no reason for a deck's figures to notice a recompile any slower. */
const TEX_FIGURE_POLL_MS = 1500;

/** The per-deck folder a TeX-figure object's source/PDF/PNG live in, beside the
 *  sidecar — kept out of the main `.tex`'s own directory so a figure's build
 *  artifacts (`.aux`/`.log`) never clutter the deck's own folder listing. */
function texFigureDir(deckPath: string): string {
  return `${deckPath.replace(/\.eldeck\.json$/i, "")}.tex-figures`;
}

/**
 * An asset path relative to the deck's own directory — **including** `..` for a
 * file that sits beside or above it.
 *
 * The model promises a relative `src` so a deck survives being moved or synced
 * (`model.ImageObject`), but the old spelling relativized only files *under* the
 * deck's folder. A figure in `<project>/figures/` picked into a deck living in
 * `<project>/talks/` was stored **absolute** — which breaks the moment the
 * project is synced to a host, moved, or opened on another machine (TODO V #108).
 *
 * Falls back to the absolute path only when the two share no root at all (a
 * different Windows drive), where there genuinely is no relative form.
 */
export function deckRelative(dir: string, absolute: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const from = norm(dir).split("/").filter((s) => s !== "" && s !== ".");
  const to = norm(absolute).split("/").filter((s) => s !== "" && s !== ".");
  // A shared root is what makes a relative path meaningful at all.
  if (norm(dir) === "" || from[0] !== to[0]) return absolute;
  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i += 1;
  const up = from.length - i;
  const rel = [...Array<string>(up).fill(".."), ...to.slice(i)].join("/");
  return rel || ".";
}

/**
 * Is `absolute` somewhere the deck will still be able to *read* it?
 *
 * `read_file_bytes` confines to the scope project's roots, so an image picked
 * from outside the project is stored, rendered once from the picker's own bytes —
 * and then permanently unreadable: a placeholder on the slide and a "not
 * available" warning in every export, with nothing saying why (TODO V #108).
 * Cheaper to refuse the pick with an explanation.
 */
export function withinProject(projectRoot: string | null, absolute: string): boolean {
  if (!projectRoot) return true; // Root scope: the backend decides, not us.
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const root = norm(projectRoot);
  const p = norm(absolute);
  return p === root || p.startsWith(`${root}/`);
}

/** One slide's thumbnail in the rail — its own small component so each row
 *  renders its canvas independently as `doc`/page/size change, the same
 *  "render into a ref'd canvas via an effect" shape `DeckStage` uses for the
 *  full-size page. */
function DeckRailThumb({
  doc,
  page,
  width,
  height,
}: {
  doc: PDFDocumentProxy | null;
  page: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !doc || width <= 0 || height <= 0) return;
    return renderPage(doc, page, canvas, width, height);
  }, [doc, page, width, height]);
  return <canvas className="deck-rail-thumb" ref={ref} />;
}

/** How long after the last edit the sidecar is written. Long enough that a
 *  gesture-heavy minute is a handful of writes, short enough that closing the tab
 *  right after an edit still catches it. */
const AUTOSAVE_MS = 800;

/** Arrow-key nudge, as a fraction of the page. Shift multiplies it. */
const NUDGE = 0.002;

export interface DeckViewProps {
  path: string;
  onOpenExternally: () => void;
  tabKey?: string;
  groupId?: string | null;
}

export function DeckView({ path, onOpenExternally, tabKey, groupId }: DeckViewProps) {
  const t = useT();
  const scope = useFileScope();
  const paneVisible = usePaneVisible();
  /** The scope project's own directory — the boundary `read_file_bytes` confines
   *  to, and therefore the boundary an asset pick has to respect (#108). */
  const projectRoot = useProjectsStore(
    (s) => s.projects.find((p) => p.id === scope)?.directory ?? null,
  );

  const [deck, setDeck] = useState<Deck | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [slideIndex, setSlideIndex] = useState(0);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);
  const [picking, setPicking] = useState<null | "new" | "replace">(null);
  const [mode, setMode] = useState<"design" | "animate" | "notes" | "tex" | "deck">("design");
  const [previewStep, setPreviewStep] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);
  /** Set when writing this deck back would lose something — see the module note.
   *  Non-null suspends the autosave until the author dismisses it. */
  const [hold, setHold] = useState<string | null>(null);
  /** True once the deck differs from what is on disk. Drives the toolbar label,
   *  which used to read "Saved" for the whole debounce window. */
  const [dirty, setDirty] = useState(false);
  /** Stop to open the presenter on — set by the Present button (#114). */
  const [presentFrom, setPresentFrom] = useState(0);
  /** Bumped to force a reload after the base plate is (re)generated. */
  const [reloadNonce, setReloadNonce] = useState(0);
  const [texAvailable, setTexAvailable] = useState(false);
  /** Ids of TeX-figure objects currently (re)compiling — the FAB, an explicit
   *  Recompile, and the external-change poll can all be in flight at once, each
   *  for a different object, so this is a set rather than a single flag. */
  const [texBusyIds, setTexBusyIds] = useState<ReadonlySet<string>>(new Set());

  const railState = useViewerState(tabKey);
  const [railWidth, setRailWidth] = useState(() =>
    clampRailWidth(railState.initial?.deckRailWidth ?? DECK_RAIL_DEFAULT_WIDTH),
  );
  /** Live width during a drag; committed (and persisted) only on release — see
   *  `SubwindowFilesSidebar`, whose resize handle this mirrors. */
  const [liveRailWidth, setLiveRailWidth] = useState<number | null>(null);

  const past = useRef<Deck[]>([]);
  const future = useRef<Deck[]>([]);
  /**
   * Armed by the first genuine edit, never by the load.
   *
   * It used to be set immediately after the load's `setDeck`, which meant the
   * reconciled deck — with `anchor.print` refreshed on every slide — was written
   * unconditionally 800 ms later. On a git-tracked, lockstep-synced sidecar,
   * *looking* at a deck produced a diff (TODO V #94).
   */
  const loadedRef = useRef(false);
  /** The latest deck, for the flush paths that run outside React's render. */
  const deckRef = useRef<Deck | null>(null);
  /** Unwritten changes. Cleared only by a **successful** write, so a failed one
   *  leaves the flush still owing rather than silently forgetting. */
  const dirtyRef = useRef(false);
  /** Mirrors `hold` for the flush paths, which cannot read state. */
  const holdRef = useRef<string | null>(null);
  holdRef.current = hold;
  /** Last mtime this view saw on the sidecar itself, so a foreign write (a
   *  second deck tab, or the JSON edited in a text tab beside it) is noticed
   *  rather than silently clobbered (TODO V #116). */
  const deckMtimeRef = useRef<number | null>(null);
  /** True while `presenting`, for the background loops that must stand down. */
  const presentingRef = useRef(false);
  presentingRef.current = presenting;
  /** Last-seen mtime of each TeX-figure's compiled PDF (by absolute path), so
   *  the poll below can tell "a recompile just happened" from "nothing changed"
   *  without re-rasterizing on every tick. Seeded by every write this view makes
   *  itself, so its own compiles never look like an external change. */
  const mtimesRef = useRef<Map<string, number>>(new Map());

  // The standard-14 metrics the stage lays text out with. Loaded once per app
  // run (the module memoizes), and rendering degrades to CSS wrapping until it
  // resolves rather than showing nothing.
  useEffect(() => {
    let live = true;
    void loadMetrics().then((m) => {
      if (live) setMetrics(m);
    });
    return () => {
      live = false;
    };
  }, []);

  // --- load --------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    loadedRef.current = false;
    dirtyRef.current = false;
    setDirty(false);
    setHold(null);
    setError(null);
    setNotice(null);

    void (async () => {
      let parsed: ReturnType<typeof parseDeck>;
      try {
        const text = await readFileText(path, scope);
        parsed = parseDeck(text);
      } catch (e) {
        if (!cancelled) setError(t(describeFileErrorKey(e)));
        return;
      }
      if (cancelled) return;
      if (parsed.error) {
        setError(t("deckView.readError", { msg: parsed.error }));
        return;
      }
      deckMtimeRef.current = await fileMtime(path, scope).catch(() => null);

      const dir = dirOf(path);
      const basePath = resolveRel(dir, parsed.deck.base ?? pdfPathForDeck(path));

      let pages: BasePage[] = [];
      try {
        const base = await loadBase(basePath, scope);
        opened = base.doc;
        pages = base.pages;
      } catch (e) {
        // A missing base plate is not a broken deck — the layers are still
        // intact and worth showing. Say so rather than failing the whole view.
        if (!cancelled) setNotice(t("deckView.basePdfError", { msg: t(describeFileErrorKey(e)) }));
      }
      if (cancelled) {
        opened?.loadingTask.destroy();
        return;
      }

      const r = reconcile(parsed.deck, pages);
      setDoc(opened);
      setDeck(r.deck);
      deckRef.current = r.deck;
      setSlideIndex((i) => Math.min(i, Math.max(0, r.deck.slides.length - 1)));

      // Two independent reasons to refuse to write this deck back. Both are
      // stated in the author's terms, because the only thing they can do about
      // either is decide whether the layers or the file matters more.
      const blockers: string[] = [];
      if (parsed.lossy) {
        blockers.push(
          t("deckView.lossyBlocker", {
            reason: parsed.lossReason ?? t("deckView.unknownLossReason"),
          }),
        );
      }
      if (r.ambiguous) {
        blockers.push(t("deckView.ambiguousBlocker"));
      }
      if (blockers.length) setHold(blockers.join(" "));

      const notes: string[] = [];
      if (parsed.repaired) notes.push(t("deckView.repairedNote", { detail: parsed.repaired }));
      if (r.detached > 0) {
        notes.push(
          t(r.detached === 1 ? "deckView.detachedOne" : "deckView.detachedMany", { n: r.detached }),
        );
      }
      if (r.moved > 0) {
        notes.push(t(r.moved === 1 ? "deckView.reanchoredOne" : "deckView.reanchoredMany", { n: r.moved }));
      }
      if (notes.length) setNotice(notes.join(" "));

      // Deliberately NOT arming the autosave here: re-anchoring alone is not a
      // reason to rewrite a tracked file (see `loadedRef`). The refreshed anchors
      // ride along with whatever the author changes next.
    })();

    return () => {
      cancelled = true;
      opened?.loadingTask.destroy();
      setDoc(null);
    };
  }, [path, scope, reloadNonce]);

  useEffect(() => {
    void getTexCapability().then((c) => setTexAvailable(c.available));
  }, []);

  // --- autosave ----------------------------------------------------------

  /**
   * Write the deck now, if it is dirty and allowed to be written.
   *
   * The one place bytes leave this view, so the hold, the dirty flag and the
   * mtime bookkeeping cannot get out of step. `await`able, so the unmount flush
   * can be sure the write was *issued* before the component goes.
   */
  const flush = useCallback(async () => {
    const d = deckRef.current;
    if (!d || !dirtyRef.current || holdRef.current) return;
    setSaving(true);
    try {
      await writeFileBytes(path, new TextEncoder().encode(serializeDeck(d)), scope);
      dirtyRef.current = false;
      setDirty(false);
      // Record our own write so the external-change poll below does not mistake
      // it for someone else's.
      deckMtimeRef.current = await fileMtime(path, scope).catch(() => deckMtimeRef.current);
    } catch (e) {
      // Still dirty — a failed write must not look like a saved one.
      setError(t(describeFileErrorKey(e)));
    } finally {
      setSaving(false);
    }
  }, [path, scope, t]);

  const flushRef = useRef(flush);
  flushRef.current = flush;
  // A popout closing on a Wayland scope-out writes a pending debounced edit
  // first (the deck always autosaves); a held deck stays dirty and keeps it open.
  useUnsavedWork(dirty, () => flushRef.current(), () => dirtyRef.current);

  useEffect(() => {
    if (!deck || !loadedRef.current || hold) return;
    // Background work stands down during a talk: an autosave mid-presentation is
    // disk I/O (an SFTP round trip on a remote project) for an edit nobody is
    // making, on the one machine that must not stutter (TODO V #113).
    if (presenting) return;
    const autosaveTimer = setTimeout(() => void flushRef.current(), AUTOSAVE_MS);
    return () => clearTimeout(autosaveTimer);
  }, [deck, hold, presenting]);

  /**
   * The unmount / window-close flush.
   *
   * The debounce's own cleanup cancels the pending write — which is correct for a
   * *rescheduled* write and catastrophic for a *final* one. Closing the tab
   * within 800 ms of an edit silently discarded it, while the toolbar said
   * "Saved" (TODO V #93). There is no unsaved-work prompt anywhere in Tabtivity to
   * catch it either, by design, so the flush has to be unconditional.
   */
  useEffect(() => {
    const onBeforeUnload = () => {
      void flushRef.current();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      void flushRef.current();
    };
  }, []);

  // Notice a foreign write to the sidecar itself — two deck tabs on one file
  // (main window + popout), or the JSON edited in a text tab beside it. Until now
  // that was last-writer-wins with no warning (TODO V #116). Visible panes only
  // (hidden ones stay mounted forever); re-show re-arms the interval, whose
  // first tick then reconciles anything written while hidden.
  useEffect(() => {
    if (!deck || !paneVisible) return;
    const id = setInterval(() => {
      if (presentingRef.current) return;
      void (async () => {
        const mt = await fileMtime(path, scope).catch(() => null);
        if (mt == null || deckMtimeRef.current == null || mt === deckMtimeRef.current) return;
        deckMtimeRef.current = mt;
        if (dirtyRef.current) {
          setHold(t("deckView.externalChangeHeld"));
        } else {
          setReloadNonce((n) => n + 1);
          setNotice(t("deckView.externalChangeReloaded"));
        }
      })();
    }, TEX_FIGURE_POLL_MS);
    return () => clearInterval(id);
  }, [deck, path, scope, paneVisible]);

  // --- editing -----------------------------------------------------------
  //
  // **History is pushed OUTSIDE the state updater.** `commit` used to mutate
  // `past.current` inside a `setDeck` callback, and `undo`/`redo` `pop()`ed
  // inside theirs — but React 18 StrictMode is on (`main.tsx`) and double-invokes
  // updaters in development, which is precisely the build where the
  // `deck_presenter` flag defaults on. So anyone who could try the feature saw
  // doubled or broken undo (TODO V #104). Every mutation now computes its next
  // deck from `deckRef` and calls `setDeck` non-functionally, which makes the
  // updater pure and running it twice harmless.

  /** How long two same-key edits stay one undo step. Long enough to swallow a
   *  burst of typing, short enough that a pause is a boundary you can feel. */
  const COALESCE_MS = 600;

  /** Cap on the undo stack. Generous now that a sentence is one entry rather
   *  than forty — the old 99 was a handful of real actions once notes typing
   *  had evicted everything structural. */
  const HISTORY_MAX = 400;

  /** `(key, at)` of the top of `past`, for coalescing. */
  const lastPush = useRef<{ key: string; at: number } | null>(null);

  /**
   * Apply a change, pushing one history entry.
   *
   * `key` opts the edit into **coalescing**: a run of same-key edits within
   * `COALESCE_MS` replaces the top of the stack instead of stacking. That is what
   * makes typing a title one undo rather than forty — and, more importantly, what
   * stops typing 100 characters of speaker notes from evicting every structural
   * edit that came before it.
   */
  const apply = useCallback((next: (d: Deck) => Deck, key?: string) => {
    const cur = deckRef.current;
    if (!cur) return;
    const out = next(cur);
    if (out === cur) return;
    const now = Date.now();
    const coalesce =
      key != null &&
      lastPush.current?.key === key &&
      now - lastPush.current.at < COALESCE_MS &&
      past.current.length > 0;
    if (!coalesce) past.current = [...past.current.slice(-(HISTORY_MAX - 1)), cur];
    lastPush.current = key != null ? { key, at: now } : null;
    future.current = [];
    deckRef.current = out;
    dirtyRef.current = true;
    loadedRef.current = true;
    setDirty(true);
    setDeck(out);
  }, []);

  /** Every mutation goes through here, so history is impossible to forget. */
  const commit = useCallback((next: (d: Deck) => Deck) => apply(next), [apply]);

  const setObjects = useCallback(
    (objects: ObjectList, key?: string) => {
      apply(
        (d) => ({
          ...d,
          slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects })),
        }),
        key,
      );
    },
    [apply, slideIndex],
  );

  /** Apply a pure object-list op to the current slide. */
  const withObjects = useCallback(
    (op: (list: ObjectList, ids: string[]) => ObjectList) => {
      apply((cur) => {
        const slide = cur.slides[slideIndex];
        if (!slide) return cur;
        const objects = op(slide.objects, [...selection]);
        if (objects === slide.objects) return cur;
        return {
          ...cur,
          slides: updateSlide(cur.slides, slideIndex, (s) => ({ ...s, objects })),
        };
      });
    },
    [apply, slideIndex, selection],
  );

  const undo = useCallback(() => {
    const prev = past.current.pop();
    const cur = deckRef.current;
    if (!cur || !prev) return;
    future.current = [...future.current, cur];
    lastPush.current = null;
    deckRef.current = prev;
    dirtyRef.current = true;
    setDirty(true);
    setDeck(prev);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    const cur = deckRef.current;
    if (!cur || !next) return;
    past.current = [...past.current, cur];
    lastPush.current = null;
    deckRef.current = next;
    dirtyRef.current = true;
    setDirty(true);
    setDeck(next);
  }, []);

  // --- copy / duplicate ----------------------------------------------------
  // An in-memory object clipboard, not the OS one: a deck object is a structured
  // value, and serializing it through the system clipboard (text or an image of
  // its render) would lose exactly what makes it editable. Paste lands on the
  // *current* slide, so it doubles as "copy this to another slide".
  const clipboard = useRef<DeckObject[]>([]);

  const copySelection = useCallback(() => {
    if (!deck || selection.size === 0) return;
    const slide = deck.slides[slideIndex];
    if (!slide) return;
    clipboard.current = slide.objects.filter((o) => selection.has(o.id)).map((o) => ({ ...o }));
  }, [deck, selection, slideIndex]);

  /** Add clones of `objs` to the current slide, offset and freshly-ided, and
   *  select them — the shared tail of paste and cross-slide copy. */
  const addClones = useCallback(
    (objs: readonly DeckObject[]) => {
      if (objs.length === 0) return;
      const fresh: string[] = [];
      const clones = objs.map((o) => {
        const id = newObjectId();
        fresh.push(id);
        return { ...o, id, x: o.x + DUPLICATE_OFFSET, y: o.y + DUPLICATE_OFFSET };
      });
      commit((d) => ({
        ...d,
        slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects: [...s.objects, ...clones] })),
      }));
      setSelection(new Set(fresh));
    },
    [commit, slideIndex],
  );

  const pasteClipboard = useCallback(() => addClones(clipboard.current), [addClones]);

  const duplicateSelection = useCallback(() => {
    if (!deck || selection.size === 0) return;
    const slide = deck.slides[slideIndex];
    if (!slide) return;
    const { list, ids } = duplicateObjects(slide.objects, [...selection]);
    if (list === slide.objects) return;
    commit((d) => ({
      ...d,
      slides: updateSlide(d.slides, slideIndex, (s) => ({ ...s, objects: list })),
    }));
    setSelection(new Set(ids));
  }, [deck, selection, slideIndex, commit]);

  // --- slide reorder -------------------------------------------------------
  // The presentation sequence is the deck's own slide order (reconcile preserves
  // it across a reload), so moving a slide earlier/later is a durable edit — it
  // does not touch which base page each slide backs.
  const moveSlide = useCallback(
    (from: number, dir: -1 | 1) => {
      const to = from + dir;
      commit((d) => {
        if (to < 0 || to >= d.slides.length) return d;
        return { ...d, slides: moveSlides(d.slides, [d.slides[from].id], to) };
      });
      // An adjacent move is a swap of `from` and `to`; keep the viewer on whatever
      // slide it was showing.
      setSlideIndex((i) => (i === from ? to : i === to ? from : i));
    },
    [commit],
  );

  // Copy a slide: a fresh-ided clone (its own objects, its own interstitial) that
  // backs the SAME base page as the original — durable now that reconcile lets two
  // slides share a page. Lands right after the original.
  const duplicateSlide = useCallback(
    (index: number) => {
      commit((d) => {
        const src = d.slides[index];
        if (!src) return d;
        const copy: Slide = {
          ...src,
          id: newSlideId(),
          objects: src.objects.map((o) => ({ ...o, id: newObjectId() })),
          ...(src.after ? { after: { ...src.after, id: newInterstitialId() } } : {}),
        };
        return { ...d, slides: insertSlide(d.slides, copy, index + 1) };
      });
      setSlideIndex(index + 1);
      setSelection(new Set());
    },
    [commit],
  );

  /**
   * Remove a slide from the deck.
   *
   * Two things make this more than a `filter`, and both are the module's own
   * non-destructive contract (`model.DetachedLayer`):
   *
   *  - its layers go to `deck.detached` rather than into the bin, so a mis-click
   *    is one click back rather than a lost afternoon; and
   *  - its base page is recorded in `deck.skippedPrints`, or `reconcile`'s
   *    "cover every base page" pass re-adds a blank slide for it on the very next
   *    load — which is why deleting a slide was impossible before (TODO V #106).
   */
  const deleteSlide = useCallback(
    (index: number) => {
      const cur = deckRef.current;
      const victim = cur?.slides[index];
      if (!cur || !victim) return;
      const hasContent =
        victim.objects.length > 0 || victim.notes.trim() !== "" || victim.after != null;
      if (
        hasContent &&
        !window.confirm(
          t("deckView.removeSlideConfirm", { n: index + 1, count: victim.objects.length }),
        )
      ) {
        return;
      }
      commit((d) => ({
        ...d,
        slides: removeSlides(d.slides, [victim.id]),
        detached: hasContent
          ? [...d.detached, { from: victim.anchor, objects: victim.objects, notes: victim.notes }]
          : d.detached,
        ...(victim.anchor.print
          ? { skippedPrints: [...(d.skippedPrints ?? []), victim.anchor.print] }
          : {}),
      }));
      setSlideIndex((i) => Math.max(0, Math.min(i, cur.slides.length - 2)));
      setSelection(new Set());
    },
    [commit],
  );

  /** Add an empty slide after `index`, backed by the same base page. The only way
   *  to grow a deck that is not "recompile the source". */
  const addBlankSlide = useCallback(
    (index: number) => {
      commit((d) => {
        const anchor = d.slides[index]?.anchor ?? { page: 1 };
        const fresh: Slide = { ...blankSlide(anchor.page), anchor: { ...anchor } };
        return { ...d, slides: insertSlide(d.slides, fresh, index + 1) };
      });
      setSlideIndex(index + 1);
      setSelection(new Set());
    },
    [commit],
  );

  /** Keep a slide in the deck but out of the talk — the backup slide, or the
   *  section cut for a shorter version. */
  const toggleSkip = useCallback(
    (index: number) => {
      commit((d) => ({
        ...d,
        slides: updateSlide(d.slides, index, (s) => ({ ...s, skip: s.skip ? undefined : true })),
      }));
    },
    [commit],
  );

  const addRect = useCallback(() => {
    if (!deck) return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "shape",
        shape: "rect",
        fill: deck.theme.shapeFill,
        stroke: deck.theme.shapeStroke,
        strokeWidth: deck.theme.shapeStrokeWidth,
        x: 0.35,
        y: 0.4,
        w: 0.3,
        h: 0.2,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [deck, withObjects]);

  const addText = useCallback(() => {
    if (!deck) return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "text",
        text: "Text",
        style: { ...deck.theme.text },
        padding: 2,
        x: 0.3,
        y: 0.45,
        w: 0.4,
        h: 0.1,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [deck, withObjects]);

  // --- assets --------------------------------------------------------------
  // Images and interstitial clips are loaded by the shared hooks the audience
  // window also uses, so the projector and the editor can never resolve a
  // deck-relative path two different ways.
  const { assets, refresh: refreshImage } = useDeckImages(deck, path, scope);
  const interstitials = useMemo(() => interstitialsOf(deck), [deck]);
  const { gifs } = useDeckGifs(interstitials, path, scope);
  // Embedded faces (#120). One loader feeds the metrics, the DOM `@font-face`
  // and the exporter, so the deck cannot be measured against one font and drawn
  // or exported with another.
  const fonts = useDeckFonts(deck, path, scope, metrics);

  const addIcon = useCallback(
    (def: IconDef) => {
      if (!deck) return;
      if (picking === "replace") {
        withObjects((list, ids) =>
          list.map((o) => (ids.includes(o.id) && o.kind === "icon" ? { ...o, icon: def.key } : o)),
        );
        setPicking(null);
        return;
      }
      const id = newObjectId();
      // Square by default: an icon stretched to a random box reads as a mistake,
      // and the aspect is measured against the page, not the box.
      const side = 0.12;
      withObjects((list) => [
        ...list,
        {
          id,
          kind: "icon",
          icon: def.key,
          color: deck.theme.iconColor,
          strokeWidth: deck.theme.iconStrokeWidth,
          x: 0.44,
          y: 0.44,
          w: side,
          h: (side * deck.pageWidth) / deck.pageHeight,
          rot: 0,
          opacity: 1,
        },
      ]);
      setSelection(new Set([id]));
      setPicking(null);
    },
    [deck, picking, withObjects],
  );

  // --- export -------------------------------------------------------------

  /**
   * Characters in this deck that the built-in PDF fonts cannot write, as a
   * sentence — or null when there are none.
   *
   * Run **before** the export and surfaced in the toolbar, because the exporter's
   * own fallback (which drops them and warns) tells the author at export time,
   * and for a talk that is the night before. A Greek letter in a caption is the
   * single most likely thing to hit this, and it renders perfectly on screen
   * (CSS font stacks), so nothing else in the editor would ever mention it.
   * See TODO V #120 for the real fix this is a net under.
   */
  const fontWarning = useMemo(() => {
    if (!deck) return null;
    const bad = new Set<string>();
    for (const s of deck.slides) {
      for (const o of s.objects) {
        if (o.kind !== "text" || o.hidden) continue;
        for (const c of unencodableIn(o.text)) bad.add(c);
      }
    }
    if (bad.size === 0) return null;
    const list = [...bad].slice(0, 8).map((c) => `"${c}"`).join(", ");
    const chars = bad.size > 8 ? `${list} ${t("deckView.andMore", { n: bad.size - 8 })}` : list;
    return t(bad.size === 1 ? "deckView.fontWarningOne" : "deckView.fontWarningMany", { chars });
  }, [deck, t]);

  const doExport = useCallback(async () => {
    if (!deck || !metrics) return;
    setExporting(true);
    setNotice(null);
    try {
      const dir = dirOf(path);
      const basePath = resolveRel(dir, deck.base ?? pdfPathForDeck(path));
      let baseBytes: Uint8Array | null = null;
      try {
        baseBytes = new Uint8Array(await readFileBytes(basePath, scope));
      } catch {
        // Exporting a deck whose plate has gone is still worth doing — the
        // layers are the part the author made.
      }

      const images = new Map<string, Uint8Array>();
      for (const slide of deck.slides) {
        for (const o of slide.objects) {
          if (o.kind !== "image" || images.has(o.src)) continue;
          try {
            images.set(o.src, new Uint8Array(await readFileBytes(resolveRel(dir, o.src), scope)));
          } catch {
            // Reported as a warning by the exporter, which knows the context.
          }
        }
      }

      // A GIF cannot be a PDF page, so each interstitial contributes its poster
      // frame. Encoding needs a canvas, which is why it happens here and not in
      // the (deliberately DOM-free, testable) exporter.
      const posters = new Map<string, Uint8Array>();
      for (const a of interstitials) {
        const g = gifs.get(gifKey(a));
        if (!g) continue;
        const png = await posterPng(g, a.poster);
        if (png) posters.set(a.id, png);
      }

      const out = await exportDeck({
        deck,
        baseBytes,
        images,
        posters,
        metrics,
        // The SAME bytes the metrics were registered with — the contract that
        // makes the export match the screen line for line (#120).
        fonts: fonts.bytes,
      });
      const exportTarget = exportPathFor(path);
      await writeFileBytes(exportTarget, out.bytes, scope);
      setNotice(
        t(out.pages === 1 ? "deckView.exportedOne" : "deckView.exportedMany", {
          n: out.pages,
          file: exportTarget.split("/").pop() ?? exportTarget,
        }) + (out.warnings.length ? ` ${out.warnings.join(" ")}` : ""),
      );
    } catch (e) {
      setError(t(describeFileErrorKey(e)));
    } finally {
      setExporting(false);
    }
  }, [deck, metrics, path, scope, interstitials, gifs, fonts.bytes, t]);

  const toDeckRelative = useCallback((absolute: string) => deckRelative(dirOf(path), absolute), [
    path,
  ]);

  const patchSlide = useCallback(
    (patch: (s: import("../../../lib/viewers/deck/model").Slide) => import("../../../lib/viewers/deck/model").Slide) => {
      commit((d) => ({ ...d, slides: updateSlide(d.slides, slideIndex, patch) }));
    },
    [commit, slideIndex],
  );

  // --- generate a base plate ----------------------------------------------
  /**
   * The "from blank" path: write a starter Beamer `.tex` and compile it into the
   * base plate this deck is missing.
   *
   * Deliberately never overwrites an existing `.tex` — the author owns that file
   * from the moment it is created, and Tabtivity writing over a source they have
   * been editing is exactly the trust this feature cannot afford to lose.
   */
  const generateBase = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const texPath = texPathForDeck(path);
      let hasTex = true;
      try {
        await readFileText(texPath, scope);
      } catch {
        hasTex = false;
      }
      if (!hasTex) {
        await writeFileBytes(
          texPath,
          new TextEncoder().encode(starterTex({ title: titleFromPath(path) })),
          scope,
        );
      }
      const res = await invokeTrusted<TexCompileResult>("compile_tex", { path: texPath });
      if (!res.success) {
        setNotice(
          t("deckView.starterTexFailed", { log: res.log.trim().split("\n").slice(-3).join(" ") }),
        );
        return;
      }
      // Record which `.tex` produced this plate. `deck.source` has always been
      // read and never written, and a SyncTeX anchor needs to know the deck HAS a
      // source at all (TODO V #100a). Written through `commit` so it is an
      // ordinary, undoable, autosaved edit.
      const rel = toDeckRelative(texPath);
      commit((d) => (d.source === rel ? d : { ...d, source: rel }));
      setNotice(t(hasTex ? "deckView.recompiledBasePdf" : "deckView.createdStarterTex"));
      setReloadNonce((n) => n + 1);
    } catch (e) {
      setError(t(describeFileErrorKey(e)));
    } finally {
      setGenerating(false);
    }
  }, [path, scope, commit, toDeckRelative, t]);

  /**
   * Place an image. Stored **deck-relative** when the file is under the deck's
   * own folder, so moving or syncing the project does not break it; an absolute
   * path is kept only for a file genuinely outside the tree, where there is no
   * relative form to record.
   */
  /**
   * Ask for an image file and hand back its **deck-relative** path, or null.
   *
   * Refuses a file outside the project rather than storing an absolute path the
   * confined file commands will later refuse to read — which produced a
   * permanent placeholder on the slide and an unexplained warning in every
   * export. Shared by "add" and "replace" so the rule cannot be enforced in one
   * and forgotten in the other.
   */
  const pickImage = useCallback(async (): Promise<string | null> => {
    const chosen = await open({
      multiple: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg"] }],
      ...(projectRoot ? { defaultPath: projectRoot } : {}),
    });
    if (typeof chosen !== "string") return null;
    if (!withinProject(projectRoot, chosen)) {
      setNotice(t("deckView.outsideProjectNotice", { name: chosen.split("/").pop() ?? chosen }));
      return null;
    }
    return toDeckRelative(chosen);
  }, [projectRoot, toDeckRelative, t]);

  const addImage = useCallback(async () => {
    const src = await pickImage();
    if (!src) return;
    const id = newObjectId();
    withObjects((list) => [
      ...list,
      {
        id,
        kind: "image",
        src,
        fit: "contain",
        x: 0.3,
        y: 0.3,
        w: 0.4,
        h: 0.4,
        rot: 0,
        opacity: 1,
      },
    ]);
    setSelection(new Set([id]));
  }, [withObjects, pickImage]);

  /** Swap the file behind an existing image, keeping its geometry, rotation,
   *  opacity and build step — the whole point of replacing rather than
   *  deleting and re-placing (TODO V #108). */
  const replaceImage = useCallback(
    async (obj: ImageObject) => {
      const src = await pickImage();
      if (!src || src === obj.src) return;
      commit((d) => ({
        ...d,
        slides: updateSlide(d.slides, slideIndex, (s) => ({
          ...s,
          objects: s.objects.map((o) => (o.id === obj.id ? { ...o, src } : o)),
        })),
      }));
    },
    [commit, pickImage, slideIndex],
  );

  // --- TeX figures ---------------------------------------------------------
  // A TeX figure is an ordinary `image` object whose `src` PNG is generated by
  // compiling and rasterizing a `.tex` the object also remembers (`texSrc`).
  // Three entry points converge on one low-level step (`rasterizeInto`): the
  // toolbar FAB creates the pair from scratch, "Recompile" reruns an existing
  // one, and the poll below reacts when the author recompiles from the source
  // tab directly rather than from here.

  const markTexBusy = useCallback((id: string, busy: boolean) => {
    setTexBusyIds((cur) => {
      const next = new Set(cur);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** Read `pdfAbs`, rasterize its first page, and write the PNG to `pngAbs`.
   *  Records the PDF's new mtime so the poll never re-processes a write this
   *  view just made itself. Returns the raster's pixel size, or null on
   *  failure (reported by the caller, which knows the right wording). */
  const rasterizeInto = useCallback(
    async (pdfAbs: string, pngAbs: string) => {
      const pdfBytes = new Uint8Array(await readFileBytes(pdfAbs, scope));
      const rendered = await renderPdfPageToPng(pdfBytes);
      if (!rendered) return null;
      await writeFileBytes(pngAbs, rendered.png, scope);
      const mt = await fileMtime(pdfAbs, scope).catch(() => null);
      if (mt != null) mtimesRef.current.set(pdfAbs, mt);
      return rendered;
    },
    [scope],
  );

  const addTexFigure = useCallback(async () => {
    if (!deck) return;
    const dir = texFigureDir(path);
    const id = newObjectId();
    const texAbs = `${dir}/${id}.tex`;
    const pngAbs = `${dir}/${id}.png`;
    markTexBusy(id, true);
    setError(null);
    try {
      await writeFileBytes(texAbs, new TextEncoder().encode(starterTexFigure()), scope);
      const res = await invokeTrusted<TexCompileResult>("compile_tex", { path: texAbs });
      if (!res.success || !res.pdf_path) {
        setNotice(
          t("deckView.texFigureFailed", { log: res.log.trim().split("\n").slice(-3).join(" ") }),
        );
        return;
      }
      const rendered = await rasterizeInto(res.pdf_path, pngAbs);
      if (!rendered) {
        setNotice(t("deckView.texFigureRasterFailed"));
        return;
      }
      // Preserve the figure's own aspect ratio rather than forcing it into a
      // square — a wide equation squashed into a box is illegible.
      const w = 0.3;
      const h = w * (deck.pageWidth / deck.pageHeight) * (rendered.height / rendered.width);
      withObjects((list) => [
        ...list,
        {
          id,
          kind: "image",
          src: toDeckRelative(pngAbs),
          texSrc: toDeckRelative(texAbs),
          fit: "contain",
          x: 0.35,
          y: 0.35,
          w,
          h,
          rot: 0,
          opacity: 1,
        },
      ]);
      setSelection(new Set([id]));
    } catch (e) {
      setError(t(describeFileErrorKey(e)));
    } finally {
      markTexBusy(id, false);
    }
  }, [deck, path, scope, withObjects, toDeckRelative, rasterizeInto, markTexBusy, t]);

  /** Open a TeX-figure's source as its own tab — Tabtivity's full TeX editor, with
   *  its own Compile button and SyncTeX. The poll below is what notices when
   *  that tab's own recompile finishes and updates the slide. */
  const editTexObject = useCallback(
    (obj: ImageObject) => {
      if (!obj.texSrc) return;
      const dir = dirOf(path);
      openLinkedFile(tabKey, dir, {
        path: resolveRel(dir, obj.texSrc),
        viewer: "tex",
        label: obj.texSrc.split("/").pop() ?? obj.texSrc,
      });
    },
    [path, tabKey],
  );

  const recompileTexObject = useCallback(
    async (obj: ImageObject) => {
      if (!obj.texSrc) return;
      const dir = dirOf(path);
      const texAbs = resolveRel(dir, obj.texSrc);
      const pngAbs = resolveRel(dir, obj.src);
      markTexBusy(obj.id, true);
      setError(null);
      try {
        const res = await invokeTrusted<TexCompileResult>("compile_tex", { path: texAbs });
        if (!res.success || !res.pdf_path) {
          setNotice(t("deckView.recompileFailed", { log: res.log.trim().split("\n").slice(-3).join(" ") }));
          return;
        }
        const rendered = await rasterizeInto(res.pdf_path, pngAbs);
        if (!rendered) {
          setNotice(t("deckView.recompiledRasterFailed"));
          return;
        }
        refreshImage(obj.src);
      } catch (e) {
        setError(t(describeFileErrorKey(e)));
      } finally {
        markTexBusy(obj.id, false);
      }
    },
    [path, rasterizeInto, refreshImage, markTexBusy, t],
  );

  /** Jump to a TeX figure from the deck-wide list (`DeckTexPanel`): select its
   *  slide and the object itself, without leaving TeX mode. */
  const jumpToTexFigure = useCallback((slideIdx: number, objectId: string) => {
    setSlideIndex(slideIdx);
    setSelection(new Set([objectId]));
  }, []);

  // Notice an external recompile — the author hit Compile in the `.tex` tab
  // this view opened, rather than using the Recompile button here — by polling
  // every TeX figure's compiled PDF for an mtime this view did not itself just
  // record. Mirrors the PDF viewer's own external-change poll (same interval);
  // deliberately skips any object already mid-compile, so a manual Recompile
  // and this poll can never race to rasterize the same PDF twice.
  useEffect(() => {
    // Visible panes only: this poll is a `file_mtime` per figure per tick — an
    // SFTP round trip each on a remote project — and hidden panes stay mounted
    // forever. `mtimesRef` survives the hidden spell, so re-show re-baselines
    // nothing and the first tick picks up any recompile it missed.
    if (!deck || !paneVisible) return;
    const figures = deck.slides.flatMap((s) =>
      s.objects.filter(
        (o): o is ImageObject & { texSrc: string } => o.kind === "image" && !!o.texSrc,
      ),
    );
    if (figures.length === 0) return;
    const dir = dirOf(path);
    let cancelled = false;
    const id = setInterval(() => {
      // Stand down during a talk. A figure that recompiled mid-presentation
      // called `refreshImage`, which re-seeds only THIS window's asset map — so
      // the projector kept the old version and the two displays showed different
      // pictures, the one thing the dual-window design says cannot happen. On a
      // remote project the poll is also a synchronous SFTP round trip per figure
      // per tick, on the main thread, during the presentation (TODO V #113).
      if (presentingRef.current) return;
      void (async () => {
        for (const obj of figures) {
          if (cancelled || texBusyIds.has(obj.id)) continue;
          const texAbs = resolveRel(dir, obj.texSrc);
          const pdfAbs = texAbs.replace(/\.tex$/i, ".pdf");
          let mt: number;
          try {
            mt = await fileMtime(pdfAbs, scope);
          } catch {
            continue; // Not compiled yet, or the PDF moved — nothing to raster.
          }
          if (cancelled) return;
          const known = mtimesRef.current.get(pdfAbs);
          if (known === mt) continue;
          if (known == null) {
            // First observation of this PDF this session — its PNG is presumed
            // already in sync (either this view just wrote it, or it was saved
            // that way in an earlier session), so this establishes the baseline
            // rather than re-rastering something that has not actually changed.
            mtimesRef.current.set(pdfAbs, mt);
            continue;
          }
          const pngAbs = resolveRel(dir, obj.src);
          markTexBusy(obj.id, true);
          try {
            const rendered = await rasterizeInto(pdfAbs, pngAbs);
            if (rendered && !cancelled) refreshImage(obj.src);
          } catch {
            // A transient read failure (mid-write) — the next tick retries.
          } finally {
            if (!cancelled) markTexBusy(obj.id, false);
          }
        }
      })();
    }, TEX_FIGURE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [deck, path, scope, paneVisible, texBusyIds, rasterizeInto, refreshImage, markTexBusy]);

  // --- keyboard ----------------------------------------------------------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // A keystroke aimed at a form control (the inspector's text/number fields)
      // is that control's — never a canvas shortcut. Without this, typing a space
      // or hitting Backspace while editing text would nudge or delete the object.
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (mod && e.key.toLowerCase() === "a") {
        e.preventDefault();
        setSelection(new Set((deck?.slides[slideIndex]?.objects ?? []).map((o) => o.id)));
        return;
      }
      if (mod && e.key.toLowerCase() === "c") {
        copySelection();
        return;
      }
      if (mod && e.key.toLowerCase() === "x") {
        if (selection.size === 0) return;
        e.preventDefault();
        copySelection();
        withObjects((list, ids) => removeObjects(list, ids));
        setSelection(new Set());
        return;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selection.size === 0) return;
        e.preventDefault();
        withObjects((list, ids) => removeObjects(list, ids));
        setSelection(new Set());
        return;
      }
      if (e.key === "Escape") {
        setSelection(new Set());
        return;
      }
      const step = e.shiftKey ? NUDGE * 10 : NUDGE;
      const nudge: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const d = nudge[e.key];
      if (d && selection.size > 0) {
        e.preventDefault();
        withObjects((list, ids) => moveObjects(list, ids, d[0], d[1]));
      }
    },
    [
      deck,
      slideIndex,
      selection,
      withObjects,
      undo,
      redo,
      copySelection,
      pasteClipboard,
      duplicateSelection,
    ],
  );

  // --- rail resize ---------------------------------------------------------
  // Pointer-based, live-local during the drag, committed (and persisted) once
  // on release — the same shape `SubwindowFilesSidebar`'s resize handle uses,
  // for the same reason: a store write per pointermove is the easiest way to
  // make a resize feel broken.
  const startRailResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const startW = railWidth;
      let last = startW;
      const onMove = (ev: PointerEvent) => {
        last = clampRailWidth(startW + (ev.clientX - startX));
        setLiveRailWidth(last);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setLiveRailWidth(null);
        if (last !== startW) {
          setRailWidth(last);
          railState.persist({ deckRailWidth: last });
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [railWidth, railState],
  );

  // --- render ------------------------------------------------------------

  const slide = deck?.slides[slideIndex];
  const hasSel = selection.size > 0;
  const pageBox = deck
    ? slidePageBox(deck, slide)
    : { width: DEFAULT_PAGE_WIDTH, height: DEFAULT_PAGE_HEIGHT };
  // Position in the TALK — a skipped slide is not part of the count a footer's
  // `{n}` should show, or the presenter should pace against (#106).
  const talkCount = deck ? deck.slides.filter((s) => !s.skip).length : 0;
  const talkIndex =
    deck && slide ? deck.slides.filter((s) => !s.skip).findIndex((s) => s.id === slide.id) : 0;

  if (error) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-error">{error}</div>
      </div>
    );
  }
  if (!deck) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-loading">{t("deckView.openingPresentation")}</div>
      </div>
    );
  }

  return (
    <div className="file-viewer deck-view" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="file-viewer-pdf-toolbar" role="group" aria-label={t("deckView.presentationToolsAria")}>
        <span className="deck-toolbar-title">
          {t("deckView.presentationTitle")} <UntestedTag id="deckView.presentationTitle" />
        </span>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button className="file-viewer-zoom-btn" onClick={addText} title={t("deckView.addTextBoxTitle")}>
          T
        </button>
        <button className="file-viewer-zoom-btn" onClick={addRect} title={t("deckView.addRectTitle")}>
          ▭
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => setPicking("new")}
          title={t("deckView.addIconTitle")}
        >
          ☆
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => void addImage()}
          title={t("deckView.addImageTitle")}
        >
          ▣
        </button>
        <button
          className="file-viewer-zoom-btn"
          onClick={() => void addTexFigure()}
          disabled={!texAvailable || texBusyIds.size > 0}
          title={t("deckView.addTexFigureTitle")}
        >
          𝒯+
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={duplicateSelection}
          title={t("deckView.duplicateSelectionTitle")}
        >
          ⧉
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "left"))}
          title={t("deckView.alignLeftTitle")}
        >
          ⇤
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "hcenter"))}
          title={t("deckView.centerHorizontalTitle")}
        >
          ⇔
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "right"))}
          title={t("deckView.alignRightTitle")}
        >
          ⇥
        </button>
        {/* The vertical half of `alignObjects`, and `distributeObjects` — both
            modelled and tested from the start, neither reachable from any UI
            (TODO V #119). */}
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "top"))}
          title={t("deckView.alignTopTitle")}
        >
          ⤒|
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "vcenter"))}
          title={t("deckView.centerVerticalTitle")}
        >
          ⇕
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => alignObjects(l, ids, "bottom"))}
          title={t("deckView.alignBottomTitle")}
        >
          ⤓|
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={selection.size < 3}
          onClick={() => withObjects((l, ids) => distributeObjects(l, ids, "h"))}
          title={t("deckView.distributeHTitle")}
        >
          ⇹
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={selection.size < 3}
          onClick={() => withObjects((l, ids) => distributeObjects(l, ids, "v"))}
          title={t("deckView.distributeVTitle")}
        >
          ⇳
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => toFront(l, ids))}
          title={t("deckView.bringFrontTitle")}
        >
          ⤒
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => raiseObjects(l, ids))}
          title={t("deckView.raiseTitle")}
        >
          ↑
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => lowerObjects(l, ids))}
          title={t("deckView.lowerTitle")}
        >
          ↓
        </button>
        <button
          className="file-viewer-zoom-btn"
          disabled={!hasSel}
          onClick={() => withObjects((l, ids) => toBack(l, ids))}
          title={t("deckView.sendBackTitle")}
        >
          ⤓
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className={`file-viewer-zoom-text${mode === "design" ? " active" : ""}`}
          onClick={() => setMode("design")}
          title={t("deckView.designModeTitle")}
        >
          {t("deckView.designModeBtn")}
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "animate" ? " active" : ""}`}
          onClick={() => setMode("animate")}
          title={t("deckView.animateModeTitle")}
        >
          {t("deckView.animateModeBtn")}
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "notes" ? " active" : ""}`}
          onClick={() => setMode("notes")}
          title={t("deckView.notesModeTitle")}
        >
          {t("deckView.notesModeBtn")}
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "tex" ? " active" : ""}`}
          onClick={() => setMode("tex")}
          title={t("deckView.texModeTitle")}
        >
          TeX
        </button>
        <button
          className={`file-viewer-zoom-text${mode === "deck" ? " active" : ""}`}
          onClick={() => setMode("deck")}
          title={t("deckView.deckModeTitle")}
        >
          {t("deckView.deckModeBtn")}
        </button>
        <span className="file-viewer-pdf-toolbar-sep" />
        <button
          className="file-viewer-zoom-text"
          // Shift presents from the beginning; a plain click resumes at the slide
          // being edited, which is what "let me see how this looks" means — and
          // walking the whole deck to check one slide was the old cost (#114).
          onClick={(e) => {
            setPresentFrom(e.shiftKey ? 0 : slideIndex);
            setPresenting(true);
          }}
          disabled={deck.slides.length === 0}
          title={t("deckView.presentTitle")}
        >
          <PlayIcon /> {t("deckView.presentBtn")}
        </button>
        <button
          className="file-viewer-zoom-text"
          onClick={() => void doExport()}
          disabled={exporting || !metrics}
          title={
            fontWarning
              ? t("deckView.exportPdfTitleWarn", { warning: fontWarning })
              : t("deckView.exportPdfTitle")
          }
        >
          {exporting ? t("deckView.exportingBtn") : t("deckView.exportPdfBtn")}
          {fontWarning && <span className="deck-export-warn" title={fontWarning}>!</span>}
        </button>
        <span className="file-viewer-header-spacer" />
        {/* Driven by `dirty`, not by the in-flight write: the old label said
            "Saved" for the whole 800 ms debounce window, i.e. exactly while the
            edit was NOT on disk (TODO V #93). */}
        <span className="deck-save-state" aria-live="polite">
          {saving
            ? t("deckView.savingState")
            : hold
              ? t("deckView.notSavingState")
              : dirty
                ? t("deckView.unsavedState")
                : t("deckView.savedState")}
        </span>
        <button className="file-viewer-zoom-btn" onClick={onOpenExternally} title={t("deckView.openExternallyTitle")}>
          <ArrowUpRightIcon />
        </button>
      </div>

      {/* The write is held. Blocking-ish rather than a passing notice, because
          the alternative to reading it is losing part of the file (TODO V #94). */}
      {hold && (
        <div className="file-viewer-banner deck-hold-banner">
          <span>{hold}</span>
          <button
            className="deck-inspector-btn"
            onClick={() => setHold(null)}
            title={t("deckView.editAnywayTitle")}
          >
            {t("deckView.editAnywayBtn")}
          </button>
          <button className="deck-inspector-btn" onClick={() => setReloadNonce((n) => n + 1)}>
            {t("deckView.reloadFromDiskBtn")}
          </button>
        </div>
      )}

      {notice && <div className="file-viewer-banner">{notice}</div>}

      {fontWarning && <div className="file-viewer-banner deck-font-banner">{fontWarning}</div>}

      <div className="deck-body">
        <div
          className="deck-rail"
          role="listbox"
          aria-label={t("deckView.slidesAria")}
          style={{ width: liveRailWidth ?? railWidth }}
        >
          <div className="deck-rail-head">{t("deckView.slidesHead")}</div>
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              className={`deck-rail-item${i === slideIndex ? " active" : ""}${
                s.skip ? " skipped" : ""
              }`}
              role="option"
              aria-selected={i === slideIndex}
              tabIndex={0}
              style={{ aspectRatio: `${deck.pageWidth} / ${deck.pageHeight}` }}
              onClick={() => {
                setSlideIndex(i);
                setSelection(new Set());
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  setSlideIndex(i);
                  setSelection(new Set());
                }
              }}
            >
              <DeckRailThumb
                doc={doc}
                page={s.anchor.page}
                width={Math.max(1, (liveRailWidth ?? railWidth) - 12)}
                height={Math.max(1, ((liveRailWidth ?? railWidth) - 12) * (deck.pageHeight / deck.pageWidth))}
              />
              <span className="deck-rail-num">{i + 1}</span>
              {s.objects.length > 0 && (
                <span
                  className="deck-rail-badge"
                  title={t("deckView.layerObjectsTitle", { n: s.objects.length })}
                >
                  {s.objects.length}
                </span>
              )}
              {s.after && (
                <span className="deck-rail-gif" title={t("deckView.gifPlaysTitle")}>
                  <PlayIcon />
                </span>
              )}
              {/* Reorder and copy are both durable — reorder moves this slide in the
                  presentation sequence, copy adds a clone that backs the same base
                  page; neither changes the base PDF. */}
              <span className="deck-rail-actions">
                <button
                  className="deck-rail-act-btn"
                  disabled={i === 0}
                  title={t("deckView.moveEarlierTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, -1);
                  }}
                >
                  ▲
                </button>
                <button
                  className="deck-rail-act-btn"
                  disabled={i === deck.slides.length - 1}
                  title={t("deckView.moveLaterTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    moveSlide(i, 1);
                  }}
                >
                  ▼
                </button>
                <button
                  className="deck-rail-act-btn"
                  title={t("deckView.duplicateSlideTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    duplicateSlide(i);
                  }}
                >
                  ⧉
                </button>
                {/* Skip and delete: `removeSlides` and `blankSlide` were written
                    and tested but had no caller at all, so a deck could only ever
                    grow (TODO V #106). */}
                <button
                  className={`deck-rail-act-btn${s.skip ? " active" : ""}`}
                  title={s.skip ? t("deckView.includeSlideTitle") : t("deckView.skipSlideTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSkip(i);
                  }}
                >
                  ⤫
                </button>
                <button
                  className="deck-rail-act-btn"
                  title={t("deckView.addBlankAfterTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    addBlankSlide(i);
                  }}
                >
                  +
                </button>
                <button
                  className="deck-rail-act-btn deck-rail-act-danger"
                  title={t("deckView.removeSlideTitle")}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSlide(i);
                  }}
                >
                  ␡
                </button>
              </span>
            </div>
          ))}
          <button
            className="deck-rail-add"
            title={t("deckView.addBlankEndTitle")}
            onClick={() => addBlankSlide(deck.slides.length - 1)}
          >
            + {t("deckView.addBlankEndBtn")}
          </button>
        </div>

        <div
          className="deck-rail-resize"
          title={t("deckView.resizeRailTitle")}
          onPointerDown={startRailResize}
        />

        {slide ? (
          <DeckStage
            slide={slide}
            doc={doc}
            // The SLIDE's box, not the deck's: a plate that mixes page sizes (a
            // portrait appendix, an inserted landscape figure page) otherwise
            // mis-scales every layer on those pages (TODO V #112).
            pageWidth={pageBox.width}
            pageHeight={pageBox.height}
            margin={deck.theme.margin}
            selection={selection}
            onSelectionChange={setSelection}
            onObjectsChange={setObjects}
            assets={assets}
            metrics={metrics}
            previewStep={mode === "animate" ? previewStep : undefined}
            showBuildBadges={mode === "animate"}
            footer={footerObject(deck, talkIndex, talkCount, pageBox.height)}
            onEditObject={(obj) => {
              if (obj.kind === "image" && obj.texSrc) editTexObject(obj);
            }}
            onTextChange={(id, text) =>
              // Keyed per object, so a sentence typed on the slide is ONE undo
              // step rather than one per character (TODO V #104).
              setObjects(
                updateObjects(slide.objects, [id], (o) =>
                  o.kind === "text" ? { ...o, text } : o,
                ),
                `text:${id}`,
              )
            }
          />
        ) : (
          <div className="deck-stage deck-stage-empty">
            <p>{t("deckView.noBasePdfMsg")}</p>
            {texAvailable ? (
              <>
                <p>{t("deckView.canWriteStarterMsg")}</p>
                <button
                  className="deck-inspector-btn"
                  onClick={() => void generateBase()}
                  disabled={generating}
                >
                  {generating ? t("deckTexPanel.compiling") : t("deckView.createStarterBtn")}
                </button>
              </>
            ) : (
              <p>{t("deckView.noLatexEngineMsg")}</p>
            )}
          </div>
        )}

        {mode === "deck" ? (
          <DeckThemePanel
            deck={deck}
            selected={slide?.objects.filter((o) => selection.has(o.id)) ?? []}
            onDeckChange={commit}
            onApplyTextToAll={() =>
              commit((d) => ({
                ...d,
                slides: d.slides.map((s) => ({
                  ...s,
                  objects: s.objects.map((o) =>
                    o.kind === "text" ? { ...o, style: { ...d.theme.text } } : o,
                  ),
                })),
              }))
            }
          />
        ) : mode === "tex" ? (
          <DeckTexPanel
            deck={deck}
            onJump={jumpToTexFigure}
            onEditTex={editTexObject}
            onRecompileTex={(obj) => void recompileTexObject(obj)}
            texBusyIds={texBusyIds}
          />
        ) : mode === "notes" && slide ? (
          <DeckNotes slide={slide} onSlideChange={patchSlide} />
        ) : mode === "animate" && slide ? (
          <DeckAnimate
            slide={slide}
            selection={selection}
            onObjectsChange={setObjects}
            onSlideChange={patchSlide}
            previewStep={previewStep}
            onPreviewStep={setPreviewStep}
            toDeckRelative={toDeckRelative}
          />
        ) : (
          <DeckInspector
            objects={slide?.objects ?? []}
            selection={selection}
            onChange={setObjects}
            onPickIcon={() => setPicking("replace")}
            onEditTex={editTexObject}
            onRecompileTex={(obj) => void recompileTexObject(obj)}
            onReplaceImage={(obj) => void replaceImage(obj)}
            missingFonts={fonts.missing}
            texBusyIds={texBusyIds}
          />
        )}
      </div>

      {picking && <IconPicker onPick={addIcon} onClose={() => setPicking(null)} />}

      {presenting && (
        <DeckPresenter
          deck={deck}
          doc={doc}
          metrics={metrics}
          assets={assets}
          gifs={gifs}
          path={path}
          scope={scope}
          startAt={Math.max(0, slideStopIndex(sequence(deck), presentFrom))}
          onClose={() => setPresenting(false)}
        />
      )}

      {deck.detached.length > 0 && (
        <div className="file-viewer-banner deck-detached-banner">
          <span>
            {t(
              deck.detached.length === 1 ? "deckView.detachedBannerOne" : "deckView.detachedBannerMany",
              { n: deck.detached.length },
            )}
          </span>
          {deck.detached.map((d, i) => (
            <button
              key={i}
              className="deck-inspector-btn"
              title={t("deckView.detachedObjTitle", { n: d.objects.length, page: d.from.page })}
              onClick={() => commit((cur) => reattach(cur, i, slideIndex))}
            >
              {t("deckView.detachedRestoreBtn", {
                page: d.from.page,
                count: d.objects.length,
                n: slideIndex + 1,
              })}
            </button>
          ))}
        </div>
      )}
      {/* `tabKey`/`groupId` are threaded for the presenter and per-tab state that
          Phases 6–7 add; referenced here so the props are not silently dropped. */}
      <span hidden data-tab-key={tabKey ?? ""} data-group-id={groupId ?? ""} />
    </div>
  );
}
