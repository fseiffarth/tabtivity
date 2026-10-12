/**
 * The file tree with many rows on screen (performance plan §5.1): each row is
 * a memoised `FileRow` fed primitives and the tree's two stable objects, so a
 * hover dwell (tooltip state on the tree) re-renders no row, and a change to
 * one row's state (its selection) re-renders that row alone — the "show more"
 * regime used to rebuild every row on each of those.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
  emit: vi.fn(() => Promise.resolve()),
}));

// Rendered once per `FileRow` render and nowhere else in the listing; every
// entry below has its own extension, so the per-ext count is the row's.
const renders = new Map<string, number>();
vi.mock("../../components/common/icons/FileIcon", () => ({
  FileIcon: ({ ext }: { ext: string | null }) => {
    renders.set(ext ?? "", (renders.get(ext ?? "") ?? 0) + 1);
    return null;
  },
}));

import { FileTree } from "../../components/files/FileTree";
import { clearFileViewSnapshots } from "../../lib/projects/fileViewSnapshots";

const N = 300;
const entries = Array.from({ length: N }, (_, i) => ({
  name: `file-${i}.x${i}`,
  path: `/p/p1/file-${i}.x${i}`,
  is_dir: false,
  size: 10 + i,
  extension: `.x${i}`,
  mime: null,
}));

const total = () => [...renders.values()].reduce((a, b) => a + b, 0);

beforeEach(() => {
  cleanup();
  renders.clear();
  localStorage.clear();
  clearFileViewSnapshots();
  vi.useFakeTimers();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "list_dir") return Promise.resolve(entries);
    if (cmd === "git_file_statuses") return Promise.resolve({});
    if (cmd === "list_project_endings") return Promise.resolve([]);
    if (cmd === "list_project_paths") return Promise.resolve([]);
    return Promise.resolve(null);
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function mountAll() {
  const utils = render(
    <FileTree
      projectDir="/p/p1"
      projectId="p1"
      sortKey="name"
      descending={false}
      hiddenEndings={[]}
      hiddenPaths={[]}
      shownPaths={[]}
      initialRelPath=""
      onRelPathChange={() => {}}
      active
    />,
  );
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  // The listing is capped to a page; reveal the rest the way the user does.
  for (let more = document.querySelector<HTMLButtonElement>(".file-tree-more"); more; ) {
    await act(async () => {
      fireEvent.click(more!);
      await vi.runAllTimersAsync();
    });
    more = document.querySelector<HTMLButtonElement>(".file-tree-more");
  }
  expect(document.querySelectorAll(".file-entry").length).toBe(N);
  return utils;
}

describe("file tree row memoisation (300 rows)", () => {
  it("re-renders no row when a hover dwell opens the tooltip", async () => {
    await mountAll();
    const before = total();
    const row = document.querySelectorAll<HTMLElement>(".file-entry")[150];
    await act(async () => {
      fireEvent.mouseEnter(row);
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.querySelector(".file-tooltip")).toBeTruthy();
    expect(total()).toBe(before);
    await act(async () => {
      fireEvent.mouseLeave(row);
    });
    expect(total()).toBe(before);
  });

  it("re-renders one row when one row's selection changes", async () => {
    await mountAll();
    const before = new Map(renders);
    const rows = document.querySelectorAll<HTMLElement>(".file-entry");
    await act(async () => {
      fireEvent.click(rows[42]);
    });
    expect(rows[42].className).toContain("selected");
    const clicked = entries.find((e) => e.path === rows[42].dataset.entryPath)!;
    for (const e of entries) {
      expect(renders.get(e.extension), e.name).toBe(
        (before.get(e.extension) ?? 0) + (e === clicked ? 1 : 0),
      );
    }
  });
});
