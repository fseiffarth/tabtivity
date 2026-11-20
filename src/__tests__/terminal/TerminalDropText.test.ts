import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { dropErrorKey, dropText, insertIntoReader, onReaderInsert, pasteClipboardImage } from "../../lib/terminal/terminalDrop";
import { markServerClient, resetLinkStateForTests } from "../../lib/transport/linkState";

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

  it("the browser client sends the picture the paste carried, never asking for the server's clipboard", async () => {
    const mocked = vi.mocked(invoke);
    mocked.mockReset();
    markServerClient();
    try {
      mocked.mockResolvedValueOnce("x/1-clipboard.png");
      const picture = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
      expect(await pasteClipboardImage("p:1", true, picture)).toEqual({ text: "@x/1-clipboard.png ", error: null });
      expect(mocked).toHaveBeenLastCalledWith("pty_paste_image", { id: "p:1", agent: true, image: "iVBORw==" });
      // A paste that carried no picture says nothing and sends nothing.
      expect(await pasteClipboardImage("p:1", true, null)).toEqual({ text: "", error: null });
      expect(mocked).toHaveBeenCalledTimes(1);
      mocked.mockRejectedValueOnce("file_too_large");
      expect((await pasteClipboardImage("p:1", false, picture)).error).toBe("terminal.paste.imageTooLarge");
      expect(mocked).not.toHaveBeenCalledWith("pty_paste_clipboard_image", expect.anything());
    } finally {
      resetLinkStateForTests();
    }
  });
});
