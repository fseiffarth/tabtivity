/**
 * The shared OpenVPN hooks: the handshake log keeps only its config's lines and
 * is capped; the ready marker is heard through the terminal bus (so a straddled
 * marker still counts) and the PTY is watched/unwatched around it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

const h = vi.hoisted(() => ({
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  output: new Map<string, (data: string) => void>(),
  invoked: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    h.invoked.push(cmd);
    return null;
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    h.handlers.set(name, cb);
    return Promise.resolve(() => h.handlers.delete(name));
  }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalOutput: (id: string, fn: (data: string) => void) => {
    h.output.set(id, fn);
    return () => h.output.delete(id);
  },
}));

import { useOpenVpnLog, useVpnReadyMarker } from "../../hooks/useOpenVpn";

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  h.handlers.clear();
  h.output.clear();
  h.invoked.length = 0;
});
afterEach(cleanup);

describe("useOpenVpnLog", () => {
  it("keeps only its config's lines, caps them, and clears on request", async () => {
    const { result } = renderHook(() => useOpenVpnLog("/a.ovpn"));
    await flush();
    const emit = (config: string, line: string) =>
      act(() => h.handlers.get("openvpn-progress")!({ payload: { config, line } }));
    emit("/a.ovpn", "one");
    emit("/b.ovpn", "other tunnel");
    expect(result.current.log.map((l) => l.text)).toEqual(["one"]);
    for (let i = 0; i < 600; i++) emit("/a.ovpn", `l${i}`);
    expect(result.current.log).toHaveLength(500);
    expect(result.current.log[499].text).toBe("l599");
    act(() => result.current.clearLog());
    expect(result.current.log).toEqual([]);
  });

  it("listens to nothing without a config", async () => {
    renderHook(() => useOpenVpnLog(null));
    await flush();
    expect(h.handlers.has("openvpn-progress")).toBe(false);
  });
});

describe("useVpnReadyMarker", () => {
  it("fires once the marker arrives, even split across two chunks, and unwatches on unmount", async () => {
    const ready = vi.fn();
    const { unmount } = renderHook(() => useVpnReadyMarker("pty-1", ready));
    expect(h.invoked).toContain("pty_watch");
    act(() => h.output.get("pty-1")!("Initialization Seq"));
    expect(ready).not.toHaveBeenCalled();
    act(() => h.output.get("pty-1")!("uence Completed\n"));
    expect(ready).toHaveBeenCalled();
    unmount();
    expect(h.output.has("pty-1")).toBe(false);
    expect(h.invoked).toContain("pty_unwatch");
  });

  it("does nothing without a terminal", () => {
    renderHook(() => useVpnReadyMarker(undefined, vi.fn()));
    expect(h.invoked).toEqual([]);
  });
});
