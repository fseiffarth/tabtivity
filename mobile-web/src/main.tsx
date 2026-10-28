// First: storage keys an older build wrote move to their current names
// before any module reads them (a no-op while the app's name is unchanged).
import "../../src/lib/brandMigrationBoot";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./style.css";
import "./themes.css";
import { applyPhoneTheme } from "./theme";
import { rememberPushLanguage } from "./pushTitles";
import { hardenPrototype } from "../../src/lib/hardenPrototype";
import { traceConnect } from "./api";
import { storageDashKey } from "../../src/lib/brand";

/** The voice probe page (docs/phone_voice_plan.md, step 0): a developer tool,
 * shown instead of the app only for `?voiceProbe` while the desktop's "Show
 * untested tags" is on — the flag App.tsx caches from the status probe. Its
 * own chunk, so the app never loads it otherwise. Deleted in agent step S11. */
const VoiceProbe = React.lazy(() => import("./voiceProbe").then((module) => ({ default: module.VoiceProbe })));
function voiceProbeWanted(): boolean {
  try {
    return new URLSearchParams(window.location.search).has("voiceProbe")
      && localStorage.getItem(storageDashKey("show-untested-tags")) === "true";
  } catch {
    return false;
  }
}

hardenPrototype();
// An uncaught error or a rejection nobody awaited is otherwise invisible on a
// phone; the connect trace is the one place a failed sign-in already shows.
const traceFailure = (kind: string, cause: unknown) => {
  const text = cause instanceof Error ? cause.message : String(cause);
  traceConnect(`${kind}: ${text.slice(0, 160)}`);
};
window.addEventListener("error", (event) => traceFailure("error", event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => traceFailure("unhandled rejection", event.reason));
applyPhoneTheme();
rememberPushLanguage();
if ("serviceWorker" in navigator) window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
const page = voiceProbeWanted() ? <React.Suspense fallback={null}><VoiceProbe /></React.Suspense> : <App />;
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary>{page}</ErrorBoundary></React.StrictMode>);

