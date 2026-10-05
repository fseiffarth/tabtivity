import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { isPtyTabKind, useTabsStore } from "../../stores/tabs";
import { BRAND, storageColonKey } from "../brand";

/**
 * Renderer memory watchdog.
 *
 * The webview renderer (WebKitWebProcess on Linux) holds a window's whole JS
 * heap and, in a long session with heavy HMR, can grow without bound until it
 * OOM-aborts — a 44 GB leak observed 2026-07-31, which apport then amplified
 * into a multi-GB core dump on a near-full disk. WebKitGTK does not implement
 * `performance.memory`, so the renderer can't watch its own heap; the backend
 * reads each renderer's RSS from `/proc` (`webview_renderer_rss`) and this hook
 * acts on it.
 *
 * When THIS window's renderer crosses `RENDERER_CEILING_MB` we
 * `location.reload()`: a full reload drops the entire JS heap at once (the
 * nuclear GC WebKitGTK won't do on its own), and the app restores its tab
 * layout while backend-owned PTYs reattach. So a reload costs xterm scrollback
 * and any unsaved in-webview draft, but converts an unavoidable OOM crash
 * (which loses all of that anyway, plus a giant core dump) into a ~1 s flicker.
 *
 * Two rules exist because of one incident (2026-09-01). The reading is
 * **per window**: every Tabtivity window — the main one, each popout — runs this
 * hook and reloads only itself. The first version read the largest renderer
 * under the app and always reloaded the main window; with a popout holding
 * 4.7 GB, the main window (at 1.4 GB) reloaded itself every 30 s, freeing
 * nothing, for as long as the popout stayed open. And a reload is **not
 * repeated inside a cooldown**: if the same window is still over the ceiling
 * shortly after a watchdog reload, the memory is evidently not its JS heap,
 * and reloading again would only repeat the cost. The last reload's time
 * survives the reload itself in `sessionStorage`, which is per window.
 *
 * **Which renderer is ours** is something no engine we ship on will say
 * (WebKitGTK 2.52 no longer exports `webkit_web_view_get_web_process_identifier`;
 * WebView2 and WKWebView never had one), so each window finds out by itself:
 * it samples every renderer's RSS, allocates and touches a `PROBE_BYTES` buffer,
 * samples again, and the one pid that grew by that much is its own process.
 * Done once per window (the answer is cached in `sessionStorage` across our own
 * reloads — same process — and re-derived only when that pid is gone, i.e. the
 * renderer was replaced after a crash), then **claimed** with the backend so
 * every window's readout can name the others. With a single renderer there is
 * nothing to probe. If the probe stays ambiguous (another renderer allocating
 * heavily at the same instant) it is retried at the next poll a few times, then
 * the window falls back to acting on the largest renderer, under the cooldown.
 *
 * **A hold is not the end of it.** A held window asks the backend to replace
 * its renderer *process* (`webview_renderer_restart`, Linux only), once per
 * cooldown. That is the second step, for memory a reload provably did not
 * free: on 2026-09-07 the main window, holding only agent terminals, climbed at
 * ~150 MB/min, and a reload took it from 6.7 GB to 4.8 GB — the rest belonged
 * to the WebKitWebProcess itself, not the page, and only a new process frees
 * that. Tabs restore and PTYs reattach exactly as after a reload. Where the
 * backend cannot (an older binary, another engine), the window holds as
 * before and says so.
 *
 * The ceiling is deliberately high: a healthy renderer sits around 1 GB, so
 * 4 GB only ever trips on a genuine runaway — well before system memory
 * pressure, far below the 44 GB catastrophe. It scales with the machine
 * (`RENDERER_CEILING_RAM_SHARE` of physical RAM when that is more), because a
 * window's honest working set scales with the tabs: every tab in every active
 * scope stays mounted, each terminal with full-size canvas layers, and thirty
 * of them at 2× DPI pass 4 GB with nothing leaking. And a window whose fresh
 * process comes back over the ceiling has proved its size is that working
 * set; its ceiling is raised over it (`WORKING_SET_HEADROOM`) rather than
 * blinking it every cooldown. Change `RENDERER_CEILING_MB` to retune the
 * floor, or set it past any real value to disable.
 */
