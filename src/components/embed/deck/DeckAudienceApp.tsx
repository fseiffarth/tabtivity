/**
 * The **audience** window of the dual-window presenter: the OS window that goes
 * on the projector while the speaker keeps the notes/timer view on the laptop.
 *
 * It is deliberately the *dumb* half. It owns no navigation state — the stop and
 * the blank screen arrive from the presenter window and are rendered as given —
 * because two indices for one talk is exactly how the two displays end up a
 * slide apart in front of a room. Keys pressed here (the speaker may well have
 * focus on this window, or be using a clicker bound to it) are forwarded as
 * *requests* and come back as state.
 *
 * It loads its own heavy assets — base PDF, images, GIF frames — from the deck's
 * path over the ordinary confined file commands, so nothing large ever crosses
 * as an event payload. The deck itself does arrive as its serialized sidecar,
 * because the presenter window may hold edits not yet autosaved.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { availableMonitors, getCurrentWindow } from "@tauri-apps/api/window";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  useSettingsStore,
} from "../../../stores/settings";
import { osFullscreenChord } from "../../../lib/shortcuts/shortcutHint";
import {
  type NavAction,
  type PresentSeed,
  type PresentState,
  PRESENT_CLOSED,
  PRESENT_NAV,
  PRESENT_READY,
  keyToAction,
  presentSeedEvent,
  presentStateEvent,
  withFrom,
} from "../../../lib/viewers/deck/present";
import {
  type Deck,
  type Slide,
  type Stop,
  footerObject,
  sequence,
  slidePageBox,
} from "../../../lib/viewers/deck/model";
import { parseDeck, pdfPathForDeck } from "../../../lib/viewers/deck/sidecar";
import { type TextMetrics, loadMetrics } from "../../../lib/viewers/deck/fonts";
import { loadBase } from "./deckBase";
import { useDeckFonts } from "./deckFonts";
import { dirOf, gifKey, interstitialsOf, resolveRel, useDeckGifs, useDeckImages } from "./deckAssets";
import { InterstitialView, PresentedSlide } from "./DeckSlideView";
import { useT } from "../../../lib/i18n";
import { subscribeTauri, useTauriListener } from "../../../hooks/useTauriListener";
import { useCrossWindowAppearance } from "../../../hooks/useCrossWindowAppearance";

/** How often to re-announce readiness until a seed lands. The presenter window
 *  may still be mounting its listener when this window first asks. */
const READY_RETRY_MS = 400;

export interface DeckAudienceAppProps {
  /** This window's Tauri label, from `?present=` — the seed/state channels' namespace. */
  label: string;
}

