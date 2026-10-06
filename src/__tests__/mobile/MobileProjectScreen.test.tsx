/**
 * The project screen's first paint. `!detail?.desktop_available` was also true
 * while the first load was still in flight, so every project opened on a
 * "Desktop unavailable" notice that vanished a moment later — and on a phone
 * that flash reads as the desktop having just dropped.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — first load", () => {
  it("does not claim the desktop is unavailable before the host has answered", async () => {
    let release: (value: Response) => void = () => {};
    // The screen reads two things: the project itself and the outbox behind the
    // shelf under the cards. Only the first is held open and released here —
    // the shelf's read is left in flight, which is what it is when the phone
    // has just opened the screen.
    fetchMock.mockImplementation((input: string | URL | Request) => String(input).endsWith("/outbox")
      ? new Promise<Response>(() => {})
      : new Promise<Response>((resolve) => { release = resolve; }));
    render(<Project id="p 1" back={() => {}} terminal={() => {}} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/Desktop unavailable/)).toBeNull();
    // The opaque id is encoded on the way into the path, like every other route.
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/v1/projects/p%201");

    release(new Response(JSON.stringify({
      project: { id: "p 1", label: "Alpha", status: "active", live_sessions: 0 },
      desktop_available: false,
      tabs: [],
      agents: [],
    }), { status: 200 }));
    expect(await screen.findByText(/Desktop unavailable/)).toBeTruthy();
  });
});

describe("Mobile project screen — tab order", () => {
  it("lists a question, then working tabs, then the rest by last finished turn", async () => {
    const row = (id: string, extra: Record<string, unknown>) => ({ id, label: id, kind: "agent", available: true, viewer_busy: false, ...extra });
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      project: { id: "p", label: "Alpha", status: "active", live_sessions: 5 },
      desktop_available: true,
      tabs: [
        { id: "shell", label: "shell", kind: "shell", available: true, viewer_busy: false },
        row("old-done", { agent_status: "done", done_at: 1_000 }),
        row("working", { agent_status: "working", done_at: 500 }),
        row("new-done", { done_at: 3_000 }),
        row("asking", { agent_status: "question" }),
      ],
      agents: [],
    }), { status: 200 }));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("asking");
    const order = [...container.querySelectorAll(".tab-card strong")].map((node) => node.textContent);
    expect(order).toEqual(["asking", "working", "new-done", "old-done", "shell"]);
  });
});

describe("Mobile project screen — the header line", () => {
  const detail = (tabs: unknown[]) => new Response(JSON.stringify({
    project: { id: "p", label: "Alpha", status: "active", live_sessions: 1 },
    desktop_available: true,
    tabs,
    agents: [],
  }), { status: 200 });

  it("carries the back chevron, the project's name and the tab order on one line, the way an agent tab's header does", async () => {
    fetchMock.mockResolvedValue(detail([
      { id: "a", label: "claude 1", kind: "agent", available: true, viewer_busy: false },
      { id: "b", label: "claude 2", kind: "agent", available: true, viewer_busy: false },
    ]));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 2");
    const header = container.querySelector("header");
    expect(header?.querySelector(".back")).toBeTruthy();
    expect(header?.querySelector("h1")?.textContent).toBe("Alpha");
    expect(header?.querySelector(".activity-sort select")).toBe(screen.getByLabelText("Sort tabs"));
    // Nothing is left standing between the header and the cards: the order used
    // to cost a row of its own above them.
    expect(container.querySelectorAll(".activity-sort")).toHaveLength(1);
  });

  it("spends nothing on the order when there is only one tab to order", async () => {
    fetchMock.mockResolvedValue(detail([{ id: "a", label: "claude 1", kind: "agent", available: true, viewer_busy: false }]));
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.queryByLabelText("Sort tabs")).toBeNull();
  });
});

describe("Mobile project screen — the git overview", () => {
  const host = (kind?: "project" | "box") => (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/outbox")) return Promise.resolve(new Response(JSON.stringify({ files: [] }), { status: 200 }));
    if (url.endsWith("/git")) {
      return Promise.resolve(new Response(JSON.stringify({
        repo: true,
        head: { branch: "main", ahead: 0, behind: 0 },
        worktrees: [{ id: "w", label: "", branch: "main", main: true, current: true, locked: false, missing: false, checked: true, tabs: 0 }],
        worktrees_total: 1,
        branches: [{ name: "main", current: true, ahead: 0, behind: 0 }],
        branches_total: 1,
        remote_branches: [],
        remote_total: 0,
      }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({
      project: { id: "p", label: "Alpha", status: "active", live_sessions: 0, ...(kind ? { kind } : {}) },
      desktop_available: true,
      tabs: [],
      agents: [],
    }), { status: 200 }));
  };

  it("offers ⎇ Git in the name menu of a project and opens the sheet", async () => {
    fetchMock.mockImplementation(host());
    render(<Project id="p" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Project menu" })).getByRole("menuitem", { name: /^Git/ }));
    const sheet = await screen.findByRole("dialog", { name: "Git · Alpha" });
    expect(await within(sheet).findByText("Branches (1)")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/projects/p/git", expect.anything());
    expect(screen.queryByRole("menu", { name: "Project menu" })).toBeNull();
  });

  it("offers no git for a box, which has no repo of its own", async () => {
    fetchMock.mockImplementation(host("box"));
    const { container } = render(<Project id="p" back={() => {}} terminal={() => {}} />);
    await waitFor(() => expect(container.querySelector("header h1")?.textContent).toBe("Alpha"));
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/git"))).toBe(false);
  });
});
