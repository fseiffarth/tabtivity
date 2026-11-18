import { describe, expect, it } from "vitest";
import { isPermissionDialog, permissionSubject } from "../../../mobile-web/src/terminal/permissionSubject";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { readReaderLive } from "../../lib/agents/readerLive";

/**
 * The permission dialogs of Claude Code 2.1.327 as the probe captured them
 * (the `open` frames of `tui_edit`, `tui_write`, `tui_fetch`, `tui_bash` under `tmp/verify-cli/claude/2.1.327-ask/turn/`, 110x40,
 * colours and hyperlinks stripped, the probe's own folder replaced by `/work`),
 * run through the Reader's own screen reading, then through the subject
 * matchers the way the cards call them (`ask`, `context` and the option labels).
 */
const RULE = "─".repeat(110);
const DASH = "╌".repeat(110);

const EDIT = [
  "❯ edit the notes", "", "  Read 1 file", "● Update(notes.txt)", RULE,
  " Edit file", " notes.txt", DASH, " 1 -old line", " 1 +new line", DASH,
  " Do you want to make this edit to notes.txt?",
  " ❯ 1. Yes",
  "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
  "      (shift+tab)",
  "   3. No", "", " Esc to cancel · Tab to amend",
];
const WRITE = [
  "❯ write a file", "", "● Write(fresh.txt)", RULE,
  " Create file", " fresh.txt", DASH, "  1 hello", DASH,
  " Do you want to create fresh.txt?",
  " ❯ 1. Yes",
  "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session",
  "      (shift+tab)",
  "   3. No", "", " Esc to cancel · Tab to amend",
];
const FETCH = [
  "❯ fetch it", "", "● Fetch(https://example.com/probe)", RULE,
  " Fetch", " Claude wants to fetch content from example.com", DASH, " url: https://example.com/probe", " prompt: summarise", DASH,
  " Do you want to allow Claude to fetch this content?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for example.com",
  "   3. No, and tell Claude what to do differently (esc)",
];
const BASH = [
  "❯ run it", "", "● Probing", "  ⎿  $ touch tui.txt", RULE,
  " Bash command", " Tip: auto mode handles these prompts for you — choose \"switch to auto mode\" below", " probe", DASH, " touch tui.txt", DASH,
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and always allow access to",
  "      /work",
  "      from this project",
  "   3. Yes, and switch to auto mode · auto mode handles these prompts for you",
  "   4. No", "", " Esc to cancel · Tab to amend",
];

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

/** What the cards hand the matcher for a screen, or null when it is no permission dialog. */
function dialogTexts(rows: string[]): string[] | null {
  const live = readReaderLive(plainBuffer(rows), "Claude", 110);
  if (!live.question || !isPermissionDialog(live.question, live.tabs.length)) return null;
  return [...live.ask, ...live.context, ...live.question.options.map((option) => option.label)];
}

const T = "2026-11-18T09:00:00.000Z";
const tools = (...list: Array<[string, string?]>) => ({ waitingTools: list.map(([name, subject]) => ({ name, ...(subject ? { subject } : {}), at: T })) });

describe("Claude 2.1.327's permission dialogs, as probed", () => {
  it("reads each as a permission dialog", () => {
    for (const rows of [EDIT, WRITE, FETCH, BASH]) expect(dialogTexts(rows), rows[0]).not.toBeNull();
  });

  it("names the file of an Edit dialog from the matching call, and nothing from another call", () => {
    const dialog = dialogTexts(EDIT)!;
    expect(permissionSubject(tools(["Edit", "notes.txt"]), dialog)).toEqual({ kind: "file", tool: "Edit", subject: "notes.txt" });
    expect(permissionSubject(tools(["MultiEdit", "src/notes.txt"]), dialog)).toEqual({ kind: "file", tool: "MultiEdit", subject: "src/notes.txt" });
    // Not a file tool, a fetch, a running shell, a call nothing waits on.
    expect(permissionSubject(tools(["WebFetch", "https://example.com"]), dialog)).toBeNull();
    expect(permissionSubject(tools(["Agent"]), dialog)).toBeNull();
    expect(permissionSubject({ shells: [{ command: "cargo build", at: T }] }, dialog)).toBeNull();
    expect(permissionSubject(tools(), dialog)).toBeNull();
  });

  it("names the file of a Create dialog from a Write call", () => {
    const dialog = dialogTexts(WRITE)!;
    expect(permissionSubject(tools(["Write", "fresh.txt"]), dialog)).toEqual({ kind: "file", tool: "Write", subject: "fresh.txt" });
    // Two file calls: the one whose leaf the dialog prints, whichever is newer.
    expect(permissionSubject({ waitingTools: [{ name: "Write", subject: "fresh.txt", at: "2026-11-18T09:00:00.000Z" }, { name: "Edit", subject: "other.txt", at: "2026-11-18T09:00:09.000Z" }] }, dialog))
      .toEqual({ kind: "file", tool: "Write", subject: "fresh.txt" });
    expect(permissionSubject(tools(["WebFetch", "https://example.com/probe"]), dialog)).toBeNull();
    expect(permissionSubject({ shells: [{ command: "touch fresh.txt", at: T }] }, dialog)).toBeNull();
  });

  it("names the URL of a Fetch dialog from a WebFetch call, and nothing from a file call", () => {
    const dialog = dialogTexts(FETCH)!;
    expect(permissionSubject(tools(["WebFetch", "https://example.com"]), dialog)).toEqual({ kind: "url", tool: "WebFetch", subject: "https://example.com" });
    // The phone's mask can leave the URL out: the tool's name is what is known.
    expect(permissionSubject(tools(["WebFetch"]), dialog)).toEqual({ kind: "tool", tool: "WebFetch", subject: "" });
    expect(permissionSubject(tools(["Edit", "notes.txt"]), dialog)).toBeNull();
    expect(permissionSubject({ shells: [{ command: "curl example.com", at: T }] }, dialog)).toBeNull();
    expect(permissionSubject(tools(), dialog)).toBeNull();
  });

  it("names the command of a Bash dialog from the waiting shell that it prints, not an unrelated one", () => {
    const dialog = dialogTexts(BASH)!;
    expect(permissionSubject({ shells: [{ command: "touch tui.txt", at: T }] }, dialog)).toEqual({ kind: "command", tool: "Bash", subject: "touch tui.txt" });
    // Of two waiting shells, the one on screen, whichever is newer.
    expect(permissionSubject({ shells: [{ command: "touch tui.txt", at: T }, { command: "cargo build", at: "2026-11-18T09:00:09.000Z" }] }, dialog)?.subject).toBe("touch tui.txt");
    expect(permissionSubject({ shells: [{ command: "cargo build", at: T }] }, dialog)).toBeNull();
    expect(permissionSubject({ shells: [{ command: "touch tui.txt", at: T, background: true }] }, dialog)).toBeNull();
    expect(permissionSubject(tools(["Edit", "notes.txt"]), dialog)).toBeNull();
    expect(permissionSubject(tools(["WebFetch", "https://example.com"]), dialog)).toBeNull();
  });
});
