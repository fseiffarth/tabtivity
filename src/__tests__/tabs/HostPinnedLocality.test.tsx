/**
 * The host pin (`isHostPinned`, `docs/remote_only_projects_plan.md` F1): a VM
 * or remote-only project has no local copy, so its tabs run only on its hosts.
 * The predicate, the one refusal mapper, and the locality controls that read
 * it — the badge says ☁, its menu has no Local (mirror) row, and the file
 * viewer's Run: picker drops "this computer" the same way.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { isHostPinned, remoteOnlyRefusal, REMOTE_ONLY_SENTINEL } from "../../lib/projectTabHost";
import { BRAND } from "../../lib/brand";
import { translateNow } from "../../lib/i18n";
import { LocalityMenu, RunHostPicker, TabLocalityBadge } from "../../components/tabs/TabLocalityBadges";
import { useRunHostPrefStore } from "../../stores/remote/runHostPref";
import type { TabEntry } from "../../stores/tabs";

const remote = { host: "h.invalid", remote_path: "/srv/p" };

describe("isHostPinned", () => {
  it("pins a VM and a remote-only project, and nothing else", () => {
    expect(isHostPinned(undefined)).toBe(false);
    expect(isHostPinned(null)).toBe(false);
    expect(isHostPinned({})).toBe(false);
    expect(isHostPinned({ remote })).toBe(false);
    expect(isHostPinned({ remote: { ...remote, remote_only: true } })).toBe(true);
    expect(isHostPinned({ remote: { ...remote, remote_only: false } })).toBe(false);
    // A VM is remote-only by default (the spec's `vm`), and by its record
    // however its spec reads.
    expect(isHostPinned({ remote: { ...remote, vm: true } })).toBe(true);
    // An explicit `remote_only: false` never unpins a VM (Rust twin agrees).
    expect(isHostPinned({ remote: { ...remote, vm: true, remote_only: false } })).toBe(true);
    expect(isHostPinned({ vm: { enabled: true } })).toBe(true);
    expect(isHostPinned({ vm: { enabled: true }, remote: { ...remote, remote_only: false } })).toBe(true);
    expect(isHostPinned({ vm: { enabled: false }, remote })).toBe(false);
  });
});

describe("remoteOnlyRefusal", () => {
  it("turns the backend's sentinel into the translated line, never its raw text", () => {
    expect(REMOTE_ONLY_SENTINEL).toBe(`${BRAND.upper}_REMOTE_ONLY`);
    const line = remoteOnlyRefusal(`${REMOTE_ONLY_SENTINEL}: a local spawn for tab 't1' was refused`);
    expect(line).toBe(translateNow("tabs.remoteOnlyRefused"));
    expect(remoteOnlyRefusal(new Error(`${REMOTE_ONLY_SENTINEL}: local_agent`))).toBe(translateNow("tabs.remoteOnlyRefused"));
  });

  it("answers null for any other error", () => {
    expect(remoteOnlyRefusal("ssh: connect to host h.invalid: Connection refused")).toBeNull();
    expect(remoteOnlyRefusal(new Error(`${BRAND.upper}_VM_DOWN: the VM is not running`))).toBeNull();
    expect(remoteOnlyRefusal(undefined)).toBeNull();
  });
});

const agentTab = (location?: TabEntry["location"]): TabEntry =>
  ({ key: "t1", label: "Claude", cmd: "claude", cwd: "/state/p", kind: "agent", ...(location ? { location } : {}) }) as TabEntry;

describe("the locality badge on a pinned project", () => {
  it("shows ☁ for an agent that stored local, and opens on the machine list", () => {
    const onOpen = vi.fn();
    const { container } = render(<TabLocalityBadge tab={agentTab("local")} pinned primaryHost="h" onOpen={onOpen} />);
    const badge = container.querySelector(".tab-locality");
    expect(badge?.classList.contains("remote")).toBe(true);
    fireEvent.click(badge!);
    expect(onOpen).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("still says ⌂ for the same tab of an ordinary remote project", () => {
    const { container } = render(<TabLocalityBadge tab={agentTab("local")} primaryHost="h" onOpen={vi.fn()} />);
    expect(container.querySelector(".tab-locality")?.classList.contains("local")).toBe(true);
  });
});

describe("LocalityMenu on a pinned project", () => {
  const menu = (view: "root" | "machines", pinned: boolean) =>
    render(
      <LocalityMenu
        menu={{ key: "t1", x: 0, y: 0, view }}
        current="remote"
        pinned={pinned}
        primaryHost="h"
        computeHosts={[{ id: "w1", host: "w1.invalid", shared_fs: true }]}
        onClose={vi.fn()}
        onChangeView={vi.fn()}
        onChoose={vi.fn()}
      />,
    );

  it("is the machine list alone, with no Local row and no way back to one", () => {
    menu("root", true);
    expect(screen.queryByText(translateNow("tabLocality.localMirrorItem"))).toBeNull();
    expect(screen.queryByText(translateNow("tabLocality.remoteEllipsis"))).toBeNull();
    expect(screen.getByText("w1.invalid")).toBeTruthy();
    expect(screen.getByTitle(translateNow("tabLocality.pinnedHostTitle"))).toBeTruthy();
  });

  it("keeps the Local row for an ordinary remote project", () => {
    menu("root", false);
    expect(screen.getByText(translateNow("tabLocality.localMirrorItem"))).toBeTruthy();
  });
});

describe("RunHostPicker on a pinned project", () => {
  it("reads a stored this-computer preference as the primary and opens on the machines", () => {
    useRunHostPrefStore.setState({ byProject: { "p-pinned": "local" } });
    render(<RunHostPicker projectId="p-pinned" pinned primaryHost="h" />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain("h");
    fireEvent.click(button);
    expect(screen.queryByText(translateNow("tabLocality.localMirrorItem"))).toBeNull();
  });
});
