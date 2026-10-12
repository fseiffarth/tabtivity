/**
 * `describeFileErrorKey` maps a backend file error to the message a viewer
 * shows. The viewers' saves refuse a file that is a link (decision D1,
 * `commands::fs::open_confined`), and that refusal gets its own sentence
 * rather than the generic "couldn't open".
 */
import { describe, expect, it } from "vitest";
import { describeFileErrorKey } from "../../components/embed/fileAccess";

describe("describeFileErrorKey", () => {
  it("names a save refused because the file is a link", () => {
    expect(
      describeFileErrorKey("'/p/deck.eldeck.json' is a link; viewers do not save through links"),
    ).toBe("fileError.link");
  });

  it("keeps the existing mappings", () => {
    expect(describeFileErrorKey("/p/x: No such file or directory")).toBe("fileError.missing");
    expect(describeFileErrorKey("Permission denied (os error 13)")).toBe("fileError.permission");
    expect(describeFileErrorKey("not a file")).toBe("fileError.open");
  });
});
