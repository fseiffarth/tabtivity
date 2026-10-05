/**
 * Tests for git-aware local↔remote lockstep sync UI (#28n, Phase 1) in GitHistory:
 * - a remote project with lockstep enabled routes branch checkout through
 *   `git_peer_checkout` (host-initiated), not the bare `git_checkout`;
 * - the status pill reflects the backend `GitPeerState`;
 * - with lockstep disabled the checkout falls back to `git_checkout`;
 * - a local project (no projectId/remote) never shows the lockstep bar.
 *
 * Plus the hardening UI (#28p): the disconnected state (D4), the pairing-overwrite
 * confirm that must name the files it would destroy (D3), the backup-ref list and
 * restore (D6), and the hand-resolve-in-a-terminal escape hatch + informed head display
 * (D8).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/**
 * Answer the app's own confirm dialog. These destructive git gestures used
 * `window.confirm` — themeless, origin-titled, and (for a warning that *lists
 * paths*) collapsed to one line; they now open `ConfirmDialog`, so a test
 * clicks its button instead of stubbing a global.
 */
async function answerDialog(
  user: ReturnType<typeof userEvent.setup>,
  button: string | RegExp,
) {
  const box = await screen.findByRole("dialog");
  await user.click(within(box).getByRole("button", { name: button }));
}

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { GitHistory } from "../../components/files/GitHistory";
import { useTabsStore } from "../../stores/tabs";
import { NAMES } from "../../lib/brand";

const COMMITS = [
  { hash: "aaa111", short: "aaa111", subject: "feat", author: "me", date: "2d", refs: "HEAD -> main", is_head: true, parents: [] },
];
const BRANCHES = [
  { name: "main", is_current: true, is_remote: false },
  { name: "feature", is_current: false, is_remote: false },
];

function setup(peerState: unknown) {
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "git_log") return Promise.resolve(COMMITS);
    if (cmd === "git_branches") return Promise.resolve(BRANCHES);
    if (cmd === "git_worktree_list") return Promise.resolve([]);
    if (cmd === "git_peer_status") return Promise.resolve(peerState);
    if (cmd === "git_peer_checkout") return Promise.resolve(peerState);
    if (cmd === "git_peer_resolve") return Promise.resolve({ ...(peerState as object), status: "synchronized", detail: null });
    if (cmd === "git_checkout") return Promise.resolve(null);
    return Promise.resolve(null);
  });
}

const ENABLED = {
  enabled: true,
  status: "synchronized",
  detail: null,
  localHead: { kind: "branch", name: "main", sha: "a" },
  remoteHead: { kind: "branch", name: "main", sha: "a" },
  lastSyncTs: 1,
  localSubject: null,
  remoteSubject: null,
  pairingConflict: null,
};
const DISABLED = { ...ENABLED, enabled: false };

async function renderRemote(peerState: unknown) {
  await act(async () => {
    render(<GitHistory projectDir="/p" projectId="proj1" remote />);
  });
  void peerState;
}

describe("#28n git lockstep UI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the status pill and routes checkout through git_peer_checkout when enabled", async () => {
    setup(ENABLED);
    const user = userEvent.setup();
    await renderRemote(ENABLED);

    // Pill reflects backend status.
    expect(await screen.findByText("synchronized")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_checkout", {
      projectId: "proj1",
      target: "feature",
      initiatingSide: "remote",
    });
    expect(mockInvoke).not.toHaveBeenCalledWith("git_checkout", expect.anything());
  });

  it("falls back to git_checkout when lockstep is disabled", async () => {
    setup(DISABLED);
    const user = userEvent.setup();
    await renderRemote(DISABLED);

    await user.click(await screen.findByRole("button", { name: "feature" }));
    expect(mockInvoke).toHaveBeenCalledWith("git_checkout", { projectDir: "/p", target: "feature" });
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_checkout", expect.anything());
  });

  it("offers Use local / Use remote when desynchronized and routes to git_peer_resolve", async () => {
    const DESYNC = { ...ENABLED, status: "desynchronized", detail: "Diverged: main" };
    setup(DESYNC);
    const user = userEvent.setup();
    await renderRemote(DESYNC);

    // The desync detail + both authority buttons render.
    expect(await screen.findByText("Diverged: main")).toBeTruthy();
    await user.click(await screen.findByRole("button", { name: "Use remote" }));
    await answerDialog(user, "Use remote host");
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_resolve", {
      projectId: "proj1",
      authority: "remote",
    });
  });

  it("does not resolve when the confirm is dismissed", async () => {
    const DESYNC = { ...ENABLED, status: "desynchronized", detail: "Diverged: main" };
    setup(DESYNC);
    const user = userEvent.setup();
    await renderRemote(DESYNC);

    await user.click(await screen.findByRole("button", { name: "Use local" }));
    await answerDialog(user, "Cancel");
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_resolve", expect.anything());
  });

  it("does not render the lockstep bar for a local project", async () => {
    setup(null);
    await act(async () => {
      render(<GitHistory projectDir="/p" />);
    });
    expect(screen.queryByText(/Lockstep/)).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_status", expect.anything());
  });
});

