/**
 * Starting an agent on a remote project's machine from the phone's ＋.
 *
 * The sheet's "Runs on" dropdown lists the desktop's local copy and each
 * machine `launch-options` names under an opaque id, greys out one the desktop
 * is not connected to, and sends the pick as `host`. The sidecar resolves that
 * id to the window's location word; the window then saves the agent at that
 * location with the project's folder as its cwd, the way the tab badge's "Run
 * on machine" would, and refuses a location the project does not have.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { NewTabSheet } from "../../../mobile-web/src/screens/NewTabSheet";
import type { LaunchOptions } from "../../../mobile-web/src/api";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import type { ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, NAMES } from "../../lib/brand";

const fetchMock = vi.fn();

const rem: ProjectEntry = {
  id: "rem",
  name: "rem",
  status: "active",
  position: 1,
  local_file: "/state/projects/rem/project.json",
  directory: "/state/projects/rem",
  mirror: "/mirrors/rem",
  remote: { host: "h.invalid", user: "u", remote_path: "/srv" } as ProjectEntry["remote"],
  compute_hosts: [
    { id: "w1", host: "w1.invalid", user: "u", remote_path: "/srv", label: "gpu-1" },
    { id: "w2", host: "w2.invalid", user: "u", remote_path: "/srv", sync_code: false },
  ] as ProjectEntry["compute_hosts"],
  [MOBILE_ACCESS_KEY]: true,
};

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(([c]) => c === "mobile_desktop_respond")).toBe(true));
  const call = invokeMock.mock.calls.find(([c]) => c === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

const create = (request: Record<string, unknown>) => ask({
  type: "create",
  request_id: "c1",
  request: { project_id: "rem", kind: "agent", agent_id: "agent-claude", idempotency_key: "0123456789abcdef", ...request },
});

describe("Mobile bridge — an agent on a remote project's machine", () => {
  const made = vi.fn();
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "list_agents") return Promise.resolve([{ id: "claude", bin: "claude", installed: true }]);
      if (command === "mobile_opaque_id") {
        const { domain, value } = args as { domain: string; value: string };
        return Promise.resolve(`${domain}-${value}`);
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    made.mockReset();
    useProjectsStore.setState({
      projects: [rem],
      activeId: null,
      loaded: true,
      activateProject: vi.fn(() => Promise.resolve()),
    } as never);
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      scope: "root",
      tabsByScope: { rem: [] },
      hydrateThenCreateInScope: (options: { spec: Omit<TabEntry, "key"> }) => {
        made(options);
        return Promise.resolve({ ...options.spec, key: "new", tmuxSession: `${BRAND.slug}-rem--agent-123456789` } as TabEntry);
      },
    } as never);
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
  });

  it("saves the agent at the machine's location, in the project's folder", async () => {
    for (const host of ["remote", "host:w1"]) {
      made.mockClear();
      expect(await create({ host, idempotency_key: `key-${host}-0123456789` })).toMatchObject({ status: "created" });
      const spec = (made.mock.calls[0]?.[0] as { spec: Omit<TabEntry, "key"> }).spec;
      expect(spec).toMatchObject({ location: host, cwd: "/state/projects/rem", cmd: "claude", kind: "agent" });
      // Resumable, so the phone's list keeps it off the saved record.
      expect(spec.sessionId).toBeTruthy();
    }
  });

  it("refuses a machine the project does not have, or one without the code", async () => {
    for (const host of ["host:w9", "host:w2", "host:", "local", "elsewhere"]) {
      expect(await create({ host })).toMatchObject({ status: "error", code: "host_not_found" });
    }
    expect(made).not.toHaveBeenCalled();
  });

  it("starts a remote-only project's agent on its hosts alone, saved in the project's folder", async () => {
    // No mirror, so no phone folder (`scope.cwd` is ""): the tab is saved with
    // the project's directory as every host tab is; a synced-copy worker has
    // nothing feeding it (D4), and a create that names no machine starts here.
    const pinned: ProjectEntry = {
      ...rem,
      mirror: null,
      remote: { ...rem.remote, remote_only: true } as ProjectEntry["remote"],
      compute_hosts: [
        { id: "w1", host: "w1.invalid", user: "u", remote_path: "/srv" },
        { id: "w3", host: "w3.invalid", user: "u", remote_path: "/srv", shared_fs: true },
      ] as ProjectEntry["compute_hosts"],
    };
    useProjectsStore.setState({ projects: [pinned] } as never);
    for (const host of ["remote", "host:w3"]) {
      made.mockClear();
      expect(await create({ host, idempotency_key: `ro-key-${host}-0123456789` })).toMatchObject({ status: "created" });
      const options = made.mock.calls[0]?.[0] as { cwd: string; spec: Omit<TabEntry, "key"> };
      expect(options.cwd).toBe("/state/projects/rem");
      expect(options.spec).toMatchObject({ location: host, cwd: "/state/projects/rem", kind: "agent" });
    }
    made.mockClear();
    expect(await create({ host: "host:w1" })).toMatchObject({ status: "error", code: "host_not_found" });
    expect(await create({})).toMatchObject({ status: "error", code: "project_ineligible" });
    expect(await create({ kind: "shell", agent_id: undefined })).toMatchObject({ status: "error", code: "not_attachable" });
    expect(made).not.toHaveBeenCalled();
  });

  it("starts nothing on a host that runs on this machine", async () => {
    for (const extra of [{ worktree: "w" }, { cloud: "new" }, { api_key: true }, { local: "l1", agent_id: undefined }]) {
      expect(await create({ host: "remote", ...extra })).toMatchObject({ status: "error", code: "invalid_request" });
    }
    expect(made).not.toHaveBeenCalled();
  });
});

describe("Mobile ＋ sheet — Runs on", () => {
  const agents = [{ id: "claude", label: "Claude", modes: [] }];
  const options = (hosts: LaunchOptions["hosts"], worktrees: LaunchOptions["worktrees"] = []): LaunchOptions =>
    ({ worktrees, cloud: [{ agent_id: "claude", action: "new", task: false }], sign_in: [], hosts });
  const serve = (body: LaunchOptions) => fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  const sheet = (onPick = vi.fn(), headless = false) => {
    render(<NewTabSheet projectId="p" agents={agents} shells={false} busy={false} headless={headless} agentsOnly onPick={onPick} onSendFile={() => {}} onClose={() => {}} />);
    return onPick;
  };

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it("lists the desktop's copy and every machine, greying out one that is not connected", async () => {
    serve(options([
      { id: "m-primary", label: "h.invalid", primary: true, connected: true },
      { id: "m-w1", label: "gpu-1", primary: false, connected: false },
    ]));
    sheet();
    const picker = await screen.findByRole("combobox", { name: /^Runs on/ });
    const rows = within(picker).getAllByRole("option") as HTMLOptionElement[];
    expect(rows.map((row) => [row.textContent, row.disabled])).toEqual([
      ["Desktop (local copy)", false],
      ["h.invalid (primary)", false],
      ["gpu-1 · not connected", true],
    ]);
    expect(screen.getByText(/connect it in the project on the desktop/)).toBeTruthy();
  });

  it("starts the agent on the picked machine, with only the plain agents offered", async () => {
    serve(options(
      [{ id: "m-primary", label: "h.invalid", primary: true, connected: true }],
      [{ id: "w-main", label: "", main: true }, { id: "w-fix", label: "fix", branch: "fix", main: false }],
    ));
    const onPick = sheet();
    const picker = await screen.findByRole("combobox", { name: /^Runs on/ });
    expect(screen.getByRole("group", { name: "Agents start in" })).toBeTruthy();
    fireEvent.change(picker, { target: { value: "m-primary" } });
    // A worktree and a cloud session run on the desktop: neither is offered.
    expect(screen.queryByRole("group", { name: "Agents start in" })).toBeNull();
    expect(screen.queryByText("Cloud sessions")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claude" }));
    expect(onPick).toHaveBeenCalledWith("agent", agents[0], undefined, { host: "m-primary" });
  });

  it("shows no picker for a project without machines, or with no window", async () => {
    serve(options(undefined));
    sheet();
    await screen.findByText("Cloud sessions");
    expect(screen.queryByRole("combobox", { name: /^Runs on/ })).toBeNull();
    cleanup();
    serve(options([{ id: "m-primary", label: "h.invalid", primary: true, connected: true }]));
    sheet(vi.fn(), true);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("combobox", { name: /^Runs on/ })).toBeNull();
  });
});
