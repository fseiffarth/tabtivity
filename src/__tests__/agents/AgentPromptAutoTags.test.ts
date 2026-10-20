import { describe, expect, it } from "vitest";
import { agentPromptAutoTags } from "../../lib/agents/prompt/autoTags";

describe("agentPromptAutoTags", () => {
  it("derives agent, preface, blame, result, state and language tags", () => {
    expect(agentPromptAutoTags({
      message: "```ts\nconst x = 1\n```",
      agent: "Codex",
      preface: ["/clear", "/model gpt-5"],
      files: ["src/lib/x.ts", "README.md"],
      result: "failed",
      recurring: true,
      queued: true,
      chained: true,
    })).toEqual([
      "agent:codex", "model:gpt-5", "cmd:clear", "file:x.ts", "dir:src",
      "file:readme.md", "result:failed", "recurring", "queued", "chained", "lang:ts",
    ]);
  });

  it("wears the given model only when the preface names none", () => {
    expect(agentPromptAutoTags({ message: "x", model: "opus-4-1" })).toEqual(["model:opus-4-1"]);
    expect(agentPromptAutoTags({ message: "x", model: "opus-4-1", preface: ["/model haiku"] })).toEqual(["model:haiku"]);
  });

  it("names the phone a prompt came from as one token, and an unpaired one as a phone", () => {
    expect(agentPromptAutoTags({ message: "x", phone: "Pixel 9 Pro" })).toEqual(["device:pixel-9-pro"]);
    expect(agentPromptAutoTags({ message: "x", phone: "" })).toEqual(["device:phone"]);
    expect(agentPromptAutoTags({ message: "x" })).toEqual([]);
  });

  it("marks a message longer than 2 KiB", () => {
    expect(agentPromptAutoTags({ message: "é".repeat(1_025) })).toContain("long");
  });
});
