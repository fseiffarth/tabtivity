import type { TabKind } from "../../stores/tabs";
import { IS_MAC } from "../platform";

const CSI = "\x1b[";
const claimedInitialInputs = new Set<string>();

/** xterm answers terminal identity probes by emitting CSI ... c back through
 *  `onData`, for example secondary DA: `ESC [ > 0 ; 276 ; 0 c`. During an
 *  auto-run tab startup that response can land in readline before Tabtivity types
 *  `initialInput`, making the shell execute `0;276;0c...` instead of the command.
 *  Suppress only the standalone identity replies while an auto-input is pending;
 *  normal interactive terminal programs can still receive them afterward. */
export function isTerminalIdentityResponse(data: string): boolean {
  return new RegExp(`^(?:${CSI.replace("[", "\\[")}[?>]?[0-9;]*c)+$`).test(data);
}

/** The queries a program sends TO the terminal — device attributes, device
 *  status, mode and version reports. Each one is *answered* by xterm through
 *  `onData`, i.e. straight back into the PTY as if the user had typed it.
 *
 *  They are stripped out of output that reaches xterm LATE — everything a pane
 *  buffered while it was closed or hidden (see `TerminalView`'s `flushPending`).
 *  A query is only meaningful to the program that asked it, within the timeout
 *  it waits out; parsed minutes later, the answer lands at whatever prompt is on
 *  screen by then. That is how a remote shell ends up holding `0;276;0c`: tmux
 *  probes the terminal with `ESC[>c` when it attaches, the tab was in the
 *  background so the probe sat in the buffer, and the reply readline finally
 *  received became command-line text (readline consumes the `ESC[>` prefix as an
 *  unknown key sequence and inserts the rest literally).
 *
 *  Dropping them costs the catch-up nothing: not one of these sequences draws
 *  anything. Only ever applied to buffered output — a query in *live* output is
 *  answered normally, so a program running in a visible pane still gets its
 *  reply. */
const TERMINAL_QUERIES = new RegExp(
  [
    "\\x1b\\[[?>=]?[0-9;]*c", // DA1 / DA2 / DA3 — device attributes
    "\\x1b\\[\\??[0-9;]*n", // DSR — device status (5n, 6n cursor position, ?6n)
    "\\x1b\\[\\??[0-9;]*\\$p", // DECRQM — "is this mode set?"
    "\\x1b\\[>[0-9;]*q", // XTVERSION (a space before `q` would be DECSCUSR, not a query)
    "\\x1bP\\$q[^\\x1b\\x07]*(?:\\x1b\\\\|\\x07)", // DECRQSS — "what is this setting?"
    "\\x1b\\](?:4;[0-9]+|1[0-9]);\\?(?:\\x1b\\\\|\\x07)", // OSC palette / fg / bg colour query
  ].join("|"),
  "g",
);

export function stripTerminalQueries(data: string): string {
  return data.includes("\x1b") ? data.replace(TERMINAL_QUERIES, "") : data;
}

/** Anything xterm emits through `onData` as an *answer* rather than as a
 *  keystroke: the replies to {@link TERMINAL_QUERIES}. Every one of them is a
 *  CSI/OSC/DCS sequence no key produces (F3 is `ESC O R`, never `ESC [ … R`), so
 *  matching the whole string is safe against real user input.
 *
 *  Used to refuse a reply provoked by a *stale* write — the belt to
 *  {@link stripTerminalQueries}'s braces, covering any query shape that list
 *  does not know about. */
const TERMINAL_REPORTS = [
  "\\x1b\\[[?>=]?[0-9;]*[cnR]", // DA reply, DSR status, CPR cursor position
  "\\x1b\\[\\??[0-9;]*\\$y", // DECRPM — the mode report
  "\\x1b\\](?:4;[0-9]+|1[0-9]);[^\\x07\\x1b]*(?:\\x1b\\\\|\\x07)", // OSC colour reply
  "\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\", // DECRPSS
];

const TERMINAL_REPORT = new RegExp(`^(?:${TERMINAL_REPORTS.join("|")})+$`);

export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT.test(data);
}

/** Everything xterm emits through `onData` that no person typed: the replies
 *  above, plus the two streams a program switches on and the terminal then
 *  sends by itself — focus in/out reports (`ESC [ I` / `ESC [ O`, mode 1004,
 *  which every agent TUI enables, so a click into or out of a tab produces
 *  one) and mouse tracking (X10 `ESC [ M` + 3 bytes, SGR `ESC [ < … M/m`, and
 *  the urxvt form; a wheel scroll over an agent pane is a burst of them).
 *
 *  These must not be stamped as the user's input to the tab. The activity
 *  store reads "input after the agent's Stop" as a new turn in flight and holds
 *  scheduled delivery until the agent's next Stop — correct for a prompt the
 *  user is submitting, and a permanent hold for a tab that was only looked at,
 *  since a focus report is followed by no Stop at all. Each is a CSI sequence
 *  no key produces (arrows are `ESC [ A`…`D`, F1–F4 are SS3), so matching the
 *  whole chunk is safe against real keystrokes. */
