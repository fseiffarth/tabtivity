/**
 * The real entry — everything `main.tsx` used to do. It is a separate module
 * so that in dev the perf monitor (`src/dev/perfMonitor.ts`) can be installed
 * BEFORE react-dom is ever evaluated: react-scan instruments React through a
 * devtools hook that must exist when react-dom loads, and the IPC tracer
 * should see the first store-mount invokes. In production `main.tsx` imports
 * this module immediately and nothing dev-related ships.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { installCrashReporter } from "./crashReporter";
import { installCustomScrollbars } from "./lib/theme/customScrollbar";
import { installStrayDropGuard } from "./lib/window/strayDropGuard";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";

installCrashReporter();
/**
 * Installed here rather than from a component, and in EVERY window: the main
 * shell, a popped-out subwindow and the presenter audience each have their own
 * document, and each needs its own thumb layer. It is a DOM-level concern with
 * no React state, so it has nothing to gain from living in the tree and would
 * only be at the mercy of when that tree mounts.
 */
installCustomScrollbars();
/** Same reasoning: a file dropped where nothing takes it must not navigate the
 *  window to it, in any window. */
installStrayDropGuard();

/**
 * Dev-only: hand each commit's duration to the perf monitor. Reached through
 * the window global rather than an import, because this module is the shared
 * prod path and must not pull `src/dev/` into a shipped bundle. In production
 * the branch below never renders a Profiler at all (react-dom's production
 * build would not time it anyway).
 */
function devCommitRecorder(
  _id: string,
  phase: "mount" | "update" | "nested-update",
  actualDuration: number,
): void {
  const perf = (
    window as unknown as {
      __APP_PERF__?: { commit?: (ms: number, phase: string) => void };
    }
  ).__APP_PERF__;
  perf?.commit?.(actualDuration, phase);
}

const app = import.meta.env.DEV ? (
  <React.Profiler id="app" onRender={devCommitRecorder}>
    <App />
  </React.Profiler>
) : (
  <App />
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{app}</React.StrictMode>,
);
