/**
 * Home's Needs you: above the projects in the Active view, the agent tabs
 * asking something or cut off, the finished ones this phone has not opened
 * yet, then the desktop's alerts — three rows, then "Show all". Above it,
 * three tiles count the waiting, working and unseen finished tabs and lead to
 * the Agents view. The group is not drawn when there is nothing to show, and
 * nothing at all in the Search view.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityTab, MobileAlertItem } from "../../../mobile-web/src/api";
import { Home } from "../../../mobile-web/src/screens/Home";
import { markDoneSeen } from "../../../mobile-web/src/seenDone";

const fetchMock = vi.fn();

function tab(id: string, status: ActivityTab["agent_status"], extra: Partial<ActivityTab> = {}): ActivityTab {
  return { id, label: id, kind: "agent", agent_status: status, available: true, viewer_busy: false, project_id: "p1", project_label: "Alpha", ...extra };
}

const alert = (title: string): MobileAlertItem => ({ kind: "task", severity: "soon", title, detail: "", all_day: false, minutes_away: 30, alert_id: `row-${title}`, task_id: `task-${title}` });

function serve(tabs: ActivityTab[], alerts: MobileAlertItem[] = []) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs, desktop_available: true }), { status: 200 });
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: alerts.length > 0, items: alerts } }), { status: 200 });
    return new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 3, agents: { working: 0, question: 2, done: 0 } }] }), { status: 200 });
  });
}

const noop = () => {};
const group = () => screen.getByRole("region", { name: /^Needs you/ });

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Mobile home — Needs you", () => {
  it("lists asking tabs first, then unseen finished ones, then the alerts", async () => {
    serve([
      tab("done-1", "done", { done_at: 2_000 }),
      tab("busy", "working"),
      tab("asking", "question", { working_at: 1_000 }),
    ], [alert("Ship it")]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha · asking");
    const rows = within(group()).getAllByRole("button").map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("Alpha · asking");
    expect(rows[1]).toContain("Alpha · done-1");
    expect(rows[2]).toContain("Ship it");
    // The working tab is no row of its own: its tile counts it and leads to Agents.
    expect(within(group()).queryByText("Alpha · busy")).toBeNull();
    const glance = screen.getByRole("navigation", { name: "Agents at a glance" });
    expect(within(glance).getByRole("button", { name: "Waiting: 1" })).toBeTruthy();
    expect(within(glance).getByRole("button", { name: "Done: 1" })).toBeTruthy();
    fireEvent.click(within(glance).getByRole("button", { name: "Working: 1" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });

  it("lets a finished tab go once opened, and takes it back after its next turn", async () => {
    serve([tab("done-1", "done", { done_at: 2_000 })]);
    const opened: string[] = [];
    const view = render(<Home tabby={() => {}} open={noop} openTab={(_project, row) => opened.push(row.id)} todo={noop} mail={noop} />);
    fireEvent.click(await screen.findByText("Alpha · done-1"));
    expect(opened).toEqual(["done-1"]);
    await waitFor(() => expect(screen.queryByText("Alpha · done-1")).toBeNull());
    view.unmount();

    serve([tab("done-1", "done", { done_at: 3_000 })]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByText("Alpha · done-1")).toBeTruthy();
  });

  it("sends \"continue\" to an interrupted tab from beside its row, without opening it", async () => {
    serve([tab("cut", "interrupted", { working_at: 1_000 }), tab("asking", "question", { working_at: 2_000 })]);
    const held: { url: string; body: unknown }[] = [];
    const served = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/held")) {
        held.push({ url, body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({ id: "h1" }), { status: 200 });
      }
      return served(input, init);
    });
    const opened: string[] = [];
    render(<Home tabby={() => {}} open={noop} openTab={(_project, row) => opened.push(row.id)} todo={noop} mail={noop} />);
    await screen.findByText("Alpha · cut");
    // Only the cut-off turn is offered one; a question is answered in the tab.
    const buttons = within(group()).getAllByRole("button", { name: /Send "continue"/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(held).toEqual([{ url: "/api/v1/tabs/cut/held", body: { message: "continue" } }]));
    expect(opened).toEqual([]);
    await waitFor(() => expect(within(group()).queryByRole("button", { name: /Send "continue"/ })).toBeNull());
  });

  it("offers no continue while the desktop's AI switch is off", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs: [tab("cut", "interrupted", { working_at: 1_000 })], desktop_available: true, ai_off: true }), { status: 200 });
      if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
      return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    });
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha · cut");
    expect(within(group()).queryByRole("button", { name: /Send "continue"/ })).toBeNull();
  });

  it("shows three rows, then the rest in place", async () => {
    serve([1, 2, 3, 4, 5].map((n) => tab(`ask-${n}`, "question", { working_at: n })));
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha · ask-5");
    expect(within(group()).getAllByText(/^Alpha · ask-/)).toHaveLength(3);
    fireEvent.click(within(group()).getByRole("button", { name: "Show all 5" }));
    expect(within(group()).getAllByText(/^Alpha · ask-/)).toHaveLength(5);
  });

  it("draws nothing when nothing waits, and nothing in the Search view", async () => {
    markDoneSeen("done-1", 2_000);
    serve([tab("done-1", "done", { done_at: 2_000 })]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/activity"))).toBe(true));
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();

    serve([tab("asking", "question")]);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.getByPlaceholderText("Project name")).toBeTruthy());
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();
  });

  it("keeps the agent tiles when nothing waits, counting a cut-off tab as waiting", async () => {
    serve([tab("cut", "interrupted"), tab("ask", "question")]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    expect(await screen.findByRole("button", { name: "Waiting: 2" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Working: 0" })).toBeTruthy();

    cleanup();
    serve([]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByRole("button", { name: "Done: 0" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /^Needs you/ })).toBeNull();
  });
});
