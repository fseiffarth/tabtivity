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
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);

