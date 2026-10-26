import { useCallback, useEffect, useRef, useState } from "react";
import { useTabsStore } from "../../../stores/tabs";
import { type InternalViewer } from "../../../lib/viewers/fileUtils";
import { IS_MAC } from "../../../lib/platform";
import { useChordHint } from "../../../lib/shortcuts/shortcutHint";
import { useT } from "../../../lib/i18n";
import { seedViewerState } from "./viewerState";
import { useViewerPref } from "./editorPrefs";

// Code-editor font sizing. The default matches the .file-viewer-code CSS metrics
// (12px / 18px); the line-height tracks the font at a fixed 1.5 ratio so the
// gutter and overlay layers stay aligned at any size.
export const EDITOR_FONT_DEFAULT = 12;
export const EDITOR_FONT_MIN = 8;
export const EDITOR_FONT_MAX = 32;
const EDITOR_LINE_RATIO = 1.5;
export const clampFontSize = (n: number) =>
  Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(n)));

/** Shared Ctrl/Cmd+wheel handler for the text viewers (code + markdown): scroll
 *  up grows, down shrinks the font, mirroring the browser zoom gesture and the
 *  Ctrl +/− keyboard shortcuts. A plain wheel (no modifier) falls through to
 *  native scrolling. Typed structurally so both native and synthetic wheel
 *  events satisfy it. */
export function onCtrlWheelFont(
  e: Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaY"> & {
    preventDefault(): void;
  },
  inc?: () => void,
  dec?: () => void,
) {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  if (e.deltaY < 0) inc?.();
  else if (e.deltaY > 0) dec?.();
}

/** Bind `handler` as a NON-passive `wheel` listener through the returned callback
 *  ref. React registers its synthetic `onWheel` passively at the document root,
 *  so `preventDefault()` inside a React `onWheel` is ignored: a Ctrl+wheel zoom
 *  can't stop the element from scrolling, so it scrolls to its limit and only
 *  then does the zoom visibly "take". Attaching the listener ourselves with
 *  `{ passive: false }` lets `preventDefault()` cancel the scroll, so Ctrl+wheel
 *  zooms immediately and never scrolls. The callback ref re-binds cleanly across
 *  mount/unmount (e.g. conditionally-rendered viewports). */
export function useNonPassiveWheel(handler: (e: WheelEvent) => void) {
  const cb = useRef(handler);
  cb.current = handler;
  const detach = useRef<(() => void) | null>(null);
  return useCallback((el: HTMLElement | null) => {
    detach.current?.();
    detach.current = null;
    if (el) {
      const listener = (e: WheelEvent) => cb.current(e);
      el.addEventListener("wheel", listener, { passive: false });
      detach.current = () => el.removeEventListener("wheel", listener);
    }
  }, []);
}

/** A Ctrl/⌘-held tracker shared by every viewer, with imperative subscribers.
 *
 *  Deliberately NOT React state: `useZoomModifierWheel` is used by the code
 *  editor and the markdown/text viewers, so a `setState` per modifier press
 *  would re-render those (very large) panes on every Ctrl+S, Ctrl+F, Ctrl+Z and
 *  Ctrl+C — a re-render to answer a question nothing renders. The window
 *  listeners are keyboard-only and bind once for the app's lifetime; they cost
 *  nothing on the scroll path, which is the whole point of the exercise. */
const zoomModSubs = new Set<(held: boolean) => void>();
let zoomModHeld = false;
let zoomModBound = false;

function setZoomModHeld(next: boolean) {
  if (next === zoomModHeld) return;
  zoomModHeld = next;
  for (const fn of zoomModSubs) fn(next);
}

function subscribeZoomMod(fn: (held: boolean) => void): () => void {
  zoomModSubs.add(fn);
  if (!zoomModBound) {
    zoomModBound = true;
    const sync = (e: KeyboardEvent) => setZoomModHeld(e.ctrlKey || e.metaKey);
    window.addEventListener("keydown", sync, true);
    window.addEventListener("keyup", sync, true);
    // A modifier released while another window holds focus never delivers its
    // keyup here, so without this the wheel listener would stay bound for good
    // — exactly the state this hook exists to avoid.
    window.addEventListener("blur", () => setZoomModHeld(false));
  }
  return () => {
    zoomModSubs.delete(fn);
  };
}

/** macOS trackpad pinch arrives as a `ctrlKey` wheel event with no preceding
 *  keydown, so there is no modifier press to gate on there and the listener has
 *  to stay bound. Not preventing it would let the pinch zoom the whole webview
 *  instead of the viewer's font. */
const WHEEL_ALWAYS_BOUND = IS_MAC;

/** {@link useNonPassiveWheel} for a handler that only ever acts on Ctrl/⌘+wheel
 *  (the font-zoom viewers), binding the listener ONLY while such a modifier is
 *  actually held.
 *
 *  A `{ passive: false }` wheel listener tells the engine the default action may
 *  be cancelled, so every wheel tick has to round-trip through the main thread
 *  before the element is allowed to scroll at all — the scroll can never outrun
 *  whatever else the main thread is doing (a terminal painting in another pane,
 *  a React commit), which reads as stuttering and stalling. Under WebKitGTK,
 *  where compositing is already software (DMABUF is off), that hop is the
 *  difference between a scroll the compositor can serve and one it cannot.
 *
 *  The gesture we need it for is keyboard-modified, so the binding can follow
 *  the modifier instead of being permanent: plain scrolling leaves the scroller
 *  with no wheel handler at all, and Ctrl+wheel still gets its
 *  `preventDefault()` because the keydown lands before the wheel tick. */
