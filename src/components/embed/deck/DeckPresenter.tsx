/**
 * The presenter.
 *
 * Navigation runs off `model.sequence(deck)`, which flattens the deck into an
 * ordered list of *stops* — a slide at a build step, or an interstitial. Doing
 * that up front is what makes the awkward cases correct by construction: `←`
 * steps a build backwards instead of jumping a slide (losing the slide to the
 * first audience question is the single most common presenter-software failure),
 * and a GIF that plays between two slides is simply one more stop.
 *
 * **One presenter, one or two screens.** With no second display this is the
 * fullscreen presenter with an optional notes/timer panel (`N`). Press `D` (or
 * the ⧉ button) and Tabtivity opens an **audience window** — a separate OS window,
 * placed fullscreen on another monitor when there is one — and this window
 * becomes the *presenter view*: current slide, next slide, notes, timer, build
 * indicator. This window keeps owning the stop; the audience window renders what
 * it is told and forwards its own keys back (see `deck/present.ts`). Two heaps,
 * one index — the two displays cannot drift apart.
 *
 * The laser and marker are `PresentationOverlay`, mounted verbatim — it is
 * self-contained, stores nothing, and already solves normalized coordinates and
 * device-pixel sizing. It only needs a `position: relative` host. Known limit of
 * the dual-window mode: those strokes are drawn on *this* window and are not
 * mirrored to the audience one.
 *
 * Rendered through a portal into `#root` rather than `document.body`: a
 * body-level portal can fail to paint in a detached popout webview (documented at
 * `ContextFilePicker.tsx`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PLATFORM } from "../../../lib/platform";
import { PresentationOverlay } from "../PresentationOverlay";
import { isToolArmed, usePresentationStore } from "../../../stores/viewers/presentation";
import {
  type Deck,
  type Slide,
  type Stop,
  footerObject,
  sequence,
  slidePageBox,
} from "../../../lib/viewers/deck/model";
import { serializeDeck } from "../../../lib/viewers/deck/sidecar";
import {
  type Blank,
  type PresentNav,
  type PresentReady,
  type PresentSeed,
  PRESENT_CLOSED,
  PRESENT_NAV,
  PRESENT_READY,
  applyNav,
  clampStop,
  keyToAction,
  nextSlideOf,
  presentSeedEvent,
  presentStateEvent,
  presenterLabel,
  slideStopIndex,
} from "../../../lib/viewers/deck/present";
import type { TextMetrics } from "../../../lib/viewers/deck/fonts";
import { type DecodedGif, disposeGif } from "./gifPlayback";
import { gifKey } from "./deckAssets";
import { renderPage } from "./deckBase";
import { InterstitialView, PresentedSlide } from "./DeckSlideView";
import { useT } from "../../../lib/i18n";
import { useUse24h } from "../../../lib/timeFormat";
import { PauseIcon, PlayIcon, TimerIcon } from "../../common/icons/Icon";
import { ErrorNote } from "../../common/ErrorNote";

export interface DeckPresenterProps {
  deck: Deck;
  doc: PDFDocumentProxy | null;
  metrics: TextMetrics | null;
  assets: ReadonlyMap<string, string>;
  /** Interstitial id → decoded clip, or `undefined` while it loads. */
  gifs: ReadonlyMap<string, DecodedGif>;
  /** The deck's sidecar path — names the audience window and locates its assets. */
  path: string;
  /** File scope the audience window reads its own bytes under. */
  scope: string | null;
  /** Stop to open on. */
  startAt?: number;
  onClose: () => void;
}

/** One overview-grid tile's page render — the presenter's twin of the editor
 *  rail's `DeckRailThumb`, same "render into a ref'd canvas via an effect" shape
 *  `DeckStage` uses for the full-size page. */
