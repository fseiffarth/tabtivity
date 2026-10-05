import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import {
  DevBuildIndicator,
  buildProgress,
  formatDuration,
} from "../../components/header/DevBuildIndicator";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useHeaderStatusStore } from "../../stores/headerStatus";
import { BRAND } from "../../lib/brand";

const invokeMock = vi.mocked(invoke);

const idle = {
  state: "idle",
  phase: null,
  commit: null,
  startedAt: null,
  estimateSecs: 420,
  queued: false,
  failed: null,
  installed: "99e2c74",
  behind: 0,
  relaunch: false,
  adoptable: null,
  canRelaunch: false,
  paused: false,
  logPath: `/h/.local/share/${BRAND.slug}/package-dev-auto.log`,
};

function answer(status: unknown) {
  invokeMock.mockImplementation((command: string) =>
    Promise.resolve(command === "dev_build_status" ? status : null),
  );
}

describe("dev-build chip helpers", () => {
  it("formats minutes and seconds", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(75.4)).toBe("1:15");
    expect(formatDuration(-3)).toBe("0:00");
  });

  it("estimates from the last build and never claims to be done", () => {
    expect(buildProgress(60, 240)).toBe(0.25);
    expect(buildProgress(900, 240)).toBe(0.95);
    expect(buildProgress(60, null)).toBeNull();
    expect(buildProgress(60, 0)).toBeNull();
  });
});

describe("DevBuildIndicator", () => {
  beforeEach(() => {
    useHeaderHoverMenuStore.setState({ openId: null });
    useHeaderStatusStore.setState({ reports: {} });
  });

  afterEach(() => {
    // Unmount first: a poll firing between a reset mock and RTL's own cleanup
    // gets `undefined` back instead of a promise.
    cleanup();
    invokeMock.mockReset();
  });

  it("renders nothing and joins no cluster in a release build", async () => {
    answer(null);
    const { container } = render(<DevBuildIndicator />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_status"));
    expect(container.innerHTML).toBe("");
    expect(useHeaderStatusStore.getState().reports.devBuild).toBeUndefined();
  });

  it("shows the running step and reports attention", async () => {
    answer({
      ...idle,
      state: "building",
      phase: "cargo",
      commit: "30ed347",
      startedAt: Math.floor(Date.now() / 1000) - 65,
    });
    render(<DevBuildIndicator />);
    // Loose on the clock and patient on the wait: a loaded full-suite run can
    // take more than the default second to render, and a second or two more
    // on the clock.
    expect(await screen.findByText(/^Compiling 1:\d\d$/, undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("attention"));
    expect(screen.getByLabelText("Dev build: Building 30ed347: Compiling")).toBeTruthy();
  });

  it("reports a failed build as an alert", async () => {
    answer({ ...idle, failed: { commit: "abc1234", status: "1", when: "2026-09-18T10:00:00+02:00" } });
    render(<DevBuildIndicator />);
    expect(await screen.findByText("failed", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("alert"));
  });

  it("is a quiet member when the snapshot is current", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 });
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("ok"));
  });

  it("offers no relaunch unless the backend says one would open something newer", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 }));
    await screen.findByText("Follow build log");
    expect(screen.queryByText("Relaunch now")).toBeNull();
  });

  it("relaunches onto a built snapshot and shows a refusal", async () => {
    invokeMock.mockImplementation((command: string) =>
      command === "dev_build_status"
        ? Promise.resolve({ ...idle, adoptable: "30ed347", canRelaunch: true })
        : command === "dev_build_relaunch"
          ? Promise.reject(`this window is not the frozen ${BRAND.display} (dev) binary`)
          : Promise.resolve(null),
    );
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 }));
    expect(await screen.findByText(/A newer snapshot \(30ed347\) is built/)).toBeTruthy();
    fireEvent.click(screen.getByText("Relaunch now"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_relaunch"));
    expect(await screen.findByText(`this window is not the frozen ${BRAND.display} (dev) binary`)).toBeTruthy();
    expect(screen.getByText("Relaunch now")).toBeTruthy();
  });

  it("pauses auto-builds from the menu", async () => {
    answer(idle);
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Up to date (99e2c74)", undefined, { timeout: 5000 }));
    fireEvent.click(await screen.findByText("Pause auto-builds"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_set_paused", { paused: true }));
  });

  it("shows a paused build as a quiet member and resumes it", async () => {
    answer({ ...idle, paused: true, behind: 3 });
    render(<DevBuildIndicator />);
    expect(await screen.findByText("paused", undefined, { timeout: 5000 })).toBeTruthy();
    await waitFor(() => expect(useHeaderStatusStore.getState().reports.devBuild?.tone).toBe("ok"));
    fireEvent.click(screen.getByLabelText("Dev build: Auto-builds paused"));
    fireEvent.click(await screen.findByText("Resume auto-builds"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_set_paused", { paused: false }));
  });

  it("builds a newer HEAD once while paused", async () => {
    answer({ ...idle, paused: true, behind: 3 });
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Auto-builds paused", undefined, { timeout: 5000 }));
    expect(await screen.findByText("Behind HEAD by 3")).toBeTruthy();
    fireEvent.click(screen.getByText("Build now"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("dev_build_now"));
    expect(invokeMock).not.toHaveBeenCalledWith("dev_build_set_paused", expect.anything());
  });

  it("offers no build now when nothing is newer or auto-builds run", async () => {
    answer({ ...idle, paused: true, behind: 0 });
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Auto-builds paused", undefined, { timeout: 5000 }));
    await screen.findByText("Resume auto-builds");
    expect(screen.queryByText("Build now")).toBeNull();
    cleanup();
    answer({ ...idle, behind: 3 });
    render(<DevBuildIndicator />);
    fireEvent.click(await screen.findByLabelText("Dev build: Behind HEAD by 3", undefined, { timeout: 5000 }));
    await screen.findByText("Pause auto-builds");
    expect(screen.queryByText("Build now")).toBeNull();
  });
});
