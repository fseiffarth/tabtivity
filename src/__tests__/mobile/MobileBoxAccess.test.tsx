/**
 * A project box reaches the phone (#31aa).
 *
 * A box's `box:<id>` scope has its own tabs, its own session file and its own
 * tmux names, so the sidecar lists it as a scope of its own once its Mobile
 * switch is on. On the desktop side that switch is a row of Mobile settings'
 * access list, and the bridge resolves the scope id the sidecar hands it the
 * way it resolves a project id — through the box's own switch, never a
 * member's.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(), emit: vi.fn() }));

import { MobileBridgeHost } from "../../components/mobile/MobileBridgeHost";
import { MobileSettings } from "../../components/mobile/MobileSettings";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore } from "../../stores/tabs";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectBox, ProjectEntry, Settings } from "../../types";
import { BRAND, MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY, NAMES } from "../../lib/brand";

/** The member keeps its own switch OFF: the box's switch is the consent. */
const member: ProjectEntry = {
  id: "p-lib",
  name: "Lib",
  status: "inactive",
  position: 1,
  local_file: "/projects/lib/project.json",
};

const paper: ProjectBox = {
  id: "b1",
  name: "Paper",
  member_ids: [member.id],
  position: 10,
  folder: "/boxes/paper",
  [MOBILE_ACCESS_KEY]: true,
};
const privateBox: ProjectBox = {
  id: "b2",
  name: "Private",
  member_ids: [member.id],
  position: 20,
  folder: "/boxes/private",
};

const TMUX = `${BRAND.slug}-box_b1--agent-123456789`;

async function ask(request: Record<string, unknown>) {
  const listener = vi.mocked(listen).mock.calls.find(([name]) => name === NAMES.mobileDesktopEvent);
  const deliver = listener![1] as (event: { payload: unknown }) => void;
  const invokeMock = vi.mocked(invoke);
  invokeMock.mockClear();
  deliver({ payload: request });
  await vi.waitFor(() => expect(invokeMock.mock.calls.some(
    ([command]) => command === "mobile_desktop_respond",
  )).toBe(true));
  const call = invokeMock.mock.calls.find(([command]) => command === "mobile_desktop_respond");
  return (call?.[1] as { response: Record<string, unknown> }).response;
}

describe("Mobile bridge — a box scope", () => {
  beforeEach(async () => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "list_agents") return Promise.resolve([]);
      if (command === "agent_schedules_list") return Promise.resolve([]);
      if (command === "ensure_box_folder") return Promise.resolve(paper.folder);
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [member], activeId: null, loaded: true });
    useBoxesStore.setState({ boxes: [paper, privateBox], loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
    useTabsStore.setState({
      scope: "root",
      tabsByScope: {
        "box:b1": [
          { key: "agent-1", label: "Claude", kind: "agent", cmd: "claude", cwd: "/projects/lib", tmuxSession: TMUX },
        ] satisfies TabEntry[],
        "box:b2": [
          { key: "agent-2", label: "Claude", kind: "agent", cmd: "claude", cwd: "/boxes/private", tmuxSession: `${BRAND.slug}-box_b2--agent-223456789` },
        ] satisfies TabEntry[],
      },
    });
    useActivityStore.setState({ busyByTab: { "box:b1:agent-1": true, "box:b2:agent-2": true } });
    render(<MobileBridgeHost />);
    await vi.waitFor(() => expect(vi.mocked(listen).mock.calls.length).toBeGreaterThan(0));
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    vi.mocked(listen).mockReset();
    useActivityStore.setState({ busyByTab: {}, attentionByTab: {}, attentionByScope: {} });
    useBoxesStore.setState({ boxes: [], loaded: false });
  });

  it("answers the box's own catalog with its agent tab's state", async () => {
    const response = await ask({ type: "catalog", request_id: "r1", project_id: "box:b1" });
    expect(response.status).toBe("catalog");
    expect(response.statuses).toMatchObject([{ tmux_session: TMUX, status: "working" }]);
  });

  it("lists the box's tabs in the activity feed, and not those of a box with Mobile off", async () => {
    const response = await ask({ type: "activity", request_id: "r2" });
    expect(response.statuses).toMatchObject([{ tmux_session: TMUX, status: "working" }]);
    expect((response.statuses as { tmux_session: string }[]).map((row) => row.tmux_session)).toEqual([TMUX]);
  });

  it("refuses a box whose switch is off, whatever its members say", async () => {
    const response = await ask({ type: "catalog", request_id: "r3", project_id: "box:b2" });
    expect(response.statuses).toEqual([]);
    const seen = await ask({ type: "tab_seen", request_id: "r4", project_id: "box:b2", tmux_session: `${BRAND.slug}-box_b2--agent-223456789` });
    expect(seen).toMatchObject({ status: "error", code: "project_ineligible" });
  });

  it("activating a box opens it the way the switcher's pill does", async () => {
    const response = await ask({ type: "activate", request_id: "r5", project_id: "box:b1" });
    expect(response.status).toBe("activated");
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("ensure_box_folder", { boxId: "b1" });
    expect(useTabsStore.getState().scope).toBe("box:b1");
  });
});

