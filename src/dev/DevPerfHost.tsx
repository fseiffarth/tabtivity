/**
 * The dev-only perf panel — a floating, non-modal readout over the running
 * app: per-command IPC cost, main-thread stalls, slow React commits and the
 * process-tree resource numbers the backend already measures
 * (`debug_app_resource_usage` / `webview_rss_kib`).
 *
 * DEV-ONLY: mounted from `AppShell` behind `import.meta.env.DEV`, lazily, so
 * neither this file nor its CSS reaches a shipped bundle. Deliberately **not**
 * a `.modal-backdrop` dialog: the whole point is to watch the numbers while
 * using the app, so it must float beside the UI, never block it.
 *
 * English-only on purpose: this surface never ships, so it stays out of the
 * ~3700-key i18n table rather than adding five translations of "avg ms".
 *
 * The panel re-renders on a 1s tick while open instead of subscribing to the
 * monitor's buffers — a per-IPC-call subscription would make the profiler a
 * measurable cost in its own trace. Closed, it costs one keydown listener.
 *
 * Three states, not two: open, closed-to-the-⏱-button, and **gone**. The ⏱ sits
 * over the app's bottom-right corner and, until it could be dismissed, closing
 * the panel only ever traded a big overlay for a small permanent one — on the
 * exact surface being measured. Hiding it persists (localStorage, not settings:
 * this is dev-only state and must not reach `settings.json`), because the point
 * is to stop seeing it, and a dev session reloads the frontend constantly.
 * Ctrl+Alt+P always reopens, whatever the button is doing — which is what makes
 * hiding it safe rather than a one-way door.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  perfInvoke,
  perfState,
  resetPerf,
  setReactScan,
  SLOW_CALL_MS,
  SLOW_COMMIT_MS,
  IPC_RING_CAP,
  REACT_SCAN_ROOT_ID,
  type ReactScanState,
} from "./perfMonitor";
import {
  aggregateCalls,
  fmtBytes,
  fmtClock,
  fmtMs,
  stallSummary,
} from "./perfStats";
import { UntestedTag } from "../components/common/UntestedTag";
import "./devPerf.css";
import { TimerIcon } from "../components/common/icons/Icon";
import { storageKey } from "../lib/brand";

const RATE_WINDOW_MS = 60_000;
const STALL_WINDOW_MS = 60_000;
const IPC_ROWS_SHOWN = 14;
const RESOURCE_POLL_MS = 2000;
const FAB_HIDDEN_KEY = storageKey("devPerf.fabHidden");

const readFabHidden = () => {
  try {
    return localStorage.getItem(FAB_HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};

const writeFabHidden = (hidden: boolean) => {
  try {
    if (hidden) localStorage.setItem(FAB_HIDDEN_KEY, "1");
    else localStorage.removeItem(FAB_HIDDEN_KEY);
  } catch {
    /* private mode / storage disabled — the flag is a convenience, not state */
  }
};

const PERF_LAYER_ID = "app-dev-perf-layer";

/**
 * The panel renders through a portal into a node appended to
 * `documentElement`, and is kept its **last** child. That is not tidiness: it
 * is the only way this panel can paint above react-scan, which its own
 * checkbox switches on. react-scan mounts its widget on a div appended to
 * `documentElement` (i.e. after `<body>`) at a z-index past the int32 range —
 * so it clamps to the same maximum this panel uses and the tie is broken by
 * tree order, which a panel rendered inside `<body>` loses by construction.
 * Losing it means the widget covers the one control that turns it off.
 */
function perfLayer(): HTMLElement {
  const existing = document.getElementById(PERF_LAYER_ID);
  if (existing) return existing;
  const el = document.createElement("div");
  el.id = PERF_LAYER_ID;
  document.documentElement.appendChild(el);
  return el;
}

interface ResourceUsage {
  cpu_percent: number;
  rss_bytes: number;
  process_count: number;
}

