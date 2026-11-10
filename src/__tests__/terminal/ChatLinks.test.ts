import { describe, expect, it } from "vitest";
import { chatLinksOf, MAX_CHAT_LINKS, type LinkTurn } from "../../../mobile-web/src/terminal/chatLinks";

const prompt = (text: string, stamp?: string): LinkTurn => ({ kind: "prompt", text, command: null, ...(stamp ? { stamp } : {}) });
const answer = (text: string, stamp?: string): LinkTurn => ({ kind: "answer", text, ...(stamp ? { stamp } : {}) });
const urls = (turns: readonly LinkTurn[]) => chatLinksOf(turns).map((link) => link.url);

describe("chatLinksOf: the links the Chat makes clickable", () => {
  it("reads a bare URL, a www. autolink and a Markdown link", () => {
    expect(urls([answer("See https://github.com/o/r/pull/7, www.example.org/docs and [the run](https://github.com/o/r/actions/runs/9).")])).toEqual([
      "https://github.com/o/r/pull/7",
      "https://www.example.org/docs",
      "https://github.com/o/r/actions/runs/9",
    ]);
  });

  it("splits the address into host and rest, dropping www.", () => {
    const [link] = chatLinksOf([answer("[x](https://www.example.com/a/b?q=1#frag)")]);
    expect(link.host).toBe("example.com");
    expect(link.rest).toBe("/a/b?q=1");
  });

  it("keeps the port in the host and has no rest for a bare host", () => {
    const [link] = chatLinksOf([answer("[dev](http://localhost:3000/)")]);
    expect(link.host).toBe("localhost:3000");
    expect(link.rest).toBe("");
  });

  it("keeps the label when it differs from the address, with the target winning", () => {
    const [link] = chatLinksOf([answer("[https://bank.example](https://evil.example/x)")]);
    expect(link.url).toBe("https://evil.example/x");
    expect(link.host).toBe("evil.example");
    // A label that is itself an address is no label.
    expect(link.label).toBeUndefined();
    const [named] = chatLinksOf([answer("[the artifact](https://claude.ai/artifact/abc)")]);
    expect(named.label).toBe("the artifact");
    expect(named.host).toBe("claude.ai");
  });

  it("finds no link inside code", () => {
    expect(urls([answer("```\nhttps://example.com/in-block\n```\nand `https://example.com/inline`")])).toEqual([]);
  });

  it("refuses javascript:, file:, user:password and relative targets", () => {
    expect(urls([answer("[a](javascript:alert(1)) [b](file:///etc/passwd) [c](https://user:pw@example.com/) [d](/relative/path) [e](mailto:x@y.z)")])).toEqual([]);
  });

  it("lists a punycode host as the Chat's confirmation would name it", () => {
    const [link] = chatLinksOf([answer("[x](https://bücher.example/a)")]);
    expect(link.host).toBe("xn--bcher-kva.example");
  });

  it("dedupes by page, ignoring the fragment, first sighting winning", () => {
    const links = chatLinksOf([answer("[a](https://example.com/p#one)"), answer("[b](https://example.com/p#two) and [c](https://example.com/q)")]);
    // Newest message first: the later answer's #two is seen before the earlier #one.
    expect(links.map((link) => link.url)).toEqual(["https://example.com/p#two", "https://example.com/q"]);
  });

  it("orders newest message first and first mention first within a message", () => {
    expect(urls([
      answer("[old](https://old.example/)"),
      answer("[a](https://a.example/) then [b](https://b.example/)"),
    ])).toEqual(["https://a.example/", "https://b.example/", "https://old.example/"]);
  });

  it("marks who wrote it and carries the message's stamp", () => {
    const links = chatLinksOf([
      prompt("look at https://you.example/page", "2026-11-10T08:00:00Z"),
      answer("and [this](https://agent.example/page)", "2026-11-10T08:00:05Z"),
    ]);
    expect(links.map((link) => [link.host, link.from, link.at])).toEqual([
      ["agent.example", "agent", "2026-11-10T08:00:05Z"],
      ["you.example", "you", "2026-11-10T08:00:00Z"],
    ]);
  });

  it("skips what the Chat draws without clickable links", () => {
    expect(urls([
      { kind: "agent", text: "https://subagent.example/a", subagent: "x" } as LinkTurn,
      { kind: "interrupted", text: "https://interrupted.example/" },
      { kind: "prompt", text: "/goal https://command.example/", command: { name: "/goal", args: "https://command.example/" } },
      { kind: "answer", text: "https://asked.example/", questions: [{ question: "q" }] },
    ])).toEqual([]);
  });

  it("caps the list at the newest 100", () => {
    const turns = Array.from({ length: 150 }, (_, i) => answer(`[n](https://example.com/${i})`));
    const links = chatLinksOf(turns);
    expect(links).toHaveLength(MAX_CHAT_LINKS);
    expect(links[0].url).toBe("https://example.com/149");
    expect(links[MAX_CHAT_LINKS - 1].url).toBe("https://example.com/50");
    expect(chatLinksOf(turns, 3)).toHaveLength(3);
  });

  it("returns equal rows on a repeat (the per-text memo)", () => {
    const turns = [answer("[a](https://example.com/a) www.example.org/b", "2026-11-10T08:00:00Z")];
    expect(chatLinksOf(turns)).toEqual(chatLinksOf(turns));
  });
});