const POLL_MS = 30_000;
/** First attribution runs shortly after mount rather than at the first poll,
 *  so the debug readout can name the window early. */
const ATTRIBUTE_AFTER_MS = 2_000;
/** The ceiling's floor. The live ceiling is `max` of this, a share of the
 *  machine's RAM, and — once a window has shown that a fresh process comes
 *  back this big — its own working set with headroom; see `ceilingFor`. */
export const RENDERER_CEILING_MB = 4096;
/** Share of physical RAM a renderer may hold before the watchdog acts. A
 *  fixed 4 GB was right on the machine it was written on and wrong on a
 *  64 GB workstation with thirty terminals mounted at 2× DPI, where the
 *  main window's honest working set passed it with nothing leaking (user,
 *  2026-09-07: "maybe too many active projects? — the 4 GB is too strict"). */
export const RENDERER_CEILING_RAM_SHARE = 0.25;
/** Headroom over a working set the watchdog has confirmed by replacing the
 *  process: below it the size is the tabs, above it something is growing. */
export const WORKING_SET_HEADROOM = 1.5;
/** How long a window that just reloaded refuses to reload again while still
 *  over the ceiling. Long enough that a reload loop is impossible; short enough
 *  that a *new* runaway after a legitimate reload is still caught. */
export const RELOAD_COOLDOWN_MS = 10 * 60_000;
/** The attribution probe: allocated and touched once, freed right after. Big
 *  enough to stand clear of anything another renderer does in the same ~100 ms
 *  (an xterm burst is tens of MB), small enough to be a blink at 192 MiB. */
export const PROBE_BYTES = 192 * 1024 * 1024;
/** The probed renderer must have grown by at least this … */
export const PROBE_MIN_DELTA_KIB = 96 * 1024;
/** … and no other renderer by more than this, or the answer is ambiguous. */
export const PROBE_MAX_OTHER_DELTA_KIB = 48 * 1024;
const PROBE_ATTEMPTS = 3;
const RELOAD_AT_KEY = storageColonKey("renderer-watchdog-reload-at");
const RESTART_AT_KEY = storageColonKey("renderer-watchdog-restart-at");
const WORKING_SET_KEY = storageColonKey("renderer-watchdog-working-set-mb");
const OWN_PID_KEY = storageColonKey("renderer-watchdog-own-pid");
/** The app's name leading a window title (`"Tabtivity win-1"`). */
const APP_TITLE_PREFIX = new RegExp(`^${BRAND.display}\\b[\\s—–-]*`);

/** One webview renderer as the backend reports it (`commands::debug::RendererRss`). */
export interface RendererRss {
  /** Label of the window that claimed this renderer; `""` while unclaimed, or
   *  when the backend could not attribute at all (`pid === 0`). */
  label: string;
  /** The claiming window's title (`"Tabtivity win-1"`); `""` when unclaimed. */
  title: string;
  /** `0` = the older backend's unattributed largest-renderer reading. */
  pid: number;
  rss_kib: number;
}

/** What one renderer's resident memory is made of (`commands::debug::RendererMemory`). */
export interface RendererMemory {
  pid: number;
  rss_kib: number;
  anon_kib: number;
  file_kib: number;
  shmem_kib: number;
  /** Largest mappings by kernel name (`[anon]`, `[heap]`, a library, `memfd:…`), largest first. */
  top: { name: string; rss_kib: number }[];
  /** The process's thread count — absent on a backend that predates it. A
   *  renderer with hundreds of threads is a page leaking Workers (pdf.js spawns
   *  one per document, 2026-09-08), which no mapping name can say: a dead
   *  worker's heap and a canvas are both `[anon]`. */
  threads?: number;
}

/**
 * The breakdown as one bracketed clause for a crash.log line: heap versus mapped
 * files versus shared memory, then the largest mappings. This is the part of a
 * ceiling report that says what KIND of memory a 4 GB renderer holds — a JS-heap
 * leak, decoded images and canvas backing stores, and compositor buffers all read
 * as "RSS" but are fixed in different places, and a reload frees only the first.
 */
