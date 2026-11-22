/**
 * Local → Remote-only (`docs/done/remote_only_projects_plan.md` D7): the Extend
 * dialog's "Keep a local copy" switch. Off, the project is extended as usual
 * (lockstep carries the history up) and `onExtended(false)` hands it to the
 * pill's Stop-keeping check; the big-folders prompt is skipped, since nothing
 * syncs once the copy is dropped. A project without git keeps its copy: the
 * switch is locked on.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../../components/terminal/TerminalView", () => ({ TerminalView: () => null }));

import { ExtendToRemoteDialog } from "../../components/projects/ExtendToRemoteDialog";
import { useProjectsStore } from "../../stores/projects";
import { useRemoteStatusStore } from "../../stores/remote/remoteStatus";
import { useSettingsStore } from "../../stores/settings";
import { useBigFoldersStore } from "../../stores/bigFolders";
import type { ProjectEntry } from "../../types";

const invokeMock = vi.mocked(invoke);

const project = (git_type: string | undefined) =>
  ({
    id: "p1",
    name: "sshtest",
    directory: "/home/u/projects/sshtest",
    position: 0,
    status: "active",
    git_type,
  }) as unknown as ProjectEntry;

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation((cmd: string) => {
    if (cmd === "remote_saved_password_state") return Promise.resolve({ saved: false, keyring: "unlocked" });
    if (cmd === "ssh_connect") return Promise.resolve({ saved: false, save_error: null });
    if (cmd === "vpn_has_saved_password") return Promise.resolve(false);
    if (cmd === "openvpn_list_configs" || cmd === "ssh_list_addresses" || cmd === "remote_list_paths")
      return Promise.resolve([]);
    if (cmd === "ssh_tooling_status") return Promise.resolve({ password_auth: true, openvpn: true });
    if (cmd === "ssh_default_dir") return Promise.resolve("/home/alice");
    if (cmd === "ssh_list_dir") return Promise.resolve([]);
    return Promise.resolve();
  });
  useSettingsStore.setState({ settings: { connections_headless: true } as never });
  useProjectsStore.setState({
    projects: [project("local")],
    extendProjectToRemote: vi.fn(() => Promise.resolve()),
  } as never);
  useRemoteStatusStore.setState({ byProject: {} } as never);
});

/** Connect, take the browsed folder, and land on the details step. */
async function toDetails() {
  await userEvent.type(await screen.findByPlaceholderText(/user@host/i), "alice@host.example");
  await userEvent.click(screen.getByRole("button", { name: /^connect$/i }));
  await userEvent.click(await screen.findByRole("button", { name: /use this folder/i }));
}

const keepSwitch = () => document.querySelector(".toggle-card input[type=checkbox]") as HTMLInputElement;

describe("Extend dialog · Keep a local copy", () => {
  it("off: titles the move remote-only, extends, and hands over without the big-folders prompt", async () => {
    const openOnce = vi.spyOn(useBigFoldersStore.getState(), "openOnce");
    const onExtended = vi.fn();
    render(
      <ExtendToRemoteDialog project={project("local")} initialKeepLocalCopy={false} onExtended={onExtended} onClose={() => {}} />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Make “sshtest” remote only");
    expect(screen.getByText(/^Move this project onto an SSH host\./)).toBeTruthy();
    expect(screen.queryByText(/Nothing is uploaded until you push it manually/)).toBeNull();
    await toDetails();
    expect(keepSwitch().checked).toBe(false);
    expect(screen.getByText("Local (kept)")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Move to host" }));
    await waitFor(() => expect(onExtended).toHaveBeenCalledWith(false));
    expect(useProjectsStore.getState().extendProjectToRemote).toHaveBeenCalled();
    expect(openOnce).not.toHaveBeenCalled();
    openOnce.mockRestore();
  });

  it("switching it back on is a plain extend", async () => {
    const onExtended = vi.fn();
    render(
      <ExtendToRemoteDialog project={project("local")} initialKeepLocalCopy={false} onExtended={onExtended} onClose={() => {}} />,
    );
    await toDetails();
    await userEvent.click(keepSwitch());
    expect(screen.getByRole("heading").textContent).toBe("Extend “sshtest” to remote");
    await userEvent.click(screen.getByRole("button", { name: "Extend to remote" }));
    await waitFor(() => expect(onExtended).toHaveBeenCalledWith(true));
  });

  it("is locked on for a project without git: nothing would reach the host", async () => {
    for (const gitType of ["none", undefined]) {
      const onExtended = vi.fn();
      const { unmount } = render(
        <ExtendToRemoteDialog project={project(gitType)} initialKeepLocalCopy={false} onExtended={onExtended} onClose={() => {}} />,
      );
      await toDetails();
      expect(keepSwitch().checked).toBe(true);
      expect(keepSwitch().disabled).toBe(true);
      expect(screen.getByText(/This project has no git/)).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Extend to remote" }));
      await waitFor(() => expect(onExtended).toHaveBeenCalledWith(true));
      unmount();
    }
  });
});
