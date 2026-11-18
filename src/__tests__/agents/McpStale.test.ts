/**
 * Stale Tabtivity tools after a reattach (`stores/agents/mcpStale`): which tabs
 * the bulk toast takes (idle, resumed by id, never a continue-latest CLI),
 * that it runs at most four relaunches at once, that "Reconnect when this turn
 * ends" fires on the turn hook's `done`, and that the toast speaks once per
 * batch of newly stale tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
type TurnHandler = (ev: { payload: { id: string; state: string; job?: boolean } }) => void;
const turnHandlers: TurnHandler[] = [];
type SessionsHandler = (ev: { payload: unknown }) => void;
const sessionsHandlers: SessionsHandler[] = [];
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn((name: string, handler: TurnHandler & SessionsHandler) => {
    const list: unknown[] | null =
      name === "agent-turn" ? turnHandlers : name === "root-mcp-sessions-changed" ? sessionsHandlers : null;
    list?.push(handler);
    return Promise.resolve(() => {
      const at = list?.indexOf(handler) ?? -1;
      if (at >= 0) list?.splice(at, 1);
    });
  }),
}));

import {
  _resetMcpStaleForTest,
  armMcpReconnect,
  mcpReconnectKind,
  mcpStaleBulkCandidates,
  noteMcpStale,
  reconnectIdleMcpStale,
  TOAST_SETTLE_MS,
  useMcpStaleStore,
  watchMcpStaleNotices,
} from "../../stores/agents/mcpStale";
import { _clearPtyActivityForTest, noteAgentTurn } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

function agentTab(key: string, extra: Partial<TabEntry> = {}): TabEntry {
  return {
    key,
    scope: "p1",
    kind: "agent",
    cmd: "claude",
    label: key,
    cwd: "/p1",
    sessionId: `sid-${key}`,
    tmuxSession: `${BRAND.slug}-p1--${key}`,
    ...extra,
  } as TabEntry;
}

function seed(tabs: TabEntry[]) {
  useTabsStore.setState((state) => ({ tabsByScope: { ...state.tabsByScope, p1: tabs } }));
}

const relaunchSeq = (key: string) =>
  useTabsStore.getState().tabsByScope.p1.find((tab) => tab.key === key)?.relaunchSeq ?? 0;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(null));
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "p1", path: "/p1" }] as never,
    switchToast: null,
    switchToastAction: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  _resetMcpStaleForTest();
  _clearPtyActivityForTest();
});

describe("stale app tools", () => {
  it("resumes Claude, Codex, Mistral and OpenCode by id, the continue-latest CLIs not, Aider not at all", () => {
    const kind = (cmd: string, extra: Partial<TabEntry> = {}) => mcpReconnectKind("p1", agentTab("a", { cmd, ...extra }));
    expect(["claude", "codex", "vibe", "opencode"].map((cmd) => kind(cmd))).toEqual(["byId", "byId", "byId", "byId"]);
    expect(["cursor-agent", "grok", "qwen", "droid", "gemini"].map((cmd) => kind(cmd))).toEqual([
      "latest",
      "latest",
      "latest",
      "latest",
      "latest",
    ]);
    expect(kind("aider")).toBe("none");
    expect(kind("claude", { sessionId: undefined })).toBe("none");
  });

  it("bulk takes only idle tabs that resume by id", () => {
    seed([
      agentTab("idle"),
      agentTab("working"),
      agentTab("latest", { cmd: "gemini" }),
      agentTab("job"),
      agentTab("armed"),
      agentTab("fresh"),
    ]);
    for (const key of ["idle", "working", "latest", "job", "armed"]) noteMcpStale(`p1:${key}`, true);
    noteMcpStale("p1:fresh", false);
    noteAgentTurn("p1:working", "working");
    noteAgentTurn("p1:job", "done", true);
    noteAgentTurn("p1:armed", "working");
    void armMcpReconnect("p1:armed");
    expect(useMcpStaleStore.getState().armed["p1:armed"]).toBe(true);
    expect(mcpStaleBulkCandidates()).toEqual(["p1:idle"]);
  });

  it("relaunches at most four at a time, each slot waiting for its tab's respawn", async () => {
    const keys = ["a", "b", "c", "d", "e", "f"];
    seed(keys.map((key) => agentTab(key)));
    for (const key of keys) noteMcpStale(`p1:${key}`, true);
    const run = reconnectIdleMcpStale();
    await flush();
    expect(keys.map(relaunchSeq)).toEqual([1, 1, 1, 1, 0, 0]);
    // The first respawn answers: its slot takes the next tab.
    noteMcpStale("p1:a", false);
    await flush();
    expect(keys.map(relaunchSeq)).toEqual([1, 1, 1, 1, 1, 0]);
    for (const key of ["b", "c", "d", "e", "f"]) {
      noteMcpStale(`p1:${key}`, false);
      await flush();
    }
    await run;
    expect(keys.map(relaunchSeq)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(invokeMock).toHaveBeenCalledWith("local_tmux_kill", { session: `${BRAND.slug}-p1--a` });
  });

  it("Reconnect when this turn ends waits for the hook's done", async () => {
    seed([agentTab("t")]);
    noteMcpStale("p1:t", true);
    noteAgentTurn("p1:t", "working");
    await flush();
    expect(await armMcpReconnect("p1:t")).toBe("armed");
    const emit = (state: string) => {
      noteAgentTurn("p1:t", state as never);
      for (const handler of [...turnHandlers]) handler({ payload: { id: "p1:t", state } });
    };
    emit("working");
    await flush();
    expect(relaunchSeq("t")).toBe(0);
    emit("done");
    await flush();
    await flush();
    expect(relaunchSeq("t")).toBe(1);
    expect(useMcpStaleStore.getState().armed["p1:t"]).toBeUndefined();
  });

  it("arming an idle tab reconnects it at once", async () => {
    seed([agentTab("t")]);
    noteMcpStale("p1:t", true);
    expect(await armMcpReconnect("p1:t")).toBe("undone");
    expect(relaunchSeq("t")).toBe(1);
    expect(useMcpStaleStore.getState().stale["p1:t"]).toBeUndefined();
  });

  it("toasts once per batch, offering the bulk only when an idle id-resumable tab is stale", () => {
    vi.useFakeTimers();
    seed([agentTab("a"), agentTab("b"), agentTab("g", { cmd: "gemini" })]);
    noteMcpStale("p1:a", true);
    noteMcpStale("p1:b", true);
    vi.advanceTimersByTime(TOAST_SETTLE_MS - 1);
    expect(useProjectsStore.getState().switchToast).toBeNull();
    vi.advanceTimersByTime(1);
    const { switchToast, switchToastAction } = useProjectsStore.getState();
    expect(switchToast).toBe(`2 agent tabs lost their ${BRAND.display} tools`);
    expect(switchToastAction).toMatchObject({ text: switchToast, label: "Reconnect idle ones" });

    // Nothing new: no second toast.
    useProjectsStore.setState({ switchToast: null, switchToastAction: null });
    noteMcpStale("p1:a", true);
    vi.advanceTimersByTime(TOAST_SETTLE_MS);
    expect(useProjectsStore.getState().switchToast).toBeNull();

    // A new tab: the toast counts every stale one; Gemini alone is no bulk.
    noteMcpStale("p1:a", false);
    noteMcpStale("p1:b", false);
    noteMcpStale("p1:g", true);
    vi.advanceTimersByTime(TOAST_SETTLE_MS);
    expect(useProjectsStore.getState().switchToast).toBe(`1 agent tab lost its ${BRAND.display} tools`);
    expect(useProjectsStore.getState().switchToastAction).toBeNull();
  });

  it("flags a running tab the backend finds stale after its spawn: card, bulk toast, and its next spawn clears it", async () => {
    // The unlisten arrives a few microtasks after `listen` answers.
    const ticks = async () => {
      for (let i = 0; i < 3; i += 1) await Promise.resolve();
    };
    vi.useFakeTimers();
    seed([agentTab("a")]);
    noteMcpStale("p1:a", false);
    // No agent terminal mounted: nobody listens.
    expect(sessionsHandlers).toHaveLength(0);
    const stops = [watchMcpStaleNotices(), watchMcpStaleNotices()];
    expect(sessionsHandlers).toHaveLength(1);
    const ring = (payload: unknown) => sessionsHandlers.forEach((handler) => handler({ payload }));
    // The session list's own cue (no payload) and junk flag nothing.
    ring(null);
    ring({ staleTab: 7 });
    expect(useMcpStaleStore.getState().stale).toEqual({});
    // A revived token of it was refused: nobody could be seen presenting it.
    ring({ staleTab: "p1:a" });
    expect(useMcpStaleStore.getState().stale["p1:a"]).toBe(true);
    expect(mcpStaleBulkCandidates()).toEqual(["p1:a"]);
    vi.advanceTimersByTime(TOAST_SETTLE_MS);
    expect(useProjectsStore.getState().switchToast).toBe(`1 agent tab lost its ${BRAND.display} tools`);
    expect(useProjectsStore.getState().switchToastAction).toMatchObject({ label: "Reconnect idle ones" });
    // Reconnect's respawn answers afresh.
    noteMcpStale("p1:a", false);
    expect(useMcpStaleStore.getState().stale["p1:a"]).toBeUndefined();
    await ticks();
    stops[0]();
    await ticks();
    expect(sessionsHandlers).toHaveLength(1);
    stops[1]();
    await ticks();
    expect(sessionsHandlers).toHaveLength(0);
  });
});
