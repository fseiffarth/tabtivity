/**
 * A linked desktop on screen (`docs/phone_multi_desktop_plan.md`, Phase 3):
 * its own phone page in one iframe from its own origin, the explanation when
 * it never says `ready`, and the switch button the app's screens carry.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { firstLabel, linkedSnapshot, noteDesktopReady, subscribeLinked } from "./linkedDesktops";
import { listenToFrame } from "./frameBridge";
import { useDesktopShell } from "./shellContext";

/** What a framed desktop may use (the sidecar's Permissions-Policy grants the
 * microphone and speech recognition to listed origins; `allow=` cannot widen it). */
export const FRAME_ALLOW = "microphone; on-device-speech-recognition; web-share; clipboard-write; publickey-credentials-get; screen-wake-lock";
/** How long a framed desktop has to say `ready` before the shell explains. */
export const READY_TIMEOUT_MS = 8_000;
/** How long the `/healthz` probe behind that explanation may take. */
const PROBE_TIMEOUT_MS = 5_000;

/** The switch button: in Home's header, or floating over a screen with none. */
export function DesktopSwitchButton({ floating = false }: { floating?: boolean }) {
  const t = useT();
  const shell = useDesktopShell();
  if (!shell.canSwitch) return null;
  const label = t("mobile.shell.switch");
  return <button className={floating ? "home-head-button shell-switch-floating" : "home-head-button"} aria-haspopup="dialog" aria-label={label} title={label} onClick={shell.openPicker}>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.5" y="4" width="13" height="9" rx="1.5" /><path d="M8.5 16.5h7M7 13v3.5" /><rect x="10.5" y="9" width="11" height="8" rx="1.5" /><path d="M14 20h4M16 17v3" /></svg>
    {isUntested("mobile.shell.switcher") && <span className="untested">{t("mobile.newTab.untested")}</span>}
  </button>;
}

/** The selected desktop, framed. Retry remounts the frame. */
export function DesktopStage({ origin }: { origin: string }) {
  const [attempt, setAttempt] = useState(0);
  return <main className="shell-stage">
    <DesktopFrame key={`${origin}#${attempt}`} origin={origin} retry={() => setAttempt((n) => n + 1)} />
  </main>;
}

/** Whether anything answers at `origin` — opaque (`no-cors`) on purpose: a
 * desktop that has not linked this app sends no CORS header, and a CORS probe
 * could not tell it from one that is down. */
async function answers(origin: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(`${origin}/healthz`, { mode: "no-cors", cache: "no-store", credentials: "omit", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

type FramePhase = "waiting" | "ready" | "notLinked" | "unreachable";

/**
 * One framed desktop. The iframe is made by hand so its `allow` and `src` are
 * set before it is attached — an attached frame given a `src` adds a history
 * entry — and its `src` is never changed after: another desktop, or a retry,
 * is a new frame (a new `key`).
 */
function DesktopFrame({ origin, retry }: { origin: string; retry: () => void }) {
  const t = useT();
  const shell = useDesktopShell();
  const holder = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [phase, setPhase] = useState<FramePhase>("waiting");
  const openPicker = useRef(shell.openPicker);
  useEffect(() => {
    openPicker.current = shell.openPicker;
  });
  const linked = useSyncExternalStore(subscribeLinked, linkedSnapshot);
  const name = linked.desktops.find((row) => row.origin === origin)?.name ?? firstLabel(origin);
  useLayoutEffect(() => {
    const parent = holder.current;
    if (!parent) return;
    const frame = document.createElement("iframe");
    frame.className = "shell-frame";
    frame.setAttribute("allow", FRAME_ALLOW);
    frame.src = `${origin}/`;
    parent.appendChild(frame);
    frameRef.current = frame;
    let alive = true;
    const stop = listenToFrame(frame, origin, (message) => {
      if (message.type === "ready") {
        setPhase("ready");
        noteDesktopReady(origin, message.name, message.desktopAvailable);
      } else {
        openPicker.current();
      }
    });
    // A keyboard (or a screen reader) lands in the desktop just switched to.
    const onLoad = () => { try { frame.contentWindow?.focus(); } catch { /* cross-origin focus refused */ } };
    frame.addEventListener("load", onLoad);
    // No `ready` in time: a desktop that has not linked this app or predates
    // linking (it refuses the frame), one that loads but predates the shell's
    // bridge, or one that is down.
    const timer = window.setTimeout(() => {
      void answers(origin).then((up) => {
        if (alive) setPhase((now) => now === "ready" ? now : up ? "notLinked" : "unreachable");
      });
    }, READY_TIMEOUT_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      stop();
      frame.removeEventListener("load", onLoad);
      frame.remove();
      frameRef.current = null;
    };
  }, [origin]);
  // Its name titles it, and changes without reloading it.
  useLayoutEffect(() => {
    if (frameRef.current) frameRef.current.title = name;
  }, [name]);
  const stuck = phase === "notLinked" || phase === "unreachable";
  return <>
    <div ref={holder} className="shell-frame-holder" />
    {stuck && <div className="shell-frame-panel" role="alert">
      <p>{phase === "notLinked"
        ? t("mobile.shell.notLinked", { name, home: window.location.origin })
        : t("mobile.shell.unreachable", { name })}</p>
      <div className="shell-frame-actions">
        <button onClick={retry}>{t("mobile.shell.retry")}</button>
        <button className="primary" onClick={() => openPicker.current()}>{t("mobile.shell.choose")}</button>
      </div>
      {isUntested("mobile.shell.framedDesktop") && <p><span className="untested">{t("mobile.newTab.untested")}</span></p>}
    </div>}
    {!stuck && isUntested("mobile.shell.framedDesktop") && <span className="untested shell-stage-tag" aria-hidden="true">{t("mobile.newTab.untested")}</span>}
  </>;
}
