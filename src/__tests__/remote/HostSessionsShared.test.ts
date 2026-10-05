/**
 * The persistent-session list is ONE reading shared by every surface that shows
 * it (`stores/remote/hostSessions`), not a private copy per `ProjectFilesView`.
 *
 * The same viewer is rendered by the side panel, by every Files (Project) tab
 * and by every subwindow's docked file column at once. When each owned its own
 * `tmux ls` poll, the cost was N SSH round trips per host per tick and — the part
 * the user sees — the surfaces disagreed: a session killed in one sat on in the
 * others until their own interval came round. These tests pin the two properties
 * that fix buys: **one poll however many subscribers**, and **one list they all
 * read**.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useHostSessionsStore, sessionHostsOf } from "../../stores/remote/hostSessions";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import type { ProjectEntry } from "../../types";
import { BRAND } from "../../lib/brand";

/** A fresh project id per test. The store's refcount/interval bookkeeping is
 *  module-level (it has to outlive any one component), so tests that reused one
 *  id would inherit each other's poll. */
let seq = 0;
let PID = "p0";

function session(name: string) {
  return {
    name,
    windows: 1,
    created: 1,
    attached: false,
    activity: 1,
    currentCommand: "bash",
    working: false,
    currentPath: "/home/me/proj",
  };
}

function remoteProject(): ProjectEntry {
  return {
    id: PID,
    name: "proj",
    status: "active",
    position: 10,
    local_file: `/p/${PID}/project.json`,
    remote: { host: "gpu.example", remote_path: "/home/me/proj" },
  };
}

/** Flush the pending microtasks the poll's `Promise.all` resolves through. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  invoke.mockReset();
  invoke.mockImplementation((cmd: string) =>
    cmd === "remote_tmux_list" ? Promise.resolve([session(`${BRAND.slug}-a`)]) : Promise.resolve(null),
  );
  PID = `p${++seq}`;
  useHostSessionsStore.setState({ byProject: {}, showAll: {} });
  useProjectsStore.setState({ projects: [remoteProject()] });
  useRemoteStatusStore.getState().setSsh(PID, "connected");
});

afterEach(() => {
  vi.useRealTimers();
});

/** Round trips asking for THIS test's project, so a leaked poll cannot count. */
const listCalls = () =>
  invoke.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "remote_tmux_list" && (args as { projectId: string }).projectId === PID,
  ).length;
const lastListArgs = () => {
  const mine = invoke.mock.calls.filter(
    ([cmd, args]) =>
      cmd === "remote_tmux_list" && (args as { projectId: string }).projectId === PID,
  );
  return mine[mine.length - 1]?.[1];
};

describe("sessionHostsOf", () => {
  it("puts the primary first, then each worker, labelled", () => {
    const project = { ...remoteProject(), compute_hosts: [{ id: "h1", host: "w.example", remote_path: "/w", label: "gpu-2" }] };
    expect(sessionHostsOf(project)).toEqual([
      { id: "primary", label: "gpu.example" },
      { id: "h1", label: "gpu-2" },
    ]);
  });

  it("is empty for a local project — there is no host to list sessions on", () => {
    expect(sessionHostsOf({ ...remoteProject(), remote: undefined })).toEqual([]);
  });
});

describe("the shared session poll", () => {
  it("runs ONCE for two surfaces, not once each", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID); // side panel
    retain(PID); // docked subwindow column
    await settle();
    expect(listCalls()).toBe(1);

    // ...and one tick later it is still a single round trip per host.
    await vi.advanceTimersByTimeAsync(7000);
    expect(listCalls()).toBe(2);

    release(PID);
    release(PID);
  });

  it("keeps polling while any surface remains, and stops when the last leaves", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    retain(PID);
    await settle();
    release(PID); // one surface closes; the other still shows the list
    await vi.advanceTimersByTimeAsync(7000);
    const whileOpen = listCalls();
    expect(whileOpen).toBeGreaterThan(1);

    release(PID); // the last one closes
    await vi.advanceTimersByTimeAsync(21000);
    expect(listCalls()).toBe(whileOpen);
  });

  it("keeps the last reading when the last surface leaves — a blank list would read as 'nothing is running'", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(useHostSessionsStore.getState().byProject[PID]).toHaveLength(1);
    release(PID);
    expect(useHostSessionsStore.getState().byProject[PID]).toHaveLength(1);
  });

  it("lists nothing, and asks the host nothing, while no host is connected", async () => {
    useRemoteStatusStore.getState().setSsh(PID, "off");
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(listCalls()).toBe(0);
    // "We looked and there is nothing", not "we never looked".
    expect(useHostSessionsStore.getState().byProject[PID]).toEqual([]);
    release(PID);
  });

  it("keeps a host's rows when ITS read fails — a failed probe is not 'nothing is running'", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(useHostSessionsStore.getState().byProject[PID]).toHaveLength(1);

    // The probe spawns its own `ssh` on the shared ControlMaster socket, so a
    // socket being replaced under it fails one tick and succeeds on the next.
    // Swallowing that into an empty list blanked the Sessions view for 7 s and
    // reported "no persistent sessions on the host".
    invoke.mockImplementation((cmd: string) =>
      cmd === "remote_tmux_list" ? Promise.reject(new Error("ssh: connect failed")) : Promise.resolve(null),
    );
    await vi.advanceTimersByTimeAsync(7000);
    expect(useHostSessionsStore.getState().byProject[PID]).toHaveLength(1);
    release(PID);
  });

  it("still drops a host's rows when its read SUCCEEDS with nothing", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(useHostSessionsStore.getState().byProject[PID]).toHaveLength(1);

    // The other half of the same rule: an answered "there is nothing here" must
    // still empty the list, or a killed session would never leave it.
    invoke.mockImplementation((cmd: string) =>
      cmd === "remote_tmux_list" ? Promise.resolve([]) : Promise.resolve(null),
    );
    await vi.advanceTimersByTimeAsync(7000);
    expect(useHostSessionsStore.getState().byProject[PID]).toEqual([]);
    release(PID);
  });

  it("re-polls the moment a host connects, rather than up to a tick later", async () => {
    useRemoteStatusStore.getState().setSsh(PID, "off");
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(listCalls()).toBe(0);

    useRemoteStatusStore.getState().setSsh(PID, "connected");
    await settle();
    expect(listCalls()).toBe(1);
    release(PID);
  });
});

describe("one list every surface reads", () => {
  it("drops a killed row for everyone at once", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    useHostSessionsStore.getState().dropRow(PID, "primary", `${BRAND.slug}-a`);
    // There is only one list, so there is no second copy left holding the row.
    expect(useHostSessionsStore.getState().byProject[PID]).toEqual([]);
    release(PID);
  });

  it("renames a row in place", async () => {
    const { retain, release } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    useHostSessionsStore.getState().renameRow(PID, "primary", `${BRAND.slug}-a`, "train");
    expect(useHostSessionsStore.getState().byProject[PID]?.[0].session.name).toBe("train");
    release(PID);
  });

  it("shares `showAll` — it changes what the backend returns, so two surfaces must not hold two answers", async () => {
    const { retain, release, setShowAll } = useHostSessionsStore.getState();
    retain(PID);
    await settle();
    expect(lastListArgs()).toEqual({ projectId: PID, hostId: "primary", includeAll: false });

    setShowAll(PID, true);
    await settle();
    expect(useHostSessionsStore.getState().showAll[PID]).toBe(true);
    expect(lastListArgs()).toEqual({ projectId: PID, hostId: "primary", includeAll: true });
    release(PID);
  });
});