export function DeckAudienceApp({ label }: DeckAudienceAppProps) {
  const t = useT();
  const loadSettings = useSettingsStore((s) => s.load);

  const [seed, setSeed] = useState<PresentSeed | null>(null);
  const [state, setState] = useState<PresentState>({ index: 0, blank: null });
  /** The live stop, for the key handler — which must stamp requests with where
   *  it was when it asked without re-subscribing on every advance of the talk. */
  const stateRef = useRef(state);
  stateRef.current = state;
  const [deck, setDeck] = useState<Deck | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [metrics, setMetrics] = useState<TextMetrics | null>(null);

  // Theme: this window is its own JS runtime with its own settings store, so it
  // loads them itself and follows the main window's live theme broadcast — the
  // same bargain `DetachedApp` strikes. Zoom is deliberately NOT applied: a
  // projector surface is sized by the slide, not by the editor's zoom.
  useEffect(() => {
    void loadSettings({ skipZoom: true });
  }, [loadSettings]);

  useCrossWindowAppearance();

  useEffect(() => {
    let live = true;
    void loadMetrics().then((m) => {
      if (live) setMetrics(m);
    });
    return () => {
      live = false;
    };
  }, []);

  // --- the link ------------------------------------------------------------

  const seededRef = useRef(false);

  useEffect(() => {
    const unlistenSeed = subscribeTauri(() =>
      listen<PresentSeed>(presentSeedEvent(label), (e) => {
        seededRef.current = true;
        setSeed(e.payload);
        setState({ index: e.payload.index, blank: e.payload.blank });
      }),
    );
    const unlistenState = subscribeTauri(() =>
      listen<PresentState>(presentStateEvent(label), (e) => setState(e.payload)),
    );

    // Ask, and keep asking until answered: this window and the presenter's
    // listener race on open, and a dropped first request would leave a black
    // projector with no way back.
    void emit(PRESENT_READY, { label });
    const retryTimer = setInterval(() => {
      if (seededRef.current) return;
      void emit(PRESENT_READY, { label });
    }, READY_RETRY_MS);

    return () => {
      clearInterval(retryTimer);
      unlistenSeed();
      unlistenState();
    };
  }, [label]);

  // Tell the presenter window when this one is closed from the WM, so it drops
  // back to the single-display presenter instead of streaming at a dead window.
  // (A close driven from the presenter side `destroy()`s, which bypasses this —
  // it already knows.)
  //
  // The handler is `async` and the emit is **awaited**: Tauri awaits the handler
  // and then destroys the window, so a fire-and-forget emit is one scheduling
  // decision away from being dropped by the teardown it is racing. Losing it
  // leaves the presenter holding `audience`, streaming state at a dead label and
  // reporting a second display that is gone (TODO V #122).
  useTauriListener(
    () =>
      getCurrentWindow().onCloseRequested(async () => {
        await emit(PRESENT_CLOSED, { label });
      }),
    [label],
  );

  // --- this window's own exits ---------------------------------------------
  //
  // Until now the audience window had none. `Escape` only *forwarded* a close
  // request, so if the main webview died — this repo has a documented WebKitGTK
  // renderer-crash history — the projector kept a fullscreen slide with no key
  // that dismissed it, no titlebar (fullscreen) and no pointer (`cursor: none`).
  // And when a display is unplugged the WM relocates the still-fullscreen window
  // over the speaker's own notes, where the only key that reacted was the one
  // that ended the whole talk (TODO V #103).

  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    void win.isFullscreen().then(setFullscreen).catch(() => {});
    // A monitor unplug moves this window; if it lands on the same monitor as the
    // main window, being fullscreen there is actively in the way. Drop out of it
    // and let the speaker deal with an ordinary window.
    return subscribeTauri(() =>
      win.onResized(() => {
        void (async () => {
          try {
            const fs = await win.isFullscreen();
            setFullscreen(fs);
            if (!fs) return;
            const monitors = await availableMonitors();
            if (monitors.length > 1) return;
            await win.setFullscreen(false);
            setFullscreen(false);
          } catch {
            // Nothing to do: the window is where the WM put it either way.
          }
        })();
      }),
    );
  }, []);

  const send = useCallback(
    (action: NavAction) => {
      void emit(PRESENT_NAV, { label, action });
    },
    [label],
  );

  // --- deck + base plate ---------------------------------------------------

  useEffect(() => {
    if (!seed) return;
    const parsed = parseDeck(seed.deck);
    if (parsed.error) return;
    setDeck(parsed.deck);
  }, [seed]);

  useEffect(() => {
    if (!seed || !deck) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    const dir = dirOf(seed.path);
    const basePath = resolveRel(dir, deck.base ?? pdfPathForDeck(seed.path));
    void (async () => {
      try {
        const base = await loadBase(basePath, seed.scope);
        opened = base.doc;
      } catch {
        // No plate: the layers still present. The presenter window shows the
        // same deck and reports the problem there; a talk in progress should
        // not gain an error banner on the projector.
        return;
      }
      if (cancelled) {
        opened.loadingTask.destroy();
        return;
      }
      setDoc(opened);
    })();
    return () => {
      cancelled = true;
      opened?.loadingTask.destroy();
      setDoc(null);
    };
    // Re-anchoring is the presenter window's job; this one only needs the pages.
    // Keyed on the resolved base path so a re-seed with the same plate does not
    // tear down and re-open the document mid-talk.
  }, [seed?.path, seed?.scope, deck?.base]);

  const interstitials = useMemo(() => interstitialsOf(deck), [deck]);
  const { assets } = useDeckImages(deck, seed?.path ?? "", seed?.scope ?? null);
  const { gifs } = useDeckGifs(interstitials, seed?.path ?? "", seed?.scope ?? null);
  // This window is its own webview with its own `document`, so it installs its
  // own `@font-face` rules and registers its own metrics rather than being handed
  // the editor's — the same reason `deckAssets` exists (#120).
  useDeckFonts(deck, seed?.path ?? "", seed?.scope ?? null, metrics);

  // --- keys ----------------------------------------------------------------

  const gotoRef = useRef("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys this window answers ITSELF, before the shared map gets a look.
      // Escape here closes *this* window, not the talk: the previous behaviour
      // (forward a close, end everywhere) meant the only key the projector
      // reacted to was the one that could not be taken back. "End everywhere"
      // moves to Shift+Escape / Q, which is deliberate rather than reachable.
      if (e.key === "Escape" && !e.shiftKey) {
        e.preventDefault();
        void (async () => {
          await emit(PRESENT_CLOSED, { label });
          await getCurrentWindow().destroy();
        })();
        return;
      }
      if ((e.key === "Escape" && e.shiftKey) || e.key === "q" || e.key === "Q") {
        e.preventDefault();
        send({ kind: "close" });
        return;
      }
      // F11 (the app's fullscreen chord, as bound) toggles this window's own
      // fullscreen — the escape hatch for a display that was unplugged, or one
      // the WM put fullscreen on the wrong screen. The window capability is
      // already granted.
      if (osFullscreenChord(e)) {
        e.preventDefault();
        void (async () => {
          const win = getCurrentWindow();
          const fs = await win.isFullscreen().catch(() => false);
          await win.setFullscreen(!fs).catch(() => {});
          setFullscreen(!fs);
        })();
        return;
      }
      if (e.key === "Enter") {
        if (gotoRef.current) {
          send({ kind: "goto", slide: Number(gotoRef.current) - 1 });
          gotoRef.current = "";
        }
        return;
      }
      const action = keyToAction(e.key);
      if (!action) {
        gotoRef.current = "";
        return;
      }
      if (action.kind === "digit") {
        gotoRef.current = (gotoRef.current + action.digit).slice(-4);
        return;
      }
      e.preventDefault();
      // Stamp the stop this request was made from, so a key pressed here that
      // races the same key pressed on the presenter moves the talk once rather
      // than twice — see `NavAction`.
      send(withFrom(action, stateRef.current.index));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send, label]);

  // --- render --------------------------------------------------------------

  const stops = useMemo(() => (deck ? sequence(deck) : []), [deck]);
  const stop: Stop | undefined = stops[state.index];
  const slide: Slide | undefined = stop ? deck?.slides[stop.slide] : undefined;

  // The transition belongs to the slide being LEFT, and must be known during the
  // render that first shows the new one — a state write would land a frame late,
  // which is one frame of un-transitioned slide.
  const prevSlideRef = useRef<number | null>(null);
  const transitionRef = useRef<string>("none");
  if (deck && stop && prevSlideRef.current !== stop.slide) {
    const from = prevSlideRef.current;
    transitionRef.current =
      from != null && deck.slides[from] ? deck.slides[from].transition : "none";
    prevSlideRef.current = stop.slide;
  }

  // `cursor: none` is scoped to fullscreen. An arrow parked in the middle of a
  // projected slide is the most-noticed artefact of presenting from a laptop —
  // but a *windowed* audience window (one monitor, or one the speaker dropped
  // out of fullscreen after an unplug) needs a pointer to be draggable at all
  // (TODO V #103).
  const shellClass = `deck-presenter deck-audience${fullscreen ? " is-fullscreen" : ""}`;

  if (!deck || !stop) {
    return (
      <div className={shellClass}>
        <div className="deck-presenter-main">
          <div className="deck-presenter-fit deck-presenter-loading">
            {t("deckAudienceApp.waitingForPresentation")}
          </div>
        </div>
      </div>
    );
  }

  const box = slidePageBox(deck, slide);
  const talkSlides = deck.slides.filter((s) => !s.skip);
  const talkPos = talkSlides.findIndex((s) => s.id === deck.slides[stop.slide]?.id);

  return (
    <div className={shellClass}>
      <div className="deck-presenter-main">
        <div className="presentation-host deck-presenter-stage">
          {stop.kind === "interstitial" && slide?.after ? (
            <InterstitialView
              gif={gifs.get(gifKey(slide.after))}
              fit={slide.after.fit}
              background={slide.after.background}
              advance={slide.after.advance}
              // This window MIRRORS: the presenter window owns the advance. Both
              // used to fire on their own clip end, and the deck skipped the
              // slide after every auto-advancing GIF (TODO V #95).
              drivesAdvance={false}
              onEnded={() => {}}
            />
          ) : (
            slide && (
              <PresentedSlide
                key={slide.id}
                slide={slide}
                step={stop.kind === "slide" ? stop.step : 0}
                doc={doc}
                pageWidth={box.width}
                pageHeight={box.height}
                metrics={metrics}
                assets={assets}
                transition={transitionRef.current}
                footer={footerObject(deck, talkPos, talkSlides.length, box.height)}
              />
            )
          )}
        </div>
        {state.blank && <div className={`deck-presenter-blank is-${state.blank}`} />}
      </div>
    </div>
  );
}
