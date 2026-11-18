import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ local: true, open: vi.fn() }));
vi.mock("../../stores/agents/agentClearUndo", () => ({ runsLocally: () => mocks.local }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
import { useActivityStore } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import { CliHandoffMenuItem } from "../../components/agents/CliHandoffMenuItem";

const agent = { key: "a", cmd: "claude", kind: "agent", label: "Claude", sessionId: "s" } as TabEntry;
function show(tab: TabEntry = agent) {
  render(<CliHandoffMenuItem scope="project" tab={tab} onOpen={mocks.open} />);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.local = true;
  useActivityStore.setState({ busyByTab: {}, busyKindByTab: {} });
});
afterEach(cleanup);

it("is offered on an idle local agent tab and opens the dialog", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: /Continue with another CLI/ }));
  expect(mocks.open).toHaveBeenCalledTimes(1);
});

it("is disabled, with the reason, while the tab's turn is running, and frees up when it ends", () => {
  useActivityStore.setState({ busyByTab: { "project:a": true }, busyKindByTab: { "project:a": "agent" } });
  show();
  const button = screen.getByRole("button", { name: /Continue with another CLI/ }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(button.title).toContain("Wait for the turn to end");
  act(() => { useActivityStore.setState({ busyByTab: {}, busyKindByTab: {} }); });
  expect(button.disabled).toBe(false);
});

it("stays enabled while only a shell command the agent started is running", () => {
  useActivityStore.setState({ busyByTab: { "project:a": true }, busyKindByTab: { "project:a": "shell" } });
  show();
  expect((screen.getByRole("button", { name: /Continue with another CLI/ }) as HTMLButtonElement).disabled).toBe(false);
});

it.each([
  ["the assistant", { ...agent, assistant: true }, true],
  ["a shell tab", { ...agent, kind: "shell" }, true],
  ["a local-model tab", { ...agent, kind: "local_agent" }, true],
  ["a remote tab", agent, false],
])("is absent for %s", (_name, tab, local) => {
  mocks.local = local;
  show(tab as TabEntry);
  expect(screen.queryByRole("button")).toBeNull();
});