const TERMINAL_AUTO_REPLY = new RegExp(
  "^(?:" +
    [
      ...TERMINAL_REPORTS,
      "\\x1b\\[[IO]", // focus in / focus out
      "\\x1b\\[<[0-9;]*[Mm]", // SGR mouse
      "\\x1b\\[M[\\s\\S]{3}", // X10 / normal mouse
      "\\x1b\\[[0-9;]+M", // urxvt mouse
    ].join("|") +
    ")+$",
);

export function isTerminalAutoReply(data: string): boolean {
  return data.length > 1 && data.startsWith("\x1b") && TERMINAL_AUTO_REPLY.test(data);
}

/** Clear any startup junk already sitting in a shell's readline buffer before
 *  auto-typing a command. No-op for agent TUIs: their prompt behavior is not a
 *  POSIX shell line editor. */
export function initialInputForPty(input: string, kind: TabKind): string {
  return kind === "shell" ? `\x15${input}` : input;
}

/** Whether terminal text shows an agent CLI's folder-trust question. Wording
 *  as found in the installed CLIs (2026-09-17):
 *  - Claude 2.1.274: "Trust this directory?" / "Yes, I trust this folder" /
 *    "No, exit" — the cursor starts on `No, exit`, so an Enter kills the tab;
 *    older builds asked "Is this a project you created or one you trust?".
 *  - Codex 0.154: "Do you trust the contents of this directory?"
 *  - Gemini (and its Qwen fork): "Do you trust the files in this folder?" /
 *    "Trust folder (…)" / "Don't trust".
 *  Whatever the default row, the answer is the user's: nothing may be
 *  auto-typed at a screen that asks it. */
export function showsAgentTrustDialog(text: string): boolean {
  return /one you trust|trust this (?:folder|directory)|trust the (?:files|contents) (?:in|of) this (?:folder|directory)/i.test(
    text.replace(/\s+/g, " "),
  );
}

