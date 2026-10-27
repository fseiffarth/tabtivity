/**
 * The project screen's layout after the Home/project redesign: ＋ New tab is
 * a floating button rather than a header control, a card's rarer actions sit
 * behind its ⋯, the gesture hints are one line that stays gone once
 * dismissed, the tips are cards shown one at a time, Recently closed is folded under one row, and a project with no
 * tabs says so once.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Project } from "../../../mobile-web/src/screens/Project";

const fetchMock = vi.fn();

function serve(tabs: unknown[], extra: Record<string, unknown> = {}) {
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (init?.method === "DELETE") return new Response(JSON.stringify({ closed: true }), { status: 200 });
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active", live_sessions: tabs.length },
      desktop_available: true,
      tabs,
      agents: [],
      ...extra,
    }), { status: 200 });
  });
}

const agent = (id: string, label: string) => ({ id, label, kind: "agent", available: true, viewer_busy: false });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — layout", () => {
  it("puts ＋ New tab in a floating button, not the header", async () => {
    serve([agent("a", "claude 1")]);
    const { container } = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    const fab = screen.getByRole("button", { name: "New tab" });
    expect(container.querySelector("header")?.contains(fab)).toBe(false);
    expect(fab.classList.contains("fab")).toBe(true);
    fireEvent.click(fab);
    expect(await screen.findByRole("dialog", { name: "New tab" })).toBeTruthy();
  });

  it("closes a tab from its ⋯ sheet, whose rows never share a card button's name", async () => {
    serve([agent("a", "claude 1"), { id: "s", label: "Shell", kind: "shell", available: true, viewer_busy: false }]);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "More for claude 1" }));
    const sheet = screen.getByRole("dialog", { name: "claude 1" });
    expect(within(sheet).getAllByRole("button").map((row) => row.getAttribute("aria-label") ?? row.textContent))
      .toEqual(["Close", "Rename", "Colour…", "Scheduled prompts", "Close tab"]);
    fireEvent.click(within(sheet).getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => (init as RequestInit | undefined)?.method === "DELETE" && String(input) === "/api/v1/tabs/a")).toBe(true));
    expect(screen.queryByRole("dialog", { name: "claude 1" })).toBeNull();
  });

  it("hides the gesture hint for good once dismissed", async () => {
    serve([agent("a", "claude 1")]);
    const first = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    expect(await screen.findByText(/Swipe a card from right to left/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide this hint" }));
    expect(screen.queryByText(/Swipe a card from right to left/)).toBeNull();
    first.unmount();
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.queryByText(/Swipe a card from right to left/)).toBeNull();
  });

  it("says a hold of ＋ reaches the other agents, until it is held or dismissed", async () => {
    serve([agent("a", "claude 1")], { agents: [{ id: "claude", label: "Claude", modes: [], default: true }] });
    const early = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    // The screen's tips share one spot, one card at a time: the ☰ one leads,
    // and closing it with × leaves the spot empty for the visit.
    expect(await screen.findByText(/Tap ☰ to open/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Never show this message again" }));
    fireEvent.click(screen.getByRole("button", { name: "Close tip" }));
    expect(screen.queryByRole("complementary", { name: "Tip" })).toBeNull();
    early.unmount();
    const first = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    expect(await screen.findByText(/Tapping ＋ opens Claude; hold ＋ to start a different agent/)).toBeTruthy();
    fireEvent.contextMenu(screen.getByRole("button", { name: "New tab" }));
    expect(screen.queryByText(/hold ＋ to start a different agent/)).toBeNull();
    // Held once, the next tip — the cards' ⋯ — takes its place.
    expect(screen.getByText(/The ⋯ on a tab's card/)).toBeTruthy();
    first.unmount();
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("claude 1");
    expect(screen.queryByText(/hold ＋ to start a different agent/)).toBeNull();
  });

  it("folds Recently closed under one row", async () => {
    serve([agent("a", "claude 1")], { closed: [{ id: "c1", label: "old claude", agent: "claude", closed_at: 1 }] });
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const row = await screen.findByRole("button", { name: /Recently closed \(1\)/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /^Reopen old claude/ })).toBeNull();
    fireEvent.click(row);
    expect(screen.getByRole("button", { name: /^Reopen old claude/ })).toBeTruthy();
  });

  it("says once that a project has no tabs, and draws no second New tab", async () => {
    serve([]);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    expect(await screen.findByText("No tabs yet")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "New tab" })).toHaveLength(1);
  });
});
