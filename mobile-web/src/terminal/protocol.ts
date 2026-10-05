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
  | { type: "visibility"; visible: boolean };

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
  | { type: "features"; visibility: boolean };

/** The geometry the desktop accepts in a `resize`. Mirrors `MIN_COLS` …
 * `MAX_ROWS` in `protocol.rs`: a size outside these is answered with
 * `invalid_terminal_size`, a close that never retries. */
export const TERMINAL_SIZE = { minCols: 20, maxCols: 400, minRows: 5, maxRows: 200 } as const;
