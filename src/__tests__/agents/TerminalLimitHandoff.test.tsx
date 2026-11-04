import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), add: vi.fn(), save: vi.fn(), automatic: false,
  tab: { key: "a", cmd: "claude", kind: "agent", label: "Claude", sessionId: "session", cwd: "/workspace" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/tabs", () => ({ useTabsStore: { getState: () => ({ addTabToScope: mocks.add }) } }));
vi.mock("../../stores/settings", () => ({ useSettingsStore: { getState: () => ({ settings: { agent_limit_auto_handoff: mocks.automatic }, updateSettings: mocks.save }) } }));
vi.mock("../../components/tabs/paneTabContext", () => ({ usePaneTab: () => mocks.tab }));
vi.mock("../../lib/terminal/ptyId", () => ({ splitPtyId: () => ({ scope: "project", key: "a" }) }));
vi.mock("../../lib/terminal/terminalRegistry", () => ({ terminalFor: () => ({ buffer: { active: {} } }) }));
vi.mock("../../../mobile-web/src/terminal/readableScreen", () => ({ readableScreen: () => ({ lines: ["You've hit your 5-hour limit · resets 10:20pm"] }) }));
vi.mock("../../stores/agents/agentClearUndo", () => ({ runsLocally: () => true }));
vi.mock("../../lib/agents/agentReader", () => ({ readerRequest: () => ({ sessionId: "session" }) }));
vi.mock("../../lib/aiSwitch", () => ({ aiIsOff: () => false }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
import { TerminalLimitHandoff } from "../../components/terminal/TerminalLimitHandoff";
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.automatic = false;
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
it("asks first, keeps the source, and persists Never ask again only on approval", async () => {
  await show();
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(mocks.add).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox"));
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  expect(mocks.save).toHaveBeenCalledWith({ agent_limit_auto_handoff: true });
  expect(mocks.add).toHaveBeenCalledWith("project", expect.objectContaining({ cmd: "codex", cwd: "/workspace", kind: "agent" }));
  const input = mocks.add.mock.calls[0][1].initialInput as string;
  expect(input).toContain("Finish task");
  expect(input).not.toMatch(/[\r\n]/);
});
it("cancelling with the checkbox checked neither switches nor saves", async () => {
  await show();
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.add).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
it("automatically hands off only when the saved preference is enabled", async () => {
  mocks.automatic = true;
  await show();
  expect(mocks.add).toHaveBeenCalledTimes(1);
  expect(mocks.save).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("retains the session and offers retry when reading context fails", async () => {
  await show();
  mocks.invoke.mockRejectedValue(new Error("read failed"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue with Codex" })); });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(mocks.add).not.toHaveBeenCalled();
});
