/**
 * The dev-only perf monitor's side-effectful half: the IPC tracer, the
 * main-thread stall sampler, the React commit recorder and the react-scan
 * opt-in. `src/dev/perfStats.ts` holds the pure logic; `DevPerfHost.tsx`
 * renders the panel.
 *
 * DEV-ONLY: the only importers are `main.tsx` (behind `import.meta.env.DEV`)
 * and `DevPerfHost` (mounted behind the same guard), so none of this reaches
 * a shipped bundle. It finds inefficiencies; it is not itself a feature.
 *
 * Three decisions are load-bearing:
 *
 * - **State lives on a window global** (`__TABTIVITY_PERF__`), not in module
 *   scope: Vite HMR re-evaluates this module, and module-scoped buffers would
 *   reset on every hot update — exactly when you are watching the numbers —
 *   while a second install would wrap the already-wrapped `invoke` and count
 *   every call twice. The global carries both the buffers and the
 *   "already patched" fact across re-evaluations.
 *
 * - **The tracer patches `window.__TAURI_INTERNALS__.invoke`**, not the
 *   `@tauri-apps/api` wrapper: every `invoke` in the codebase — whichever
 *   module imported it — reaches that one function at call time, so one patch
 *   sees all IPC without touching any call site. The panel's own polling goes
 *   through the saved original (`perfInvoke`), so the monitor never shows up
 *   as its own worst offender (`debug_app_resource_usage` sleeps 300ms by
 *   design and would otherwise top every list).
 *
 * - **Stalls are measured by timer lag**, with `longtask` as an opportunistic
 *   extra: WebKitGTK (the engine this app actually runs on under Linux) does
 *   not implement the `longtask` entry type, so a `PerformanceObserver` alone
 *   would report an eternally smooth main thread. A 200ms interval that
 *   arrives late by more than 60ms is evidence something blocked the thread;
 *   coarse, but it fires on the engine that matters.
 */

import {
  pushRing,
  type IpcCall,
  type SlowIpcCall,
  type SlowCommit,
  type Stall,
} from "./perfStats";
import { storageDashKey } from "../lib/brand";

export const IPC_RING_CAP = 3000;
export const SLOW_CALL_MS = 50;
const SLOW_RING_CAP = 120;
const STALL_RING_CAP = 300;
const COMMIT_RING_CAP = 120;
/** React commits slower than this are kept (StrictMode double-renders in dev,
 * so the same update commits twice — both show, which is honest). */
export const SLOW_COMMIT_MS = 16;
const LAG_INTERVAL_MS = 200;
const LAG_STALL_MS = 60;

/** localStorage key arming react-scan at the next boot (and live, best-effort). */
export const REACT_SCAN_KEY = storageDashKey("dev-react-scan");
/** react-scan's OWN persisted options. It reads this back inside `setOptions`
 * and lets a stored `enabled` win over the value just passed, so switching the
 * scan off has to clear the key or the next call re-enables it. */
const REACT_SCAN_OPTIONS_KEY = "react-scan-options";
/** The id of react-scan's shadow host, appended to `documentElement`. */
export const REACT_SCAN_ROOT_ID = "react-scan-root";

type InvokeFn = (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;

interface TauriInternals {
  invoke: InvokeFn;
}

/** Whether react-scan is instrumenting this page, and how it got there. */
export type ReactScanState = "off" | "on" | "on-late" | "failed";

export interface PerfState {
  startedAt: number;
  calls: IpcCall[];
  slow: SlowIpcCall[];
  stalls: Stall[];
  commits: SlowCommit[];
  /** The unpatched invoke — also the "tracer is installed" marker. */
  rawInvoke: InvokeFn | null;
  /** Whether a `longtask` observer could be installed (Chromium yes, WebKit no). */
  longTasks: boolean;
  lagTimer: number | null;
  reactScan: ReactScanState;
  /** Called by the dev <Profiler> in bootstrap.tsx (which must not import
   * this dev module statically, so it reaches us through the global). */
  commit: (ms: number, phase: string) => void;
}

function ensureState(): PerfState {
  const w = window as unknown as { __APP_PERF__?: PerfState };
  if (w.__APP_PERF__) return w.__APP_PERF__;
  const st: PerfState = {
    startedAt: Date.now(),
    calls: [],
    slow: [],
    stalls: [],
    commits: [],
    rawInvoke: null,
    longTasks: false,
    lagTimer: null,
    reactScan: "off",
    commit: (ms, phase) => {
      if (ms >= SLOW_COMMIT_MS) {
        pushRing(st.commits, { ts: Date.now(), ms, phase }, COMMIT_RING_CAP);
      }
    },
  };
  w.__APP_PERF__ = st;
  return st;
}

/** The panel's read handle. Buffers are live references — do not mutate. */
export function perfState(): PerfState {
  return ensureState();
}

/** Clear every buffer (the panel's Reset), keeping the instrumentation. */
export function resetPerf(): void {
  const st = ensureState();
  st.calls.length = 0;
  st.slow.length = 0;
  st.stalls.length = 0;
  st.commits.length = 0;
  st.startedAt = Date.now();
}

function safeArgBytes(args: unknown): number | null {
  try {
    const s = JSON.stringify(args);
    return s ? s.length : 0;
  } catch {
    return null;
  }
}

function installIpcTracer(st: PerfState): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriInternals };
  const internals = w.__TAURI_INTERNALS__;
  // No internals: a plain browser tab / vitest, where there is nothing to trace.
  if (!internals || typeof internals.invoke !== "function" || st.rawInvoke) return;
  const raw = internals.invoke.bind(internals);
  st.rawInvoke = raw;
  internals.invoke = (cmd: string, args?: unknown, options?: unknown) => {
    const t0 = performance.now();
    const p = raw(cmd, args, options);
    const record = (ok: boolean) => {
      const ms = performance.now() - t0;
      const call: IpcCall = { cmd, ts: Date.now(), ms, ok };
      pushRing(st.calls, call, IPC_RING_CAP);
      if (ms >= SLOW_CALL_MS) {
        // Payload size only for the calls worth keeping: stringify is itself
        // main-thread work, so it must not run once per ordinary call.
        pushRing(st.slow, { ...call, argBytes: safeArgBytes(args) }, SLOW_RING_CAP);
      }
    };
    p.then(
      () => record(true),
      () => record(false),
    );
    return p;
  };
}

