/**
 * The phone's project screen offers the project's collected prompts beside
 * the per-tab ◷: the sheet lists them through the opaque project id, "Send
 * now" posts the chosen agent tab's opaque id, and "Schedule…" hands the text
 * to the per-tab sheet prefilled — without attaching to any session.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const detail = {
  project: { id: "p1", label: "Alpha", status: "active" },
  desktop_available: true,
  tabs: [
    { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  ],
  agents: [],
};
const prompts = { prompts: [{ id: "pr-1", message: "Run the tests", created_at: "x", updated_at: "x" }] };

describe("Mobile project — collected prompts", () => {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/prompts") || url.endsWith("/send")) {
      return new Response(JSON.stringify(prompts), { status: init?.method === "POST" ? 201 : 200 });
    }
    if (url.endsWith("/schedules")) {
      return new Response(JSON.stringify({ schedules: [], time_zone: "Europe/Berlin", next_runs: {} }), { status: 200 });
    }
    return new Response(JSON.stringify(detail), { status: 200 });
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("sends a prompt to the agent tab and schedules one with the text prefilled", async () => {
    const terminal = vi.fn();
    render(<Project id="p1" back={() => {}} terminal={terminal} />);
    // The row renders disabled until the project's detail has loaded; a click
    // before then is dropped and the sheet never opens.
    const open = await screen.findByRole("button", { name: "Collected prompts" });
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(open);
    expect(await screen.findByRole("dialog", { name: "Collected prompts" })).toBeTruthy();
    expect(await screen.findByText("Run the tests")).toBeTruthy();
    // Only the agent tab is a target.
    const options = [...document.querySelectorAll(".mobile-prompt-target option")].map((option) => option.textContent);
    expect(options).toEqual(["Claude"]);

    fireEvent.click(screen.getByRole("button", { name: "Send now: Run the tests" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) =>
      String(input) === "/api/v1/projects/p1/prompts/pr-1/send"
      && init?.method === "POST"
      && JSON.parse(String(init?.body)).tab_id === "t-agent")).toBe(true));
    expect(await screen.findByText(/Queued for Claude/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Schedule…" }));
    const sheet = await screen.findByRole("dialog", { name: "Scheduled prompts for Claude" });
    expect((sheet.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Run the tests");
    expect(terminal).not.toHaveBeenCalled();
  });
});
