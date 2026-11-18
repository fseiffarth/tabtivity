import { beforeEach, describe, expect, it } from "vitest";
import { _resetPromptedForTest, findEmptyAgentTab, notePrompted } from "../../lib/agents/emptyAgentTab";
import { AGENT_ITEMS, buildStaticTabSpec } from "../../lib/tabs/newTabItems";
import type { TabEntry } from "../../stores/tabs";

const t = (key: string) => key;
const claude = AGENT_ITEMS.find((item) => item.cmd === "claude")!;
const codex = AGENT_ITEMS.find((item) => item.cmd === "codex")!;

/** A tab as the store holds it: the spec plus its key, scope and launch time. */
function opened(key: string, spec = buildStaticTabSpec(claude, "/p", "Proj", t), extra: Partial<TabEntry> = {}): TabEntry {
  return { ...spec, key, scope: "proj", launchedAt: 1, ...extra };
}

describe("findEmptyAgentTab", () => {
  beforeEach(() => _resetPromptedForTest());

  it("takes over an unprompted tab of the same launch, whatever session id it was minted", () => {
    const empty = opened("agent-1");
    const spec = buildStaticTabSpec(claude, "/p", "Proj", t);
    expect(empty.sessionId).not.toBe(spec.sessionId);
    expect(findEmptyAgentTab("proj", [empty], spec)).toBe(empty);
  });

  it("skips a tab that was asked something", () => {
    const asked = opened("agent-1");
    notePrompted("proj:agent-1");
    expect(findEmptyAgentTab("proj", [asked], buildStaticTabSpec(claude, "/p", "Proj", t))).toBeUndefined();
  });

  it("skips a tab restored from disk or resumed (no launchedAt)", () => {
    const restored = opened("agent-1", undefined, { launchedAt: undefined });
    expect(findEmptyAgentTab("proj", [restored], buildStaticTabSpec(claude, "/p", "Proj", t))).toBeUndefined();
  });

  it("skips another CLI, folder, machine or login", () => {
    const empty = opened("agent-1");
    expect(findEmptyAgentTab("proj", [empty], buildStaticTabSpec(codex, "/p", "Proj", t))).toBeUndefined();
    expect(findEmptyAgentTab("proj", [empty], buildStaticTabSpec(claude, "/p/wt", "Proj", t))).toBeUndefined();
    expect(findEmptyAgentTab("proj", [empty], { ...buildStaticTabSpec(claude, "/p", "Proj", t), location: "remote" })).toBeUndefined();
    expect(findEmptyAgentTab("proj", [empty], { ...buildStaticTabSpec(claude, "/p", "Proj", t), apiKey: true })).toBeUndefined();
    expect(findEmptyAgentTab("proj", [empty], buildStaticTabSpec(claude, "/p", "Proj", t))).toBe(empty);
  });

  it("never reuses for a shell, nor a shell as the empty one", () => {
    const shell = opened("shell-1", { label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" });
    const spec = { label: "Shell", cmd: "bash", cwd: "/p", kind: "shell" as const };
    expect(findEmptyAgentTab("proj", [shell], spec)).toBeUndefined();
    expect(findEmptyAgentTab("proj", [shell], buildStaticTabSpec(claude, "/p", "Proj", t))).toBeUndefined();
  });
});
