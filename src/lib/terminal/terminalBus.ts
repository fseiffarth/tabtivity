import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { parseDetachedParam } from "../../stores/detached";

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

}

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
  return subscribe(outputHandlers, id, handler);
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