export function formatRendererMemory(m: RendererMemory): string {
  const mb = (kib: number) => Math.round(kib / 1024);
  const top = m.top
    .slice(0, 8)
    .map((t) => `${t.name} ${mb(t.rss_kib)} MB`)
    .join(", ");
  const threads = typeof m.threads === "number" ? `, ${m.threads} threads` : "";
  return (
    ` [anon ${mb(m.anon_kib)} MB, file ${mb(m.file_kib)} MB, shmem ${mb(m.shmem_kib)} MB${threads}` +
    (top ? `; largest mappings: ${top}]` : "]")
  );
}

/** The breakdown clause for `pid`, or `""` when the backend cannot say (an older
 *  binary, a platform without `/proc`, a pid that is not one of our renderers). */
async function describeRendererMemory(pid: number): Promise<string> {
  if (!pid) return "";
  try {
    const m = await invoke<RendererMemory | null>("webview_renderer_memory", { pid });
    return m && typeof m === "object" && Array.isArray(m.top) ? formatRendererMemory(m) : "";
  } catch {
    return "";
  }
}

/**
 * Every renderer's resident size. Falls back to the older unattributed
 * largest-renderer command against a backend that predates the per-renderer
 * one — including a stale binary still running behind a hot-reloaded frontend.
 * Resolves to `[]` when neither can answer: a watchdog that cannot measure
 * simply does nothing.
 */
export async function readRendererRss(): Promise<RendererRss[]> {
  try {
    const rows = await invoke<unknown>("webview_renderer_rss");
    // A mocked or foreign backend can answer anything; only well-formed rows
    // count, and a non-array (e.g. `null`) is "cannot measure", not a crash.
    if (Array.isArray(rows)) {
      return rows.filter(
        (r): r is RendererRss =>
          typeof r === "object" &&
          r !== null &&
          typeof (r as RendererRss).pid === "number" &&
          typeof (r as RendererRss).rss_kib === "number" &&
          typeof (r as RendererRss).label === "string" &&
          typeof (r as RendererRss).title === "string",
      );
    }
  } catch {
    // Backend predating the per-renderer command: fall through to the older one.
  }
  try {
    const kib = await invoke<unknown>("webview_rss_kib");
    return typeof kib === "number" && kib > 0
      ? [{ label: "", title: "", pid: 0, rss_kib: kib }]
      : [];
  } catch {
    return [];
  }
}

/** The probe's verdict, pure: which pid grew by the probe and no other did. */
export function pickProbedPid(
  before: readonly Pick<RendererRss, "pid" | "rss_kib">[],
  after: readonly Pick<RendererRss, "pid" | "rss_kib">[],
  minDeltaKib = PROBE_MIN_DELTA_KIB,
  maxOtherDeltaKib = PROBE_MAX_OTHER_DELTA_KIB,
): number | null {
  const base = new Map(before.map((r) => [r.pid, r.rss_kib]));
  const deltas = after
    .filter((r) => r.pid > 0 && base.has(r.pid))
    .map((r) => ({ pid: r.pid, delta: r.rss_kib - (base.get(r.pid) ?? 0) }))
    .sort((a, b) => b.delta - a.delta);
  const best = deltas[0];
  if (!best || best.delta < minDeltaKib) return null;
  const second = deltas[1];
  if (second && second.delta > maxOtherDeltaKib) return null;
  return best.pid;
}

/**
 * The entry this window's watchdog acts on. With a known own pid, that
 * renderer (or nothing, if the pid is gone — the caller re-attributes). Without
 * one: the unattributed reading if the backend gave one; else, only once
 * attribution has been given up on, the largest renderer — the old behaviour,
 * safe now under the reload cooldown. `null` = nothing to act on.
 */
export function ownRenderer(
  all: readonly RendererRss[],
  ownPid: number | null,
  fallbackToLargest: boolean,
): RendererRss | null {
  if (ownPid !== null) return all.find((r) => r.pid === ownPid) ?? null;
  const unattributed = all.find((r) => r.pid === 0);
  if (unattributed) return unattributed;
  if (!fallbackToLargest || all.length === 0) return null;
  return all.reduce((a, b) => (b.rss_kib > a.rss_kib ? b : a));
}

