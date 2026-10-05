/**
 * `ScheduleSheet` on its own (opening it from the Project screen is
 * MobileProjectSchedule). What the sheet itself promises: the three rule shapes
 * cross the wire as the desktop's own JSON — weekdays sorted, `once` as a local
 * stamp — the empty-prompt / no-weekday refusal sends nothing, an edit fills
 * the form and PUTs against the schedule's id, and a closed desktop disables
 * every control rather than letting a write fail one at a time.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledPrompt } from "../../../mobile-web/src/api";
import { ScheduleSheet } from "../../../mobile-web/src/screens/ScheduleSheet";
import { BRAND } from "../../lib/brand";

const TAB = "tab one";
const PATH = "/api/v1/tabs/tab%20one/schedules";

let schedules: ScheduledPrompt[] = [];
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  if (!url.startsWith(PATH)) throw new Error(`unexpected ${method} ${url}`);
  if (method === "POST") {
    schedules = [...schedules, { id: `s${schedules.length + 1}`, ...JSON.parse(String(init?.body)) }];
  } else if (method === "PUT") {
    const id = decodeURIComponent(url.slice(PATH.length + 1));
    schedules = schedules.map((s) => (s.id === id ? { id, ...JSON.parse(String(init?.body)) } : s));
  } else if (method === "DELETE") {
    const id = decodeURIComponent(url.slice(PATH.length + 1));
    schedules = schedules.filter((s) => s.id !== id);
  }
  return new Response(JSON.stringify({ schedules, time_zone: "Europe/Berlin", next_runs: { s1: "2026-09-16T09:00" } }), { status: 200 });
});

const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);
const lastBody = (method: string) => {
  const list = calls(method);
  return JSON.parse(String(list[list.length - 1][1]?.body));
};

beforeEach(() => {
  schedules = [];
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
});

describe("Mobile schedule sheet", () => {
  it("creates a daily rule with the desktop's payload shape, then clears the form", async () => {
    render(<ScheduleSheet tabId={TAB} label="Claude" onClose={() => {}} />);
    expect(await screen.findByText("No prompts are scheduled for this tab.")).toBeTruthy();
    expect(screen.getByText("Desktop time zone: Europe/Berlin")).toBeTruthy();
    // A new schedule starts as a one-time prompt; recurring is opt-in.
    expect((screen.getByLabelText("Recurrence") as HTMLSelectElement).value).toBe("once");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Review the diff" } });
    fireEvent.change(screen.getByLabelText("Recurrence"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("Desktop-local time"), { target: { value: "07:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(lastBody("POST")).toEqual({ enabled: true, message: "Review the diff", rule: { type: "daily", time: "07:30" } });
    expect(await screen.findByText("Daily · 07:30")).toBeTruthy();
    expect(screen.getByText("Next: 2026-09-16 09:00 (Europe/Berlin)")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Recurrence") as HTMLSelectElement).value).toBe("once");
  });

  it("sends the weekdays sorted, and refuses a rule with none picked without a request", async () => {
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} initialMessage="Nightly build" />);
    await screen.findByText("No prompts are scheduled for this tab.");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Nightly build");
    fireEvent.change(screen.getByLabelText("Recurrence"), { target: { value: "weekdays" } });
    // Mon–Fri are preselected; drop them all, then pick Sun and Wed in that order.
    for (const day of ["Mon", "Tue", "Wed", "Thu", "Fri"]) fireEvent.click(screen.getByLabelText(day));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Enter a prompt and choose at least one weekday.");
    expect(calls("POST")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("Sun"));
    fireEvent.click(screen.getByLabelText("Wed"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(lastBody("POST").rule).toEqual({ type: "weekdays", weekdays: [3, 7], time: "09:00" });
    expect(await screen.findByText("Wed, Sun · 09:00")).toBeTruthy();
  });

  it("sends a one-time rule as the typed local stamp and lists it with a space for the T", async () => {
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    await screen.findByText("No prompts are scheduled for this tab.");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Ship it" } });
    fireEvent.change(screen.getByLabelText("Recurrence"), { target: { value: "once" } });
    fireEvent.change(screen.getByLabelText("Desktop-local date and time"), { target: { value: "2026-12-24T18:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("POST")).toHaveLength(1));
    expect(lastBody("POST").rule).toEqual({ type: "once", at: "2026-12-24T18:00" });
    expect(await screen.findByText("2026-12-24 18:00")).toBeTruthy();
  });

  it("refuses an empty prompt without a request", async () => {
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    await screen.findByText("No prompts are scheduled for this tab.");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(calls("POST")).toHaveLength(0);
  });

  it("edits in place — the form fills from the rule and the save PUTs against its id, keeping its enabled state", async () => {
    schedules = [{ id: "s1", enabled: false, message: "Old text", rule: { type: "weekdays", weekdays: [1, 5], time: "10:15" } }];
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    expect(screen.getByText("Edit schedule")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Old text");
    expect((screen.getByLabelText("Recurrence") as HTMLSelectElement).value).toBe("weekdays");
    expect((screen.getByLabelText("Desktop-local time") as HTMLInputElement).value).toBe("10:15");
    expect((screen.getByLabelText("Mon") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Tue") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "New text" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));
    expect(String(calls("PUT")[0][0])).toBe(`${PATH}/s1`);
    expect(lastBody("PUT")).toEqual({ enabled: false, message: "New text", rule: { type: "weekdays", weekdays: [1, 5], time: "10:15" } });
    expect(calls("POST")).toHaveLength(0);
    await waitFor(() => expect(screen.getByText("Add schedule")).toBeTruthy());
  });

  it("Cancel leaves an edit without writing, and the toggle and Delete address the rule's id", async () => {
    schedules = [{ id: "s1", enabled: true, message: "Keep", rule: { type: "daily", time: "09:00" }, last: { occurrence: "x", result: "delivered", at: "2026-09-15T09:00:00Z" } }];
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Add schedule")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText(/Last: delivered/)).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Enabled"));
    await waitFor(() => expect(calls("PUT")).toHaveLength(1));
    expect(lastBody("PUT")).toMatchObject({ enabled: false, message: "Keep" });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("DELETE")).toHaveLength(1));
    expect(String(calls("DELETE")[0][0])).toBe(`${PATH}/s1`);
    expect(await screen.findByText("No prompts are scheduled for this tab.")).toBeTruthy();
  });

  it("disables the whole form when the desktop is closed, and says why", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: "desktop_unavailable" }), { status: 503 }));
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toBe(`Open desktop ${BRAND.display} to manage scheduled prompts.`);
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText("Recurrence") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the form live when the host answered off its files with no window (H3), and says so", async () => {
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ schedules: [], time_zone: "Europe/Berlin", next_runs: {}, desktop_available: false }), { status: 200 }));
    render(<ScheduleSheet tabId={TAB} onClose={() => {}} />);
    expect((await screen.findByRole("status")).textContent).toContain(`The ${BRAND.display} window is closed`);
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("closes from ✕ and the backdrop, not from a tap inside the sheet", async () => {
    const onClose = vi.fn();
    render(<ScheduleSheet tabId={TAB} onClose={onClose} />);
    await screen.findByText("No prompts are scheduled for this tab.");
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("presentation"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