export function useZoomModifierWheel(handler: (e: WheelEvent) => void) {
  const cb = useRef(handler);
  cb.current = handler;
  const elRef = useRef<HTMLElement | null>(null);
  const detach = useRef<(() => void) | null>(null);

  const unbind = useCallback(() => {
    detach.current?.();
    detach.current = null;
  }, []);
  const bind = useCallback(() => {
    const el = elRef.current;
    if (!el || detach.current) return;
    const listener = (e: WheelEvent) => cb.current(e);
    el.addEventListener("wheel", listener, { passive: false });
    detach.current = () => el.removeEventListener("wheel", listener);
  }, []);

  useEffect(() => {
    const unsub = subscribeZoomMod((held) => {
      // Releasing the modifier must NOT unbind where the binding is permanent
      // (macOS), or the first pinch after any Ctrl press would zoom the webview.
      if (held) bind();
      else if (!WHEEL_ALWAYS_BOUND) unbind();
    });
    return () => {
      unsub();
      unbind();
    };
  }, [bind, unbind]);

  return useCallback(
    (el: HTMLElement | null) => {
      unbind();
      elRef.current = el;
      // Mounting mid-gesture (a pane revealed while Ctrl is already down) still
      // has to arrive bound — the keydown that would have bound it is past.
      if (el && (WHEEL_ALWAYS_BOUND || zoomModHeld)) bind();
    },
    [bind, unbind],
  );
}

/**
 * Per-TAB editor font size (text-size +/− control, #48). The zoom is tab-local:
 * changing it resizes only this viewer tab, not every other tab of the same
 * type. The size is seeded once from the tab's persisted `viewerState.fontSize`
 * and written back there (like scroll/zoom), so it survives reopening the file
 * and a Tabtivity restart. Until the user zooms this tab it tracks the per-type
 * `viewer_prefs[type].font_size` default reactively; once zoomed, the tab pins
 * its own size. `reset` clears the override, dropping back to that default.
 */
export function useEditorFontSize(tabKey: string | undefined, type: InternalViewer) {
  const pref = useViewerPref(type);
  const typeDefault = clampFontSize(pref?.font_size ?? EDITOR_FONT_DEFAULT);

  // Tab-local override, seeded once from the persisted viewerState. `undefined`
  // means "no override yet" → fall through to the per-type default above.
  const [override, setOverride] = useState<number | undefined>(
    () => seedViewerState(tabKey)?.fontSize,
  );
  const fontSize = clampFontSize(override ?? typeDefault);

  const persist = useCallback(
    (size: number | undefined) => {
      setOverride(size);
      if (tabKey) useTabsStore.getState().setViewerState(tabKey, { fontSize: size });
    },
    [tabKey],
  );
  const setFontSize = useCallback(
    (next: number) => persist(clampFontSize(next)),
    [persist],
  );

  return {
    fontSize,
    lineHeight: Math.round(fontSize * EDITOR_LINE_RATIO),
    // True once this tab has set its own size — lets surfaces with their own
    // default (the markdown preview) leave it alone until then.
    isCustom: override != null,
    inc: useCallback(() => setFontSize(fontSize + 1), [setFontSize, fontSize]),
    dec: useCallback(() => setFontSize(fontSize - 1), [setFontSize, fontSize]),
    // Clear the tab override so it falls back to the per-type default.
    reset: useCallback(() => persist(undefined), [persist]),
  };
}

/** A−/A+ text-size control for the code editors, mirroring the image/PDF zoom
 *  group. Reuses the `.file-viewer-zoom-btn` styling. */
export function FontSizeControls({
  fontSize,
  inc,
  dec,
  reset,
}: {
  fontSize: number;
  inc: () => void;
  dec: () => void;
  reset: () => void;
}) {
  const t = useT();
  const chordHint = useChordHint();
  return (
    <div className="file-viewer-zoom file-viewer-fontsize" role="group" aria-label={t("fileViewer.textSizeGroup")}>
      <button
        className="file-viewer-zoom-btn"
        onClick={dec}
        disabled={fontSize <= EDITOR_FONT_MIN}
        title={chordHint(t("fileViewer.decreaseTextSize"), "zoomOut")}
        aria-label={t("fileViewer.decreaseTextSizeLabel")}
      >
        A−
      </button>
      <button
        className="file-viewer-zoom-level file-viewer-fontsize-level"
        onClick={reset}
        title={chordHint(t("fileViewer.resetTextSize"), "zoomReset")}
        aria-label={t("fileViewer.resetTextSizeLabel")}
      >
        {fontSize}
      </button>
      <button
        className="file-viewer-zoom-btn"
        onClick={inc}
        disabled={fontSize >= EDITOR_FONT_MAX}
        title={chordHint(t("fileViewer.increaseTextSize"), "zoomIn")}
        aria-label={t("fileViewer.increaseTextSizeLabel")}
      >
        A+
      </button>
    </div>
  );
}
