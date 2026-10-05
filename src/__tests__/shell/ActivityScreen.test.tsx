/**
 * `Activity` on its own (`mobile-web/src/screens/Activity.tsx`); the Home
 * screen's agents mode around it is MobileAgentsMode. This is the list a phone
 * is picked up to check, so what is pinned is what it says when it cannot
 * answer — loading, the desktop being closed, the host unreachable with or
 * without a list already on screen — the reading each row shows under each
 * sort, the persisted sort choice, and that it stops asking while hidden and
 * aborts its request on unmount.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActivityTab } from "../../../mobile-web/src/api";
import { Activity } from "../../../mobile-web/src/screens/Activity";
import { BRAND, storageKey } from "../../lib/brand";

const fetchMock = vi.fn();
const MIN = 60_000;

function tab(id: string, status: ActivityTab["agent_status"], extra: Partial<ActivityTab> = {}): ActivityTab {
  return {
    id, label: id, kind: "agent", agent_status: status, available: true, viewer_busy: false,
    project_id: "p1", project_label: "Aurora", ...extra,
  };
}

/** A fresh Response per call — a body can only be read once. */
function answer(tabs: ActivityTab[], desktop = true) {
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ tabs, desktop_available: desktop }), { status: 200 }));
}

const small = (label: string) => screen.getByText(label).closest("button")!.querySelector("small")!.textContent;
const cards = () => screen.getAllByRole("button").filter((n) => n.classList.contains("card"));

let visibility = "visible";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Mobile activity list — what it says when it cannot answer", () => {
  it("says it is loading until the first answer, and asks the desktop nothing else", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const onConnection = vi.fn();
    render(<Activity open={() => {}} onConnection={onConnection} />);
    expect(screen.getByRole("status").textContent).toBe("Loading agent tabs…");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/v1/activity");
    expect(onConnection).not.toHaveBeenCalled();
  });

  it("names the outage and says nothing was cached when the first request fails", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const onConnection = vi.fn();
    render(<Activity open={() => {}} onConnection={onConnection} />);
    await screen.findByText("Can't reach your desktop. Is Tailscale on?");
    expect(screen.getByText("Agent activity is never loaded from cache.")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
    expect(onConnection).toHaveBeenLastCalledWith("unreachable");
  });

  it("keeps the last good list on a later failure and says so", async () => {
    answer([tab("Claude", "done")]);
    const onConnection = vi.fn();
    render(<Activity open={() => {}} onConnection={onConnection} />);
    await screen.findByText("Claude");
    expect(onConnection).toHaveBeenLastCalledWith(null);

    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText(`${BRAND.display} isn't running on your desktop.`);
    expect(screen.getByText("Showing the last list this session loaded.")).toBeTruthy();
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(onConnection).toHaveBeenLastCalledWith("desktop_down");
  });

  it("distinguishes the desktop being closed from nothing happening", async () => {
    answer([], false);
    const { unmount } = render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText(/Desktop unavailable/);
    expect(screen.queryByText(/Nothing is working/)).toBeNull();
    unmount();

    answer([], true);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText(/Nothing is working, waiting or done/);
    expect(screen.queryByText(/Desktop unavailable/)).toBeNull();
  });
});

