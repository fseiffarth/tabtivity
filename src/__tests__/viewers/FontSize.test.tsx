/**
 * Tests for the code-editor text-size control (#48):
 *  - the effective size drives the editor's --code-font-size / --code-line-height
 *    CSS variables (so the gutter and overlay layers scale together);
 *  - zoom is TAB-LOCAL: A+/A− (and Ctrl +/−) persist the new size on the tab's
 *    `viewerState.fontSize` — NOT the global per-type `viewer_prefs` — so zooming
 *    one tab never resizes other viewers of the same type, and the size survives
 *    a Tabtivity restart (re-seeded from the persisted viewerState);
 *  - until the tab is zoomed it tracks the per-type `viewer_prefs[type].font_size`
 *    default reactively.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { BRAND } from "../../lib/brand";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

// Settings-store mock exposing the per-type `viewer_prefs` defaults (selector +
// getState). `updateSettings` is spied so the tests can assert it is NOT touched
// by the per-tab zoom anymore.
const { mockUpdate, prefsRef } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  prefsRef: { current: {} as Record<string, { font_size?: number }> },
}));
vi.mock("../../stores/settings", () => {
  const state = () => ({
    settings: { autosave: false, viewer_prefs: prefsRef.current },
    updateSettings: mockUpdate,
  });
  const hook = (sel: (s: unknown) => unknown) => sel(state());
  (hook as unknown as { getState: typeof state }).getState = state;
  return { useSettingsStore: hook };
});

// Tabs-store mock backing the per-tab viewerState. `setViewerState` records the
// patch AND merges it into the tab so a re-render (a "restart") re-seeds the
// persisted size. Real exports (findGroupOfTab/getDetachedViewerState/…) are kept
// so the rest of FileViewerPane still resolves.
type Tab = { key: string; kind?: string; viewerState?: Record<string, unknown> };
const { mockSetViewerState, tabsRef } = vi.hoisted(() => ({
  mockSetViewerState: vi.fn(),
  tabsRef: { current: [] as Tab[] },
}));
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const state = () => ({
    tabs: tabsRef.current,
    setActive: vi.fn(),
    setViewerState: (key: string, patch: Record<string, unknown>) => {
      mockSetViewerState(key, patch);
      const t = tabsRef.current.find((x) => x.key === key);
      if (t) t.viewerState = { ...t.viewerState, ...patch };
    },
  });
  const hook = (sel?: (s: unknown) => unknown) => (sel ? sel(state()) : state());
  (hook as unknown as { getState: typeof state }).getState = state;
  return { ...actual, useTabsStore: hook };
});

const SOURCE = "hello\nworld\n";
const TAB_KEY = "t1";
let source = SOURCE;

function setup() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(source);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    return Promise.resolve(null);
  });
}

async function renderTextView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/notes.txt" projectId="proj" tabKey={TAB_KEY} />);
  });
}

async function renderMarkdownView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="markdown" path="/p/notes.md" projectId="proj" tabKey={TAB_KEY} />);
  });
}

describe("editor text-size control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prefsRef.current = {};
    tabsRef.current = [{ key: TAB_KEY, kind: "embed", viewerState: {} }];
    source = SOURCE;
    setup();
  });

  it("applies the persisted per-type font_size as the editor CSS variables", async () => {
    prefsRef.current = { text: { font_size: 16 } };
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    const code = document.querySelector(".file-viewer-code") as HTMLElement;
    expect(code.style.getPropertyValue("--code-font-size")).toBe("16px");
    // line-height tracks the font at 1.5x → 24px.
    expect(code.style.getPropertyValue("--code-line-height")).toBe("24px");
    // The level readout doubles as the reset button.
    expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("16");
  });

  it("persists a larger size on THIS tab (not global settings) when A+ is clicked", async () => {
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    });
    // Written to the tab's viewerState — not the global per-type viewer_prefs.
    expect(mockSetViewerState).toHaveBeenCalledWith(TAB_KEY, { fontSize: 13 });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("13");
  });

  it("shrinks on Ctrl+− from the editor and persists on the tab", async () => {
    tabsRef.current[0].viewerState = { fontSize: 14 };
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "-", ctrlKey: true });
    });
    expect(mockSetViewerState).toHaveBeenCalledWith(TAB_KEY, { fontSize: 13 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it(`restores the persisted tab size across a ${BRAND.display} restart`, async () => {
    // First session: zoom this tab up to 13, which persists on its viewerState.
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    });
    expect(tabsRef.current[0].viewerState).toMatchObject({ fontSize: 13 });
    // Restart: tear down this session, then remount. The tab (and its
    // viewerState) survives; the viewer re-seeds the size from it.
    cleanup();
    await renderTextView();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("13"),
    );
  });

  it("Reset clears the tab override, falling back to the per-type default", async () => {
    prefsRef.current = { text: { font_size: 20 } };
    tabsRef.current[0].viewerState = { fontSize: 10 };
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("10");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    });
    // Override cleared → falls back to the per-type default (20).
    expect(mockSetViewerState).toHaveBeenCalledWith(TAB_KEY, { fontSize: undefined });
    expect(screen.getByRole("button", { name: "Reset text size" }).textContent).toBe("20");
  });

  it("clamps at the minimum size", async () => {
    tabsRef.current[0].viewerState = { fontSize: 8 };
    await renderTextView();
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    const dec = screen.getByRole("button", { name: "Decrease text size" }) as HTMLButtonElement;
    expect(dec.disabled).toBe(true);
  });

  it("offers the control in the markdown viewer and persists on the tab", async () => {
    await renderMarkdownView();
    // The preview renders the markdown body; the size control sits in the header.
    await waitFor(() => expect(document.querySelector(".markdown-body")).not.toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Increase text size" }));
    });
    expect(mockSetViewerState).toHaveBeenCalledWith(TAB_KEY, { fontSize: 13 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("shows a resolved destination while hovering a Markdown link", async () => {
    source = "[guide](docs/guide.md)";
    await renderMarkdownView();
    const link = await screen.findByRole("link", { name: "guide" });
    fireEvent.mouseMove(link);
    expect((await screen.findByRole("tooltip")).textContent).toBe("/p/docs/guide.md");
  });

  it("copies a selection contained by the markdown preview on mouse release", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    await renderMarkdownView();
    const preview = await waitFor(() => {
      const el = document.querySelector(".markdown-body");
      expect(el).not.toBeNull();
      return el as HTMLDivElement;
    });
    const textNode = preview.querySelector("p")?.firstChild ?? null;
    expect(textNode).toBeTruthy();
    const selection: {
      anchorNode: Node | null;
      focusNode: Node | null;
      isCollapsed: boolean;
      toString: () => string;
    } = {
      anchorNode: textNode,
      focusNode: textNode,
      isCollapsed: false,
      toString: () => "hello",
    };
    const getSelection = vi.spyOn(window, "getSelection").mockReturnValue(
      selection as unknown as Selection,
    );

    fireEvent.mouseUp(preview);

    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(await screen.findByText("Copied to clipboard")).toBeTruthy();

    // A selection extending outside this preview belongs to broader window
    // interaction and must not overwrite the clipboard a second time.
    selection.focusNode = preview.parentElement;
    fireEvent.mouseUp(preview);
    expect(writeText).toHaveBeenCalledOnce();
    getSelection.mockRestore();
  });
});