describe("#28p git lockstep hardening UI", () => {
  beforeEach(() => vi.clearAllMocks());

  it("D4: renders the disconnected state and disables Sync now", async () => {
    // The whole point of D4: a cold pool must not read as a green "synchronized".
    const OFFLINE = {
      ...ENABLED,
      status: "disconnected",
      detail: "Not connected to the remote host",
    };
    setup(OFFLINE);
    await renderRemote(OFFLINE);

    expect(await screen.findByText("disconnected")).toBeTruthy();
    const sync = await screen.findByRole("button", { name: "Sync now" });
    expect((sync as HTMLButtonElement).disabled).toBe(true);
    // No authority actions: there is nothing to resolve against an unseen host.
    expect(screen.queryByRole("button", { name: "Use local" })).toBeNull();
  });

  it("D3: a pairing conflict offers only the confirm that names the files at risk", async () => {
    const CONFLICT = {
      ...ENABLED,
      status: "desynchronized",
      detail: "Pairing would overwrite 2 file(s) on the host that differ: README.md, src/a.rs",
      pairingConflict: { sourceIsLocal: true, paths: ["README.md", "src/a.rs"] },
    };
    setup(CONFLICT);
    const user = userEvent.setup();
    await renderRemote(CONFLICT);

    // Use-local/Use-remote would be meaningless (nothing is paired yet) — the only
    // action is the one that has named what it would destroy.
    expect(screen.queryByRole("button", { name: "Use local" })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /Overwrite 2 file/ }));

    // The confirm must actually list the files — that is the whole safety property.
    expect((await screen.findByRole("dialog")).textContent).toContain("README.md");
    await answerDialog(user, "Overwrite");
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_pair_confirm", { projectId: "proj1" });
  });

  it("D3: dismissing the overwrite confirm pairs nothing", async () => {
    const CONFLICT = {
      ...ENABLED,
      status: "desynchronized",
      detail: "Pairing would overwrite 1 file(s) on the host that differ: README.md",
      pairingConflict: { sourceIsLocal: true, paths: ["README.md"] },
    };
    setup(CONFLICT);
    const user = userEvent.setup();
    await renderRemote(CONFLICT);

    await user.click(await screen.findByRole("button", { name: /Overwrite 1 file/ }));
    await answerDialog(user, "Cancel");
    expect(mockInvoke).not.toHaveBeenCalledWith("git_peer_pair_confirm", expect.anything());
  });

  it("D6: Backups lists the safety refs and routes Restore to the backend", async () => {
    const DESYNC = { ...ENABLED, status: "desynchronized", detail: "Diverged: main" };
    setup(DESYNC);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_log") return Promise.resolve(COMMITS);
      if (cmd === "git_branches") return Promise.resolve(BRANCHES);
      if (cmd === "git_worktree_list") return Promise.resolve([]);
      if (cmd === "git_peer_status") return Promise.resolve(DESYNC);
      if (cmd === "git_peer_backups")
        return Promise.resolve([
          {
            peer: "remote",
            refname: `${NAMES.gitRefBackup}/1735689600/main`,
            ts: 1735689600,
            branch: "main",
            sha: "deadbeefcafe",
            subject: "The tip a resolve overwrote",
          },
        ]);
      return Promise.resolve(DESYNC);
    });
    const user = userEvent.setup();
    await renderRemote(DESYNC);

    await user.click(await screen.findByRole("button", { name: "Backups" }));
    expect(await screen.findByText("The tip a resolve overwrote")).toBeTruthy();

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    await answerDialog(user, "Restore");
    expect(mockInvoke).toHaveBeenCalledWith("git_peer_restore_backup", {
      projectId: "proj1",
      peer: "remote",
      refname: `${NAMES.gitRefBackup}/1735689600/main`,
    });
  });

  it("D8: Resolve in terminal opens a local shell tab in the mirror", async () => {
    const DESYNC = { ...ENABLED, status: "desynchronized", detail: "Diverged: main" };
    setup(DESYNC);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "git_log") return Promise.resolve(COMMITS);
      if (cmd === "git_branches") return Promise.resolve(BRANCHES);
      if (cmd === "git_worktree_list") return Promise.resolve([]);
      if (cmd === "git_peer_mirror_dir") return Promise.resolve("/home/me/mirror");
      return Promise.resolve(DESYNC);
    });
    const user = userEvent.setup();
    const addTab = vi.spyOn(useTabsStore.getState(), "addTab");
    await renderRemote(DESYNC);

    await user.click(await screen.findByRole("button", { name: "Resolve in terminal" }));

    const tab = addTab.mock.calls[0][0];
    expect(tab.kind).toBe("shell");
    expect(tab.cwd).toBe("/home/me/mirror");
    // A remote-located shell would cd into the HOST tree, where the parked peer ref
    // isn't — the merge has to happen in the local mirror.
    expect(tab.location).toBe("local");
    expect(tab.initialInput).toContain(`${NAMES.gitRefPeer}/main`);
    addTab.mockRestore();
  });

  it("D8: the desync bar shows both heads so the authority choice is informed", async () => {
    const DESYNC = {
      ...ENABLED,
      status: "desynchronized",
      detail: "Diverged: main",
      localHead: { kind: "branch", name: "main", sha: "1111111abc" },
      remoteHead: { kind: "branch", name: "main", sha: "2222222def" },
      localSubject: "My local work",
      remoteSubject: "Their host work",
    };
    setup(DESYNC);
    await renderRemote(DESYNC);

    const bar = await screen.findByText(/local: main 1111111/);
    expect(bar.textContent).toContain("My local work");
    expect(bar.textContent).toContain("Their host work");
    expect(bar.textContent).toContain("2222222");
  });
});
