/**
 * Calendar and to-do sharing (hosted plan §6.7, P4c): the panel opens a
 * calendar's parts per user, lists what is opened to the user, asks before
 * the move-on-first-share, and the watch reloads the calendar on a change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { ServerCalendarSharing, SharedCalendarWatch } from "../../components/server/ServerCalendarSharing";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { markServerClient, resetLinkStateForTests } from "../../lib/transport/linkState";

const listing = {
  me: "alice",
  list: [
    { id: "a".repeat(32), owner: "alice", name: "Lab", color: "#4aa3df", events: "owner", tasks: "owner", rev: 3, members: { bob: { events: "viewer", tasks: null } } },
    { id: "b".repeat(32), owner: "carol", name: "Team", color: "#000", events: null, tasks: "editor", rev: 1 },
  ],
};

const calendarData = {
  version: 3,
  calendars: [
    { id: "default", name: "Personal", color: "#4aa3df", visible: true, readonly: false },
    { id: "trips", name: "Trips", color: "#f00", visible: true, readonly: false },
  ],
  events: [],
  tasks: [],
};

describe("ServerCalendarSharing", () => {
  beforeEach(() => {
    markServerClient();
    useCalendarStore.setState({ loaded: false, calendars: [], events: [], tasks: [] });
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "shared_calendar_list") return Promise.resolve(listing);
      if (cmd === "calendar_load") return Promise.resolve(calendarData);
      return Promise.resolve(null);
    });
  });
  afterEach(() => {
    cleanup();
    resetLinkStateForTests();
    vi.mocked(invoke).mockReset();
  });

  it("lists members per part and what is opened to the user", async () => {
    render(<ServerCalendarSharing />);
    expect(await screen.findByText(/bob: events viewer, to-dos not shared/)).toBeTruthy();
    expect(screen.getByText(/Team · carol's · events not shared, to-dos editor/)).toBeTruthy();
    fireEvent.click(screen.getByText("Revoke bob"));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("shared_calendar_revoke", { id: "a".repeat(32), user: "bob" }));
  });

  it("asks before moving a calendar into the service", async () => {
    render(<ServerCalendarSharing />);
    await screen.findByText(/bob: events viewer/);
    await waitFor(() => expect(useCalendarStore.getState().loaded).toBe(true));
    // The default calendar is never offered.
    fireEvent.click(screen.getByRole("button", { name: "Choose a calendar" }));
    expect(screen.queryByRole("option", { name: "Personal" })).toBeNull();
    fireEvent.click(await screen.findByRole("option", { name: "Trips" }));
    fireEvent.click(screen.getAllByText("Share")[0]);
    expect(await screen.findByText(/move into the server's calendar service/)).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("shared_calendar_share", expect.anything());
    const shares = screen.getAllByText("Share");
    fireEvent.click(shares[shares.length - 1]);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("shared_calendar_share", { calendarId: "trips" }));
  });

  it("reloads the calendar when the daemon reports a change", async () => {
    let calls = 0;
    vi.mocked(invoke).mockImplementation((cmd: string) => {
      if (cmd === "shared_calendar_wait") {
        calls += 1;
        return calls === 1 ? Promise.resolve(true) : new Promise(() => {});
      }
      if (cmd === "calendar_load") return Promise.resolve(calendarData);
      return Promise.resolve(null);
    });
    useCalendarStore.setState({ loaded: true });
    render(<SharedCalendarWatch />);
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "calendar_load").length).toBe(1));
  });
});
