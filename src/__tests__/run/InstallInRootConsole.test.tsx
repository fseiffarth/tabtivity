/**
 * One-click installs surface in the ROOT CONSOLE — the one overlay onto the
 * root terminal. They used to float a second, smaller overlay of their own
 * (`InstallOverlay`) on the install tab's PTY; `runInstallInTab` now opens the
 * tab through `openTabInRootConsole`, the door a parked login takes too. These
 * tests lock that door: the tab lands in the root scope with the console open
 * on it, the active project stays put, and a root that was never restored this
 * session is restored BEFORE the tab is added — adding first would mark the
 * scope hydrated and let the host's persist write the lone install tab over
 * the saved root layout.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { runInstallInTab } from "../../lib/installCommand";
import { openConnectionInRoot, forgetConnection } from "../../lib/remote/remoteConnect";
import { allGroups, useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { BRAND } from "../../lib/brand";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ rootDir: `/home/u/${BRAND.slug}/root`, activeId: "p1", switchToast: null });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
});

describe("runInstallInTab", () => {
  it("opens the root tab and the root console on it, leaving the project alone", () => {
    const shell = useTabsStore
      .getState()
      .addTabToScope("root", { label: "Shell", cmd: "", cwd: "/r", kind: "shell" });

    runInstallInTab("Install LaTeX", "sudo apt-get install -y texlive", "bash");

    const install = rootTabs().find((tab) => tab.key !== shell.key);
    expect(install).toBeTruthy();
    expect(install?.label).toBe("Install LaTeX");
    expect(install?.cmd).toBe("/bin/bash");
    expect(install?.initialInput).toBe("sudo apt-get install -y texlive");

    expect(useRootOverlayStore.getState().open).toBe(true);
    // The install is the tab in front, not merely one of the console's tabs.
    const groups = allGroups(useTabsStore.getState().layoutByScope.root ?? null);
    expect(groups.some((g) => g.activeKey === install?.key)).toBe(true);

    expect(useProjectsStore.getState().activeId).toBe("p1");
    expect(useTabsStore.getState().scope).toBe("p1");
  });

  it("marks the install's tab so the console can pulse it, and only that tab", () => {
    const shell = useTabsStore
      .getState()
      .addTabToScope("root", { label: "Shell", cmd: "", cwd: "/r", kind: "shell" });

    runInstallInTab("Install LaTeX", "sudo apt-get install -y texlive", "bash");

    const install = rootTabs().find((tab) => tab.key !== shell.key);
    expect(useRootOverlayStore.getState().installTabs).toEqual({ [install!.key]: true });
    useRootOverlayStore.getState().clearInstallTab(install!.key);
    expect(useRootOverlayStore.getState().installTabs).toEqual({});
  });

  it("restores a root never opened this session before adding the install tab", async () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    vi.mocked(invoke).mockImplementation((cmd: string) =>
      Promise.resolve(
        cmd === "workspace_snapshot"
          ? { tabLayout: [{ label: "Saved shell", cmd: "", cwd: "/r", kind: "shell" }] }
          : "/r",
      ),
    );

    runInstallInTab("Install gh", "sudo apt-get install -y gh", "bash");
    // Nothing is added until the saved layout is in.
    expect(rootTabs()).toHaveLength(0);

    await vi.waitFor(() => expect(useRootOverlayStore.getState().open).toBe(true));
    expect(rootTabs().map((tab) => tab.label)).toEqual(["Saved shell", "Install gh"]);
  });
});

describe("openConnectionInRoot", () => {
  it("takes the same door, and a request landing mid-restore opens no second login", async () => {
    useTabsStore.setState({ tabsByScope: {}, layoutByScope: {}, focusedGroupByScope: {} });
    forgetConnection("vpn:/x.ovpn");

    openConnectionInRoot({ label: "VPN", command: "openvpn x", dedupeKey: "vpn:/x.ovpn" });
    openConnectionInRoot({ label: "VPN", command: "openvpn x", dedupeKey: "vpn:/x.ovpn" });

    await vi.waitFor(() => expect(useRootOverlayStore.getState().open).toBe(true));
    expect(rootTabs().map((tab) => tab.label)).toEqual(["VPN"]);
  });
});
