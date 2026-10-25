/**
 * Which tabs the phone can attach to, and what it may create, per project type
 * (`lib/projectTabHost`). The reachability rule is the sidecar's
 * `discovery::runs_on_this_machine`; the remote and VM rows come from the table
 * both sides read (`tabLocality.fixture.json`), so a drift in either fails one
 * of the two tests.
 */
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { readFileSync } from "node:fs";
import { effectiveTabLocation, type TabKind, type TabLocation } from "../../stores/tabs";
import { shouldPersistLocalTab } from "../../lib/terminal/tmuxSession";
import type { ProjectEntry } from "../../types";
import {
  phoneCreateVerdict,
  phoneListsTab,
  phoneProjectFolder,
  phoneReachesTab,
  projectHostKind,
  tabRunsInContainer,
} from "../../lib/projectTabHost";
import table from "./tabLocality.fixture.json";
import hostTable from "./projectHostReach.fixture.json";

const base: ProjectEntry = {
  id: "p1",
  name: "P",
  status: "active",
  position: 1,
  local_file: "/state/projects/p1/project.json",
  directory: "/state/projects/p1",
};
const remote = { host: "h.invalid", user: "u", remote_path: "/srv/p" } as ProjectEntry["remote"];
const remoteProject: ProjectEntry = { ...base, remote };
const vmProject: ProjectEntry = { ...base, remote, vm: { enabled: true } as ProjectEntry["vm"] };
const containerProject: ProjectEntry = { ...base, sandbox: { enabled: true } };
const agentsContainer: ProjectEntry = { ...base, sandbox: { enabled: true, scope: "agents" } };

const tab = (kind: string, location: string | null) => ({
  kind: kind as TabKind,
  ...(location ? { location: location as TabLocation } : {}),
});

beforeEach(() => {
  try { localStorage.clear(); } catch { /* none */ }
});

describe("the shared locality table, over a project of each host", () => {
  for (const row of table) {
    const name = `${row.kind} ${row.location ?? "(no location)"}${row.vm ? " in a VM project" : ""}`;
    it(`${name} is ${row.local ? "reachable" : "not reachable"}`, () => {
      const project = row.vm ? vmProject : remoteProject;
      expect(phoneReachesTab(project, tab(row.kind, row.location), "p1")).toBe(row.local);
    });
  }
});

/** The whole table (project type x tab kind x location), read by the sidecar's
 * `the_project_host_table_matches_the_windows` too: the host word, whether the
 * phone reaches the tab here, whether its list may hold it (a remote project's
 * host tab too, `docs/mobile_remote_host_tabs_plan.md`) and the create
 * verdict (of a project with a folder). */
describe("the shared project-host table", () => {
  for (const row of hostTable) {
    const name = `${row.project}: ${row.kind} ${row.location ?? "(no location)"}`;
    it(`${name} is ${row.reach ? "reachable" : "not reachable"}, ${row.lists ? "listed" : "not listed"}, host ${row.host}, create ${row.create}`, () => {
      const project = { ...base, ...row.record } as ProjectEntry;
      expect(projectHostKind(project)).toBe(row.host);
      expect(phoneReachesTab(project, tab(row.kind, row.location), "p1")).toBe(row.reach);
      expect(phoneListsTab(project, tab(row.kind, row.location), "p1")).toBe(row.lists);
      expect(phoneCreateVerdict(project)).toBe(row.create);
    });
  }

  it("lists what it reaches, plus a remote project's host tabs, and nothing else", () => {
    for (const row of hostTable) expect(row.lists, JSON.stringify(row)).toBe(row.reach || row.host === "remote");
    expect(hostTable.some((row) => row.lists && !row.reach)).toBe(true);
  });
});

describe("remote-host tabs", () => {
  it("are listed in a remote project, a worker's too, but never reached here", () => {
    for (const location of ["remote", "host:w1"]) {
      expect(phoneListsTab(remoteProject, tab("agent", location), "p1")).toBe(true);
      expect(phoneReachesTab(remoteProject, tab("agent", location), "p1")).toBe(false);
    }
    // A shell with no location runs on the host.
    expect(phoneListsTab(remoteProject, tab("shell", null), "p1")).toBe(true);
    expect(phoneReachesTab(remoteProject, tab("shell", null), "p1")).toBe(false);
  });

  it("are not listed for a VM or a container project", () => {
    expect(phoneListsTab(vmProject, tab("agent", "remote"), "p1")).toBe(false);
    expect(phoneListsTab(vmProject, tab("shell", null), "p1")).toBe(false);
    expect(phoneListsTab(containerProject, tab("agent", null), "p1")).toBe(false);
  });

  it("feed the bridge's per-tab handlers, while create and reopen stay on reach", () => {
    const src = readFileSync("src/components/mobile/MobileBridgeHost.tsx", "utf8") as string;
    expect(src).toContain(".filter((tab) => phoneListsTab(project, tab, scopeId));");
    expect(src).toContain(".filter((closed) => phoneReachesTab(scope.project, closed.tab, scope.id));");
    expect(src).toContain("if (wanted && !phoneReachesTab(scope.project, wanted.tab, scope.id)) return notAttachable;");
  });
});