export type WatchdogVerdict =
  | { action: "none" }
  | { action: "reload"; mb: number }
  | { action: "hold"; mb: number; sinceReloadMs: number };

/** The pure decision: below the ceiling nothing; over it, reload — unless this
 *  window already reloaded for the watchdog within the cooldown, in which case
 *  hold (a reload demonstrably does not free this memory). */
export function decideWatchdog(
  mb: number,
  lastReloadAt: number | null,
  now: number,
  ceilingMb = RENDERER_CEILING_MB,
  cooldownMs = RELOAD_COOLDOWN_MS,
): WatchdogVerdict {
  if (mb < ceilingMb) return { action: "none" };
  if (lastReloadAt !== null && now - lastReloadAt < cooldownMs) {
    return { action: "hold", mb, sinceReloadMs: now - lastReloadAt };
  }
  return { action: "reload", mb };
}

/**
 * The ceiling this window acts on, pure: the fixed floor, or the RAM share when
 * the machine is big enough for that to be more, or the working set a process
 * replacement failed to shrink plus headroom — whichever is highest. `null`
 * for a reading the backend could not give.
 */
export function ceilingFor(
  totalRamMb: number | null,
  workingSetMb: number | null,
  floorMb = RENDERER_CEILING_MB,
  ramShare = RENDERER_CEILING_RAM_SHARE,
  headroom = WORKING_SET_HEADROOM,
): number {
  let ceiling = floorMb;
  if (totalRamMb !== null && totalRamMb > 0) {
    ceiling = Math.max(ceiling, Math.round(totalRamMb * ramShare));
  }
  if (workingSetMb !== null && workingSetMb > 0) {
    ceiling = Math.max(ceiling, Math.round(workingSetMb * headroom));
  }
  return ceiling;
}

/** The pure second-step decision, for a window already holding: replace the
 *  renderer process unless this window already did so within the cooldown —
 *  the same one-per-cooldown rule the reload follows, for the same reason (a
 *  replacement that did not help is not improved by another). */
export function shouldReplaceRenderer(
  lastRestartAt: number | null,
  now: number,
  cooldownMs = RELOAD_COOLDOWN_MS,
): boolean {
  return lastRestartAt === null || now - lastRestartAt >= cooldownMs;
}

/** Short name for a renderer row: the claiming window's title minus the app
 *  name (`"Tabtivity win-1"` → `"win-1"`), its label when there is no title, the
 *  pid while unclaimed, and a generic word for an unattributed reading. */
export function rendererName(r: Pick<RendererRss, "label" | "title" | "pid">): string {
  const title = r.title.replace(APP_TITLE_PREFIX, "").trim();
  if (title) return title;
  if (r.label) return r.label;
  if (r.pid > 0) return `pid ${r.pid}`;
  return "renderer";
}

/** `912 MB` below a gibibyte, `4.6 GB` from there — one decimal, since the
 *  reading is glanced at beside a 4 GB ceiling. */
export function formatRssKib(kib: number): string {
  const mb = kib / 1024;
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function readSessionNumber(key: string): number | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSessionNumber(key: string, n: number): void {
  try {
    sessionStorage.setItem(key, String(n));
  } catch {
    // No storage → no memory across reloads; each rule still holds within
    // this page's lifetime, and the probe simply runs again after a reload.
  }
}

function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return "";
  }
}

async function report(message: string): Promise<void> {
  try {
    // Land the reason in crash.log, so a user asking "why did my window
    // blink?" has an answer beside the native crashes.
    await invoke("report_frontend_error", { kind: "renderer-watchdog", message, stack: null });
  } catch {
    // Reporting must never block the decision.
  }
}

// ── The machine's RAM, for the ceiling ──────────────────────────────────────

let totalRamMb: number | null = null;
let ramRead: Promise<void> | null = null;

/** Read the machine's RAM once per window. `machine_load_snapshot` is the
 *  monitor's own sampler (two reads 300 ms apart around an await, no shared
 *  state); a backend without it, or one that reports no total, leaves the
 *  fixed floor in force. */
