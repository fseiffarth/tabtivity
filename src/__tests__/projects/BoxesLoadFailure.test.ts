/** A failed `get_boxes` keeps the boxes on screen and says why; a stale answer is ignored. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectBox } from "../../types";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useBoxesStore } from "../../stores/boxes";

const box = (id: string): ProjectBox => ({ id, name: id, member_ids: [], position: 10 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  useBoxesStore.setState({ boxes: [], loaded: false, loadError: null });
});

describe("boxes store load failure", () => {
  it("keeps the boxes and records the error", async () => {
    invoke.mockResolvedValueOnce([box("a")]);
    await useBoxesStore.getState().load();
    invoke.mockRejectedValueOnce(new Error("projects.json busy"));
    await useBoxesStore.getState().load();
    const state = useBoxesStore.getState();
    expect(state.boxes.map((b) => b.id)).toEqual(["a"]);
    expect(state.loadError).toContain("projects.json busy");
  });

  it("clears the error on the next good load", async () => {
    invoke.mockRejectedValueOnce("x");
    await useBoxesStore.getState().load();
    expect(useBoxesStore.getState().loaded).toBe(false);
    invoke.mockResolvedValueOnce([box("a")]);
    await useBoxesStore.getState().load();
    expect(useBoxesStore.getState()).toMatchObject({ loaded: true, loadError: null });
  });

  it("ignores a stale answer that arrives after a newer one", async () => {
    const slow = deferred<ProjectBox[]>();
    invoke.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([box("new")]);
    const first = useBoxesStore.getState().load();
    await useBoxesStore.getState().load();
    slow.resolve([box("old")]);
    await first;
    expect(useBoxesStore.getState().boxes.map((b) => b.id)).toEqual(["new"]);
  });
});
