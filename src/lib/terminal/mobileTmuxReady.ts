/**
 * Which local agent tabs this window wraps in tmux for the phone, keyed
 * `<scope>/<tabKey>`. A phone attaches through tmux, so an agent tab of a
 * Mobile-access scope is wrapped (`shouldPersistLocalTab`) — but a live agent
 * that was already running when the switch went on must not be respawned
 * merely to put tmux underneath it. So eligibility is stamped the first time a
 * pane renders a tab (`PaneSlot`): new and restored tabs first seen while
 * opted in are wrapped, tabs first seen before wait — for their next ordinary
 * reopen (which mints a fresh tab key), or for the phone opening one, which is
 * the consent to that respawn (`MobileBridgeHost`'s `activate` →
 * {@link markMobileTmuxReady}).
 *
 * One map per window, for the window's life: never replaced, only added to.
 */
export const mobileAgentTmuxReady = new Map<string, boolean>();

export function mobileTmuxReadyKey(scope: string, tabKey: string): string {
  return `${scope}/${tabKey}`;
}

/** What the tab's first render stamped: `undefined` while no pane has drawn it
 *  yet (its first render will stamp the scope's switch as it is then). */
export function mobileTmuxReadiness(scope: string, tabKey: string): boolean | undefined {
  return mobileAgentTmuxReady.get(mobileTmuxReadyKey(scope, tabKey));
}

/** Let the tab's next spawn be tmux-wrapped. The caller respawns it. */
export function markMobileTmuxReady(scope: string, tabKey: string): void {
  mobileAgentTmuxReady.set(mobileTmuxReadyKey(scope, tabKey), true);
}
