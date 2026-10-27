/**
 * The "+" menu's API section (`components/tabs/apiKeyGroup`): "<agent> (API)"
 * rows open a tab on the stored key, the Agents group's plain rows stay on the
 * CLI's own login, and the pick rides the tab record into the spawn.
 */
import { describe, expect, it } from "vitest";
import { apiKeyMenuGroups } from "../../components/tabs/apiKeyGroup";
import { AGENT_ITEMS, buildStaticTabSpec, type StaticMenuItem } from "../../lib/tabs/newTabItems";
import { agentMenuEntries } from "../../components/tabs/agentMenuEntries";
import { tabTerminalSpawn, terminalSpawnKey } from "../../lib/terminal/terminalSpawn";
import { toSavedTabEntry } from "../../stores/tabs";

const t = (key: string, vars?: Record<string, string>) =>
  vars ? `${key}(${Object.values(vars).join(",")})` : key;

const groups = (opts: Partial<Parameters<typeof apiKeyMenuGroups>[0]> = {}) => {
  const picked: StaticMenuItem[] = [];
  const result = apiKeyMenuGroups({
    keyable: [{ bin: "claude", budgetReached: false }],
    installedBuiltins: new Set(["claude", "codex"]),
    remoteScope: false,
    pick: (item) => picked.push(item),
    t,
    ...opts,
  });
  return { result, picked };
};

describe("the + menu's API section", () => {
  it("lists only installed agents a saved key can run, and none at all without one", () => {
    expect(groups({ keyable: [] }).result).toEqual([]);
    // Gemini has a key but is not installed; Codex is installed but has none.
    const { result } = groups({ keyable: [{ bin: "claude", budgetReached: false }, { bin: "gemini", budgetReached: false }] });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe("newTabMenu.groupApiKey");
    expect(result[0].entries.map((e) => e.key)).toEqual(["api:claude"]);
    expect(result[0].entries[0].label).toBe("newTabMenu.apiKeyEntry(Claude)");
  });

  it("opens a tab on the key, labelled as one", () => {
    const { result, picked } = groups();
    result[0].entries[0].onPick();
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ cmd: "claude", apiKey: true, label: "newTabMenu.apiKeyEntry(Claude)" });
    const spec = buildStaticTabSpec(picked[0], "/p", "p", t);
    expect(spec).toMatchObject({ cmd: "claude", apiKey: true, label: "newTabMenu.apiKeyEntry(Claude)" });
  });

  it("greys a row whose budget is spent and cautions in a remote project", () => {
    const blocked = groups({ keyable: [{ bin: "claude", budgetReached: true }] }).result[0].entries[0];
    expect(blocked.disabled).toBe(true);
    expect(blocked.label).toContain("newTabMenu.apiKeyEntryBudgetReached");
    expect(groups().result[0].entries[0].caution).toBeUndefined();
    expect(groups({ remoteScope: true }).result[0].entries[0].caution).toBe("newTabMenu.apiKeyRemoteCaution");
  });
});

describe("the Agents group's plain rows", () => {
  it("stay on the CLI's own login whatever the switch says", () => {
    const picked: StaticMenuItem[] = [];
    const entries = agentMenuEntries({
      installedBuiltins: new Set(["claude"]),
      installedCmds: new Set(["my-claude"]),
      customAgents: [{ id: "c1", label: "Mine", cmd: "my-claude" }],
      pick: (item) => picked.push(item),
      onAddCustom: () => {},
      t,
    });
    entries.find((e) => e.key === "claude")!.onPick();
    entries.find((e) => e.key === "custom:c1")!.onPick();
    expect(picked.map((item) => item.apiKey)).toEqual([false, false]);
    expect(buildStaticTabSpec(picked[0], "/p", "p", t).apiKey).toBe(false);
  });

  it("leave a launch without a menu pick to the switch", () => {
    const claude = AGENT_ITEMS.find((item) => item.cmd === "claude")!;
    expect(claude.apiKey).toBeUndefined();
    expect(buildStaticTabSpec(claude, "/p", "p", t)).not.toHaveProperty("apiKey");
  });
});

describe("the pick on the tab record", () => {
  const tab = (apiKey?: boolean) => ({
    ...buildStaticTabSpec({ ...AGENT_ITEMS[0], apiKey }, "/p", "p", t),
    key: "k1",
  });

  it("is saved and reaches the spawn, and a change respawns", () => {
    expect(toSavedTabEntry(tab(true)).apiKey).toBe(true);
    expect(toSavedTabEntry(tab()).apiKey).toBeUndefined();
    const spawn = (apiKey?: boolean) => tabTerminalSpawn(tab(apiKey), "p1", { terminalCwd: "/p" });
    expect(spawn(true).apiKey).toBe(true);
    expect(spawn(false).apiKey).toBe(false);
    expect(spawn().apiKey).toBeNull();
    const key = (apiKey?: boolean) => terminalSpawnKey({ ...spawn(apiKey), env: {}, args: [] });
    expect(key(true)).not.toBe(key(false));
    expect(key(false)).not.toBe(key());
  });
});
