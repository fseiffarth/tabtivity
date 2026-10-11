import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { invoke } from "@tauri-apps/api/core";
import { resolveTheme, useSettingsStore } from "../../stores/settings";
import { useProjectsStore } from "../../stores/projects";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useExperimental } from "../../lib/experimental";
import { cmdToKind, isDetachedPtyId, type TabKind } from "../../stores/tabs";
import { isInterruptInput, lastPtyOutputAt, noteAgentResting, notePtySpawn, noteTurnCutOff, noteUserInput, splitPtyId, useActivityStore } from "../../stores/activity";
import { useAgentTaskStore } from "../../stores/agents/agentTask";
import { noteInput } from "../../lib/agents/promptCount";
import { METRIC, agentPromptLeaf, sub } from "../../lib/usageMetrics";
import { ROOT_SCOPE, bumpUsage, markAgentActive } from "../../stores/usage";
import {
  onTerminalExit,
  onTerminalOutput,
  onTerminalReady,
  onTerminalReplay,
  type TerminalOutputRange,
} from "../../lib/terminal/terminalBus";
import { terminalPalette } from "../../lib/terminal/terminalPalette";
import { hpcGuardRefusal } from "../../lib/remote/hpc/hpcGuard";
import { useHpcGuardStore } from "../../stores/remote/hpc/hpcGuardPrompt";
import { unfencedPlatformRefusal } from "../../lib/agents/agentFence";
import { useUnfencedPlatformStore } from "../../stores/unfencedPlatformPrompt";
import { CSI_U_SHIFT_TAB, FORCE_SELECTION_MODIFIER, SILENT_START_MS, agentMouseDownAction, bufferTail, claimInitialInput, decodeOsc52Clipboard, initialInputForPty, claudeLaunchName, isClaudeCommand, isCodexCommand, isTerminalAutoReply, isTerminalIdentityResponse, isTerminalReport, showsAgentTrustDialog, silentStartNotice, stripTerminalQueries, suppressNativeContextMenu, terminalProgramLabel, type SilentStartNotice } from "../../lib/terminal/terminalControl";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { deliverDrop, insertIntoReader } from "../../lib/terminal/terminalDrop";
import { isExternalFileDrag, parseDroppedFilePaths } from "../files/importDrop";
import { clearPtyInput, writePtyInput } from "../../lib/terminal/terminalInput";
import { registerScheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { wakePhoneHolds } from "../../lib/agents/phoneHolds";
import { terminalYieldsChord } from "../../lib/shortcuts/terminalTabChord";
import { terminalChordFor, zoomFor, type ShortcutMap } from "../../lib/shortcuts/shortcuts";
import { copyableSelection, installMouseModeGuard, joinedSelectionText } from "../../lib/terminal/terminalSelection";
import { keySelectHighlight, keySelectRange, keySelectStep, scrollToShow, startKeySelect, type KeySelectState } from "../../lib/terminal/keyboardSelect";
import { findSignInRequest, findWrappedUrls, type SignInRequest } from "../../lib/terminal/terminalUrls";
import { openPathLink } from "../../lib/terminal/pathLinks";
import { registerPathLinkProvider } from "../../lib/terminal/pathLinkProvider";
import { usePathLinkContext } from "../../lib/terminal/usePathLinkContext";
import { relativePathWithin } from "../../lib/paths";
import { PathLinkHint, type PathLinkHover } from "./PathLinkHint";
import { SIGN_IN_CARD_CLASS, TerminalSignInCard } from "./TerminalSignInCard";
import { TerminalPromptStrip } from "./TerminalPromptStrip";
import { TerminalReaderView } from "./TerminalReaderView";
import { TerminalReaderChanges, changesWidthStyle } from "./TerminalReaderChanges";
import { readerAgent as readerAgentOf, readerOffered } from "../../lib/agents/agentReader";
import { useAgentReaderStore, useReaderChangesOpen, useReaderOpen } from "../../stores/agents/agentReader";
import { isDetachedWindow } from "../../stores/detachedContext";
import { usePaneTab } from "../tabs/paneTabContext";
import { TerminalUndoClearCard } from "./TerminalUndoClearCard";
import { TerminalVersionCard } from "./TerminalVersionCard";
import { UntestedTag } from "../common/UntestedTag";
import { type ConfirmSpec, useDialogs } from "../common/PromptDialogs";
import { noteTypedClear, useAgentClearUndoStore } from "../../stores/agents/agentClearUndo";
import { noteTypedLine, screenAtCursor } from "../../lib/agents/typedClear";
import { isSessionCommand } from "../../lib/agents/prompt/chart";
import { notePromptTrailInput } from "../../stores/agents/promptTrail";
import "@xterm/xterm/css/xterm.css";
import { envName, storageKey } from "../../lib/brand";

// Hoisted to module scope: keystroke input fires this on every key, so we reuse
// one encoder rather than allocating a `new TextEncoder()` per keystroke. The
// resulting `Uint8Array` is passed straight to `pty_write` (Tauri v2 ships typed
// arrays to a `Vec<u8>` command directly), avoiding the per-key `Array.from`.
const PTY_ENCODER = new TextEncoder();
const PTY_DECODER = new TextDecoder();

/** Rows above the live screen still searched for a sign-in link: a flow that
 *  printed a few lines after the link must not lose its card. */
const SIGN_IN_SCROLLBACK_ROWS = 20;
/** How far above a hovered row a hard-wrapped URL may have started. */
const WRAPPED_URL_LOOKBACK_ROWS = 40;
/** How long a click on a link waits before opening it: a second click in that
 *  time makes it a double-click, which copies the link instead. */
const LINK_OPEN_DELAY_MS = 300;

/** Whether a pane-level mouse event came from the sign-in card, which the
 *  terminal's own mouse handling must leave alone. */
function fromSignInCard(e: Event): boolean {
  return e.target instanceof Element && !!e.target.closest(`.${SIGN_IN_CARD_CLASS}`);
}

interface PtyScrollback {
  data: string;
  startOffset: number;
  endOffset: number;
}

/** Keep only bytes newer than an atomic backend scrollback snapshot. */
export function outputAfterScrollback(
  data: string,
  range: TerminalOutputRange | undefined,
  snapshotEnd: number | undefined,
): string {
  if (!range || snapshotEnd === undefined) return data;
  if (range.endOffset <= snapshotEnd) return "";
  if (range.startOffset >= snapshotEnd) return data;
  const cut = snapshotEnd - range.startOffset;
  return PTY_DECODER.decode(PTY_ENCODER.encode(data).slice(cut));
}

interface Props {
  id: string;
  cmd: string;
  args?: string[];
  env?: Record<string, string>;
  initialInput?: string;
  cwd: string;
  // When true, never run this tab over ssh even for remote projects (e.g.
  // locally-bound Ollama agents). Forwarded to the backend spawn.
  localOnly?: boolean;
  // When true, run this (agent) tab inside a Docker sandbox that mounts only the
  // project dir. Set only for agent tabs of a sandbox-enabled local project.
  sandbox?: boolean;
  // The owning project's id for a project-scope tab (null/undefined for the root
  // scope and connection terminals). Forwarded to the backend spawn so it can
  // detect remoteness explicitly (resolve the project's RemoteSpec) instead of
  // sniffing the cwd. Harmless for local projects — they resolve to no remote.
  projectId?: string | null;
  // Which of the project's remote hosts this tab runs on (multi-host remote,
  // `docs/multi_host_remote_plan.md`): "primary" / undefined for the primary
  // remote, a worker id for a `host:<id>` locality. Forwarded to the backend so
  // it resolves the right worker's RemoteSpec. Ignored for local projects/tabs.
  remoteHostId?: string | null;
  // Persistent remote sessions (TODO #85): the stable tmux session name to spawn-
  // or-attach this remote spawn into, so the run survives an SSH drop / relaunch.
  // Set only for remote shell/script tabs of a persist-enabled project. No-op locally.
  tmuxSession?: string | null;
  // Attach this tab to an existing named tmux session instead of spawning one
  // (TODO #85 Sessions view). Takes precedence over `tmuxSession`. No-op locally.
  tmuxAttach?: string | null;
  /** Host-bound marker id (#150) — see `lib/remote/hostBound.ts`. */
  hostBoundUid?: string | null;
  /** The root console's Host session: spawned unfenced in Tabtivity's `host`
   *  home (`PtyOptions.host_session`). Honoured by the backend only with no
   *  project id. */
  hostSession?: boolean;
  // Whether this pane is laid out on screen (single-mode active tab, or any
  // pane in grid mode). Drives display + xterm fit.
  visible: boolean;
  // Whether this pane holds keyboard focus / shows the active highlight.
  focused: boolean;
  // #42: ATTACH-ONLY mode for the detached subwindow. The detached window opens
  // a SECOND TerminalView for the SAME PTY id (output is broadcast via app.emit,
  // so it just also receives the stream). It must NOT spawn the PTY (that would
  // kill+respawn the live one, destroying scrollback) and must NOT kill it on
  // unmount (the main window's still-mounted pane owns the PTY lifetime). Such a
  // terminal opens blank and only shows output produced AFTER it attached.
  attachOnly?: boolean;
  // When true (agent tabs), the pane is font-zoomable: Ctrl+wheel and
  // Ctrl +/-/0 scale the font, with the level shared across all agent panes.
  zoomable?: boolean;
  // When true, do NOT kill the PTY when this view unmounts. Used by the
  // non-headless connection terminals embedded in the project dialog: the
  // OpenVPN/SSH login they run must outlive the dialog (the new project relies
  // on the tunnel/master being up), so closing the dialog leaves the PTY
  // running rather than tearing the connection down. This view owns the PTY
  // (it spawns it, unlike `attachOnly`), it just declines to reap it on unmount.
  persistOnUnmount?: boolean;
  /** The tab-store kind. Threaded explicitly so custom/local agent launchers
   * receive the restriction even when their command name is not recognisable. */
  kind?: TabKind;
  /** Stable local-only target id for per-tab scheduled prompts. */
  scheduleTargetId?: string;
  /** Bumped to respawn the PTY in place (`relaunchTabInScope`). */
  relaunchSeq?: number;
}

function terminalTheme(scheme: string | undefined) {
  // "system" never reaches the CSS unresolved (stores/settings.applyTheme
  // resolves it against the OS preference) and must not reach this mapping
  // unresolved either — the terminal is the largest surface in the window, and
  // an unrecognized scheme here would silently paint the fancy_dark palette
  // inside a light window. (An OS flip while the app is open re-themes the
  // window live but an open terminal only on its next theme write — accepted.)
  return terminalPalette(scheme ? resolveTheme(scheme) : scheme);
}

// While a pane is hidden its PTY output is buffered instead of written into
// xterm — before the first open because xterm has no renderer to write into,
// and for every hidden spell after it because a `display: none` pane still
// pays full escape-sequence parsing + render scheduling per chunk. With many
// parallel agent tabs streaming (Tabtivity's normal shape) that made background
// tabs the renderer's biggest standing cost. The buffer flushes when the pane
// is next shown; agent TUIs repaint whole screens, so the flush converges on
// the current frame. Cap the retained text so a chatty background agent can't
// grow this without bound; xterm trims to its own scrollback on flush anyway.
const PENDING_OUTPUT_CAP = 1_000_000;

/** How long an OPEN pane must stay hidden before its renderer addon is
 *  released. The canvas renderer keeps four full-pane canvases (text,
 *  selection, link, cursor) whose backing stores stay allocated under
 *  `display: none` — ~4 × width × height × 4 bytes at device pixels, about
 *  30 MB for a 1800×1100 pane — and the WebGL renderer holds a GL context the
 *  browser evicts once too many are live. Every tab of every open project
 *  stays mounted, so a session with several projects carried that for every
 *  terminal ever shown. Releasing the addon leaves xterm's paused DOM renderer
 *  in place; the buffer, scrollback, selection and PTY are untouched, and the
 *  addon is re-loaded the moment the pane is shown again (the same swap a
 *  WebGL context loss or the renderer flag already performs). The delay keeps
 *  ordinary tab flipping from paying the re-load. */
export const RENDERER_RELEASE_MS = 60_000;

// Agent-terminal zoom. Agent TUIs (Claude, Codex, …) render dense layouts, so
// zoomable agent panes let the user scale the font with Ctrl+wheel / Ctrl +/-/0.
// The chosen size is a single global preference (one knob for every agent pane),
// persisted in localStorage — mirrors the view-pref pattern used by FileTree /
// GitHistory — and broadcast on a window event so all open agent panes restyle
// live, not just the one being scrolled. Non-agent shells keep the fixed default.
const AGENT_FONT_KEY = storageKey("agentTermFontSize");
const AGENT_ZOOM_EVENT = "app-agent-zoom";
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;
/** How long a tab must have been quiet before a scheduled prompt may be typed
 *  into it. Shared by the local arming and the digest-backed fallback below so
 *  a hidden pane is held to the same cushion as a visible one. */
const SCHEDULED_SETTLE_MS = 1200;
/** How long after an agent tab's auto-typed line is submitted the keystrokes
 *  held back meanwhile are replayed — a beat for the TUI to clear its box. */
const HELD_INPUT_FLUSH_MS = 300;
/** Longest an agent tab holds the user's keystrokes back waiting to type its
 *  launch line (boot wait is capped at 5 s after ready; this covers a slow
 *  spawn too). Past it the hold lifts and what was held is dropped. */
const HOLD_INPUT_MAX_MS = 15000;

function clampFontSize(n: number): number {
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(n)));
}

