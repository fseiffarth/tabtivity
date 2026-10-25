/**
 * Gap 46: mirror files a push left alone (a link, a special file, one over the
 * cap) are named in a per-project notice instead of a log line. Nothing renders
 * when nothing was skipped; a push's result and the `auto-sync` event feed it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import { SyncMirrorSkips } from "../../components/files/SyncMirrorSkips";
import { useSyncStore, type SyncMirrorSkips as Skips } from "../../stores/remote/sync";

const MIB = 1024 * 1024;
const skips: Skips = {
  total: 3,
  items: [
    { rel: "keys/id", kind: "link", size: null },
    { rel: "run/pipe", kind: "special", size: null },
    { rel: "data/big.bin", kind: "tooLarge", size: 70 * MIB },
  ],
};

describe("SyncMirrorSkips", () => {
  beforeEach(() => useSyncStore.setState({ skippedUnsafeByProject: {} }));

  it("renders nothing without a notice", () => {
    const { container } = render(<SyncMirrorSkips projectId="p1" />);
    expect(container.textContent).toBe("");
  });

  it("names the count and each file with its reason, and can be dismissed", () => {
    useSyncStore.setState({ skippedUnsafeByProject: { p1: skips } });
    render(<SyncMirrorSkips projectId="p1" />);
    expect(screen.getByText(/3 file\(s\) in the local mirror were not pushed/)).toBeTruthy();
    const list = document.querySelector(".error-note-raw")!;
    expect(list.textContent).toContain("keys/id (a link, or behind one)");
    expect(list.textContent).toContain("run/pipe (not a regular file)");
    expect(list.textContent).toContain("data/big.bin (over 64 MiB (70.0 MB))");
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector(".error-note-raw")).toBeNull();
  });

  it("is per project, and a push result fills it", async () => {
    vi.mocked(invoke).mockResolvedValue({ pushed: 0, conflicts: [], skipped_unsafe: skips } as never);
    await act(async () => {
      await useSyncStore.getState().push("p1", "");
    });
    expect(useSyncStore.getState().skippedUnsafeByProject["p1"]).toEqual(skips);
    const { container } = render(<SyncMirrorSkips projectId="p2" />);
    expect(container.textContent).toBe("");
  });
});