function PresenterGridThumb({ doc, page }: { doc: PDFDocumentProxy | null; page: number }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!host) return;
    const measure = () => setBox({ w: host.clientWidth, h: host.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !doc || box.w <= 0 || box.h <= 0) return;
    return renderPage(doc, page, canvas, box.w, box.h);
  }, [doc, page, box.w, box.h]);
  return <canvas className="deck-presenter-grid-thumb" ref={ref} />;
}

export function DeckPresenter({
  deck,
  doc,
  metrics,
  assets,
  gifs,
  path,
  scope,
  startAt = 0,
  onClose,
}: DeckPresenterProps) {
  const t = useT();
  const use24h = useUse24h();
  const stops = useMemo(() => sequence(deck), [deck]);
  const [index, setIndex] = useState(() => Math.min(startAt, Math.max(0, stops.length - 1)));
  const [blank, setBlank] = useState<Blank>(null);
  const [grid, setGrid] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [goto, setGoto] = useState("");
  const [now, setNow] = useState(() => Date.now());
  // The clock is elapsed-since-`started` *plus* whatever was banked before the
  // last pause, so pause/resume needs no second ticker and a reset is one write.
  const [started, setStarted] = useState(() => Date.now());
  const [banked, setBanked] = useState(0);
  const [paused, setPaused] = useState(false);
  /** Target talk length in minutes; 0 = no target, so no amber/red. */
  const [target, setTarget] = useState(0);
  const [notesSize, setNotesSize] = useState(13);
  /** The audience window's label while it is open, else null. */
  const [audience, setAudience] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const stop: Stop | undefined = stops[index];
  const slide: Slide | undefined = stop ? deck.slides[stop.slide] : undefined;

  // The transition is a property of the slide being LEFT ("leaving this slide"
  // in the animate panel), so it is read off the previous stop, not the new one.
  // Held in a ref rather than state: it must be known during the render that
  // first shows the new slide, and a state write would land one frame late —
  // which is exactly one frame of un-transitioned slide.
  const prevSlideRef = useRef<number | null>(null);
  const transitionRef = useRef<string>("none");
  if (stop && prevSlideRef.current !== stop.slide) {
    const from = prevSlideRef.current;
    transitionRef.current =
      from != null && deck.slides[from] ? deck.slides[from].transition : "none";
    prevSlideRef.current = stop.slide;
  }

  // A one-second tick for the elapsed clock. Cheap, and the presenter is the one
  // place a wall clock genuinely earns its re-render.
  useEffect(() => {
    const tickTimer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tickTimer);
  }, []);

  // Tell the rest of the app a talk is on, so `FileViewerPane` withdraws the
  // marker/laser overlay it keeps mounted behind this portal — see
  // `stores/viewers/presentation`.
  useEffect(() => {
    const { setPresenting } = usePresentationStore.getState();
    setPresenting(true);
    return () => setPresenting(false);
  }, []);

  /**
   * Actually fill the screen.
   *
   * `.deck-presenter` is `position: fixed; inset: 0` inside a window that is
   * maximized-but-not-fullscreen (`tauri.conf.json`, and `AppShell` keeps
   * Linux/Windows out of fullscreen deliberately). So "Present fullscreen"
   * presented the talk with the desktop panel and the app chrome around it —
   * on a single monitor, which is the common conference case (TODO V #99).
   *
   * Two rules keep this from fighting the shell. The prior state is **read and
   * restored**, never blindly set to false: `AppShell` has its own reasons for
   * where the window was. And Windows maximizes instead, for the reason
   * `useKeyboard`'s F11 already documents — real fullscreen there strips the
   * window styles Aero Snap and title-bar dragging rely on.
   */
  useEffect(() => {
    const win = getCurrentWindow();
    let restore: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        if (PLATFORM === "windows") {
          const was = await win.isMaximized();
          if (cancelled) return;
          if (!was) {
            await win.maximize();
            restore = () => void win.unmaximize().catch(() => {});
          }
        } else {
          const was = await win.isFullscreen();
          if (cancelled) return;
          if (!was) {
            await win.setFullscreen(true);
            restore = () => void win.setFullscreen(false).catch(() => {});
          }
        }
      } catch {
        // A window manager that refuses is not a reason to fail to present; the
        // talk still runs, just inside the window it was already in.
      }
    })();
    return () => {
      cancelled = true;
      restore?.();
    };
  }, []);

  // Keep the projector awake: a long Q&A pause has no input at all, and the
  // screensaver does not know a talk is a talk. The command holds a
  // `systemd-inhibit` child on Linux, `caffeinate` on macOS and a
  // `SetThreadExecutionState` thread on Windows (`commands/presenter.rs`).
  useEffect(() => {
    void invoke("presenter_inhibit_sleep", { reason: "Presenting a deck" }).catch(() => {});
    return () => {
      void invoke("presenter_release_sleep").catch(() => {});
    };
  }, []);

  const next = useCallback(() => setIndex((i) => clampStop(stops, i + 1)), [stops]);
  const prev = useCallback(() => setIndex((i) => clampStop(stops, i - 1)), [stops]);

  // Bank the elapsed time on pause and restart the reference on resume, so the
  // displayed clock is continuous across both.
  useEffect(() => {
    if (paused) setBanked((b) => b + (Date.now() - started));
    else setStarted(Date.now());
  }, [paused]);

  const resetTimer = useCallback(() => {
    setBanked(0);
    setStarted(Date.now());
  }, []);

  const jumpToSlide = useCallback(
    (n: number) => {
      const found = slideStopIndex(stops, n);
      if (found >= 0) setIndex(found);
      setGrid(false);
    },
    [stops],
  );

  // --- the audience window -------------------------------------------------

  const label = useMemo(() => presenterLabel(path), [path]);

  const openAudience = useCallback(async () => {
    setLinkError(null);
    try {
      await invoke("open_presenter_window", { label });
      setAudience(label);
      // Take focus back. The new window has it, and over there `N`, `G`, `D` and
      // digit-goto are all inert — so without this the speaker's first few
      // keystrokes after pressing `D` land on the projector and do nothing
      // (TODO V #103c). The audience window still forwards the keys it *does*
      // claim, so a clicker bound to it keeps working either way.
      await getCurrentWindow().setFocus().catch(() => {});
    } catch (e) {
      setLinkError(
        t("deckPresenter.linkErrorMsg", { msg: e instanceof Error ? e.message : String(e) }),
      );
    }
  }, [label, t]);

  const closeAudience = useCallback(() => {
    setAudience(null);
    void invoke("close_presenter_window", { label }).catch(() => {
      // A window already gone is the state we wanted.
    });
  }, [label]);

  // Closing the talk takes the audience window with it — a slide left glowing on
  // a projector after the speaker has sat down is worse than no second display.
  const closeAll = useCallback(() => {
    if (audience) closeAudience();
    onClose();
  }, [audience, closeAudience, onClose]);

  // Where we are, for a seed. Read through refs so seeding does NOT depend on
  // the index: it does, of course, carry it, but a dependency would re-serialize
  // the whole deck on every keypress of the talk.
  const whereRef = useRef({ index, blank });
  whereRef.current = { index, blank };

  const seed = useCallback(() => {
    if (!audience) return;
    const payload: PresentSeed = {
      path,
      scope,
      // Serialized, not the live object: the audience window parses the sidecar
      // form, which is the only shape both halves agree on — and this window may
      // hold edits the 800 ms autosave has not written yet.
      deck: serializeDeck(deck),
      index: whereRef.current.index,
      blank: whereRef.current.blank,
    };
    void emit(presentSeedEvent(audience), payload);
  }, [audience, deck, path, scope]);

  // Seed on request (the audience window asks until answered) and whenever the
  // deck itself changes under an open window.
  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PresentReady>(PRESENT_READY, (e) => {
      if (e.payload.label === audience) seed();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience, seed]);

  useEffect(() => {
    seed();
  }, [seed]);

  // Stream the stop/blank. Small and frequent — the seed carries the deck, this
  // carries only where we are in it.
  useEffect(() => {
    if (!audience) return;
    void emit(presentStateEvent(audience), { index, blank });
  }, [audience, index, blank]);

  // Keys pressed on the audience window arrive as requests; this window remains
  // the only place the index actually moves.
  //
  // The handler reads `stops`/`closeAll` through refs so the subscription depends
  // on `audience` alone. `listen()` is async, so every re-subscribe opens a
  // sub-round-trip window in which an audience keypress is silently dropped —
  // and this used to re-subscribe whenever `closeAll` changed identity, i.e. on
  // every toggle of the second display (TODO V #122).
  const stopsRef = useRef(stops);
  stopsRef.current = stops;
  const closeAllRef = useRef(closeAll);
  closeAllRef.current = closeAll;

  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<PresentNav>(PRESENT_NAV, (e) => {
      if (e.payload.label !== audience) return;
      const action = e.payload.action;
      if (action.kind === "close") {
        closeAllRef.current();
        return;
      }
      if (action.kind === "blank") {
        setBlank((v) => (v === action.mode ? null : action.mode));
        return;
      }
      setIndex((i) => applyNav(stopsRef.current, i, action));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience]);

  // The audience window was closed from the WM: drop back to one screen rather
  // than streaming at a window that is not there.
  useEffect(() => {
    if (!audience) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ label: string }>(PRESENT_CLOSED, (e) => {
      if (e.payload.label === audience) setAudience(null);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [audience]);

  // Unmount (the tab closed, the deck reloaded) must not leave an orphaned
  // window on the projector. Read through a ref so this fires exactly once, at
  // teardown, instead of on every toggle.
  const audienceRef = useRef<string | null>(null);
  audienceRef.current = audience;
  useEffect(
    () => () => {
      if (audienceRef.current) {
        void invoke("close_presenter_window", { label: audienceRef.current }).catch(() => {});
      }
    },
    [],
  );

  // --- keys ----------------------------------------------------------------

  /** The overview grid's own cursor, so arrows browse it instead of the talk. */
  const [gridPick, setGridPick] = useState(0);
  useEffect(() => {
    if (grid && stop) setGridPick(stop.slide);
  }, [grid, stop?.slide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys this window owns alone: the overlays and the second display are
      // the speaker's, not the audience's.
      switch (e.key) {
        case "Enter":
          if (goto) {
            jumpToSlide(Number(goto) - 1);
            setGoto("");
            return;
          }
          // With the grid open, Enter is what *commits* the browsed slide — see
          // the movement branch below.
          if (grid) {
            e.preventDefault();
            jumpToSlide(gridPick);
            return;
          }
          return;
        case "g":
        case "G":
          setGrid((v) => !v);
          return;
        case "n":
        case "N":
          setNotesOpen((v) => !v);
          return;
        case "d":
        case "D":
          if (audience) closeAudience();
          else void openAudience();
          return;
        case "Escape":
          // Escape peels one layer at a time rather than dumping you out of the
          // talk from whatever overlay happens to be open — and the marker/laser
          // is one of those layers even though it is a different component's
          // state. Three window listeners see this one key (here, the overlay,
          // and `useKeyboard`), none of them stops propagation, and none can see
          // the others; so holstering the laser with nothing else open used to
          // END THE TALK (TODO V #98). Declining the key here leaves the disarm
          // to the overlay's own handler, which runs immediately after.
          if (isToolArmed()) return;
          if (grid) setGrid(false);
          else if (blank) setBlank(null);
          else closeAll();
          return;
        default:
          break;
      }

      // Everything else goes through the SAME mapping the audience window uses,
      // so whichever display has focus, a key means the same thing.
      const action = keyToAction(e.key);
      if (!action) {
        setGoto("");
        return;
      }
      if (action.kind === "digit") {
        setGoto((g) => (g + action.digit).slice(-4));
        return;
      }
      if (action.kind === "close") {
        closeAll();
        return;
      }
      if (action.kind === "blank") {
        setBlank((v) => (v === action.mode ? null : action.mode));
        return;
      }
      e.preventDefault();

      // The overview grid is a place to LOOK, not a place to navigate from. It
      // used to pass movement straight through, so the speaker hunting for slide
      // 23 advanced the live talk on the projector while browsing for it
      // (TODO V #102). Arrows move the grid's own cursor; Enter commits.
      if (grid) {
        const step =
          action.kind === "next"
            ? 1
            : action.kind === "prev"
              ? -1
              : action.kind === "slide"
                ? action.delta
                : 0;
        if (action.kind === "first") setGridPick(0);
        else if (action.kind === "last") setGridPick(Math.max(0, deck.slides.length - 1));
        else if (step)
          setGridPick((p) => Math.min(Math.max(0, p + step), Math.max(0, deck.slides.length - 1)));
        else if (action.kind === "goto") jumpToSlide(action.slide);
        return;
      }

      // A blanked screen swallows the first advance: the key that wakes the
      // screen should not also move the talk on.
      if (blank && (action.kind === "next" || action.kind === "prev")) {
        setBlank(null);
        return;
      }
      setIndex((i) => applyNav(stops, i, action));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    stops,
    blank,
    grid,
    gridPick,
    goto,
    deck.slides.length,
    jumpToSlide,
    closeAll,
    audience,
    openAudience,
    closeAudience,
  ]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const root = typeof document !== "undefined" ? document.getElementById("root") : null;
  if (!root || !stop) return null;

  const elapsed = Math.floor((banked + (paused ? 0 : now - started)) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const timerTone = paused
    ? "paused"
    : target > 0 && elapsed >= target * 60
      ? "over"
      : target > 0 && elapsed >= target * 60 * 0.9
        ? "near"
        : "ok";
  // The speaker's wall clock, in the app's clock (`lib/timeFormat`) rather than
  // the locale's — the presenter is glanced at, and a format that disagrees with
  // every other clock in the app is one more thing to parse mid-sentence.
  const wall = new Date(now).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: !use24h,
  });

  // The next DIFFERENT slide. On a slide with builds the next `kind: "slide"`
  // stop is the same slide's next build step, so the naive search showed the
  // speaker a preview of what the room was already looking at, under the wrong
  // number, exactly while stepping builds (TODO V #101). The arithmetic lives in
  // `present.ts` so it is testable rather than inline in this JSX.
  const nextIdx = nextSlideOf(stops, index);
  const nextSlideIndex = nextIdx >= 0 ? nextIdx : undefined;
  const nextSlide = nextSlideIndex !== undefined ? deck.slides[nextSlideIndex] : undefined;
  const box = slidePageBox(deck, slide);
  const nextBox = slidePageBox(deck, nextSlide);
  // Position in the TALK, not in the slide array: a skipped slide is not part of
  // the count the speaker is pacing against (#106).
  const talkSlides = deck.slides.filter((s) => !s.skip);
  const talkPos = stop ? talkSlides.findIndex((s) => s.id === deck.slides[stop.slide]?.id) + 1 : 0;
  // With the audience on its own screen this window IS the presenter view, so
  // the notes column stops being optional — hiding it would leave the speaker
  // looking at a second copy of what the room already sees.
  const showNotes = notesOpen || audience !== null;
  const builds = stop.kind === "slide" ? stop.step : 0;

  return createPortal(
    <div
      className={`deck-presenter${audience ? " is-dual" : ""}`}
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="deck-presenter-main">
        {/* PresentationOverlay needs a position:relative host; giving it the
            slide area (not the whole window) keeps marker strokes anchored to
            the slide rather than to the chrome around it. */}
        <div className="presentation-host deck-presenter-stage">
          {stop.kind === "interstitial" && slide?.after ? (
            <InterstitialView
              gif={gifs.get(gifKey(slide.after))}
              fit={slide.after.fit}
              background={slide.after.background}
              advance={slide.after.advance}
              onEnded={next}
              // This window owns the advance — the audience window mirrors. See
              // `InterstitialView`'s note on the double-step this closes.
              drivesAdvance
            />
          ) : (
            slide && (
              <PresentedSlide
                // Re-keying on the slide is what makes the entrance transition
                // replay: a CSS animation on a persistent element only runs once.
                key={slide.id}
                slide={slide}
                step={stop.kind === "slide" ? stop.step : 0}
                doc={doc}
                pageWidth={box.width}
                pageHeight={box.height}
                metrics={metrics}
                assets={assets}
                transition={transitionRef.current}
                footer={footerObject(deck, talkPos - 1, talkSlides.length, box.height)}
              />
            )
          )}
          <PresentationOverlay />
        </div>

        {/* Blanking is for the ROOM. In dual-window mode the speaker keeps their
            own view of the slide — blanking both is how you end up talking about
            a slide you can no longer see (TODO V #126's first half). */}
        {blank && !audience && <div className={`deck-presenter-blank is-${blank}`} />}

        {grid && (
          <div className="deck-presenter-grid" role="listbox" aria-label={t("deckPresenter.allSlidesAria")}>
            {deck.slides.map((s, i) => (
              <button
                key={s.id}
                className={
                  "deck-presenter-grid-cell" +
                  (i === stop.slide ? " active" : "") +
                  (i === gridPick ? " picked" : "") +
                  (s.skip ? " skipped" : "")
                }
                onClick={() => jumpToSlide(i)}
                onMouseEnter={() => setGridPick(i)}
              >
                {/* Real thumbnails, not numbered blanks: past ~15 slides a grid
                    of numbers is unusable as a jump target, which is the one job
                    it has (TODO V #126). `DeckRailThumb` in the editor already
                    renders exactly this, so the presenter renders the page the
                    same way rather than inventing a second path. */}
                <PresenterGridThumb doc={doc} page={s.anchor.page} />
                <span className="deck-presenter-grid-num">{i + 1}</span>
                {s.skip && (
                  <span className="deck-presenter-grid-skip" title={t("deckPresenter.skippedTitle")}>
                    ⤫
                  </span>
                )}
                {s.notes.trim() && <span className="deck-presenter-grid-note" title={s.notes} />}
              </button>
            ))}
          </div>
        )}

        {goto && (
          <div className="deck-presenter-goto">{t("deckPresenter.gotoSlide", { n: goto })}</div>
        )}
      </div>

      {showNotes && (
        <aside className="deck-presenter-notes" style={{ ["--deck-notes-size" as string]: `${notesSize}px` }}>
          <div className="deck-presenter-notes-head">
            <span>
              {t("deckPresenter.slideOfTotal", { pos: talkPos, total: talkSlides.length })}
              {stop.kind === "slide" && stop.step > 0 && ` · ${t("deckPresenter.buildSuffix", { n: builds })}`}
              {stop.kind === "interstitial" && ` · ${t("deckPresenter.animationSuffix")}`}
            </span>
            <span
              className={`deck-presenter-timer is-${timerTone}`}
              title={
                target > 0
                  ? t("deckPresenter.targetStartedTitle", {
                      target,
                      time: new Date(started).toLocaleTimeString(),
                    })
                  : t("deckPresenter.startedAtTitle", { time: new Date(started).toLocaleTimeString() })
              }
            >
              {mm}:{ss}
            </span>
            {/* A talk's clock has to be controllable: it used to run from mount
                with no pause and no reset, so a laptop suspend added the sleep to
                it and a rehearsal restarted meant restarting the presenter
                (TODO V #126). */}
            <span className="deck-presenter-timer-btns">
              <button
                onClick={() => setPaused((p) => !p)}
                title={paused ? t("deckPresenter.resumeTimerTitle") : t("deckPresenter.pauseTimerTitle")}
              >
                {paused ? <PlayIcon /> : <PauseIcon />}
              </button>
              <button onClick={resetTimer} title={t("deckPresenter.resetTimerTitle")}>
                ↺
              </button>
              <button
                onClick={() => setTarget((v) => (v + 5) % 65)}
                title={t("deckPresenter.targetDurationTitle")}
              >
                {target > 0 ? `${target}m` : <TimerIcon />}
              </button>
              <button
                onClick={() => setNotesSize((n) => (n >= 20 ? 11 : n + 2))}
                title={t("deckPresenter.notesTextSizeTitle")}
              >
                A
              </button>
            </span>
          </div>

          {audience && (
            <div className="deck-presenter-audience-note">
              {t("deckPresenter.audienceNotePre")} <kbd>D</kbd> {t("deckPresenter.audienceNotePost")}
            </div>
          )}
          {linkError && <ErrorNote className="deck-presenter-audience-note is-error" error={linkError} />}

          {/* The next slide, still: a preview that re-ran its build entrances
              every time the speaker stepped one on the CURRENT slide would be a
              flicker in the corner of their eye for the whole talk. */}
          {nextSlide && (
            <div className="deck-presenter-next-preview">
              <span className="deck-presenter-next-label">
                {t("deckPresenter.nextSlideLabel", { n: talkPos + 1 })}
              </span>
              <div className="deck-presenter-next-frame">
                <PresentedSlide
                  key={`next-${nextSlide.id}`}
                  slide={nextSlide}
                  step={Number.MAX_SAFE_INTEGER}
                  doc={doc}
                  pageWidth={nextBox.width}
                  pageHeight={nextBox.height}
                  metrics={metrics}
                  assets={assets}
                  transition="none"
                  still
                />
              </div>
            </div>
          )}

          <div className="deck-presenter-notes-body">
            {slide?.notes.trim() ? slide.notes : <em>{t("deckPresenter.noNotes")}</em>}
          </div>

          <div className="deck-presenter-next">
            {nextSlideIndex !== undefined ? (
              <>
                {t("deckPresenter.nextColonSlide", { n: talkPos + 1 })}
                {deck.slides[nextSlideIndex]?.after && ` ${t("deckPresenter.animationFollows")}`}
              </>
            ) : (
              t("deckPresenter.lastSlide")
            )}
            <span className="deck-presenter-wall">{wall}</span>
          </div>
        </aside>
      )}

      <div className="deck-presenter-bar">
        <button onClick={prev} title={t("deckPresenter.previousTitle")} aria-label={t("deckPresenter.previousAria")}>
          ‹
        </button>
        <span className="deck-presenter-pos">
          {talkPos} / {talkSlides.length}
        </span>
        <button onClick={next} title={t("deckPresenter.nextTitle")} aria-label={t("deckPresenter.nextAria")}>
          ›
        </button>
        <button
          className={notesOpen ? "active" : ""}
          onClick={() => setNotesOpen((v) => !v)}
          title={t("deckPresenter.speakerNotesTitle")}
        >
          ☰
        </button>
        <button
          className={grid ? "active" : ""}
          onClick={() => setGrid((v) => !v)}
          title={t("deckPresenter.overviewTitle")}
        >
          ⊞
        </button>
        <button
          className={audience ? "active" : ""}
          onClick={() => (audience ? closeAudience() : void openAudience())}
          title={t("deckPresenter.audienceViewTitle")}
          aria-label={t("deckPresenter.secondDisplayAria")}
        >
          ⧉
        </button>
        <button onClick={closeAll} title={t("deckPresenter.exitTitle")} aria-label={t("deckPresenter.exitAria")}>
          ✕
        </button>
      </div>
    </div>,
    root,
  );
}

export { disposeGif };
