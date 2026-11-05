import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), add: vi.fn(), save: vi.fn(), automatic: false, screen: "You've hit your 5-hour limit · resets 10:20pm",
  tab: { key: "a", cmd: "claude", kind: "agent", label: "Claude", sessionId: "session", cwd: "/workspace" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/tabs", () => ({ useTabsStore: { getState: () => ({ addTabToScope: mocks.add }) } }));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({ settings: { agent_limit_auto_handoff: mocks.automatic }, updateSettings: mocks.save }) } }));
vi.mock("../../components/tabs/paneTabContext", () => ({ usePaneTab: () => mocks.tab }));
vi.mock("../../lib/terminal/ptyId", () => ({ splitPtyId: () => ({ scope: "project", key: "a" }) }));
vi.mock("../../lib/terminal/terminalRegistry", () => ({ terminalFor: () => ({ buffer: { active: {} } }) }));
vi.mock("../../../mobile-web/src/terminal/readableScreen", () => ({ readableScreen: () => ({ lines: [mocks.screen] }) }));
vi.mock("../../stores/agents/agentClearUndo", () => ({ runsLocally: () => true }));
vi.mock("../../lib/agents/agentReader", () => ({ readerRequest: () => ({ sessionId: "session" }) }));
vi.mock("../../lib/aiSwitch", () => ({ aiIsOff: () => false }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
import { TerminalLimitHandoff } from "../../components/terminal/TerminalLimitHandoff";
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.automatic = false;
  mocks.screen = "You've hit your 5-hour limit · resets 10:20pm";
  mocks.save.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "list_agents") return [{ bin: "claude", label: "Claude", installed: true }, { bin: "codex", label: "Codex", installed: true }];
    return { available: true, entries: [{ kind: "prompt", text: "Finish task\nwithout repeating it" }, { kind: "answer", text: "Progress so far" }] };
  });
});
afterEach(cleanup);
async function show() {
  await act(async () => { render(<TerminalLimitHandoff ptyId={`pane-${++sequence}`} visible cwd="/workspace" />); });
}
it("asks first, quotes the screen line that matched, and keeps the source", async () => {
  await show();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(mocks.add).not.toHaveBeenCalled();
  expect(screen.getByTestId("limit-line").textContent).toContain("You've hit your 5-hour limit · resets 10:20pm");
  expect(screen.queryByRole("checkbox")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.add).toHaveBeenCalledWith("project", expect.objectContaining({ cmd: "codex", cwd: "/workspace", kind: "agent" }));
  const input = mocks.add.mock.calls[0][1].initialInput as string;
  expect(input).toContain("Finish task");
  expect(input).not.toMatch(/[\r\n]/);
});
it("cancelling neither switches nor saves", async () => {
  await show();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("never switches by itself, even with the old remembered setting still in settings (gap 77)", async () => {
  mocks.automatic = true;
  await show();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(mocks.add).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});
it("quotes only a cleaned, cut line: no escapes, bidi marks or more than 160 characters", async () => {
  mocks.screen = `\u001b[31mYou've hit your usage limit\u202E.${"x".repeat(400)}\u0007`;
  await show();
  const quoted = screen.getByTestId("limit-line").textContent ?? "";
  expect(quoted).toContain("You've hit your usage limit.");
  expect(quoted).not.toMatch(/[\u001b\u0007\u202E]/);
  expect(quoted.length).toBeLessThan(160 + "Screen line that matched: ".length + 1);
});
it("retains the session and offers retry when reading context fails", async () => {
  await show();
  mocks.invoke.mockRejectedValue(new Error("read failed"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(mocks.add).not.toHaveBeenCalled();
});