function readAgentFontSize(): number {
  try {
    const raw = localStorage.getItem(AGENT_FONT_KEY);
    if (raw) return clampFontSize(parseInt(raw, 10) || DEFAULT_FONT_SIZE);
  } catch {
    /* ignore storage failures */
  }
  return DEFAULT_FONT_SIZE;
}

/** Remove the xterm elements from a pane container, and only those. The pane's
 *  cards (sign-in, undo clear, version drift, key-select legend) are React
 *  portals into the same node: removing one behind React's back makes React's
 *  own removal throw `NotFoundError` when the card later unmounts — on a tab
 *  close that aborts the whole window's tree (a black main window). */
function sweepXtermElements(container: HTMLElement) {
  for (const el of Array.from(container.children)) {
    if (el.classList.contains("xterm")) el.remove();
  }
}

export function TerminalView({ id, cmd, args = [], env = {}, initialInput, cwd, localOnly = false, sandbox = false, projectId = null, remoteHostId = null, tmuxSession = null, tmuxAttach = null, hostBoundUid = null, hostSession = false, visible, focused, attachOnly = false, zoomable = false, persistOnUnmount = false, kind: declaredKind, scheduleTargetId, relaunchSeq = 0 }: Props) {
  const viewerId = useRef(crypto.randomUUID()).current;
  const viewerUpdateSeq = useRef(0);
  const colorScheme = useSettingsStore((s) => s.settings?.color_scheme);
  const containerRef = useRef<HTMLDivElement>(null);
  // The pane's element for the overlays drawn into it (Reader, cards), as
  // state: a ref read while rendering is null on the first render, and a pane
  // nothing re-renders afterwards (a new Claude tab, its session id fixed at
  // spawn) would open on its terminal although its CLI's choice is the Reader.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => setHost(containerRef.current), []);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenOutput = useRef<(() => void) | null>(null);
  const unlistenReplay = useRef<(() => void) | null>(null);
  const unlistenReady = useRef<(() => void) | null>(null);
  const unlistenExit = useRef<(() => void) | null>(null);
  const initialInputSent = useRef(false);
  const initialInputPending = useRef(false);
  const initialEnterTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openWatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silentStartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstOutputAt = useRef<number | null>(null);
  const scheduledReady = useRef(false);
  const terminalReadySeen = useRef(false);
  const scheduledSettleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // xterm crashes if opened/written into a zero-size or display:none element
  // (its renderer never initializes, so syncScrollArea dereferences undefined).
  // Panes start hidden — and even the active pane is display:none until its rect
  // is measured — so we defer term.open()/fit() until the container has a layout
  // box, buffering PTY output until then. `doFitRef` lets the visibility effect
  // reach the open/fit logic that lives in the mount effect's scope.
  const openedRef = useRef(false);
  const pendingOutput = useRef("");
  const doFitRef = useRef<(() => void) | null>(null);
  // Renderer hibernation (see RENDERER_RELEASE_MS): the `visible` effect's way
  // into the mount effect's renderer manager.
  const rendererVisibilityRef = useRef<((visible: boolean) => void) | null>(null);
  const visibleRef = useRef(visible);
  // Announcement text for an accepted OSC 52 clipboard write, held in a ref because
  // the OSC handler is registered once inside the setup effect (see below).
  const t = useT();
  const clipboardNoticeRef = useRef(t("terminal.clipboardSetByProgram"));
  clipboardNoticeRef.current = t("terminal.clipboardSetByProgram");
  // What a user-made copy announces itself with (see `copyToClipboard` in the
  // mount effect). Under an agent TUI the highlight a drag leaves is wiped by
  // the program's next repaint within milliseconds, so without a word from the
  // app the copy looks like nothing happened — and Ctrl+Shift+C never showed
  // anything at all.
  const copiedNoticeRef = useRef<(text: string) => string>(() => "");
  copiedNoticeRef.current = (text) => {
    const lines = text.split("\n").length;
    return lines > 1 ? t("terminal.copiedLines", { n: lines }) : t("terminal.copiedChars", { n: text.length });
  };
  // What a tab still blank SILENT_START_MS after its launch says (see the timer
  // armed beside the spawn below); a ref for the same reason as the two above.
  const silentStartTextRef = useRef<(kind: SilentStartNotice, program: string) => string>(() => "");
  silentStartTextRef.current = (kind, program) =>
    t(kind === "pending" ? "terminal.silentStartPending" : "terminal.silentStartNoOutput", {
      program: program || t("terminal.silentStartShell"),
      s: SILENT_START_MS / 1000,
    });
  // What the pane says when the Windows "full rights" acceptance was declined.
  const unfencedDeclinedTextRef = useRef<() => string>(() => "");
  unfencedDeclinedTextRef.current = () => t("unfencedPlatform.declined");
  // A clicked link never opens straight away: the user confirms the exact URL
  // first, since anything a program prints can be a link. Refs, because the
  // spawn effect below outlives renders.
  const { dialogs, confirmAction } = useDialogs();
  const confirmLinkRef = useRef<(url: string) => Promise<boolean>>(() => Promise.resolve(false));
  confirmLinkRef.current = (url) => {
    const spec: ConfirmSpec = {
      title: (
        <>
          {t("terminal.openLink.title")}
          <UntestedTag id="terminal.openLink.title" />
        </>
      ),
      body: (
        <>
          {t("terminal.openLink.body")}
          <code className="file-delete-path" style={{ display: "block", marginTop: 8 }}>{url}</code>
        </>
      ),
      confirmLabel: t("terminal.openLink.confirm"),
    };
    return confirmAction(spec);
  };

  // The sign-in link the program on screen is waiting on (see
  // `TerminalSignInCard`), and the links the user already closed the card for.
  const [signIn, setSignIn] = useState<SignInRequest | null>(null);
  // The session in this pane was just cleared: offer to take it back.
  const undoClearOffered = useAgentClearUndoStore((state) => !!state.cleared[id]);
  // Over the Reader, only once it has let go of the cleared chat (its mark).
  const readerCleared = useAgentClearUndoStore((state) => state.marks[id] !== undefined);
  const dismissedSignIns = useRef(new Set<string>());
  const signInCopiedRef = useRef(t("terminal.signIn.copied"));
  signInCopiedRef.current = t("terminal.signIn.copied");
  const linkCopiedRef = useRef(t("terminal.linkCopied"));
  linkCopiedRef.current = t("terminal.linkCopied");
  // What a copy the clipboard refused says — a copy must never fail silently,
  // or the user pastes the old contents and learns nothing.
  const copyFailedRef = useRef(t("terminal.copyFailed"));
  copyFailedRef.current = t("terminal.copyFailed");
  // Keyboard select (Ctrl+Shift+X) is on: shows its key legend over the pane.
  const [keySelecting, setKeySelecting] = useState(false);

  // Path links (`lib/terminal/pathLinks`), read by the link provider through
  // a ref: it lives in the spawn effect, which must not respawn on a settings
  // or project change.
  const pathLinkContext = usePathLinkContext(projectId, cwd);
  const pathLinkContextRef = useRef(pathLinkContext);
  pathLinkContextRef.current = pathLinkContext;
  const tRef = useRef(t);
  tRef.current = t;
  const [pathHover, setPathHover] = useState<PathLinkHover | null>(null);

  const focusedRef = useRef(focused);
  visibleRef.current = visible;
  focusedRef.current = focused;
  // The live colour scheme, readable from inside the spawn effect without being
  // one of its deps — that effect owns the PTY, so listing `colorScheme` there
  // would respawn every terminal on a theme change. `tryOpen` reads it to adopt
  // whatever the scheme became while the pane was still closed.
  const colorSchemeRef = useRef(colorScheme);
  colorSchemeRef.current = colorScheme;
  // Same bargain for the renderer choice: the flag must not be a dep of the
  // spawn effect (a settings flip must never respawn a PTY), and settings load
  // asynchronously, so the first panes of a session open before the flag is
  // even known. `applyRendererRef` lets the flag effect below re-pick the
  // renderer of an already-open terminal in place.
  const webglWanted = useExperimental("terminal_webgl");
  const webglWantedRef = useRef(webglWanted);
  webglWantedRef.current = webglWanted;
  const applyRendererRef = useRef<((wantWebgl: boolean) => void) | null>(null);
  const argsKey = JSON.stringify(args);
  const envKey = JSON.stringify(env);

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    initialInputSent.current = false;
    initialInputPending.current = !!initialInput;
    scheduledReady.current = false;
    terminalReadySeen.current = false;

    const term = new Terminal({
      scrollback: 5000,
      allowProposedApi: false,
      // macOS reads Option+click, and only Option+click, as "select even though
      // the program has grabbed the mouse" (see FORCE_SELECTION_MODIFIER) — and
      // only while this option is on. Off, an agent pane on a Mac would have no
      // way at all to select the agent's output back out of a mouse-driven TUI.
      macOptionClickForcesSelection: true,
      cursorBlink: true,
      fontSize: zoomable ? readAgentFontSize() : DEFAULT_FONT_SIZE,
      // 'JetBrains Mono Variable' is bundled (fontsource, imported in main.tsx)
      // so it's always available; the rest of the stack is the fallback for a
      // renderer that can't load it — Consolas/Cascadia Mono are the guaranteed
      // Windows monospace fonts, kept ahead of the generic fallback so the
      // terminal isn't a bitmap font there.
      fontFamily:
        "'JetBrains Mono Variable', 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Cascadia Mono', Consolas, Menlo, monospace",
      theme: terminalTheme(colorScheme),
    });

    const fit = new FitAddon();
    // A click on a link opens it once the double-click window has passed; a
    // double-click copies it instead (see `onMouseDownCapture`, which takes the
    // second press away from xterm and from the agent pane's paste). xterm
    // activates a link on each release, so the double-click's second release
    // (`detail` 2) is ignored here. The hovered link is tracked because the
    // second press has to know it is on one before xterm sees it. Opening
    // always asks first (`confirmLinkRef`).
    let hoveredLink: string | null = null;
    let linkOpenTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelLinkOpen = () => {
      if (linkOpenTimer) clearTimeout(linkOpenTimer);
      linkOpenTimer = null;
    };
    const activateLink = (event: MouseEvent, url: string) => {
      if (event.detail > 1) return;
      cancelLinkOpen();
      linkOpenTimer = setTimeout(() => {
        linkOpenTimer = null;
        void confirmLinkRef.current(url).then((ok) => {
          if (ok) return invoke("open_external_url", { url });
        }).catch(() => {});
      }, LINK_OPEN_DELAY_MS);
    };
    const linkHover = {
      hover: (_e: MouseEvent, url: string) => {
        hoveredLink = url;
      },
      leave: () => {
        hoveredLink = null;
      },
    };
    const links = new WebLinksAddon(activateLink, linkHover);
    // A URL an agent CLI cut across rows with hard newlines (a sign-in link,
    // above all) is one link on every row it covers, opened whole. Registered
    // before the web-links addon because the first provider with a link at the
    // cell wins; it answers nothing for a URL that fits one row.
    const wrappedLinks = term.registerLinkProvider({
      provideLinks(row, reply) {
        const buf = term.buffer.active;
        const y = row - 1;
        const hits = findWrappedUrls((n) => buf.getLine(n), term.cols, y - WRAPPED_URL_LOOKBACK_ROWS, y).filter(
          (u) => u.start.y <= y && u.end.y >= y,
        );
        if (!hits.length) return reply(undefined);
        reply(
          hits.map((u) => ({
            range: { start: { x: u.start.x + 1, y: u.start.y + 1 }, end: { x: u.end.x, y: u.end.y + 1 } },
            text: u.url,
            activate: activateLink,
            hover: (e: MouseEvent) => linkHover.hover(e, u.url),
            leave: linkHover.leave,
          })),
        );
      },
    });
    // A file path the program printed opens the file's tab, on the same click
    // (after the double-click window) — no question first, since it only ever
    // opens an in-app viewer of a file inside the tab's folder or project; a
    // double-click copies it, like a URL.
    const pathLinks = registerPathLinkProvider(term, () => pathLinkContextRef.current, {
      activate: (event, entry, at) => {
        if (event.detail > 1) return;
        cancelLinkOpen();
        setPathHover(null);
        linkOpenTimer = setTimeout(() => {
          linkOpenTimer = null;
          const ctx = pathLinkContextRef.current;
          const scope = splitPtyId(id)?.scope ?? ROOT_SCOPE;
          openPathLink(entry, at, { scope, projectId, projectDir: ctx.projectDir, cwd, disabled: ctx.disabled, t: tRef.current });
        }, LINK_OPEN_DELAY_MS);
      },
      hover: (event, entry, at, text) => {
        hoveredLink = text;
        const ctx = pathLinkContextRef.current;
        const name = relativePathWithin(ctx.projectDir || cwd, entry.path) || entry.path;
        setPathHover({ left: event.clientX, top: event.clientY - 4, name, line: at.line, isDir: entry.is_dir });
      },
      leave: () => {
        hoveredLink = null;
        setPathHover(null);
      },
    });
    // OSC 8 hyperlinks (a link whose text is not its URL) take the same path;
    // xterm's own handler would ask with a native box and `window.open` it.
    term.options.linkHandler = { activate: activateLink, hover: linkHover.hover, leave: linkHover.leave };
    term.loadAddon(fit);
    term.loadAddon(links);

    // Watch the screen for a sign-in link (`findSignInRequest`) and show the
    // card while one is up. Only parsed output triggers a look — a hidden pane
    // parses nothing (see `writeTerm`) and catches up when shown — and the look
    // is coalesced so a streaming agent costs one scan per 300 ms at most. The
    // card goes away with the link: a login that succeeded redraws the screen.
    setSignIn(null);
    let signInScanTimer: ReturnType<typeof setTimeout> | null = null;
    const scanForSignIn = () => {
      signInScanTimer = null;
      const buf = term.buffer.active;
      const found = findSignInRequest(
        (n) => buf.getLine(n),
        term.cols,
        buf.baseY - SIGN_IN_SCROLLBACK_ROWS,
        buf.baseY + term.rows - 1,
      );
      const next = found && !dismissedSignIns.current.has(found.url) ? found : null;
      setSignIn((prev) =>
        prev?.url === next?.url && prev?.wantsCode === next?.wantsCode ? prev : next,
      );
    };
    const signInWatch = term.onWriteParsed(() => {
      signInScanTimer ??= setTimeout(scanForSignIn, 300);
    });

    termRef.current = term;
    registerTerminal(id, term);
    fitRef.current = fit;
    openedRef.current = false;
    pendingOutput.current = "";

    // Which renderer paints this terminal — the scroll-performance ladder.
    // xterm's default DOM renderer rebuilds styled spans for every visible row
    // on each scroll step, which under WebKitGTK with GPU compositing disabled
    // (WEBKIT_DISABLE_DMABUF_RENDERER=1) makes scrolling densely colored agent
    // output very slow — so every terminal gets the canvas renderer (glyph
    // cache, no DOM/layout work, still on the safe software path). WebGL is
    // the faster tier but rides the same GPU/driver territory the DMABUF
    // re-test failed on (docs/typing_latency_plan.md Step 4), so it is opt-in
    // via the `terminal_webgl` experimental flag and demotes itself: a
    // construction/load failure falls back to canvas in the same call, and a
    // context lost at runtime (driver reset, or the browser evicting the
    // oldest of too many live contexts — every open pane holds one) disposes
    // the addon and reloads canvas. A renderer must never take the terminal
    // down; canvas failing too (jsdom has no canvas at all) leaves the DOM
    // renderer. term.dispose() in the cleanup disposes whichever addon is
    // loaded, so no teardown is kept here.
    let canvasAddon: CanvasAddon | null = null;
    let webglAddon: WebglAddon | null = null;
    const dropCanvas = () => {
      if (!canvasAddon) return;
      const addon = canvasAddon;
      canvasAddon = null;
      try {
        addon.dispose();
      } catch {
        /* already torn down */
      }
    };
    const dropWebgl = () => {
      if (!webglAddon) return;
      const addon = webglAddon;
      webglAddon = null;
      try {
        addon.dispose();
      } catch {
        /* already torn down */
      }
    };
    const loadCanvas = () => {
      if (canvasAddon) return;
      try {
        canvasAddon = new CanvasAddon();
        term.loadAddon(canvasAddon);
      } catch {
        dropCanvas();
      }
    };
    // Hibernation state: true while a long-hidden pane has had its renderer
    // addon released (RENDERER_RELEASE_MS). While set, `applyRenderer` stands
    // down — a renderer-flag flip on a hidden pane would otherwise re-allocate
    // what was just released; `restoreRenderer` picks the current flag on show.
    let rendererReleased = false;
    let releaseTimer: ReturnType<typeof setTimeout> | null = null;
    const applyRenderer = (wantWebgl: boolean) => {
      if (cancelled || !openedRef.current || rendererReleased) return;
      if (wantWebgl) {
        if (webglAddon) return;
        dropCanvas();
        try {
          webglAddon = new WebglAddon();
          webglAddon.onContextLoss(() => {
            dropWebgl();
            loadCanvas();
          });
          term.loadAddon(webglAddon);
        } catch {
          dropWebgl();
          loadCanvas();
        }
      } else {
        dropWebgl();
        loadCanvas();
      }
    };
    applyRendererRef.current = applyRenderer;
    const releaseRenderer = () => {
      releaseTimer = null;
      if (cancelled || !openedRef.current || visibleRef.current) return;
      if (!canvasAddon && !webglAddon) return;
      dropWebgl();
      dropCanvas();
      rendererReleased = true;
    };
    const restoreRenderer = () => {
      if (releaseTimer) {
        clearTimeout(releaseTimer);
        releaseTimer = null;
      }
      if (!rendererReleased) return;
      rendererReleased = false;
      applyRenderer(webglWantedRef.current);
    };
    rendererVisibilityRef.current = (nowVisible: boolean) => {
      if (nowVisible) {
        restoreRenderer();
        return;
      }
      if (releaseTimer || rendererReleased || !openedRef.current) return;
      releaseTimer = setTimeout(releaseRenderer, RENDERER_RELEASE_MS);
    };

    // THE one way buffered output reaches xterm — every catch-up goes through
    // here, never through a bare `term.write`, because output written late is
    // not the same thing as output written live. A terminal *query* in it
    // (`ESC[>c` and friends) is answered by xterm the moment it is finally
    // parsed, and that answer goes into the PTY as if typed — which is how
    // `0;276;0c` (tmux's attach probe on a remote shell tab, replayed when the
    // pane was next shown) ends up as text on the shell's command line.
    // `stripTerminalQueries` takes out the queries it knows; `staleParse`
    // counts how much stale output xterm is still parsing so `onData` can
    // refuse the replies to any it doesn't. xterm's write callback fires when
    // that exact chunk is done parsing, so the window is precise rather than a
    // timeout: a live query written afterwards is parsed after the callback, and
    // its reply still reaches the program that asked for it.
    let staleParse = 0;
    // Group B #235: an ATTACH-ONLY view opens a fresh xterm on a PTY that has
    // been running without it — a tab just popped out into its own window, or a
    // pane remounted by a reseed. Until its history has been fetched, nothing
    // may reach the terminal: live chunks are buffered like any catch-up so the
    // fetched tail can be prepended to them. The backend tags both snapshots and
    // events with byte offsets: an event may be delivered during the round trip
    // even though its bytes are already IN the snapshot, so offset filtering is
    // what makes the handoff exactly-once. Cleared by the fetch in either
    // direction — a backend too old to answer must not leave a pane mute.
    let historyPending = attachOnly;
    const historyOutput: Array<{ data: string; range?: TerminalOutputRange }> = [];
    const flushPending = () => {
      if (historyPending) return;
      const buffered = pendingOutput.current;
      if (!buffered) return;
      pendingOutput.current = "";
      const catchUp = stripTerminalQueries(buffered);
      if (!catchUp) return;
      staleParse += 1;
      term.write(catchUp, () => {
        staleParse = Math.max(0, staleParse - 1);
      });
    };

    // Write PTY output to the terminal only while the pane is open AND visible;
    // buffer it otherwise — a hidden pane's xterm still parses and schedules
    // renders for every chunk, which is what background agent tabs must not
    // cost (see PENDING_OUTPUT_CAP). Draining the buffer before a direct write
    // keeps ordering safe even if a chunk lands between the visibility flip
    // and the flush-on-show in doFit.
    const writeTerm = (data: string) => {
      if (openedRef.current && visibleRef.current && !historyPending) {
        flushPending();
        term.write(data);
      } else {
        pendingOutput.current += data;
        // Trim with hysteresis: cutting exactly to the cap on every chunk past
        // it re-copies the whole buffer per chunk (a ~1 MB memcpy up to ~60×/s
        // per chatty hidden tab, forever). Letting it grow to 2× and cutting
        // back to the cap costs one copy per megabyte of new output instead.
        if (pendingOutput.current.length > PENDING_OUTPUT_CAP * 2) {
          pendingOutput.current = pendingOutput.current.slice(-PENDING_OUTPUT_CAP);
        }
      }
    };

    // True only when the container is actually laid out (visible, non-zero size).
    const hasLayout = () => {
      const el = containerRef.current;
      return (
        !!el && el.offsetParent !== null && el.clientWidth > 0 && el.clientHeight > 0
      );
    };

    // Open the terminal into its container the first time the pane is visible and
    // sized, then flush any output buffered while it was hidden.
    const tryOpen = () => {
      if (openedRef.current || cancelled) return;
      if (!visibleRef.current || !hasLayout() || !containerRef.current) return;
      // Sweep the container before opening. Any xterm element still in it is
      // a LEAKED one from an earlier lifecycle whose `dispose()` did not get
      // as far as removing it
      // (see the teardown below). xterm's `open()` unconditionally creates a
      // fresh element and appends it, so without this the leftover survives as a
      // sibling — and since the container is a flex COLUMN, the two split the
      // pane into a live terminal and a frozen one stacked above/below it, each
      // with its own scrollbar and each painting whatever theme it was last
      // given. That is the "one Claude tab, two scrollable halves, one light one
      // dark" report. Clearing here makes the duplicate impossible whatever the
      // dispose failed on. Only xterm elements: a card already portaled in
      // is React's (`sweepXtermElements`).
      sweepXtermElements(containerRef.current);
      term.open(containerRef.current);
      openedRef.current = true;
      // Renderer addons need the opened element — see the manager above.
      applyRenderer(webglWantedRef.current);
      // Adopt the current scheme now that there is a renderer to take it. The
      // terminal was constructed with whatever `colorScheme` was at setup — which
      // is `undefined` on a cold start, since settings load asynchronously — and
      // the theme effect deliberately skips a closed terminal, so without this a
      // pane opened after the settings landed would keep the fallback theme.
      term.options.theme = terminalTheme(colorSchemeRef.current);
      fit.fit();
      flushPending();
      invoke("pty_resize", { id, cols: term.cols, rows: term.rows }).catch(() => {});
      if (focusedRef.current) term.focus();
      // The pane may keep growing right after open — the startup fullscreen
      // transition (especially on a larger screen) and late web-font load both
      // change the final cell geometry after this first fit. Re-fit on the next
      // frame, shortly after, and once fonts settle so cols/rows match the final
      // pane size instead of the size at open time.
      requestAnimationFrame(() => { if (!cancelled) doFitRef.current?.(); });
      setTimeout(() => { if (!cancelled) doFitRef.current?.(); }, 300);
      document.fonts?.ready?.then(() => { if (!cancelled) doFitRef.current?.(); }).catch(() => {});
    };

    // What this tab counts as for the usage recap. A `local_agent` tab always
    // carries its model in the env Tabtivity spawned it with, and that is the only
    // signal here that distinguishes it from the cloud agent of the same command
    // (a local model driven through `vibe` still has cmd "vibe") — TerminalView
    // is handed cmd/env, not the TabEntry's kind.
    const localModel = env[envName("LOCAL_MODEL")] || env.VIBE_ACTIVE_MODEL;
    const kind: TabKind = declaredKind ?? (localModel ? "local_agent" : cmdToKind(cmd));
    const agentLeaf = agentPromptLeaf({ kind, cmd, env });
    // A shell tab can be RESUMED with no initialInput to type — a tmux reattach on
    // reconnect/relaunch. tmux probes the outer terminal on attach (secondary DA,
    // `ESC[>c`); xterm's reply arrives after tmux has handed the pane to the shell,
    // so it lands in readline as `^[[>0;276;0c`. Open the same startup-suppression
    // window (line 226 only opens it for an auto-run tab) for ANY shell tab, closed
    // on the first real keystroke in onData below — so the reattach junk is eaten
    // but a program the user later launches still gets its own identity replies.
    if (kind === "shell") initialInputPending.current = true;
    const scope = splitPtyId(id)?.scope ?? ROOT_SCOPE;

    /** One thing asked: a prompt to an agent, or a command in a shell. */
    const countSubmit = () => {
      if (agentLeaf) {
        bumpUsage(scope, sub(METRIC.AGENT_PROMPT, agentLeaf));
        // "Agent tabs you used today" — once per tab per day, however much you
        // then ask it.
        markAgentActive(scope, id, sub(METRIC.AGENT_ACTIVE, agentLeaf));
      } else if (kind === "shell") {
        bumpUsage(scope, METRIC.SHELL_COMMAND);
      }
    };

    // Scheduler input is registered by the PTY-owning main-window view, and by
    // a popout's view in the popout's own heap — that heap's registry serves
    // only its Chat composer (the schedule hosts run in the main window), so
    // it never becomes a second delivery owner. An attach-only mirror in the
    // main window (root console, overlay column) registers nothing. Readiness
    // waits for terminal-ready plus real TUI output and a short settle
    // cushion, matching the initial-input gate below.
    const takesPrompts = !attachOnly || isDetachedWindow();
    let settledOnce = false;
    const armScheduledReady = () => {
      if (!scheduleTargetId || !takesPrompts || !terminalReadySeen.current || firstOutputAt.current === null) return;
      if (scheduledSettleTimer.current) clearTimeout(scheduledSettleTimer.current);
      scheduledReady.current = false;
      // Every new output chunk restarts the cushion. This closes the short gap
      // before the activity store's sustained-output debounce calls an agent
      // "working": scheduling must still wait until the TUI itself is quiet.
      scheduledSettleTimer.current = setTimeout(() => {
        if (cancelled) return;
        scheduledReady.current = true;
        if (!settledOnce) {
          settledOnce = true;
          wakePhoneHolds();
        }
      }, SCHEDULED_SETTLE_MS);
    };
    /**
     * Whether a scheduled prompt may be typed into this tab right now.
     *
     * The local arming above is driven by `terminal-output`, which a HIDDEN pane
     * never receives at all: the backend streams output only to visible views
     * and condenses the rest into throttled `terminal-activity` digests. So a
     * tab that has not been looked at since it was mounted — every agent tab but
     * the active one after a relaunch — armed nothing, and the scheduler's
     * `ready()` gate stayed false forever: a prompt aimed at it from the Agents
     * view sat queued until it read "missed", while the agent sat idle. Delivery
     * is deliberately not gated on the tab being focused, so readiness must not
     * be either.
     *
     * The fallback reads the same output stamp the digests keep up to date
     * (`stores/activity`, fed app-wide by `AppShell`), and applies the identical
     * settle cushion: terminal-ready, output seen, and quiet since. Panes that do
     * get their own stream keep using the local arming, which is finer-grained
     * than the throttled digest.
     */
    const scheduledInputReady = () => {
      if (scheduledReady.current) return true;
      if (!terminalReadySeen.current) return false;
      const last = lastPtyOutputAt(id);
      return last !== undefined && Date.now() - last >= SCHEDULED_SETTLE_MS;
    };
    /**
     * Whether a phone prompt may be typed while the agent works
     * (`queueableWhileBusy`): the CLI has drawn and gone quiet once. Not the
     * bare terminal-ready event — a brand-new tab is ready before its CLI has
     * started, and what is typed into a CLI still starting is lost (the phone
     * markup's new-tab Submit held its prompt into exactly that window). Once
     * settled it stays so: a working agent redraws without pause.
     */
    const scheduledInputStarted = () => {
      if (!settledOnce && scheduledInputReady()) settledOnce = true;
      return settledOnce;
    };
    const unregisterScheduled = scheduleTargetId && takesPrompts
      ? registerScheduledAgentInput(scheduleTargetId, {
          ptyId: id,
          ready: scheduledInputReady,
          started: scheduledInputStarted,
          bracketedPaste: () => term.modes.bracketedPasteMode === true,
          // The family decides whether the markers are used at all: a prompt
          // pasted into Claude Code arrives as `<pasted_content>` rather than
          // as the question (`bracketsAgentMessage`).
          agent: cmd,
          recordAuthorizedInput: () => {
            noteUserInput(id);
            countSubmit();
          },
          // A prefix command (`/clear`, `/model …`) stamps input so its output
          // reads as this tab working, but is deliberately NOT counted: the
          // usage recap counts prompts asked, and a slash command is not one.
          noteInput: () => noteUserInput(id),
        })
      : undefined;

    /** A keystroke (or paste) of the user's, on its way to the PTY. */
    const forwardInput = (data: string) => {
      // A bare Escape / Ctrl+C is the user cutting the agent off: its hook
      // verdict of "working" would otherwise stand (an interrupted turn fires
      // no Stop) — see noteUserInput.
      //
      // Only a person's keystrokes are stamped. xterm also answers the TUI's
      // queries and sends focus / mouse reports through this same callback
      // (`isTerminalAutoReply`); they reach the PTY like anything else, but
      // stamped as input they read as a prompt the user just submitted, and
      // a scheduled prompt aimed at a tab that was merely clicked into then
      // waited for a Stop that no submission was going to bring.
      if (!isTerminalAutoReply(data)) {
        // Read before the keystroke retires the agent's decision verdict.
        const deciding = useActivityStore.getState().attentionByTab[id] === "decision";
        noteUserInput(id, isInterruptInput(data));
        if (noteInput(id, data) > 0) countSubmit();
        // A typed `/clear` (or `/new`) offers "Undo clear" and empties the
        // Reader — the one way the window learns of it at once (Codex's hook
        // waits for the next prompt). One picked in the CLI's slash popup is
        // read off the screen, which the Enter has not reached yet.
        if ((kind === "agent" || kind === "local_agent") && noteTypedLine(id, data, () => screenAtCursor(term.buffer.active))) {
          noteTypedClear(id);
        }
        // The prompt strip's own reading of what was asked, CLI-blind: a
        // one-key answer or a session command is not a prompt.
        if (kind === "agent" || kind === "local_agent") {
          notePromptTrailInput(id, data, deciding, (text) => text.length > 1 && !isSessionCommand(text));
        }
      }
      writePtyInput(id, PTY_ENCODER.encode(data)).catch(console.error);
    };

    // An agent tab's auto-typed line (Claude's `/rename <project>`, which also
    // names the Remote Control session) is typed a second or more after launch,
    // once the TUI has booted. Anything the user typed in that window landed in
    // the same input box and the two ran together — `/rename Projhello`. So the
    // user's keystrokes are held until that line has been submitted and then
    // replayed in order; the program's own terminal replies (DA, cursor
    // position, focus) still pass straight through, since its boot waits on them.
    // A launch that types nothing after all (trust dialog, already claimed)
    // DROPS what was held: flushed into Claude's trust dialog, an Enter would
    // answer `No, exit`. `HOLD_INPUT_MAX_MS` bounds the hold for a spawn that
    // never reports ready, so the pane can never lock the keyboard for good.
    //
    // A Claude whose version takes `--name` never gets the line typed at all:
    // `pty_spawn` puts the name on the launch argv and answers `named`, and the
    // hold lifts the moment it does. Only a Claude Tabtivity cannot vouch for (a
    // container's or a remote host's, an old or not-yet-probed host CLI) is
    // still typed at. `launchNamed` is null until the spawn has answered.
    const launchName = attachOnly ? null : claudeLaunchName(cmd, initialInput);
    let launchNamed: boolean | null = launchName ? null : false;
    let holdingInput = !attachOnly && !!initialInput && (kind === "agent" || kind === "local_agent");
    const heldInput: string[] = [];
    let holdInputTimer: ReturnType<typeof setTimeout> | null = null;
    const releaseHeldInput = (flush: boolean) => {
      if (!holdingInput) return;
      holdingInput = false;
      if (holdInputTimer) clearTimeout(holdInputTimer);
      const held = heldInput.splice(0);
      if (flush && !cancelled) for (const data of held) forwardInput(data);
    };
    if (holdingInput) holdInputTimer = setTimeout(() => releaseHeldInput(false), HOLD_INPUT_MAX_MS);

    // Wire keyboard input → PTY write. The input stamp is what licenses this
    // tab's later output to show as "working"/"done" (see noteUserInput).
    //
    // This is also the one place Tabtivity sees everything the user asks an agent,
    // so the usage recap's "you asked them N things" is counted here (see
    // lib/agents/promptCount): Enter with content pending = one submit.
    term.onData((data) => {
      if (staleParse > 0 && isTerminalReport(data)) {
        return; // an answer to a query xterm only just parsed out of replayed output
      }
      if (initialInputPending.current && isTerminalIdentityResponse(data)) {
        return; // swallow the startup / tmux-reattach identity reply (see above)
      }
      // A genuine user keystroke — a printable char or Enter, i.e. NOT an
      // ESC-prefixed control — closes the identity-suppression window. Terminal
      // auto-reports (cursor-position `\x1b[…R`, other DA replies) are ALSO delivered
      // through onData and are ESC-prefixed; they must NOT lift the gate, or a late
      // DA2 reply arriving on the tmux-attach probe burst right after one of them
      // would leak to the shell prompt as `^[[>0;276;0c` (the resume bug). A program
      // that needs DA detection is launched by keystrokes, which close the window
      // first, so its own replies still flow through.
      if (initialInputPending.current && data && !data.startsWith("\x1b")) {
        initialInputPending.current = false;
      }
      if (holdingInput && !isTerminalAutoReply(data)) {
        heldInput.push(data); // replayed once the auto-typed line is in (above)
        return;
      }
      forwardInput(data);
    });

    // A terminal bell means the agent wants to be looked at NOW, so it shortcuts
    // the quiet window the activity store otherwise waits out before calling a
    // turn finished. It is only a hint, never the source of truth: agents ring it
    // optionally, and a pane that has never been opened has no xterm to parse it
    // at all. WHAT the agent wants (a decision vs a finished turn) is worked out
    // in the store from the raw output tail — reading the screen here would race
    // the paint, since onBell fires as xterm parses the BEL, before the prompt
    // that follows it in the same chunk has landed in the buffer.
    // xterm fires this only for a real BEL control, not an OSC title terminator,
    // so title changes don't false-trigger. Disposed with `term` on unmount.
    term.onBell(() => {
      useActivityStore.getState().noteBell(id);
    });

    // OSC 52 clipboard write: TUIs (Claude Code's own copy action among them)
    // set the system clipboard by writing `ESC ] 52 ; c ; <base64> BEL/ST`
    // rather than relying on a host-side mouse selection — the standard escape
    // for "copy this over SSH/tmux where the program can't reach the clipboard
    // itself". xterm parses OSC codes but performs no action on 52 without a
    // handler, so the CLI reports success (it only confirms the write *reached
    // the terminal*) while the OS clipboard silently keeps its old contents.
    // `c` is the only target register Tabtivity has one clipboard for; a `?`
    // query (read-back) is intentionally left unhandled — implementing it would
    // let any program read whatever the user last copied elsewhere.
    // Gated rather than trusted: the payload is sanitized and capped by
    // `decodeOsc52Clipboard` (newlines stripped, read-back refused), and the write
    // is allowed only while THIS pane has the keyboard focus — so a background
    // agent, a build script or a remote host cannot silently swap the clipboard
    // out from under whatever the user is actually working in. Every accepted
    // write announces itself in the transient toast, so a clipboard the user did
    // not fill is never a surprise.
    const oscHandler = term.parser.registerOscHandler(52, (data) => {
      if (!focusedRef.current) return true;
      const text = decodeOsc52Clipboard(data);
      if (text === null) return true;
      // Through the backend, not `navigator.clipboard`: this write comes with PTY
      // output, not from a click or key, so the webview refuses it (see
      // `copy_text_to_clipboard`). Announced only once the backend took it.
      invoke("copy_text_to_clipboard", { text })
        .then(() => useProjectsStore.setState({ switchToast: clipboardNoticeRef.current }))
        .catch(() => {});
      return true;
    });

    // Copy-on-select: a mouse-made selection (drag, double/triple-click) copies
    // itself to the clipboard with no chord needed, matching most native
    // terminals. xterm fires `onSelectionChange` once, from inside its own
    // mouseup handler, so the copy is made right there. Right-click on a
    // selection, Ctrl+Shift+C and keyboard select copy explicitly.
    //
    // The copied text rejoins the rows tmux and the agent CLIs wrapped
    // (`copyableSelection`); an Alt-drag column selection is copied as drawn.
    // Every copy the user makes goes through here so each one is announced in
    // the same transient toast the OSC 52 path uses, once the clipboard took it
    // — and a refused one says so.
    //
    // Through the backend first, like OSC 52: the webview's `navigator.clipboard`
    // writes only while WebKit still counts the press as a user gesture, and it
    // dropped some mouse-up copies outright — the "copy works sometimes" report.
    // The webview stays as the fallback (and for text past the backend's cap).
    const copyToClipboard = (text: string) => {
      const copied = () => useProjectsStore.setState({ switchToast: copiedNoticeRef.current(text) });
      invoke("copy_text_to_clipboard", { text })
        .then(copied)
        .catch(() => (navigator.clipboard ? navigator.clipboard.writeText(text).then(copied) : Promise.reject()))
        .catch(() => useProjectsStore.setState({ switchToast: copyFailedRef.current }));
    };
    let columnSelect = false;
    // Keyboard select (see lib/terminal/keyboardSelect): the cursor and anchor
    // while the mode is on, drawn with xterm's own selection. Its steps are not
    // copies, so copy-on-select stands aside until Enter copies the result.
    let keySelect: KeySelectState | null = null;
    term.onSelectionChange(() => {
      if (keySelect) return;
      const sel = copyableSelection(term, columnSelect);
      if (sel) copyToClipboard(sel);
    });
    // Mouse-mode escapes from the program would otherwise wipe a selection —
    // mid-drag included — whenever they arrive (see `installMouseModeGuard`).
    const mouseModeGuard = installMouseModeGuard(term);

    const drawKeySelect = () => {
      if (!keySelect) return;
      const { column, row, length } = keySelectHighlight(keySelect, term.cols);
      term.select(column, row, length);
      const top = scrollToShow(keySelect.cursor.y, term.buffer.active.viewportY, term.rows);
      if (top !== null) term.scrollToLine(top);
    };
    const enterKeySelect = () => {
      const buf = term.buffer.active;
      keySelect = startKeySelect({ x: buf.cursorX, y: buf.baseY + buf.cursorY }, term.getSelectionPosition(), term.cols);
      setKeySelecting(true);
      drawKeySelect();
    };
    const leaveKeySelect = () => {
      if (!keySelect) return;
      keySelect = null;
      setKeySelecting(false);
      term.clearSelection();
    };
    // Copy what keyboard select holds (the cursor's row when nothing is
    // anchored) and leave the mode.
    const copyKeySelect = () => {
      if (!keySelect) return;
      const buf = term.buffer.active;
      const text = joinedSelectionText((y) => buf.getLine(y), term.cols, keySelectRange(keySelect, term.cols));
      leaveKeySelect();
      if (text.trim()) copyToClipboard(text);
    };
    const onKeySelectKey = (e: KeyboardEvent) => {
      if (!keySelect || e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
      const buf = term.buffer.active;
      const step = keySelectStep(keySelect, e, {
        cols: term.cols,
        rows: term.rows,
        length: buf.length,
        lineText: (y) => buf.getLine(y)?.translateToString(true) ?? "",
      });
      if (step.kind === "move") {
        keySelect = step.state;
        drawKeySelect();
      } else if (step.kind === "copy") copyKeySelect();
      else if (step.kind === "exit") leaveKeySelect();
    };

    // Paste the OS clipboard into the running program. `term.paste` rather than a
    // raw `writePtyInput`: it normalizes newlines to CR and — when the program
    // asked for bracketed paste, as every agent TUI does — wraps the text in the
    // `ESC[200~ … ESC[201~` markers that tell it "this is pasted, not typed". A
    // multi-line paste then lands in the composer as one block instead of a burst
    // of Enters that submits the first line and types the rest into what it
    // opened. The text leaves through xterm's own `onData` handler above, so it
    // counts as user input exactly like a keystroke does.
    const pasteClipboard = () => {
      navigator.clipboard
        ?.readText()
        .then((text) => {
          if (text) term.paste(text);
        })
        .catch(() => {});
    };

    // Agent CLIs set the terminal title (OSC 0/2) to a short summary of what
    // they're doing — the same signal a native terminal shows in its tab. Capture
    // it per tab so the tab hover card can surface it as the agent task summary.
    // Disposed with `term` on unmount.
    term.onTitleChange((title) => {
      useAgentTaskStore.getState().setTabTitle(id, title);
    });

    // Copy/paste: xterm binds neither itself, so without this the terminal has no
    // way to copy a selection (the agent-terminal "can't copy" report). Use the
    // standard terminal chords — Ctrl+Shift+C copies the current selection, Ctrl+
    // Shift+V pastes clipboard text into the PTY — and deliberately leave plain
    // Ctrl+C alone so it still sends SIGINT to the running program (interrupting
    // an agent). Returning false swallows the chord so xterm doesn't also forward
    // it to the PTY as a control sequence.
    // Apply a new font size to this pane and (when `persist`) save + broadcast it
    // so every other open agent pane restyles to match. Refit on the next frame:
    // xterm needs a beat to re-measure the cell after fontSize changes before
    // FitAddon can read the new geometry.
    const applyFontSize = (size: number, persist: boolean) => {
      const next = clampFontSize(size);
      if (next !== term.options.fontSize) {
        term.options.fontSize = next;
        requestAnimationFrame(() => { if (!cancelled) doFitRef.current?.(); });
      }
      if (persist) {
        try {
          localStorage.setItem(AGENT_FONT_KEY, String(next));
        } catch {
          /* ignore storage failures */
        }
        window.dispatchEvent(new CustomEvent<number>(AGENT_ZOOM_EVENT, { detail: next }));
      }
    };

    // Codex is the one agent whose Shift+Tab has to be re-encoded on its way to
    // the PTY; resolved once here from the pane's command.
    const csiUShiftTab = isCodexCommand(cmd);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Keyboard select owns every key while it is on: nothing reaches the
      // program (so an arrow never moves the agent's own cursor) and nothing
      // bubbles to the window's chords (Esc leaves the mode, not fullscreen).
      if (keySelect) {
        e.preventDefault();
        e.stopPropagation();
        onKeySelectKey(e);
        return false;
      }
      // Ctrl +/-/0 zoom (agent panes only). preventDefault stops WebKit's own
      // page-zoom; returning false stops xterm forwarding the chord to the PTY;
      // stopPropagation stops the WINDOW-level per-window zoom handler (useKeyboard
      // / DetachedApp) from ALSO webview-zooming — an agent pane zooms its FONT, not
      // the whole window.
      const overrides = useSettingsStore.getState().settings?.keyboard_shortcuts as ShortcutMap | undefined;
      const zoom = zoomable ? zoomFor(e, overrides) : null;
      if (zoom) {
        const cur = term.options.fontSize ?? DEFAULT_FONT_SIZE;
        e.preventDefault();
        e.stopPropagation();
        applyFontSize(zoom === "in" ? cur + 1 : zoom === "out" ? cur - 1 : DEFAULT_FONT_SIZE, true);
        return false;
      }
      // Ctrl+Shift+←/→ (as bound): the pane's previous / next tab. Left unhandled
      // so xterm neither sends it to the PTY nor cancels it, and the window's
      // keyboard handler steps the tab (lib/shortcuts/terminalTabChord). Plain
      // Shift+←/→ is deliberately left alone — an agent CLI (Codex) uses it.
      // F11 (the window's fullscreen toggle, as bound) is handed over the same way.
      if (terminalYieldsChord(e, overrides)) return false;
      // Shift+Tab in a Codex pane. xterm.js would send the legacy backtab, which
      // Codex's permission-mode cycle does not recognize — send the CSI-u form of
      // Tab+Shift it does read instead (see terminalControl.shiftTabForAgent).
      // Every other agent cycles on the backtab, so nothing else is re-encoded.
      if (csiUShiftTab && e.code === "Tab" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        noteUserInput(id);
        writePtyInput(id, PTY_ENCODER.encode(CSI_U_SHIFT_TAB)).catch(console.error);
        return false;
      }
      // Copy / paste / keyboard select — Ctrl+Shift+C / V / X unless rebound
      // (`terminalChordFor`). preventDefault on each: returning false only
      // stops xterm, not the webview. WebKitGTK binds Ctrl+Shift+V to its own
      // paste command, whose native `paste` event lands on xterm's textarea
      // and pastes a second copy next to pasteClipboard's (the "pastes twice"
      // report).
      const termChord = terminalChordFor(e, overrides);
      if (termChord) {
        e.preventDefault();
        if (termChord === "terminalCopy") {
          const sel = copyableSelection(term, columnSelect);
          if (sel) copyToClipboard(sel);
        } else if (termChord === "terminalPaste") {
          pasteClipboard();
        } else {
          enterKeySelect();
        }
        return false;
      }
      return true;
    });

    // Subscribed by id through the shared bus (lib/terminal/terminalBus) rather than each
    // pane calling `listen()` itself — the backend emits these window-wide, not
    // scoped per PTY, so one `listen()` per mounted terminal meant every output
    // chunk from every running PTY was dispatched to and filtered by every
    // mounted terminal (CenterPanel keeps every loaded active scope mounted).
    // The bus does that dispatch once, in O(1) per id, no matter how many panes
    // are mounted. Subscribing is synchronous, so these are wired up before
    // `setupAndSpawn` below ever awaits `pty_spawn` — no output can arrive first.
    unlistenOutput.current = onTerminalOutput(id, (data, range) => {
      // Record when the spawned program first produces output — used to tell
      // when an agent TUI has actually started so we don't type the
      // initialInput before it can accept keystrokes (see below).
      if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
      armScheduledReady();
      if (historyPending) historyOutput.push({ data, range });
      else writeTerm(data);
    });

    // The backend's replay of what streamed while this pane was hidden
    // (visible-only streaming — a hidden pane's PTY emits no terminal-output
    // at all; showing it drains the Rust-side buffer as one of these). It is
    // STALE output written late, so it goes through pendingOutput and
    // flushPending's stripTerminalQueries guard, never a bare term.write — a
    // terminal query in it would be answered on parse and typed into the
    // shell (the tmux attach-probe bug flushPending documents).
    unlistenReplay.current = onTerminalReplay(id, (data, range) => {
      if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
      armScheduledReady();
      if (historyPending) {
        historyOutput.push({ data, range });
        return;
      }
      pendingOutput.current += data;
      if (pendingOutput.current.length > PENDING_OUTPUT_CAP * 2) {
        pendingOutput.current = pendingOutput.current.slice(-PENDING_OUTPUT_CAP);
      }
      if (openedRef.current && visibleRef.current) flushPending();
    });

    unlistenReady.current = onTerminalReady(id, () => {
      terminalReadySeen.current = true;
      armScheduledReady();
      writeTerm("\r\n");
      if (initialInput && !initialInputSent.current) {
        if (!claimInitialInput(id, initialInput)) {
          initialInputSent.current = true;
          initialInputPending.current = false;
          releaseHeldInput(false);
          return;
        }
        initialInputSent.current = true;
        // `terminal-ready` fires as soon as the PTY is spawned, but an agent
        // TUI (Claude, etc.) needs a beat to boot before it reads stdin.
        // Typing the command immediately means the keystrokes/Enter land
        // before the input box is live, so the text appears but never
        // submits. Wait until the program has produced output for a short
        // cushion (boot done) — capped by a hard timeout — then type the
        // text and submit it with a single Enter (CR) a beat later, as a
        // separate write so a trailing newline isn't swallowed by the TUI's
        // bracketed-paste/buffered input handling.
        const READY_CUSHION_MS = 1200;
        const MAX_WAIT_MS = 5000;
        const scheduledAt = Date.now();
        const typeWhenReady = () => {
          if (cancelled) return;
          const elapsed = Date.now() - scheduledAt;
          const firstOut = firstOutputAt.current;
          const ready =
            launchNamed !== null && firstOut !== null && Date.now() - firstOut >= READY_CUSHION_MS;
          if (!ready && elapsed < MAX_WAIT_MS) {
            initialEnterTimer.current = setTimeout(typeWhenReady, 100);
            return;
          }
          if (launchNamed) {
            initialInputPending.current = false;
            return; // named at launch — nothing to type
          }
          // Last look before typing, for every agent: a CLI asking whether to
          // trust the folder must be answered by the user, never by our Enter
          // (Claude's default is `No, exit`; Codex's and Gemini's default is to
          // trust). For Claude it also backs up the backend probe below, which
          // can be wrong (a stale backend, a trust store the spawn does not read).
          const active = termRef.current?.buffer?.active;
          if (
            kind === "agent" &&
            active &&
            showsAgentTrustDialog(bufferTail(active))
          ) {
            initialInputPending.current = false;
            releaseHeldInput(false);
            return;
          }
          // Typed on the user's behalf — they triggered the flow that
          // opened this tab with a command, so its work counts as asked-for.
          noteUserInput(id);
          writePtyInput(
            id,
            PTY_ENCODER.encode(initialInputForPty(initialInput, kind)),
          ).catch(console.error);
          initialEnterTimer.current = setTimeout(() => {
            initialInputPending.current = false;
            writePtyInput(id, new Uint8Array([0x0d])).catch(console.error);
            // What the user typed meanwhile goes into the prompt the submitted
            // line leaves behind, not onto its end.
            initialEnterTimer.current = setTimeout(() => releaseHeldInput(true), HELD_INPUT_FLUSH_MS);
          }, 200);
        };

        // …but only into a launch that is ready to be typed at. Claude opens
        // its "Is this a project you created or one you trust?" dialog in a
        // folder it has not been trusted in, and that dialog's highlighted row
        // is `No, exit` — so the bare Enter above answered it and the tab died
        // on launch with nothing but `[process exited]`. Every box folder is
        // new, which is where this surfaced, but a freshly created project hits
        // it just as hard. The trust decision is the user's alone: when the
        // question is coming, leave the tab entirely alone and skip the rename
        // (the next tab in that folder gets it, once they have answered).
        const submittableTab = async (): Promise<boolean> => {
          if (!isClaudeCommand(cmd)) return true;
          try {
            // The scope decides which `.claude.json` the spawn reads — the
            // fence's staged copy carries trust Tabtivity recorded, the host
            // file does not — so the probe needs it, not just the folder.
            return await invoke<boolean>("claude_folder_trusted", {
              cwd,
              projectId: projectId ?? null,
              sandbox,
              localOnly,
            });
          } catch {
            // An older backend does not expose the probe — preserve the
            // previous behavior rather than silently dropping the rename.
            return true;
          }
        };
        void submittableTab().then((submittable) => {
          if (cancelled) return;
          if (!submittable) {
            initialInputPending.current = false;
            releaseHeldInput(false);
            return;
          }
          typeWhenReady();
        });
      }
    });

    // How far this lifecycle's launch got, for the silent-start notice below.
    let spawnState: "pending" | "spawned" | "failed" = "pending";
    let exited = false;

    unlistenExit.current = onTerminalExit(id, () => {
      exited = true;
      writeTerm("\r\n\x1b[33m[process exited]\x1b[0m\r\n");
    });

    const setupAndSpawn = async () => {
      // #42: an attach-only terminal (detached window) must NEVER spawn the PTY.
      // The PTY already exists, spawned by the main window's pane; pty_spawn with
      // a duplicate id would kill+respawn it, destroying scrollback / the agent
      // session. We only subscribe to the broadcast output/input by id.
      if (attachOnly) {
        // …but it does ask for what the terminal has already shown (#235). The
        // backend keeps a bounded tail of everything it routed for this PTY, so
        // a freshly popped-out shell renders its history instead of a blank
        // pane that stays blank until the program next draws. Prepended to
        // whatever streamed after the snapshot boundary, then trimmed to the
        // same cap the buffer uses. Byte ranges discard events already included
        // in the snapshot (including an overlapping replay); all of it still
        // goes through `flushPending`'s query guard like every other late write.
        let tail = "";
        let snapshotEnd: number | undefined;
        // Register this view before taking the snapshot: a popout hears only
        // the PTYs it has a view of (`streamEventName`), so a chunk emitted
        // between the snapshot and a later registration would never reach it.
        // Registered first, every later chunk lands in `historyOutput`, and the
        // byte ranges drop whatever the snapshot already holds.
        const viewSeq = ++viewerUpdateSeq.current;
        try {
          await invoke("pty_set_visible", { id, viewerId, visible, updateSeq: viewSeq });
        } catch {
          // An older backend: the visibility effect registers the view instead.
        }
        if (cancelled) return;
        try {
          const snapshot = await invoke<string | PtyScrollback>("pty_scrollback", { id });
          if (typeof snapshot === "string") {
            // Backend-stale development session: retain the old response shape.
            tail = snapshot;
          } else if (snapshot) {
            tail = snapshot.data;
            snapshotEnd = snapshot.endOffset;
          }
        } catch {
          // An older backend has no such command — open blank, as before.
        }
        if (cancelled) return;
        // Attached, the program is already up: the main window spawned it
        // and saw its terminal-ready, which this view never hears.
        terminalReadySeen.current = true;
        const live = historyOutput
          .map((chunk) => outputAfterScrollback(chunk.data, chunk.range, snapshotEnd))
          .join("");
        if (tail || live) {
          pendingOutput.current = tail + live + pendingOutput.current;
          if (pendingOutput.current.length > PENDING_OUTPUT_CAP * 2) {
            pendingOutput.current = pendingOutput.current.slice(-PENDING_OUTPUT_CAP);
          }
          if (firstOutputAt.current === null) firstOutputAt.current = Date.now();
          // A re-adopted tab's whole TUI can arrive as this one restored
          // snapshot and never produce another live chunk. That is real output
          // from a started agent, so it arms scheduling like any other — without
          // this, an attached tab that stays quiet was permanently undeliverable.
          armScheduledReady();
        }
        historyPending = false;
        if (openedRef.current && visibleRef.current) flushPending();
        return;
      }

      // Register this view with the visible-only output router *before* starting
      // the child. The ordinary visibility effect below also keeps that state in
      // sync after mount, but effects run after this one and its IPC call is not
      // ordered against a very short-lived process. Without this handshake, a
      // CLI that prints an error and exits immediately (OpenClaw rejecting an
      // unsupported Node version is one example) can finish while no view is
      // registered: `route_close` drops its buffered output and the tab is left
      // as an empty pane. Waiting for the router acknowledgement makes the
      // spawn/output lifetime start with a concrete recipient.
      const updateSeq = ++viewerUpdateSeq.current;
      try {
        await invoke("pty_set_visible", { id, viewerId, visible, updateSeq });
      } catch {
        // Output routing is an optimization. Preserve the normal spawn path if
        // an older backend does not expose the registration command.
      }
      if (cancelled) return;

      // A (re)spawn is a new program: wipe what the activity store recorded
      // about the previous occupant of this id, so a reopened project's resume
      // replay can't ride an old input stamp into a "working"/"done" glow.
      notePtySpawn(id);
      const spawn = async () => {
        const spawned = await invoke<{ named?: boolean; interrupted?: boolean; resting?: boolean } | null>("pty_spawn", {
          opts: { id, cmd, args, env, cwd, cols: term.cols, rows: term.rows, local_only: localOnly, sandbox, agent: kind === "agent" || kind === "local_agent", project_id: projectId ?? null, schedule_target_id: scheduleTargetId ?? null, remote_host_id: remoteHostId ?? null, tmux_session: tmuxSession ?? null, tmux_attach: tmuxAttach ?? null, host_bound_uid: hostBoundUid ?? null, local_model: kind === "local_agent", host_session: hostSession },
          sessionName: launchName,
        });
        // An older backend answers nothing: `named` absent types the line as before.
        launchNamed = spawned?.named === true;
        if (launchNamed) releaseHeldInput(true);
        // The tab's last run died mid-turn (a quit or crash): mark it
        // interrupted, as its resumed transcript will say.
        if (spawned?.interrupted === true) noteTurnCutOff(id);
        // Its last run finished its turn: the agent is at its composer, and
        // the conversation a resume or reattach repaints is not a question.
        if (spawned?.resting === true) noteAgentResting(id);
      };
      try {
        await spawn();
        spawnState = "spawned";
      } catch (e) {
        // Every branch below either prints why or asks the user first, so a
        // silent-start notice would only talk over it.
        spawnState = "failed";
        if (cancelled) return;
        // **The HPC tag's refusal, made actionable** (G.24). `pty_spawn` dials the
        // host before wrapping a remote tab, and on a machine tagged HPC it
        // refuses with `hpc_mode`'s sentinel — deliberately, because it receives
        // identical options for a tab *restored at relaunch* (nobody asked for
        // that) and for a click. The backend's own comment says the frontend
        // should "offer connect and open"; nothing did, so the raw
        // `TABTIVITY_HPC_GUARD connect user@host:22` was printed into the pane.
        //
        // Connecting the project is what actually lifts the refusal: the pool
        // holds a standing authorization once it is up
        // (`services::remote::connect_host`), which is the only distinction this
        // seam can make. So the retry is connect-then-spawn, not a flag.
        // **A fence-less platform's refusal, made a one-time question.** On
        // Windows `pty_spawn` refuses every local agent until the user has
        // accepted, once, that agents there run with their full rights
        // (`agent_fence::PlatformUnaccepted`). Every tab refused at the same
        // moment — a restored session — shares the one prompt; accepting
        // persists the answer, and the retry is the same spawn.
        if (unfencedPlatformRefusal(e)) {
          const accepted = await useUnfencedPlatformStore.getState().request();
          if (cancelled) return;
          if (!accepted) {
            writeTerm(`\r\n\x1b[33m[${unfencedDeclinedTextRef.current()}]\x1b[0m\r\n`);
            return;
          }
          try {
            await spawn();
            spawnState = "spawned";
          } catch (retryErr) {
            if (!cancelled) writeTerm(`\r\n\x1b[31m[spawn error: ${retryErr}]\x1b[0m\r\n`);
          }
          return;
        }
        const refusal = hpcGuardRefusal(e);
        if (!refusal) {
          writeTerm(`\r\n\x1b[31m[spawn error: ${e}]\x1b[0m\r\n`);
          return;
        }
        const ok = await useHpcGuardStore.getState().request(refusal.kind, refusal.target);
        if (cancelled) return;
        if (!ok) {
          // Backing out is an answer, not a failure — say what did not happen and
          // how to get it, rather than leaving a blank pane.
          writeTerm(
            `\r\n\x1b[33m[${refusal.target} is tagged as a cluster login node, so this tab did not connect.\r\n` +
              `Connect the project from its pill to open tabs on it.]\x1b[0m\r\n`,
          );
          return;
        }
        try {
          await invoke("remote_connect", {
            projectId: projectId ?? null,
            hostId: remoteHostId ?? null,
            password: null,
          });
          if (cancelled) return;
          await spawn();
        } catch (retryErr) {
          if (!cancelled) writeTerm(`\r\n\x1b[31m[spawn error: ${retryErr}]\x1b[0m\r\n`);
        }
      }
    };

    // React Strict Mode deliberately runs an effect setup → cleanup → setup cycle
    // on an initial development mount. Starting a PTY synchronously in the first
    // setup made the second one replace it under the same id; replacement reaps
    // the first child with SIGTERM. Most CLIs exit quietly, but Antigravity logs
    // that signal as a scary raw gRPC error in the terminal it is about to
    // resume. Defer the actual spawn by one microtask: Strict Mode's synthetic
    // cleanup marks this lifecycle cancelled before the task runs, leaving only
    // the real setup to create the PTY. A genuine quick unmount gets the same
    // safe outcome (no process was ever started).
    queueMicrotask(() => {
      if (!cancelled) void setupAndSpawn();
    });

    // A launch that never completes leaves the pane blank with nothing to say
    // why — the output-router handshake or `pty_spawn` itself simply never
    // resolves, and on a light theme the pane is plain white (a "+ OpenCode" tab,
    // 2026-09-15, whose program never started). So a tab that owns its launch
    // and has shown nothing after SILENT_START_MS says which of the two it is.
    // Attach-only views spawn nothing and are excluded. Output is judged by this
    // view's own stream, and — once the spawn is through, so a previous
    // occupant's stamp cannot count — by the activity digests a hidden pane gets
    // instead of a stream. Fires once.
    if (!attachOnly) {
      silentStartTimer.current = setTimeout(() => {
        silentStartTimer.current = null;
        if (cancelled) return;
        const notice = silentStartNotice({
          spawn: spawnState,
          sawOutput:
            firstOutputAt.current !== null ||
            (spawnState === "spawned" && lastPtyOutputAt(id) !== undefined),
          exited,
        });
        if (!notice) return;
        writeTerm(`\r\n\x1b[33m[${silentStartTextRef.current(notice, terminalProgramLabel(cmd))}]\x1b[0m\r\n`);
      }, SILENT_START_MS);
    }

    // Resize observer — handles container-level resizes (e.g. panel open/close)
    // and the hidden→visible transition (display:none→flex changes the box from
    // zero to its measured size, which fires the observer). While still unopened
    // this opens the terminal once it gains a layout box; afterwards it refits.
    const doFit = () => {
      if (!openedRef.current) {
        tryOpen();
        return;
      }
      if (fitRef.current && termRef.current && hasLayout()) {
        // A re-shown pane holds whatever streamed while it was hidden
        // (writeTerm buffers past a hidden pane's xterm) — flush it in the
        // same beat the pane regains its layout, before the refit, so the
        // catch-up isn't waiting on the next live chunk to drain it.
        if (visibleRef.current) {
          restoreRenderer();
          flushPending();
        }
        fitRef.current.fit();
        invoke("pty_resize", {
          id,
          cols: termRef.current.cols,
          rows: termRef.current.rows,
        }).catch(() => {});
      }
    };
    doFitRef.current = doFit;
    const ro = new ResizeObserver(doFit);
    if (containerRef.current) ro.observe(containerRef.current);

    // Window resize listener — WebKitGTK doesn't reliably fire ResizeObserver
    // for viewport-level changes (maximize, fullscreen toggle).
    window.addEventListener("resize", doFit);

    // Open watchdog (the "black agent tab" gate, esp. Windows/WebView2).
    // tryOpen() only runs from the ResizeObserver and the `visible` effect. When
    // a pane goes display:none → flex while `visible` was already true, the only
    // trigger is the ResizeObserver firing on that box change — and WebView2
    // occasionally drops that callback. The PTY has already spawned and is
    // buffering its output into pendingOutput, but xterm never opens, so the
    // pane stays black AND unresponsive (no open → no focus → keystrokes go
    // nowhere). This bounded poll guarantees we keep attempting tryOpen while the
    // pane is visible-but-unopened, so it can never get stuck closed. It costs a
    // few cheap ticks at mount, stops the instant the terminal opens, and is
    // capped by a wall-clock deadline so it can't spin forever (a legitimately
    // hidden pane is opened by the `visible` effect when it is next shown).
    const OPEN_WATCH_INTERVAL_MS = 150;
    const OPEN_WATCH_DEADLINE_MS = 8000;
    const watchStart = Date.now();
    const watchOpen = () => {
      openWatchTimer.current = null;
      if (cancelled || openedRef.current) return;
      if (visibleRef.current) tryOpen();
      if (openedRef.current || Date.now() - watchStart >= OPEN_WATCH_DEADLINE_MS) return;
      openWatchTimer.current = setTimeout(watchOpen, OPEN_WATCH_INTERVAL_MS);
    };
    openWatchTimer.current = setTimeout(watchOpen, OPEN_WATCH_INTERVAL_MS);

    // Agent-pane zoom: Ctrl+wheel scales the font; a window event keeps every
    // other open agent pane in sync with the shared level. Both are no-ops for
    // non-agent shells. The wheel listener is non-passive so it can preventDefault.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const cur = termRef.current?.options.fontSize ?? DEFAULT_FONT_SIZE;
      applyFontSize(cur + (e.deltaY < 0 ? 1 : -1), true);
    };
    // Typed as the global EventListener because the `Event` identifier is shadowed
    // here by Tauri's generic Event<T> import.
    const onZoomEvent: EventListener = (e) => {
      const size = (e as CustomEvent<number>).detail;
      if (typeof size === "number") applyFontSize(size, false);
    };

    // The pane mouse gestures (see `agentMouseDownAction`): a plain drag selects
    // even while the program holds the mouse — in every pane, since each local tab
    // sits in a `mouse on` tmux — and in agent panes a double-click pastes. Bound on the CONTAINER in the capture phase, which is the only place
    // that runs before xterm's own listeners — they sit on the terminal element
    // it creates *inside* this container — so a "paste" press can be taken away
    // from the selection service entirely and a "select" press can be handed to it
    // wearing the modifier it looks for.
    // Set by a right-click that copied: the `contextmenu` event that follows it
    // belongs to that click and must neither open a menu nor reach xterm.
    let swallowContextMenu = false;
    const onMouseDownCapture = (e: MouseEvent) => {
      if (fromSignInCard(e)) return;
      swallowContextMenu = false;
      // Right-click on selected text copies it and clears the highlight — the
      // Windows Terminal / PuTTY gesture. With nothing selected the press goes
      // on as before (to the program, which in Claude Code pastes).
      if (e.button === 2 && (keySelect || term.hasSelection())) {
        e.preventDefault();
        e.stopPropagation();
        swallowContextMenu = true;
        if (keySelect) {
          copyKeySelect();
        } else {
          const sel = copyableSelection(term, columnSelect);
          term.clearSelection();
          if (sel) copyToClipboard(sel);
        }
        return;
      }
      // Any other press hands selecting back to the mouse.
      leaveKeySelect();
      // A plain double-click on a link copies it, and only that: no open, no
      // word selection, no agent-pane paste.
      if (hoveredLink && e.button === 0 && e.detail === 2 && !(e.shiftKey || e.ctrlKey || e.altKey || e.metaKey)) {
        e.preventDefault();
        e.stopPropagation();
        cancelLinkOpen();
        invoke("copy_text_to_clipboard", { text: hoveredLink })
          .then(() => useProjectsStore.setState({ switchToast: linkCopiedRef.current }))
          .catch(() => {});
        return;
      }
      const action = agentMouseDownAction(e, term.modes.mouseTrackingMode !== "none", zoomable);
      if (e.button === 0 && action !== "paste") {
        // Read before the "select" branch below re-defines a modifier on the
        // event: Alt is what makes xterm draw a column selection.
        columnSelect = e.altKey;
        mouseModeGuard.beginDrag();
      }
      if (action === "paste") {
        e.preventDefault();
        e.stopPropagation();
        term.focus();
        pasteClipboard();
      } else if (action === "select") {
        // The event object is what xterm reads the modifier off, so re-defining
        // the property on it is enough; nothing else in this window sees the
        // event afterwards.
        Object.defineProperty(e, FORCE_SELECTION_MODIFIER, { get: () => true });
      }
    };
    // On the document, not the container: a drag that ends outside the pane (the
    // usual way to grab the last line) releases there. A lost window focus ends
    // it too, so a release the webview never saw cannot hold mouse modes back.
    const onDocMouseUp = () => mouseModeGuard.endDrag();
    // Every pane, not just agent ones: whichever program grabbed the mouse owns
    // the right-click (see `suppressNativeContextMenu`). The element is captured
    // here so the cleanup detaches both listeners from the node it attached to.
    // Capture phase, so the menu of a copying right-click is kept from xterm's
    // own handler (which would re-select the word under the pointer) as well.
    const contextMenuTarget = containerRef.current;
    const onContextMenu = (e: MouseEvent) => {
      if (fromSignInCard(e)) return;
      if (swallowContextMenu) {
        swallowContextMenu = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (suppressNativeContextMenu(e, term.modes.mouseTrackingMode !== "none")) e.preventDefault();
    };
    contextMenuTarget?.addEventListener("contextmenu", onContextMenu, true);
    // A selection must survive the pointer resting on the pane. While the
    // program tracks all motion (an agent TUI's hover), xterm reports every
    // buttonless move to it as user input — and user input clears the
    // selection, so a drag's highlight vanished as soon as the mouse moved on.
    // Such moves are held back from xterm while text is selected; the program
    // misses hover only until the selection is copied, typed over or clicked away.
    const onMouseMoveCapture = (e: MouseEvent) => {
      if (e.buttons === 0 && term.modes.mouseTrackingMode === "any" && (keySelect || term.hasSelection())) {
        e.stopPropagation();
      }
    };
    contextMenuTarget?.addEventListener("mousemove", onMouseMoveCapture, true);

    contextMenuTarget?.addEventListener("mousedown", onMouseDownCapture, true);
    if (zoomable) {
      containerRef.current?.addEventListener("wheel", onWheel, { passive: false });
      window.addEventListener(AGENT_ZOOM_EVENT, onZoomEvent);
    }
    document.addEventListener("mouseup", onDocMouseUp);
    window.addEventListener("blur", onDocMouseUp);

    return () => {
      cancelled = true;
      clearPtyInput(id);
      if (initialEnterTimer.current) clearTimeout(initialEnterTimer.current);
      if (holdInputTimer) clearTimeout(holdInputTimer);
      if (scheduledSettleTimer.current) clearTimeout(scheduledSettleTimer.current);
      unregisterScheduled?.();
      if (openWatchTimer.current) clearTimeout(openWatchTimer.current);
      if (silentStartTimer.current) clearTimeout(silentStartTimer.current);
      oscHandler.dispose();
      mouseModeGuard.dispose();
      wrappedLinks.dispose();
      pathLinks.dispose();
      setPathHover(null);
      cancelLinkOpen();
      signInWatch.dispose();
      if (signInScanTimer) clearTimeout(signInScanTimer);
      window.removeEventListener("resize", doFit);
      contextMenuTarget?.removeEventListener("contextmenu", onContextMenu, true);
      contextMenuTarget?.removeEventListener("mousemove", onMouseMoveCapture, true);
      contextMenuTarget?.removeEventListener("mousedown", onMouseDownCapture, true);
      if (zoomable) {
        containerRef.current?.removeEventListener("wheel", onWheel);
        window.removeEventListener(AGENT_ZOOM_EVENT, onZoomEvent);
      }
      document.removeEventListener("mouseup", onDocMouseUp);
      window.removeEventListener("blur", onDocMouseUp);
      ro.disconnect();
      doFitRef.current = null;
      applyRendererRef.current = null;
      rendererVisibilityRef.current = null;
      if (releaseTimer) clearTimeout(releaseTimer);
      unlistenOutput.current?.();
      unlistenReplay.current?.();
      unlistenReady.current?.();
      unlistenExit.current?.();
      unlistenOutput.current = null;
      unlistenReplay.current = null;
      unlistenReady.current = null;
      unlistenExit.current = null;
      // #42: do NOT kill the PTY on unmount when (a) this is an attach-only
      // viewer (the detached window — the main pane owns it), or (b) this pane is
      // unmounting *because its tab was just detached* into a popped-out window
      // (the detached attach-only viewer is now reading this PTY; killing it
      // would leave that window a dead black pane). Only a real close tears it
      // down. (c) `persistOnUnmount` — a dialog-embedded connection terminal
      // whose tunnel/login must outlive the dialog.
      if (!attachOnly && !isDetachedPtyId(id) && !persistOnUnmount) {
        invoke("pty_kill", { id }).catch(() => {});
        // Drop the captured agent-task title so a closed tab's summary can't
        // linger against a future tab that reuses the key. Through the shared
        // parser: splitting on every colon left a box tab's key as
        // `<boxId>:<tabKey>`, which matched no stored title and so cleared none.
        useAgentTaskStore.getState().clearTabTitle(splitPtyId(id)?.key ?? id);
      }
      // xterm tears itself down by walking a flat list of disposables with no
      // try/catch of its own (`Disposable.dispose()`), and the disposable that
      // lifts the terminal's element back out of the DOM is the LAST one its
      // constructor registers — so a single throwing entry ahead of it (a
      // renderer whose context is already gone, an addon disposed twice) aborts
      // the walk and strands the element in our container. Unguarded, that throw
      // also escaped this cleanup and skipped the three ref retirements below,
      // leaving `openedRef` true against a dead terminal. Contain it: the
      // teardown is best-effort, the invariant it protects is not.
      try {
        term.dispose();
      } catch {
        /* a renderer/addon that was already gone; the refs below still matter */
      }
      // Whatever dispose managed, the container must end up without an xterm
      // — it is the node the NEXT lifecycle opens into (see the sweep in
      // `tryOpen`). The cards portaled into it stay: they are React's.
      if (containerRef.current) sweepXtermElements(containerRef.current);
      // Retire the lifecycle refs WITH the terminal they describe. Every guard in
      // this file asks one of these three whether there is a terminal to touch
      // (`openedRef` in the focus effect, `termRef` in the theme effect, both in
      // `doFit`), and a disposed xterm answers none of them for itself — it keeps
      // its object identity while tearing its renderer down, so a call that
      // arrives afterwards fails inside xterm with
      // "undefined is not an object (evaluating 'this._renderer.value.dimensions')"
      // rather than being refused. That is not hypothetical: this effect re-runs
      // whenever the spawn deps change (an agent mode flip, a container toggle,
      // a host switch) and unmounts on every tab close, while `colorScheme`,
      // focus and zoom are all driven from OUTSIDE it — so a theme or focus
      // change landing in the same tick as a teardown reached a dead terminal.
      // It was the single most common error in the crash log, thrown on every
      // launch as restored tabs settled. Clearing here restores the invariant the
      // guards assume: these refs describe a LIVE terminal or nothing.
      termRef.current = null;
      unregisterTerminal(id, term);
      fitRef.current = null;
      openedRef.current = false;
    };
  }, [id, cmd, cwd, initialInput, argsKey, envKey, localOnly, sandbox, projectId, remoteHostId, tmuxSession, tmuxAttach, hostBoundUid, hostSession, attachOnly, zoomable, persistOnUnmount, declaredKind, scheduleTargetId, relaunchSeq]);

  // Re-theme a LIVE, OPEN terminal. Both halves of that guard are load-bearing,
  // and `termRef.current` alone was neither: assigning `options.theme` makes
  // xterm refresh through its renderer, and the renderer exists only between
  // `open()` and `dispose()`. Outside that window it throws
  // "undefined is not an object (evaluating 'this._renderer.value.dimensions')".
  // The closed case is the one that fired on every launch: `colorScheme` comes
  // from settings, which load a few seconds AFTER the restored tabs mount, so the
  // scheme arriving flipped this effect over a whole layout's worth of terminals
  // that had been constructed but not yet opened (hidden tabs, panes still
  // waiting on a layout box). `tryOpen` applies the scheme on open instead, so
  // skipping a closed terminal here costs nothing.
  useEffect(() => {
    if (openedRef.current && termRef.current) {
      termRef.current.options.theme = terminalTheme(colorScheme);
    }
  }, [colorScheme]);

  // Re-pick the renderer of a LIVE, OPEN terminal when the WebGL flag moves —
  // which includes settings simply arriving: they load a few seconds after the
  // restored tabs mount, so a pane opened before that read the flag as off and
  // would otherwise stay on canvas for the whole session. The ref is null (or
  // its closure self-guards on openedRef) outside the open()..dispose() window,
  // so a closed terminal is skipped exactly as the theme effect skips it.
  useEffect(() => {
    applyRendererRef.current?.(webglWanted);
  }, [webglWanted]);

  // Open (first time) or re-fit when the pane becomes visible or its cell
  // geometry changes (grid layout switches). The container ResizeObserver covers
  // most resizes, but a hidden→visible transition doesn't always fire it, so
  // drive the open/fit logic explicitly here.
  useEffect(() => {
    // Re-load a released renderer before the refit paints (show), or arm the
    // release of a pane that just went hidden.
    rendererVisibilityRef.current?.(visible);
    if (visible) doFitRef.current?.();
  }, [visible, id]);

  // Visible-only streaming: report pane visibility so the backend can stop
  // emitting a hidden pane's output over IPC entirely (it buffers in Rust and
  // condenses throttled `terminal-activity` digests for the pill indicators;
  // the buffer comes back as one `terminal-replay` when the pane is shown).
  // Each mounted view owns a stable token. Cleanup removes only that view, so a
  // hidden main pane can never silence a visible detached pane (or vice versa).
  useEffect(() => {
    const updateSeq = ++viewerUpdateSeq.current;
    invoke("pty_set_visible", { id, viewerId, visible, updateSeq }).catch(() => {});
  }, [id, viewerId, visible]);

  useEffect(() => {
    return () => {
      const updateSeq = ++viewerUpdateSeq.current;
      invoke("pty_remove_view", { id, viewerId, updateSeq }).catch(() => {});
    };
  }, [id, viewerId]);

  // The Reader over an agent pane (`TerminalReaderView`): offered only for a
  // CLI whose transcript Tabtivity reads, and only in the tab's own pane.
  // `usePaneTab`: a popout's tabs store holds no tabs.
  const readerIds = splitPtyId(id);
  const readerTab = usePaneTab(readerIds?.scope, readerIds?.key);
  // A popout's pane is that tab's own pane in its window; the main window's
  // attach-only mirrors of a tab shown elsewhere are not.
  const readerAvailable = readerOffered(readerTab) && (!attachOnly || isDetachedWindow());
  const readerAgent = readerTab ? readerAgentOf(readerTab) : cmd;
  const readerOn = useReaderOpen(readerAgent, readerAvailable);
  const changesOn = useReaderChangesOpen(readerAgent);
  /** The Changes panel over the terminal itself while the Reader is off —
   * the pane pads its right edge by the panel, so the fit leaves it free. */
  const terminalChanges = changesOn && readerAvailable && !readerOn && !!readerTab;
  const changesWidth = useAgentReaderStore((state) => state.changesWidth);
  const setReader = (on: boolean) => {
    useAgentReaderStore.getState().set(readerAgent, on);
    if (!on) setTimeout(() => termRef.current?.focus(), 0);
  };

  // Take keyboard focus only when this pane is the focused one (and opened);
  // over a shown Reader, its composer takes it.
  useEffect(() => {
    if (focused && !readerOn && openedRef.current && termRef.current) termRef.current.focus();
  }, [focused, readerOn]);

  const dismissSignIn = (url: string) => {
    dismissedSignIns.current.add(url);
    setSignIn(null);
  };

  // The spawn effect's own reading of the tab kind (see there).
  const paneKind: TabKind = declaredKind ?? (env[envName("LOCAL_MODEL")] || env.VIBE_ACTIVE_MODEL ? "local_agent" : cmdToKind(cmd));
  const agentPane = paneKind === "agent" || paneKind === "local_agent";

  // Files dragged in from the OS file manager (`lib/terminal/terminalDrop`):
  // an agent gets them through its folder's inbox as `@` references, a shell
  // their quoted paths — into the Reader's composer while it is up, else typed
  // into the terminal. Native listeners on the pane, so a drop onto the
  // composer (a portal into it) is caught too; a drag that carries no file path
  // (text dragged into the composer) keeps its default.
  const [dropActive, setDropActive] = useState(false);
  const readerOnRef = useRef(readerOn);
  readerOnRef.current = readerOn;
  const dropTRef = useRef(t);
  dropTRef.current = t;
  useEffect(() => {
    const pane = containerRef.current;
    if (!pane) return;
    const toast = (key: TranslationKey) => useProjectsStore.setState({ switchToast: dropTRef.current(key) });
    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer || !isExternalFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDropActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (!pane.contains(e.relatedTarget as Node | null)) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      setDropActive(false);
      if (!e.dataTransfer) return;
      const paths = parseDroppedFilePaths(e.dataTransfer);
      if (paths.length === 0) {
        if (Array.from(e.dataTransfer.types ?? []).includes("Files")) {
          e.preventDefault();
          toast("terminal.drop.noPath");
        }
        return;
      }
      e.preventDefault();
      void deliverDrop(id, paths, agentPane).then(({ text, error }) => {
        if (text && !(readerOnRef.current && insertIntoReader(id, text))) {
          termRef.current?.paste(text);
          termRef.current?.focus();
        }
        if (error) toast(error);
      });
    };
    pane.addEventListener("dragover", onDragOver);
    pane.addEventListener("dragleave", onDragLeave);
    pane.addEventListener("drop", onDrop);
    return () => {
      pane.removeEventListener("dragover", onDragOver);
      pane.removeEventListener("dragleave", onDragLeave);
      pane.removeEventListener("drop", onDrop);
    };
  }, [id, agentPane]);
  const splitId = splitPtyId(id);
  return (
    <>
    <div
      ref={containerRef}
      className={[terminalChanges && "terminal-pane-with-changes", dropActive && "terminal-drop-active"].filter(Boolean).join(" ") || undefined}
      style={{
        ...(terminalChanges ? changesWidthStyle(changesWidth) : null),
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        display: "flex",
        flexDirection: "column",
        // Agent panes get a touch more breathing room on the left and a bit less
        // on the right (the viewport scrollbar already insets the right edge), so
        // the text margins read as balanced. FitAddon accounts for this padding.
        ...(zoomable ? { paddingLeft: 10, paddingRight: 4 } : null),
        ...(terminalChanges ? { paddingRight: "var(--reader-changes-inset)" } : null),
        // The ground under xterm's own canvas, which must be the SAME colour the
        // terminal paints — it shows through before the renderer's first frame
        // and in the strip below the last row. So it is read straight off
        // `terminalTheme` rather than restated as a second ternary over the same
        // schemes: that copy had already drifted (it answered #0d1117 for every
        // dark scheme, so a theme with its own background flashed the wrong one).
        background: terminalTheme(colorScheme).background,
      }}
    />
    {/* After the terminal in the DOM (the pane's first child is its xterm
        host everywhere else), drawn above it by `order` in the stylesheet. */}
    {(paneKind === "agent" || paneKind === "local_agent") && splitId && (
      <TerminalPromptStrip
        ptyId={id}
        scope={splitId.scope}
        tabKey={splitId.key}
        background={terminalTheme(colorScheme).background}
        foreground={terminalTheme(colorScheme).foreground ?? "inherit"}
        onReturnFocus={() => termRef.current?.focus()}
        reader={readerAvailable ? {
          open: readerOn,
          onToggle: () => setReader(!readerOn),
          changes: { open: changesOn, onToggle: () => useAgentReaderStore.getState().setChanges(readerAgent, !changesOn) },
        } : undefined}
      />
    )}
    {terminalChanges && readerTab && splitId && host && createPortal(
      <TerminalReaderChanges
        scope={splitId.scope}
        tab={readerTab}
        cwd={cwd}
        visible={visible}
        subagent={undefined}
        subagentTitle={undefined}
        onClose={() => useAgentReaderStore.getState().setChanges(readerAgent, false)}
      />,
      host,
    )}
    {dropActive && host && createPortal(
      <div className="terminal-drop-banner">
        {t(agentPane ? "terminal.drop.hintAgent" : "terminal.drop.hintShell")} <UntestedTag id="terminal.drop.hint" />
      </div>,
      host,
    )}
    {readerOn && splitId && host && (
      <TerminalReaderView
        host={host}
        ptyId={id}
        scope={splitId.scope}
        tabKey={splitId.key}
        cwd={cwd}
        visible={visible}
        focused={focused}
      />
    )}
    {signIn && host && (
      <TerminalSignInCard
        key={signIn.url}
        host={host}
        request={signIn}
        onOpen={() => void invoke("open_external_url", { url: signIn.url }).catch(() => {})}
        onCopy={() => {
          invoke("copy_text_to_clipboard", { text: signIn.url })
            .then(() => useProjectsStore.setState({ switchToast: signInCopiedRef.current }))
            .catch(() => {});
        }}
        onSendCode={(code) => {
          const term = termRef.current;
          if (!term) return;
          // Pasted, not typed: a bracketed paste reaches the prompt as one
          // piece. Enter follows once the program has taken it, as with the
          // initial input.
          term.paste(code);
          setTimeout(() => void writePtyInput(id, new Uint8Array([0x0d])).catch(console.error), 200);
          dismissSignIn(signIn.url);
          term.focus();
        }}
        onDismiss={() => dismissSignIn(signIn.url)}
      />
    )}
    {undoClearOffered && (!readerOn || readerCleared) && !signIn && host && (
      <TerminalUndoClearCard host={host} ptyId={id} />
    )}
    {/* The host's CLI only: a remote or container tab runs another install. */}
    {zoomable && !remoteHostId && !sandbox && !undoClearOffered && !signIn && host && (
      <TerminalVersionCard host={host} cmd={cmd} />
    )}
    {keySelecting && host && createPortal(
      // The keyboard-steering legend's look, pinned inside the pane.
      <div className="steering-legend terminal-key-select" role="status">
        <span className="steering-legend-title">
          {t("terminal.keySelect.title")}
          <UntestedTag id="terminal.keySelect.title" />
        </span>
        <span className="steering-legend-item"><kbd>←↑↓→</kbd>{t("terminal.keySelect.move")}</span>
        <span className="steering-legend-item"><kbd>Shift</kbd><kbd>v</kbd>{t("terminal.keySelect.select")}</span>
        <span className="steering-legend-item"><kbd>V</kbd>{t("terminal.keySelect.lines")}</span>
        <span className="steering-legend-item"><kbd>Enter</kbd>{t("terminal.keySelect.copy")}</span>
        <span className="steering-legend-item"><kbd>Esc</kbd>{t("terminal.keySelect.leave")}</span>
      </div>,
      host,
    )}
    <PathLinkHint hover={visible ? pathHover : null} />
    {dialogs}
    </>
  );
}