describe("Mobile settings — box access rows", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command: string) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: false, running: false, update_available: false });
      if (command === "mobile_tailscale_serve_status") return Promise.resolve({ installed: false });
      if (command === "mobile_admin") return Promise.resolve({ status: "devices", devices: [] });
      if (command === "set_box_mobile_access") return Promise.resolve({ ...paper, folder: "/boxes/paper" });
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [member], activeId: null, loaded: true });
    useBoxesStore.setState({ boxes: [{ ...paper, folder: undefined, [MOBILE_ACCESS_KEY]: undefined }], loaded: true });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    useBoxesStore.setState({ boxes: [], loaded: false });
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("offers one switch per box beside the project switches and writes it through the backend", async () => {
    const user = userEvent.setup();
    render(<MobileSettings />);
    const toggle = await screen.findByRole("checkbox", { name: "Paper" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    await waitFor(() => {
      // One click on is every phone; the list is the ▾ picker's job.
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_box_mobile_access", { boxId: "b1", enabled: true, devices: null });
    });
    // The backend answers with the record it wrote — the switch on and the
    // folder it resolved — and the store takes that record as it is.
    await waitFor(() => expect(useBoxesStore.getState().boxes[0]).toMatchObject({ [MOBILE_ACCESS_KEY]: true, folder: "/boxes/paper" }));
    expect((screen.getByRole("checkbox", { name: "Paper" }) as HTMLInputElement).checked).toBe(true);
  });
});

