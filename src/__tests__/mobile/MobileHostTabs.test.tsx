/**
 * A remote project's tabs that run on its host, on the phone
 * (`docs/mobile_remote_host_tabs_plan.md`): the host lists them with
 * `on_host`, reached over the desktop's own SSH connection. The card carries
 * an "on host" chip; while the desktop is not connected to the host it says so
 * in one line and never asks the desktop to restart the tab; schedules are
 * offered only while a window is open to type them; and the two new codes
 * (`host_offline`, `tab_on_host`) read as sentences.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TabRow } from "../../../mobile-web/src/api";
import { describeFailure, knownFailureCodes } from "../../../mobile-web/src/connection";
import { schedulesOffered, tabActions } from "../../../mobile-web/src/components/TabCard";
import { Project } from "../../../mobile-web/src/screens/Project";

const hostTab = (over: Partial<TabRow> = {}): TabRow => ({
  id: "t-host", label: "Host Claude", kind: "agent", available: true, viewer_busy: false, on_host: true, ...over,
});
const localTab: TabRow = { id: "t-local", label: "Local Claude", kind: "agent", available: true, viewer_busy: false };

function detail(tabs: TabRow[], extra: Record<string, unknown> = {}) {
  return {
    project: { id: "p1", label: "Alpha", status: "active", live_sessions: 0, host: "remote" },
    desktop_available: true,
    tabs,
    agents: [{ id: "agent-claude", label: "Claude Code", modes: [], default: true }],
    shells: true,
    folder: true,
    create: "agents",
    files: true,
    ...extra,
  };
}

function host(body: Record<string, unknown>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/outbox")) return new Response(JSON.stringify({ files: [] }), { status: 200 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Mobile project screen — tabs on the remote host", () => {
  it("marks a host tab with the on-host chip and opens it like any tab", async () => {
    vi.stubGlobal("fetch", host(detail([hostTab(), localTab])));
    const terminal = vi.fn();
    render(<Project id="p1" back={() => {}} terminal={terminal} />);
    await screen.findByText("Host Claude");
    const chips = Array.from(document.querySelectorAll(".tab-card-meta .agent-mode-mark")).map((chip) => chip.textContent);
    expect(chips).toEqual(["on host"]);
    expect(screen.queryByText("Connect this project on the desktop to open it.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Host Claude" }));
    expect(terminal).toHaveBeenCalledWith(expect.objectContaining({ id: "t-host", on_host: true }));
    // Says what the phone now reaches.
    expect(screen.getByText(/and its tabs on the remote host while the desktop is connected to it/)).toBeTruthy();
  });

  it("says to connect the project on the desktop, and never restarts an unreachable host tab", async () => {
    const fetchMock = host(detail([hostTab({ available: false })]));
    vi.stubGlobal("fetch", fetchMock);
    const terminal = vi.fn();
    render(<Project id="p1" back={() => {}} terminal={terminal} />);
    await screen.findByText("Host Claude");
    expect(screen.getByText("Connect this project on the desktop to open it.")).toBeTruthy();
    const open = screen.getByRole("button", { name: "Open Host Claude" }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    fireEvent.click(open);
    expect(terminal).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/activate"))).toBe(false);
    expect(screen.queryByText("Restarting it so the phone can open it…")).toBeNull();
  });

  it("still restarts a local agent the desktop started before Mobile access", async () => {
    const fetchMock = host(detail([{ ...localTab, available: false }]));
    vi.stubGlobal("fetch", fetchMock);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Local Claude");
    fireEvent.click(screen.getByRole("button", { name: "Open Local Claude" }));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/activate?tab=t-local"))).toBe(true));
  });

  it("offers a host tab's schedules only while a desktop window is open", async () => {
    const scheduled = { total: 1, enabled: 1, next: "2026-10-24T09:00" };
    vi.stubGlobal("fetch", host(detail([hostTab({ schedules: scheduled }), { ...localTab, schedules: scheduled }], { desktop_available: false })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await screen.findByText("Host Claude");
    expect(screen.queryByRole("button", { name: "Scheduled prompts for Host Claude" })).toBeNull();
    expect(screen.getByRole("button", { name: "Scheduled prompts for Local Claude" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More for Host Claude" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByRole("button", { name: "Scheduled prompts" })).toBeNull();
    expect(within(sheet).getByRole("button", { name: "Colour…" })).toBeTruthy();
  });
});

describe("the rules behind the controls", () => {
  it("offers schedules on a host tab only with a window, on any other tab as before", () => {
    expect(schedulesOffered(hostTab(), true, true)).toBe(true);
    expect(schedulesOffered(hostTab(), true, undefined)).toBe(true);
    expect(schedulesOffered(hostTab(), true, false)).toBe(false);
    expect(schedulesOffered(localTab, true, false)).toBe(true);
    expect(schedulesOffered(localTab, false, true)).toBe(false);
    expect(tabActions(hostTab(), schedulesOffered(hostTab(), true, false))).not.toContain("schedule");
    expect(tabActions(hostTab(), schedulesOffered(hostTab(), true, true))).toContain("schedule");
  });

  it("reads the two host codes as sentences, never as themselves", () => {
    expect(knownFailureCodes()).toEqual(expect.arrayContaining(["host_offline", "tab_on_host"]));
    expect(describeFailure("host_offline")).toBe("The desktop is not connected to this project's host. Connect the project on the desktop to open the tab.");
    expect(describeFailure("tab_on_host")).toBe("This tab runs on the project's remote host, where the phone cannot do that.");
  });
});
