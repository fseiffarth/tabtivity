import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { PhoneShareDialogHost } from "../../components/mobile/PhoneShareDialog";
import {
  askToShareNewProject,
  PAIRING_WATCH_MS,
  usePhoneShareStore,
  watchPairing,
} from "../../stores/phoneShare";
import { useProjectsStore } from "../../stores/projects";
import { useBoxesStore } from "../../stores/boxes";
import { useSettingsStore } from "../../stores/settings";
import { useBigFoldersStore } from "../../stores/bigFolders";
import type { ProjectBox, ProjectEntry, Settings } from "../../types";
import { MOBILE_ACCESS_KEY, MOBILE_DEVICES_KEY, MOBILE_HOST_KEY } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

/** Device ids as the sidecar mints them: 27 chars of base64url. */
const PIXEL = "pixelpixelpixelpixelpixel01";
const IPAD = "ipadipadipadipadipadipad_02";
const NEW = "newnewnewnewnewnewnewnew_03";

const entry = (id: string, name: string, extra: Partial<ProjectEntry> = {}): ProjectEntry => ({
  id,
  name,
  status: "active",
  position: 1,
  local_file: `/projects/${id}/project.json`,
  ...extra,
});

let paired: { id: string; name: string; created_at: number }[] = [];
const accessCalls: { command: string; id: string; enabled: boolean; devices: string[] | null }[] = [];

function mobileOn(on: boolean) {
  useSettingsStore.setState({ settings: { [MOBILE_HOST_KEY]: { enabled: on } } as unknown as Settings });
}

beforeEach(() => {
  paired = [
    { id: PIXEL, name: "Pixel", created_at: 1 },
    { id: IPAD, name: "iPad", created_at: 2 },
  ];
  accessCalls.length = 0;
  invokeMock.mockImplementation((command: string, args?: unknown) => {
    const a = args as { projectId?: string; boxId?: string; enabled: boolean; devices: string[] | null };
    if (command === "mobile_paired_devices") return Promise.resolve(paired);
    if (command === "set_project_mobile_access") {
      accessCalls.push({ command, id: a.projectId!, enabled: a.enabled, devices: a.devices });
      return Promise.resolve({ enabled: a.enabled, devices: a.devices });
    }
    if (command === "set_box_mobile_access") {
      accessCalls.push({ command, id: a.boxId!, enabled: a.enabled, devices: a.devices });
      const box = useBoxesStore.getState().boxes.find((b) => b.id === a.boxId);
      return Promise.resolve({ ...box, [MOBILE_ACCESS_KEY]: a.enabled || undefined, [MOBILE_DEVICES_KEY]: a.devices ?? undefined });
    }
    return Promise.resolve(null);
  });
  usePhoneShareStore.setState({ queue: [], pairedSeq: 0 });
  useBigFoldersStore.setState({ projectId: null });
  useProjectsStore.setState({
    projects: [
      entry("fresh", "Fresh project"),
      entry("everyone", "Everyone", { [MOBILE_ACCESS_KEY]: true }),
      entry("ipad-only", "iPad only", { [MOBILE_ACCESS_KEY]: true, [MOBILE_DEVICES_KEY]: [IPAD] }),
    ],
    loaded: true,
  });
  useBoxesStore.setState({
    boxes: [{ id: "box1", name: "Thesis box" } as unknown as ProjectBox],
  });
  mobileOn(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  invokeMock.mockReset();
});

describe("a project added on the desktop", () => {
  it("is asked about only with Mobile on and a phone paired", async () => {
    mobileOn(false);
    await askToShareNewProject("fresh");
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);

    mobileOn(true);
    paired = [];
    await askToShareNewProject("fresh");
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);

    paired = [{ id: PIXEL, name: "Pixel", created_at: 1 }];
    await askToShareNewProject("fresh");
    expect(usePhoneShareStore.getState().queue).toEqual([
      { kind: "project", projectId: "fresh", phones: paired },
    ]);
  });

  it("opens it to every phone when every phone stays ticked", async () => {
    const user = userEvent.setup();
    await askToShareNewProject("fresh");
    render(<PhoneShareDialogHost />);
    expect(screen.getByText(/Open “Fresh project” on your phone\?/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open on phone" }));
    await waitFor(() => expect(usePhoneShareStore.getState().queue).toHaveLength(0));
    expect(accessCalls).toEqual([{ command: "set_project_mobile_access", id: "fresh", enabled: true, devices: null }]);
  });

  it("writes the ticked phones as the list when one is unticked", async () => {
    const user = userEvent.setup();
    await askToShareNewProject("fresh");
    render(<PhoneShareDialogHost />);
    await user.click(screen.getByRole("checkbox", { name: "iPad" }));
    await user.click(screen.getByRole("button", { name: "Open on phone" }));
    await waitFor(() => expect(accessCalls).toHaveLength(1));
    expect(accessCalls[0]).toMatchObject({ id: "fresh", enabled: true, devices: [PIXEL] });
  });

  it("Not now writes nothing, and the ask waits behind the large-folder prompt", async () => {
    const user = userEvent.setup();
    useBigFoldersStore.setState({ projectId: "fresh" });
    await askToShareNewProject("fresh");
    render(<PhoneShareDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useBigFoldersStore.setState({ projectId: null }));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);
    expect(accessCalls).toHaveLength(0);
  });
});

