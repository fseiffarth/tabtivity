/**
 * A popout whose scope is a box wears `▣ <box name>` in the box's colour in its
 * title bar, before the window's own name. The box record comes from the
 * popout's one-time seed (`remoteInfo.box`); any other scope shows no mark.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import type { GroupNode, TabEntry } from "../../stores/tabs";
import type { ProjectBox } from "../../types";

const tabs: TabEntry[] = [{ key: "a", label: "Claude", kind: "agent", cmd: "claude", cwd: "/p" }];
const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a"], activeKey: "a" };
const thesis: ProjectBox = { id: "b1", name: "Thesis", member_ids: [], position: 1, color: "#ff0000" };

afterEach(cleanup);

function mount(scope: string, box: ProjectBox | undefined, windowName?: string) {
  return render(
    <DetachedCenterPanel
      scope={scope} popoutId="popout" tree={tree} tabs={tabs}
      remoteInfo={box ? ({ box, boxMembers: [] } as never) : undefined}
      windowName={windowName}
      onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
      onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
      onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
      onRename={vi.fn()} onSetStack={vi.fn()}
    />,
  ).container;
}

describe("popout title bar box mark", () => {
  it("shows the box swatch and name in the box colour, before the window's own name", () => {
    const container = mount("box:b1", thesis, "Writing");
    const mark = container.querySelector(".detached-titlebar .detached-titlebar-box") as HTMLElement;
    expect(mark).toBeTruthy();
    expect(mark.querySelector(".detached-titlebar-box-name")?.textContent).toBe("Thesis");
    expect((mark.querySelector("svg.box-swatch") as SVGElement).style.color).toBe("rgb(255, 0, 0)");
    expect(mark.style.getPropertyValue("--box-mark")).toBe("#ff0000");
    const name = container.querySelector(".detached-titlebar-name") as HTMLElement;
    expect(name.textContent).toBe("Writing");
    // Mark first, then the name.
    expect(mark.compareDocumentPosition(name) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no mark for a project scope, even when the seed carries a box", () => {
    expect(mount("p1", thesis).querySelector(".detached-titlebar-box")).toBeNull();
  });

  it("shows no mark for a box scope without a seeded record", () => {
    expect(mount("box:b1", undefined).querySelector(".detached-titlebar-box")).toBeNull();
  });
});
