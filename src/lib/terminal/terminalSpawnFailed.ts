/**
 * "This terminal's launch ended without a PTY" — the frontend-only twin of the
 * backend's `terminal-exit`, for a spawn that never produced a program to exit.
 *
 * A refused or failing `pty_spawn` (a bad `.ovpn`, a VPN already up, no ssh on
 * the machine, the crash-loop guard, a declined HPC question) prints its
 * `[spawn error: …]` into the pane and stops: no PTY, so no `terminal-exit`
 * ever comes. Whoever waits on that exit to release something — a root login
 * tab's connection dedupe mark (`lib/remote/remoteConnect`) — would otherwise
 * hold it until the user closes the tab, and a retry would open nothing.
 *
 * A module of its own rather than a `terminalBus` export: this event never
 * crosses IPC, and the many tests that replace `terminalBus` wholesale keep
 * working without having to stub it.
 */
type Handler = () => void;

const handlers = new Map<string, Set<Handler>>();

/** Hear the launch of PTY `id` fail. Returns the unsubscribe. */
export function onTerminalSpawnFailed(id: string, handler: Handler): () => void {
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

/** Called by `TerminalView` once a launch has ended without a PTY. */
export function noteTerminalSpawnFailed(id: string): void {
  const set = handlers.get(id);
  if (!set) return;
  for (const h of [...set]) h();
}
