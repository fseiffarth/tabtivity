/**
 * SSH-sync Phase 0 — per-tab local/remote locality axis. Agent tabs default
 * LOCAL (run in the project mirror), shell tabs default REMOTE (run on the host
 * over ssh); local_agent is fixed-local; the choice is user-toggleable via
 * setTabLocation and survives the save → project.json → load round-trip. These
 * tests lock the defaults, the resolver, the cwd resolution, and the round-trip.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import {
  defaultLocationForKind,
  effectiveTabLocation,
  hostTabCwd,
  hostTabId,
  isLocatableKind,
  localTabCwd,
  useTabsStore,
  type SavedLayoutTree,
} from "../../stores/tabs";

const invokeMock = vi.mocked(invoke);

function resetStore() {
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
}

describe("locality defaults + resolver", () => {
  it("agents default local, shells default remote", () => {
    expect(defaultLocationForKind("agent")).toBe("local");
    expect(defaultLocationForKind("shell")).toBe("remote");
  });

  it("effectiveTabLocation honors an explicit override, else the kind default", () => {
    expect(effectiveTabLocation({ kind: "agent" })).toBe("local");
    expect(effectiveTabLocation({ kind: "shell" })).toBe("remote");
    expect(effectiveTabLocation({ kind: "agent", location: "remote" })).toBe("remote");
    expect(effectiveTabLocation({ kind: "shell", location: "local" })).toBe("local");
    // local_agent is fixed-local regardless of any stored value.
    expect(effectiveTabLocation({ kind: "local_agent", location: "remote" })).toBe("local");
  });

  it("only agent/shell tabs are locatable", () => {
    expect(isLocatableKind("agent")).toBe(true);
    expect(isLocatableKind("shell")).toBe(true);
    expect(isLocatableKind("local_agent")).toBe(false);
    expect(isLocatableKind("files")).toBe(false);
    expect(isLocatableKind("embed")).toBe(false);
  });
});

describe("localTabCwd", () => {
  const opts = (over = {}) => ({
    isRemoteProject: true,
    projectDirectory: "/state/remote-projects/p1",
    fallback: "/ignored",
    ...over,
  });

  it("routes a local-on-remote tab into the project mirror dir", () => {
    expect(localTabCwd({ kind: "agent" }, opts())).toBe("/state/remote-projects/p1/mirror");
  });

  it("leaves a remote-running tab on its own cwd (ignored by the ssh wrap)", () => {
    expect(localTabCwd({ kind: "shell" }, opts())).toBe("/ignored");
    // An agent explicitly switched to remote also keeps the fallback.
    expect(localTabCwd({ kind: "agent", location: "remote" }, opts())).toBe("/ignored");
  });

  it("is inert on a local project (always the tab's own cwd)", () => {
    expect(localTabCwd({ kind: "agent" }, opts({ isRemoteProject: false }))).toBe("/ignored");
  });
});

describe("setTabLocation", () => {
  beforeEach(resetStore);

  it("flips a tab's locality and is a no-op when unchanged", () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({ label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" });

    useTabsStore.getState().setTabLocation(tab.key, "remote");
    expect(
      useTabsStore.getState().tabs.find((t) => t.key === tab.key)?.location,
    ).toBe("remote");

    const before = useTabsStore.getState().tabs;
    useTabsStore.getState().setTabLocation(tab.key, "remote");
    // Re-setting the same value leaves the tabs array reference untouched.
    expect(useTabsStore.getState().tabs).toBe(before);
  });
});

describe("location round-trips through save/load", () => {
  beforeEach(() => {
    invokeMock.mockClear();
    resetStore();
  });

  it("persists location in the saved tab layout", async () => {
    const store = useTabsStore.getState();
    store.setScope("p");
    const tab = store.addTab({ label: "Shell", cmd: "", cwd: "/p", kind: "shell" });
    useTabsStore.getState().setTabLocation(tab.key, "local");

    await useTabsStore.getState().saveLayout("/p/project.json");

    const call = invokeMock.mock.calls.find((c) => c[0] === "workspace_sync");
    expect(call).toBeTruthy();
    const arg = call![1] as {
      tabs: { label: string; location?: string }[];
      groups: SavedLayoutTree | null;
    };
    expect(arg.tabs.find((t) => t.label === "Shell")?.location).toBe("local");
  });

  it("restores location onto the rebuilt tab", () => {
    useTabsStore.getState().loadFromLayout(
      [
        {
          key: "agent-9",
          label: "Claude",
          cmd: "claude",
          cwd: "/p",
          kind: "agent",
          location: "remote",
        },
      ],
      "/p",
      "p",
    );
    const tabs = useTabsStore.getState().tabsByScope["p"];
    expect(tabs).toHaveLength(1);
    expect(tabs[0].location).toBe("remote");
  });
});

describe("hostTabCwd", () => {
  const project = {
    remote: { remote_path: "/srv/primary/p1" },
    compute_hosts: [{ id: "h1", remote_path: "/scratch/p1" }],
  };

  it("names the folder on the host a tab runs on, not the state folder", () => {
    expect(hostTabCwd({ kind: "agent", location: "remote" }, project)).toBe("/srv/primary/p1");
    expect(hostTabCwd({ kind: "shell" }, project)).toBe("/srv/primary/p1");
    expect(hostTabCwd({ kind: "agent", location: "host:h1" }, project)).toBe("/scratch/p1");
  });

  it("falls back to the primary for a removed worker, as the spawn does", () => {
    expect(hostTabCwd({ kind: "agent", location: "host:gone" }, project)).toBe("/srv/primary/p1");
  });

  it("is null for a tab that runs locally or a project with no such host", () => {
    expect(hostTabCwd({ kind: "agent" }, project)).toBeNull();
    expect(hostTabCwd({ kind: "local_agent", location: "remote" }, project)).toBeNull();
    expect(hostTabCwd({ kind: "agent", location: "remote" }, {})).toBeNull();
    expect(hostTabCwd({ kind: "agent", location: "remote" }, undefined)).toBeNull();
  });

  it("pins a VM project's tabs to the VM host", () => {
    expect(hostTabCwd({ kind: "agent", location: "local" }, { ...project, vm: { enabled: true } })).toBe("/srv/primary/p1");
  });
});

describe("hostTabId", () => {
  const project = {
    remote: { remote_path: "/srv/primary/p1" },
    compute_hosts: [{ id: "h1", remote_path: "/scratch/p1" }],
  };

  it("names the host a remote project's tab runs on", () => {
    expect(hostTabId({ kind: "agent", location: "remote" }, project)).toBe("primary");
    expect(hostTabId({ kind: "agent", location: "host:h1" }, project)).toBe("h1");
    expect(hostTabId({ kind: "agent", location: "host:gone" }, project)).toBe("primary");
  });

  it("is null for a local tab or a local project", () => {
    expect(hostTabId({ kind: "agent" }, project)).toBeNull();
    expect(hostTabId({ kind: "agent", location: "local" }, project)).toBeNull();
    expect(hostTabId({ kind: "agent", location: "remote" }, {})).toBeNull();
    expect(hostTabId({ kind: "agent", location: "remote" }, undefined)).toBeNull();
  });
});
