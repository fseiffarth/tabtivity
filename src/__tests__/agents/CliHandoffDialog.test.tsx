import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), add: vi.fn(), close: vi.fn(), aiOff: false,
  rows: [] as { bin: string; label: string; installed: boolean }[],
  order: undefined as string[] | undefined,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/tabs", () => ({ useTabsStore: { getState: () => ({ addTabToScope: mocks.add }) } }));
vi.mock("../../stores/settings", () => {
  const state = () => ({ settings: { agent_order: mocks.order, default_agent_cmd: "claude" } });
  return { useSettingsStore: Object.assign((select: (s: ReturnType<typeof state>) => unknown) => select(state()), { getState: state }) };
});
vi.mock("../../lib/aiSwitch", () => ({ aiIsOff: () => mocks.aiOff }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
import { isResumableAgentTab } from "../../stores/tabs/tabKinds";
import type { TabEntry } from "../../stores/tabs";
import { CliHandoffDialog } from "../../components/agents/CliHandoffDialog";

const ROWS = [
  { bin: "claude", label: "Claude Code", installed: true },
  { bin: "codex", label: "Codex", installed: true },
  { bin: "opencode", label: "OpenCode", installed: true },
  { bin: "gemini", label: "Gemini", installed: false },
];
const tab = { key: "a", id: "saved-a", cmd: "claude", kind: "agent", label: "Claude", sessionId: "session", cwd: "/workspace" } as TabEntry;
const preview = { entries: 14, total: 20, truncated: true, firstRequest: true, changedFiles: 2, notes: true };
const FILE = "~/handoff/cli-20261118-101500-beef/HANDOFF.md";

function prepareCalls() {
  return mocks.invoke.mock.calls.filter(([command]) => command === "agent_cli_handoff_prepare").map(([, args]) => args as Record<string, unknown>);
}
async function open(props: Partial<React.ComponentProps<typeof CliHandoffDialog>> = {}) {
  await act(async () => { render(<CliHandoffDialog scope="project" tab={tab} cwd="/workspace" onClose={mocks.close} {...props} />); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.aiOff = false;
  mocks.rows = ROWS;
  mocks.order = undefined;
  mocks.invoke.mockImplementation(async (command: string, args: { previewOnly?: boolean }) => {
    if (command === "list_agents") return mocks.rows;
    return { preview, file: args.previewOnly ? null : FILE };
  });
});
afterEach(cleanup);

it("preselects the next installed CLI by its label and leaves the source's own out", async () => {
  await open();
  expect(screen.getByRole("button", { name: "Continue with Codex" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(["Codex", "OpenCode"]);
});

it("follows the saved agent order for the default and lets the user pick another", async () => {
  mocks.order = ["claude", "opencode", "codex"];
  await open();
  expect(screen.getByRole("button", { name: "Continue with OpenCode" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  expect(screen.getByRole("button", { name: "Continue with Codex" })).toBeTruthy();
});

it("shows the counts of a preview-only prepare and re-reads them when the pick changes", async () => {
  await open();
  const calls = prepareCalls();
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ target: "codex", previewOnly: true, tabId: "saved-a", sessionId: "session", agent: expect.any(String) });
  expect(calls[0]).not.toHaveProperty("chat");
  const text = screen.getByTestId("cli-handoff-preview").textContent ?? "";
  expect(text).toContain("14 of 20");
  expect(text).toContain("Earlier turns are left out");
  expect(text).toContain("original request is included");
  expect(text).toContain("Changed files listed: 2");
  expect(text).toContain("notes are included");
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  fireEvent.click(screen.getByRole("option", { name: "OpenCode" }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(prepareCalls().map((call) => call.target)).toEqual(["codex", "opencode"]);
});

it("quotes the limit line only when it was opened from the notice", async () => {
  await open();
  expect(screen.queryByTestId("limit-line")).toBeNull();
  cleanup();
  await open({ line: "You've hit your usage limit" });
  expect(screen.getByTestId("limit-line").textContent).toContain("You've hit your usage limit");
});

it("Continue prepares the file for real, then opens a resumable tab told to read it, with no transcript text", async () => {
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  const calls = prepareCalls();
  expect(calls[calls.length - 1]).toMatchObject({ target: "codex", previewOnly: false });
  expect(mocks.add).toHaveBeenCalledWith("project", expect.objectContaining({ cmd: "codex", cwd: "/workspace", kind: "agent" }));
  const added = mocks.add.mock.calls[0][1];
  expect(isResumableAgentTab(added)).toBe(true);
  expect(added.initialInput).toContain(FILE);
  expect(added.initialInput).toContain("Claude Code");
  expect(added.initialInput).not.toMatch(/[\r\n]/);
  expect(added.initialInput.length).toBeLessThan(400);
  expect(mocks.close).toHaveBeenCalled();
});

it.each([
  ["unsupported", "cannot be handed off"],
  ["no_transcript", "could not be read yet"],
  ["no_session", "could not be read yet"],
  ["write failed: disk full", "Could not prepare the handoff"],
])("a %s error is explained and the dialog stays open", async (code, message) => {
  await open();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_agents") return mocks.rows;
    throw code;
  });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  expect(screen.getByRole("alert").textContent).toContain(message);
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.close).not.toHaveBeenCalled();
});

it("a failing preview names the reason up front and does not let Continue run into it", async () => {
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_agents") return mocks.rows;
    throw "unsupported";
  });
  await open();
  expect(screen.getByRole("alert").textContent).toContain("cannot be handed off");
  expect((screen.getByRole("button", { name: "Continue with Codex" }) as HTMLButtonElement).disabled).toBe(true);
});

it("with no other CLI installed it says so and cannot continue", async () => {
  mocks.rows = [mocks.rows[0]];
  await open();
  expect(screen.getByText("No other CLI is installed.")).toBeTruthy();
});

it("Cancel closes without touching the source", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.close).toHaveBeenCalled();
  expect(mocks.add).not.toHaveBeenCalled();
});

it("does nothing while the AI switch is off", async () => {
  mocks.aiOff = true;
  await open();
  expect((screen.getByRole("button", { name: "Continue with Codex" }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.add).not.toHaveBeenCalled();
});
