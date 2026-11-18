/**
 * Managing calendars from the phone: a sheet for the name and colour, the
 * option sheet for a delete, and `subscribed` — the fact, not the feed URL —
 * for a feed calendar. `window.prompt`/`window.confirm` are never called.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "../../../mobile-web/src/screens/Calendar";

const fetchMock = vi.fn();
const posted: unknown[] = [];

const calendar = {
  month: "2026-09",
  week_start: 1,
  calendars: [
    { id: "c1", name: "Personal", color: "#7c6cff", visible: true, readonly: false, subscribed: false, caldav: false },
    { id: "c2", name: "Holidays", color: "#00aa88", visible: true, readonly: false, subscribed: true, caldav: false },
  ],
  events: [],
  truncated: false,
};

beforeEach(() => {
  posted.length = 0;
  fetchMock.mockImplementation(async (_input: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ calendar }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "prompt").mockImplementation(() => { throw new Error("window.prompt must not be used"); });
  vi.spyOn(window, "confirm").mockImplementation(() => { throw new Error("window.confirm must not be used"); });
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openManager() {
  render(<Calendar />);
  // Calendars lives in the head's ⋯ menu; its row's name carries the description.
  fireEvent.click(screen.getByRole("button", { name: "More" }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Calendars/ }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /^Calendars/ }));
  await screen.findByText("Personal");
}

describe("Mobile calendar management", () => {
  it("says a feed calendar is subscribed from the flag alone", async () => {
    await openManager();
    expect(screen.getByText("Holidays").parentElement?.textContent).toContain("Subscribed");
    expect(screen.getByText("Personal").parentElement?.textContent).toContain("Local");
  });

  it("edits a calendar's name and colour in a sheet and saves once", async () => {
    await openManager();
    fireEvent.click(screen.getByRole("button", { name: "Edit Personal" }));
    const sheet = within(screen.getByRole("dialog", { name: "Edit calendar" }));
    fireEvent.change(sheet.getByLabelText("Calendar name"), { target: { value: "Family" } });
    fireEvent.change(sheet.getByLabelText("Colour"), { target: { value: "#112233" } });
    fireEvent.click(sheet.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ type: "update_calendar", calendar_id: "c1", name: "Family", color: "#112233", visible: true });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit calendar" })).toBeNull());
  });

  it("asks in the option sheet before deleting a calendar", async () => {
    await openManager();
    fireEvent.click(screen.getByRole("button", { name: "Delete Personal" }));
    expect(posted).toHaveLength(0);
    const sheet = within(screen.getByRole("dialog", { name: "Delete “Personal”?" }));
    fireEvent.click(sheet.getByRole("button", { name: /Delete calendar and its events/ }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ type: "delete_calendar", calendar_id: "c1" });
  });
});
