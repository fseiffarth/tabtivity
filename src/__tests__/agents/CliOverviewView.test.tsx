/**
 * The side panel's CLIs view: one toolbar with one Refresh, then per CLI a
 * plain two-line row with its usage meters on the kit's share bar.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));

import { CliOverviewView } from "../../components/agents/CliOverviewView";
import { usePowerStore } from "../../stores/power";
import { useTabsStore } from "../../stores/tabs";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useTabsStore.setState((state) => ({ ...state, tabsByScope: {} }));
  // The poll reads only in a focused window.
  usePowerStore.setState({ blurred: false });
});

describe("CliOverviewView", () => {
  it("lists each CLI as a row with its plan, account and meters, none tinted near the limit", async () => {
    vi.mocked(invoke).mockResolvedValue([{
      id: "claude",
      label: "Claude",
      signedIn: true,
      account: "me@example.org",
      plan: { name: "pro" },
      usage: { raw: "Current session: 95% used", cached: false },
    }]);
    await act(async () => { render(<CliOverviewView active />); });
    const card = screen.getByRole("article", { name: "Claude" });
    expect(card.querySelector(".sp-row.sp-row--plain")).not.toBeNull();
    expect(within(card).getByText("Pro")).toBeTruthy();
    expect(within(card).getByText("me@example.org")).toBeTruthy();
    expect(within(card).getByText("95% used")).toBeTruthy();
    const bar = within(card).getByRole("img", { name: /Current session/ });
    expect(bar.className).toBe("sp-bar");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("95%");
  });

  it("asks again, bypassing the cache, from its one Refresh", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await act(async () => { render(<CliOverviewView active />); });
    expect(screen.getByText("No agent CLI is signed in yet.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    const calls = vi.mocked(invoke).mock.calls;
    expect(calls[calls.length - 1]).toEqual(["agent_overview", { refresh: true }]);
  });

  it("reads once on show, not again on its own answer's re-render", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await act(async () => { render(<CliOverviewView active />); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === "agent_overview")).toHaveLength(1);
  });

  it("says so when the read fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    await act(async () => { render(<CliOverviewView active />); });
    expect(screen.getByText("Could not read the CLIs' state.")).toBeTruthy();
  });
});
