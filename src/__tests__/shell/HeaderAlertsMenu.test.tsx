/**
 * The Alerts list hangs off the header bell's hover (it used to be a group in
 * the side panel). Hover reads the rows out; the click keeps its one job, the
 * machine-wide `files_alerts` switch; switched off, the bell hangs no list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { AlertItem } from "../../lib/alerts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

const feed = vi.hoisted(() => ({
  value: {
    enabled: true,
    items: [] as unknown[],
    loading: false,
    error: null,
    refresh: () => {},
    mutedItems: [] as unknown[],
    mute: () => {},
    unmute: () => {},
    unmuteAll: () => {},
  },
}));
vi.mock("../../components/files/useAlertsFeed", () => ({ useAlertsFeed: () => feed.value }));

import { AlertsToggle } from "../../components/header/AlertsToggle";
import { useHeaderHoverMenuStore } from "../../stores/headerHoverMenu";
import { useSettingsStore } from "../../stores/settings";

const updateSettings = vi.fn(() => Promise.resolve());

const CARD: AlertItem = {
  id: "task:1",
  kind: "task",
  severity: "overdue",
  title: "Hand in the report",
  detail: "",
  at: "2026-10-20T09:00",
  allDay: false,
  minutesAway: -300,
  daysAway: -2,
  source: { taskId: "1" },
};

function setFiles(filesAlerts: boolean) {
  useSettingsStore.setState({
    settings: { files_alerts: filesAlerts } as never,
    updateSettings,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useHeaderHoverMenuStore.setState({ openId: null });
  feed.value = { ...feed.value, enabled: true, items: [CARD], mutedItems: [] };
  setFiles(true);
});
afterEach(cleanup);

describe("header Alerts bell", () => {
  it("reads the alert rows out on hover", () => {
    render(<AlertsToggle />);
    expect(screen.queryByText("Hand in the report")).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("button").parentElement!);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByText("Hand in the report")).toBeTruthy();
  });

  it("says so when nothing needs the user", () => {
    feed.value = { ...feed.value, items: [] };
    render(<AlertsToggle />);
    fireEvent.mouseEnter(screen.getByRole("button").parentElement!);
    expect(screen.getByText("Nothing needs you right now.")).toBeTruthy();
  });

  it("hangs no list while the alerts are switched off", () => {
    setFiles(false);
    render(<AlertsToggle />);
    fireEvent.mouseEnter(screen.getByRole("button").parentElement!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the click as the machine-wide switch", () => {
    render(<AlertsToggle />);
    fireEvent.click(screen.getByRole("button"));
    expect(updateSettings).toHaveBeenCalledWith({ files_alerts: false });
  });
});
