/**
 * The stopped state's place on a tab (`docs/done/agent_tab_stop_plan.md` §2):
 * `stopped` is runtime only — never saved, never copied — and `lastUsedAt` is
 * saved and validated on the way back in.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { toSavedTabEntry, useTabsStore, type SavedTabEntry, type TabEntry } from "../../stores/tabs";
import { duplicateSpec, restoreSavedTab, restoredLastUsedAt } from "../../stores/tabs/tabEntries";
import { reopenSpec } from "../../stores/agents/closedAgentTabs";
import { costBytes, describeTabCost, tabCost } from "../../lib/tabCost";
import { translate, type TranslationKey } from "../../lib/i18n";

const NOW = Date.now();

function agent(key: string, over: Partial<TabEntry> = {}): TabEntry {
  return { key, label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", sessionId: "00000000-0000-4000-8000-000000000001", ...over };
}

beforeEach(() => {
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [agent("agent-1")] },
    layoutByScope: { p1: { type: "group", id: "g1", tabKeys: ["agent-1"], activeKey: "agent-1" } },
    focusedGroupByScope: {},
    tabs: [agent("agent-1")],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("saving", () => {
  it("keeps lastUsedAt and drops stopped", () => {
    const saved = toSavedTabEntry(agent("agent-1", { stopped: true, lastUsedAt: NOW - 5000 }));
    expect(saved.lastUsedAt).toBe(NOW - 5000);
    expect("stopped" in saved).toBe(false);
  });
});

describe("restoring", () => {
  const ctx = { defaultCwd: "/p", scope: "p1", agentRoots: [] };
  const savedAgent = (over: Partial<SavedTabEntry>): SavedTabEntry => ({
    key: "agent-1",
    label: "Claude",
    cmd: "claude",
    cwd: "/p",
    kind: "agent",
    sessionId: "00000000-0000-4000-8000-000000000001",
    ...over,
  });

  it("takes a sane lastUsedAt back", () => {
    expect(restoreSavedTab(savedAgent({ lastUsedAt: NOW - 1000 }), ctx).lastUsedAt).toBe(NOW - 1000);
  });

  it("drops a junk or far-future lastUsedAt", () => {
    for (const bad of [Number.NaN, -1, 0, NOW + 3 * 86_400_000, "1" as unknown as number]) {
      expect(restoreSavedTab(savedAgent({ lastUsedAt: bad }), ctx).lastUsedAt).toBeUndefined();
    }
    expect(restoredLastUsedAt(NOW + 3_600_000, NOW)).toBe(NOW + 3_600_000);
  });

  it("never brings stopped back from a file", () => {
    const fromFile = { ...savedAgent({}), stopped: true } as SavedTabEntry;
    expect(restoreSavedTab(fromFile, ctx).stopped).toBeUndefined();
  });
});

describe("copies", () => {
  it("a duplicate drops stopped and lastUsedAt", () => {
    const copy = duplicateSpec(agent("agent-1", { stopped: true, lastUsedAt: NOW }));
    expect(copy.stopped).toBeUndefined();
    expect(copy.lastUsedAt).toBeUndefined();
  });

  it("a reopened closed tab drops stopped", () => {
    const spec = reopenSpec({ id: "c1", tab: agent("agent-1", { stopped: true }), closedAt: NOW, sessionEnded: true });
    expect(spec.stopped).toBeUndefined();
  });
});

describe("the hover card's memory row", () => {
  it("says a stopped agent tab resumes when shown", () => {
    const cost = tabCost("p1", agent("agent-1", { stopped: true }));
    expect(cost).toEqual({ kind: "terminal", state: "stopped" });
    const t = (key: TranslationKey, params?: Record<string, string | number>) => translate("en", key, params);
    expect(describeTabCost(cost!, t)).toBe("Stopped — resumes when shown");
    expect(costBytes(cost)).toBeUndefined();
  });
});

describe("the store actions", () => {
  it("setTabStopped flips the flag and is a no-op when it already is", () => {
    const store = useTabsStore.getState();
    store.setTabStopped("p1", "agent-1", true);
    expect(useTabsStore.getState().tabsByScope.p1?.[0].stopped).toBe(true);
    const before = useTabsStore.getState().tabsByScope.p1;
    useTabsStore.getState().setTabStopped("p1", "agent-1", true);
    expect(useTabsStore.getState().tabsByScope.p1).toBe(before);
    useTabsStore.getState().setTabStopped("p1", "agent-1", false);
    expect(useTabsStore.getState().tabsByScope.p1?.[0].stopped).toBeUndefined();
  });

  it("relaunchTabInScope can clear stopped and the first prompt in one write", () => {
    useTabsStore.setState({ tabsByScope: { p1: [agent("agent-1", { stopped: true, initialInput: "hi\r" })] } });
    useTabsStore.getState().relaunchTabInScope("p1", "agent-1", ["--resume", "x"], { stopped: undefined, initialInput: undefined });
    const tab = useTabsStore.getState().tabsByScope.p1?.[0];
    expect(tab?.stopped).toBeUndefined();
    expect(tab?.initialInput).toBeUndefined();
    expect(tab?.args).toEqual(["--resume", "x"]);
    expect(tab?.relaunchSeq).toBe(1);
  });

  it("setTabLastUsedAt moves the mark", () => {
    useTabsStore.getState().setTabLastUsedAt("p1", "agent-1", NOW);
    expect(useTabsStore.getState().tabsByScope.p1?.[0].lastUsedAt).toBe(NOW);
  });
});
