/**
 * A phone paired with a host that has no tmux (Windows): its tabs never reach
 * the phone, so the project screen offers nothing that would open, schedule
 * or send to one — the ＋ sheet keeps only its send-a-file row (the project
 * inbox is a file the sidecar writes), no ◷ on an agent card, no Schedule in
 * the Prompts sheet, no Mark up on a gallery picture — and says why in one
 * line. An older desktop sends no `terminals` field, and the screen is as it
 * was.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const PICTURE = { name: "20261007-120000-plot.png", original: "plot.png", kind: "image/png", size: 4_000, modified: 1_790_000_000 };

function detail(extra: Record<string, unknown>) {
  return {
    project: { id: "p1", label: "Alpha", status: "active", live_sessions: 0 },
    desktop_available: true,
    tabs: [{ id: "t-agent", label: "Claude", kind: "agent", available: false, viewer_busy: false }],
    agents: [{ id: "agent-claude", label: "Claude Code", modes: [], default: true }],
    ...extra,
  };
}

function host(body: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [PICTURE] }), { status: 200 });
    if (url.endsWith("/prompts")) return new Response(JSON.stringify({ prompts: [{ id: "q1", message: "run the nightly benchmark", created_at: "2026-10-07T09:00", updated_at: "2026-10-07T09:00" }] }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

/** The gallery picture, opened through the name menu's 🖼 row. */
async function openPicture() {
  if (!screen.queryByRole("menu", { name: "Project menu" })) fireEvent.click(await screen.findByRole("button", { name: "Project menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: /Files from the agent/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Open plot.png" }));
  return screen.findByRole("dialog", { name: "plot.png" });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — a host with no tmux", () => {
  it("keeps ＋ for sending a file only, hides the cards' ◷ and the Prompts sheet's Schedule, and says why once", async () => {
    const fetch = host(detail({ terminals: "unsupported", shells: true }));
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Claude");
    expect(screen.getByText(/attach through tmux, which it does not have/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Scheduled prompts for Claude" })).toBeNull();
    // The header's ＋ is still there, named for what it can do, and its sheet
    // is the send-a-file row alone: no shell, no agent, no cloud or sign-in
    // rows, and `launch-options` is never asked for.
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send a file from this phone" }));
    const plus = await screen.findByRole("dialog", { name: "Send a file from this phone" });
    expect(within(plus).getByRole("button", { name: /Send a file from this phone/ })).toBeTruthy();
    expect(within(plus).queryByRole("button", { name: "New shell" })).toBeNull();
    expect(within(plus).queryByRole("button", { name: "Claude Code" })).toBeNull();
    expect(within(plus).queryByText(/Opens in .* on your desktop/)).toBeNull();
    expect(within(plus).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent)).toEqual(["Close", expect.stringMatching(/^Send a file from this phone/)]);
    expect(fetch.mock.calls.some(([input]) => String(input).includes("launch-options"))).toBe(false);
    fireEvent.click(within(plus).getByRole("button", { name: "Close" }));
    // The project's collected prompts are files and stay; only Schedule goes.
    fireEvent.click(screen.getByRole("button", { name: /Collected prompts/ }));
    const sheet = await screen.findByRole("dialog", { name: /Collected prompts/ });
    await within(sheet).findByText("run the nightly benchmark");
    expect(within(sheet).getByText("Send now")).toBeTruthy();
    expect(within(sheet).queryByText("Schedule…")).toBeNull();
  });

  it("offers no Mark up on a gallery picture: its Submit would open a tab", async () => {
    vi.stubGlobal("fetch", host(detail({ terminals: "unsupported" })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const viewer = await openPicture();
    expect(within(viewer).queryByRole("button", { name: /^Mark up/ })).toBeNull();
    expect(within(viewer).getByText("Save")).toBeTruthy();
  });

  it("is unchanged when the host sends no field (an older desktop) or says tmux", async () => {
    for (const extra of [{}, { terminals: "tmux" }]) {
      vi.stubGlobal("fetch", host(detail(extra)));
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      await screen.findByText("Claude");
      expect(screen.queryByText(/attach through tmux/)).toBeNull();
      expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Scheduled prompts for Claude" })).toBeTruthy();
      const viewer = await openPicture();
      expect(within(viewer).getByRole("button", { name: /^Mark up/ })).toBeTruthy();
      cleanup();
      vi.unstubAllGlobals();
    }
  });
});
