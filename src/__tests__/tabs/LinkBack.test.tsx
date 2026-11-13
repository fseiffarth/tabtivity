/**
 * Back from a file tab an agent's file link opened (`openPathLink({ fromTab })`
 * → `stores/linkBack` → `LinkBackButton`): it shows the agent tab again and
 * closes the file tab the link opened (Shift+click keeps it); a file tab that
 * was open before the click is only left.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({})) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { linkBackKey, useLinkBackStore } from "../../stores/linkBack";
import { openPathLink } from "../../lib/terminal/pathLinks";
import { openFileEntry } from "../../lib/files/openFileEntry";
import { LinkBackButton } from "../../components/tabs/LinkBackButton";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const md: FileEntry = { name: "plan.md", path: "/p1/plan.md", is_dir: false, size: 1, extension: ".md", mime: null };
const t = (key: string) => key;

const tabs = (): TabEntry[] => useTabsStore.getState().tabs;
const fileTab = () => tabs().find((tab) => tab.embedPath === md.path);
let agentKey = "";

const follow = (newSubwindow = false) =>
  openPathLink(md, {}, { scope: "p1", projectId: "p1", projectDir: "/p1", cwd: "/p1", t, newSubwindow, fromTab: agentKey });

beforeEach(() => {
  useLinkBackStore.setState({ byTab: {} });
  useTabsStore.setState({
    scope: "p1",
    tabs: [],
    layout: null,
    focusedGroupId: null,
    tabsByScope: { p1: [] },
    layoutByScope: { p1: null },
    focusedGroupByScope: { p1: null },
  });
  agentKey = useTabsStore.getState().addTab({ label: "Claude", cmd: "claude", cwd: "/p1", kind: "agent" }).key;
});

describe("Back from a file an agent's link opened", () => {
  it("returns to the agent tab and closes the file tab", () => {
    follow();
    const file = fileTab()!;
    expect(useTabsStore.getState().activeKey).toBe(file.key);
    render(<LinkBackButton scope="p1" tabKey={file.key} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Claude/ }));
    expect(fileTab()).toBeUndefined();
    expect(useTabsStore.getState().activeKey).toBe(agentKey);
    expect(useLinkBackStore.getState().byTab).toEqual({});
  });

  it("keeps the file tab open on Shift+click", () => {
    follow();
    const file = fileTab()!;
    render(<LinkBackButton scope="p1" tabKey={file.key} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Claude/ }), { shiftKey: true });
    expect(fileTab()).toBeDefined();
    expect(useTabsStore.getState().activeKey).toBe(agentKey);
  });

  it("works for a file opened in a new subwindow", () => {
    follow(true);
    const file = fileTab()!;
    render(<LinkBackButton scope="p1" tabKey={file.key} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Claude/ }));
    expect(fileTab()).toBeUndefined();
    expect(useTabsStore.getState().activeKey).toBe(agentKey);
  });

  it("never closes a file tab that was already open", () => {
    openFileEntry({ entry: md, projectDir: "/p1", projectId: "p1", origin: "test", external: false });
    follow();
    const file = fileTab()!;
    expect(useLinkBackStore.getState().byTab[linkBackKey("p1", file.key)]).toEqual({ from: agentKey, close: false });
    render(<LinkBackButton scope="p1" tabKey={file.key} />);
    fireEvent.click(screen.getByRole("button", { name: /Back to Claude/ }));
    expect(fileTab()).toBeDefined();
    expect(useTabsStore.getState().activeKey).toBe(agentKey);
  });

  it("is not drawn once the agent tab is gone", () => {
    follow();
    const file = fileTab()!;
    useTabsStore.getState().removeTab(agentKey);
    const { container } = render(<LinkBackButton scope="p1" tabKey={file.key} />);
    expect(container.querySelector(".link-back-btn")).toBeNull();
  });

  it("gives no Back without the agent tab it came from", () => {
    openPathLink(md, {}, { scope: "p1", projectId: "p1", projectDir: "/p1", cwd: "/p1", t });
    expect(useLinkBackStore.getState().byTab).toEqual({});
  });
});
