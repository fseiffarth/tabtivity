import { describe, expect, it } from "vitest";
import { agentItemFor, newAgentTabForDraft, promptChartNewTabAgent } from "../../lib/agents/prompt/newTab";

const t = (key: string) => key;

describe("promptChartNewTabAgent", () => {
  it("prefers the chart's own pick, then the 🧠 menu's default, then claude", () => {
    expect(promptChartNewTabAgent(null)).toBe("claude");
    expect(promptChartNewTabAgent({ default_agent_cmd: "codex" })).toBe("codex");
    expect(promptChartNewTabAgent({ default_agent_cmd: "codex", prompt_chart_agent: "gemini" })).toBe("gemini");
    expect(promptChartNewTabAgent({ default_agent_cmd: "codex", prompt_chart_agent: "  " })).toBe("codex");
  });

  it("launches a default agent's registry id as its binary", () => {
    expect(promptChartNewTabAgent({ default_agent_cmd: "antigravity" })).toBe("agy");
    expect(agentItemFor(promptChartNewTabAgent({ default_agent_cmd: "antigravity" })).label).toBe("Google Antigravity");
    // The chart's own pick is already a binary and stays one.
    expect(promptChartNewTabAgent({ default_agent_cmd: "antigravity", prompt_chart_agent: "agy" })).toBe("agy");
  });
});

describe("agentItemFor", () => {
  it("resolves a built-in, a custom agent, or the bare command", () => {
    expect(agentItemFor("claude").label).toBe("Claude");
    const custom = { id: "c1", label: "My agent", cmd: "myagent", args: ["--x"] };
    expect(agentItemFor("myagent", [custom])).toMatchObject({ label: "My agent", cmd: "myagent", args: ["--x"], kind: "agent" });
    expect(agentItemFor("unknown-cli")).toEqual({ label: "unknown-cli", cmd: "unknown-cli", kind: "agent" });
  });
});

describe("newAgentTabForDraft", () => {
  it("builds the + menu's tab spec with a schedule target, and the model as a /model preface", () => {
    const { tab, preface } = newAgentTabForDraft({ agent: "claude", model: "opus", cwd: "/p", projectName: "Proj", t });
    expect(tab).toMatchObject({ label: "Claude", cmd: "claude", kind: "agent", cwd: "/p", initialInput: "/rename Proj" });
    expect(tab.scheduleTargetId).toMatch(/[0-9a-f-]{36}/);
    expect(tab.sessionId).toBeTruthy();
    expect(tab.args).toEqual(["--session-id", tab.sessionId]);
    expect(preface).toEqual(["/model opus"]);
  });

  it("types no model command when none is picked", () => {
    expect(newAgentTabForDraft({ agent: "codex", model: "", cwd: "/p", projectName: "", t }).preface).toEqual([]);
    expect(newAgentTabForDraft({ agent: "codex", cwd: "/p", projectName: "", t }).preface).toEqual([]);
  });
});
