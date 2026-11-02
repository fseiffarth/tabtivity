import { describe, expect, it } from "vitest";
import {
  isStopWord,
  matchOption,
  sanitizeVoiceTranscript,
  speechChunks,
  spokenSend,
  spokenText,
} from "../../../shared/voice";

describe("voice text shared by the phone and the desktop", () => {
  it("removes control bytes before a transcript reaches the PTY", () => {
    expect(sanitizeVoiceTranscript("  inspect\nthis\u001b[2J  now\u0000 ")).toBe(
      "inspect this [2J now",
    );
  });

  it("sends on a spoken \"go on\" or \"los\" said last, without those words", () => {
    expect(spokenSend("fix the login go on")).toBe("fix the login");
    expect(spokenSend("Fix the login. Go on.")).toBe("Fix the login.");
    expect(spokenSend("fix the login, go on")).toBe("fix the login");
    expect(spokenSend("Behebe den Fehler los")).toBe("Behebe den Fehler");
    expect(spokenSend("Behebe den Fehler. Los!")).toBe("Behebe den Fehler.");
    expect(spokenSend("go on")).toBe("");
  });

  it("leaves a \"go on\" or \"los\" that is not a send in the draft", () => {
    expect(spokenSend("fix the login")).toBeNull();
    expect(spokenSend("go on and fix the login")).toBeNull();
    expect(spokenSend("what is going on")).toBeNull();
    expect(spokenSend("das ist ziellos")).toBeNull();
    expect(spokenSend("Was ist los?")).toBeNull();
    expect(spokenSend("fly to Los Angeles")).toBeNull();
  });

  it("hears \"stop\" or \"stopp\" said alone as the stop word", () => {
    for (const said of ["stop", "Stop.", "STOPP!", "Stop, stop!", " stopp stopp ", "Stopp."]) {
      expect(isStopWord(said), said).toBe(true);
    }
  });

  it("leaves a sentence with \"stop\" in it to the agent", () => {
    for (const said of ["don't stop", "stop the server", "Stop it now", "stopped", "", "  ", "..."]) {
      expect(isStopWord(said), said).toBe(false);
    }
  });

  it("picks a question card's option by number, word or ordinal", () => {
    expect(matchOption("one", 3)).toBe(0);
    expect(matchOption("Option two.", 3)).toBe(1);
    expect(matchOption("option 3", 3)).toBe(2);
    expect(matchOption("2", 3)).toBe(1);
    expect(matchOption("Nummer drei, bitte", 3)).toBe(2);
    expect(matchOption("zwo", 2)).toBe(1);
    expect(matchOption("the second one", 3)).toBe(1);
    expect(matchOption("die Zweite", 3)).toBe(1);
    expect(matchOption("den ersten", 3)).toBe(0);
    expect(matchOption("erster", 3)).toBe(0);
    expect(matchOption("Please, first.", 2)).toBe(0);
    expect(matchOption("eins", 2)).toBe(0);
  });

  it("takes \"to\" and \"for\" as numbers only after \"option\"", () => {
    expect(matchOption("option to", 3)).toBe(1);
    expect(matchOption("number for", 4)).toBe(3);
    expect(matchOption("to", 3)).toBeNull();
    expect(matchOption("for", 4)).toBeNull();
  });

  it("picks nothing from a sentence, an article or a number off the card", () => {
    expect(matchOption("take option two", 3)).toBeNull();
    expect(matchOption("I have one question", 3)).toBeNull();
    expect(matchOption("ein", 3)).toBeNull();
    expect(matchOption("four", 3)).toBeNull();
    expect(matchOption("option 0", 3)).toBeNull();
    expect(matchOption("option", 3)).toBeNull();
    expect(matchOption("", 3)).toBeNull();
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

  it("packs sentences into pieces a voice speaks whole", () => {
    const chunks = speechChunks("One. Two is here! Three? And a fourth sentence that is long.", 20);
    expect(chunks).toEqual(["One. Two is here!", "Three?", "And a fourth", "sentence that is", "long."]);
    expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(speechChunks("", 20)).toEqual([]);
  });

  it("does not end a sentence at a dot inside a word or a number", () => {
    expect(speechChunks("Open chime.ts first. Then v0.2.47 is out.", 22)).toEqual(["Open chime.ts first.", "Then v0.2.47 is out."]);
  });
});