describe("a phone that just paired", () => {
  it("is found by the pairing watch, which then stops and drops the code", async () => {
    vi.useFakeTimers();
    watchPairing([PIXEL, IPAD], Math.floor(Date.now() / 1000) + 300);
    await vi.advanceTimersByTimeAsync(PAIRING_WATCH_MS);
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);

    paired = [...paired, { id: NEW, name: "New phone", created_at: 3 }];
    await vi.advanceTimersByTimeAsync(PAIRING_WATCH_MS);
    expect(usePhoneShareStore.getState().queue).toEqual([{ kind: "phone", deviceId: NEW, deviceName: "New phone" }]);
    expect(usePhoneShareStore.getState().pairedSeq).toBe(1);

    paired = [...paired, { id: "anotheranotheranotheranoth4", name: "Another", created_at: 4 }];
    await vi.advanceTimersByTimeAsync(PAIRING_WATCH_MS * 3);
    expect(usePhoneShareStore.getState().queue).toHaveLength(1);
  });

  it("stops watching once the code has expired", async () => {
    vi.useFakeTimers();
    watchPairing([PIXEL, IPAD], Math.floor(Date.now() / 1000) + 1);
    await vi.advanceTimersByTimeAsync(PAIRING_WATCH_MS * 2);
    paired = [...paired, { id: NEW, name: "New phone", created_at: 3 }];
    await vi.advanceTimersByTimeAsync(PAIRING_WATCH_MS * 2);
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);
  });

  it("starts with nothing ticked, shows every-phone projects as on, and adds the phone to what is ticked", async () => {
    const user = userEvent.setup();
    paired = [...paired, { id: NEW, name: "New phone", created_at: 3 }];
    usePhoneShareStore.getState().push({ kind: "phone", deviceId: NEW, deviceName: "New phone" });
    render(<PhoneShareDialogHost />);
    expect(screen.getByText(/Which projects should New phone reach\?/)).toBeTruthy();

    const everyone = screen.getByRole("checkbox", { name: "Everyone" }) as HTMLInputElement;
    expect(everyone.checked).toBe(true);
    expect(everyone.disabled).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Fresh project" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("button", { name: "Done" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: "Fresh project" }));
    await user.click(screen.getByRole("checkbox", { name: "iPad only" }));
    await user.click(screen.getByRole("checkbox", { name: "Thesis box" }));
    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(usePhoneShareStore.getState().queue).toHaveLength(0));
    expect(accessCalls).toEqual([
      { command: "set_project_mobile_access", id: "fresh", enabled: true, devices: [NEW] },
      { command: "set_project_mobile_access", id: "ipad-only", enabled: true, devices: [IPAD, NEW] },
      { command: "set_box_mobile_access", id: "box1", enabled: true, devices: [NEW] },
    ]);
  });

  it("Skip writes nothing", async () => {
    const user = userEvent.setup();
    usePhoneShareStore.getState().push({ kind: "phone", deviceId: NEW, deviceName: "New phone" });
    render(<PhoneShareDialogHost />);
    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(usePhoneShareStore.getState().queue).toHaveLength(0);
    expect(accessCalls).toHaveLength(0);
  });
});
