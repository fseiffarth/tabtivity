import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RootMcpSecurity } from "../../components/layout/RootMcpSecurity";
import { useCalendarStore } from "../../stores/calendar/calendar";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

const { invoke, listen, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  return {
    invoke: vi.fn(),
    listeners,
    listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler);
      return Promise.resolve(() => { listeners.delete(name); });
    }),
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen, emit: vi.fn() }));
const access = {
  calendars: { all: true, ids: [] }, projects: { all: true, ids: [] }, accounts: { all: true, ids: [] },
  families: ["calendar", "board", "projects", "mail"], write: true,
};
const session = { id: "session", tab: "root:agent-1", caller: "agent", access };
let status: { sessions: unknown[]; audit: unknown[] };
beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  status = { sessions: [{ ...session, tab: "Root <script>‮" }], audit: [] };
  useCalendarStore.setState({ loaded: true, calendars: [] });
  useTabsStore.setState({ tabsByScope: {} });
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "root_mcp_security_status"
    ? status
    : cmd === "mail_accounts_list" ? [] : undefined));
});
afterEach(cleanup);
/** A session card's heading: a title element plus the class, so the text is split. */
const heading = (text: string) => screen.findByText((_, el) => el?.tagName === "STRONG" && el.textContent === text);

it("saves read-only grants for the displayed session and revokes by session id after a confirm", async () => {
  render(<RootMcpSecurity />);
  await heading("Root <script> · Root agent");
  fireEvent.click(screen.getByRole("checkbox", { name: "Allow calendar, board and draft changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_session_access", {
    id: "session", access: { ...access, write: false },
  }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Revoke access" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  // Irreversible for the tab: a confirm names the tab and says so; Cancel revokes nothing.
  const dialog = await screen.findByRole("dialog");
  expect(dialog.textContent).toContain("reopening the tab");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(invoke).not.toHaveBeenCalledWith("root_mcp_session_revoke", expect.anything());
  fireEvent.click(screen.getByRole("button", { name: "Revoke access" }));
  await screen.findByRole("dialog");
  const revokes = screen.getAllByRole("button", { name: "Revoke access" });
  fireEvent.click(revokes[revokes.length - 1]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_session_revoke", { id: "session" }));
  expect(invoke.mock.calls.some(([command]) => command === "mail_open" || command === "mail_body")).toBe(false);
});

it("narrows a scope to chosen calendars through the scope editor", async () => {
  useCalendarStore.setState({ loaded: true, calendars: [
    { id: "work", name: "Work‮", color: "#000", visible: true, readonly: false },
    { id: "home", name: "Home", color: "#000", visible: true, readonly: false },
  ] as never });
  render(<RootMcpSecurity />);
  await heading("Root <script> · Root agent");
  // "All" is on: no per-calendar rows yet.
  expect(screen.queryByRole("checkbox", { name: "Work" })).toBeNull();
  const alls = screen.getAllByRole("checkbox", { name: "All, including future entries" });
  fireEvent.click(alls[0]);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Work" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("root_mcp_session_access", {
    id: "session", access: { ...access, calendars: { all: false, ids: ["work"] } },
  }));
});

it("shows the tab's title, the audit reason and target, and unauthenticated rows", async () => {
  status = {
    sessions: [session, { id: "sched", tab: "p1:sched-1", caller: "scheduler", access, project: "p1" }],
    audit: [
      { session: "session", caller: "agent", tool: "calendar_list", outcome: "allowed", elapsed_ms: 3, time: 0 },
      { session: "sched", caller: "scheduler", tool: "schedule_prompt", outcome: "refused", elapsed_ms: 1, time: 0, reason: "lead_time", target: "t‮1" },
      { session: "", caller: null, tool: "admission", outcome: "denied", elapsed_ms: 0, time: 0, reason: "unauthorized" },
      { session: "session", caller: "agent", tool: "protocol", outcome: "refused", elapsed_ms: 0, time: 0, reason: "batch" },
    ],
  };
  useTabsStore.setState({ tabsByScope: { root: [{ key: "agent-1", label: "Claude ‮root", cmd: "claude", cwd: "/", kind: "agent" } as TabEntry] } });
  render(<RootMcpSecurity />);
  expect((await screen.findByText("Claude root")).getAttribute("title")).toBe("root:agent-1");
  expect(screen.getByText("p1:sched-1")).toBeTruthy();
  const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
  expect(rows.some((r) => r.includes("lead_time") && r.includes("target t1"))).toBe(true);
  expect(rows.some((r) => r.includes("No session") && r.includes("Refused before authentication") && r.includes("unauthorized"))).toBe(true);
  expect(rows.some((r) => r.includes("Protocol request") && r.includes("batch"))).toBe(true);
  expect(rows.some((r) => r.includes("calendar_list") && r.endsWith("—"))).toBe(true);
  expect(document.querySelector("img")).toBeNull();
});

it("re-reads the sessions on the backend's session and review events", async () => {
  render(<RootMcpSecurity />);
  await heading("Root <script> · Root agent");
  await waitFor(() => expect(listeners.has("root-mcp-sessions-changed") && listeners.has("root-mcp-review-changed")).toBe(true));
  const before = invoke.mock.calls.filter(([c]) => c === "root_mcp_security_status").length;
  status = { sessions: [], audit: [] };
  await act(async () => { listeners.get("root-mcp-sessions-changed")!({ payload: null }); });
  await screen.findByText("No active MCP sessions.");
  expect(invoke.mock.calls.filter(([c]) => c === "root_mcp_security_status").length).toBeGreaterThan(before);
  await act(async () => { listeners.get("root-mcp-review-changed")!({ payload: 1 }); });
  expect(invoke.mock.calls.filter(([c]) => c === "root_mcp_security_status").length).toBeGreaterThan(before + 1);
});

it("shows backend refusals without interpreting markup", async () => {
  invoke.mockImplementation(() => Promise.reject(new Error("<img src=x>‮ denied")));
  render(<RootMcpSecurity />);
  expect((await screen.findByRole("alert")).textContent).toContain("<img src=x> denied");
  expect(document.querySelector("img")).toBeNull();
});

it("explains where headless tabs' sessions live only while Mobile is on", async () => {
  const { useSettingsStore } = await import("../../stores/settings");
  const { MOBILE_HOST_KEY } = await import("../../lib/brand");
  const before = useSettingsStore.getState().settings;
  try {
    useSettingsStore.setState({ settings: { ...(before ?? {}), [MOBILE_HOST_KEY]: { enabled: false } } as never });
    render(<RootMcpSecurity />);
    await heading("Root <script> · Root agent");
    expect(screen.queryByText(/started while no window was open/)).toBeNull();
    cleanup();
    useSettingsStore.setState({ settings: { ...(before ?? {}), [MOBILE_HOST_KEY]: { enabled: true } } as never });
    render(<RootMcpSecurity />);
    expect(await screen.findByText(/started while no window was open/)).toBeTruthy();
  } finally {
    useSettingsStore.setState({ settings: before });
  }
});
