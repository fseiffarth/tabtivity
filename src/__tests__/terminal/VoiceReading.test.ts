import { describe, expect, it } from "vitest";
import {
  codeChunks,
  createReadingCursor,
  DRIVING_LIMITS,
  outlineAnswer,
  READING_LABEL_KEYS,
  readingLabels,
  type ReadingAnswer,
  type ReadingLabelKey,
  type ReadingOptions,
  type ReadingOutline,
} from "../../../shared/voiceReading";

/** English stand-ins for the dictionary lines, `{name}` filled like
 * `translate` does. */
const EN: Record<ReadingLabelKey, string> = {
  "voice.reading.code": "code block, {n} lines",
  "voice.reading.codeOne": "code block, 1 line",
  "voice.reading.table": "a table, {n} rows",
  "voice.reading.tableOne": "a table, 1 row",
  "voice.reading.more": "and {n} more",
  "voice.reading.link": "a link",
  "voice.reading.answered": "{agent} answered, about {n} lines",
  "voice.reading.answeredOne": "{agent} answered, one line",
  "voice.reading.answeredLong": "{agent} answered, about {n} lines. Say summary, or listen later.",
  "voice.reading.answeredLongOne": "{agent} answered, one line. Say summary, or listen later.",
  "voice.reading.where": "answer {answer} of {answers}, section {section} of {sections}",
};

const labels = readingLabels((key, params) =>
  EN[key].replace(/\{(\w+)\}/g, (all, name: string) => (params && name in params ? String(params[name]) : all)),
);

const options: ReadingOptions = { labels };
/** Limits under which `ANSWER` is long. */
const tight = { maxSentences: 2, maxChars: 60, announceLong: false };

const said = (outline: ReadingOutline) => outline.sections.map((section) => section.chunks.map((chunk) => chunk.text));

const ANSWER = [
  "Intro line here.",
  "",
  "## Changes",
  "",
  "I fixed the login. It works now.",
  "",
  "```ts",
  "const a = 1;",
  "const b = 2;",
  "```",
  "",
  "## Files",
  "",
  "| File | Lines |",
  "| --- | --- |",
  "| a.ts | 3 |",
  "| b.ts | 4 |",
  "",
  "## Summary",
  "",
  "Login fixed, tests pass.",
].join("\n");

describe("the reading outline", () => {
  it("splits at headings and stands placeholders in for code and tables", () => {
    const outline = outlineAnswer(ANSWER, "full", options);
    expect(outline.sections.map((section) => section.heading)).toEqual([null, "Changes", "Files", "Summary"]);
    expect(said(outline)).toEqual([
      ["Intro line here."],
      ["Changes", "I fixed the login. It works now.", "code block, 2 lines"],
      ["Files", "a table, 2 rows"],
      ["Summary", "Login fixed, tests pass."],
    ]);
    expect(outline.codes).toEqual(["const a = 1;\nconst b = 2;"]);
    expect(outline.hasSummary).toBe(true);
    expect(outline.sections[1].chunks[2]).toMatchObject({ kind: "code", code: 0 });
  });

  it("reads a table's rows and a long list's tail only for \"read all\"", () => {
    const text = ["Steps:", "", "- one", "- two", "- three", "- four", "- five", "- six", "- seven", "", "| A | B |", "|---|---|", "| 1 | 2 |"].join("\n");
    expect(said(outlineAnswer(text, "full", options))[0]).toEqual([
      "Steps:", "one", "two", "three", "and 4 more", "a table, 1 row",
    ]);
    expect(said(outlineAnswer(text, "all", options))[0]).toEqual([
      "Steps:", "one", "two", "three", "four", "five", "six", "seven", "a table, 1 row", "A, B.", "1, 2.",
    ]);
  });

  it("reads a list of five whole, and items that run on over lines and hold code", () => {
    const text = ["1. Run the tests", "   after the build.", "2. Then:", "   ```sh", "   npm test", "", "   npm run lint", "   ```", "3. Done", "- four", "- five"].join("\n");
    const outline = outlineAnswer(text, "full", options);
    expect(said(outline)[0]).toEqual(["Run the tests after the build.", "Then:", "code block, 3 lines", "Done", "four", "five"]);
    expect(outline.codes).toEqual(["npm test\n\nnpm run lint"]);
  });

  it("says paths by their file name and URLs as a link", () => {
    const text = "See `src/lib/voice/chime.ts:42` and ~/notes/todo.md, also [the docs](https://example.com/x) and https://example.com/y. And/or 1/2 stay.";
    expect(said(outlineAnswer(text, "full", options))[0].join(" ")).toBe(
      "See chime.ts and todo.md, also the docs and a link. And/or 1/2 stay.",
    );
    expect(said(outlineAnswer("Open **/etc/hosts** now.", "full", options))[0][0]).toBe("Open hosts now.");
  });

  it("cuts long paragraphs into chunks of at most the maximum", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = outlineAnswer(text, "full", options).sections[0].chunks;
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(220);
    expect(outlineAnswer(text, "full", { ...options, maxChunk: 60 }).sections[0].chunks.every((chunk) => chunk.text.length <= 60)).toBe(true);
  });

  it("handles an empty answer, an unclosed fence and nested items", () => {
    expect(outlineAnswer("", "full", options).sections).toEqual([]);
    expect(outlineAnswer("```", "brief", options).sections).toEqual([
      { heading: null, chunks: [{ text: "code block, 0 lines", kind: "code", code: 0 }] },
    ]);
    const streaming = outlineAnswer("Here:\n\n```ts\nconst a = 1;", "full", options);
    expect(said(streaming)[0]).toEqual(["Here:", "code block, 1 line"]);
    expect(streaming.codes).toEqual(["const a = 1;"]);
    expect(said(outlineAnswer("- top\n  - inner one\n  - inner two\n- next", "full", options))[0]).toEqual([
      "top. inner one. inner two.", "next",
    ]);
    const fenced = outlineAnswer("- run\n  ```\n  make\n  ```\n  - then this\n- done", "full", options);
    expect(said(fenced)[0]).toEqual(["run", "code block, 1 line", "then this.", "done"]);
  });

  it("takes a bold line for a heading", () => {
    const outline = outlineAnswer("**What changed**\nThe button.\n\n**In short:**\nIt works.", "full", options);
    expect(outline.sections.map((section) => section.heading)).toEqual(["What changed", "In short"]);
  });
});