/** The last `maxLines` lines of an xterm buffer as plain text. */
export function bufferTail(
  buffer: { length: number; getLine(i: number): { translateToString(trim?: boolean): string } | null | undefined },
  maxLines = 60,
): string {
  const lines: string[] = [];
  for (let i = Math.max(0, buffer.length - maxLines); i < buffer.length; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

/** Claim the right to auto-submit `input` for `ptyId`. React dev remounts,
 *  duplicate panes, or duplicate ready events must not type the same run command
 *  twice into one shell. */
export function claimInitialInput(ptyId: string, input: string): boolean {
  const key = `${ptyId}\0${input}`;
  if (claimedInitialInputs.has(key)) return false;
  claimedInitialInputs.add(key);
  return true;
}

export function clearClaimedInitialInputsForTest(): void {
  claimedInitialInputs.clear();
}

/** Longest clipboard a program may set via OSC 52. Generous for a copied command,
 *  a diff hunk or a key, small enough that the clipboard cannot be used as a
 *  megabyte-scale dumping ground the user can't see. */
export const OSC52_MAX_CHARS = 4096;

/**
 * Decode an OSC 52 clipboard-write payload into the text it may set, or `null`
 * when the sequence must be ignored.
 *
 * OSC 52 is how a TUI (Claude Code's copy action among them) sets the system
 * clipboard when it can't reach it itself — over SSH, inside tmux, inside a
 * container. Tabtivity honours it, because xterm parses OSC 52 but performs no
 * action without a handler, so the CLI's "copied!" would otherwise be a lie.
 *
 * But *any* process whose output reaches a terminal pane can emit it — a
 * contained agent, a `make` run, a hostile repo's build script, `cat` of a
 * crafted file, a remote host — and the user's next Ctrl+V might land in a root
 * shell or at a `sudo` prompt. So the payload is bounded rather than trusted:
 *
 * - **Newlines are stripped.** A `\n` is what turns a paste into an *executed*
 *   command line; without one the payload has to be read and submitted by hand.
 *   (Bracketed paste is no defence — the payload can carry its own newline.)
 * - **Length is capped** at [`OSC52_MAX_CHARS`], so a long run of spaces cannot
 *   scroll a malicious tail out of sight.
 * - A read-back query (`Pc;?`) returns `null`: answering it would let any program
 *   read whatever the user last copied anywhere.
 * - A target register that isn't the clipboard (`p`/`s` only) returns `null`.
 *
 * The caller adds the two things this function cannot see: the pane must be
 * focused, and the write is announced.
 */
export function decodeOsc52Clipboard(data: string): string | null {
  const parts = data.split(";");
  // Pc (parts[0]) names the target selection buffer(s) — "c" (clipboard), ""
  // (spec default, also clipboard), or a combination like "cp"/"cs" that includes
  // clipboard alongside primary/select. Anything without "c" (e.g. a
  // primary-selection-only "p") isn't Tabtivity's one clipboard.
  if (parts.length < 2 || (parts[0] !== "" && !parts[0].includes("c"))) return null;
  if (parts[1] === "?") return null;
  let text: string;
  try {
    const binary = atob(parts[1]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    text = new TextDecoder("utf-8").decode(bytes);
  } catch {
    // Malformed payload — ignore rather than surface a write error.
    return null;
  }
  const flattened = text.replace(/[\r\n]+/g, " ").slice(0, OSC52_MAX_CHARS);
  return flattened.length > 0 ? flattened : null;
}

/** Shift+Tab, the way xterm.js encodes it: the legacy backtab `ESC [ Z`. */
export const LEGACY_SHIFT_TAB = `${CSI}Z`;

/** Shift+Tab in the kitty keyboard protocol's CSI-u form: Tab (9) with the
 *  Shift modifier (2). */
export const CSI_U_SHIFT_TAB = `${CSI}9;2u`;

/** Which byte sequence a Shift+Tab must arrive as for `cmd`'s TUI to see it.
 *
 *  Every agent CLI binds its permission-mode cycle to Shift+Tab, and all of
 *  them but one read the legacy backtab `ESC [ Z` that xterm.js sends — xterm.js
 *  implements neither the kitty keyboard protocol nor `modifyOtherKeys`, so the
 *  backtab is all a pane can produce on its own.
 *
 *  Codex is the exception. It binds `chat.next_permission_mode` to Tab-with-
 *  Shift and only recognizes the CSI-u encoding of it; a backtab matches
 *  nothing, so the mode never cycles even though its composer footer advertises
 *  "shift+tab to cycle". Verified against codex-cli 0.151.0 in a legacy-key
 *  terminal: `ESC [ Z` changed nothing, `ESC [ 9 ; 2 u` stepped the mode. Codex
 *  parses CSI-u whether or not the terminal ever answered its keyboard-
 *  enhancement probe, so sending that form needs no negotiation.
 *
 *  Codex-only on purpose: Claude Code and Qwen Code cycle on the backtab, and
 *  re-encoding Shift+Tab terminal-wide would break every ordinary curses
 *  program that reads backtab as "focus previous field". */
export function shiftTabForAgent(cmd: string | null | undefined): string {
  return isCodexCommand(cmd) ? CSI_U_SHIFT_TAB : LEGACY_SHIFT_TAB;
}

/** Whether `cmd` launches Codex — matched on the binary's leaf name, so an
 *  absolute path or a versioned wrapper still counts. */
export function isCodexCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false;
  const leaf = cmd.trim().split(/[\\/]/).pop() ?? "";
  return leaf.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() === "codex";
}

/** Whether `cmd` launches Claude Code — same leaf-name match as
 *  {@link isCodexCommand}. Used to decide whether a tab's auto-typed initial
 *  input may be submitted at all: Claude opens a trust dialog in a folder it
 *  has not seen before, and the blind Enter that submits the input confirms
 *  that dialog's default row, `No, exit`. */
export function isClaudeCommand(cmd: string | null | undefined): boolean {
  if (!cmd) return false;
  const leaf = cmd.trim().split(/[\\/]/).pop() ?? "";
  return leaf.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase() === "claude";
}

/** The session name a Claude tab's `/rename <name>` initial input sets, handed
 *  to `pty_spawn` so a CLI that takes `--name` gets it at launch instead of as
 *  a line typed a few seconds in. `null` for anything else. */
export function claudeLaunchName(cmd: string | null | undefined, initialInput: string | null | undefined): string | null {
  if (!isClaudeCommand(cmd) || !initialInput) return null;
  const match = /^\/rename\s+(\S.*)$/.exec(initialInput.trim());
  return match ? match[1].trim() : null;
}

/**
 * What a primary-button `mousedown` inside an AGENT pane means.
 *
 * Two gestures agent panes need and a plain xterm does not give them:
 *
 *  - **`"paste"`** — a double-click inserts the clipboard at the agent's prompt
 *    (the ask). xterm would select the word under the cursor instead, which
 *    copy-on-select would then push to the clipboard — overwriting the very text
 *    the double-click was meant to paste. So the double-click is taken away from
 *    xterm entirely rather than layered on top of it.
 *  - **`"select"`** — the running program has grabbed the mouse (`mouseGrabbed`:
 *    the TUI turned on mouse tracking, as Codex and other full-screen agents do),
 *    so every press is reported to it and a drag selects nothing. Terminals let
 *    you override that with a modifier; nobody knows the chord, which is what
 *    "can't copy out of an agent tab" actually is. In an agent pane a plain drag
 *    selects, because the mouse there is worth more as a way to copy the agent's
 *    output than as a way to click inside its TUI.
 *
 * Any modifier means the user is asking for something specific — Shift extends /
 * forces a selection, Alt column-selects, and Ctrl is left as the escape hatch
 * that still reaches a mouse-driven TUI — so a modified press is always passed
 * through untouched.
 *
 * Shell and command tabs (`pasteOnDoubleClick` false) take the `"select"` half
 * only. Every local tab runs inside tmux with `mouse on`, so the mouse is ALWAYS
 * grabbed there: a plain drag went to tmux's copy-mode, which jumps the view and
 * never reaches the OS clipboard, instead of making the xterm selection that
 * copy-on-select copies. There a double-click stays xterm's select-a-word.
 */
export type AgentMouseDown = "paste" | "select" | "pass";

export function agentMouseDownAction(
  ev: { button: number; detail: number; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean },
  mouseGrabbed: boolean,
  pasteOnDoubleClick = true,
): AgentMouseDown {
  if (ev.button !== 0) return "pass";
  if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return "pass";
  // `detail` counts the clicks of the current sequence: 2 is the second press of
  // a double-click (the first arrived as a plain 1 and did nothing but place an
  // empty selection), 3 the triple-click that selects a whole line.
  if (ev.detail === 2 && pasteOnDoubleClick) return "paste";
  return mouseGrabbed ? "select" : "pass";
}

/**
 * The event property xterm reads as "select anyway, even though the program has
 * the mouse" — `SelectionService.shouldForceSelection`, which is `shiftKey`
 * everywhere except macOS, where it is `altKey` and honoured only while the
 * `macOptionClickForcesSelection` option is on (TerminalView sets it).
 *
 * Forcing selection by re-defining this one property on the event is deliberate:
 * xterm exposes no API for it, and the alternative — hand-rolling selection from
 * pixel coordinates — would duplicate its buffer geometry. Note that xterm's
 * *incremental* (shift-extends-the-selection) branch is guarded by the selection
 * service being enabled, and it is enabled only while the program has NOT
 * grabbed the mouse — the one case where we never force. So a forced press
 * always starts a fresh selection.
 */
export const FORCE_SELECTION_MODIFIER: "altKey" | "shiftKey" = IS_MAC ? "altKey" : "shiftKey";

/**
 * Whether a right-click's `contextmenu` should be cancelled so the webview's
 * native menu does not open. Yes while the program has grabbed the mouse: the
 * press was already reported to it, and the click is its to answer. Claude
 * Code's full-screen TUI answers a right-click on Linux/Windows by reading the
 * clipboard and pasting it itself, so a native menu opened over the same click
 * offered a Paste that put the text in a second time (the "right-click, Paste
 * pastes twice" report). Shift reaches the native menu anyway, as it does in
 * GNOME Terminal and every other terminal that hands the mouse to the program.
 */
export function suppressNativeContextMenu(ev: { shiftKey: boolean }, mouseGrabbed: boolean): boolean {
  return mouseGrabbed && !ev.shiftKey;
}

/** How long a freshly spawned tab may stay silent before it says so. */
export const SILENT_START_MS = 10_000;

/** Where a silent launch is stuck: the spawn never came back, or it came back
 *  and the program has drawn nothing. */
export type SilentStartNotice = "pending" | "noOutput";

/**
 * What a tab that is still blank {@link SILENT_START_MS} after its launch should
 * say about itself, or `null` for nothing.
 *
 * A launch that never completes leaves the pane empty with no message at all —
 * a spawn error prints itself, and an exit prints `[process exited]`, but a
 * spawn call that simply never resolves looks exactly like a program that is
 * slow to draw, and on a light theme the pane is plain white. So a silent start
 * names which of the two it is: `pending` (Tabtivity never heard back from the
 * launch) or `noOutput` (the program runs and has shown nothing). A failed spawn
 * has already explained itself and an exited program has its own line, so
 * neither gets a second one.
 */
export function silentStartNotice(state: {
  spawn: "pending" | "spawned" | "failed";
  sawOutput: boolean;
  exited: boolean;
}): SilentStartNotice | null {
  if (state.sawOutput || state.exited || state.spawn === "failed") return null;
  return state.spawn === "pending" ? "pending" : "noOutput";
}

/** The program a tab runs, as a person would name it: the command's basename,
 *  without a Windows `.exe`. Empty for the default shell. */
export function terminalProgramLabel(cmd: string): string {
  const base = cmd.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.exe$/i, "");
}
