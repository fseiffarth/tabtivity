/**
 * `CenterPanel`'s root copy stands down while another view draws a root tab.
 * With no project open the panel shows the root scope itself, and the root
 * console and an app overlay's docked agent column (`OverlayAgentColumn`) are
 * attach-only views of the same panes — two visible views of one PTY would
 * take turns resizing it. The console hides the whole root scope here; a
 * docked column hides only the key it draws (`shownKeys`).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(undefined)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    scaleFactor: () => Promise.resolve(1),
    innerPosition: () => Promise.resolve({ toLogical: () => ({ x: 0, y: 0 }) }),
    onMoved: () => Promise.resolve(() => {}),
    onResized: () => Promise.resolve(() => {}),
    onFocusChanged: () => Promise.resolve(() => {}),
  }),
}));
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("../../components/tabs/TabPane", () => ({
  TabPane: (props: { tab: { key: string }; visible: boolean; focused: boolean }) => (
    <div
      data-testid={`pane-${props.tab.key}`}
      data-visible={String(props.visible)}
      data-focused={String(props.focused)}
    />
  ),
}));

import { CenterPanel } from "../../components/layout/CenterPanel";
import { ROOT_SCOPE, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useOverlayAgentStore } from "../../stores/overlayAgent";

let docked: TabEntry;
let other: TabEntry;

const visible = (key: string) =>
  document.querySelector(`[data-testid="pane-${key}"]`)?.getAttribute("data-visible");

beforeEach(() => {
  cleanup();
  localStorage.clear();
  // No project open: the panel's current scope is root. A root array that is
  // already present skips the first-visit hydrate.
  useProjectsStore.setState({ projects: [], activeId: null, rootDir: "/r" });
  useTabsStore.setState({
    scope: ROOT_SCOPE,
    tabsByScope: { [ROOT_SCOPE]: [] },
    layoutByScope: { [ROOT_SCOPE]: null },
    focusedGroupByScope: { [ROOT_SCOPE]: null },
    detachedGroupsByScope: {},
    fullscreenGroupId: null,
  });
  useTabsStore.getState().setScope(ROOT_SCOPE);
  const s = useTabsStore.getState();
  other = s.addTabToScope(ROOT_SCOPE, { label: "Shell", cmd: "bash", cwd: "", kind: "shell" });
  docked = s.addTabToScope(ROOT_SCOPE, { label: "Claude", cmd: "claude", cwd: "", kind: "agent" });
  // Two subwindows, each showing one of the tabs.
  const group = useTabsStore.getState().layoutByScope[ROOT_SCOPE];
  if (group?.type !== "group") throw new Error("expected one root group");
  useTabsStore.getState().splitWithTabInScope(ROOT_SCOPE, docked.key, group.id, "right");
  useRootOverlayStore.setState({ open: false, installTabs: {} });
  useOverlayAgentStore.setState({ shownKeys: new Set() });
});

describe("CenterPanel root stand-down", () => {
  it("shows both root tabs when nothing else draws them", async () => {
    render(<CenterPanel />);
    await act(async () => {});
    expect(visible(other.key)).toBe("true");
    expect(visible(docked.key)).toBe("true");
  });

  it("hides the whole root scope while the root console is open", async () => {
    render(<CenterPanel />);
    await act(async () => {
      useRootOverlayStore.setState({ open: true });
    });
    expect(visible(other.key)).toBe("false");
    expect(visible(docked.key)).toBe("false");
  });

  it("hides only the key a docked column draws, and shows it again on unmark", async () => {
    render(<CenterPanel />);
    await act(async () => {
      useOverlayAgentStore.getState().markShown(docked.key);
    });
    expect(visible(docked.key)).toBe("false");
    expect(document.querySelector(`[data-testid="pane-${docked.key}"]`)?.getAttribute("data-focused")).toBe(
      "false",
    );
    expect(visible(other.key)).toBe("true");

    await act(async () => {
      useOverlayAgentStore.getState().unmarkShown(docked.key);
    });
    expect(visible(docked.key)).toBe("true");
    expect(visible(other.key)).toBe("true");
  });
});
