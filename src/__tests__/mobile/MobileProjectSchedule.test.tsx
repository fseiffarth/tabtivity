/**
 * The phone's project overview is where scheduling lives — the tab's own screen
 * no longer carries a Schedule chip. Every agent tab shows what it has
 * scheduled and opens the sheet from there, without attaching to the session,
 * and a shell tab has no schedules to offer.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const detail = {
  project: { id: "p1", label: "Alpha", status: "active" },
  desktop_available: true,
  tabs: [
    {
      id: "t-agent",
      label: "Claude",
      kind: "agent",
      available: true,
      viewer_busy: false,
      agent_model: "opus",
      schedules: {
        total: 3,
        enabled: 2,
        next: "2026-09-03T09:00",
        upcoming: [{ text: "run the nightly benchmark", at: "2026-09-03T09:00" }],
      },
    },
    {
      id: "t-quiet",
      label: "Codex",
      kind: "agent",
      available: true,
      viewer_busy: false,
      schedules: { total: 0, enabled: 0 },
    },
    { id: "t-shell", label: "Shell", kind: "shell", available: true, viewer_busy: false },
  ],
  agents: [],
};

describe("Mobile project tab list — scheduled prompts", () => {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
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

  it("offers a schedule control on the agent tab only, and opens the sheet without attaching", async () => {
    const terminal = vi.fn();
    render(<Project id="p1" back={() => {}} terminal={terminal} />);
    const control = await screen.findByRole("button", { name: "Scheduled prompts for Claude" });
    expect(screen.queryByRole("button", { name: "Scheduled prompts for Shell" })).toBeNull();

    fireEvent.click(control);
    expect(await screen.findByRole("dialog", { name: "Scheduled prompts for Claude" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("No prompts are scheduled for this tab.")).toBeTruthy());
    expect(terminal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v1/tabs/t-agent/schedules")).toBe(true);
  });

  it("says what the tab has scheduled without opening the sheet", async () => {
    render(<Project id="p1" back={() => {}} terminal={vi.fn()} />);
    expect(await screen.findByText("2 of 3 scheduled · next 09-03 09:00")).toBeTruthy();
  });

  it("lists upcoming scheduled prompts with the last prompts and puts the ◷ right of the model", async () => {
    render(<Project id="p1" back={() => {}} terminal={vi.fn()} />);
    const text = await screen.findByText("run the nightly benchmark");
    const row = text.closest(".tab-card-prompt");
    expect(row?.classList.contains("scheduled")).toBe(true);
    expect(row?.textContent).toContain("09-03 09:00");

    const control = screen.getByRole("button", { name: "Scheduled prompts for Claude" });
    const model = screen.getByRole("button", { name: "Change the model of Claude" });
    expect(control.parentElement).toBe(model.parentElement);
    expect(model.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says nothing under a tab with no schedules, and offers its first one from the ⋯ sheet", async () => {
    render(<Project id="p1" back={() => {}} terminal={vi.fn()} />);
    // The ◷ is a shortcut to schedules a tab has; a tab with none reaches the
    // sheet through ⋯.
    fireEvent.click(await screen.findByRole("button", { name: "More for Codex" }));
    expect(screen.queryByRole("button", { name: "Scheduled prompts for Codex" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Codex" })).getByRole("button", { name: "Scheduled prompts" }));
    expect(await screen.findByRole("dialog", { name: "Scheduled prompts for Codex" })).toBeTruthy();
    expect(screen.queryByText("No scheduled prompts")).toBeNull();
  });

  it("stops polling the sheet while the app is hidden and catches up on return", async () => {
    // Only the interval is faked, so the async queries above it stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      render(<Project id="p1" back={() => {}} terminal={vi.fn()} />);
      fireEvent.click(await screen.findByRole("button", { name: "Scheduled prompts for Claude" }));
      await screen.findByRole("dialog", { name: "Scheduled prompts for Claude" });
      const scheduleCalls = () => fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/schedules")).length;
      await waitFor(() => expect(scheduleCalls()).toBe(1));

      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      vi.advanceTimersByTime(15_000);
      expect(scheduleCalls()).toBe(1);

      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      await waitFor(() => expect(scheduleCalls()).toBe(2));
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      vi.useRealTimers();
    }
  });
});
