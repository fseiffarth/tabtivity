import { describe, expect, it } from "vitest";
import { answerHtml, promptHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { pendingPrompt, withPending } from "../../../mobile-web/src/terminal/pendingPrompts";
import { transcriptTurns } from "../../../mobile-web/src/terminal/transcriptTurns";
import { outboxPosts } from "../../../mobile-web/src/terminal/outboxPosts";
import type { OutboxFile } from "../../../mobile-web/src/api";
import { BRAND } from "../../lib/brand";

function dom(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host;
}

describe(`${BRAND.display} Mobile Focus formats an answer's Markdown`, () => {
  it("keeps the formatting: headings, lists, emphasis, code, tables", () => {
    const host = dom(answerHtml([
      "## Done",
      "",
      "- **bold** and *italic*",
      "- `npm test`",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n")));
    expect(host.querySelector("h2")?.textContent).toBe("Done");
    expect(host.querySelector("h2")?.id).toBe("");
    expect(host.querySelectorAll("li")).toHaveLength(2);
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector("em")?.textContent).toBe("italic");
    expect(host.querySelector("li code")?.textContent).toBe("npm test");
    expect(host.querySelector("pre code")?.textContent).toContain("const a = 1;");
    expect(host.querySelector("table td")?.textContent).toBe("1");
  });

  it("opens and loads nothing: links are their label, images their alt text", () => {
    const host = dom(answerHtml([
      "See [the docs](https://example.com/x) and https://example.com/y and [a file](src/a.ts).",
      "",
      "![diagram](data:image/png;base64,AAAA) ![remote](https://example.com/p.png) ![local](shot.png)",
      "",
      "- [x] shipped",
      "- [ ] tested",
    ].join("\n")));
    expect(host.querySelector("a, img, input")).toBeNull();
    expect(host.querySelector("[href], [src], [data-md-src], [data-md-remote]")).toBeNull();
    expect(host.textContent).toContain("See the docs and https://example.com/y and a file.");
    // A web link keeps its address for the chat's confirmation; a file does not.
    expect([...host.querySelectorAll<HTMLElement>(".md-link")].map((link) => link.dataset.href ?? null))
      .toEqual(["https://example.com/x", "https://example.com/y", null]);
    expect(host.textContent).toContain("diagram");
    expect(host.textContent).toContain("local");
    expect([...host.querySelectorAll(".md-task")].map((box) => box.classList.contains("md-task-done"))).toEqual([true, false]);
    expect([...host.querySelectorAll(".md-task")].map((box) => box.textContent)).toEqual(["", ""]);
  });

  it("shows an answer's own HTML as text", () => {
    const host = dom(answerHtml('<a href="https://evil.example">x</a> <img src=x onerror=alert(1)>'));
    expect(host.querySelector("a, img")).toBeNull();
    expect(host.textContent).toContain('<a href="https://evil.example">x</a>');
  });
});

describe(`${BRAND.display} Mobile Focus formats a prompt's Markdown`, () => {
  it("formats a subagent's brief like an answer", () => {
    const host = dom(promptHtml([
      "## Task",
      "",
      "Fix the **parser**:",
      "- read `lexer.ts`",
      "- add a test",
    ].join("\n")));
    expect(host.querySelector("h2")?.textContent).toBe("Task");
    expect(host.querySelector("strong")?.textContent).toBe("parser");
    expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["read lexer.ts", "add a test"]);
  });

  it("keeps a single line break as typed", () => {
    const host = dom(promptHtml("first line\nsecond line"));
    expect(host.querySelectorAll("p")).toHaveLength(1);
    expect(host.querySelector("p br")).not.toBeNull();
    expect(host.textContent).toBe("first linesecond line");
    // An answer still joins them, as Markdown does.
    expect(dom(answerHtml("first line\nsecond line")).querySelector("br")).toBeNull();
  });

  it("shows a prompt's own HTML as text", () => {
    const host = dom(promptHtml('<img src=x onerror=alert(1)>\n<a href="https://evil.example">x</a>'));
    expect(host.querySelector("a, img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe(`${BRAND.display} Mobile Focus holds a sent prompt in its place`, () => {
  const prompt = (text: string, at?: string) => ({ kind: "prompt" as const, text, at });
  const answer = (text: string, at?: string) => ({ kind: "answer" as const, text, at });
  const shape = (entries: { kind: string; text: string }[]) => entries.map((entry) => `${entry.kind}:${entry.text}`);

  it("sits after what the session held when sent, the answers to it below", () => {
    const before = [prompt("fix it", "2026-09-18T10:00:00Z"), answer("Done.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "also  the\ntests ", before);
    expect(shape(withPending(before, [sent]))).toEqual(["prompt:fix it", "answer:Done.", "prompt:also  the\ntests"]);
    // The agent answered before the record of the prompt arrived.
    const working = [...before, answer("On it.", "2026-09-18T10:02:00Z")];
    expect(shape(withPending(working, [sent]))).toEqual(["prompt:fix it", "answer:Done.", "prompt:also  the\ntests", "answer:On it."]);
  });

  it("keeps Codex answers without timestamps below the prompt sent before them", () => {
    const before = [prompt("first", "2026-09-18T10:00:00Z"), answer("First reply")];
    const sent = pendingPrompt(1, "follow up", before);
    const working = [...before, answer("Reply to follow up")];
    expect(shape(withPending(working, [sent]))).toEqual([
      "prompt:first", "answer:First reply", "prompt:follow up", "answer:Reply to follow up",
    ]);
  });

  it("puts the first prompt of an empty Codex session before its answer", () => {
    const sent = pendingPrompt(1, "start here", []);
    expect(shape(withPending([answer("Starting now")], [sent]))).toEqual([
      "prompt:start here", "answer:Starting now",
    ]);
  });

  it("anchors to the earlier of two identical unstamped answers", () => {
    const before = [prompt("first", "2026-09-18T10:00:00Z"), answer("Done.")];
    const sent = pendingPrompt(1, "follow up", before);
    expect(shape(withPending([...before, answer("Done.")], [sent]))).toEqual([
      "prompt:first", "answer:Done.", "prompt:follow up", "answer:Done.",
    ]);
  });

  it("keeps its place and words when its record arrives later in the file, whitespace aside", () => {
    const before = [prompt("fix it", "2026-09-18T10:00:00Z"), answer("Checking.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "also the tests", before);
    // Typed mid-turn: recorded only once taken in, after another message.
    const after = [...before, answer("Found it.", "2026-09-18T10:02:00Z"), prompt("also  the tests", "2026-09-18T10:01:30Z"), answer("Both fixed.", "2026-09-18T10:03:00Z")];
    expect(shape(withPending(after, [sent]))).toEqual(["prompt:fix it", "answer:Checking.", "prompt:also the tests", "answer:Found it.", "answer:Both fixed."]);
  });

  it("does not take an earlier copy of the same words for its record", () => {
    const before = [prompt("continue", "2026-09-18T10:00:00Z"), answer("More.", "2026-09-18T10:01:00Z")];
    const sent = pendingPrompt(1, "continue", before);
    expect(shape(withPending(before, [sent]))).toEqual(["prompt:continue", "answer:More.", "prompt:continue"]);
    const arrived = [...before, prompt("continue", "2026-09-18T10:03:00Z")];
    expect(shape(withPending(arrived, [sent]))).toEqual(["prompt:continue", "answer:More.", "prompt:continue"]);
    // The older copy left the window the phone reads: the newer stamp still
    // names the record.
    expect(shape(withPending([answer("More.", "2026-09-18T10:01:00Z"), prompt("continue", "2026-09-18T10:03:00Z")], [sent]))).toEqual(["answer:More.", "prompt:continue"]);
  });

  it("drops the not-delivered marker once the session recorded the prompt", () => {
    const before = [answer("Ready.", "2026-09-18T10:00:00Z")];
    const sent = { ...pendingPrompt(1, "also the tests", before), failed: true };
    expect(withPending(before, [sent])[1]).toMatchObject({ pending: 1, failed: true });
    // The link lost the ack, not the words: the record is the proof.
    const arrived = [...before, prompt("also the tests", "2026-09-18T10:00:30Z")];
    const shown = withPending(arrived, [sent]);
    expect(shape(shown)).toEqual(["answer:Ready.", "prompt:also the tests"]);
    expect(shown[1].failed).toBeUndefined();
  });

  it("keeps two prompts sent in a row in their order", () => {
    const before = [answer("Ready.", "2026-09-18T10:00:00Z")];
    const first = pendingPrompt(1, "one", before);
    const second = pendingPrompt(2, "two", before);
    expect(shape(withPending(before, [first, second]))).toEqual(["answer:Ready.", "prompt:one", "prompt:two"]);
  });

  it("waits below the agent's work while the desktop holds it, then stands where it was typed", () => {
    const before = [prompt("fix it", "2026-09-18T10:00:00Z"), answer("Checking.", "2026-09-18T10:01:00Z")];
    const sent = { ...pendingPrompt(1, "also the tests", before), held: "h1" };
    const queued = withPending(before, [sent]);
    expect(shape(queued)).toEqual(["prompt:fix it", "answer:Checking.", "prompt:also the tests"]);
    expect(queued[2]).toMatchObject({ pending: 1, held: true, queued: true });
    // The agent keeps talking: its answers go above the waiting prompt.
    const working = [...before, answer("Found it.", "2026-09-18T10:02:00Z")];
    expect(shape(withPending(working, [sent]))).toEqual(["prompt:fix it", "answer:Checking.", "answer:Found it.", "prompt:also the tests"]);
    // Typed at the idle point: the bubble is where its record is, no longer queued, same key.
    const typed = [...working, prompt("also  the tests", "2026-09-18T10:03:00Z"), answer("Both fixed.", "2026-09-18T10:04:00Z")];
    const shown = withPending(typed, [sent]);
    expect(shape(shown)).toEqual(["prompt:fix it", "answer:Checking.", "answer:Found it.", "prompt:also the tests", "answer:Both fixed."]);
    expect(shown[3].queued).toBeUndefined();
    expect(shown[3].held).toBeUndefined();
    expect(transcriptTurns(shown)[3].key).toBe(transcriptTurns(withPending(working, [sent]))[3].key);
  });

  it("counts a held prompt as waiting before the desktop named it", () => {
    const before = [answer("Working.", "2026-09-18T10:00:00Z")];
    const sent = { ...pendingPrompt(1, "next", before), held: "" };
    const shown = withPending([...before, answer("More.", "2026-09-18T10:01:00Z")], [sent]);
    expect(shown[shown.length - 1]).toMatchObject({ text: "next", queued: true });
  });

  it("puts none of the agent's files below a waiting prompt", () => {
    const before = [answer("Working.", "2026-09-18T10:00:00Z")];
    const sent = { ...pendingPrompt(1, "next", before), held: "h1" };
    const entries = withPending([...before, answer("Plot sent.", "2026-09-18T10:02:00Z")], [sent]);
    const file: OutboxFile = { name: "plot.png", kind: "image", size: 1, modified: Date.parse("2026-09-18T10:03:00Z") / 1000 };
    expect([...outboxPosts(entries, [file]).keys()]).toEqual([1]);
  });
});