function ensureTotalRam(): Promise<void> {
  ramRead ??= invoke<{ mem_total_bytes?: unknown } | null>("machine_load_snapshot")
    .then((m) => {
      const bytes = m && typeof m === "object" ? m.mem_total_bytes : undefined;
      if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0) {
        totalRamMb = Math.round(bytes / (1024 * 1024));
      }
    })
    .catch(() => {});
  return ramRead;
}

/** The live ceiling for this window, in MB. */
function currentCeilingMb(): number {
  return ceilingFor(totalRamMb, readSessionNumber(WORKING_SET_KEY));
}

// ── Attribution: which renderer is this window's own ────────────────────────
// Module state is per window: a popout is its own JS context.

let ownPid: number | null = null;
let probeAttemptsLeft = PROBE_ATTEMPTS;
let attributing: Promise<number | null> | null = null;

/** True once the probe has been tried and failed `PROBE_ATTEMPTS` times. */
export function attributionGivenUp(): boolean {
  return ownPid === null && probeAttemptsLeft <= 0;
}

async function claim(pid: number): Promise<void> {
  try {
    await invoke("webview_renderer_claim", { pid });
  } catch {
    // An older backend has no claims; naming other windows is a nicety.
  }
}

/** Allocate + touch the probe buffer between two samples; the pid that grew
 *  is ours. The buffer is referenced after the second sample so the engine
 *  cannot drop it early. */
async function probeOwnPid(): Promise<number | null> {
  const before = await readRendererRss();
  const buf = new Uint8Array(PROBE_BYTES);
  buf.fill(1);
  const after = await readRendererRss();
  if (buf[buf.length - 1] !== 1) return null;
  return pickProbedPid(before, after);
}

/**
 * This window's renderer pid, deriving it if unknown: the cached answer if
 * that pid is still a live renderer, else the backend's existing claim for
 * this window (a reload keeps the process), else the single renderer if there
 * is only one, else the probe. Concurrent callers share one derivation.
 * `null` when the backend cannot attribute (unattributed reading) or the
 * probe was ambiguous this time.
 */
export async function ensureOwnRendererPid(): Promise<number | null> {
  if (attributing) return attributing;
  attributing = (async () => {
    try {
      const all = await readRendererRss();
      const live = all.filter((r) => r.pid > 0);
      if (live.length === 0) return null;
      if (ownPid !== null && live.some((r) => r.pid === ownPid)) return ownPid;

      const cached = readSessionNumber(OWN_PID_KEY);
      if (cached !== null && live.some((r) => r.pid === cached)) {
        ownPid = cached;
        await claim(cached);
        return cached;
      }
      const label = currentLabel();
      const claimed = label ? live.find((r) => r.label === label) : undefined;
      let pid: number | null = claimed?.pid ?? null;
      if (pid === null && live.length === 1) pid = live[0].pid;
      if (pid === null) {
        if (probeAttemptsLeft <= 0) return null;
        probeAttemptsLeft -= 1;
        pid = await probeOwnPid();
      }
      if (pid !== null) {
        ownPid = pid;
        probeAttemptsLeft = PROBE_ATTEMPTS;
        writeSessionNumber(OWN_PID_KEY, pid);
        await claim(pid);
      }
      return pid;
    } finally {
      attributing = null;
    }
  })();
  return attributing;
}

/** "37 tabs (29 terminals) across 6 scopes" — what a working-set report can
 *  point at, since every one of them is mounted whether or not its scope is in
 *  front. */
function mountedTabsSummary(): string {
  try {
    const byScope = useTabsStore.getState().tabsByScope;
    const scopes = Object.keys(byScope).length;
    const all = Object.values(byScope).flat();
    const ptys = all.filter((t) => isPtyTabKind(t.kind)).length;
    return `${all.length} tabs (${ptys} terminals) mounted across ${scopes} scopes`;
  } catch {
    return "tab count unavailable";
  }
}

