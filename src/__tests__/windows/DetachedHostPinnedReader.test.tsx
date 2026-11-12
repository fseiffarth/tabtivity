/**
 * A popout's agent tab of a host-pinned project (a VM or remote-only project,
 * `isHostPinned`) runs on the host, as it does in the main window. The popout
 * used to hand the shared `TabPane` no `hostPinned`, so `tabTerminalSpawn`
 * resolved the tab's locality as "local" (agents default local): the terminal
 * still attached by PTY id, but its Chat read the conversation off this
 * machine's disk instead of the host and came up empty. The same holds for
 * the cockpit's attach-only view (`AttachedAgentPane`).
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  cursorPosition: vi.fn(() => Promise.resolve({ x: 0, y: 0 })),
  getCurrentWindow: () => ({
    label: "popout",
    innerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    outerSize: () => Promise.resolve({ width: 800, height: 600 }),
    scaleFactor: () => Promise.resolve(1),
    onMoved: () => Promise.resolve(() => {}),
  }),
}));
const paneProps = new Map<string, { hostPinned?: boolean }>();
vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; hostPinned?: boolean }) => {
    paneProps.set(props.tab.key, props);
    return <div />;
  },
}));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import { AttachedAgentPane } from "../../components/layout/AttachedAgentPane";
import { useProjectsStore } from "../../stores/projects";
import type { GroupNode, TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";

const agent: TabEntry = { key: "a", label: "Claude", kind: "agent", cmd: "claude", cwd: "/state/p" };
const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a"], activeKey: "a" };
const project = (pinned: boolean) =>
  ({
    id: "p",
    name: "P",
    local_file: "/state/p/project.json",
    directory: "/state/p",
    remote: { host: "h", user: "u", remote_path: "/r", ...(pinned ? { remote_only: true } : {}) },
  }) as unknown as ProjectEntry;

beforeEach(() => paneProps.clear());
afterEach(() => cleanup());

function popout(pinned: boolean) {
  render(
    <DetachedCenterPanel
      scope="p" popoutId="popout" tree={tree} tabs={[agent]}
      remoteInfo={{ project: project(pinned), primaryHost: "h" }}
      onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
      onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
      onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
    />,
  );
  return paneProps.get("a");
}

function attached(pinned: boolean) {
  useProjectsStore.setState({ projects: [project(pinned)] });
  render(<AttachedAgentPane scope="p" tab={agent} focused={false} scopeDir="/state/p" />);
  return paneProps.get("a");
}

describe("an agent tab of a host-pinned project, drawn attach-only", () => {
  it("is pinned to its host in a popout", () => {
    expect(popout(true)?.hostPinned).toBe(true);
  });

  it("is not pinned in a popout of a plain remote project", () => {
    expect(popout(false)?.hostPinned).toBeFalsy();
  });

  it("is pinned to its host in the cockpit's attached view", () => {
    expect(attached(true)?.hostPinned).toBe(true);
  });

  it("is not pinned in the attached view of a plain remote project", () => {
    expect(attached(false)?.hostPinned).toBeFalsy();
  });
});