function installLagSampler(st: PerfState): void {
  if (st.lagTimer !== null) return;
  let expected = performance.now() + LAG_INTERVAL_MS;
  st.lagTimer = window.setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + LAG_INTERVAL_MS;
    if (lag >= LAG_STALL_MS) {
      pushRing(st.stalls, { ts: Date.now(), ms: Math.round(lag), kind: "lag" }, STALL_RING_CAP);
    }
  }, LAG_INTERVAL_MS);
}

function installLongTaskObserver(st: PerfState): void {
  if (st.longTasks) return;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        pushRing(
          st.stalls,
          { ts: Date.now(), ms: Math.round(e.duration), kind: "longtask" },
          STALL_RING_CAP,
        );
      }
    });
    po.observe({ entryTypes: ["longtask"] });
    st.longTasks = true;
  } catch {
    st.longTasks = false;
  }
}

/** Is the react-scan boot opt-in set? (The live state is `perfState().reactScan`.) */
export function reactScanArmed(): boolean {
  try {
    return localStorage.getItem(REACT_SCAN_KEY) === "1";
  } catch {
    return false;
  }
}

async function startReactScan(st: PerfState, late: boolean): Promise<void> {
  try {
    const { scan } = await import("react-scan");
    scan({ enabled: true });
    st.reactScan = late ? "on-late" : "on";
  } catch {
    st.reactScan = "failed";
  }
}

/**
 * Take react-scan's UI off the screen. `scan({ enabled: false })` alone does
 * not: it pauses the instrumentation, but the toolbar is only torn down when
 * `showToolbar` is *present* in the passed options (`setOptions` gates that on
 * `"showToolbar" in options`), and the shadow host it appends to
 * `documentElement` is never removed by the library at all. So an off used to
 * leave a draggable widget sitting over the app — above this panel, since it
 * carries a near-max z-index — with no control of its own to dismiss it.
 *
 * Every step here is best-effort and independent: this runs against a library
 * whose teardown is not part of its public contract, so a step that throws or
 * finds nothing must not stop the ones after it.
 */
async function stopReactScan(): Promise<void> {
  try {
    const { scan } = await import("react-scan");
    // showToolbar must be passed, not merely false by default, or the toolbar
    // is left mounted.
    scan({ enabled: false, showToolbar: false });
  } catch {
    // Was on, so the module is loaded; an import failure here can't happen in
    // practice. The DOM sweep below is the net under it either way.
  }
  const w = window as unknown as {
    reactScanCleanupListeners?: () => void;
    __REACT_SCAN_TOOLBAR_CONTAINER__?: { remove?: () => void };
  };
  try {
    w.reactScanCleanupListeners?.();
  } catch {
    /* the library's own cleanup; a throw here is not ours to handle */
  }
  try {
    w.__REACT_SCAN_TOOLBAR_CONTAINER__?.remove?.();
    document.getElementById(REACT_SCAN_ROOT_ID)?.remove();
  } catch {
    /* nothing mounted */
  }
  try {
    // Otherwise the stored `enabled: true` wins inside the next `setOptions`,
    // and a reload re-arms the scan we just switched off.
    localStorage.removeItem(REACT_SCAN_OPTIONS_KEY);
  } catch {
    /* localStorage unavailable */
  }
}

/**
 * The panel's toggle. Turning it on mid-session still tries (`on-late`), but
 * react-scan's fiber hook only fully instruments when it loads before
 * react-dom — which is why the armed flag is read at boot in `installDevPerf`
 * and the UI says "full coverage after reload" for a late enable.
 *
 * Off is not symmetric with on: see `stopReactScan`. It also runs even when
 * this session never turned the scan on, because a page armed at boot, or a
 * widget left behind by an earlier build, is exactly the state that needs a
 * way out.
 */
export async function setReactScan(on: boolean): Promise<void> {
  const st = ensureState();
  try {
    localStorage.setItem(REACT_SCAN_KEY, on ? "1" : "0");
  } catch {
    // localStorage unavailable: the toggle still works for this session.
  }
  if (on) {
    if (st.reactScan === "on" || st.reactScan === "on-late") return;
    await startReactScan(st, true);
  } else {
    await stopReactScan();
    st.reactScan = "off";
  }
}

/**
 * Invoke a Tauri command through the *unpatched* channel, so the panel's own
 * polling never appears in the trace it is displaying.
 */
export async function perfInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const st = ensureState();
  if (st.rawInvoke) return st.rawInvoke(cmd, args) as Promise<T>;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/**
 * Install everything. Called from `main.tsx` BEFORE the app module graph is
 * pulled in, which is what makes two things possible: the tracer sees the
 * very first invokes (store-mount reads), and react-scan — when armed — loads
 * before react-dom and can instrument at all.
 */
export async function installDevPerf(): Promise<void> {
  const st = ensureState();
  installIpcTracer(st);
  installLagSampler(st);
  installLongTaskObserver(st);
  if (reactScanArmed() && st.reactScan === "off") {
    await startReactScan(st, false);
  }
}