export function DevPerfHost() {
  const [open, setOpen] = useState(false);
  const [fabHidden, setFabHidden] = useState(readFabHidden);
  const [, setTick] = useState(0);
  const [res, setRes] = useState<ResourceUsage | null>(null);
  const [rendererKib, setRendererKib] = useState<number>(0);
  const [scanState, setScanState] = useState<ReactScanState>(perfState().reactScan);
  const [layer] = useState(perfLayer);

  // Keep the layer last under <html>. react-scan appends its own root there
  // whenever it starts — which, from this panel's checkbox, is after we
  // mounted — so this cannot be done once at mount. Terminates: the move is
  // itself a mutation, but by then there is no next sibling and it stops.
  useEffect(() => {
    const raise = () => {
      if (layer.nextElementSibling) document.documentElement.appendChild(layer);
    };
    raise();
    const mo = new MutationObserver(raise);
    mo.observe(document.documentElement, { childList: true });
    return () => mo.disconnect();
  }, [layer]);

  // Ctrl+Alt+P toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 1s repaint while open — the buffers are read fresh each render.
  useEffect(() => {
    if (!open) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [open]);

  // Resource poll while open, through the unpatched channel (perfInvoke) so
  // the panel's own polling stays out of the IPC table it renders.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const poll = () => {
      perfInvoke<ResourceUsage>("debug_app_resource_usage")
        .then((r) => {
          if (alive) setRes(r);
        })
        .catch(() => undefined);
      perfInvoke<number>("webview_rss_kib")
        .then((kib) => {
          if (alive) setRendererKib(kib);
        })
        .catch(() => undefined);
    };
    poll();
    const t = window.setInterval(poll, RESOURCE_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open]);

  const hideEntirely = () => {
    setFabHidden(true);
    writeFabHidden(true);
    setOpen(false);
  };

  if (!open) {
    if (fabHidden) return null;
    return createPortal(
      <button
        className="dev-perf-fab"
        title="Perf monitor (Ctrl+Alt+P)"
        onClick={() => setOpen(true)}
      >
        <TimerIcon />
      </button>,
      layer,
    );
  }

  const st = perfState();
  const now = Date.now();
  const rows = aggregateCalls(st.calls, now, RATE_WINDOW_MS).slice(0, IPC_ROWS_SHOWN);
  const stalls = stallSummary(st.stalls, now, STALL_WINDOW_MS);
  const recentStalls = st.stalls.slice(-8).reverse();
  const slowCalls = st.slow.slice(-10).reverse();
  const commits = st.commits.slice(-8).reverse();
  const scanOn = scanState === "on" || scanState === "on-late";
  // Read on each 1s tick rather than tracked: the widget can be mounted by a
  // path this component never hears about (the boot arm, a hot update).
  const scanLeftover = document.getElementById(REACT_SCAN_ROOT_ID) !== null;

  const toggleScan = () => {
    const next = !scanOn;
    void setReactScan(next).then(() => setScanState(perfState().reactScan));
  };

  return createPortal(
    <div className="dev-perf-panel">
      <div className="dev-perf-head">
        <span className="dev-perf-title">
          Perf monitor <UntestedTag id="devPerfHost.1" />
        </span>
        <span className="dev-perf-head-actions">
          <button onClick={() => resetPerf()} title="Clear all buffers">
            Reset
          </button>
          {fabHidden ? (
            <button
              onClick={() => {
                setFabHidden(false);
                writeFabHidden(false);
              }}
              title="Put the timer button back in the corner"
            >
              Show <TimerIcon />
            </button>
          ) : (
            <button
              onClick={hideEntirely}
              title="Hide the panel and the timer button — Ctrl+Alt+P brings it back"
            >
              Hide <TimerIcon />
            </button>
          )}
          <button
            onClick={() => setOpen(false)}
            title={
              fabHidden
                ? "Close (Ctrl+Alt+P reopens)"
                : "Close to the timer button (Ctrl+Alt+P)"
            }
          >
            ✕
          </button>
        </span>
      </div>

      <div className="dev-perf-body">
        <section>
          <h4>Process tree</h4>
          {res ? (
            <div className="dev-perf-grid">
              <span>CPU</span>
              <span>{res.cpu_percent.toFixed(1)}%</span>
              <span>RSS (all)</span>
              <span>{fmtBytes(res.rss_bytes)}</span>
              <span>Renderer RSS</span>
              <span>{rendererKib > 0 ? fmtBytes(rendererKib * 1024) : "—"}</span>
              <span>Processes</span>
              <span>{res.process_count}</span>
            </div>
          ) : (
            <div className="dev-perf-empty">reading…</div>
          )}
        </section>

        <section>
          <h4>
            Main-thread stalls <small>(last 60s — {st.longTasks ? "longtask + timer lag" : "timer lag only"})</small>
          </h4>
          <div className="dev-perf-grid">
            <span>Stalls</span>
            <span>{stalls.count}</span>
            <span>Worst</span>
            <span>{stalls.worstMs > 0 ? fmtMs(stalls.worstMs) : "—"}</span>
          </div>
          {recentStalls.length > 0 && (
            <ul className="dev-perf-list">
              {recentStalls.map((s, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(s.ts)}</span> blocked ~{fmtMs(s.ms)}
                  <small> ({s.kind})</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h4>
            Slow React commits <small>(&gt;{SLOW_COMMIT_MS}ms)</small>
          </h4>
          {commits.length === 0 ? (
            <div className="dev-perf-empty">none recorded</div>
          ) : (
            <ul className="dev-perf-list">
              {commits.map((c, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(c.ts)}</span> {fmtMs(c.ms)}
                  <small> ({c.phase})</small>
                </li>
              ))}
            </ul>
          )}
          <label className="dev-perf-scan">
            <input type="checkbox" checked={scanOn} onChange={toggleScan} />
            <span>
              react-scan render highlighting
              {scanOn && <small> — unticking also removes its widget</small>}
              {scanState === "on-late" && <small> — full coverage after reload</small>}
              {scanState === "failed" && <small> — failed to load (see console)</small>}
            </span>
          </label>
          {/* The scan reports itself off while its widget is still on screen —
              a build before the teardown existed, or a start this panel never
              saw. The checkbox cannot express that (it is already unticked),
              so the way out has to be its own control. */}
          {!scanOn && scanLeftover && (
            <button className="dev-perf-scan-clear" onClick={() => void setReactScan(false)}>
              Remove leftover react-scan overlay
            </button>
          )}
        </section>

        <section>
          <h4>
            IPC commands <small>(last {IPC_RING_CAP} calls; rate over 60s; by total time)</small>
          </h4>
          {rows.length === 0 ? (
            <div className="dev-perf-empty">no calls traced yet</div>
          ) : (
            <table className="dev-perf-table">
              <thead>
                <tr>
                  <th>command</th>
                  <th>calls</th>
                  <th>/min</th>
                  <th>avg</th>
                  <th>max</th>
                  <th>total</th>
                  <th>err</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.cmd}>
                    <td className="mono">{r.cmd}</td>
                    <td>{r.count}</td>
                    <td>{r.perMin >= 10 ? Math.round(r.perMin) : r.perMin.toFixed(1)}</td>
                    <td>{fmtMs(r.avgMs)}</td>
                    <td>{fmtMs(r.maxMs)}</td>
                    <td>{fmtMs(r.totalMs)}</td>
                    <td>{r.errors > 0 ? r.errors : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h4>
            Slow IPC calls <small>(&gt;{SLOW_CALL_MS}ms, newest first)</small>
          </h4>
          {slowCalls.length === 0 ? (
            <div className="dev-perf-empty">none recorded</div>
          ) : (
            <ul className="dev-perf-list">
              {slowCalls.map((c, i) => (
                <li key={i}>
                  <span className="mono">{fmtClock(c.ts)}</span>{" "}
                  <span className="mono">{c.cmd}</span> {fmtMs(c.ms)}
                  {c.argBytes !== null && c.argBytes > 2048 && (
                    <small> — {fmtBytes(c.argBytes)} args</small>
                  )}
                  {!c.ok && <small> — failed</small>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>,
    layer,
  );
}
