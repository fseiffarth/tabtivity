import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { useTauriListener } from "../../hooks/useTauriListener";
import { useT } from "../../lib/i18n";
import { chordMatches, resolveChord, type ShortcutMap } from "../../lib/shortcuts/shortcuts";
import {
  curtainKeyVerdict,
  PRESENTING_CHANGED,
  PRIVACY_CURTAIN_RAISE,
  usePrivacyCurtainStore,
  type CurtainMode,
  type PresentingState,
} from "../../lib/window/privacyCurtain";
import {
  pdfPresentLabel,
  readLastPresent,
  readPresentScreen,
  takePresentResume,
  writeLastPresent,
} from "../../lib/viewers/pdfPresent";
import { useSettingsStore } from "../../stores/settings";
import { usePresentationStore } from "../../stores/viewers/presentation";
import { UntestedTag } from "../common/UntestedTag";

/**
 * The privacy curtain of one app window (`lib/window/privacyCurtain`), mounted
 * by `AppShell` and `DetachedApp`, never by a presentation window.
 *
 * `cover`: an opaque panel over the whole window, everything under it
 * `visibility: hidden` so it stops painting. `keep`: a deck presenter in this
 * window already covers it opaquely and stays the speaker's view; it is lifted
 * above every other layer and the curtain is a corner chip. Both modes are CSS
 * on `<html data-privacy-curtain>` (`shell.css`).
 *
 * Once a PDF's present window has closed, `cover` also offers the way back to
 * it: on the sheet it was left on, on its remembered screen, curtain still up.
 */
export function PrivacyCurtain() {
  const t = useT();
  const up = usePrivacyCurtainStore((s) => s.up);
  const lift = usePrivacyCurtainStore((s) => s.lift);
  const pdfClosed = usePrivacyCurtainStore((s) => !s.presenting && s.presented === "pdf");
  const mode: CurtainMode = usePresentationStore((s) => s.presenting) > 0 ? "keep" : "cover";
  const curtainRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useTauriListener(
    () =>
      listen<PresentingState>(PRESENTING_CHANGED, (ev) =>
        usePrivacyCurtainStore.getState().applyPresenting(ev.payload),
      ),
    [],
  );
  useTauriListener(
    () => listen(PRIVACY_CURTAIN_RAISE, () => usePrivacyCurtainStore.getState().raise()),
    [],
  );

  // A window that mounts mid-talk (a popout opened while presenting, a
  // reloaded renderer) starts curtained.
  useEffect(() => {
    let cancelled = false;
    invoke<PresentingState>("presenting_state")
      .then((state) => {
        if (!cancelled && state) usePrivacyCurtainStore.getState().applyPresenting(state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // The shortcut, and the key filter while the curtain is up. Window CAPTURE,
  // registered at mount, so it runs ahead of the shell's and a terminal's own
  // listeners.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const overrides = useSettingsStore.getState().settings?.keyboard_shortcuts as
        | ShortcutMap
        | undefined;
      const store = usePrivacyCurtainStore.getState();
      if (chordMatches(resolveChord("privacyCurtain", overrides), e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        // Raising reaches every window; lifting is this window's own.
        if (store.up) store.lift();
        else void emit(PRIVACY_CURTAIN_RAISE).catch(() => store.raise());
        return;
      }
      if (!store.up) return;
      const onCurtain = e.target instanceof Node && !!curtainRef.current?.contains(e.target);
      if (curtainKeyVerdict(e, modeRef.current, onCurtain) === "drop") {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (!up) {
      delete root.dataset.privacyCurtain;
      return;
    }
    root.dataset.privacyCurtain = mode;
    // Keys must land somewhere visible: the Show button, or the presenter.
    if (mode === "keep") document.querySelector<HTMLElement>("[data-curtain-keep]")?.focus();
    else showRef.current?.focus();
    return () => {
      delete root.dataset.privacyCurtain;
    };
  }, [up, mode]);

  if (!up) return null;
  const show = (
    <button type="button" ref={showRef} className="privacy-curtain-show" onClick={lift}>
      {t("privacyCurtain.show")}
    </button>
  );
  const last = pdfClosed ? readLastPresent() : null;
  const backToFullscreen = () => {
    if (!last) return;
    const label = pdfPresentLabel(last.path);
    writeLastPresent({ ...last, resume: true });
    // Gone until the new window's own `presenting-changed`, so a second click
    // cannot leave a resume behind for a later Present to trip over.
    usePrivacyCurtainStore.setState({ presented: null });
    invoke("open_presenter_window", {
      label,
      fullscreen: true,
      monitor: readPresentScreen(),
    }).catch(() => {
      takePresentResume(label);
      usePrivacyCurtainStore.setState({ presented: "pdf" });
    });
  };
  return createPortal(
    mode === "keep" ? (
      <div className="privacy-curtain is-corner" ref={curtainRef} role="status">
        <span>{t("privacyCurtain.title")}</span>
        {show}
      </div>
    ) : (
      <div
        className="privacy-curtain"
        ref={curtainRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="privacy-curtain-title"
      >
        <div className="privacy-curtain-card">
          <h2 id="privacy-curtain-title">
            {t("privacyCurtain.title")} <UntestedTag id="privacyCurtain.title" />
          </h2>
          <p>{t("privacyCurtain.body")}</p>
          {show}
          {last && (
            <button type="button" className="privacy-curtain-show" onClick={backToFullscreen}>
              {t("privacyCurtain.backToFullscreen")}{" "}
              <UntestedTag id="privacyCurtain.backToFullscreen" />
            </button>
          )}
        </div>
      </div>
    ),
    document.body,
  );
}
