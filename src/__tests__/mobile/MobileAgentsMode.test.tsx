/**
 * The Projects tab's agents mode: every project's agent tabs that are working,
 * waiting on a decision or done, in one flat list. What matters here is that it
 * is a *mode* and not a filter — the project list is not fetched behind it, a
 * row carries the project it belongs to, and tapping one goes straight to the
 * session rather than to the project it lives in.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../../mobile-web/src/screens/Home";
import type { ActivityTab } from "../../../mobile-web/src/api";
import { storageKey } from "../../lib/brand";

const fetchMock = vi.fn();

function activityTab(id: string, label: string, project: string, status: ActivityTab["agent_status"], extra: Partial<ActivityTab> = {}): ActivityTab {
  return {
    id,
    label,
    kind: "agent",
    agent_status: status,
    available: true,
    viewer_busy: false,
    project_id: `${project}-id`,
    project_label: project,
    ...extra,
  };
}

const rowLabels = () => screen.getAllByRole("button").filter((node) => node.classList.contains("card")).map((node) => node.querySelector("strong")?.textContent);

function answerActivity(body: unknown, desktopAvailable = true) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/activity")) {
      return new Response(JSON.stringify(body ?? { tabs: [], desktop_available: desktopAvailable }), { status: 200 });
    }
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 });
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const noop = () => {};

async function enterAgentsMode() {
  await screen.findByText("Alpha");
  fireEvent.click(screen.getByRole("button", { name: "Agents" }));
}

describe("Mobile home — agents mode", () => {
  it("lists every project's live agent tabs flat, with the project on the row", async () => {
    answerActivity({
      tabs: [
        activityTab("t1", "Claude", "Aurora", "question"),
        activityTab("t2", "Codex", "Borealis", "working"),
      ],
      desktop_available: true,
    });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    expect(await screen.findByText("Claude")).toBeTruthy();
    expect(screen.getByText("Aurora")).toBeTruthy();
    // A working row says so beside its project.
    expect(screen.getByText(/Borealis/).textContent).toBe("Borealis · working now");
    expect(screen.getByText("question")).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    // The heading follows the mode, and the project list is gone rather than
    // filtered — nothing here is grouped by project.
    expect(screen.getByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
  });

  it("stops polling the project list while the mode is on", async () => {
    answerActivity({ tabs: [activityTab("t1", "Claude", "Aurora", "done")], desktop_available: true });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    await screen.findByText("Claude");
    const before = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/v1/projects")).length;
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/activity"))).toBe(true));
    const after = fetchMock.mock.calls.filter(([input]) => String(input).startsWith("/api/v1/projects")).length;
    expect(after).toBe(before);
  });

  it("opens the session itself, naming the project it belongs to", async () => {
    answerActivity({ tabs: [activityTab("t1", "Claude", "Aurora", "question")], desktop_available: true });
    const opened: [string, string][] = [];
    render(<Home open={noop} openTab={(projectId, tab) => opened.push([projectId, tab.id])} todo={noop} mail={noop} />);
    await enterAgentsMode();
    fireEvent.click(await screen.findByText("Claude"));
    expect(opened).toEqual([["Aurora-id", "t1"]]);
  });

  it("says the desktop is what classifies, rather than reading an empty list as quiet", async () => {
    answerActivity({ tabs: [], desktop_available: false });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    expect((await screen.findByText(/Desktop unavailable/)).textContent).toContain("desktop");
    expect(screen.queryByText(/Nothing is working/)).toBeNull();
  });

  it("says nothing is waiting only when the desktop answered", async () => {
    answerActivity({ tabs: [], desktop_available: true });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    expect(await screen.findByText(/Nothing is working, waiting or done/)).toBeTruthy();
  });

  it("orders by last working by default — asking first, then working, then the newest finished — and tags each row with its model", async () => {
    const now = Date.now();
    answerActivity({
      tabs: [
        activityTab("t1", "Finished", "Aurora", "done", { working_at: now - 10 * 60_000, done_at: now - 9 * 60_000, agent_model: "opus-4-1" }),
        activityTab("t2", "Recent", "Aurora", "done", { working_at: now - 2 * 60_000, done_at: now - 60 * 60_000 }),
        activityTab("t3", "Busy", "Borealis", "working", { working_at: now, done_at: now - 3 * 60_000, agent_model: "gpt-5-codex" }),
        activityTab("t4", "Asking", "Borealis", "question", { working_at: now - 30 * 60_000, done_at: now - 90 * 60_000 }),
      ],
      desktop_available: true,
    });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    await screen.findByText("Busy");
    // The oldest tab of the four leads the list: it is the only one that cannot
    // go on without the reader.
    expect(rowLabels()).toEqual(["Asking", "Busy", "Finished", "Recent"]);
    expect(screen.getByText(/opus-4-1/).textContent).toContain("Aurora · opus-4-1 · finished 9m ago");
    expect(screen.getByText(/gpt-5-codex/).textContent).toContain("working now");

    fireEvent.change(screen.getByLabelText("Sort agent tabs"), { target: { value: "lastDone" } });
    expect(rowLabels()).toEqual(["Busy", "Finished", "Recent", "Asking"]);
    expect(screen.getByText(/gpt-5-codex/).textContent).toContain("finished 3m ago");
    expect(localStorage.getItem(storageKey("mobile.agentsSort"))).toBe("lastDone");

    // The sidecar's own order (waiting first, finished last) is still on offer.
    fireEvent.change(screen.getByLabelText("Sort agent tabs"), { target: { value: "native" } });
    expect(rowLabels()).toEqual(["Finished", "Recent", "Busy", "Asking"]);
  });

  it("comes back in the mode it was left in, and forgets it when the reader leaves", async () => {
    answerActivity({ tabs: [activityTab("t1", "Claude", "Aurora", "working")], desktop_available: true });
    const first = render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    await enterAgentsMode();
    await screen.findByText("Claude");
    first.unmount();

    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByText("Claude")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Active" }));
    await screen.findByText("Alpha");
    cleanup();

    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByText("Alpha")).toBeTruthy();
  });
});
