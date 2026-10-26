// The phone terminal's live link: the xterm emulator, the socket to the desktop
// bridge, and the viewport the screen is sized to. Moved out of
// `screens/Terminal.tsx`, which calls these where its hooks always ran.
// Their effects read setters and refs the screen passes in. Those are stable,
// so where `exhaustive-deps` cannot tell, the rule is disabled at the site
// rather than handed a dependency the screen's own effect never had.
import { translateNow } from "../../../../src/lib/i18n";
import {
  useEffect, useLayoutEffect, type Dispatch, type SetStateAction, type MutableRefObject,
  type RefObject,
} from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { phoneTerminalTheme } from "../../theme";
import { TERMINAL_MIN_CONTRAST } from "../../../../src/lib/terminal/terminalPalette";
import { ApiError, api, recoverSession, type TabRow } from "../../api";
import { describeFailure } from "../../connection";
import {
  TERMINAL_PROTOCOL, TERMINAL_SIZE, type TerminalControl, type TerminalEvent,
} from "../../terminal/protocol";
import { readableRange, readableScreen, type ReadableLine } from "../../terminal/readableScreen";
import {
  absorbHistory, emptyHistory, lastHistoryText, scrollbackTrimEvent, shiftHistory,
  type HistoryChunk,
} from "../../terminal/readableHistory";
import { createVisibilityReporter } from "../../terminal/visibility";
import { installTerminalTouchScroll } from "../../terminal/touchScroll";
import { installWideOutputHint, type WideOutputHint } from "../../terminal/wideOutput";
import { bufferRows } from "../../terminal/subagentInput";
import { type PendingPrompt } from "../../terminal/pendingPrompts";
import { copiedSignIn, osc52Text, type SignIn } from "../../terminal/signIn";
import { type DictationSession } from "../../voiceSession";
import { paintMicLevel } from "../../../../shared/voice";
import { type VoiceNote, LINK_WAIT_MS } from "./terminalShared";

const PING_INTERVAL = 20_000;

/** Floor between two rebuilds of the reading view. */
const READABLE_INTERVAL = 120;

/** Two missed pongs. A half-open TCP connection — routine on cellular — leaves
 * `readyState` at OPEN indefinitely, so the socket looked connected and every
 * keystroke was silently buffered into a dead link. */
const PONG_GRACE = PING_INTERVAL * 2 + 5_000;

/** How long a pong may take after the page comes back into view. A locked
 * phone keeps its socket in the OPEN state whether or not the link behind it
 * survived, so a reader who unlocked and typed was writing into a dead link
 * for up to PONG_GRACE — the composer looked connected and nothing arrived —
 * and only leaving the tab and reopening it reconnected. On resume the link
 * is asked to prove itself within this much, and closed (which reconnects)
 * if it does not. */
const RESUME_GRACE = 4_000;

/** How long an input frame may wait for the desktop's `ack` before the words
 * in it count as lost. Longer than a round trip on a poor cellular link,
 * well short of PONG_GRACE: the ack is what tells a prompt "sent" from a
 * prompt buffered into a half-open socket, and a reader should learn which
 * within seconds, not after the next missed pong. */
const ACK_DEADLINE = 5_000;

/** How long the pong asked for at an overdue ack may take before the frames
 * it would vouch for count as lost (see `armAck`). */
const ACK_PROBE_GRACE = 4_000;

/** Bytes the browser may hold unsent before the link counts as stalled. The
 * phone's frames are keystrokes and prompts; this much sitting in the socket's
 * buffer is a link that has stopped taking anything. */
const STALLED_BYTES = 64 * 1024;

/** Session lines the phone keeps. Matches the desktop sidecar's replay depth
 * (`pty_bridge::MOBILE_SCROLLBACK_LINES`) and the tmux `history-limit` Tabtivity
 * sets on its sessions — the three are one number by design, so what tmux
 * retains is what the replay carries and what this buffer can hold. */
const PHONE_SCROLLBACK = 10_000;

/** Rows past the live screen the per-frame tail rebuild re-reads. The screen
 * itself can still be repainted by the program; the margin is slack so the
 * history absorbs nothing a repaint could reach. */
const TAIL_MARGIN = 8;

/** How far from its own bottom a scroller still counts as showing the newest
 * output. Terminal view needs only the rounding slack of one fractional cell
 * height; the reading view re-wraps, so it keeps the wider window a reader's
 * own scroll already uses there. */
const NEWEST_SLACK = 4;

/** Sizes the screen to the visual viewport, and keeps the document from
 * scrolling while the terminal is mounted. */
