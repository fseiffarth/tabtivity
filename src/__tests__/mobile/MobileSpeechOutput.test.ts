import { describe, expect, it } from "vitest";
import { speechChunks, speechOutputSupported, spokenText } from "../../../mobile-web/src/speechOutput";
import { BRAND } from "../../lib/brand";

describe(`${BRAND.display} Mobile read-aloud`, () => {
  it("is absent where the browser cannot speak", () => {
    expect(speechOutputSupported({} as Window)).toBe(false);
    expect(speechOutputSupported({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} } as unknown as Window)).toBe(true);
  });

  it("says an answer's prose, not its markup", () => {
    const answer = [
      "## Fixed the **login**",
      "",
      "See [the docs](https://example.com/a) or https://example.com/b for `more`.",
      "",
      "- first item",
      "- [x] second item.",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "> Done\u001b[2J now",
    ].join("\n");

    expect(spokenText(answer, "code block")).toBe(
      "Fixed the login. See the docs or for more. first item. second item. code block. Done [2J now",
    );
  });

  it("stands in for a code block that never closes", () => {
    expect(spokenText("Run this:\n```\nrm -rf x", "code block")).toBe("Run this: code block.");
  });

  it("reads a table as its cells", () => {
    expect(spokenText("| a | b |\n|---|:-:|\n| 1 | 2 |", "code")).toBe("a, b. 1, 2.");
  });

  it("packs sentences into pieces a phone speaks whole", () => {
    const chunks = speechChunks("One. Two is here! Three? And a fourth sentence that is long.", 20);
    expect(chunks).toEqual(["One. Two is here!", "Three?", "And a fourth", "sentence that is", "long."]);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(speechChunks("")).toEqual([]);
  });
});
