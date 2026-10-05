import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatusReport, TabRow } from "../../../mobile-web/src/api";
import { StatusSheet, resetCountdown, resetText } from "../../../mobile-web/src/screens/StatusSheet";
import { BRAND } from "../../lib/brand";

// `fetch` rather than the api module: `getAgentStatus` calls `api` through its
// own module-local binding, which a module mock never reaches — and stubbing
// the transport exercises the real route, the real `?refresh=1`, and the real
// error mapping instead of asserting against a stand-in for all three.
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

function respond(status: number, body: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

const urlOf = (call: unknown[]) => String(call[0]);

const tab: TabRow = {
  id: "tab-1",
  label: "Claude — feature work",
  kind: "agent",
  agent_label: "Claude",
  agent_status: "working",
  available: true,
  viewer_busy: false,
};

function report(overrides: Partial<AgentStatusReport> = {}): AgentStatusReport {
  return {
    state: "working",
    label: tab.label,
    agent: "Claude",
    project: `Project${BRAND.display}`,
    today: { prompts: 14, worked_s: 4920, decisions: 3, done: 5 },
    usage: {
      label: "Claude Code",
      supported: true,
      cached: false,
      raw: "Current session: 71% used · resets 6:20pm\nCurrent week (all models): 38% used",
    },
    ...overrides,
  };
}

function answer(value: AgentStatusReport) {
  fetchMock.mockImplementation(() => respond(200, { report: value }));
}

describe(`${BRAND.display} Mobile agent status sheet`, () => {
  it("shows the session state beside the quota the CLI reported", async () => {
    answer(report());
    render(<StatusSheet tab={tab} live={{ model: "opus", mode: "plan", context: "62%" }} onClose={() => {}} />);
    await screen.findByText("Working");
    // The phone's own status-line facts sit next to the account-wide figures;
    // they are about different things and both belong on the headline.
    expect(screen.getByText("opus")).toBeTruthy();
    expect(screen.getByText("62% context left")).toBeTruthy();
    expect(screen.getByText("Current session")).toBeTruthy();
    expect(screen.getByLabelText("Current session: 71% used")).toBeTruthy();
    // The reset is placed in time; the CLI's own words stay one hover away.
    expect(screen.getByTitle("resets 6:20pm").textContent).toMatch(/^resets .+ · in \d+/u);
  });

  it("names the exact reset instant, not just the day the CLI printed", () => {
    // 20:00 UTC is 22:00 in Berlin, so the 2pm reset two days out is 40h away
    // whatever zone the test runs in.
    const now = new Date("2026-09-15T20:00:00Z");
    const text = resetText("Sep 17, 2pm (Europe/Berlin)", now);
    const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .format(new Date("2026-09-17T12:00:00Z"));
    expect(text).toContain(clock);
    expect(text).toMatch(/ · in 40h 0m$/u);
    expect(resetText("Mon 9am", new Date(2026, 8, 14, 8, 0))).toMatch(/ · in 1h 0m$/u);
    expect(resetText("Sep 15, 9am (Europe/Berlin)", now)).not.toContain(" · in ");
    // What cannot be placed is shown as the CLI said it, never guessed at.
    expect(resetText("when the moon is full", now)).toBe("resets when the moon is full");
  });

  it("does not move a bare reset clock to tomorrow after the panel gets old", () => {
    const readAt = new Date(2026, 8, 15, 17, 0);
    expect(resetCountdown("6:20pm", new Date(2026, 8, 15, 18, 0), readAt)).toBe("20m");
    expect(resetCountdown("6:20pm", new Date(2026, 8, 15, 18, 21), readAt)).toBe("");
  });

  it("shows minutes instead of a zero hours past two days", () => {
    const readAt = new Date(2026, 8, 14, 8, 0);
    // Mon 9am from Thu 8:23 is 4d 0h 37m away; from Thu 7:23 it is 4d 1h 37m.
    expect(resetCountdown("Mon 9am", new Date(2026, 8, 17, 8, 23), new Date(2026, 8, 17, 8, 0))).toBe("4d 37m");
    expect(resetCountdown("Mon 9am", new Date(2026, 8, 17, 7, 23), new Date(2026, 8, 17, 7, 0))).toBe("4d 1h");
    expect(resetCountdown("6:20pm", new Date(2026, 8, 14, 8, 0), readAt)).toBe("10h 20m");
  });

  it("labels the project-wide counters as project-wide, not as this agent's", async () => {
    answer(report());
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    await screen.findByText(`Today in Project${BRAND.display}`);
    expect(screen.getByText("14 prompts to Claude")).toBeTruthy();
    // 4920s is 1h 22m, and the wording must not claim it for Claude alone.
    expect(screen.getByText(/Across every agent tab in this project: 1h 22m working/u)).toBeTruthy();
    expect(screen.getByText(/3 decisions/u)).toBeTruthy();
  });

  it("shows the panel exactly as the CLI printed it in Terminal view", async () => {
    answer(report());
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    await screen.findByText("Current session");
    fireEvent.click(screen.getByText("Terminal"));
    const raw = screen.getByLabelText("Usage panel as the CLI printed it");
    expect(raw.textContent).toContain("Current session: 71% used · resets 6:20pm");
    expect(raw.textContent).toContain("Current week (all models): 38% used");
  });

  it("says an agent has no readable usage instead of showing an empty panel", async () => {
    answer(report({
      agent: "Codex",
      // The desktop sends the reason as a code; the sheet names the agent itself.
      usage: { label: "Codex", supported: false, cached: false, error: "no_usage_readout" },
    }));
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    await screen.findByText(`Codex has no usage readout ${BRAND.display} can ask for without opening a tab.`);
    // The session half still answers — the refusal is about the quota only.
    expect(screen.getByText("Working")).toBeTruthy();
    expect(screen.getByText(`Today in Project${BRAND.display}`)).toBeTruthy();
  });

  it("points at the raw text when the panel is a shape it cannot read", async () => {
    answer(report({ usage: { label: "Claude Code", supported: true, cached: false, raw: "Plenty left this week." } }));
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    await screen.findByText(new RegExp(String.raw`Claude Code answered in a shape ${BRAND.display} does not recognize`, "u"));
    fireEvent.click(screen.getByText("Terminal"));
    expect(screen.getByLabelText("Usage panel as the CLI printed it").textContent).toContain("Plenty left this week.");
  });

  it("asks the desktop to run the CLI again only when Refresh is tapped", async () => {
    answer(report());
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    await screen.findByText("Current session");
    expect(urlOf(fetchMock.mock.calls[0])).toBe("/api/v1/tabs/tab-1/status");
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
    expect(urlOf(fetchMock.mock.calls[1])).toBe("/api/v1/tabs/tab-1/status?refresh=1");
  });

  it(`names desktop ${BRAND.display} when the bridge is what is missing`, async () => {
    fetchMock.mockImplementation(() => respond(503, { error: "desktop_unavailable" }));
    render(<StatusSheet tab={tab} live={null} onClose={() => {}} />);
    // The one vocabulary (`connection.ts`): the same sentence every screen uses.
    await screen.findByText(`${BRAND.display} isn't running on your desktop.`);
  });
});
