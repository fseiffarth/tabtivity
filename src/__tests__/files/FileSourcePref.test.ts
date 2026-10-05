/**
 * The Local/Remote side of a remote project's file views must be decided ONCE
 * and then only ever move because the user clicked the switch.
 *
 * It used to be re-derived from the live SSH lamp in a plain mount effect, so
 * anything that remounted a file view — hiding and re-showing the panels (the
 * side panel is unmounted, not hidden), a scope switch, an activation that
 * briefly cleared the active project — silently rewrote the side. With a pool
 * that had come up in the meantime, a deliberate "Local" became "Remote" with
 * nothing touched: the reported jump. The docked subwindow column had the same
 * bug one level down — its choice lived in component state and it is remounted
 * by `key={scope}`, so it came back re-seeded from the project-wide value.
 *
 * These lock: the latch is a one-time decision, a remount is a no-op, an
 * explicit choice outranks it and survives a relaunch (localStorage), and each
 * viewer's own switch is independent of the project-wide one in both directions.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import {
  autoFileSource,
  fileSourceSettled,
  useFileSourcePrefStore,
  viewerSourceKey,
} from "../../stores/remote/fileSourcePref";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useFileSource, useIndependentFileSource } from "../../components/files/ProjectFilesPane";
import { storageKey } from "../../lib/brand";

const PID = "p1";

function setSsh(state: "off" | "connecting" | "connected" | "error") {
  act(() => {
    useRemoteStatusStore.getState().setSsh(PID, state);
  });
}

beforeEach(() => {
  localStorage.clear();
  useFileSourcePrefStore.setState({ byProject: {}, byViewer: {} });
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
});

describe("the auto default", () => {
  it("is the host while connected or heading there, the mirror otherwise", () => {
    expect(autoFileSource("connected")).toBe("remote");
    expect(autoFileSource("connecting")).toBe("remote");
    expect(autoFileSource("off")).toBe("local");
    expect(autoFileSource("error")).toBe("local");
    expect(autoFileSource(undefined)).toBe("local");
  });

  it("only latches off a settled lamp — a handshake in flight decides nothing", () => {
    expect(fileSourceSettled("connected")).toBe(true);
    expect(fileSourceSettled("off")).toBe(true);
    expect(fileSourceSettled("error")).toBe(true);
    expect(fileSourceSettled("connecting")).toBe(false);
    expect(fileSourceSettled(undefined)).toBe(false);
  });
});

describe("useFileSource (the side panel's tree)", () => {
  it("latches the usable side once the lamp settles", () => {
    setSsh("connected");
    const { result } = renderHook(() => useFileSource(PID, true));
    expect(result.current[0]).toBe("remote");
    expect(useFileSourcePrefStore.getState().byProject[PID]).toBe("remote");
  });

  it("keeps a Local choice when the project connects", () => {
    setSsh("off");
    const { result } = renderHook(() => useFileSource(PID, true));
    expect(result.current[0]).toBe("local");
    setSsh("connected");
    expect(result.current[0]).toBe("local");
  });

  it("keeps a Local choice across a remount — the reported jump", () => {
    setSsh("connected");
    const first = renderHook(() => useFileSource(PID, true));
    act(() => first.result.current[1]("local"));
    expect(first.result.current[0]).toBe("local");
    first.unmount();

    // Panels hidden and shown again / scope switched away and back: the view is
    // rebuilt from scratch against a live pool, and must NOT re-decide.
    const second = renderHook(() => useFileSource(PID, true));
    expect(second.result.current[0]).toBe("local");
  });

  it("remembers an explicit choice across a relaunch, but not a latch", () => {
    setSsh("connected");
    const { result } = renderHook(() => useFileSource(PID, true));
    expect(useFileSourcePrefStore.getState().byProject[PID]).toBe("remote"); // latched
    // A fresh process: the store is re-created from localStorage only.
    expect(localStorage.getItem(storageKey("fileSourceByProject"))).toBeNull();

    act(() => result.current[1]("local"));
    expect(JSON.parse(localStorage.getItem(storageKey("fileSourceByProject"))!)).toEqual({
      [PID]: "local",
    });
  });

  it("decides nothing for a local project", () => {
    renderHook(() => useFileSource(PID, false));
    expect(useFileSourcePrefStore.getState().byProject[PID]).toBeUndefined();
  });
});

describe("useIndependentFileSource (a Files tab / the docked column)", () => {
  const VIEWER = "group:g1";

  it("starts from the project-wide side and then goes its own way", () => {
    setSsh("connected");
    renderHook(() => useFileSource(PID, true)); // panel latches "remote"
    const { result } = renderHook(() => useIndependentFileSource(PID, true, VIEWER));
    expect(result.current[0]).toBe("remote");

    act(() => result.current[1]("local"));
    expect(result.current[0]).toBe("local");
    // Its own switch never writes back to the project-wide one.
    expect(useFileSourcePrefStore.getState().byProject[PID]).toBe("remote");
  });

  it("keeps its own side across the remount its host forces on a scope switch", () => {
    setSsh("connected");
    const first = renderHook(() => useIndependentFileSource(PID, true, VIEWER));
    act(() => first.result.current[1]("local"));
    first.unmount();

    const second = renderHook(() => useIndependentFileSource(PID, true, VIEWER));
    expect(second.result.current[0]).toBe("local");
    expect(useFileSourcePrefStore.getState().byViewer[viewerSourceKey(VIEWER, PID)]).toBe("local");
  });

  it("does not follow the project-wide side once it has one of its own", () => {
    setSsh("connected");
    const panel = renderHook(() => useFileSource(PID, true));
    const viewer = renderHook(() => useIndependentFileSource(PID, true, VIEWER));
    act(() => panel.result.current[1]("local"));
    expect(viewer.result.current[0]).toBe("remote");
  });

  it("is per (viewer, project) — a second column decides for itself", () => {
    setSsh("connected");
    const a = renderHook(() => useIndependentFileSource(PID, true, "group:g1"));
    act(() => a.result.current[1]("local"));
    const b = renderHook(() => useIndependentFileSource(PID, true, "group:g2"));
    expect(b.result.current[0]).toBe("remote");
  });
});
