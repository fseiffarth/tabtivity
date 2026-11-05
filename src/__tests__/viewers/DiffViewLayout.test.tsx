/**
 * The diff viewer's layout: unified / split (remembered), the previous / next
 * change buttons and keys, the multi-file index with foldable files, and the
 * whole-file view folding long runs of unchanged lines.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) => sel({ settings: { viewer_prefs: {} } }),
}));

import { DiffView } from "../../components/embed/DiffView";
import { storageKey } from "../../lib/brand";

const PATCH = [
  "diff --git a/one.ts b/one.ts",
  "--- a/one.ts",
  "+++ b/one.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old one",
  "+new one",
  " tail",
  "@@ -20,2 +20,3 @@",
  " x",
  "+added late",
  " y",
  "diff --git a/old.ts b/new.ts",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
].join("\n");

let diskText = PATCH;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  diskText = PATCH;
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "read_file_text") return Promise.resolve(diskText);
    if (cmd === "file_mtime") return Promise.resolve(1000);
    return Promise.resolve(null);
  });
});

async function open(path = "/p/change.patch") {
  await act(async () => {
    render(<DiffView path={path} projectId={null} onOpenExternally={() => {}} />);
  });
  await screen.findByRole("navigation", { name: "Files in this diff" });
}

describe("DiffView layout", () => {
  it("lists the files with their counts and a rename arrow, and folds one", async () => {
    await open();
    const index = screen.getByRole("navigation", { name: "Files in this diff" });
    const rows = within(index).getAllByRole("button");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("one.ts");
    expect(rows[0].textContent).toContain("+2");
    expect(rows[0].textContent).toContain("−1");
    expect(rows[1].textContent).toContain("old.ts → new.ts");

    expect(document.querySelectorAll(".diff-file")).toHaveLength(2);
    const fold = screen.getAllByTitle("Collapse file")[0];
    fireEvent.click(fold);
    expect(document.querySelectorAll(".diff-file")[0].querySelector(".diff-hunk")).toBeNull();
    expect(screen.getAllByTitle("Expand file")).toHaveLength(1);
  });

  it("steps through the changes with the buttons and the keys, wrapping round", async () => {
    await open();
    const counter = () => document.querySelector(".diff-nav .file-viewer-find-count")?.textContent;
    expect(counter()).toBe("– / 3");
    fireEvent.click(screen.getByRole("button", { name: "Next change (N)" }));
    expect(counter()).toBe("1 / 3");
    const scroller = document.querySelector(".diff-viewer") as HTMLElement;
    fireEvent.keyDown(scroller, { key: "n" });
    expect(counter()).toBe("2 / 3");
    fireEvent.keyDown(scroller, { key: "F7" });
    expect(counter()).toBe("3 / 3");
    fireEvent.keyDown(scroller, { key: "F7" });
    expect(counter()).toBe("1 / 3");
    fireEvent.keyDown(scroller, { key: "p" });
    expect(counter()).toBe("3 / 3");
    fireEvent.keyDown(scroller, { key: "ArrowUp", altKey: true });
    expect(counter()).toBe("2 / 3");
    // The landed-on change is marked.
    expect(document.querySelectorAll('[data-current="true"]')).toHaveLength(1);
  });

  it("opens a collapsed file when a change in it is stepped to", async () => {
    await open();
    fireEvent.click(screen.getAllByTitle("Collapse file")[1]);
    expect(document.querySelectorAll(".diff-hunk")).toHaveLength(2);
    fireEvent.keyDown(document.querySelector(".diff-viewer") as HTMLElement, { key: "p" });
    await waitFor(() => expect(document.querySelectorAll(".diff-hunk")).toHaveLength(3));
  });

  it("shows unified by default, split on request, and remembers it", async () => {
    await open();
    expect(document.querySelector(".terminal-changes-split")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Diff layout" }));
    fireEvent.click(screen.getByText("Split view"));
    expect(document.querySelectorAll(".terminal-changes-split-row").length).toBeGreaterThan(0);
    expect(localStorage.getItem(storageKey("diffView.split"))).toBe("1");
  });

  it("starts split when it was left split", async () => {
    localStorage.setItem(storageKey("diffView.split"), "1");
    await open();
    expect(document.querySelector(".terminal-changes-split")).not.toBeNull();
    // A replacement pairs the old and the new line in one row.
    const row = Array.from(document.querySelectorAll(".terminal-changes-split-row")).find((r) =>
      r.textContent?.includes("old one"),
    );
    expect(row?.textContent).toContain("new one");
  });
});

describe("DiffView whole file", () => {
  it("folds long unchanged runs and expands one in place", async () => {
    const body = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
    const after = [...body];
    after[29] = "line 30 changed";
    diskText = after.join("\n") + "\n";
    const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -28,5 +28,5 @@", " line 28", " line 29", "-line 30", "+line 30 changed", " line 31", " line 32"].join("\n");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_text") return Promise.resolve(diskText);
      if (cmd === "file_mtime") return Promise.resolve(1000);
      if (cmd === "git_diff_file") return Promise.resolve(diff);
      return Promise.resolve(null);
    });
    await act(async () => {
      render(<DiffView path="/p/f.txt" projectId={null} onOpenExternally={() => {}} />);
    });
    const folds = await screen.findAllByRole("button", { name: /unchanged lines/ });
    expect(folds).toHaveLength(2);
    expect(folds[0].textContent).toBe("Show 25 unchanged lines");
    expect(screen.queryByText("line 1")).toBeNull();
    expect(screen.getByText("line 27")).toBeTruthy();
    expect(screen.getByText("line 30 changed", { exact: false })).toBeTruthy();

    fireEvent.click(folds[0]);
    expect(screen.getByText("line 1")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /unchanged lines/ })).toHaveLength(1);
    expect(document.querySelector(".diff-nav .file-viewer-find-count")?.textContent).toBe("1 / 1");
  });
});
