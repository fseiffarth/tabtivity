/**
 * Locks how a tab is classified for the usage recap.
 *
 * "By model" is the whole point of the agent stats, and a local model is not a
 * field on the tab — it is carried in the env Tabtivity spawns it with. The trap is
 * that a local model driven through `vibe` still has `cmd: "vibe"`, so a
 * cmd-only classification would file every local model under "Mistral".
 */
import { describe, expect, it } from "vitest";
import { METRIC, agentLabel, agentMetricLeaf, agentPromptLeaf, sub } from "../../lib/usageMetrics";
import { BRAND, envName, tabCommand } from "../../lib/brand";

describe("agentMetricLeaf", () => {
  it("files a cloud agent under its command", () => {
    expect(agentMetricLeaf({ kind: "agent", cmd: "claude" })).toEqual({
      prefix: METRIC.AGENT_TAB,
      leaf: "claude",
    });
    expect(agentMetricLeaf({ kind: "agent", cmd: "codex" })).toEqual({
      prefix: METRIC.AGENT_TAB,
      leaf: "codex",
    });
  });

  it("files a local agent under its MODEL, not its driving command", () => {
    // The `vibe` route: cmd is "vibe" for every local model, so the model has to
    // come from the env or they would all collapse into one bucket.
    expect(
      agentMetricLeaf({
        kind: "local_agent",
        cmd: "vibe",
        env: { [envName("LOCAL_MODEL")]: "qwen3:8b", VIBE_ACTIVE_MODEL: `${BRAND.slug}-qwen3` },
      }),
    ).toEqual({ prefix: METRIC.AGENT_TAB_LOCAL, leaf: "qwen3:8b" });
  });

  it("prefers the model the user picked over the resolved vibe alias", () => {
    const id = agentMetricLeaf({
      kind: "local_agent",
      cmd: "vibe",
      env: { [envName("LOCAL_MODEL")]: "llama3.1:8b", VIBE_ACTIVE_MODEL: `${BRAND.slug}-alias` },
    });
    expect(id?.leaf).toBe("llama3.1:8b");
  });

  it("falls back to the vibe alias when only that is present", () => {
    // Tabs restored from a layout written by an older Tabtivity have no
    // TABTIVITY_LOCAL_MODEL; naming them by the alias beats losing them.
    expect(
      agentMetricLeaf({
        kind: "local_agent",
        cmd: "vibe",
        env: { VIBE_ACTIVE_MODEL: `${BRAND.slug}-qwen3` },
      }),
    ).toEqual({ prefix: METRIC.AGENT_TAB_LOCAL, leaf: `${BRAND.slug}-qwen3` });
  });

  it("falls back to the command for a local agent with no model recorded", () => {
    // Rather than filing it under an empty key.
    expect(agentMetricLeaf({ kind: "local_agent", cmd: "vibe", env: {} })).toEqual({
      prefix: METRIC.AGENT_TAB,
      leaf: "vibe",
    });
  });

  it("classifies non-agent tabs as nothing", () => {
    expect(agentMetricLeaf({ kind: "shell", cmd: "bash" })).toBeNull();
    expect(agentMetricLeaf({ kind: "files", cmd: tabCommand("files") })).toBeNull();
    expect(agentMetricLeaf({ kind: "network", cmd: tabCommand("network") })).toBeNull();
  });
});

describe("agentPromptLeaf", () => {
  it("namespaces a local model so it cannot collide with a cloud agent", () => {
    // Both prompts and "tabs used" key off this leaf; without the prefix a local
    // model named like an agent would merge with it.
    expect(
      agentPromptLeaf({ kind: "local_agent", cmd: "vibe", env: { [envName("LOCAL_MODEL")]: "qwen3:8b" } }),
    ).toBe("local.qwen3:8b");
    expect(agentPromptLeaf({ kind: "agent", cmd: "claude" })).toBe("claude");
  });

  it("is null for a shell tab, so shell input is counted as a command not a prompt", () => {
    expect(agentPromptLeaf({ kind: "shell", cmd: "bash" })).toBeNull();
  });
});

describe("agentLabel", () => {
  it("gives known agents their product names", () => {
    expect(agentLabel("claude")).toBe("Claude");
    expect(agentLabel("cursor-agent")).toBe("Cursor");
    expect(agentLabel("agy")).toBe("Google Antigravity");
    expect(agentLabel("gemini")).toBe("Google Gemini");
  });

  it("shows a local model by its bare name", () => {
    expect(agentLabel("local.qwen3:8b")).toBe("qwen3:8b");
  });

  it("renders an unknown agent as-is rather than dropping it", () => {
    // The key space is open — a new agent must still show up in the recap.
    expect(agentLabel("some-new-agent")).toBe("some-new-agent");
  });
});

describe("sub", () => {
  it("composes dotted metric keys", () => {
    expect(sub(METRIC.AGENT_PROMPT, "claude")).toBe("agent.prompt.claude");
    expect(sub(METRIC.AGENT_ACTIVE, "local.qwen3:8b")).toBe("agent.active.local.qwen3:8b");
  });
});
