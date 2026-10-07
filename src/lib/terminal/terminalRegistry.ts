import type { Terminal } from "@xterm/xterm";

/**
 * The live xterm behind each terminal pane, by composed PTY id — so a store
 * can read what a tab has on screen (`lib/agents/prompt/echo`) without the pane
 * handing its terminal around. `TerminalView` registers the terminal the
 * moment it owns one and retires it with the same teardown that clears its
 * own refs, so an entry here is a live terminal or nothing. Per window: a
 * popout's panes register in the popout.
 */
const terminals = new Map<string, Terminal>();
/** Who wants to hear when an id's terminal is registered or retired: the
 *  Reader, which hooks the terminal's own write event instead of polling and
 *  so must learn of a terminal built after it (a pane constructs its xterm on
 *  first show) or swapped under it (a respawn). */
const watchers = new Map<string, Set<() => void>>();

function notify(ptyId: string): void {
  const set = watchers.get(ptyId);
  if (!set) return;
  for (const cb of [...set]) cb();
}

export function registerTerminal(ptyId: string, term: Terminal): void {
  terminals.set(ptyId, term);
  notify(ptyId);
}

export function unregisterTerminal(ptyId: string, term: Terminal): void {
  if (terminals.get(ptyId) !== term) return;
  terminals.delete(ptyId);
  notify(ptyId);
}

/** Call `cb` whenever `ptyId`'s terminal changes (built, swapped, retired);
 *  read it back with `terminalFor`. Returns the unwatch. */
export function watchTerminal(ptyId: string, cb: () => void): () => void {
  let set = watchers.get(ptyId);
  if (!set) {
    set = new Set();
    watchers.set(ptyId, set);
  }
  set.add(cb);
  return () => {
    set.delete(cb);
    if (set.size === 0) watchers.delete(ptyId);
  };
}

export function terminalFor(ptyId: string): Terminal | undefined {
  return terminals.get(ptyId);
}
