/**
 * The framed page's side of the clickjacking guard (`frameGuard.ts`): while
 * the guard is not clear, the body is inert and guarded events are dropped;
 * a browser that cannot report visibility, or a guard stuck for a while, gets
 * a card instead, with this desktop on its own and the way back to the
 * picker. The card lives outside `<body>` (a child of `<html>`), so the inert
 * body does not take its buttons with it — a tricked tap on either is harmless.
 */
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { postToShell, shellOrigin } from "./frameBridge";
import { blockInput, startFrameGuard, visibilitySupported, type FrameGuardState } from "./frameGuard";

/** How long input may stay off before the card says why. */
export const EXPLAIN_AFTER_MS = 3_000;

export function FrameGuard() {
  const t = useT();
  const [state, setState] = useState<FrameGuardState>(() => visibilitySupported() ? "covered" : "unsupported");
  const [stalled, setStalled] = useState(false);
  const [host] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    host.className = "frame-guard-host";
    document.documentElement.appendChild(host);
    const guard = startFrameGuard(document.documentElement, setState);
    const stopBlocking = blockInput(guard, (target) => target instanceof Node && host.contains(target));
    return () => {
      stopBlocking();
      guard.stop();
      host.remove();
      document.body.inert = false;
    };
  }, [host]);
  // Before paint: the page is never interactive for a frame it should not be.
  useLayoutEffect(() => {
    document.body.inert = state !== "clear";
  }, [state]);
  useEffect(() => {
    if (state === "clear" || state === "unsupported") return;
    const timer = window.setTimeout(() => setStalled(true), EXPLAIN_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      setStalled(false);
    };
  }, [state]);
  if (state === "clear" || (state !== "unsupported" && !stalled)) return null;
  const canPick = shellOrigin() !== null;
  return createPortal(
    <div className="frame-guard-panel" role="alertdialog" aria-modal="true" aria-labelledby="frame-guard-text">
      <p id="frame-guard-text">{t(state === "unsupported" ? "mobile.shell.guardUnsupported" : "mobile.shell.guardCovered")}</p>
      <div className="shell-frame-actions">
        {canPick && <button onClick={() => { postToShell({ type: "openPicker" }); }}>{t("mobile.shell.choose")}</button>}
        <button className="primary" onClick={() => { window.open(`${window.location.origin}/`, "_blank", "noopener,noreferrer"); }}>
          {t("mobile.shell.guardOpen", { host: window.location.host })}
        </button>
      </div>
      {isUntested("mobile.shell.frameGuard") && <p><span className="untested">{t("mobile.newTab.untested")}</span></p>}
    </div>,
    host,
  );
}
