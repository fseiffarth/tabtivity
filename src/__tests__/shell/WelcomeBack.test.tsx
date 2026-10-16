/**
 * The startup recap's welcome-back line: StatsRecapHost opens the recap on the
 * last day with tracked time (not on a fresh install), and the recap greets
 * with that day's project and the recent alternatives as Continue / Switch.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { StatsRecapHost } from "../../components/stats/StatsRecapHost";
import { dayKey } from "../../lib/usageRollup";
import { lastActiveDay, pickWelcomeBack, type TimeByDay } from "../../lib/welcomeBack";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { APP_TIMER_ID } from "../../stores/timer";
import type { ProjectEntry, Settings } from "../../types";

const DAY_MS = 86_400_000;
const daysAgo = (n: number) => dayKey(Date.now() - n * DAY_MS);

const project = (id: string, name: string, position: number) =>
  ({ id, name, status: "active", position, local_file: "" }) as ProjectEntry;

describe("welcomeBack picks", () => {
  const ids = new Set(["a", "b", "c", "d"]);

  it("the last active day skips today, the app timer and empty days", () => {
    const log: TimeByDay = {
      [daysAgo(0)]: { a: 100 },
      [daysAgo(1)]: { [APP_TIMER_ID]: 500 },
      [daysAgo(2)]: { a: 0 },
      [daysAgo(3)]: { b: 60 },
      [daysAgo(9)]: { c: 60 },
    };
    expect(lastActiveDay(log, daysAgo(0), APP_TIMER_ID)).toBe(daysAgo(3));
    expect(lastActiveDay({ [daysAgo(0)]: { a: 1 } }, daysAgo(0), APP_TIMER_ID)).toBeNull();
    expect(lastActiveDay({}, daysAgo(0), APP_TIMER_ID)).toBeNull();
  });

  it("picks the day's top project and up to two recent others, live projects only", () => {
    const log: TimeByDay = {
      [daysAgo(1)]: { a: 300, b: 900, root: 5000, gone: 9000 },
      [daysAgo(3)]: { c: 2000, a: 100 },
      [daysAgo(5)]: { d: 50 },
      [daysAgo(30)]: { d: 99999 },
    };
    expect(pickWelcomeBack(log, daysAgo(1), ids)).toEqual({
      day: daysAgo(1),
      projectId: "b",
      alternatives: ["c", "a"],
    });
    // Only pseudo-scopes / deleted projects that day: nothing to name.
    expect(pickWelcomeBack({ [daysAgo(1)]: { root: 10 } }, daysAgo(1), ids)).toBeNull();
  });
});

describe("StatsRecapHost welcome-back", () => {
  let log: TimeByDay;
  const setActive = vi.fn(async () => {});
  const updateSettings = vi.fn(async () => {});

  beforeEach(() => {
    cleanup();
    log = {};
    setActive.mockClear();
    updateSettings.mockClear();
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_time_activity_all") return log;
      if (cmd === "get_net_usage") return { hours: {}, days: {} };
      if (cmd === "usage_summary") return { hours: {}, days: {} };
      throw new Error(`unmocked ${cmd}`);
    });
    useProjectsStore.setState({
      projects: [project("a", "Alpha", 0), project("b", "Beta", 1), project("c", "Gamma", 2)],
      activeId: "a",
      loaded: true,
      setActive,
    });
    useSettingsStore.setState({ settings: {} as Settings, loaded: true, updateSettings });
  });
  afterEach(() => cleanup());

  it("does not open without earlier tracked time (fresh install)", async () => {
    log = { [daysAgo(0)]: { a: 30 } };
    await act(async () => {
      render(<StatsRecapHost />);
    });
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_time_activity_all"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("greets with yesterday's project; Switch makes another current and closes", async () => {
    log = { [daysAgo(1)]: { b: 900, a: 100 }, [daysAgo(2)]: { c: 400 } };
    await act(async () => {
      render(<StatsRecapHost />);
    });
    const cont = await screen.findByRole("button", { name: "Continue with Beta" });
    expect(screen.getByRole("button", { name: "Switch to Gamma" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Switch to Alpha" })).toBeTruthy();
    expect(document.querySelector(".typewriter-sr")?.textContent).toBe(
      "Hi there — yesterday you worked on Beta. Continue, or switch to Gamma or Alpha?",
    );
    expect(updateSettings).toHaveBeenCalledWith({ daily_stats_last_shown: daysAgo(0) });
    expect(cont).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Switch to Gamma" }));
    expect(setActive).toHaveBeenCalledWith("c");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Continue on the already-current project just closes", async () => {
    log = { [daysAgo(4)]: { a: 900 } };
    await act(async () => {
      render(<StatsRecapHost />);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Continue with Alpha" }));
    expect(setActive).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
