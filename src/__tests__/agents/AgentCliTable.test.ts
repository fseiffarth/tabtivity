/**
 * One source for the built-in agent CLIs (screen 2026-10-15, M7): the
 * generated `lib/agents/agentCliTable.ts` (from `commands/agents.rs`) feeds
 * the tab kind, the resume args and the + menu. The kind used to come from a
 * hand-kept 13-entry set while the menu listed 30, so a Goose, Amp or Kiro
 * tab came back from a restart as a plain shell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { AGENT_BINS, AGENT_CLI_ROWS, RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { SESSION_ID_ARG } from "../../lib/agents/agentCliTable";
import { cmdToKind, useTabsStore } from "../../stores/tabs";
import { AGENT_ITEMS } from "../../components/tabs/newTabItems";
import { agentLabel } from "../../lib/usageMetrics";

describe("the generated agent CLI table", () => {
  it("makes every registry CLI an agent tab, not a shell", () => {
    expect(AGENT_CLI_ROWS.length).toBeGreaterThanOrEqual(30);
    for (const row of AGENT_CLI_ROWS) {
      expect(cmdToKind(row.bin), row.bin).toBe("agent");
    }
    // The ones the old hand-kept set missed.
    for (const bin of ["kiro-cli", "cline", "goose", "amp", "cn", "muse"]) {
      expect(AGENT_BINS.has(bin), bin).toBe(true);
    }
    expect(cmdToKind("bash")).toBe("shell");
    expect(cmdToKind("")).toBe("shell");
  });

  it("never brings a kind-less saved agent tab back as a shell", () => {
    useTabsStore.getState().loadFromLayout(
      [
        // A CLI the old hand-kept set missed: it used to load as a "shell"
        // tab running the agent (and so was saved and relaunched as one).
        { key: "g1", label: "Goose", cmd: "goose", cwd: "/x", sessionId: "s1" },
        { key: "k1", label: "Kiro", cmd: "kiro-cli", cwd: "/x" },
        // Resumable: back on its registry resume args.
        { key: "d1", label: "Droid", cmd: "droid", cwd: "/x", sessionId: "s2" },
        { key: "s1", label: "Shell", cmd: "", cwd: "/x" },
      ],
      "/proj",
      "p",
    );
    const tabs = useTabsStore.getState().tabs;
    expect(tabs.map((t) => [t.cmd, t.kind])).toEqual([
      ["goose", "agent"],
      ["kiro-cli", "agent"],
      ["droid", "agent"],
      ["", "shell"],
    ]);
    expect(tabs[2].args).toEqual(["--resume"]);
    expect(tabs[0].args).toEqual([]);
  });

  it("is the + menu's list, in its order, with the launch extras kept", () => {
    expect(AGENT_ITEMS.map((i) => i.cmd)).toEqual(AGENT_CLI_ROWS.map((r) => r.bin));
    expect(AGENT_ITEMS.map((i) => i.label)).toEqual(AGENT_CLI_ROWS.map((r) => r.label));
    expect(AGENT_ITEMS.slice(0, 5).map((i) => i.cmd)).toEqual(["claude", "codex", "agy", "gemini", "vibe"]);
    const claude = AGENT_ITEMS.find((i) => i.cmd === "claude")!;
    expect(claude.sessionIdArgs?.("u")).toEqual(["--session-id", "u"]);
    expect(claude.sessionRename?.("proj")).toBe("/rename proj");
    expect(AGENT_ITEMS.find((i) => i.cmd === "gemini")!.sessionIdArgs?.("u")).toEqual(["--session-id", "u"]);
    expect(AGENT_ITEMS.find((i) => i.cmd === "codex")!.sessionIdArgs).toBeUndefined();
  });

  it("derives the resume args, with the session id filled in", () => {
    expect(RESUMABLE_AGENTS.claude("abc")).toEqual(["--resume", "abc"]);
    expect(RESUMABLE_AGENTS.codex("abc")).toEqual([]);
    expect(RESUMABLE_AGENTS.gemini("abc")).toEqual(["--resume", "latest"]);
    expect(RESUMABLE_AGENTS.droid("abc")).toEqual(["--resume"]);
    expect(RESUMABLE_AGENTS.qwen("abc")).toEqual(["--continue"]);
    expect("aider" in RESUMABLE_AGENTS).toBe(false);
    expect("toString" in RESUMABLE_AGENTS).toBe(false);
    expect(Object.keys(RESUMABLE_AGENTS).sort()).toEqual(
      AGENT_CLI_ROWS.filter((r) => r.resume).map((r) => r.bin).sort(),
    );
    // The placeholder never reaches a launch line.
    for (const [bin, args] of Object.entries(RESUMABLE_AGENTS)) {
      expect(args("id").includes(SESSION_ID_ARG), bin).toBe(false);
    }
  });

  it("labels usage counters by the registry, keeping retired leaves", () => {
    expect(agentLabel("goose")).toBe("Goose");
    expect(agentLabel("kiro-cli")).toBe("Kiro");
    expect(agentLabel("kiro")).toBe("Kiro");
    expect(agentLabel("mentat")).toBe("Mentat");
  });
});

beforeEach(() => {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});
