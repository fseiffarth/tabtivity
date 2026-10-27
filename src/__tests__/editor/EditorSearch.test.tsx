/**
 * Tests for in-editor search (#67): the pure match/decoration helpers, plus the
 * find bar wired into the code editor (Ctrl+F opens it from anywhere in the pane,
 * a live match count, Enter cycles, the case toggle, and the highlight overlay).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ settings: { autosave: false, viewer_prefs: {} } }),
    { getState: () => ({ settings: { viewer_prefs: {} } }) },
  ),
}));

import {
  findMatches,
  decorateSearchRanges,
  applyReplacements,
} from "../../components/embed/fileViewer/decorations";

warmFileViewer();

describe("findMatches (#67)", () => {
  it("finds non-overlapping occurrences, case-insensitive by default", () => {
    expect(findMatches("Hello hello HELLO", "hello", false)).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("respects case sensitivity", () => {
    expect(findMatches("Hello hello", "hello", true)).toEqual([{ start: 6, end: 11 }]);
  });

  it("does not overlap matches (aa in aaa is one match)", () => {
    expect(findMatches("aaa", "aa", false)).toEqual([{ start: 0, end: 2 }]);
  });

  it("returns no matches for an empty query", () => {
    expect(findMatches("anything", "", false)).toEqual([]);
  });
});

describe("decorateSearchRanges (#67)", () => {
  it("wraps matches, marking the current one, and escapes the source", () => {
    const html = decorateSearchRanges(
      "a<b ab",
      [
        { start: 0, end: 1 },
        { start: 4, end: 6 },
      ],
      1,
    );
    expect(html).toBe(
      '<span class="file-viewer-search-match">a</span>&lt;b ' +
        '<span class="file-viewer-search-match current">ab</span>',
    );
  });

  it("returns the escaped source unchanged with no matches", () => {
    expect(decorateSearchRanges("x<y", [], 0)).toBe("x&lt;y");
  });
});

describe("applyReplacements (#67 find-and-replace)", () => {
  it("replaces every supplied range with the replacement (left-to-right)", () => {
    const matches = findMatches("Hello hello HELLO", "hello", false);
    expect(applyReplacements("Hello hello HELLO", matches, "hi")).toBe("hi hi hi");
  });

  it("replaces a single range, leaving the rest untouched", () => {
    expect(applyReplacements("foo foo foo", [{ start: 4, end: 7 }], "bar")).toBe(
      "foo bar foo",
    );
  });

  it("supports an empty replacement (deletion) and an empty range set", () => {
    expect(applyReplacements("a-b-c", [{ start: 1, end: 2 }], "")).toBe("ab-c");
    expect(applyReplacements("unchanged", [], "x")).toBe("unchanged");
  });

  it("skips overlapping/empty ranges", () => {
    expect(
      applyReplacements("abcd", [
        { start: 0, end: 2 },
        { start: 1, end: 3 }, // overlaps the consumed [0,2)
        { start: 3, end: 3 }, // empty
      ], "X"),
    ).toBe("Xcd");
  });
});

const TEXT = "Hello world\nhello again\nfoo\n";

async function renderTextView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/notes.txt" projectId="proj" />);
  });
}

describe("editor find bar (#67)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_text") return Promise.resolve(TEXT);
      if (cmd === "file_mtime") return Promise.resolve(1000);
      return Promise.resolve(null);
    });
  });

  it("opens on Ctrl+F from the editor and highlights matches with a count", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEXT));

    // The bar is closed initially.
    expect(screen.queryByLabelText("Find")).toBeNull();

    // Ctrl+F bubbles from the textarea to the container handler and opens it.
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
    });
    const input = (await screen.findByLabelText("Find")) as HTMLInputElement;

    // Type a query: two case-insensitive matches, count shows the first selected.
    await act(async () => {
      fireEvent.change(input, { target: { value: "hello" } });
    });
    await waitFor(() =>
      expect(document.querySelectorAll(".file-viewer-search-match").length).toBe(2),
    );
    expect(document.querySelectorAll(".file-viewer-search-match.current").length).toBe(1);
    expect(screen.getByText("1/2")).toBeTruthy();

    // Enter advances to the next match.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(screen.getByText("2/2")).toBeTruthy();
  });

  it("the case toggle restricts matches and Esc closes the bar", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEXT));

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "f", ctrlKey: true });
    });
    const input = (await screen.findByLabelText("Find")) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { value: "Hello" } });
    });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());

    // Enabling "Match case" leaves only the capitalised occurrence.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Match case"));
    });
    await waitFor(() => expect(screen.getByText("1/1")).toBeTruthy());

    // Esc closes the bar.
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByLabelText("Find")).toBeNull());
  });

  it("Ctrl+R opens find-and-replace and Replace All rewrites every match", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEXT));

    // The replace input is hidden until Ctrl+R opens the bar in replace mode.
    expect(screen.queryByLabelText("Replace with")).toBeNull();
    await act(async () => {
      fireEvent.keyDown(textarea, { key: "r", ctrlKey: true });
    });
    const find = (await screen.findByLabelText("Find")) as HTMLInputElement;
    const replace = (await screen.findByLabelText("Replace with")) as HTMLInputElement;

    await act(async () => {
      fireEvent.change(find, { target: { value: "hello" } }); // 2 matches (case-insensitive)
    });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());

    await act(async () => {
      fireEvent.change(replace, { target: { value: "hi" } });
    });
    // Replace All rewrites both occurrences in the editor buffer.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Replace all"));
    });
    await waitFor(() =>
      expect((document.querySelector(".file-viewer-code-editor") as HTMLTextAreaElement).value).toBe(
        "hi world\nhi again\nfoo\n",
      ),
    );
  });

  it("Enter in the replace field replaces the current match only", async () => {
    await renderTextView();
    const textarea = (await screen.findByRole("textbox")) as HTMLTextAreaElement;
    await waitFor(() => expect(textarea.value).toBe(TEXT));

    await act(async () => {
      fireEvent.keyDown(textarea, { key: "r", ctrlKey: true });
    });
    const find = (await screen.findByLabelText("Find")) as HTMLInputElement;
    const replace = (await screen.findByLabelText("Replace with")) as HTMLInputElement;

    await act(async () => {
      fireEvent.change(find, { target: { value: "hello" } });
      fireEvent.change(replace, { target: { value: "hi" } });
    });
    await waitFor(() => expect(screen.getByText("1/2")).toBeTruthy());

    // Enter replaces just the first match; the second "hello" survives.
    await act(async () => {
      fireEvent.keyDown(replace, { key: "Enter" });
    });
    await waitFor(() =>
      expect((document.querySelector(".file-viewer-code-editor") as HTMLTextAreaElement).value).toBe(
        "hi world\nhello again\nfoo\n",
      ),
    );
  });
});
