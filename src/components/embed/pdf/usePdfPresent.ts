/** The PDF viewer's two ways to present: the fullscreen present window, and `Open as
 *  deck` (an editable deck sidecar beside the PDF, experimental). */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../../hooks/useTauriListener";
import { writeFileBytes, fileMtime, describeFileErrorKey } from "../../../lib/files/fileAccess";
import { useExperimental } from "../../../lib/experimental";
import { emptyDeck } from "../../../lib/viewers/deck/model";
import { deckPathForPdf, serializeDeck } from "../../../lib/viewers/deck/sidecar";
import {
  type PdfPresentReady,
  type PdfPresentSeed,
  PDF_PRESENT_READY,
  pdfPresentLabel,
  pdfPresentSeedEvent,
  readPresentScreen,
} from "../../../lib/viewers/pdfPresent";
import { basename, dirname } from "../../../lib/paths";
import { useT } from "../../../lib/i18n";

/**
 * Present opens the file AS SAVED in a window of its own and seeds it with the sheet in
 * view; Open as deck creates the sidecar if there is none and opens it.
 */
export function usePdfPresent({
  path,
  scope,
  tabKey,
  visiblePage,
  setError,
}: {
  path: string;
  scope: string | null;
  tabKey?: string;
  /** The sheet in view, where Present starts. */
  visiblePage: number;
  setError: (msg: string | null) => void;
}) {
  const t = useT();
  // "Present": turn this PDF into a deck — a sidecar of editable layers beside
  // it, plus the fullscreen presenter. Experimental, so the button is absent
  // unless the flag is on. Creating the sidecar is deliberately non-destructive:
  // the PDF is untouched, and an existing deck is opened rather than replaced.
  const deckEnabled = useExperimental("deck_presenter");
  const [makingDeck, setMakingDeck] = useState(false);
  const openAsDeck = useCallback(async () => {
    setMakingDeck(true);
    try {
      const deckPath = deckPathForPdf(path);
      // "Is there a deck?" by stat, not by reading it: a read also fails for a
      // deck that is not UTF-8 text or is over the text cap, and that deck must
      // be opened (and shown broken), never written over with an empty one.
      const exists = await fileMtime(deckPath, scope).then(
        () => true,
        () => false,
      );
      if (!exists) {
        const deck = emptyDeck(basename(path));
        await writeFileBytes(
          deckPath,
          new TextEncoder().encode(serializeDeck(deck)),
          scope,
        );
      }
      // Imported lazily: `FileViewerPane` already imports this module, so a
      // static import would close a cycle. The call happens in a callback, long
      // after both modules have initialised, so deferring it costs nothing and
      // keeps the dependency one-way on paper — the same reason
      // `openProjectFilesTab` lives beside its tab rather than in the view.
      const { openLinkedFile } = await import("../fileViewer/openLinked");
      openLinkedFile(tabKey, dirname(path) || "/", {
        path: deckPath,
        viewer: "eldeck",
        label: basename(deckPath),
      });
    } catch (e) {
      setError(t(describeFileErrorKey(e)));
    } finally {
      setMakingDeck(false);
    }
  }, [path, scope, tabKey, t, setError]);

  // ── Presenting this PDF fullscreen (`present.ts`) ────────────────────────
  //
  // A window of its own showing the sheet and nothing else — the toolbar, the
  // tab bar and the desktop all gone. It opens the file itself from `path`, so
  // what it shows is the file AS SAVED: an unsaved page arrangement stays in this
  // tab, which the button's tooltip says while there is one.
  const presentLabel = useMemo(() => pdfPresentLabel(path), [path]);
  /** This tab has opened the present window (and so answers its seed requests).
   *  Not proof it is still on screen — the reader may have closed it with Esc —
   *  which costs nothing: an emit at a label with no listener is a no-op. */
  const [presentOpen, setPresentOpen] = useState(false);
  const seedPresent = useCallback(() => {
    const payload: PdfPresentSeed = {
      path,
      scope,
      // Where the reader is now, so Present picks up the sheet on screen — and so
      // pressing it again with the window already open moves it here rather than
      // doing nothing visible.
      page: visiblePage,
    };
    void emit(pdfPresentSeedEvent(presentLabel), payload);
  }, [presentLabel, path, scope, visiblePage]);
  // Read by the subscription below through a ref: `listen()` is async, so
  // re-subscribing drops any request that lands during the round trip — and this
  // one would otherwise re-subscribe on every scroll that changes the sheet
  // number, which is the trap `DeckPresenter` documents.
  const seedPresentRef = useRef(seedPresent);
  seedPresentRef.current = seedPresent;
  const openPresentWindow = useCallback(() => {
    void (async () => {
      try {
        // `fullscreen: true` is what makes this different from the deck's
        // audience window: that one only takes over a SECOND monitor and stays
        // windowed on a single-monitor machine, which is the right default for a
        // talk with a notes view but not for "show me this PDF fullscreen".
        // Opening is idempotent by label, so a second press re-focuses the window
        // already up and the seed below moves it to this sheet. `monitor` is the
        // screen the reader last moved the present window to, if any.
        await invoke("open_presenter_window", {
          label: presentLabel,
          fullscreen: true,
          monitor: readPresentScreen(),
        });
        setPresentOpen(true);
        seedPresent();
      } catch (e) {
        setError(t(describeFileErrorKey(e)));
      }
    })();
  }, [presentLabel, seedPresent, t, setError]);

  // The present window asks until it is answered (it and this listener race on
  // open). Subscribed only once this tab has opened one: a listener per PDF tab
  // for a window nobody asked for is a subscription that never pays for itself.
  useEffect(() => {
    if (!presentOpen) return;
    return subscribeTauri(() =>
      listen<PdfPresentReady>(PDF_PRESENT_READY, (e) => {
        if (e.payload.label === presentLabel) seedPresentRef.current();
      }),
    );
  }, [presentOpen, presentLabel]);

  return { deckEnabled, makingDeck, openAsDeck, openPresentWindow };
}
