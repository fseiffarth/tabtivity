/**
 * A failed (re)load is not "there is nothing": the calendar and CalDAV stores
 * keep what they showed and say why, and a slow answer to an older load never
 * overwrites a newer one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { useCalDavStore } from "../../stores/calendar/caldav";
import { useCalendarStore } from "../../stores/calendar/calendar";
import type { CalDavAccount } from "../../types/caldav";

const calendar = { id: "c1", name: "Work" };
const data = (name: string) => ({
  calendars: [{ ...calendar, name }],
  events: [],
  tasks: [],
  task_columns: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  invoke.mockReset();
  useCalendarStore.setState({ calendars: [], events: [], tasks: [], taskColumns: [], loaded: false, loadError: null });
  useCalDavStore.setState({ accounts: [], loaded: false, loadError: null });
});

describe("calendar store reload", () => {
  it("keeps the loaded data and records the error when a reload fails", async () => {
    invoke.mockResolvedValueOnce(data("Work"));
    await useCalendarStore.getState().reload();
    expect(useCalendarStore.getState().loadError).toBeNull();
    invoke.mockRejectedValueOnce(new Error("disk unreadable"));
    await useCalendarStore.getState().reload();
    const state = useCalendarStore.getState();
    expect(state.calendars).toHaveLength(1);
    expect(state.loaded).toBe(true);
    expect(state.loadError).toContain("disk unreadable");
  });

  it("stays unloaded after a failed first load, so the next load retries", async () => {
    invoke.mockRejectedValueOnce("boom");
    await useCalendarStore.getState().load();
    expect(useCalendarStore.getState().loaded).toBe(false);
    expect(useCalendarStore.getState().loadError).toBe("boom");
    invoke.mockResolvedValueOnce(data("Work"));
    await useCalendarStore.getState().load();
    expect(useCalendarStore.getState()).toMatchObject({ loaded: true, loadError: null });
  });

  it("ignores a stale answer that arrives after a newer one", async () => {
    const slow = deferred<unknown>();
    invoke.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(data("new"));
    const first = useCalendarStore.getState().reload();
    await useCalendarStore.getState().reload();
    slow.resolve(data("old"));
    await first;
    expect(useCalendarStore.getState().calendars[0].name).toBe("new");
  });

  it("ignores a stale failure that arrives after a newer success", async () => {
    const slow = deferred<unknown>();
    invoke.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(data("new"));
    const first = useCalendarStore.getState().reload();
    await useCalendarStore.getState().reload();
    slow.resolve(Promise.reject(new Error("late")));
    await first;
    expect(useCalendarStore.getState().loadError).toBeNull();
  });
});

describe("CalDAV store reload", () => {
  const account = { id: "a1", calendars: [] } as unknown as CalDavAccount;

  it("keeps the accounts and records the error when a reload fails", async () => {
    invoke.mockResolvedValueOnce([account]);
    await useCalDavStore.getState().reload();
    invoke.mockRejectedValueOnce(new Error("keychain locked"));
    await useCalDavStore.getState().reload();
    const state = useCalDavStore.getState();
    expect(state.accounts).toEqual([account]);
    expect(state.loadError).toContain("keychain locked");
  });

  it("ignores a stale answer that arrives after a newer one", async () => {
    const slow = deferred<unknown>();
    invoke.mockReturnValueOnce(slow.promise).mockResolvedValueOnce([account]);
    const first = useCalDavStore.getState().reload();
    await useCalDavStore.getState().reload();
    slow.resolve([]);
    await first;
    expect(useCalDavStore.getState().accounts).toEqual([account]);
  });
});
