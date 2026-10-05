import type { TerminalControl } from "./protocol";

/** The slice of a `WebSocket` the reporter needs. */
export interface VisibilityLink {
  readyState: number;
  send(data: string): void;
}

/** `WebSocket.OPEN`, spelled out so this module needs no DOM global. */
const OPEN = 1;

/**
 * Tells the desktop whether this page is in front of someone.
 *
 * A phone put in a pocket keeps its terminal socket — the page is hidden, not
 * unloaded, and sending `detached` there would cost a full history replay on
 * every app switch. But the desktop held an agent's "finished" / "needs your
 * answer" notice back for any tab with a socket attached, so the notice was
 * skipped exactly when its reader had pocketed the phone. The socket stays;
 * this says whether anybody is looking at it.
 *
 * Only to a desktop that asked: one that predates the `visibility` control
 * closes the socket on it (`invalid_terminal_control`, no retry), and in dev
 * this bundle can be newer than the installed sidecar. `supported` is called
 * with the socket whose opening frames carried `features.visibility`; nothing
 * is ever sent on any other.
 */
export function createVisibilityReporter(isVisible: () => boolean) {
  let link: VisibilityLink | undefined;
  /** What the desktop believes about `link`. A new viewer counts as visible
   * until told otherwise, so a page that opens visible sends nothing. */
  let reported = true;
  const report = () => {
    if (!link || link.readyState !== OPEN) return;
    const visible = isVisible();
    if (visible === reported) return;
    reported = visible;
    const frame: TerminalControl = { type: "visibility", visible };
    link.send(JSON.stringify(frame));
  };
  return {
    /** The desktop behind `socket` accepts visibility reports. Sends the
     * state the page is in now, if that is not the default. */
    supported(socket: VisibilityLink) {
      link = socket;
      reported = true;
      report();
    },
    /** The page's visibility changed. */
    changed: report,
  };
}
