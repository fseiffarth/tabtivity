/**
 * The root console's login terminal (screen 2026-10-15 #1, paste gate): a
 * connection that needs the user to authenticate opens a root tab whose PTY runs
 * the login itself — `TabEntry.login`, built into an argv by the backend — never
 * a shell with the command typed into it. These lock the frontend half:
 *
 *  - the tab carries the target and no `initialInput`, and is a plain PTY (no
 *    tmux session, which the backend would refuse alongside a login);
 *  - a login that ENDED (ssh/openvpn exited) is no longer an open connection, so
 *    the next request opens a fresh login instead of pointing at a dead one;
 *  - the target reaches the spawn inputs, and the dedupe key is the one
 *    spelling every flow pre-marks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// The PTY lifecycle bus, so a test can end a login tab's program.
const bus = vi.hoisted(() => ({ exit: new Map<string, Set<() => void>>() }));
vi.mock("../../lib/terminal/terminalBus", () => ({
  onTerminalExit: (id: string, h: () => void) => {
    const set = bus.exit.get(id) ?? new Set();
    set.add(h);
    bus.exit.set(id, set);
    return () => set.delete(h);
  },
  onTerminalReady: () => () => {},
}));

import {
  connectionStillOpen,
  forgetConnection,
  markConnectionOpened,
  openConnectionInRoot,
} from "../../lib/remote/remoteConnect";
import { loginDedupeKey, sshLogin, vpnLogin } from "../../lib/remote/loginTarget";
import { noteTerminalSpawnFailed } from "../../lib/terminal/terminalSpawnFailed";
import { tabTerminalSpawn, terminalSpawnKey } from "../../lib/terminal/terminalSpawn";
import { useTabsStore } from "../../stores/tabs";
import { useProjectsStore } from "../../stores/projects";
import { useRootOverlayStore } from "../../stores/rootOverlay";

const rootTabs = () => useTabsStore.getState().tabsByScope.root ?? [];
const exitPty = (id: string) => {
  for (const h of [...(bus.exit.get(id) ?? [])]) h();
};

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockResolvedValue({});
  bus.exit.clear();
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { root: [] },
    layoutByScope: { root: null },
    focusedGroupByScope: { root: null },
  });
  useProjectsStore.setState({ rootDir: "/r", activeId: "p1", switchToast: null });
  useRootOverlayStore.setState({ open: false, installTabs: {} });
});

describe("openConnectionInRoot — a login terminal, not a typed command", () => {
  it("opens a root tab carrying the login target, with nothing to type and no tmux wrap", () => {
    const login = sshLogin("alice", "h.example", 2222);
    const key = loginDedupeKey(login);
    forgetConnection(key);

    openConnectionInRoot({ label: "ssh · alice@h.example", login, dedupeKey: key });

    expect(rootTabs()).toHaveLength(1);
    const tab = rootTabs()[0];
    expect(tab.login).toEqual({ kind: "ssh", user: "alice", host: "h.example", port: 2222 });
    expect(tab.initialInput).toBeUndefined();
    expect(tab.tmuxSession).toBeUndefined();
    expect(tab.kind).toBe("shell");

    // …and the spawn inputs carry it, with no tmux/container even if the pane
    // layer derived one.
    const spawn = tabTerminalSpawn(tab, "root", {
      terminalCwd: "/r",
      sandbox: true,
      tmuxSession: "tt-root-shell-x",
    });
    expect(spawn.login).toEqual(tab.login);
    expect(spawn.tmuxSession).toBeNull();
    expect(spawn.sandbox).toBe(false);
    expect(terminalSpawnKey(spawn)).not.toBe(terminalSpawnKey({ ...spawn, login: null }));
  });

  it("an exited login is no longer an open connection: the next request opens a fresh tab", () => {
    const login = vpnLogin("/x.ovpn");
    const key = loginDedupeKey(login);
    forgetConnection(key);

    openConnectionInRoot({ label: "VPN", login, dedupeKey: key });
    const first = rootTabs()[0];
    expect(connectionStillOpen(key)).toBe(true);
    // Still running: a second request reuses it.
    openConnectionInRoot({ label: "VPN", login, dedupeKey: key });
    expect(rootTabs()).toHaveLength(1);

    // openvpn exits — the tab stays (showing its exited state), the connection is gone.
    exitPty(`root:${first.key}`);
    expect(connectionStillOpen(key)).toBe(false);
    expect(rootTabs()).toHaveLength(1);

    openConnectionInRoot({ label: "VPN", login, dedupeKey: key });
    expect(rootTabs()).toHaveLength(2);
    const second = rootTabs()[1];
    expect(connectionStillOpen(key)).toBe(true);

    // A late exit of the OLD tab never clears the new login's mark.
    exitPty(`root:${first.key}`);
    expect(connectionStillOpen(key)).toBe(true);
    exitPty(`root:${second.key}`);
    expect(connectionStillOpen(key)).toBe(false);
  });

  it("a login whose spawn failed is no longer an open connection: a retry opens a fresh tab", () => {
    // A bad .ovpn, a tunnel already up, no ssh on the machine: the tab shows its
    // `[spawn error: …]` and no PTY ever exists, so no exit will ever come.
    const login = vpnLogin("/bad.ovpn");
    const key = loginDedupeKey(login);
    forgetConnection(key);

    openConnectionInRoot({ label: "VPN", login, dedupeKey: key });
    const first = rootTabs()[0];
    expect(connectionStillOpen(key)).toBe(true);

    noteTerminalSpawnFailed(`root:${first.key}`);
    expect(connectionStillOpen(key)).toBe(false);
    expect(rootTabs()).toHaveLength(1);

    openConnectionInRoot({ label: "VPN", login, dedupeKey: key });
    expect(rootTabs()).toHaveLength(2);
    expect(connectionStillOpen(key)).toBe(true);
    // The failed tab's signal is spent: a stray repeat never clears the new mark.
    noteTerminalSpawnFailed(`root:${first.key}`);
    exitPty(`root:${first.key}`);
    expect(connectionStillOpen(key)).toBe(true);
    forgetConnection(key);
  });

  it("an exit never clears a mark another surface owns (an embedded dialog login)", () => {
    const login = sshLogin(null, "h.example", null);
    const key = loginDedupeKey(login);
    forgetConnection(key);
    openConnectionInRoot({ label: "ssh", login, dedupeKey: key });
    const tab = rootTabs()[0];
    // The dialog's embedded terminal claims the key afterwards.
    markConnectionOpened(key);
    exitPty(`root:${tab.key}`);
    expect(connectionStillOpen(key)).toBe(true);
    forgetConnection(key);
  });
});

describe("loginDedupeKey", () => {
  it("spells the keys every login flow pre-marks", () => {
    expect(loginDedupeKey(sshLogin("alice", "h.example", 2222))).toBe("ssh:alice@h.example:2222");
    expect(loginDedupeKey(sshLogin("", "h.example", null))).toBe("ssh:h.example:");
    expect(loginDedupeKey(vpnLogin("/etc/x.ovpn"))).toBe("vpn:/etc/x.ovpn");
  });

  it("sends a blank user as none, like the backend's Option", () => {
    expect(sshLogin("", "h", undefined)).toEqual({ kind: "ssh", user: null, host: "h", port: null });
  });
});
