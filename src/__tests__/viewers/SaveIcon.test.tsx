/**
 * Tests for the icon save control (#47): the plain-text viewer's Save button is
 * icon-only with aria-label="Save", disabled when clean, and reflects the dirty
 * state once the buffer diverges from disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
// Settings store: autosave OFF, no viewer prefs (so nothing auto-saves mid-test).
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { autosave: false, viewer_prefs: {} } }),
}));

const SOURCE = "hello\nworld\n";

function setup() {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(SOURCE);
    if (cmd === "file_mtime") return Promise.resolve(1000);
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

describe("SaveButton icon (#47)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup();
  });

  it("is an aria-labelled Save control, disabled while the buffer is clean", async () => {
    await renderTextView();
    const save = await screen.findByRole("button", { name: "Save" });
    const print = screen.getByRole("button", { name: "Print" });
    // No textual Save/Saved label — it's icon-only.
    expect(save.textContent).not.toMatch(/saved/i);
    expect(save.querySelector("svg")).not.toBeNull();
    // File actions have one stable reading order in every editable viewer.
    expect(save.compareDocumentPosition(print) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
    );
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables and marks dirty once the buffer diverges from disk", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(SOURCE));
    await act(async () => {
      fireEvent.change(textarea, { target: { value: SOURCE + "x" } });
    });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(save.className).toContain("is-dirty");
  });
});
