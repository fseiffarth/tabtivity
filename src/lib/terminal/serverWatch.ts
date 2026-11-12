import type { Terminal } from "@xterm/xterm";
import { findServerUrls, type ServerUrl } from "./serverUrls";
import { onParsedSettled } from "./parsedSettled";

/** Rows above the viewport still read for a server URL. */
const SERVER_SCROLLBACK_ROWS = 60;
/** The scan waits this long after the last parsed write, like the sign-in scan. */
const SCAN_DELAY_MS = 300;

/**
 * Watch `term`'s screen for the local servers its program printed
 * (`findServerUrls`) and hand the current list to `onChange` whenever it
 * changes. Only parsed output triggers a look — a hidden pane parses nothing
 * and catches up when shown — and looks are coalesced to one per 300 ms, so a
 * streaming program costs one scan per tick at most. Nothing is probed: the
 * list is whatever the screen shows.
 */
export function watchServers(term: Terminal, onChange: (servers: ServerUrl[]) => void): { dispose(): void } {
  let last = "";
  const scan = () => {
    const buf = term.buffer.active;
    const servers = findServerUrls(
      (n) => buf.getLine(n),
      term.cols,
      buf.baseY - SERVER_SCROLLBACK_ROWS,
      buf.baseY + term.rows - 1,
    );
    const signature = servers.map((s) => `${s.url}\n${s.kind}`).join("\u0001");
    if (signature === last) return;
    last = signature;
    onChange(servers);
  };
  return onParsedSettled(term, scan, SCAN_DELAY_MS);
}
