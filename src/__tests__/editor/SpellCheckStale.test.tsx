/**
 * The dictionary spell check runs a moment after the last keystroke. A check
 * that was still in flight when the draft changed (a newer check was armed)
 * must not land its issues over the newer answer.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke, mockListen } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockListen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mockListen, emit: vi.fn() }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/projects", () => {
  const state = { projects: [{ id: "proj", directory: "/p", local_file: "/p/project.json" }], activeId: "proj" };
  const useProjectsStore = Object.assign(
    (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state),
    { getState: () => state },
  );
  return { useProjectsStore };
});
vi.mock("../../stores/settings", () => {
  const state = () => ({
    settings: { autosave: false, viewer_prefs: { text: { spell_check: true } } },
  });
  return {
    useSettingsStore: Object.assign((sel: (s: unknown) => unknown) => sel(state()), { getState: state }),
  };
});

const SOURCE = "teh cat";
const ISSUE = { line: 1, bad: "teh", category: "spelling", message: "m", suggestion: "the" };

warmFileViewer();

describe("spell check responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListen.mockImplementation(() => Promise.resolve(() => {}));
  });

  it("drops a response whose check was superseded by a newer one", async () => {
    const pending: Array<(issues: unknown[]) => void> = [];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_text") return Promise.resolve(SOURCE);
      if (cmd === "file_mtime") return Promise.resolve(1000);
      if (cmd === "spell_check") return new Promise((resolve) => pending.push(resolve));
      return Promise.resolve(null);
    });
    vi.resetModules();
    const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
    await act(async () => {
      render(<FileViewerPane viewer="text" path="/p/foo.txt" projectId="proj" />);
    });
    const el = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(el.value).toBe(SOURCE));
    await waitFor(() => expect(pending).toHaveLength(1), { timeout: 4000 });

    // The user edits; a second check is armed and answers "nothing wrong".
    fireEvent.change(el, { target: { value: `${SOURCE}!` } });
    await waitFor(() => expect(pending).toHaveLength(2), { timeout: 4000 });
    await act(async () => {
      pending[1]([]);
    });

    // The first check lands late, with the older answer.
    await act(async () => {
      pending[0]([ISSUE]);
    });
    expect(document.querySelector(".file-viewer-grammar-mark")).toBeNull();
  });
});