describe("Mobile activity list — rows", () => {
  it("shows the reading the current sort orders by, and switches it with the sort", async () => {
    const now = Date.now();
    answer([
      tab("Working", "working", { working_at: now - 2 * MIN, done_at: now - 60 * MIN }),
      tab("Done", "done", { done_at: now - 3 * MIN }),
      tab("Asking", "question", { working_at: now - 10 * MIN, done_at: now - 1 * MIN }),
      tab("Fresh", "done"),
    ]);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("Working");

    // lastWorking (default): the tiers, then the reading each tier carries.
    expect(cards().map((c) => c.querySelector("strong")!.textContent)).toEqual(["Asking", "Working", "Done", "Fresh"]);
    expect(small("Working")).toBe("Aurora · working now");
    expect(small("Done")).toBe("Aurora · finished 3m ago");
    expect(small("Asking")).toBe("Aurora · worked 10m ago");
    expect(small("Fresh")).toBe("Aurora");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort agent tabs" }), { target: { value: "lastDone" } });
    expect(cards().map((c) => c.querySelector("strong")!.textContent)).toEqual(["Asking", "Done", "Working", "Fresh"]);
    expect(small("Working")).toBe("Aurora · finished 60m ago");
    expect(small("Asking")).toBe("Aurora · finished 1m ago");
    expect(small("Fresh")).toBe("Aurora");

    fireEvent.change(screen.getByRole("combobox", { name: "Sort agent tabs" }), { target: { value: "native" } });
    expect(cards().map((c) => c.querySelector("strong")!.textContent)).toEqual(["Working", "Done", "Asking", "Fresh"]);
    expect(small("Working")).toBe("Aurora · working now");
    expect(small("Asking")).toBe("Aurora · worked 10m ago");
  });

  it("rounds ages the way a glance reads them", async () => {
    const now = Date.now();
    answer([
      tab("Now", "done", { done_at: now - 20_000 }),
      tab("Hour", "done", { done_at: now - 100 * MIN }),
      tab("Days", "done", { done_at: now - 40 * 60 * MIN }),
    ]);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("Now");
    expect(small("Now")).toBe("Aurora · finished just now");
    expect(small("Hour")).toBe("Aurora · finished 2h ago");
    expect(small("Days")).toBe("Aurora · finished 2d ago");
  });

  it("remembers the sort choice for the next mount, and offers no sort for a single tab", async () => {
    answer([tab("A", "done"), tab("B", "done")]);
    const { unmount } = render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("A");
    fireEvent.change(screen.getByRole("combobox", { name: "Sort agent tabs" }), { target: { value: "native" } });
    expect(localStorage.getItem(storageKey("mobile.agentsSort"))).toBe("native");
    unmount();

    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("A");
    expect((screen.getByRole("combobox", { name: "Sort agent tabs" }) as HTMLSelectElement).value).toBe("native");
    cleanup();

    answer([tab("Only", "done")]);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("Only");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("marks a busy tab and disables a gone one; a tap opens the tab in its project", async () => {
    const rows = [
      tab("Busy", "working", { viewer_busy: true, agent_model: "opus" }),
      tab("Gone", "done", { available: false }),
      tab("Free", "question"),
    ];
    answer(rows);
    const open = vi.fn();
    render(<Activity open={open} onConnection={() => {}} />);
    await screen.findByText("Busy");
    expect(small("Busy")).toBe("Aurora · opus · working now · open elsewhere");
    expect(small("Gone")).toBe("Aurora · gone");
    expect((screen.getByText("Gone").closest("button") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Free").closest("button")!);
    expect(open).toHaveBeenCalledWith("p1", rows[2]);
    expect(screen.getByText("Free").closest("button")!.querySelector(".agent-status")!.textContent).toBe("?question");
  });
});

describe("Mobile activity list — plan and goal", () => {
  it("wears the desktop's PLAN / GOAL pills and a tinted edge while the session is in either", async () => {
    answer([
      tab("Planner", "working", { agent_plan: true }),
      tab("Chaser", "working", { agent_goal: true }),
      tab("Both", "done", { agent_plan: true, agent_goal: true }),
      tab("Plain", "done"),
    ]);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    await screen.findByText("Planner");
    const marks = (label: string) => [...screen.getByText(label).closest("button")!.querySelectorAll(".agent-mode-mark")].map((n) => n.textContent);
    const card = (label: string) => screen.getByText(label).closest("button")!;
    expect(marks("Planner")).toEqual(["PLAN"]);
    expect(card("Planner").classList.contains("in-plan")).toBe(true);
    expect(marks("Chaser")).toEqual(["GOAL"]);
    expect(card("Chaser").classList.contains("in-goal")).toBe(true);
    expect(marks("Both")).toEqual(["PLAN", "GOAL"]);
    expect(card("Both").classList.contains("in-plan")).toBe(true);
    expect(marks("Plain")).toEqual([]);
    expect(card("Plain").className).not.toMatch(/in-(plan|goal)/);
  });
});

describe("Mobile activity list — polling discipline", () => {
  it("does not ask while the page is hidden, and catches up when it is shown", async () => {
    visibility = "hidden";
    answer([tab("Late", "done")]);
    render(<Activity open={() => {}} onConnection={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("Late");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("aborts the in-flight request on unmount and ignores its outcome", async () => {
    let settle: (r: Response) => void = () => {};
    fetchMock.mockImplementation((_: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      settle = resolve;
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const onConnection = vi.fn();
    const { unmount } = render(<Activity open={() => {}} onConnection={onConnection} />);
    const signal = (fetchMock.mock.calls[0][1] as RequestInit).signal!;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
    settle(new Response("{}", { status: 200 }));
    await waitFor(() => expect(onConnection).not.toHaveBeenCalled());
  });
});
