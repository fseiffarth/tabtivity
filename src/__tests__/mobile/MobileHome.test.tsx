/**
 * The project list's loading and empty states. Both used to draw nothing
 * under the "Projects" heading — a first open with no active project looked
 * broken, and there was no way to tell it from a list still on its way.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../../mobile-web/src/screens/Home";
import { storageKey } from "../../lib/brand";

const fetchMock = vi.fn();

function answer(projects: unknown[]) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs: [], desktop_available: true }), { status: 200 });
    return new Response(JSON.stringify({ projects }), { status: 200 });
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const noop = () => {};

describe("Mobile home — project list states", () => {
  it("says it is loading until the first list arrives", async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation((input: string | URL | Request) => String(input).startsWith("/api/v1/alerts")
      ? Promise.resolve(new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 }))
      : new Promise<Response>((resolve) => { release = resolve; }));
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(screen.getByRole("status").textContent).toContain("Loading projects");
    // The list request is issued from a timer, so wait for it to be in flight.
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/v1/projects"))).toBe(true));
    release(new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 }));
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByText(/Loading projects/)).toBeNull();
  });

  it("says which rows are boxes, where a project row says its status", async () => {
    answer([
      { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
      { id: "b1", label: "Paper", status: "active", kind: "box", live_sessions: 0 },
    ]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Paper");
    expect(screen.getByText("Alpha").parentElement?.textContent).toContain("active");
    expect(screen.getByText("Paper").parentElement?.textContent).toContain("box");
  });

  it("counts a row's working, waiting and done agent tabs beside its open tabs", async () => {
    answer([
      { id: "p1", label: "Alpha", status: "active", live_sessions: 5, agents: { working: 2, question: 1, done: 0 } },
      { id: "p2", label: "Beta", status: "active", live_sessions: 1 },
    ]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    expect(screen.getByRole("img", { name: "Working: 2" }).textContent).toContain("2");
    expect(screen.getByRole("img", { name: "Waiting on a decision: 1" })).toBeTruthy();
    // A state with no tab is left out, and so is a row with no agent at work.
    expect(screen.queryByRole("img", { name: /^Done/ })).toBeNull();
    expect(screen.getAllByRole("img", { name: /^(Working|Waiting|Done)/ })).toHaveLength(2);
    expect(screen.getByLabelText("Open tabs: 5").textContent).toBe("5");
    expect(screen.getByLabelText("Open tabs: 1").textContent).toBe("1");
  });

  it("keeps root out of the list: the logo opens it, with a note while proposals wait", async () => {
    const open = vi.fn();
    answer([
      { id: "root", label: "Root", status: "active", kind: "root", live_sessions: 1, pending_reviews: 2 },
      { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
    ]);
    render(<Home tabby={() => {}} open={open} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    expect(screen.queryByText("Root")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open the root console · 2 awaiting approval at the desk" }));
    expect(open).toHaveBeenCalledWith("root");
  });

  it("has no door to root on a phone that is not ticked for it", async () => {
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: /root console/i })).toBeNull();
  });

  it("explains an empty active list and points at search", async () => {
    answer([]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect((await screen.findByText(/No project is active right now/)).textContent).toContain("Search");
  });

  it("distinguishes an empty search from one not yet typed", async () => {
    answer([]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText(/No project is active right now/);
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/Type a project's name/)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText("Project name"), { target: { value: "zeta" } });
    expect(await screen.findByText(/No project by that name/)).toBeTruthy();
  });

  it("sets the voice language from the start page, in any of its views", async () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "en-GB" });
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    // The phone's own settings sit behind the header's gear, not on the page.
    expect(screen.queryByRole("button", { name: /Voice language/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "This device" }));
    const row = within(screen.getByRole("dialog", { name: "This device" })).getByRole("button", { name: /Voice language/ });
    // Until it is set, the row says which language the phone itself reports.
    expect(row.textContent).toContain("en-GB");

    // The row's sheet takes the settings sheet's place; picking comes back to it.
    fireEvent.click(row);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Deutsch" }));
    expect(localStorage.getItem(storageKey("mobile.speechLang"))).toBe("de");
    const settings = screen.getByRole("dialog", { name: "This device" });
    expect(within(settings).getByRole("button", { name: /Voice language/ }).textContent).toContain("Deutsch");
    fireEvent.click(within(settings).getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    // The agents mode replaces the project list, not the phone's own settings.
    fireEvent.click(screen.getByRole("button", { name: /^Working/ }));
    fireEvent.click(screen.getByRole("button", { name: "This device" }));
    await waitFor(() => expect(within(screen.getByRole("dialog", { name: "This device" })).getByRole("button", { name: /Voice language/ }).textContent).toContain("Deutsch"));
  });

  it("shows no git state on a project row, even when the desktop has one", async () => {
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1, git: "unpushed" }]);
    const { container } = render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    expect(screen.queryByText("not pushed")).toBeNull();
    expect(container.querySelector(".git-mark")).toBeNull();
  });

  it("loads the list again on its own once the page is shown after a failed load", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText(/Can't reach your desktop/);
    const failed = fetchMock.mock.calls.length;
    // The host is back; the reader brings the app to the front.
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }]);
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(failed);
    expect(screen.queryByText(/Can't reach your desktop/)).toBeNull();
  });

  it("keeps the last list, and no empty-state copy, when the host drops", async () => {
    answer([{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }]);
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText(/Showing the last list this session loaded/)).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
    expect(screen.queryByText(/No project/)).toBeNull();
  });
});

describe("Mobile home — box layout", () => {
  const rows = [
    { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
    { id: "p2", label: "Beta", status: "active", live_sessions: 0 },
    { id: "b1", label: "Paper", status: "active", kind: "box", live_sessions: 0, members: ["p2", "gone"] },
  ];

  it("folds a box's listed members under it, keeps the rest loose, and remembers it", async () => {
    answer(rows);
    const open = vi.fn();
    render(<Home tabby={() => {}} open={open} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Paper");
    // One button beside the title; its sheet holds the three layouts.
    fireEvent.click(screen.getByRole("button", { name: "Project list layout" }));
    const sheet = screen.getByRole("dialog", { name: "Project list layout" });
    expect(within(sheet).getByRole("button", { name: "List layout" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Boxes layout" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    const box = screen.getByText("Paper").closest("section")!;
    expect(within(box).getByText("Beta")).toBeTruthy();
    expect(within(box).queryByText("Alpha")).toBeNull();
    expect(within(box).getByText(/members: 1/)).toBeTruthy();
    expect(screen.getByText("Alpha").closest("section")).not.toBe(box);
    expect(screen.getAllByText("Beta")).toHaveLength(1);

    fireEvent.click(within(box).getByRole("button", { name: "Fold Paper" }));
    expect(within(box).queryByText("Beta")).toBeNull();
    fireEvent.click(within(box).getByText("Paper"));
    expect(open).toHaveBeenCalledWith("b1");

    cleanup();
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Paper");
    fireEvent.click(screen.getByRole("button", { name: "Project list layout" }));
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Boxes layout" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /close/i }));
    expect(screen.getByRole("button", { name: "Unfold Paper" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("says where to turn a box on when none is on this phone", async () => {
    localStorage.setItem(`${storageKey("mobile.")}projectsBoxes`, "1");
    answer(rows.slice(0, 2));
    render(<Home tabby={() => {}} open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByText(/No box is on this phone/)).toBeTruthy();
    expect(screen.getByText("Alpha")).toBeTruthy();
  });
});