export function useTerminalViewport({
  setViewportHeight,
}: {
  setViewportHeight: Dispatch<SetStateAction<number | undefined>>;
}) {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const syncHeight = () => setViewportHeight(viewport.height);
    syncHeight();
    viewport.addEventListener("resize", syncHeight);
    return () => viewport.removeEventListener("resize", syncHeight);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The one full-bleed screen has to be the one screen the *document* cannot
  // scroll. `body` keeps a 100dvh floor for the scrolling sections while this
  // screen is sized to the visual viewport, so the document is taller than what
  // is on glass — and everything a phone does about that is a scroll that takes
  // the header with it. Three ways in practice: arriving from the bottom of a
  // long project screen, or from far down the agents list, keeps that scroll
  // offset; focusing the composer makes the browser
  // scroll the header away to seat the keyboard; and an agent tab has its own
  // way in, because `addContext` and the two attach paths focus the composer
  // *for* the reader, so the scroll arrives unasked after a tap on the ＋ sheet.
  // The header carries the back chevron, and the body below it eats
  // vertical drags (`touch-action:none` plus the drag handler in
  // terminal/touchScroll.ts), so once it is off screen there is no way back to
  // the project at all. Take the overflow away for as long as the terminal is
  // mounted — and pull the page back up first, since hiding the overflow under a
  // scrolled document leaves it scrolled, which is the same trap with no scroll
  // bar left to escape it.
  useLayoutEffect(() => {
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    document.body.classList.add("terminal-open");
    return () => document.body.classList.remove("terminal-open");
  }, []);
}

/** The xterm emulator and the terminal socket behind it for the tab on screen:
 * output, acks, pings, reconnects, resizes and the reading view's rebuilds. */
