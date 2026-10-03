import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseDetachedParam } from "../../stores/detached";
import { isServerClient, onLinkState } from "../transport/linkState";

/**
 * Single global subscription per PTY-lifecycle event, fanned out to per-id
 * handlers. Every mounted `TerminalView` used to call `listen("terminal-output",
 * ...)` itself and filter `ev.payload.id === id` client-side — but the backend
 * emits these as plain window-wide events (`app.emit`, not scoped per PTY), so
 * every chunk from every running PTY was dispatched to and filtered by EVERY
 * mounted terminal (CenterPanel keeps all tabs, all scopes, mounted forever —
 * see its "flat pane layer" comment). That's O(mounted terminals) work per
 * output chunk, not O(1). Here there is exactly one `listen()` per event type
 * for the app's lifetime, doing an O(1) Map lookup to reach the right pane(s).
 */

interface TerminalOutput {
  id: string;
  data: string;
  startOffset?: number;
  endOffset?: number;
}

interface TerminalExit {
  id: string;
  code: number | null;
}

export interface TerminalOutputRange {
  startOffset: number;
  endOffset: number;
}

type OutputHandler = (data: string, range?: TerminalOutputRange) => void;
type ReadyHandler = () => void;
type ExitHandler = (code: number | null) => void;

const outputHandlers = new Map<string, Set<OutputHandler>>();
const replayHandlers = new Map<string, Set<OutputHandler>>();
/** The end offset of the last chunk seen per PTY — where a catch-up resumes. */
const lastEndOffset = new Map<string, number>();
const readyHandlers = new Map<string, Set<ReadyHandler>>();
const exitHandlers = new Map<string, Set<ExitHandler>>();

let started = false;

/**
 * The name this window hears a stream event under. Tauri evaluates an emit in
 * every webview that listens for its name, so a popout listening on the plain
 * name parsed every chunk of every PTY the main window streams. The backend
 * (`emit_output` in `terminal/mod.rs`) sends the main window every chunk under
 * the plain name and each popout only its own PTYs under `<event>:<label>`.
 */
export function streamEventName(event: string): string {
  try {
    if (parseDetachedParam(window.location.search) === null) return event;
    return `${event}:${getCurrentWindow().label}`;
  } catch {
    return event;
  }
}

function ensureStarted() {
  if (started) return;
  started = true;

  listen<TerminalOutput>(streamEventName("terminal-output"), (ev) => {
    const set = outputHandlers.get(ev.payload.id);
    if (!set) return;
    const range =
      typeof ev.payload.startOffset === "number" && typeof ev.payload.endOffset === "number"
        ? { startOffset: ev.payload.startOffset, endOffset: ev.payload.endOffset }
        : undefined;
    if (range) lastEndOffset.set(ev.payload.id, range.endOffset);
    for (const h of set) h(ev.payload.data, range);
  }).catch(() => {});

  // The backend's replay of output it buffered while the pane was hidden
  // (visible-only streaming). A separate event from `terminal-output` on
  // purpose: replayed output is STALE output written late, and the pane must
  // route it through its strip-terminal-queries path, never a bare write.
  listen<TerminalOutput>(streamEventName("terminal-replay"), (ev) => {
    const set = replayHandlers.get(ev.payload.id);
    if (!set) return;
    const range =
      typeof ev.payload.startOffset === "number" && typeof ev.payload.endOffset === "number"
        ? { startOffset: ev.payload.startOffset, endOffset: ev.payload.endOffset }
        : undefined;
    for (const h of set) h(ev.payload.data, range);
  }).catch(() => {});

  listen<{ id: string }>("terminal-ready", (ev) => {
    const set = readyHandlers.get(ev.payload.id);
    if (!set) return;
    for (const h of set) h();
  }).catch(() => {});

  listen<TerminalExit>("terminal-exit", (ev) => {
    const set = exitHandlers.get(ev.payload.id);
    if (!set) return;
    for (const h of set) h(ev.payload.code);
  }).catch(() => {});

  // The browser client's link can drop and come back (hosted plan §3.5,
  // "reconnect resumes by byte offset"): the server keeps this page's PTYs,
  // and their output went on while nobody listened. On every return to `up`,
  // each pane asks for the retained tail and takes only what lies beyond the
  // last offset it saw — through the replay path, whose query guard treats
  // it as the stale output it is.
  if (isServerClient()) {
    let wasDown = false;
    onLinkState((state) => {
      if (state !== "up") {
        wasDown = true;
        return;
      }
      if (!wasDown) return;
      wasDown = false;
      for (const id of outputHandlers.keys()) void catchUp(id);
    });
  }
}

