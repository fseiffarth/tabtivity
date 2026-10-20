import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useRemoteBrowse } from "../../components/projects/useRemoteBrowse";
import type { RemoteEntry } from "../../types";
import type { ParsedSshAddress } from "../../components/projects/scaffold";
import { resolveRemoteStartDir } from "../../lib/remote/remoteConnect";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../lib/remote/remoteConnect", () => ({
  resolveRemoteStartDir: vi.fn(async () => "/home/alice"),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const HOST_A: ParsedSshAddress = { user: "alice", host: "a.example", port: 22 };
const HOST_B: ParsedSshAddress = { user: "bob", host: "b.example", port: 2222 };
const OUTCOME = { saved: false, save_error: null };
const invokeMock = vi.mocked(invoke);

function directory(name: string): RemoteEntry {
  return { name, is_dir: true };
}

beforeEach(() => {
  vi.mocked(resolveRemoteStartDir).mockReset().mockResolvedValue("/home/alice");
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command) => {
    if (command === "ssh_connect") return OUTCOME;
    if (command === "ssh_list_dir") return [];
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("remote browser request ownership", () => {
  it("does not reopen a reset session when a pending connect completes", async () => {
    const connect = deferred<typeof OUTCOME>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "ssh_connect") return connect.promise;
      if (command === "ssh_list_dir") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useRemoteBrowse());
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.connect({ target: HOST_A, password: "test-secret", startPath: "/a" });
    });
    act(() => result.current.reset());
    await act(async () => { connect.resolve(OUTCOME); await expect(pending).resolves.toBeNull(); });

    expect(result.current.conn).toBeNull();
    expect(result.current.password).toBe("");
    expect(result.current.path).toBe("");
    expect(invokeMock.mock.calls.filter(([command]) => command === "ssh_list_dir")).toEqual([]);
  });

  it("keeps the newer host when two connects finish in reverse order", async () => {
    const first = deferred<typeof OUTCOME>();
    const second = deferred<typeof OUTCOME>();
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "ssh_connect") {
        return (args as { host: string }).host === HOST_A.host ? first.promise : second.promise;
      }
      if (command === "ssh_list_dir") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useRemoteBrowse());
    let pendingA!: Promise<unknown>;
    let pendingB!: Promise<unknown>;
    act(() => {
      pendingA = result.current.connect({ target: HOST_A, password: "test-old", startPath: "/a" });
      pendingB = result.current.connect({ target: HOST_B, password: "test-new", startPath: "/b" });
    });
    await act(async () => { second.resolve(OUTCOME); await expect(pendingB).resolves.toEqual(OUTCOME); });
    expect(result.current.conn).toEqual(HOST_B);
    await act(async () => { first.resolve(OUTCOME); await expect(pendingA).resolves.toBeNull(); });

    expect(result.current.conn).toEqual(HOST_B);
    expect(result.current.password).toBe("test-new");
    expect(result.current.path).toBe("/b");
    expect(invokeMock.mock.calls.filter(([command]) => command === "ssh_list_dir"))
      .toHaveLength(1);
  });

  it("clears busy when a session is reset during a directory listing", async () => {
    const listing = deferred<RemoteEntry[]>();
    invokeMock.mockImplementation(() => listing.promise);
    const { result } = renderHook(() => useRemoteBrowse());
    act(() => result.current.openSession(HOST_A, "test-secret", "/a"));
    expect(result.current.busy).toBe(true);

    act(() => result.current.reset());
    expect(result.current.busy).toBe(false);
    await act(async () => { listing.resolve([directory("stale")]); });
    expect(result.current.conn).toBeNull();
    expect(result.current.entries).toEqual([]);
    expect(result.current.busy).toBe(false);
  });

  it("does not reopen a session reset while its start directory is being resolved", async () => {
    const startDir = deferred<string>();
    vi.mocked(resolveRemoteStartDir).mockReturnValueOnce(startDir.promise);
    const { result } = renderHook(() => useRemoteBrowse());
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.connect({ target: HOST_A, password: "test-old" });
    });
    expect(resolveRemoteStartDir).toHaveBeenCalledOnce();
    act(() => result.current.reset());
    await act(async () => { startDir.resolve("/old-home"); await expect(pending).resolves.toBeNull(); });
    expect(result.current.conn).toBeNull();
    expect(result.current.path).toBe("");
    expect(invokeMock.mock.calls.filter(([command]) => command === "ssh_list_dir")).toEqual([]);
  });

  it("does not start a directory listing when a connection finishes after unmount", async () => {
    const connect = deferred<typeof OUTCOME>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "ssh_connect") return connect.promise;
      if (command === "ssh_list_dir") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result, unmount } = renderHook(() => useRemoteBrowse());
    let pending!: Promise<unknown>;
    act(() => { pending = result.current.connect({ target: HOST_A, password: "test-secret", startPath: "/a" }); });
    unmount();
    await act(async () => { connect.resolve(OUTCOME); await expect(pending).resolves.toBeNull(); });
    expect(invokeMock.mock.calls.filter(([command]) => command === "ssh_list_dir")).toEqual([]);
  });

  it("ignores a stale connection failure after a newer session opens", async () => {
    const connect = deferred<typeof OUTCOME>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "ssh_connect") return connect.promise;
      if (command === "ssh_list_dir") return [directory("current")];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useRemoteBrowse());
    let pending!: ReturnType<typeof result.current.connect>;
    act(() => { pending = result.current.connect({ target: HOST_A, password: "test-old", startPath: "/a" }); });
    await act(async () => result.current.openSession(HOST_B, "test-new", "/b"));
    let outcome: Awaited<typeof pending> | undefined;
    await act(async () => { connect.reject(new Error("old login failed")); outcome = await pending; });
    expect(outcome).toBeNull();
    expect(result.current.conn).toEqual(HOST_B);
    expect(result.current.entries).toEqual([directory("current")]);
    expect(result.current.error).toBe("");
  });

  it("does not navigate a newer session when an old mkdir completes", async () => {
    const mkdir = deferred<void>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "ssh_mkdir") return mkdir.promise;
      if (command === "ssh_list_dir") return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { result } = renderHook(() => useRemoteBrowse());
    await act(async () => result.current.openSession(HOST_A, "test-old", "/a"));
    let pending!: Promise<void>;
    act(() => { pending = result.current.mkdir("child"); });
    await act(async () => result.current.openSession(HOST_B, "test-new", "/b"));
    await act(async () => { mkdir.resolve(); await pending; });
    expect(result.current.conn).toEqual(HOST_B);
    expect(result.current.path).toBe("/b");
    expect(result.current.busy).toBe(false);
  });

  it.each(["success", "failure"])("ignores a stale listing's %s after navigating", async (completion) => {
    const first = deferred<RemoteEntry[]>();
    const second = deferred<RemoteEntry[]>();
    invokeMock.mockImplementation((_command, args) =>
      (args as { path: string }).path === "/a" ? first.promise : second.promise,
    );
    const { result } = renderHook(() => useRemoteBrowse());
    act(() => result.current.openSession(HOST_A, "test-secret", "/a"));
    act(() => result.current.jump("/b"));
    await act(async () => { second.resolve([directory("current")]); });
    expect(result.current.entries).toEqual([directory("current")]);

    await act(async () => {
      if (completion === "success") first.resolve([directory("stale")]);
      else first.reject(new Error("old request failed"));
    });
    expect(result.current.path).toBe("/b");
    expect(result.current.entries).toEqual([directory("current")]);
    expect(result.current.error).toBe("");
    expect(result.current.busy).toBe(false);
  });

  it("keeps the authenticated target and credential when navigating", async () => {
    const { result } = renderHook(() => useRemoteBrowse());
    await act(async () => result.current.connect({ target: HOST_B, password: "test-session-secret", startPath: "/b" }));
    await act(async () => result.current.enter(directory("child")));

    expect(invokeMock).toHaveBeenLastCalledWith("ssh_list_dir", {
      user: "bob", host: "b.example", port: 2222, password: "test-session-secret", path: "/b/child",
    });
  });
});
