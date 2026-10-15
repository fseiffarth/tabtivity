/**
 * The viewers moved onto `useDiskReloadPoll` (screen 2026-10-15, M7) that had
 * no reload test of their own still follow a write on disk: the read-only text
 * hook (`useReadonlyFile`: notebook, diff) and the ODT viewer. The editor
 * (`AutoReload`), image (`ImageAutoReload`), GIF (`GifView`) and PDF
 * (`PdfReloadSettle`) viewers keep their own tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: { viewer_prefs: {} } }),
}));
// The ODT parsers are tested on their own (`odt.test.ts`); here the document
// is just the bytes' first value, so a re-read shows up as new text.
vi.mock("../../lib/viewers/odtArchive", () => ({
  unzipOdt: (bytes: Uint8Array) => ({ version: bytes[0] }),
}));
vi.mock("../../lib/viewers/odt", () => ({
  extractOdt: (entries: { version: number }) => ({ contentXml: String(entries.version), images: {} }),
  renderOdtDocument: (xml: string) => `<p>version ${xml}</p>`,
}));

import { useReadonlyFile } from "../../components/embed/FileViewerPane";
import { OdtView } from "../../components/embed/OdtView";

let diskText = "v1";
let diskVersion = 1;
let diskMtime = 1000;
const reads = (cmd: string) => mockInvoke.mock.calls.filter((c) => c[0] === cmd).length;

warmFileViewer();

beforeEach(() => {
  vi.clearAllMocks();
  diskText = "v1";
  diskVersion = 1;
  diskMtime = 1000;
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(diskText);
    if (cmd === "read_file_bytes") return Promise.resolve(new Uint8Array([diskVersion]).buffer);
    if (cmd === "file_mtime") return Promise.resolve(diskMtime);
    return Promise.resolve(null);
  });
});

describe("viewers on useDiskReloadPoll", () => {
  it("useReadonlyFile re-reads the text when the file changes on disk", async () => {
    const { result, unmount } = renderHook(() => useReadonlyFile("/p/nb.ipynb"));
    await waitFor(() => expect(result.current.content).toBe("v1"));

    diskText = "v2";
    diskMtime = 2000;
    await waitFor(() => expect(result.current.content).toBe("v2"), { timeout: 12000 });
    expect(reads("read_file_text")).toBe(2);
    unmount();
  });

  it("the ODT viewer re-renders when the document changes on disk", async () => {
    await act(async () => {
      render(<OdtView path="/p/doc.odt" onOpenExternally={() => {}} />);
    });
    await screen.findByText("version 1");

    diskVersion = 2;
    diskMtime = 2000;
    await screen.findByText("version 2", undefined, { timeout: 12000 });
    expect(reads("read_file_bytes")).toBe(2);

    // An unchanged file is not read again.
    await new Promise((r) => setTimeout(r, 1800));
    expect(reads("read_file_bytes")).toBe(2);
  });
});