interface PtyScrollback {
  data: string;
  startOffset: number;
  endOffset: number;
}

/** Replay what `id` produced past the last chunk this page saw. */
export async function catchUp(id: string): Promise<void> {
  let snapshot: PtyScrollback | string | null;
  try {
    snapshot = await invoke<PtyScrollback | string | null>("pty_scrollback", { id });
  } catch {
    return;
  }
  if (!snapshot || typeof snapshot === "string") return;
  const seen = lastEndOffset.get(id);
  const slice = sliceBeyond(snapshot, seen);
  if (slice === null) return;
  lastEndOffset.set(id, snapshot.endOffset);
  const set = replayHandlers.get(id);
  if (!set) return;
  for (const h of set) h(slice.data, slice.range);
}

/**
 * The part of a retained tail that lies past `seen` (the end offset of the
 * last chunk delivered), or `null` when nothing new is there. A pane that saw
 * nothing yet takes the whole tail; a tail that starts past `seen` (the
 * retained window moved on) is taken whole too — the gap is lost output, as
 * `pty_bridge` sheds it.
 */
export function sliceBeyond(snapshot: PtyScrollback, seen: number | undefined): { data: string; range: TerminalOutputRange } | null {
  if (seen !== undefined && snapshot.endOffset <= seen) return null;
  if (seen === undefined || seen <= snapshot.startOffset) {
    return { data: snapshot.data, range: { startOffset: snapshot.startOffset, endOffset: snapshot.endOffset } };
  }
  // Offsets count UTF-8 bytes of the text as the backend emitted it, not
  // UTF-16 code units: the cut is made in the encoded bytes and decoded back,
  // as `outputAfterScrollback` in TerminalView does (final review B8 — a
  // string slice garbled every replay past non-ASCII output such as `⏺`/`│`).
  const cut = seen - snapshot.startOffset;
  return {
    data: BYTE_DECODER.decode(BYTE_ENCODER.encode(snapshot.data).slice(cut)),
    range: { startOffset: seen, endOffset: snapshot.endOffset },
  };
}

const BYTE_ENCODER = new TextEncoder();
const BYTE_DECODER = new TextDecoder();

function subscribe<H>(registry: Map<string, Set<H>>, id: string, handler: H): () => void {
  ensureStarted();
  let set = registry.get(id);
  if (!set) {
    set = new Set();
    registry.set(id, set);
  }
  set.add(handler);
  return () => {
    set.delete(handler);
    if (set.size === 0) registry.delete(id);
  };
}

export function onTerminalOutput(id: string, handler: OutputHandler): () => void {
  const unsubscribe = subscribe(outputHandlers, id, handler);
  return () => {
    unsubscribe();
    // Only a pane still listening is caught up after a link drop; a PTY no
    // pane shows any more needs no offset (one entry per PTY otherwise
    // outlived every closed tab).
    if (!outputHandlers.has(id)) lastEndOffset.delete(id);
  };
}

export function onTerminalReplay(id: string, handler: OutputHandler): () => void {
  return subscribe(replayHandlers, id, handler);
}

export function onTerminalReady(id: string, handler: ReadyHandler): () => void {
  return subscribe(readyHandlers, id, handler);
}

export function onTerminalExit(id: string, handler: ExitHandler): () => void {
  return subscribe(exitHandlers, id, handler);
}
