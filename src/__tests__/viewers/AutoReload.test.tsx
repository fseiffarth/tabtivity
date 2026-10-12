/**
 * Tests for diff-aware auto-reload (#43): the text viewer polls `file_mtime` and,
 * when the file changes on disk, silently re-reads a CLEAN buffer but shows a
 * non-destructive banner over a DIRTY buffer (never clobbering edits).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { autosave: false, viewer_prefs: {} } }),
}));

const V1 = "first version\n";
const V2 = "changed on disk\n";

// Mutable disk state the mock serves.
let diskText = V1;
let diskMtime = 1000;

function setup() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(diskText);
    if (cmd === "file_mtime") return Promise.resolve(diskMtime);
    if (cmd === "write_file_text") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

async function renderTextView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/notes.txt" projectId="proj" />);
  });
}

warmFileViewer();

describe("diff-aware auto-reload (#43)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diskText = V1;
    diskMtime = 1000;
    setup();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("silently reloads a clean buffer when the file changes on disk", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(V1));

    // External change: new content + advanced mtime.
    diskText = V2;
    diskMtime = 2000;

    // Let the poll fire and the re-read resolve.
    await waitFor(
      () => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(V2),
      { timeout: 12000 },
    );
    // No reconcile banner for a clean reload.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a non-destructive banner (does NOT clobber) when the buffer is dirty", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(V1));

    // Make the buffer dirty with un-saved edits.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "my unsaved work" } });
    });

    // External change on disk.
    diskText = V2;
    diskMtime = 2000;

    // A banner appears; the dirty buffer is preserved (not overwritten).
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy(), { timeout: 12000 });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("my unsaved work");
    expect(screen.getByRole("button", { name: /reload/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /keep mine/i })).toBeTruthy();
  });
});
