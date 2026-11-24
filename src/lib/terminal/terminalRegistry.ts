import type { Terminal } from "@xterm/xterm";

/**
 * The live xterm behind each terminal pane, by composed PTY id — so a store
 * can read what a tab has on screen (`lib/agents/prompt/echo`) without the pane
 * handing its terminal around. `TerminalView` registers the terminal the
 * moment it owns one and retires it with the same teardown that clears its
 * own refs, so an entry here is a live terminal or nothing. Per window: a
 * popout's panes register in the popout.
 *
 * One PTY can have two live xterms in a window: its owning pane (CenterPanel's
 * keep-alive layer) and an attach-only view drawing it (the Root window, a
 * docked agent column, the cockpit's detail pane). Only one is on screen at a
 * time, and that is the one `terminalFor` returns — so steering's Work key
 * focuses the terminal the user sees, never a hidden copy (the Root window's
 * "typing does nothing" after steering), and closing one view leaves the
 * other registered instead of dropping the id.
 */
const terminals = new Map<string, Terminal[]>();
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
  const live = (terminals.get(ptyId) ?? []).filter((t) => t !== term);
  live.push(term);
  terminals.set(ptyId, live);
  notify(ptyId);
}

export function unregisterTerminal(ptyId: string, term: Terminal): void {
  const live = terminals.get(ptyId);
  if (!live?.includes(term)) return;
  const rest = live.filter((t) => t !== term);
  if (rest.length) terminals.set(ptyId, rest);
  else terminals.delete(ptyId);
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

/** Whether the xterm is drawn: opened, attached, and under no `display: none`. */
function onScreen(term: Terminal): boolean {
  const el = term.element;
  return !!el && el.isConnected && el.getClientRects().length > 0;
}

/** The id's terminal: the one on screen when it has several, else the one
 *  built last. */
export function terminalFor(ptyId: string): Terminal | undefined {
  const live = terminals.get(ptyId);
  if (!live?.length) return undefined;
  if (live.length === 1) return live[0];
  for (let i = live.length - 1; i >= 0; i--) if (onScreen(live[i])) return live[i];
  return live[live.length - 1];
}