describe("project hosts", () => {
  it("tells the four types apart, a VM before its forwarded remote", () => {
    expect(projectHostKind(undefined)).toBe("local");
    expect(projectHostKind(base)).toBe("local");
    expect(projectHostKind(remoteProject)).toBe("remote");
    expect(projectHostKind(vmProject)).toBe("vm");
    expect(projectHostKind(containerProject)).toBe("container");
    expect(projectHostKind({ ...base, sandbox: { enabled: false } })).toBe("local");
  });

  it("reaches everything in a local project, a box, root and the assistant", () => {
    for (const kind of ["agent", "shell", "local_agent"]) {
      expect(phoneReachesTab(base, tab(kind, null), "p1")).toBe(true);
      expect(phoneReachesTab(undefined, tab(kind, "remote"), "box:b1")).toBe(true);
    }
  });

  it("reaches a container project's host tabs only", () => {
    expect(phoneReachesTab(containerProject, tab("agent", null), "p1")).toBe(false);
    expect(phoneReachesTab(containerProject, tab("shell", null), "p1")).toBe(false);
    expect(phoneReachesTab(containerProject, tab("local_agent", null), "p1")).toBe(true);
    expect(phoneReachesTab(agentsContainer, tab("agent", null), "p1")).toBe(false);
    expect(phoneReachesTab(agentsContainer, tab("shell", null), "p1")).toBe(true);
    expect(tabRunsInContainer(agentsContainer, "shell", "p1")).toBe(false);
    expect(tabRunsInContainer(containerProject, "agent", "root")).toBe(false);
  });

  it("says what the phone may create: anything, agents, nothing", () => {
    expect(phoneCreateVerdict(undefined)).toBe("all");
    expect(phoneCreateVerdict(base)).toBe("all");
    expect(phoneCreateVerdict(remoteProject)).toBe("agents");
    expect(phoneCreateVerdict(containerProject)).toBe("none");
    expect(phoneCreateVerdict(agentsContainer)).toBe("none");
    expect(phoneCreateVerdict(vmProject)).toBe("none");
  });

  it("uses the folder the sidecar uses", () => {
    expect(phoneProjectFolder(base)).toBe("/state/projects/p1");
    expect(phoneProjectFolder(containerProject)).toBe("/state/projects/p1");
    // A remote project's directory holds project.json only; its files are the mirror.
    expect(phoneProjectFolder(remoteProject)).toBe("/state/projects/p1/mirror");
    expect(phoneProjectFolder({ ...remoteProject, mirror: "/work/p1-mirror/" })).toBe("/work/p1-mirror");
    // A VM has no folder on the host unless the user opted into a mirror.
    expect(phoneProjectFolder(vmProject)).toBe("");
    expect(phoneProjectFolder({ ...vmProject, mirror: "/work/vm-mirror" })).toBe("/work/vm-mirror");
  });
});

describe("the Mobile switch's tmux wrap stays off a tab that runs elsewhere", () => {
  it("wraps no agent that runs on a remote host or a login node", () => {
    // PaneSlot: `localRunning = !remoteProject || location === "local"`.
    const localRunning = (tab: { kind: TabKind; location?: TabLocation }) => effectiveTabLocation(tab) === "local";
    const wrapped = (tab: { kind: TabKind; location?: TabLocation }) =>
      shouldPersistLocalTab(tab.kind, "p1", localRunning(tab), true, true, true);
    expect(wrapped({ kind: "agent" })).toBe(true);
    expect(wrapped({ kind: "agent", location: "remote" })).toBe(false);
    expect(wrapped({ kind: "agent", location: "host:w1" })).toBe(false);
  });

  it("is the expression PaneSlot actually evaluates", () => {
    const src = readFileSync("src/components/layout/PaneSlot.tsx", "utf8") as string;
    expect(src).toContain('const localRunning = !paneRemoteProj || location === "local";');
    expect(src).toContain("const location = effectiveTabLocation(tab, { vmProject });");
  });
});
