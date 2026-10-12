/**
 * Tests for image-viewer auto-reload (#68): the image viewer polls `file_mtime`
 * and re-reads the bytes when the file changes on disk, so an image regenerated
 * by an external tool refreshes in place (no manual reopen).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, act, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { viewer_prefs: {} } }),
}));

// Mutable disk state the mock serves.
let diskMtime = 1000;

function countReadBytes() {
  return mockInvoke.mock.calls.filter((c) => c[0] === "read_file_bytes").length;
}

async function renderImageView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="image" path="/p/fig.png" projectId="proj" />);
  });
}

warmFileViewer();

describe("image auto-reload (#68)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diskMtime = 1000;
    // jsdom has no object-URL plumbing; stub it for the blob the viewer creates.
    let n = 0;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock-${n++}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_bytes") return Promise.resolve([1, 2, 3]);
      if (cmd === "file_mtime") return Promise.resolve(diskMtime);
      return Promise.resolve(null);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads the bytes when the file's mtime advances on disk", async () => {
    await renderImageView();
    await waitFor(() => expect(countReadBytes()).toBe(1));

    // External change: a newer mtime should trigger exactly one more read.
    diskMtime = 2000;
    await waitFor(() => expect(countReadBytes()).toBe(2), { timeout: 12000 });

    // A second poll with no further change must not re-read again.
    await new Promise((r) => setTimeout(r, 1800));
    expect(countReadBytes()).toBe(2);
  });

  it("does not re-read while the file is unchanged", async () => {
    await renderImageView();
    await waitFor(() => expect(countReadBytes()).toBe(1));
    await new Promise((r) => setTimeout(r, 1800));
    expect(countReadBytes()).toBe(1);
  });
});
