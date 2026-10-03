/**
 * Shared projects (hosted plan §6.2–§6.6, P4a): the Sharing panel lists the
 * user's own shares with their members and presence, and the ones shared
 * with them — a revoked or deleted one as a greyed row whose copy stays.
 * Every action is a `share_*` command of the user's own daemon.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { ServerSharing } from "../../components/server/ServerSharing";
import { markServerClient, resetLinkStateForTests } from "../../lib/transport/linkState";

const overview = {
  me: "alice",
  rows: [
    {
      id: "a".repeat(32),
      name: "Paper",
      owner: "alice",
      role: "owner",
      state: "active",
      members: [{ user: "bob", role: "viewer", since: 1 }],
      presence: [{ user: "bob", since: 2 }],
      projectId: "p1",
    },
    { id: "b".repeat(32), name: "Thesis", owner: "carol", role: "editor", state: "active", members: [], presence: [], projectId: null },
    { id: "c".repeat(32), name: "Gone", owner: "dave", role: "viewer", state: "revoked", members: [], presence: [], projectId: "p9" },
  ],
};

describe("ServerSharing", () => {
  beforeEach(() => {
    markServerClient();
    vi.mocked(invoke).mockImplementation((cmd: string) => Promise.resolve(cmd === "share_list" ? overview : null));
  });
  afterEach(() => {
    cleanup();
    resetLinkStateForTests();
    vi.mocked(invoke).mockReset();
  });

  it("shows members and presence, and revokes by name", async () => {
    render(<ServerSharing />);
    expect(await screen.findByText(/Members: bob \(viewer\)/)).toBeTruthy();
    expect(screen.getByText(/Open now: bob/)).toBeTruthy();
    fireEvent.click(screen.getByText("Revoke bob"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("share_revoke", { share: "a".repeat(32), user: "bob" }));
  });

  it("adds a share shared with the user and greys one no longer shared", async () => {
    render(<ServerSharing />);
    expect(await screen.findByText(/carol's · you are editor/)).toBeTruthy();
    expect(screen.getByText(/No longer shared with you\. Your copy stays yours\./)).toBeTruthy();
    expect(screen.getAllByText("Add to my projects")).toHaveLength(1);
    fireEvent.click(screen.getByText("Add to my projects"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("share_add", { share: "b".repeat(32) }));
  });

  it("renders nothing outside the hosted server's browser client", async () => {
    resetLinkStateForTests();
    const { container } = render(<ServerSharing />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
    expect(invoke).not.toHaveBeenCalledWith("share_list");
  });
});
