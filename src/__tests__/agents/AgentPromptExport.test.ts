import { describe, expect, it } from "vitest";
import type { TranscriptEntry } from "../../../mobile-web/src/api";
import {
  exportFileName,
  promptsMarkdown,
  sessionHtml,
  sessionMarkdown,
  trailPrompts,
  transcriptPrompts,
  type ExportWords,
} from "../../lib/agents/prompt/export";

const words: ExportWords = {
  title: "Session — Claude",
  you: "You",
  agent: "Agent",
  plan: "Plan",
  subagent: "Subagent",
  interrupted: "Interrupted",
  cut: "(cut)",
  earlier: "Earlier turns left out.",
};

const entries: TranscriptEntry[] = [
  { kind: "prompt", text: "fix the build\nplease", at: "2026-11-19T08:00:00Z" },
  { kind: "answer", text: "On it.\n\n```sh\nnpm run build\n```\n" },
  { kind: "agent", text: "find the failing test", role: "Explore" },
  { kind: "answer", text: "1. do it", plan: true },
  { kind: "interrupted", text: "[Request interrupted by user]" },
  { kind: "prompt", text: "/model", setting: "Fable 5.2" },
  { kind: "answer", text: "a long one", cut: true },
  { kind: "answer", text: "Which one?", blocking: true },
];

describe("the Prompts panel's Markdown export", () => {
  it("writes the whole session in order, a code block and line breaks kept", () => {
    const md = sessionMarkdown(entries, { words, use24h: true });
    expect(md.startsWith("# Session — Claude\n\n## You · ")).toBe(true);
    expect(md).toContain("fix the build\nplease");
    expect(md).toContain("## Agent\n\nOn it.\n\n```sh\nnpm run build\n```");
    expect(md).toContain("## Subagent (Explore)\n\nfind the failing test");
    expect(md).toContain("## Plan\n\n1. do it");
    expect(md).toContain("*Interrupted — [Request interrupted by user]*");
    expect(md).toContain("/model → Fable 5.2");
    expect(md).toContain("a long one\n\n*(cut)*");
    // A question still on the agent's own screen is not the conversation yet.
    expect(md).not.toContain("Which one?");
    expect(md.indexOf("fix the build")).toBeLessThan(md.indexOf("On it."));
    expect(md.endsWith("\n")).toBe(true);
  });

  it("says when earlier turns were not read", () => {
    expect(sessionMarkdown([], { words, use24h: true, truncated: true })).toBe("# Session — Claude\n\n*Earlier turns left out.*\n");
  });

  it("writes only the prompts, numbered, from the transcript or the panel's list", () => {
    const fromTranscript = promptsMarkdown(transcriptPrompts(entries), { words, use24h: true });
    expect(fromTranscript).toContain("## 1 · ");
    expect(fromTranscript).toContain("fix the build\nplease");
    expect(fromTranscript).toContain("## 2\n\n/model → Fable 5.2");
    expect(fromTranscript).not.toContain("On it.");
    expect(fromTranscript).not.toContain("find the failing test");
    const fromTrail = promptsMarkdown(trailPrompts([{ text: "typed one", at: Date.UTC(2026, 10, 19, 9), source: "typed" }]), { words, use24h: true });
    expect(fromTrail).toMatch(/## 1 · .+\n\ntyped one\n$/);
  });

  it("names the file after the tab, safe on every OS", () => {
    expect(exportFileName("Fix: build/CI?", "session")).toBe("Fix build CI-session.md");
    expect(exportFileName("  trailing dots... ", "prompts")).toBe("trailing dots-prompts.md");
    expect(exportFileName("tab\u0007bell", "prompts")).toBe("tab bell-prompts.md");
    expect(exportFileName(undefined, "session")).toBe("agent-session.md");
    expect(exportFileName("???", "session")).toBe("agent-session.md");
  });

  it("draws the session as a chat page: bubbles, rules, day chips, nothing that runs", () => {
    const html = sessionHtml(
      [
        ...entries,
        { kind: "answer", text: "<script>alert(1)</script> and <img src=x onerror=alert(1)> [x](javascript:alert(1))", at: "2026-11-20T09:30:00Z" },
      ],
      { words: { ...words, title: "Session — <b>tab</b>" }, use24h: true, truncated: true },
    );
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'");
    expect(html).toContain("<title>Session — &lt;b&gt;tab&lt;/b&gt;</title>");
    expect(html).toContain('class="note">Earlier turns left out.');
    expect(html).toMatch(/<div class="turn user"><div class="markdown-body">.*fix the build/s);
    expect(html).toMatch(/<div class="turn agent"><div class="markdown-body">.*<pre/s);
    expect(html).toContain('<div class="turn agent plan"><span class="plan-head">Plan</span>');
    expect(html).toContain("<b>Subagent (Explore)</b> · find the failing test");
    expect(html).toContain('class="rule interrupted"><span>Interrupted</span>');
    // A slash command is a rule with what it left set, not a bubble.
    expect(html).toContain('<div class="rule"><span><b>/model</b> → Fable 5.2</span></div>');
    expect(html).toContain('<span class="cut">(cut)</span>');
    expect(html).not.toContain("Which one?");
    // Two days, two chips; each timed bubble carries its clock.
    expect(html.match(/class="day"/g)).toHaveLength(2);
    expect(html).toMatch(/<time class="time">\d\d:\d\d<\/time>/);
    // The agent's own markup is text, and no link points anywhere.
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script|<img|\shref=|<a\s/i);
  });

  it("names the chat page .html", () => {
    expect(exportFileName("Claude", "chat")).toBe("Claude-chat.html");
  });
});
