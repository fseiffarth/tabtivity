/**
 * A just-created remote project's first pooled connect (`connectCreatedRemoteProject`,
 * called by `ProjectDialog` and `HpcPipelineWizard` right after creation).
 *
 * The gap it closes: the create dialogs used to park the password they signed in
 * with (or a "rode a login terminal" mark) in maps nothing read, so the project's
 * first connect went out later as a bare `remote_connect {password: null}` — riding
 * the dialog's ControlMaster, which the backend reads as key auth and records as
 * `key_auth: true` on a password host (`record_key_auth`). Now the dialog connects
 * at once and says how: the typed password, or `viaLogin` with none.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { connectCreatedRemoteProject } from "../../lib/remote/remoteConnect";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";

const invokeMock = vi.mocked(invoke);
const lamp = () => useRemoteStatusStore.getState().byProject.p1?.ssh;
const connects = () => invokeMock.mock.calls.filter(([c]) => c === "remote_connect");

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
});

describe("connectCreatedRemoteProject", () => {
  it("a terminal sign-in (no password) connects with viaLogin, so nothing is read as key auth", async () => {
    await connectCreatedRemoteProject("p1", "");
    expect(connects()).toEqual([
      ["remote_connect", { projectId: "p1", password: null, viaLogin: true, background: false }],
    ]);
    expect(lamp()).toBe("connected");
  });

  it("a typed, unsaved password is handed over (recorded as a password host), not ridden", async () => {
    expect(await connectCreatedRemoteProject("p1", "pw-test")).toBeNull();
    expect(connects()).toEqual([
      ["remote_connect", { projectId: "p1", password: "pw-test", viaLogin: false, background: false }],
    ]);
    expect(lamp()).toBe("connected");
  });

  it("never fights a lamp already moving", async () => {
    useRemoteStatusStore.getState().setSsh("p1", "connecting");
    await connectCreatedRemoteProject("p1", null);
    expect(connects()).toHaveLength(0);
  });

  it("a failed ride (no master — e.g. Windows) leaves the project disconnected; a failed password is red", async () => {
    invokeMock.mockRejectedValue("Permission denied");
    // The failure is handed back, for a caller that must wait on the connect.
    expect(await connectCreatedRemoteProject("p1", null)).toBe("Permission denied");
    expect(lamp()).toBe("off");

    useRemoteStatusStore.setState({ byProject: {}, byHost: {} });
    await connectCreatedRemoteProject("p1", "wrong");
    expect(lamp()).toBe("error");
  });
});