describe("brief mode and the summary", () => {
  it("says who answered and how long, then each heading with its first sentence", () => {
    expect(said(outlineAnswer(ANSWER, "brief", { ...options, limits: tight }, "Claude"))).toEqual([
      ["Claude answered, about 10 lines", "Intro line here."],
      ["Changes", "I fixed the login."],
      ["Files", "a table, 2 rows"],
      ["Summary", "Login fixed, tests pass."],
    ]);
  });

  it("reads a short answer whole", () => {
    expect(said(outlineAnswer("Done. Tests pass.", "brief", options, "Claude"))).toEqual([["Done. Tests pass."]]);
  });

  it("only announces a long answer under the driving limits", () => {
    const driving = { ...options, limits: { ...DRIVING_LIMITS, maxChars: 60 } };
    expect(said(outlineAnswer(ANSWER, "brief", driving, "Codex"))).toEqual([
      ["Codex answered, about 10 lines. Say summary, or listen later."],
    ]);
    expect(said(outlineAnswer("Done.", "brief", driving, "Codex"))).toEqual([["Done."]]);
  });

  it("finds the agent's own summary section", () => {
    expect(said(outlineAnswer(ANSWER, "summary", options))).toEqual([["Summary", "Login fixed, tests pass."]]);
    const lead = "Long text one. Two. Three.\n\n**TL;DR:** it works.";
    expect(said(outlineAnswer(lead, "summary", options))).toEqual([["TL;DR: it works."]]);
    const german = "## Änderungen\n\nViel.\n\n## Zusammenfassung\n\nAlles gut.";
    expect(said(outlineAnswer(german, "summary", options))).toEqual([["Zusammenfassung", "Alles gut."]]);
  });

  it("falls back to the headings when there is no summary", () => {
    const text = "## One\n\nFirst. More.\n\n## Two\n\nSecond. More.";
    expect(outlineAnswer(text, "summary", options).hasSummary).toBe(false);
    expect(said(outlineAnswer(text, "summary", options))).toEqual([["One", "First."], ["Two", "Second."]]);
  });
});

const answers: ReadingAnswer[] = [
  { id: "a1", agent: "Claude", text: "## A\n\nFirst one here. Second one here.\n\n## B\n\nThird one here." },
  { id: "a2", agent: "Claude", text: ANSWER },
  { id: "a3", agent: "Claude", text: "Last answer." },
];

/** A cursor with every chunk in one short sentence, so "previous chunk" is
 * easy to see. */
function cursor() {
  return createReadingCursor({ ...options, maxChunk: 20 }, answers);
}

