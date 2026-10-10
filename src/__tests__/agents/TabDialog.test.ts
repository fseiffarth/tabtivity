/**
 * The question line of a dialog an agent tab waits on, for the markup pill
 * (`lib/agents/tabDialog`, `dialogLine`): read from the router's retained
 * output drawn offscreen, since a hidden pane's own xterm is not fed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { readTabDialogLine } from "../../lib/agents/tabDialog";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { dialogLine } from "../../../mobile-web/src/markup/submitState";

/** Claude Code's permission prompt, as the Reader's tests paint it. */
const PERMISSION = [
  "> fix the strings",
  "",
  "⏺ I'll update the file.",
  "",
  "Edit file",
  "  src/lib/i18n.ts",
  "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  "  esc to cancel",
].join("\r\n");

afterEach(() => mocks.invoke.mockReset());

describe("readTabDialogLine", () => {
  it("reads the dialog's question off the retained output", async () => {
    mocks.invoke.mockResolvedValue({ data: PERMISSION, startOffset: 0, endOffset: PERMISSION.length });
    expect(await readTabDialogLine("p1:t1", "Claude")).toBe("Do you want to make this edit to i18n.ts?");
    expect(mocks.invoke).toHaveBeenCalledWith("pty_scrollback", { id: "p1:t1" });
  });

  it("reads none when no dialog is on screen, or nothing was retained", async () => {
    mocks.invoke.mockResolvedValue({ data: "> hi\r\n\r\n⏺ Hello.\r\n", startOffset: 0, endOffset: 18 });
    expect(await readTabDialogLine("p1:t1", "Claude")).toBeUndefined();
    mocks.invoke.mockResolvedValue(null);
    expect(await readTabDialogLine("p1:t1", "Claude")).toBeUndefined();
  });

  it("falls back to the pane's own screen only without the command", async () => {
    const pane = new Terminal({ cols: 80, rows: 20 });
    await new Promise<void>((resolve) => pane.write(PERMISSION, resolve));
    registerTerminal("p1:t1", pane);
    try {
      mocks.invoke.mockRejectedValue(new Error("unknown command"));
      expect(await readTabDialogLine("p1:t1", "Claude")).toBe("Do you want to make this edit to i18n.ts?");
    } finally {
      unregisterTerminal("p1:t1", pane);
      pane.dispose();
    }
  });
});

describe("dialogLine", () => {
  it("takes the last paragraph, whitespace collapsed", () => {
    expect(dialogLine(["Bash command", "  Do you want   to proceed?  ", ""])).toBe("Do you want to proceed?");
    expect(dialogLine([])).toBeUndefined();
    expect(dialogLine(["   "])).toBeUndefined();
  });

  it("clips a long one", () => {
    const line = dialogLine(["word ".repeat(80)]);
    expect(line?.length).toBeLessThanOrEqual(160);
    expect(line?.endsWith("…")).toBe(true);
  });
});
