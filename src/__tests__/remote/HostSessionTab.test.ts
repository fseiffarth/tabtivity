/**
 * Opening a remote agent's session from the Sessions view after its tab closed:
 * it comes back as the agent tab it was, which is what keeps its Chat view. The
 * window's own closed tab first; past a restart, the agent the host recorded.
 * Anything that cannot be named safely stays the plain shell attach (null).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { hostAgentTabSpec, reopenClosedHostSession } from "../../lib/remote/hostSessionTab";
import { noteClosedAgentTab, useClosedAgentTabsStore } from "../../stores/agents/closedAgentTabs";
import { readerOffered } from "../../lib/agents/agentReader";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { envName, NAMES } from "../../lib/brand";
import { sessionMintedFor } from "../../lib/terminal/tmuxSession";
import type { ProjectEntry } from "../../types";

const PID = "host-session-proj";
const ID = "11111111-2222-4333-8444-555555555555";
const SESSION = `${NAMES.tmuxPrefix}${PID}--agent-aaaa`;
const PLACE = { cwd: "/p", location: "remote" as const };
const t = (key: string) => key;

const PROJECT = {
  id: PID,
  name: "proj",
  status: "active",
  position: 0,
  local_file: `/p/${PID}/project.json`,
  remote: { host: "gpu.example", remote_path: "/home/me/proj" },
} as ProjectEntry;

const hostSays = (answer: unknown) =>
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "remote_tmux_agent" ? Promise.resolve(answer) : Promise.resolve(null),
  );

const CLOSED: TabEntry = {
  key: "agent-1",
  label: "My run",
  cmd: "claude",
  args: ["--session-id", ID],
  cwd: "/p",
  kind: "agent",
  sessionId: ID,
  location: "remote",
  tmuxSession: SESSION,
};

beforeEach(() => {
  mockInvoke.mockReset();
  hostSays(null);
  useProjectsStore.setState({ projects: [PROJECT], activeId: PID });
  useTabsStore.setState({ tabsByScope: { [PID]: [] } });
  useClosedAgentTabsStore.setState({ byScope: {} });
});

describe("reopenClosedHostSession", () => {
  it("brings the closed tab back on its own session, label and conversation", () => {
    noteClosedAgentTab(PID, CLOSED, false);
    expect(reopenClosedHostSession(PID, "primary", SESSION)).toBe(true);
    const [tab] = useTabsStore.getState().tabsByScope[PID];
    expect(tab).toMatchObject({ kind: "agent", label: "My run", sessionId: ID, tmuxSession: SESSION });
    expect(tab.tmuxAttach).toBeUndefined();
    expect(readerOffered(tab, true)).toBe(true);
  });

  it("does not take another host's session of the same name for it", () => {
    noteClosedAgentTab(PID, CLOSED, false);
    expect(reopenClosedHostSession(PID, "w1", SESSION)).toBe(false);
    expect(useTabsStore.getState().tabsByScope[PID]).toEqual([]);
  });

  it("answers false with nothing kept", () => {
    expect(reopenClosedHostSession(PID, "primary", SESSION)).toBe(false);
  });
});

describe("hostAgentTabSpec", () => {
  it("rebuilds the agent tab from what the host recorded", async () => {
    hostSays({ cmd: "claude", sessionId: ID });
    const spec = await hostAgentTabSpec(PID, "primary", SESSION, PLACE, t as never);
    expect(mockInvoke).toHaveBeenCalledWith("remote_tmux_agent", { projectId: PID, hostId: "primary", session: SESSION });
    expect(spec).toMatchObject({ kind: "agent", cmd: "claude", sessionId: ID, tmuxSession: SESSION, location: "remote", cwd: "/p" });
    expect(spec?.args).toContain(ID);
    expect(spec?.env?.[envName("TAB_UID")]).toBe(ID);
    expect(spec?.tmuxAttach).toBeUndefined();
    expect(readerOffered(spec as TabEntry, true)).toBe(true);
  });

  it("asks the host only about this scope's agent sessions", async () => {
    for (const name of [
      `${NAMES.tmuxPrefix}${PID}--shell-aaaa`,
      `${NAMES.tmuxPrefix}other--agent-aaaa`,
      "train",
    ]) {
      expect(await hostAgentTabSpec(PID, "primary", name, PLACE, t as never)).toBeNull();
    }
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("stays a shell attach when the host names no agent we know, or does not answer", async () => {
    expect(await hostAgentTabSpec(PID, "primary", SESSION, PLACE, t as never)).toBeNull();
    hostSays({ cmd: "/tmp/evil", sessionId: ID });
    expect(await hostAgentTabSpec(PID, "primary", SESSION, PLACE, t as never)).toBeNull();
    mockInvoke.mockImplementation(() => Promise.reject(new Error("ssh down")));
    expect(await hostAgentTabSpec(PID, "primary", SESSION, PLACE, t as never)).toBeNull();
  });

  it("never opens a second tab onto a conversation that is open", async () => {
    hostSays({ cmd: "claude", sessionId: ID });
    useTabsStore.setState({ tabsByScope: { [PID]: [{ ...CLOSED, tmuxSession: "elsewhere" }] } });
    expect(await hostAgentTabSpec(PID, "primary", SESSION, PLACE, t as never)).toBeNull();
  });
});

describe("sessionMintedFor", () => {
  it("is exact on the scope", () => {
    expect(sessionMintedFor(SESSION, PID)).toBe(true);
    expect(sessionMintedFor(SESSION, `${PID}x`)).toBe(false);
    expect(sessionMintedFor(SESSION, PID.slice(0, -1))).toBe(false);
    expect(sessionMintedFor("train", PID)).toBe(false);
  });
});
