/**
 * Custom agents (Settings.custom_agents): a user-defined CLI offered in the
 * add-tab menu's Agents group. These tests lock in the two pure helpers that
 * make a custom agent behave like a built-in one — `buildStaticTabSpec` (the
 * launch-spec builder, including the resume-flag → restart-resumable promotion)
 * and `agentMenuEntries` (the shared Agents-group row builder).
 */
import { describe, it, expect } from "vitest";

import {
  AGENT_ITEMS,
  agentMenuEntries,
  buildStaticTabSpec,
  customAgentToItem,
  enabledInstalledAgentBins,
  rootAllowedAgentBins,
  installedAgentBins,
} from "../../components/tabs/newTabItems";
import { isResumableAgentTab } from "../../stores/tabs";
import { translate, type TranslationKey } from "../../lib/i18n";
import type { CustomAgent } from "../../types";
import { envName } from "../../lib/brand";

const t = (key: TranslationKey) => translate("en", key);

describe("buildStaticTabSpec — custom agents", () => {
  it("launches a bare custom agent as a launch-only agent tab", () => {
    const ca: CustomAgent = { id: "1", label: "Mine", cmd: "my-agent" };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj", t);
    expect(spec.kind).toBe("agent");
    expect(spec.cmd).toBe("my-agent");
    expect(spec.args).toEqual([]);
    // No resume flag → not restart-resumable → no minted session id / tab uid.
    expect(spec.resumeArgs).toBeUndefined();
    expect(spec.sessionId).toBeUndefined();
    expect(spec.env?.[envName("TAB_UID")]).toBeUndefined();
    expect(isResumableAgentTab({ ...spec })).toBe(false);
  });

  it("prepends the custom agent's own args", () => {
    const ca: CustomAgent = {
      id: "1",
      label: "Mine",
      cmd: "my-agent",
      args: ["--model", "x"],
    };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj", t);
    expect(spec.args).toEqual(["--model", "x"]);
  });

  it("promotes a custom agent with a resume flag to restart-resumable", () => {
    const ca: CustomAgent = {
      id: "1",
      label: "Mine",
      cmd: "my-agent",
      resumeArgs: ["--continue"],
    };
    const spec = buildStaticTabSpec(customAgentToItem(ca), "/proj", "Proj", t);
    expect(spec.resumeArgs).toEqual(["--continue"]);
    // A session id is minted so the tab satisfies the persistence gate, and the
    // tab is tagged with the TABTIVITY_TAB_UID env var like the built-in resumables.
    expect(typeof spec.sessionId).toBe("string");
    expect(spec.env?.[envName("TAB_UID")]).toBe(spec.sessionId);
    expect(isResumableAgentTab({ ...spec })).toBe(true);
  });
});

describe("agentMenuEntries", () => {
  const custom: CustomAgent[] = [
    { id: "a", label: "Present", cmd: "here" },
    { id: "b", label: "Absent", cmd: "gone" },
  ];

  it("lists installed built-ins, then custom agents, then the add row", () => {
    const entries = agentMenuEntries({
      installedBuiltins: new Set(["claude"]),
      installedCmds: new Set(["here"]),
      customAgents: custom,
      pick: () => {},
      onAddCustom: () => {},
      t,
    });
    const labels = entries.map((e) => e.label);
    expect(labels).toEqual(["Claude", "Present", "Absent (not found)", "Add agent…"]);
    // The known-missing custom agent is greyed out; the present one is pickable.
    const present = entries.find((e) => e.key === "custom:a");
    const absent = entries.find((e) => e.key === "custom:b");
    expect(present?.disabled).toBeFalsy();
    expect(absent?.disabled).toBe(true);
  });

  it("hides built-ins until their probe resolves, but the add row is always present", () => {
    const entries = agentMenuEntries({
      installedBuiltins: null,
      installedCmds: null,
      customAgents: [],
      pick: () => {},
      onAddCustom: () => {},
      t,
    });
    expect(entries.map((e) => e.key)).toEqual(["__add_custom_agent__"]);
  });
});

describe("Google Antigravity built-in", () => {
  it("matches the backend's executable name, not its registry id", () => {
    const installed = installedAgentBins([{ bin: "agy", installed: true }]);
    const entries = agentMenuEntries({
      installedBuiltins: installed,
      installedCmds: new Set(),
      customAgents: [],
      pick: () => {},
      onAddCustom: () => {},
      t,
    });
    expect(entries.map((entry) => entry.label)).toEqual(["Google Antigravity", "Add agent…"]);
  });

  it("honors registry-id disables for agents whose command has another name", () => {
    expect([...enabledInstalledAgentBins([
      { id: "antigravity", bin: "agy", installed: true },
      { id: "swe-agent", bin: "sweagent", installed: true },
    ], ["antigravity", "swe-agent"])]).toEqual([]);
  });

  it("launches agy and restores with its documented continue flag", () => {
    const item = AGENT_ITEMS.find((candidate) => candidate.cmd === "agy");
    expect(item?.label).toBe("Google Antigravity");
    const spec = buildStaticTabSpec(item!, "/proj", "Proj", t);
    expect(spec.kind).toBe("agent");
    expect(spec.sessionId).toBeTruthy();
    expect(isResumableAgentTab(spec)).toBe(true);
  });
});

describe("rootAllowedAgentBins", () => {
  const agents = [
    { id: "claude", bin: "claude", installed: true },
    { id: "antigravity", bin: "agy", installed: true },
    { id: "codex", bin: "codex", installed: true },
  ];
  const enabled = new Set(["claude", "agy", "codex"]);

  it("offers no agent in the root console until one is switched on", () => {
    expect([...rootAllowedAgentBins(enabled, agents, undefined)]).toEqual([]);
    expect([...rootAllowedAgentBins(enabled, agents, [])]).toEqual([]);
  });

  it("maps registry ids to executable names and never re-adds a disabled agent", () => {
    expect([...rootAllowedAgentBins(enabled, agents, ["antigravity", "codex"])]).toEqual([
      "agy",
      "codex",
    ]);
    expect([...rootAllowedAgentBins(new Set(["claude"]), agents, ["codex"])]).toEqual([]);
  });
});

describe("expanded built-in agents", () => {
  it("offers each newly managed agent under its executable name", () => {
    const cmds = new Set(AGENT_ITEMS.map((item) => item.cmd));
    expect([
      "kiro-cli", "cline", "goose", "pi", "plandex", "sweagent",
      "mini", "crush", "amp", "kimi", "qoder", "muse",
      "droid", "auggie", "kilo", "cn", "junie", "codebuddy",
    ].every((cmd) => cmds.has(cmd))).toBe(true);
  });
});
