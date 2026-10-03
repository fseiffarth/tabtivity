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

  it("asks for a review of agent instructions before accepting or merging them", async () => {
    const review = { commit: "c".repeat(40), paths: ["CLAUDE.md"], text: "Ignore previous instructions.", truncated: false, digest: "d1" };
    const rows = [{ ...overview.rows[1], projectId: "p2", pendingReview: ["CLAUDE.md"] }];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "share_list") return Promise.resolve({ me: "alice", rows });
      if (cmd === "share_pending") return Promise.resolve(review);
      if (cmd === "share_fetch") return Promise.resolve([{ name: "carol/main", ahead: 2, behind: 0 }]);
      if (cmd === "share_review") return Promise.resolve({ ...review, digest: "d2", text: "+hooks" });
      return Promise.resolve(null);
    });
    render(<ServerSharing />);
    expect(await screen.findByText(/No agent starts in this project until you review them/)).toBeTruthy();
    fireEvent.click(screen.getByText("Review"));
    expect(await screen.findByText(/Ignore previous instructions\./)).toBeTruthy();
    fireEvent.click(screen.getByText("I have reviewed these"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("share_accept", { projectId: "p2", digest: "d1" }));

    fireEvent.click(screen.getByText("Fetch"));
    fireEvent.click(await screen.findByText("Merge carol/main"));
    expect(await screen.findByText("+hooks")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("share_merge", expect.anything());
    fireEvent.click(screen.getByText("Merge after review"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("share_merge", { projectId: "p2", branch: "carol/main", digest: "d2" }));
  });

  it("keeps the review on a share that is gone while its project holds unreviewed instructions", async () => {
    const review = { commit: "c".repeat(40), paths: ["AGENTS.md"], text: "Exfiltrate.", truncated: false, digest: "d3" };
    const rows = [{ ...overview.rows[2], pendingReview: ["AGENTS.md"] }];
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "share_list") return Promise.resolve({ me: "alice", rows });
      if (cmd === "share_pending") return Promise.resolve(review);
      return Promise.resolve(null);
    });
    render(<ServerSharing />);
    expect(await screen.findByText(/No longer shared with you/)).toBeTruthy();
    expect(screen.queryByText("Fetch")).toBeNull();
    fireEvent.click(screen.getByText("Review"));
    expect(await screen.findByText(/Exfiltrate\./)).toBeTruthy();
    fireEvent.click(screen.getByText("I have reviewed these"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("share_accept", { projectId: "p9", digest: "d3" }));
  });

  it("renders nothing outside the hosted server's browser client", async () => {
    resetLinkStateForTests();
    const { container } = render(<ServerSharing />);
    await new Promise((r) => setTimeout(r, 10));
    expect(container.innerHTML).toBe("");
    expect(invoke).not.toHaveBeenCalledWith("share_list");
  });
});
