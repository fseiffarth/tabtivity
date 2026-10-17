/**
 * The popout's `agent-schedules-changed` listener must not outlive the effect
 * that started it. `listen` hands back its unlisten only once a promise
 * settles; a cleanup that ran first (unmount, or `tabs` changing) used to find
 * nothing to call, and the listener lived on for the window's lifetime.
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Pending = { resolve: (fn: () => void) => void };
const pending: Pending[] = [];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(false)) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string) => {
    if (event !== "agent-schedules-changed") return Promise.resolve(() => {});
    return new Promise<() => void>((resolve) => pending.push({ resolve }));
  }),
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
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import type { GroupNode, TabEntry } from "../../stores/tabs";

const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a"], activeKey: "a" };

function panel(tabs: TabEntry[]) {
  return (
    <DetachedCenterPanel
      scope="p" popoutId="popout" tree={tree} tabs={tabs}
      onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
      onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
      onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
    />
  );
}

afterEach(() => {
  cleanup();
  pending.length = 0;
});

describe("popout agent-schedules listener", () => {
  it("is dropped when the subscription settles after unmount", async () => {
    const tabs: TabEntry[] = [{ key: "a", label: "shell", kind: "shell", cmd: "bash", cwd: "/p" }];
    const { unmount } = render(panel(tabs));
    expect(pending).toHaveLength(1);
    unmount();
    const unlisten = vi.fn();
    await act(async () => {
      pending[0].resolve(unlisten);
      await Promise.resolve();
    });
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("drops the superseded subscription when the tabs change before it settles", async () => {
    const first: TabEntry[] = [{ key: "a", label: "shell", kind: "shell", cmd: "bash", cwd: "/p" }];
    const { rerender } = render(panel(first));
    rerender(panel([...first]));
    expect(pending).toHaveLength(2);
    const stale = vi.fn();
    const live = vi.fn();
    await act(async () => {
      pending[0].resolve(stale);
      pending[1].resolve(live);
      await Promise.resolve();
    });
    expect(stale).toHaveBeenCalledTimes(1);
    expect(live).not.toHaveBeenCalled();
  });
});
