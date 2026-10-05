/**
 * The phone's Alerts rows carry the desktop strip's ✓.
 *
 * What the button *does* is the desktop's (`lib/alertDone`, reached over the
 * bridge); what is asserted here is the boundary the phone keeps: it sends the
 * opaque row handle and nothing else, it takes the resulting list from the
 * answer rather than patching its own copy, and a row the desktop minted no
 * handle for gets no ✓ at all.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileAlertItem, MobileAlerts } from "../../../mobile-web/src/api";
import { Home } from "../../../mobile-web/src/screens/Home";
import { BRAND } from "../../lib/brand";

const fetchMock = vi.fn();

const row = (over: Partial<MobileAlertItem> = {}): MobileAlertItem => ({
  kind: "task",
  severity: "overdue",
  title: "Ship mobile alerts",
  detail: BRAND.display,
  at: "2026-09-03",
  all_day: true,
  minutes_away: -60,
  days_away: -1,
  task_id: "opaque-task",
  alert_id: "opaque-row",
  ...over,
});

/** The alerts route answers `feed`, then whatever the writes queue holds; the
 *  project list is always empty, so only the alert rows are on screen. */
function serve(feed: MobileAlerts, afterWrite?: MobileAlerts) {
  const posts: { path: string; body: unknown }[] = [];
  fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/v1/alerts")) {
      if (init?.method === "POST") {
        posts.push({ path: url, body: JSON.parse(String(init.body)) });
        if (!afterWrite) return new Response(JSON.stringify({ error: "alert_gone" }), { status: 400 });
        return new Response(JSON.stringify({ alerts: afterWrite }), { status: 200 });
      }
      return new Response(JSON.stringify({ alerts: feed }), { status: 200 });
    }
    return new Response(JSON.stringify({ projects: [] }), { status: 200 });
  });
  return posts;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const noop = () => {};

describe("Mobile alerts — the desktop's Done button", () => {
  it("sends only the row handle and renders the feed the desktop answers with", async () => {
    const posts = serve(
      { enabled: true, items: [row()] },
      { enabled: true, items: [row({ title: "Next thing", alert_id: "opaque-row-2" })] },
    );
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    fireEvent.click(await screen.findByLabelText("Mark this to-do done"));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toEqual({ path: "/api/v1/alerts", body: { alert_id: "opaque-row" } });
    // The ticked row is gone because the answer no longer lists it — not
    // because the phone decided what a ✓ removes.
    expect(await screen.findByText("Next thing")).toBeTruthy();
    expect(screen.queryByText("Ship mobile alerts")).toBeNull();
  });

  it("names each kind's own resolution, and never calls any of them a delete", async () => {
    serve({
      enabled: true,
      items: [
        row({ kind: "mail", title: "Invoice", alert_id: "row-mail" }),
        row({ kind: "event", title: "Stand-up", alert_id: "row-event" }),
      ],
    });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByLabelText("Return this mail to normal")).toBeTruthy();
    expect(screen.getByLabelText("Remove this appointment from alerts")).toBeTruthy();
  });

  it("says the desktop refused instead of quietly dropping the row", async () => {
    serve({ enabled: true, items: [row()] });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    fireEvent.click(await screen.findByLabelText("Mark this to-do done"));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be completed");
    // The row it failed on is still there to try again.
    expect(screen.getByText("Ship mobile alerts")).toBeTruthy();
  });

  it("gives no ✓ to a row the desktop minted no handle for", async () => {
    serve({ enabled: true, items: [row({ alert_id: undefined })] });
    render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);
    expect(await screen.findByText("Ship mobile alerts")).toBeTruthy();
    expect(screen.queryByLabelText("Mark this to-do done")).toBeNull();
  });
});
