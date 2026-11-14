/**
 * The desktop markup layer's load / save / restamp protocol (`usePdfMarkup`),
 * pinned before it is reshaped (`docs/markup_refactor_plan.md` step C):
 * a record read from the store is never written straight back; the first
 * change is saved, stamped with the fingerprint read after the load (or once
 * it arrives); a stored fingerprint that differs from the file's says
 * `changed` — for marks only; `beforeReload()` mutes that, saves changes made
 * while it waits with the old fingerprint, and stamps the new one (even a new
 * object equal in value) once more, clearing `changed`; a failed save shows
 * "unsaved" and is not retried until the next change.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: mocks.saveLayer,
}));

import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import { EMPTY_LAYER, addMark, type Layer, type Mark } from "../../../mobile-web/src/markup/layer";

const PATH = "/home/u/paper/paper.pdf";
const KEY = `p1:files:${PATH}`;
const SIZE: [number, number] = [595, 842];
const STROKE: Mark = { kind: "ink", color: "red", width: 1.7, points: [[10, 10, 0.5], [40, 30, 0.5]] };
const BOX: Mark = { kind: "box", color: "yellow", rect: [100, 200, 50, 10] };
const LAYER = addMark(EMPTY_LAYER, 1, SIZE, STROKE);
const DOC_SIZE = 9_000;
const MTIME = 1_790_000_000;

/** What `file_mtime` answers, and a gate it waits on when a test holds it. */
let mtime = MTIME;
let gate: Promise<void> | null = null;
const record = (layer: Layer, modified = MTIME, past?: Layer[]) => ({ layer, fingerprint: { size: DOC_SIZE, modified }, saved: 1, ...(past ? { past } : {}) });

type Saved = [string, Layer, { size: number; modified: number }, undefined, Layer[]];
const saves = () => mocks.saveLayer.mock.calls as unknown as Saved[];

function mount() {
  return renderHook(
    ({ docVersion }: { docVersion: number }) =>
      usePdfMarkup({ projectId: "p1", scope: "p1", path: PATH, active: true, visible: true, pageCount: 3, docSize: DOC_SIZE, docVersion }),
    { initialProps: { docVersion: 0 } },
  );
}
type Mounted = ReturnType<typeof mount>;

/** Waits for the record to be read and the file's fingerprint after it. */
async function ready(view: Mounted, reads = 1) {
  await waitFor(() => expect(view.result.current.edit.base).not.toBe(EMPTY_LAYER));
  await waitFor(() => expect(mocks.invoke.mock.calls.filter(([name]) => name === "file_mtime")).toHaveLength(reads));
  await flush();
}
/** Lets the promise chains behind the effects settle. */
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
const draw = (view: Mounted, mark: Mark) => act(() => { view.result.current.edit.add(1, SIZE, mark); });

