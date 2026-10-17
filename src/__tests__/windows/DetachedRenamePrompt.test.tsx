/**
 * The popout's tab menu renames in the app's own prompt — the main window's
 * `TabBar` question — not `window.prompt`, which WebKitGTK draws as a bare
 * origin-titled box. The dialog is mounted in the popout's own tree, so it
 * lands in the popout's document.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
vi.mock("../../components/tabs/TabPane", () => ({ TabPane: () => <div /> }));
vi.mock("../../components/header/WindowControls", () => ({ WindowControls: () => null }));

import { DetachedCenterPanel } from "../../components/layout/DetachedCenterPanel";
import type { GroupNode, TabEntry } from "../../stores/tabs";
import { translate } from "../../lib/i18n";

const tabs: TabEntry[] = [{ key: "a", label: "Claude", kind: "agent", cmd: "claude", cwd: "/p" }];
const tree: GroupNode = { type: "group", id: "g", tabKeys: ["a"], activeKey: "a" };

beforeEach(() => {
  vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("window.prompt must not be used"); });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount() {
  const onRename = vi.fn();
  const onSetStack = vi.fn();
  const { container } = render(
    <DetachedCenterPanel
      scope="p" popoutId="popout" tree={tree} tabs={tabs}
      onSplit={vi.fn()} onMove={vi.fn()} onReorder={vi.fn()}
      onActivate={vi.fn()} onClose={vi.fn()} onSetLocation={vi.fn()}
      onResize={vi.fn()} onAddTab={vi.fn()} onFiles={vi.fn()}
      onRename={onRename} onSetStack={onSetStack}
    />,
  );
  fireEvent.contextMenu(container.querySelector(".tab") as HTMLElement, { clientX: 10, clientY: 10 });
  return { onRename, onSetStack };
}

describe("popout tab menu prompts", () => {
  it("renames a tab through the app's prompt, pre-filled with its label", async () => {
    const user = userEvent.setup();
    const { onRename } = mount();
    await user.click(screen.getByRole("button", { name: /Rename/ }));
    const asked = await screen.findByRole("dialog", { name: translate("en", "detachedTabs.renamePrompt") });
    const field = within(asked).getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe("Claude");
    await user.clear(field);
    await user.type(field, "Reviewer{Enter}");
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("a", "Reviewer"));
  });

  it("names a new tab group through the app's prompt", async () => {
    const user = userEvent.setup();
    const { onSetStack } = mount();
    await user.click(screen.getByRole("button", { name: new RegExp(translate("en", "tabStack.newGroup")) }));
    const asked = await screen.findByRole("dialog", { name: translate("en", "tabStack.newTitle") });
    await user.type(within(asked).getByRole("textbox"), "Docs{Enter}");
    await waitFor(() => expect(onSetStack).toHaveBeenCalledWith("a", "Docs"));
  });
});
