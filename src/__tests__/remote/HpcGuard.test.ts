/**
 * The HPC tag's confirmable half, from the caller's side (`lib/remote/hpc/hpcGuard`).
 *
 * The backend refuses a gated act with `TABTIVITY_HPC_GUARD <kind> <target>`, and
 * the wrapper reads both out of the error itself — no call site knows in
 * advance that its target might be a cluster. What these pin: the parse, the
 * retry-exactly-once-on-confirm contract (a decline propagates the ORIGINAL
 * refusal), and `guardLoginNodeRun`'s cheap paths, which must answer without
 * reading a store. `HpcGuardNoHost.test.ts` covers the dialog store itself.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { HPC_GUARD, guardLoginNodeRun, hpcGuardRefusal, withHpcConfirm } from "../../lib/remote/hpc/hpcGuard";
import { useHpcGuardStore } from "../../stores/remote/hpc/hpcGuardPrompt";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { targetKey } from "../../lib/remote/machineSync";
import type { ProjectEntry } from "../../types";

const REFUSAL = `${HPC_GUARD} du-scan alice@login.example.org:22`;

function clusterProject(): ProjectEntry {
  return {
    id: "p1",
    name: "sim",
    status: "active",
    position: 1,
    local_file: "/p/p1/project.json",
    remote: { user: "alice", host: "login.example.org", remote_path: "/home/alice/sim" },
    compute_hosts: [
      { id: "w-gpu", host: "gpu.example.org", user: "alice", remote_path: "/home/alice/sim" },
    ],
  };
}

beforeEach(() => {
  useHpcGuardStore.setState({ pending: null, hosts: 0 });
  useProjectsStore.setState({ projects: [clusterProject()] });
  useSettingsStore.setState({ settings: {}, loaded: true });
});

describe("hpcGuardRefusal", () => {
  it("reads kind and target out of a string, an Error, or a raw rejection", () => {
    expect(hpcGuardRefusal(REFUSAL)).toEqual({ kind: "du-scan", target: "alice@login.example.org:22" });
    expect(hpcGuardRefusal(new Error(`refused: ${REFUSAL} — tagged HPC`))).toEqual({
      kind: "du-scan",
      target: "alice@login.example.org:22",
    });
    expect(hpcGuardRefusal({ toString: () => REFUSAL })).not.toBeNull();
  });

  it("tolerates a refusal with no target, but not one with no kind", () => {
    expect(hpcGuardRefusal(`${HPC_GUARD} census`)).toEqual({ kind: "census", target: "" });
    expect(hpcGuardRefusal(`${HPC_GUARD}   `)).toBeNull();
  });

  it("does not claim any other failure", () => {
    expect(hpcGuardRefusal("Permission denied (publickey).")).toBeNull();
    expect(hpcGuardRefusal(undefined)).toBeNull();
    expect(hpcGuardRefusal(new Error("timeout"))).toBeNull();
  });
});

describe("withHpcConfirm", () => {
  it("passes a success and any ordinary failure straight through", async () => {
    const ok = vi.fn().mockResolvedValue(42);
    await expect(withHpcConfirm(ok)).resolves.toBe(42);
    expect(ok).toHaveBeenCalledWith(false);

    const bad = vi.fn().mockRejectedValue("disk full");
    await expect(withHpcConfirm(bad)).rejects.toBe("disk full");
    expect(bad).toHaveBeenCalledTimes(1);
    expect(useHpcGuardStore.getState().pending).toBeNull();
  });

  it("retries once with confirmed=true after the user says go ahead", async () => {
    useHpcGuardStore.getState().registerHost();
    const attempt = vi.fn().mockRejectedValueOnce(REFUSAL).mockResolvedValueOnce("scanned");
    const done = withHpcConfirm(attempt);
    await vi.waitFor(() => expect(useHpcGuardStore.getState().pending).not.toBeNull());
    expect(useHpcGuardStore.getState().pending).toMatchObject({
      kind: "du-scan",
      target: "alice@login.example.org:22",
    });
    useHpcGuardStore.getState().proceed();
    await expect(done).resolves.toBe("scanned");
    expect(attempt).toHaveBeenNthCalledWith(1, false);
    expect(attempt).toHaveBeenNthCalledWith(2, true);
  });

  it("propagates the original refusal when the user backs out", async () => {
    useHpcGuardStore.getState().registerHost();
    const attempt = vi.fn().mockRejectedValue(REFUSAL);
    const done = withHpcConfirm(attempt);
    await vi.waitFor(() => expect(useHpcGuardStore.getState().pending).not.toBeNull());
    useHpcGuardStore.getState().cancel();
    // Declining is an answer: the caller's own "it didn't happen" path runs.
    await expect(done).rejects.toBe(REFUSAL);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("refuses without retrying when no dialog can ask", async () => {
    const attempt = vi.fn().mockRejectedValue(REFUSAL);
    await expect(withHpcConfirm(attempt)).rejects.toBe(REFUSAL);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe("guardLoginNodeRun", () => {
  const tagLogin = () =>
    useSettingsStore.setState({
      settings: { hpc_hosts: { [targetKey({ user: "alice", host: "login.example.org" })]: true } },
      loaded: true,
    });

  it("answers the local majority without consulting anything", async () => {
    // Nothing mounted, so a store read that asked would answer false — these
    // must be true purely from the arguments.
    tagLogin();
    for (const opts of [
      { projectId: null, location: "remote" },
      { projectId: "root", location: "remote" },
      { projectId: "p1", location: undefined },
      { projectId: "p1", location: "local" },
    ]) {
      await expect(guardLoginNodeRun({ ...opts, kind: "login-node-run" })).resolves.toBe(true);
    }
  });

  it("lets an untagged host, and a location naming no known host, run unasked", async () => {
    await expect(
      guardLoginNodeRun({ projectId: "p1", location: "remote", kind: "login-node-run" }),
    ).resolves.toBe(true);
    tagLogin();
    await expect(
      guardLoginNodeRun({ projectId: "p1", location: "host:gone", kind: "login-node-run" }),
    ).resolves.toBe(true);
    await expect(
      guardLoginNodeRun({ projectId: "p1", location: "host:w-gpu", kind: "login-node-run" }),
    ).resolves.toBe(true);
  });

  it("asks about a tagged primary, naming it user@host, and honours the answer", async () => {
    tagLogin();
    useHpcGuardStore.getState().registerHost();
    const answer = guardLoginNodeRun({ projectId: "p1", location: "remote", kind: "login-node-run" });
    await vi.waitFor(() => expect(useHpcGuardStore.getState().pending).not.toBeNull());
    expect(useHpcGuardStore.getState().pending).toMatchObject({
      kind: "login-node-run",
      target: "alice@login.example.org",
    });
    useHpcGuardStore.getState().cancel();
    await expect(answer).resolves.toBe(false);
  });

  it("asks about a tagged worker reached through host:<id>", async () => {
    useSettingsStore.setState({
      settings: { hpc_hosts: { [targetKey({ user: "alice", host: "gpu.example.org" })]: true } },
      loaded: true,
    });
    useHpcGuardStore.getState().registerHost();
    const answer = guardLoginNodeRun({ projectId: "p1", location: "host:w-gpu", kind: "login-node-run" });
    await vi.waitFor(() => expect(useHpcGuardStore.getState().pending).not.toBeNull());
    expect(useHpcGuardStore.getState().pending?.target).toBe("alice@gpu.example.org");
    useHpcGuardStore.getState().proceed();
    await expect(answer).resolves.toBe(true);
  });

  it("refuses a tagged host outright when no dialog is mounted (#233)", async () => {
    tagLogin();
    await expect(
      guardLoginNodeRun({ projectId: "p1", location: "remote", kind: "login-node-run" }),
    ).resolves.toBe(false);
  });
});
