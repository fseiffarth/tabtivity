import { NAMES } from "../../../src/lib/brand";

export const TERMINAL_PROTOCOL = NAMES.terminalProtocol;
export type TerminalControl =
  | { type: "ready" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "ping" }
  | { type: "detached" }
  /** Whether this page is in front of someone. Sent only on a socket whose
   * `features` event announced it (`terminal/visibility.ts`): a desktop that
   * does not know a control closes the socket on it. */
  | { type: "visibility"; visible: boolean }
  /** The queued bubbles' Send now for an agent of CLI `family`: the desktop
   * presses Esc only while the CLI's screen says the message still waits in
   * its queue, read beside the pane. Sent only where `features` announced it. */
  | { type: "send_now"; family: string };

/** Server → client. Mirrors `TerminalEvent` in
 * `src-tauri/src/services/mobile_control/protocol.rs`. */
export type TerminalEvent =
  | { type: "pong" }
  | { type: "window"; cols: number; rows: number }
  | { type: "replay" }
  | { type: "closing"; reason: string; retry: boolean }
  /** The phone's `seq`-th binary input frame on this socket reached the
   * session's PTY. Frames are counted per socket, on both ends alike. */
  | { type: "ack"; seq: number }
  /** The optional controls this desktop accepts, sent with the opening
   * frames. An event type this bundle does not know is ignored, which is
   * what lets either side be the newer one. */
  | { type: "features"; visibility: boolean; send_now?: boolean }
  /** The answer to `send_now`: whether the Esc went in. */
  | { type: "send_now"; sent: boolean }
  /** The desktop's AI switch is off: the input frame the next `ack` covers
   * was dropped, not written to the agent. */
  | { type: "ai_off" }
  /** The desktop's AI switch as it is now (agent tabs): sent at open while
   * it is off, and at every change after. */
  | { type: "ai_switch"; off: boolean };

/** The geometry the desktop accepts in a `resize`. Mirrors `MIN_COLS` …
 * `MAX_ROWS` in `protocol.rs`: a size outside these is answered with
 * `invalid_terminal_size`, a close that never retries. */
export const TERMINAL_SIZE = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 } as const;