beforeEach(() => {
  mtime = MTIME;
  gate = null;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "file_mtime") {
      const modified = mtime;
      await gate;
      return modified;
    }
    if (command === "markup_mcp_list" || command === "markup_mcp_ticks") return [];
    return null;
  });
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue(record(LAYER));
  mocks.saveLayer.mockReset();
  mocks.saveLayer.mockResolvedValue(true);
  useTabsStore.setState({ tabsByScope: { p1: [] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

describe("desktop markup storage", () => {
  it("writes nothing back for a record it just read", async () => {
    const view = mount();
    await ready(view);
    expect(view.result.current.edit.base).toBe(LAYER);
    expect(mocks.loadLayer).toHaveBeenCalledWith(KEY);
    expect(mocks.saveLayer).not.toHaveBeenCalled();
    expect(view.result.current.storage).toBe("saved");
    expect(view.result.current.changed).toBe(false);
  });

  it("saves the first change, stamped with the fingerprint read after the load", async () => {
    const view = mount();
    await ready(view);
    draw(view, BOX);
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(1));
    const [key, layer, fingerprint, backend, past] = saves()[0];
    expect(key).toBe(KEY);
    expect(layer.pages[1].marks).toEqual([STROKE, BOX]);
    expect(fingerprint).toEqual({ size: DOC_SIZE, modified: MTIME });
    expect(backend).toBeUndefined();
    expect(past).toEqual([LAYER]);
    await flush();
    expect(mocks.saveLayer).toHaveBeenCalledTimes(1);
  });

  it("saves a change made before the fingerprint is read once it arrives, and only once", async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    const view = mount();
    await waitFor(() => expect(view.result.current.edit.base).toBe(LAYER));
    draw(view, BOX);
    await flush();
    expect(mocks.saveLayer).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(1));
    expect(saves()[0][2]).toEqual({ size: DOC_SIZE, modified: MTIME });
    expect(saves()[0][1].pages[1].marks).toEqual([STROKE, BOX]);
    await flush();
    expect(mocks.saveLayer).toHaveBeenCalledTimes(1);
  });

  it("says the marks were drawn on another version of the file — for marks, not for an empty record", async () => {
    mocks.loadLayer.mockResolvedValue(record(LAYER, MTIME - 5));
    const marked = mount();
    await ready(marked);
    await waitFor(() => expect(marked.result.current.changed).toBe(true));
    // Nothing is written back to silence it.
    expect(mocks.saveLayer).not.toHaveBeenCalled();
    cleanup();

    mocks.invoke.mockClear();
    mocks.loadLayer.mockResolvedValue(record(EMPTY_LAYER, MTIME - 5));
    const empty = renderHook(() => usePdfMarkup({ projectId: "p1", scope: "p1", path: PATH, active: true, visible: true, pageCount: 3, docSize: DOC_SIZE, docVersion: 0 }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([name]) => name === "file_mtime")).toHaveLength(1));
    await flush();
    expect(empty.result.current.changed).toBe(false);
  });

  it("a Reload mutes that, saves changes made while it waits with the old fingerprint, and stamps the new file once more", async () => {
    const view = mount();
    await ready(view);
    act(() => view.result.current.beforeReload());
    // The new file's fingerprint is slow.
    let release!: () => void;
    gate = new Promise<void>((resolve) => { release = resolve; });
    mtime = MTIME + 50;
    view.rerender({ docVersion: 1 });
    draw(view, BOX);
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(1));
    expect(saves()[0][2]).toEqual({ size: DOC_SIZE, modified: MTIME });
    release();
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(2));
    expect(saves()[1][2]).toEqual({ size: DOC_SIZE, modified: MTIME + 50 });
    expect(saves()[1][1].pages[1].marks).toEqual([STROKE, BOX]);
    await flush();
    // The marks now sit on the new file: not stale, nothing more saved.
    expect(view.result.current.changed).toBe(false);
    expect(mocks.saveLayer).toHaveBeenCalledTimes(2);
  });

  it("a Reload that finds the file unchanged (a new fingerprint equal in value) still stamps it and clears 'changed'", async () => {
    mocks.loadLayer.mockResolvedValue(record(LAYER, MTIME - 5));
    const view = mount();
    await ready(view);
    await waitFor(() => expect(view.result.current.changed).toBe(true));
    act(() => view.result.current.beforeReload());
    view.rerender({ docVersion: 1 });
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(1));
    expect(saves()[0][2]).toEqual({ size: DOC_SIZE, modified: MTIME });
    expect(saves()[0][1]).toBe(LAYER);
    await waitFor(() => expect(view.result.current.changed).toBe(false));
    await flush();
    expect(view.result.current.changed).toBe(false);
    expect(mocks.saveLayer).toHaveBeenCalledTimes(1);
  });

  it("shows 'unsaved' for a failed save and does not retry it until the next change", async () => {
    mocks.saveLayer.mockResolvedValueOnce(false);
    const view = mount();
    await ready(view);
    draw(view, BOX);
    await waitFor(() => expect(view.result.current.storage).toBe("unsaved"));
    await flush();
    expect(mocks.saveLayer).toHaveBeenCalledTimes(1);
    draw(view, { kind: "box", color: "red", rect: [10, 300, 20, 20] });
    await waitFor(() => expect(mocks.saveLayer).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(view.result.current.storage).toBe("saved"));
  });
});
