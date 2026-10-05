/**
 * A write the desktop made, whose refreshed list was too large to relay, is
 * answered `applied_response_too_large` — and must not read as a failed write:
 * the reader would send it again and a Create would land twice. The phone
 * reloads the list through its read route instead (`reloadIfApplied`), clears
 * the form as on success, and, when even the reload cannot be shown, says the
 * change was made rather than that it was refused.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, createPrompt, reloadIfApplied, resolveAlert, wasApplied } from "../../../mobile-web/src/api";
import type { TodoCard, TodoColumn } from "../../../mobile-web/src/api";
import { describeFailure } from "../../../mobile-web/src/connection";
import { ScheduleSheet } from "../../../mobile-web/src/screens/ScheduleSheet";
import { Todo } from "../../../mobile-web/src/screens/Todo";

const APPLIED = "applied_response_too_large";
const refusal = (code: string, status = 400) => new Response(JSON.stringify({ error: code }), { status });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** What each route answers, per method; replaced by each test. */
let answer: (method: string, url: string) => Response = () => refusal("unset");
const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => answer(init?.method ?? "GET", String(input)));
const calls = (method: string) => fetchMock.mock.calls.filter(([, init]) => (init?.method ?? "GET") === method);

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockClear();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("reloadIfApplied", () => {
  it("answers an applied write with the list from the read route", async () => {
    answer = (method) => method === "POST" ? refusal(APPLIED) : ok({ prompts: [{ id: "p1", message: "Review" }] });
    const list = await createPrompt("project", "Review");
    expect(list.prompts).toHaveLength(1);
    expect(calls("POST")).toHaveLength(1);
    expect(calls("GET")).toHaveLength(1);
    expect(String(calls("GET")[0][0])).toBe("/api/v1/projects/project/prompts");
  });

  it("leaves a real refusal and a too-large read as they are", async () => {
    await expect(reloadIfApplied(Promise.reject(new ApiError(400, "invalid_task")), async () => "reloaded"))
      .rejects.toMatchObject({ code: "invalid_task" });
    // On a read the code keeps its meaning; nothing was applied.
    const tooLarge = new ApiError(400, "response_too_large");
    await expect(reloadIfApplied(Promise.reject(tooLarge), async () => "reloaded")).rejects.toBe(tooLarge);
    expect(wasApplied(tooLarge)).toBe(false);
    expect(wasApplied(new ApiError(503, "desktop_unavailable"))).toBe(false);
  });

  it("says the change was made when the reload cannot be shown either", async () => {
    answer = (method) => refusal(method === "POST" ? APPLIED : "response_too_large");
    const tooLarge = await resolveAlert("row").catch((reason: unknown) => reason);
    expect(tooLarge).toMatchObject({ code: "applied_list_too_large" });
    expect(wasApplied(tooLarge)).toBe(true);
    expect(describeFailure(tooLarge)).toBe("The change was made, but the list is now too large to show on the phone.");

    answer = (method) => method === "POST" ? refusal(APPLIED) : refusal("desktop_unavailable", 503);
    const closed = await resolveAlert("row").catch((reason: unknown) => reason);
    expect(closed).toMatchObject({ code: "applied_reload_failed" });
    expect(wasApplied(closed)).toBe(true);
    // Not the "desktop is closed" title a 503 would otherwise be given.
    expect(describeFailure(closed)).toBe("The change was made, but the list could not be reloaded.");
    // One write each, never a second.
    expect(calls("POST")).toHaveLength(2);
  });
});

describe("Mobile schedule sheet, applied write", () => {
  const created = { id: "s1", enabled: true, message: "Review the diff", rule: { type: "daily", time: "07:30" } };
  const list = (schedules: unknown[]) => ok({ schedules, time_zone: "Europe/Berlin", next_runs: {} });
  const fill = async () => {
    render(<ScheduleSheet tabId="tab" label="Claude" onClose={() => {}} />);
    await screen.findByText("No prompts are scheduled for this tab.");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Review the diff" } });
    fireEvent.change(screen.getByLabelText("Recurrence"), { target: { value: "daily" } });
    fireEvent.change(screen.getByLabelText("Desktop-local time"), { target: { value: "07:30" } });
  };

  it("reloads the list and clears the form, with one write", async () => {
    let posted = false;
    answer = (method) => {
      if (method === "POST") { posted = true; return refusal(APPLIED); }
      return list(posted ? [created] : []);
    };
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Daily · 07:30")).toBeTruthy();
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls("POST")).toHaveLength(1);
  });

  it("clears the form and says the change was made when the list cannot be shown", async () => {
    let posted = false;
    answer = (method) => {
      if (method === "POST") { posted = true; return refusal(APPLIED); }
      return posted ? refusal("response_too_large") : list([]);
    };
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent)
      .toBe("The change was made, but the list is now too large to show on the phone."));
    // Nothing left in the form to send a second time.
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
    expect(calls("POST")).toHaveLength(1);
  });

  it("keeps the form for a write the desktop refused", async () => {
    answer = (method) => method === "POST" ? refusal("invalid_request") : list([]);
    await fill();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Review the diff");
  });
});

describe("Mobile board, applied write", () => {
  const COLUMNS: TodoColumn[] = [
    { id: "doing", name: "Doing", position: 0, done: false, archived: false, intake: true, overdue: false, due_today: false },
    { id: "done", name: "Done", position: 1, done: true, archived: false, intake: false, overdue: false, due_today: false },
  ];
  const card = (over: Partial<TodoCard> = {}): TodoCard => ({
    id: "card", title: "Write it up", notes: "", column: "doing", done: false,
    priority: 0, percent: 0, calendar_id: "calendar", tags: [], subtasks: [], ...over,
  });
  const board = (tasks: TodoCard[]) => ok({ board: { columns: COLUMNS, tasks, calendars: [{ id: "calendar", name: "Personal" }], projects: [] } });

  it("shows the board from the read route after a tick whose answer was too large", async () => {
    let posted = false;
    answer = (method) => {
      if (method === "POST") { posted = true; return refusal(APPLIED); }
      return board(posted ? [card({ title: "Ticked on the desktop" })] : [card()]);
    };
    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Mark Write it up done"));
    await waitFor(() => expect(screen.getByText("Ticked on the desktop")).toBeTruthy());
    expect(calls("POST")).toHaveLength(1);
    expect(calls("GET")).toHaveLength(2);
    expect(screen.queryByText(/could not|rejected|error/i)).toBeNull();
  });

  it("says the change was made when the board is too large to show", async () => {
    let posted = false;
    answer = (method) => {
      if (method === "POST") { posted = true; return refusal(APPLIED); }
      return posted ? refusal("response_too_large") : board([card()]);
    };
    render(createElement(Todo));
    await waitFor(() => expect(screen.getByText("Write it up")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("Mark Write it up done"));
    await waitFor(() => expect(screen.getByText("The change was made, but the list is now too large to show on the phone.")).toBeTruthy());
    expect(calls("POST")).toHaveLength(1);
  });
});
