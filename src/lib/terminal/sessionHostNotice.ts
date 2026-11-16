/**
 * The Windows session host's word on one tab's spawn, turned into what the
 * pane shows (`TerminalSessionHostCard`). docs/windows_session_host_plan.md §4
 * "Fallback vs fail closed"; the backend half is `services::session_host::route`.
 *
 * - `fallback`: the host is *definitively absent* (failed to start, version
 *   refused), so the tab runs in-process in the window. The backend emits
 *   `session-host-fallback` (`route::FALLBACK_EVENT`, payload `{ id, reason }`)
 *   at most once per app run.
 * - `unresponsive`: the host is *present but silent*. Not an event: `pty_spawn`
 *   rejects with `session_host_silent: …` (`route::ERR_SILENT`). The tab is NOT
 *   started — a fallback would run a second `--resume` agent on the same
 *   conversation and worktree — and the pane offers Retry.
 * - `refused`: the host answered and declined (an invalid name, …): `pty_spawn`
 *   rejects with `session_host_refused: …` (`route::ERR_REFUSED`). Fails closed
 *   the same way.
 *
 * Everything that knows the backend's wire shape is in this file, so the card
 * and its tests depend only on `SessionHostSignal`.
 */

import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../hooks/useTauriListener";

export type SessionHostUiState = "fallback" | "unresponsive" | "refused";

export interface SessionHostSignal {
  /** The tab's pty id (`<scope>:<key>`). */
  ptyId: string;
  state: SessionHostUiState;
}

/** `route::FALLBACK_EVENT`. */
export const SESSION_HOST_FALLBACK_EVENT = "session-host-fallback";
/** `route::ERR_SILENT`, the prefix of a `pty_spawn` rejection. */
export const ERR_SESSION_HOST_SILENT = "session_host_silent";
/** `route::ERR_REFUSED`, the prefix of a `pty_spawn` rejection. */
export const ERR_SESSION_HOST_REFUSED = "session_host_refused";

/** The fallback event's payload (`route::FallbackNotice`) as a signal, or
 *  `null` for anything else. */
export function sessionHostSignalOf(payload: unknown): SessionHostSignal | null {
  if (!payload || typeof payload !== "object") return null;
  const { id, reason } = payload as { id?: unknown; reason?: unknown };
  if (typeof id !== "string" || !id || typeof reason !== "string") return null;
  return { ptyId: id, state: "fallback" };
}

function errorText(err: unknown): string {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return "";
}

/** Which fail-closed state a `pty_spawn` rejection is, or `null` for any other
 *  spawn error. Matches the prefix up to its colon, so a longer code that
 *  merely starts the same way is not taken for it. */
export function sessionHostSpawnErrorState(err: unknown): SessionHostUiState | null {
  const text = errorText(err).trimStart();
  const code = text.split(":", 1)[0].trim();
  if (code === ERR_SESSION_HOST_SILENT) return "unresponsive";
  if (code === ERR_SESSION_HOST_REFUSED) return "refused";
  return null;
}

type Handler = (state: SessionHostUiState | null) => void;
const handlers = new Map<string, Set<Handler>>();
/** Each PTY's current notice, so a card that mounts after it (its pane's host
 *  element arrived late, the fallback event came before any pane) still shows
 *  it. Cleared at every spawn attempt, on dismiss/Retry, and when the PTY goes. */
const latest = new Map<string, SessionHostUiState>();

function publish(id: string, state: SessionHostUiState | null): void {
  if (state) latest.set(id, state);
  else if (!latest.delete(id)) return;
  for (const h of [...(handlers.get(id) ?? [])]) h(state);
}

/** Follow PTY `id`'s notice: called at once with the current one (if any),
 *  then with every change (`null` when it is gone). Returns the unsubscribe. */
export function onSessionHostState(id: string, handler: Handler): () => void {
  startSessionHostNotices();
  const already = latest.get(id);
  if (already) handler(already);
  let set = handlers.get(id);
  if (!set) {
    set = new Set();
    handlers.set(id, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0 && handlers.get(id) === set) handlers.delete(id);
  };
}

/** Called by `TerminalView` with every `pty_spawn` rejection it prints; only a
 *  session host one becomes a notice. */
export function reportSessionHostSpawnError(id: string, err: unknown): void {
  const state = sessionHostSpawnErrorState(err);
  if (state) publish(id, state);
}

/** The fallback event's payload, recorded for its tab. */
export function noteSessionHostFallback(payload: unknown): void {
  const signal = sessionHostSignalOf(payload);
  if (signal) publish(signal.ptyId, signal.state);
}

/** Drop PTY `id`'s notice: a new spawn attempt, a dismiss or Retry, the PTY
 *  killed or its tab closed. Cards showing it hide. */
export function clearSessionHostState(id: string): void {
  publish(id, null);
}

let stopListening: (() => void) | null = null;

/**
 * Listen for the fallback event for the window's life, recording into the
 * notices. Started at app start (`AppShell`) — the event is emitted once per
 * run, possibly before the tab's pane exists — and again, idempotently, by the
 * first card that subscribes (a popout has no AppShell).
 */
export function startSessionHostNotices(): void {
  if (stopListening) return;
  stopListening = subscribeTauri(() =>
    listen<unknown>(SESSION_HOST_FALLBACK_EVENT, (event) => noteSessionHostFallback(event.payload)),
  );
}

/** Test seam: stop listening and forget every notice. */
export function resetSessionHostNotices(): void {
  stopListening?.();
  stopListening = null;
  latest.clear();
}