describe("Mobile settings — which phones a row reaches", () => {
  const PIXEL = "pixelpixelpixelpixelpixel01";
  const IPAD = "ipadipadipadipadipadipad_02";
  const REVOKED = "revokedrevokedrevokedrevo03";
  const shared: ProjectEntry = { ...member, id: "p-shared", name: "Shared", [MOBILE_ACCESS_KEY]: true };

  beforeEach(() => {
    vi.mocked(invoke).mockImplementation((command: string, args?: unknown) => {
      if (command === "mobile_host_status") return Promise.resolve({ configured: true, running: true, update_available: false });
      if (command === "mobile_tailscale_serve_status") return Promise.resolve({ installed: false });
      if (command === "mobile_admin") {
        return Promise.resolve({
          status: "devices",
          devices: [
            { id: PIXEL, name: "Pixel", created_at: 1_790_000_000, online: true },
            { id: IPAD, name: "iPad", created_at: 1_790_000_000, online: false },
          ],
        });
      }
      if (command === "mobile_paired_devices") {
        return Promise.resolve([
          { id: PIXEL, name: "Pixel", created_at: 1_790_000_000 },
          { id: IPAD, name: "iPad", created_at: 1_790_000_000 },
        ]);
      }
      if (command === "set_box_mobile_access") {
        const { boxId, enabled, devices } = args as { boxId: string; enabled: boolean; devices: string[] | null };
        const box = useBoxesStore.getState().boxes.find((b) => b.id === boxId)!;
        return Promise.resolve({ ...box, [MOBILE_ACCESS_KEY]: enabled, [MOBILE_DEVICES_KEY]: devices ?? undefined });
      }
      if (command === "set_project_mobile_access") {
        const { enabled, devices } = args as { enabled: boolean; devices: string[] | null };
        return Promise.resolve({ enabled, devices });
      }
      return Promise.resolve(undefined);
    });
    vi.mocked(listen).mockResolvedValue(() => {});
    useProjectsStore.setState({ projects: [member, shared], activeId: null, loaded: true });
    useBoxesStore.setState({
      boxes: [
        { ...paper, [MOBILE_DEVICES_KEY]: [PIXEL, REVOKED] },
        { ...privateBox, [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: [REVOKED] },
      ],
      loaded: true,
    });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true });
  });

  afterEach(() => {
    cleanup();
    vi.mocked(invoke).mockReset();
    useBoxesStore.setState({ boxes: [], loaded: false });
    useSettingsStore.setState({ settings: null, loaded: false });
  });

  it("labels each enabled row with its reach, counting only phones still paired", async () => {
    render(<MobileSettings />);
    // A project with no list reaches every phone.
    expect(await screen.findByRole("button", { name: "All phones ▾" })).toBeTruthy();
    // Paper names one paired phone and one revoked: one phone.
    expect(await screen.findByRole("button", { name: "1 phone ▾" })).toBeTruthy();
    // Private names only a revoked phone: on, but reaching none — warned.
    const none = await screen.findByRole("button", { name: "No phones ▾" });
    expect(none.className).toContain("warning");
    // The switch keeps its own name beside the button.
    expect((screen.getByRole("checkbox", { name: "Paper" }) as HTMLInputElement).checked).toBe(true);
  });

  it("opens the same picker for a box and writes the ticked phones with the current list", async () => {
    const user = userEvent.setup();
    render(<MobileSettings />);
    // Counted against the paired phones once they are read (until then a
    // list counts as stored).
    await screen.findByRole("button", { name: "No phones ▾" });
    await user.click(screen.getByRole("button", { name: "1 phone ▾" }));

    expect(screen.getByText(/The box's own list decides/)).toBeTruthy();
    expect(screen.getByText(/counts as a new phone/)).toBeTruthy();
    const ipad = await screen.findByRole("menuitemcheckbox", { name: "iPad" });
    expect(screen.getByRole("menuitemcheckbox", { name: "Pixel" }).getAttribute("aria-checked")).toBe("true");
    await user.click(ipad);

    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_box_mobile_access", { boxId: "b1", enabled: true, devices: [PIXEL, IPAD] });
    });
    await waitFor(() => expect(screen.getAllByRole("button", { name: "2 phones ▾" }).length).toBe(1));
  });

  it("widens a project to every phone only when All phones is picked", async () => {
    const user = userEvent.setup();
    useProjectsStore.setState({ projects: [member, { ...shared, [MOBILE_DEVICES_KEY]: [IPAD] }] });
    render(<MobileSettings />);
    await screen.findByRole("button", { name: "No phones ▾" });
    const row = screen.getByRole("checkbox", { name: "Shared" }).closest(".settings-card-row") as HTMLElement;
    await user.click(within(row).getByRole("button", { name: "1 phone ▾" }));
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith("set_project_mobile_access", expect.anything());

    await user.click(screen.getByRole("menuitemradio", { name: "All phones" }));
    await waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith("set_project_mobile_access", { projectId: "p-shared", enabled: true, devices: null });
    });
    await waitFor(() => expect(useProjectsStore.getState().projects[1][MOBILE_DEVICES_KEY]).toBeUndefined());
  });
});
