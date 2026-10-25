import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dropErrorKey, dropText, insertIntoReader, onReaderInsert, pasteClipboardImage } from "../../lib/terminal/terminalDrop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("terminalDrop", () => {
  it("types @ references for an agent, quoted paths for a shell", () => {
    expect(dropText(["a/x.png", "a/y.pdf"], true)).toBe("@a/x.png @a/y.pdf ");
    expect(dropText(["/h/it's.png"], false)).toBe("'/h/it'\\''s.png' ");
  });

  it("routes text to the mounted composer of that pane only", () => {
    const got: string[] = [];
    const off = onReaderInsert("p:1", (text) => got.push(text));
    expect(insertIntoReader("p:2", "x")).toBe(false);
    expect(insertIntoReader("p:1", "y")).toBe(true);
    off();
    expect(insertIntoReader("p:1", "z")).toBe(false);
    expect(got).toEqual(["y"]);
  });

  it("an unknown refusal still says something", () => {
    expect(dropErrorKey("remote_tab")).toBe("terminal.drop.remote");
    expect(dropErrorKey("Error: boom")).toBe("terminal.drop.failed");
  });

  it("a pasted clipboard image is typed like a dropped file", async () => {
    const mocked = vi.mocked(invoke);
    mocked.mockResolvedValueOnce("x/1-clipboard.png");
    expect(await pasteClipboardImage("p:1", true)).toEqual({ text: "@x/1-clipboard.png ", error: null });
    expect(mocked).toHaveBeenLastCalledWith("pty_paste_clipboard_image", { id: "p:1", agent: true });
    mocked.mockRejectedValueOnce("no_clipboard_image");
    expect(await pasteClipboardImage("p:1", true)).toEqual({ text: "", error: null });
    mocked.mockRejectedValueOnce("remote_tab");
    expect((await pasteClipboardImage("p:1", false)).error).toBe("terminal.paste.imageRemote");
    mocked.mockRejectedValueOnce("Error: boom");
    expect((await pasteClipboardImage("p:1", true)).error).toBe("terminal.paste.imageFailed");
  });
});
