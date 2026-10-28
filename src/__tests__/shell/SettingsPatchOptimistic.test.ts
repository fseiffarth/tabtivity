/**
 * A settings patch is on screen before it is on disk.
 *
 * `updateSettings` used to set state only after the backend answered, so every
 * UI that reads its own setting back — the side panel's view, its edge, the
 * pin — lagged a disk write behind the click. The edge rail made that visible:
 * a tab that opens the panel on Agents opened it on the OLD view first, mounted
 * and probed the file tree, then swapped. These pin the guess-then-adopt
 * contract: the patch lands at once, the backend's merged answer replaces it,
 * and a failed write puts the previous state back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: () => Promise.resolve() }),
}));

import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("updateSettings applies the patch before the write lands", () => {
  beforeEach(() => {
    invoke.mockReset();
    useSettingsStore.setState({
      settings: { side_panel_edge: "right", side_panel_view: "files" } as Settings,
      loaded: true,
    });
  });

  it("shows the patch at once, then adopts the backend's merged answer", async () => {
    const write = deferred<Settings>();
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings" ? write.promise : Promise.resolve(undefined),
    );

    const pending = useSettingsStore.getState().updateSettings({ side_panel_edge: "left" });
    // Not yet written — already the state every subscriber sees.
    expect(useSettingsStore.getState().settings?.side_panel_edge).toBe("left");
    expect(useSettingsStore.getState().settings?.side_panel_view).toBe("files");

    // The backend merges in what another window wrote meanwhile; that wins.
    write.resolve({ side_panel_edge: "left", side_panel_view: "git" } as Settings);
    await pending;
    expect(useSettingsStore.getState().settings).toEqual({
      side_panel_edge: "left",
      side_panel_view: "git",
    });
  });

  it("sends a cleared key as null so the backend resets it", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings" ? Promise.resolve({} as Settings) : Promise.resolve(undefined),
    );
    // Zoom back to 100% clears `ui_zoom`; JSON drops `undefined`, so without
    // the null the backend kept the old zoom and the reset snapped back.
    await useSettingsStore.getState().updateSettings({ ui_zoom: undefined });
    const call = invoke.mock.calls.find(([cmd]) => cmd === "patch_settings");
    expect(JSON.parse(JSON.stringify(call?.[1]))).toEqual({ patch: { ui_zoom: null } });
  });

  it("puts the previous state back when the write fails", async () => {
    invoke.mockImplementation((cmd: string) =>
      cmd === "patch_settings"
        ? Promise.reject(new Error("disk full"))
        : Promise.resolve(undefined),
    );
    await expect(
      useSettingsStore.getState().updateSettings({ side_panel_edge: "left" }),
    ).rejects.toThrow("disk full");
    expect(useSettingsStore.getState().settings?.side_panel_edge).toBe("right");
  });

  it("a failed write does not undo a later patch that already moved on", async () => {
    const first = deferred<Settings>();
    invoke.mockImplementation((_cmd: string, args: { patch?: Partial<Settings> }) =>
      args?.patch?.side_panel_edge === "left"
        ? first.promise
        : Promise.resolve({ side_panel_edge: "left", side_panel_view: "agents" } as Settings),
    );
    const pendingFirst = useSettingsStore.getState().updateSettings({ side_panel_edge: "left" });
    await useSettingsStore.getState().updateSettings({ side_panel_view: "agents" });
    first.reject(new Error("late failure"));
    await expect(pendingFirst).rejects.toThrow("late failure");
    // The second patch's answer stands; the rollback saw a state that was no
    // longer its own guess and left it alone.
    expect(useSettingsStore.getState().settings).toEqual({
      side_panel_edge: "left",
      side_panel_view: "agents",
    });
  });
});