export function useRendererWatchdog(): void {
  useEffect(() => {
    let stopped = false;
    let tripped = false;
    let heldReported = false;
    const label = currentLabel();
    const foreignReported = new Set<number>();

    const check = async (): Promise<void> => {
      if (stopped || tripped) return;
      const all = await readRendererRss();
      if (stopped || tripped) return;

      let pid = ownPid;
      if (pid === null || !all.some((r) => r.pid === pid)) {
        pid = await ensureOwnRendererPid();
        if (stopped || tripped) return;
      }
      const own = ownRenderer(all, pid, attributionGivenUp());

      // Another window's renderer over the ceiling is that window's own
      // watchdog's to reload — but it is also where a "why is Tabtivity slow"
      // answer lives, so say so once per renderer.
      for (const r of all) {
        if (r === own || r.pid === 0 || r.pid === pid) continue;
        const mb = r.rss_kib / 1024;
        if (mb >= currentCeilingMb() && !foreignReported.has(r.pid)) {
          foreignReported.add(r.pid);
          void report(
            `renderer '${rendererName(r)}' (pid ${r.pid}) is ${Math.round(mb)} MB ` +
              `≥ ${currentCeilingMb()} MB — its own window's watchdog reloads it, not '${label}'`,
          );
        }
      }
      if (!own) return;

      const mb = own.rss_kib / 1024;
      const ceiling = currentCeilingMb();
      const verdict = decideWatchdog(mb, readSessionNumber(RELOAD_AT_KEY), Date.now(), ceiling);
      if (verdict.action === "none") return;
      if (verdict.action === "hold") {
        if (heldReported) return;
        heldReported = true;
        // Memory a reload did not free is not the page's own garbage — say what
        // it is made of, so the next look starts from the kind, not the total.
        const what = await describeRendererMemory(own.pid);
        if (stopped) return;
        const held =
          `renderer RSS ${Math.round(mb)} MB still ≥ ${ceiling} MB ceiling ` +
          `${Math.round(verdict.sinceReloadMs / 1000)} s after a watchdog reload of '${label}' ` +
          `— a reload does not free this memory`;
        if (!shouldReplaceRenderer(readSessionNumber(RESTART_AT_KEY), Date.now())) {
          // A fresh process came back this big: the size is what the restored
          // tabs cost, not garbage. Every tab in every active scope stays
          // mounted, each terminal with full-size canvas layers, and at 2× DPI
          // that is real memory. Raise this window's ceiling over it so the
          // watchdog stops blinking a healthy window, while a runaway beyond
          // the headroom still trips. Per window, and it survives our own
          // reloads with the other keys.
          writeSessionNumber(WORKING_SET_KEY, Math.round(mb));
          await report(
            `${held}, and neither did replacing its process — this is the window's working ` +
              `set (${mountedTabsSummary()}); ceiling for '${label}' raised to ` +
              `${currentCeilingMb()} MB${what}`,
          );
          return;
        }
        // Second step: the memory is the process's, so replace the process.
        // The backend ends this renderer and reloads into a fresh one; this
        // page does not outlive the call. Written first: the storage is per
        // window and may survive the process, and then it is what stops a
        // window watching the wrong pid from replacing itself every poll.
        tripped = true;
        writeSessionNumber(RESTART_AT_KEY, Date.now());
        await report(`${held}; replacing the renderer process of '${label}'${what}`);
        try {
          await invoke("webview_renderer_restart");
        } catch (err) {
          // An older backend, or an engine with no way to end a content
          // process: hold, as before, and say why nothing more happens.
          tripped = false;
          await report(
            `renderer of '${label}' not replaced (${String(err)}); not reloading again for ` +
              `${Math.round(RELOAD_COOLDOWN_MS / 60_000)} min`,
          );
        }
        return;
      }

      tripped = true;
      const what = await describeRendererMemory(own.pid);
      await report(
        `renderer RSS ${Math.round(mb)} MB ≥ ${ceiling} MB ceiling ` +
          `(pid ${own.pid || "?"}) — reloading window '${label}' to free its JS heap before it OOMs${what}`,
      );
      writeSessionNumber(RELOAD_AT_KEY, Date.now());
      location.reload();
    };

    // Attribute early (a fresh renderer is small, so nothing else runs yet);
    // the first check is one interval in, never at mount.
    const attributeId = window.setTimeout(() => {
      if (stopped) return;
      void ensureOwnRendererPid();
      void ensureTotalRam();
    }, ATTRIBUTE_AFTER_MS);
    const id = window.setInterval(() => void check(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(attributeId);
      window.clearInterval(id);
    };
  }, []);
}
