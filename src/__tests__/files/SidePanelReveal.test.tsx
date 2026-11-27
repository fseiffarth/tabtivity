/**
 * An agent tab's Ctrl+click on a path link shows the path in the side panel's
 * file tree (`stores/sidePanelReveal`): who may ask (`sidePanelRevealOf`), and
 * the side panel's tree taking the request — a file made after the folder's
 * last listing included.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

import { FileTree } from "../../components/files/FileTree";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";
import { revealInSidePanel, sidePanelRevealOf } from "../../lib/terminal/pathLinks";
import { REVEAL_TTL_MS, useSidePanelRevealStore } from "../../stores/sidePanelReveal";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useReaderSideChatStore } from "../../stores/agents/readerSideChat";
import { installDetachedWindowContext } from "../../stores/detachedContext";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const file = (path: string, isDir = false): FileEntry => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return { name, path, is_dir: isDir, size: 1, extension: !isDir && dot > 0 ? name.slice(dot) : null, mime: null };
};

const ctx = { scope: "p", projectId: "p", projectDir: "/p" };

beforeEach(() => {
  cleanup();
  localStorage.clear();
  clearFileViewSnapshots();
  useSidePanelRevealStore.setState({ pending: null });
  useProjectsStore.setState({ activeId: "p" });
  useTabsStore.setState({ scope: "p" });
  useReaderSideChatStore.setState({ claims: [], slot: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("who may show a link in the side panel", () => {
  it("a tab of the project the panel shows, for a path inside the project", () => {
    expect(sidePanelRevealOf(file("/p/docs/a.md"), ctx)).toBe("docs/a.md");
    expect(sidePanelRevealOf(file("/p/docs", true), ctx)).toBe("docs");
    expect(sidePanelRevealOf(file("/elsewhere/a.md"), ctx)).toBeNull();
  });

  it("not a root tab, a box, another project, a covered panel or a popout", () => {
    expect(sidePanelRevealOf(file("/p/a.md"), { scope: "root", projectId: null, projectDir: "" })).toBeNull();
    expect(sidePanelRevealOf(file("/p/a.md"), { ...ctx, scope: "box:b" })).toBeNull();
    useProjectsStore.setState({ activeId: "q" });
    expect(sidePanelRevealOf(file("/p/a.md"), ctx)).toBeNull();
    useProjectsStore.setState({ activeId: "p" });
    useReaderSideChatStore.setState({ claims: [{ ptyId: "p:t", label: "T", showChat: () => {} }] });
    expect(sidePanelRevealOf(file("/p/a.md"), ctx)).toBeNull();
    useReaderSideChatStore.setState({ claims: [] });
    const undo = installDetachedWindowContext({} as never);
    expect(sidePanelRevealOf(file("/p/a.md"), ctx)).toBeNull();
    undo();
  });

  it("asks the shell for the Files view", () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("app:reveal-side-panel", on);
    expect(revealInSidePanel(file("/p/docs/a.md"), ctx)).toBe(true);
    window.removeEventListener("app:reveal-side-panel", on);
    expect(seen).toEqual([{ view: "files" }]);
    expect(useSidePanelRevealStore.getState().pending).toMatchObject({ projectId: "p", rel: "docs/a.md", isDir: false });
  });

  it("drops a request no tree took in time", () => {
    vi.useFakeTimers();
    useSidePanelRevealStore.getState().request("p", "a.md", false);
    vi.advanceTimersByTime(REVEAL_TTL_MS + 1);
    expect(useSidePanelRevealStore.getState().take("p")).toBeNull();
  });
});

describe("the side panel's tree", () => {
  let docs: FileEntry[];
  beforeEach(() => {
    vi.useFakeTimers();
    docs = [file("/p/docs/old.md")];
    mockInvoke.mockImplementation((cmd: string, args?: { relPath?: string }) => {
      if (cmd === "list_dir") return Promise.resolve(args?.relPath === "docs" ? docs : [file("/p/docs", true)]);
      if (cmd === "git_file_statuses") return Promise.resolve({});
      return Promise.resolve(null);
    });
  });

  const mount = (takeReveals: boolean, refreshNonce = 0) => (
    <FileTree
      projectDir="/p"
      projectId="p"
      hiddenEndings={[]}
      hiddenPaths={[]}
      shownPaths={[]}
      initialRelPath=""
      active
      takeReveals={takeReveals}
      refreshNonce={refreshNonce}
    />
  );
  const settle = () => act(async () => { await vi.runAllTimersAsync(); });
  const row = (path: string) => document.querySelector(`[data-entry-path="${path}"]`);

  it("lists the file's folder and selects it", async () => {
    render(mount(true));
    await settle();
    act(() => useSidePanelRevealStore.getState().request("p", "docs/old.md", false));
    // Short of the give-up timer: running every timer would fire it first.
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(row("/p/docs/old.md")?.classList.contains("selected")).toBe(true);
    expect(useSidePanelRevealStore.getState().pending).toBeNull();
  });

  it("waits for a file the folder's listing did not hold yet", async () => {
    const view = render(mount(true));
    await settle();
    act(() => useSidePanelRevealStore.getState().request("p", "docs/new.md", false));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(row("/p/docs/new.md")).toBeNull();
    docs = [file("/p/docs/old.md"), file("/p/docs/new.md")];
    view.rerender(mount(true, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(row("/p/docs/new.md")?.classList.contains("selected")).toBe(true);
  });

  it("leaves a request alone when it is not the side panel's", async () => {
    render(mount(false));
    await settle();
    act(() => useSidePanelRevealStore.getState().request("p", "docs/old.md", false));
    await settle();
    expect(row("/p/docs/old.md")).toBeNull();
    expect(useSidePanelRevealStore.getState().pending).not.toBeNull();
  });
});
