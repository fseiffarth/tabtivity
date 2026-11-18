import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
import { useActivityStore } from "../../stores/activity";
import { useProjectsStore } from "../../stores/projects";
import type { TabEntry } from "../../stores/tabs";
import type { ProjectEntry } from "../../types";
import { CliHandoffMenuItem } from "../../components/agents/CliHandoffMenuItem";

/** The scope's project, remote or not (only the fields the gate reads). */
function project(remote: boolean) {
  const entry = { id: "project", name: "p", path: "/p", ...(remote ? { remote: { host: "h" } } : {}) };
  useProjectsStore.setState({ projects: [entry as unknown as ProjectEntry] });
}

const agent = { key: "a", cmd: "claude", kind: "agent", label: "Claude", sessionId: "s" } as TabEntry;
function show(tab: TabEntry = agent) {
  render(<CliHandoffMenuItem scope="project" tab={tab} onOpen={mocks.open} />);
}
beforeEach(() => {
  vi.clearAllMocks();
  project(false);
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
  ["the assistant", { ...agent, assistant: true }, false],
  ["a shell tab", { ...agent, kind: "shell" }, false],
  ["a local-model tab", { ...agent, kind: "local_agent" }, false],
  ["the root console's Host session", { ...agent, hostSession: true }, false],
  // The backend refuses every remote project, a tab running here included.
  ["a remote project's tab running here", { ...agent, location: "local" }, true],
  ["a remote project's host tab", agent, true],
])("is absent for %s", (_name, tab, remote) => {
  project(remote);
  show(tab as TabEntry);
  expect(screen.queryByRole("button")).toBeNull();
});
