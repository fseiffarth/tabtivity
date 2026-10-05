/**
 * Tests for the tab context menu's "Duplicate tab" — `useTabsStore.duplicateTab`
 * and the pure `duplicateSpec` behind it.
 *
 * The interesting half is not that a copy appears but WHAT is copied: everything
 * describing the tab (cmd/args/cwd/locality/folder/viewer position) rides along,
 * while everything IDENTIFYING it (an agent's `sessionId`, wherever it was baked
 * into `args`/`env`, plus the tmux session name and the host-bound marker) is
 * re-minted or dropped — two tabs sharing one of those are not two tabs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  useTabsStore,
  duplicateSpec,
  type GroupNode,
  type TabEntry,
} from "../../stores/tabs";
import { BRAND, envName } from "../../lib/brand";

function seed() {
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
  for (const label of ["a", "b", "c"]) {
    useTabsStore.getState().addTab({ label, cmd: "bash", cwd: "/p", kind: "shell" });
  }
}

function labels() {
  return (useTabsStore.getState().layout as GroupNode).tabKeys.map(
    (k) => useTabsStore.getState().tabs.find((x) => x.key === k)!.label,
  );
}

function byLabel(label: string): TabEntry {
  return useTabsStore.getState().tabs.find((t) => t.label === label)!;
}

describe("tabs store — duplicateTab", () => {
  beforeEach(seed);

  it("lands the copy directly to the right of its source, not at the end", () => {
    const copy = useTabsStore.getState().duplicateTab(byLabel("a").key)!;
    expect(labels()).toEqual(["a", "a", "b", "c"]);
    const group = useTabsStore.getState().layout as GroupNode;
    expect(group.tabKeys[1]).toBe(copy.key);
    // …and is the one now showing.
    expect(group.activeKey).toBe(copy.key);
  });

  it("copies the launch spec and mints a fresh key", () => {
    const source = byLabel("b");
    useTabsStore.getState().setTabLocation(source.key, "remote");
    const copy = useTabsStore.getState().duplicateTab(source.key)!;
    expect(copy.key).not.toBe(source.key);
    expect(copy.cmd).toBe("bash");
    expect(copy.cwd).toBe("/p");
    expect(copy.kind).toBe("shell");
    // The locality is part of what the tab IS: a copy that ran on the other
    // machine would be a different tab.
    expect(copy.location).toBe("remote");
  });

  it("gives the copy its own tmux session, never the source's", () => {
    const source = byLabel("a");
    expect(source.tmuxSession).toBeTruthy(); // shell tabs mint one at creation
    const copy = useTabsStore.getState().duplicateTab(source.key)!;
    expect(copy.tmuxSession).toBeTruthy();
    expect(copy.tmuxSession).not.toBe(source.tmuxSession);
  });

  it("returns null for a key that is not in the current scope", () => {
    expect(useTabsStore.getState().duplicateTab("nope-1")).toBeNull();
  });

  it("applies the caller's overrides (the host-bound marker it had to register)", () => {
    useTabsStore.getState().addTab({
      label: "vibe",
      cmd: "vibe",
      cwd: "/p",
      kind: "local_agent",
      hostBoundUid: "uid-source",
    });
    const copy = useTabsStore
      .getState()
      .duplicateTab(byLabel("vibe").key, { hostBoundUid: "uid-copy" })!;
    expect(copy.hostBoundUid).toBe("uid-copy");
  });

  it("drops the host-bound marker when the caller supplies none", () => {
    useTabsStore.getState().addTab({
      label: "vibe",
      cmd: "vibe",
      cwd: "/p",
      kind: "local_agent",
      hostBoundUid: "uid-source",
    });
    const copy = useTabsStore.getState().duplicateTab(byLabel("vibe").key)!;
    // Running inside the container is the safe direction — never an inherited
    // grant (#150).
    expect(copy.hostBoundUid).toBeUndefined();
  });

  it("mints an isolated schedule target for an agent duplicate", () => {
    useTabsStore.getState().addTab({ label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" });
    const source = byLabel("Claude");
    const copy = useTabsStore.getState().duplicateTab(source.key)!;
    expect(source.scheduleTargetId).toBeTruthy();
    expect(copy.scheduleTargetId).toBeTruthy();
    expect(copy.scheduleTargetId).not.toBe(source.scheduleTargetId);
  });
});

describe("duplicateSpec", () => {
  it("drops the schedule target so the duplicate receives an isolated binding", () => {
    const tab: TabEntry = {
      key: "agent-scheduled",
      label: "Claude",
      kind: "agent",
      cmd: "claude",
      cwd: "/p",
      scheduleTargetId: "target-original",
    };
    expect(duplicateSpec(tab).scheduleTargetId).toBeUndefined();
  });
  const agent: TabEntry = {
    key: "agent-1",
    label: "Claude",
    cmd: "claude",
    args: ["--session-id", "sess-1", "--verbose"],
    env: { [envName("TAB_UID")]: "sess-1", TERM: "xterm" },
    cwd: "/p",
    kind: "agent",
    sessionId: "sess-1",
    tmuxSession: `${BRAND.slug}-p--agent-xyz`,
    tmuxAttach: "some-session",
    hostBoundUid: "uid-1",
  };

  it("re-mints the session id everywhere it was baked in", () => {
    const spec = duplicateSpec(agent);
    expect(spec.sessionId).toBeTruthy();
    expect(spec.sessionId).not.toBe("sess-1");
    // The uuid reaches the agent through the launch args and the env, both
    // frozen at creation — a copy still carrying either would collide with the
    // original's conversation.
    expect(spec.args).toEqual(["--session-id", spec.sessionId, "--verbose"]);
    expect(spec.env).toEqual({ [envName("TAB_UID")]: spec.sessionId, TERM: "xterm" });
  });

  it("drops the identities a second tab must not share", () => {
    const spec = duplicateSpec(agent) as Partial<TabEntry>;
    expect(spec.key).toBeUndefined();
    expect(spec.tmuxSession).toBeUndefined();
    expect(spec.tmuxAttach).toBeUndefined();
    expect(spec.hostBoundUid).toBeUndefined();
  });

  it("leaves a tab with no session id otherwise untouched", () => {
    const viewer: TabEntry = {
      key: "embed-1",
      label: "paper.pdf",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/paper.pdf",
      viewer: "pdf",
      viewerState: { scrollTop: 400 },
    };
    const spec = duplicateSpec(viewer);
    expect(spec).toEqual({
      label: "paper.pdf",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/paper.pdf",
      viewer: "pdf",
      viewerState: { scrollTop: 400 },
    });
  });
});