export function useTerminalSocket({
  tab, host, wideHint, readableHost, refreshReadable, write, sendControl, setSendNowReady,
  sendNowAsking, sendNowAnswer, recognition, dictateButton, connectedRef, voiceRequest,
  lastOutputAt, bracketedPaste, screenRows, viewportRows, setConnected, setStoppedReason,
  setAiOffAt, setAiOff, setAltScreen, setAltFrame, setSendFailed, setLines, setClipped,
  setSignInSheet, setCopiedLink, linkAsked, linkTimer, setLinkAsking, setLinkMissing, setEarlier,
  followReadable, atNewest, setListening, setPreparingVoice, setVoiceStatus, setVoiceFailure,
  setPending, setScreenTick, paneColumns,
}: {
  tab: TabRow;
  host: RefObject<HTMLDivElement>;
  wideHint: RefObject<HTMLDivElement>;
  readableHost: RefObject<HTMLElement>;
  refreshReadable: MutableRefObject<() => void>;
  write: MutableRefObject<(value: string, prompt?: number) => boolean>;
  sendControl: MutableRefObject<(frame: TerminalControl) => boolean>;
  setSendNowReady: Dispatch<SetStateAction<boolean>>;
  sendNowAsking: MutableRefObject<boolean>;
  sendNowAnswer: MutableRefObject<(sent: boolean) => void>;
  recognition: MutableRefObject<DictationSession | undefined>;
  dictateButton: RefObject<HTMLButtonElement>;
  connectedRef: MutableRefObject<boolean>;
  voiceRequest: MutableRefObject<number>;
  lastOutputAt: MutableRefObject<number>;
  bracketedPaste: MutableRefObject<() => boolean>;
  screenRows: MutableRefObject<() => string[]>;
  viewportRows: MutableRefObject<() => string[]>;
  setConnected: Dispatch<SetStateAction<boolean>>;
  setStoppedReason: Dispatch<SetStateAction<string>>;
  setAiOffAt: Dispatch<SetStateAction<number>>;
  setAiOff: Dispatch<SetStateAction<boolean>>;
  setAltScreen: Dispatch<SetStateAction<boolean>>;
  setAltFrame: Dispatch<SetStateAction<ReadableLine[]>>;
  setSendFailed: Dispatch<SetStateAction<boolean>>;
  setLines: Dispatch<SetStateAction<ReadableLine[]>>;
  setClipped: Dispatch<SetStateAction<boolean>>;
  setSignInSheet: Dispatch<SetStateAction<boolean>>;
  setCopiedLink: Dispatch<SetStateAction<SignIn | null>>;
  linkAsked: MutableRefObject<number>;
  linkTimer: MutableRefObject<number>;
  setLinkAsking: Dispatch<SetStateAction<boolean>>;
  setLinkMissing: Dispatch<SetStateAction<boolean>>;
  setEarlier: Dispatch<SetStateAction<{ chunks: HistoryChunk[]; open: ReadableLine[]; dropped: boolean; }>>;
  followReadable: (value: boolean) => void;
  atNewest: MutableRefObject<boolean>;
  setListening: Dispatch<SetStateAction<boolean>>;
  setPreparingVoice: Dispatch<SetStateAction<boolean>>;
  setVoiceStatus: Dispatch<SetStateAction<VoiceNote | null>>;
  setVoiceFailure: Dispatch<SetStateAction<VoiceNote | null>>;
  setPending: Dispatch<SetStateAction<PendingPrompt[]>>;
  setScreenTick: Dispatch<SetStateAction<number>>;
  paneColumns: MutableRefObject<number>;
}) {
  useEffect(() => {
    if (!host.current) return;
    const term = new XTerm({
      // The rendered terminal is an output and scroll surface. Text always
      // comes from the native composer below, which is more reliable on phone
      // keyboards and keeps accidental taps from editing a live agent prompt.
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: "bar",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      fontSize: 14,
      scrollback: PHONE_SCROLLBACK,
      theme: phoneTerminalTheme(),
      minimumContrastRatio: TERMINAL_MIN_CONTRAST,
    });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(host.current); fit.fit();
    // A theme picked while the terminal is open repaints it too.
    const themeWatch = new MutationObserver(() => { term.options.theme = phoneTerminalTheme(); });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    setCopiedLink(null);
    setLinkAsking(false);
    setLinkMissing(false);
    linkAsked.current = 0;
    // A clipboard copy the session makes is read only as the sign-in link the
    // phone just asked for (`askForLink`); any other copy stays on the desktop.
    // Guarded like the trim emitter below: a stand-in terminal has no parser.
    term.parser?.registerOscHandler(52, (data) => {
      if (Date.now() - linkAsked.current > LINK_WAIT_MS) return true;
      const link = copiedSignIn(osc52Text(data) ?? "");
      if (link) {
        linkAsked.current = 0;
        setLinkAsking(false);
        setCopiedLink(link);
        setSignInSheet(true);
      }
      return true;
    });
    bracketedPaste.current = () => term.modes.bracketedPasteMode === true;
    screenRows.current = () => bufferRows(term.buffer.active);
    viewportRows.current = () => bufferRows(term.buffer.active, term.rows);
    // The history log needs to know when xterm trims scrollback (row indices
    // shift), and xterm has no public event for it — so this rides the internal
    // buffer list's own trim emitter (`scrollbackTrimEvent`), guarded: when a
    // future xterm renames it, the view falls back to the bounded whole-screen
    // rebuild instead of showing wrong lines.
    const history = emptyHistory();
    let trimWatch: { dispose(): void } | undefined;
    // `term.reset()` — the replay boundary below — builds a *new* normal
    // buffer, and a listener on the old one's trim emitter then never fires
    // again. Left as it was, the first reconnect silently detached the log from
    // trims: once the 10k scrollback filled, `history.end` stopped following the
    // buffer and the absorbed rows drifted onto the wrong lines. Re-armed after
    // every reset instead.
    const watchTrim = () => {
      trimWatch?.dispose();
      trimWatch = scrollbackTrimEvent(term)?.((amount) => shiftHistory(history, amount));
    };
    watchTrim();
    const resetHistory = () => {
      history.chunks = [];
      history.open = [];
      history.end = 0;
      history.droppedLines = 0;
      history.lost = false;
      setEarlier({ chunks: [], open: [], dropped: false });
    };
    let readableFrame = 0;
    let readableScrollFrame = 0;
    let readableTimer = 0;
    let lastReadable = 0;
    const renderReadable = () => {
      const buffer = term.buffer?.active;
      if (!buffer) return;
      paneColumns.current = term.cols;
      const stream = readableHost.current;
      // The reading view is unmounted in Terminal view. A shell tab has no
      // other reader of these lines, so re-reading the screen there is pure
      // waste on a phone battery — but an agent tab's model and mode facts still do:
      // the mode walk confirms every Shift+Tab against the redrawn status line
      // and the model sheet lists the picker, both from `lines`. Left stale in
      // Terminal view, a walk pressed its full lap and reported a failure on a
      // session that had switched on the second press. The lazy history keeps
      // this to the live tail, so the rebuild is cheap; only the scroll follow
      // needs the stream.
      if (!stream && tab.kind !== "agent") return;
      lastReadable = Date.now();
      const followOutput = stream != null && stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
      // The alternate screen has no scrollback, so the reading view would show
      // only the visible frame, rebuild it on every redraw, and lose the lot
      // when the program exits. Say so instead of showing a collapsing view —
      // and never absorb its frames into the history: they are a full-screen
      // program's repaints, not session output.
      const alternate = buffer.type === "alternate";
      setAltScreen(alternate);
      if (alternate) {
        // An agent CLI can draw its whole session here — Claude Code does under
        // `"tui": "fullscreen"`, OpenCode's full TUI always — and then a
        // question it is waiting on sits on this frame and nowhere else: the
        // stored session only grows at message boundaries, and there is no
        // scrollback the reading view could grow from. So the frame is read for
        // the live readers, and still absorbed nowhere.
        if (tab.kind === "agent") setAltFrame(readableScreen(buffer).lines);
        return;
      }
      setAltFrame((held) => (held.length > 0 ? [] : held));
      if (trimWatch) {
        // Rows that left the tail window are converted once and kept; only the
        // tail — the live screen plus a margin — is re-read per frame.
        const grew = absorbHistory(buffer, history, term.rows + TAIL_MARGIN);
        const tail = readableRange(buffer, history.end, buffer.length, lastHistoryText(history));
        while (tail.length > 0 && tail[tail.length - 1].text === "") tail.pop();
        setLines(tail);
        if (grew) {
          setEarlier({
            chunks: [...history.chunks],
            open: history.open,
            dropped: history.droppedLines > 0 || history.lost,
          });
        }
        setClipped(false);
      } else {
        const screen = readableScreen(buffer);
        setLines(screen.lines);
        setClipped(screen.clipped);
      }
      if (stream && followOutput) {
        cancelAnimationFrame(readableScrollFrame);
        readableScrollFrame = requestAnimationFrame(() => {
          stream.scrollTo({ top: stream.scrollHeight });
          followReadable(true);
        });
      }
    };
    // A busy agent repaints many times a second. Rebuilding the reading view on
    // every one of those frames burned battery and made the text jitter under a
    // reader's eyes without adding anything they could follow.
    const updateReadable = () => {
      if (readableTimer) return;
      const wait = Math.max(0, READABLE_INTERVAL - (Date.now() - lastReadable));
      readableTimer = window.setTimeout(() => {
        readableTimer = 0;
        cancelAnimationFrame(readableFrame);
        readableFrame = requestAnimationFrame(() => {
          renderReadable();
          // The tick's one reader is the session settle read, which only an
          // agent tab has (`sessionFocus`). On a shell tab in Terminal view
          // `renderReadable` changes no state, so bumping it anyway re-rendered
          // this whole screen ~8×/s for as long as a command streamed.
          if (tab.kind === "agent") setScreenTick((tick) => tick + 1);
        });
      }, wait);
    };
    refreshReadable.current = updateReadable;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket | null = null;
    let stopped = false;
    let reconnectTimer: number | undefined;
    let reconnectAttempt = 0;
    let lastPong = 0;
    /** Pongs received on the current socket — what the resume check compares,
     * since two timestamps in one millisecond would read as no pong. */
    let pongs = 0;
    /** Binary input frames sent on the current socket. The desktop counts the
     * ones it wrote to the PTY the same way and acks each by that ordinal, so
     * nothing has to ride on a raw keystroke frame. */
    let inputFrames = 0;
    /** Frames the desktop has not acked yet, by ordinal: when they went, and
     * the pending bubble they carry a piece of. One past its deadline stays
     * here, `late`, until its socket goes: an ack that comes after all still
     * takes the marker back down. */
    const unacked = new Map<number, { at: number; prompt?: number; late?: boolean }>();
    let ackTimer = 0;
    /** `inputFrames` at each ping still waiting for its pong. The desktop
     * reads the socket in order, so a pong vouches for every frame sent
     * before its ping — which is also all a sidecar that predates the ack
     * says about them. */
    const pingMarks: number[] = [];
    /** Whether an interruption notice is already on screen for this outage:
     * one line per outage, not one per reconnect attempt. */
    let interrupted = false;
    const markPrompt = (id: number, state: { failed: boolean; retrying: boolean }) => {
      setPending((current) => current.map((prompt) => prompt.id === id ? { ...prompt, ...state } : prompt));
    };
    /** Give up on every unacked frame older than `olderThan`: its bubble is
     * marked not delivered, or, for a keystroke with no bubble, the
     * composer's notice goes up. `lost` (a close, a replay) also forgets
     * them — no ack can come for them any more. */
    const failUnacked = (olderThan: number, lost = false) => {
      const failed = new Set<number>();
      let bare = false;
      for (const [seq, entry] of unacked) {
        if (entry.at > olderThan) continue;
        if (lost) unacked.delete(seq);
        if (entry.late) continue;
        entry.late = true;
        if (entry.prompt === undefined) bare = true;
        else failed.add(entry.prompt);
      }
      for (const id of failed) markPrompt(id, { failed: true, retrying: false });
      if (bare) setSendFailed(true);
    };
    /** Everything up to the `seq`-th frame reached the PTY (frames are
     * ordered). A bubble whose last frame is in clears its marker, and so
     * does the composer's notice once no late keystroke is left. */
    // The desktop's AI switch dropped the frame the next ack covers (its
    // `ai_off` event comes just before that ack): the prompt was not delivered.
    let aiRefused = false;
    const acked = (seq: number) => {
      const refused = aiRefused;
      aiRefused = false;
      const delivered = new Set<number>();
      let bare = false;
      for (const [frame, entry] of unacked) {
        if (frame > seq) continue;
        unacked.delete(frame);
        if (entry.prompt !== undefined) delivered.add(entry.prompt);
        else if (entry.late) bare = true;
      }
      const waiting = [...unacked.values()];
      for (const id of delivered) {
        if (refused) markPrompt(id, { failed: true, retrying: false });
        else if (!waiting.some((entry) => entry.prompt === id)) markPrompt(id, { failed: false, retrying: false });
      }
      if (bare && !waiting.some((entry) => entry.late && entry.prompt === undefined)) setSendFailed(false);
    };
    const sendPing = (socket: WebSocket) => {
      pingMarks.push(inputFrames);
      socket.send(JSON.stringify({ type: "ping" }));
    };
    /** An overdue ack is not yet a lost frame: a late ack (behind a burst of
     * output) or a desktop that predates acks left the marker flickering up on
     * every prompt and the composer's notice up after every keystroke. Past
     * the deadline the link is asked for a pong — which vouches for every
     * frame sent before its ping — and only what that has not cleared within
     * ACK_PROBE_GRACE counts as lost. */
    const armAck = () => {
      if (ackTimer || ![...unacked.values()].some((entry) => !entry.late)) return;
      ackTimer = window.setTimeout(() => {
        const overdue = Date.now() - ACK_DEADLINE;
        const socket = ws;
        if (socket?.readyState === WebSocket.OPEN && [...unacked.values()].some((entry) => !entry.late && entry.at <= overdue)) {
          sendPing(socket);
          ackTimer = window.setTimeout(() => {
            ackTimer = 0;
            failUnacked(overdue);
            armAck();
          }, ACK_PROBE_GRACE);
          return;
        }
        ackTimer = 0;
        failUnacked(overdue);
        armAck();
      }, ACK_DEADLINE);
    };
    // Returns whether the bytes were handed to an open socket that is still
    // taking them. Callers that confirm something to the user must not claim
    // success on a `false`; the ack is what confirms delivery.
    sendControl.current = (frame) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(frame));
      return true;
    };
    write.current = (value, prompt) => {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      // Buffered bytes the socket is not draining are the earliest sign of a
      // stalled link — earlier than the missed pongs that would close it.
      if (ws.bufferedAmount > STALLED_BYTES) return false;
      ws.send(new TextEncoder().encode(value));
      inputFrames += 1;
      unacked.set(inputFrames, { at: Date.now(), prompt });
      armAck();
      return true;
    };
    // tmux sizes a window to its widest client and pans every narrower one
    // across it. Adopting the window geometry the server reports is what keeps
    // the phone from receiving a silently cropped, cursor-following slice; the
    // offscreen emulator's column count never had to match the physical screen.
    let windowSize: { cols: number; rows: number } | undefined;
    let wide: WideOutputHint | undefined;
    let anchorFrame = 0;
    // The screen is as tall as the desktop window, so on a phone its last rows
    // — the live prompt and the newest output — sit below the fold. Show that
    // end of it; the rows above are one drag away (terminal/touchScroll.ts).
    // Deferred a frame because xterm sizes the screen element on its own
    // render, after this returns.
    const anchorNewest = () => {
      cancelAnimationFrame(anchorFrame);
      anchorFrame = requestAnimationFrame(() => {
        const box = host.current;
        if (box) box.scrollTop = box.scrollHeight;
        atNewest.current = true;
        wide?.sync();
      });
    };
    const applySize = () => {
      const rows = term.rows;
      if (windowSize) {
        if (term.cols !== windowSize.cols || term.rows !== windowSize.rows) {
          term.resize(windowSize.cols, windowSize.rows);
        }
      } else {
        fit.fit();
        // Without a window frame the fitted size is what goes to the desktop,
        // and a size outside the protocol's bounds is answered with a close
        // that never retries. A landscape phone with its keyboard up fits fewer
        // rows than the floor; clamp to what the desktop accepts.
        const cols = Math.min(TERMINAL_SIZE.maxCols, Math.max(TERMINAL_SIZE.minCols, term.cols));
        const rows = Math.min(TERMINAL_SIZE.maxRows, Math.max(TERMINAL_SIZE.minRows, term.rows));
        if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
      }
      // A changed row count moves the view, and so does a box that was showing
      // the newest rows before this resize — the keyboard opening and the
      // composer growing both shrink it, and without this the live prompt and
      // the newest output slide under the composer and stay there. A reader
      // panned up into the screen keeps their place through either.
      if (term.rows !== rows || atNewest.current) anchorNewest();
      wide?.sync();
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };
    /** The desktop said the session lapsed (`session_expired`): the next
     * connect renews it first — the device key signs a fresh challenge, no
     * PIN — since the upgrade would only meet a 401 otherwise. */
    let relogin = false;
    const visibility = createVisibilityReporter(() => document.visibilityState === "visible");
    /** The link is down: the composer stops looking live, whatever the
     * socket still owed an ack for is marked not delivered, and dictation —
     * which types into this link — ends. Shared by a close, a closing frame
     * that ends the session, and a link this code judged dead itself. */
    const dropLink = () => {
      connectedRef.current = false;
      voiceRequest.current += 1;
      // Whatever this socket still owed an ack for is gone with it.
      failUnacked(Number.POSITIVE_INFINITY, true);
      setConnected(false);
      setPreparingVoice(false);
      const activeRecognition = recognition.current;
      if (activeRecognition) {
        recognition.current = undefined;
        activeRecognition.abort();
        paintMicLevel(dictateButton.current, null);
        setListening(false);
        setVoiceStatus(null);
        setVoiceFailure({ key: "mobile.voice.disconnected" });
      }
    };
    /** The next attempt, on the backoff. The server attaches to the persisted
     * tmux session again on reconnect, so its screen/history is replayed. Do
     * not clear the local screen: it keeps the last rendered state useful
     * while a phone wakes or switches between Wi-Fi and cellular. */
    const reconnectLater = () => {
      // Once per outage: a long one used to print this on every attempt,
      // which walked the screen away from what the reader was reading.
      if (!interrupted) {
        interrupted = true;
        term.write(`\r\n\x1b[33m[${translateNow("mobile.terminal.interrupted")}]\x1b[0m\r\n`);
      }
      const delay = Math.min(1_000 * 2 ** reconnectAttempt, 15_000);
      reconnectAttempt += 1;
      // A session that ended on the desktop refuses the upgrade at the HTTP
      // layer, so no `closing` frame can ever say why — the phone would show
      // "reconnecting…" forever. After two straight failures, ask the tab
      // endpoint; a transient network failure keeps the reconnect loop. A tab
      // on the remote host that is out of reach lost the desktop's connection
      // to the host (its upgrade's `409 host_offline`, `host_down` on the row),
      // not its session.
      if (reconnectAttempt >= 2) {
        void api<{ tab: TabRow }>(`/api/v1/tabs/${tab.id}`)
          .then((body) => { if (!body.tab.available) throw new ApiError(410, body.tab.on_host && body.tab.host_down ? "host_offline" : "session_gone"); })
          .catch((reason) => {
            if (stopped || !(reason instanceof ApiError)) return;
            if (reason.status !== 404 && reason.status !== 410) return;
            stopped = true;
            clearTimeout(reconnectTimer);
            setStoppedReason(describeFailure(reason.code === "host_offline" ? "host_offline" : "session_gone"));
          });
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, delay);
    };
    /** A link this code judged dead — no pong, a send buffer not draining —
     * is let go of at once. `close()` alone left it to `onclose`, which on a
     * silent link the browser fires only once the closing handshake times
     * out; until then `readyState` read CLOSING, the screen still said
     * connected, and neither the ping tick nor `resume` would act on it.
     * Detached here, its late `onclose` and anything it still delivers are
     * ignored (`ws !== next`); the desktop evicts the old viewer when the new
     * socket attaches. */
    const abandon = (socket: WebSocket) => {
      if (stopped || ws !== socket) return;
      ws = null;
      socket.close();
      dropLink();
      reconnectLater();
    };
    const connect = () => {
      if (stopped) return;
      if (relogin) {
        relogin = false;
        void recoverSession().finally(() => { if (!stopped) connect(); });
        return;
      }
      const next = new WebSocket(`${scheme}://${location.host}/api/v1/tabs/${tab.id}/terminal`, TERMINAL_PROTOCOL);
      ws = next;
      next.binaryType = "arraybuffer";
      next.onopen = () => {
        if (stopped || ws !== next) return;
        reconnectAttempt = 0;
        connectedRef.current = true;
        lastPong = Date.now();
        pongs = 0;
        inputFrames = 0;
        pingMarks.length = 0;
        interrupted = false;
        // A new bridge says again what it takes; an ask the old socket held
        // is never answered.
        setSendNowReady(false);
        sendNowAsking.current = false;
        setConnected(true);
        setSendFailed(false);
        // A retryable close (`idle_timeout`) explained itself and then
        // reconnected; the explanation must not outlive the outage, or it sat
        // over the composer for the rest of the session.
        setStoppedReason("");
        next.send(JSON.stringify({ type: "ready" }));
        applySize();
      };
      // An error is always followed by `close`, which does the reconnecting;
      // this exists so the failure is not an unhandled event.
      next.onerror = () => {
        if (ws === next) connectedRef.current = false;
      };
      // A closing frame that ends the session tore the link down already
      // (below), and an unmount must not set state: both leave `stopped`.
      next.onclose = () => {
        if (stopped || ws !== next) return;
        dropLink();
        reconnectLater();
      };
      next.onmessage = (event) => {
        if (ws !== next) return;
        if (event.data instanceof ArrayBuffer) {
          lastOutputAt.current = Date.now();
          term.write(new Uint8Array(event.data), updateReadable);
          return;
        }
        if (typeof event.data !== "string") return;
        let control: TerminalEvent;
        try {
          control = JSON.parse(event.data) as TerminalEvent;
        } catch {
          return;
        }
        if (typeof control !== "object" || control === null) return;
        if (control.type === "pong") {
          lastPong = Date.now();
          pongs += 1;
          const mark = pingMarks.shift();
          if (mark !== undefined) acked(mark);
          return;
        }
        if (control.type === "ack") {
          acked(control.seq);
          return;
        }
        if (control.type === "replay") {
          // The desktop sends this once, before it reads any input: frames the
          // phone sent ahead of it are still to be written and acked, not lost.
          // The server is about to resend the session. Without an explicit
          // boundary the replay was appended to whatever was already on screen,
          // so each reconnect left another copy of the same agent turn — and a
          // reader could not tell one destructive command from three.
          // The history log goes with it: the replay re-delivers the session,
          // so keeping the absorbed copy would double every line.
          term.reset();
          watchTrim();
          resetHistory();
          setLines([]);
          return;
        }
        if (control.type === "ai_switch") {
          setAiOff(control.off);
          if (!control.off) setAiOffAt(0);
          return;
        }
        if (control.type === "ai_off") {
          aiRefused = true;
          setAiOff(true);
          setAiOffAt(Date.now());
          return;
        }
        if (control.type === "features") {
          // This desktop takes visibility reports: say so if the page is
          // already hidden, and from here on at every change.
          if (control.visibility) visibility.supported(next);
          setSendNowReady(control.send_now === true);
          return;
        }
        if (control.type === "send_now") {
          sendNowAnswer.current(control.sent);
          return;
        }
        if (control.type === "window") {
          windowSize = { cols: control.cols, rows: control.rows };
          applySize();
          return;
        }
        if (control.type === "closing") {
          // An end the desktop chose (`replaced`, `access_revoked`, …) is
          // torn down here, on its frame: `stopped` makes the `onclose` that
          // follows a no-op, so leaving it to that left the composer live and
          // the unacked prompts pending under the sentence below. That
          // sentence is the whole explanation; nothing goes on the screen.
          if (!control.retry && !stopped) {
            stopped = true;
            clearTimeout(reconnectTimer);
            dropLink();
          }
          // The session lapsed, not the tab: renew it and come back.
          if (control.reason === "session_expired") relogin = true;
          setStoppedReason(describeFailure(control.reason));
        }
      };
    };
    connect();
    // xterm retains an internal textarea for accessibility even with stdin
    // disabled. Explicitly disable and remove it from tab order so a tap can
    // neither summon a second keyboard nor become a second input route.
    if (term.textarea) {
      term.textarea.disabled = true;
      term.textarea.tabIndex = -1;
      term.textarea.setAttribute("aria-hidden", "true");
    }
    const terminalHost = host.current;
    const removeTouchScroll = installTerminalTouchScroll(terminalHost, term);
    // Both the drag handler and `anchorNewest` scroll the box, and both arrive
    // here. `NEWEST_SLACK` absorbs the sub-pixel cell height that leaves a
    // fitted screen a fraction short of its own scroll extent.
    const followNewest = () => {
      atNewest.current =
        terminalHost.scrollHeight - terminalHost.scrollTop - terminalHost.clientHeight <= NEWEST_SLACK;
    };
    terminalHost.addEventListener("scroll", followNewest, { passive: true });
    // A fresh session starts at column one, whatever the previous tab was
    // panned to.
    terminalHost.scrollLeft = 0;
    if (wideHint.current) wide = installWideOutputHint(terminalHost, wideHint.current);
    anchorNewest();
    let resizeTimer = 0;
    let resizeFrame = 0;
    // A pending reading-view frame is left alone: the keyboard opening fires a
    // burst of viewport resizes, and cancelling the frame here dropped the
    // rebuild of whatever output had just arrived — the next byte, if any,
    // was the only thing that brought it back.
    const resize = () => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(applySize, 100);
      });
    };
    // A backgrounded PWA can be frozen before React unmounts, so the release
    // has to go out on `pagehide` too — otherwise the server holds the tab.
    const release = () => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
    };
    window.addEventListener("pagehide", release);
    // Hidden is not gone: the socket stays (no replay on the way back), and
    // the desktop is told nobody is looking, so an agent's notice is not held
    // back for a phone in a pocket (`terminal/visibility.ts`).
    document.addEventListener("visibilitychange", visibility.changed);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    // A phone can change the terminal's usable width without firing a window
    // resize (for example when browser chrome or a split-screen divider moves).
    // Keep xterm and the PTY in lockstep so long output is reflowed at the
    // visible right edge instead of leaving a stale, wider canvas behind.
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(resize);
    resizeObserver?.observe(terminalHost);
    const ping = window.setInterval(() => {
      if (ws?.readyState !== WebSocket.OPEN) return;
      // The server answers every ping. Silence past the grace window means the
      // link is gone even though the browser still reports OPEN, so let go of
      // it and reconnect. So does a send buffer the socket is not draining —
      // the earlier tell of the same dead link.
      if ((lastPong && Date.now() - lastPong > PONG_GRACE) || ws.bufferedAmount > STALLED_BYTES) {
        abandon(ws);
        return;
      }
      sendPing(ws);
    }, PING_INTERVAL);
    // The page came back into view — a phone unlocked, the app switched back
    // to. A socket that closed while it was away has its reconnect waiting on
    // a backoff timer that was frozen with the page: run it now. One the
    // browser still reports OPEN is asked for a pong within RESUME_GRACE and
    // abandoned otherwise, which starts the ordinary reconnect without waiting
    // for the browser's close; before this the composer stayed enabled on a
    // dead link until PONG_GRACE ran out, and typing went nowhere.
    let resumeTimer = 0;
    const resume = () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = ws;
      if (!current || current.readyState === WebSocket.CLOSED) {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        connect();
        return;
      }
      if (current.readyState !== WebSocket.OPEN) return;
      const seen = pongs;
      sendPing(current);
      clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        if (stopped || ws !== current || current.readyState !== WebSocket.OPEN) return;
        if (pongs === seen) {
          reconnectAttempt = 0;
          abandon(current);
        }
      }, RESUME_GRACE);
      updateReadable();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    return () => {
      stopped = true;
      connectedRef.current = false;
      voiceRequest.current += 1;
      refreshReadable.current = () => {};
      write.current = () => false;
      sendControl.current = () => false;
      bracketedPaste.current = () => false;
      screenRows.current = () => [];
      viewportRows.current = () => [];
      clearTimeout(reconnectTimer);
      clearTimeout(ackTimer);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "detached" }));
      ws?.close();
      trimWatch?.dispose();
      themeWatch.disconnect();
      term.dispose();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      window.clearTimeout(linkTimer.current);
      clearInterval(ping);
      clearTimeout(resumeTimer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      clearTimeout(resizeTimer);
      clearTimeout(readableTimer);
      cancelAnimationFrame(resizeFrame);
      cancelAnimationFrame(readableFrame);
      cancelAnimationFrame(readableScrollFrame);
      cancelAnimationFrame(anchorFrame);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", visibility.changed);
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      terminalHost.removeEventListener("scroll", followNewest);
      removeTouchScroll();
      wide?.dispose();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);
}
