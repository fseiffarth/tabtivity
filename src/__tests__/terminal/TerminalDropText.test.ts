import { describe, expect, it } from "vitest";
import { dropErrorKey, dropText, insertIntoReader, onReaderInsert } from "../../lib/terminal/terminalDrop";

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
});