describe("the reading cursor", () => {
  it("walks answer → section → chunk and stops at the answer's end", () => {
    const c = cursor();
    expect(c.current()).toBeNull();
    expect(c.start("a1")?.text).toBe("A");
    expect(c.advance()?.text).toBe("First one here.");
    expect(c.advance()?.text).toBe("Second one here.");
    expect(c.atSectionEnd()).toBe(true);
    expect(c.advance()?.text).toBe("B");
    expect(c.advance()?.text).toBe("Third one here.");
    expect(c.advance()).toBeNull();
    expect(c.ended()).toBe(true);
    expect(c.current()).toBeNull();
  });

  it("follows into later answers, also ones that arrive after the end", () => {
    const c = createReadingCursor(options, answers.slice(0, 1));
    c.start("a1", { follow: true });
    while (c.advance()) { /* read to the end */ }
    expect(c.ended()).toBe(true);
    c.setAnswers([answers[0], answers[2]]);
    expect(c.advance()?.text).toBe("Last answer.");
    expect(c.position()).toMatchObject({ id: "a3", answer: 2, answers: 2 });
  });

  it("skips an answer with nothing to say", () => {
    const c = createReadingCursor(options, [answers[2], { id: "empty", agent: "Claude", text: "" }, answers[0]]);
    expect(c.start("empty")).toBeNull();
    expect(c.ended()).toBe(true);
    c.start("a3", { follow: true });
    expect(c.advance()?.text).toBe("A");
    expect(c.position()).toMatchObject({ id: "a1", answer: 3 });
  });

  it("\"next\" goes to the next section, then the next answer", () => {
    const c = cursor();
    c.start("a1");
    expect(c.next()?.text).toBe("B");
    expect(c.next()?.text).toBe("Intro line here.");
    expect(c.position()).toMatchObject({ id: "a2", section: 1 });
  });

  it("\"next answer\" skips the rest, and stops at the last", () => {
    const c = cursor();
    c.start("a2");
    expect(c.nextAnswer()?.text).toBe("Last answer.");
    expect(c.nextAnswer()).toBeNull();
    expect(c.ended()).toBe(true);
    // "repeat" after the end says the last chunk again.
    expect(c.repeat()?.text).toBe("Last answer.");
  });

  it("\"back\" is the previous chunk; twice, the section before", () => {
    const c = cursor();
    c.start("a1");
    c.next(); // B
    c.advance(); // Third one here.
    expect(c.back()?.text).toBe("B");
    expect(c.back()?.text).toBe("A");
    expect(c.position()).toMatchObject({ section: 1, chunk: 1 });
    // The cursor moved on: "back" is a chunk again.
    c.advance(); // First one here.
    expect(c.back()?.text).toBe("A");
  });

  it("\"back\" crosses into the previous answer", () => {
    const c = cursor();
    c.start("a3");
    expect(c.back()?.text).toBe("pass.");
    expect(c.position()).toMatchObject({ id: "a2", section: 4 });
    expect(c.back()?.text).toBe("Summary");
  });

  it("\"repeat\" says the current chunk again", () => {
    const c = cursor();
    c.start("a1");
    c.advance();
    expect(c.repeat()?.text).toBe("First one here.");
    expect(c.current()?.text).toBe("First one here.");
  });

  it("\"where\" says the answer and the section", () => {
    const c = cursor();
    expect(c.where()).toBeNull();
    c.start("a2");
    c.next();
    expect(c.where()).toBe("answer 2 of 3, section 2 of 4");
  });

  it("\"summary\" and \"read all\" re-render this answer only", () => {
    const c = createReadingCursor({ ...options, mode: "brief", limits: tight }, answers);
    expect(c.start("a2")?.text).toBe("Claude answered, about 10 lines");
    expect(c.summary()?.text).toBe("Summary");
    expect(c.position()).toMatchObject({ sections: 1 });
    expect(c.readAll()?.text).toBe("Summary");
    expect(c.position()).toMatchObject({ section: 4, sections: 4 });
    c.start("a1");
    expect(c.position()).toMatchObject({ id: "a1" });
  });

  it("\"read the code\" reads the block, then goes on after its placeholder", () => {
    const c = createReadingCursor(options, answers);
    c.start("a2");
    expect(c.readCode()?.text).toBe("const a = 1;\nconst b = 2;");
    expect(c.position()).toMatchObject({ section: 2, chunk: 3 });
    expect(c.atSectionEnd()).toBe(false);
    expect(c.advance()?.text).toBe("Files");
    c.start("a1");
    expect(c.readCode()).toBeNull();
  });

  it("keeps its place while an answer grows, and drops it when it is gone", () => {
    const c = createReadingCursor(options, [{ id: "s", agent: "Claude", text: "First." }]);
    c.start("s");
    expect(c.advance()).toBeNull();
    c.setAnswers([{ id: "s", agent: "Claude", text: "First.\n\nSecond." }]);
    expect(c.advance()?.text).toBe("Second.");
    c.setAnswers([]);
    expect(c.position()).toBeNull();
    expect(c.ended()).toBe(true);
  });

  it("switches to the driving limits mid-answer", () => {
    const c = createReadingCursor({ ...options, mode: "brief", limits: tight }, answers);
    c.start("a2");
    expect(c.current()?.text).toBe("Claude answered, about 10 lines");
    c.setOptions({ ...options, mode: "brief", limits: { ...tight, announceLong: true } });
    expect(c.current()?.text).toBe("Claude answered, about 10 lines. Say summary, or listen later.");
  });
});

describe("labels and code", () => {
  it("uses the singular keys for one", () => {
    expect(labels.code(1)).toBe("code block, 1 line");
    expect(labels.answered("Claude", 1)).toBe("Claude answered, one line");
    expect(READING_LABEL_KEYS).toHaveLength(11);
  });

  it("packs code lines into chunks", () => {
    expect(codeChunks("a\n\nb\n", 10).map((chunk) => chunk.text)).toEqual(["a\nb"]);
    expect(codeChunks("x".repeat(5) + "\n" + "y".repeat(8), 10).map((chunk) => chunk.text)).toEqual(["xxxxx", "yyyyyyyy"]);
  });
});
