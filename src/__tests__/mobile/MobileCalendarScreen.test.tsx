/**
 * The Calendar screen in the tool-screen layout: the view segment and Today,
 * labelled step chevrons, the + button that needs a writable calendar, and the
 * ⋯ menu that holds Calendars and Reminders.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Calendar } from "../../../mobile-web/src/screens/Calendar";

const base = { month: "2026-09", week_start: 1, events: [], truncated: false };
const personal = { id: "c1", name: "Personal", color: "#7c6cff", visible: true, readonly: false, subscribed: false, caldav: false };
let calendars = [personal];

beforeEach(() => {
  calendars = [personal];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ calendar: { ...base, calendars } }), { status: 200 })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Mobile calendar screen", () => {
  it("switches the view in a labelled segment and steps with labelled chevrons", async () => {
    render(<Calendar />);
    const views = within(await screen.findByRole("group", { name: "Calendar" }));
    await waitFor(() => expect(views.getByRole("button", { name: "Month" }).hasAttribute("disabled")).toBe(false));
    expect(views.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(views.getByRole("button", { name: "Week" }));
    expect(views.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");
    expect(views.getByRole("button", { name: "Month" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Previous" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeTruthy();
  });

  it("keeps the + button disabled until a calendar can be written to", async () => {
    calendars = [{ ...personal, readonly: true }];
    render(<Calendar />);
    const fab = await screen.findByRole("button", { name: "New event" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));
    expect(fab.hasAttribute("disabled")).toBe(true);
  });

  it("opens the event editor from the + button and closes it with a labelled ×", async () => {
    render(<Calendar />);
    const fab = await screen.findByRole("button", { name: "New event" });
    await waitFor(() => expect(fab.hasAttribute("disabled")).toBe(false));
    fireEvent.click(fab);
    const heading = await screen.findByRole("heading", { name: "New event", level: 2 });
    fireEvent.click(within(heading.closest("form") as HTMLElement).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "New event", level: 2 })).toBeNull());
  });

  it("lists Calendars and Reminders in the ⋯ menu", async () => {
    render(<Calendar />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    const sheet = within(await screen.findByRole("dialog", { name: "Calendar" }));
    expect(sheet.getByRole("button", { name: /^Calendars/ })).toBeTruthy();
    expect(sheet.getByRole("button", { name: /^Reminders/ })).toBeTruthy();
  });
});
