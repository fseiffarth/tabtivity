/**
 * The headless agent installer Settings → Manage CLIs and the intro share:
 * the live log from `agent-install-progress` (this agent's lines only), one
 * install at a time, the registry broadcast on success, the error kept on
 * failure, and the `agent_is_installed` re-detect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { useAgentInstaller } from "../../hooks/useAgentInstaller";
import { AGENT_REGISTRY_CHANGED_EVENT } from "../../lib/agents/agentRegistry";
import { ELSEWHERE_POLL_MS, resetInstallRuns } from "../../stores/installRuns";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);
type Progress = { payload: { id: string; line: string } };
let emitProgress: (p: { id: string; line: string }) => void = () => {};
const registryChanged = vi.fn();

beforeEach(() => {
  listenMock.mockImplementation(async (_event, handler) => {
    emitProgress = (payload) => (handler as (e: Progress) => void)({ payload });
    return () => {};
  });
  window.addEventListener(AGENT_REGISTRY_CHANGED_EVENT, registryChanged);
});

afterEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  registryChanged.mockReset();
  window.removeEventListener(AGENT_REGISTRY_CHANGED_EVENT, registryChanged);
  resetInstallRuns();
  vi.useRealTimers();
});

describe("useAgentInstaller", () => {
  it("streams this agent's log, broadcasts the registry change and reports success", async () => {
    let finish: (v: string) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "install_agent") return new Promise<string>((r) => (finish = r));
      return null;
    });
    const { result } = renderHook(() => useAgentInstaller());
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.install("codex");
    });
    await waitFor(() => expect(result.current.installing).toBe("codex"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "codex" }));
    act(() => {
      emitProgress({ id: "codex", line: "fetching" });
      emitProgress({ id: "claude", line: "not mine" });
      emitProgress({ id: "codex", line: "linking" });
    });
    expect(result.current.logs.codex).toBe("fetching\nlinking");
    await act(async () => {
      finish("ok");
      expect(await done).toBe(true);
    });
    expect(result.current.installing).toBeNull();
    expect(result.current.errors.codex).toBeUndefined();
    expect(registryChanged).toHaveBeenCalledTimes(1);
  });

  it("keeps the error on failure, broadcasts nothing, and joins a second click instead of a second run", async () => {
    let fail: (e: unknown) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "install_agent") return new Promise<string>((_r, j) => (fail = j));
      return null;
    });
    const { result } = renderHook(() => useAgentInstaller());
    let first: Promise<boolean> = Promise.resolve(false);
    let second: Promise<boolean> = Promise.resolve(true);
    act(() => {
      first = result.current.install("codex");
      second = result.current.install("codex");
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "codex" }));
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "install_agent")).toHaveLength(1);
    await act(async () => {
      fail("npm ERR! EACCES");
      expect(await first).toBe(false);
      expect(await second).toBe(false);
    });
    expect(result.current.errors.codex).toBe("npm ERR! EACCES");
    expect(result.current.installing).toBeNull();
    expect(registryChanged).not.toHaveBeenCalled();
  });

  it("recheck re-detects, notes a miss and returns null when the probe fails", async () => {
    invokeMock.mockImplementation(async (cmd: string) => (cmd === "agent_is_installed" ? false : null));
    const { result } = renderHook(() => useAgentInstaller());
    await act(async () => {
      expect(await result.current.recheck("gemini")).toBe(false);
    });
    expect(result.current.errors.gemini).toMatch(/Still not detected/);
    expect(registryChanged).toHaveBeenCalledTimes(1);

    invokeMock.mockImplementation(async () => {
      throw "backend gone";
    });
    await act(async () => {
      expect(await result.current.recheck("gemini")).toBeNull();
    });
    expect(result.current.errors.gemini).toBe("backend gone");
  });

  it("a remounted view re-attaches to the run it left", async () => {
    let finish: (v: string) => void = () => {};
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "install_agent") return new Promise<string>((r) => (finish = r));
      return null;
    });
    const first = renderHook(() => useAgentInstaller());
    act(() => {
      void first.result.current.install("codex");
    });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("install_agent", { id: "codex" }));
    act(() => emitProgress({ id: "codex", line: "fetching" }));
    first.unmount();

    const again = renderHook(() => useAgentInstaller());
    expect(again.result.current.installing).toBe("codex");
    expect(again.result.current.logs.codex).toBe("fetching");
    // Install again while it runs: joined, never a second backend call.
    act(() => {
      void again.result.current.install("codex");
    });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "install_agent")).toHaveLength(1);
    await act(async () => finish("ok"));
    await waitFor(() => expect(again.result.current.installing).toBeNull());
    expect(registryChanged).toHaveBeenCalledTimes(1);
  });

  it("treats the backend's lock refusal as a run in progress, never a failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let there = false;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "install_agent") throw "Codex is already being installed or updated. Wait for that run to finish.";
      if (cmd === "agent_is_installed") return there;
      return null;
    });
    const { result } = renderHook(() => useAgentInstaller());
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = result.current.install("codex");
    });
    await waitFor(() => expect(result.current.elsewhere.has("codex")).toBe(true));
    expect(result.current.installing).toBe("codex");
    expect(result.current.errors.codex).toBeUndefined();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
    });
    expect(result.current.installing).toBe("codex");
    there = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ELSEWHERE_POLL_MS);
      expect(await done).toBe(true);
    });
    expect(result.current.installing).toBeNull();
    expect(result.current.errors.codex).toBeUndefined();
    expect(registryChanged).toHaveBeenCalledTimes(1);
  });
});
