import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(), add: vi.fn(), close: vi.fn(), aiOff: false,
  rows: [] as { bin: string; label: string; installed: boolean }[],
  order: undefined as string[] | undefined,
  send: vi.fn(), busy: {} as Record<string, boolean>,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/tabs", () => ({ useTabsStore: { getState: () => ({ addTabToScope: mocks.add }) } }));
vi.mock("../../stores/settings", () => {
  const state = () => ({ settings: { agent_order: mocks.order, default_agent_cmd: "claude" } });
  return { useSettingsStore: Object.assign((select: (s: ReturnType<typeof state>) => unknown) => select(state()), { getState: state }) };
});
vi.mock("../../lib/aiSwitch", () => ({ aiIsOff: () => mocks.aiOff }));
vi.mock("../../components/common/UntestedTag", () => ({ UntestedTag: () => null }));
vi.mock("../../lib/shortcuts/steeringAgent", () => ({ sendSteeringPrompt: mocks.send }));
vi.mock("../../stores/activity", () => ({ useActivityStore: { getState: () => ({ busyByTab: mocks.busy, busyKindByTab: {} }) } }));
vi.mock("../../lib/agents/cliHandoff", async (original) => ({ ...(await original<typeof import("../../lib/agents/cliHandoff")>()), SUMMARY_POLL_MS: 5, SUMMARY_WAIT_MS: 200 }));
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

function lastPrepare() {
  const calls = prepareCalls();
  return calls[calls.length - 1];
}
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
  mocks.busy = {};
  mocks.send.mockResolvedValue(undefined);
  mocks.invoke.mockImplementation(async (command: string, args: { previewOnly?: boolean }) => {
    if (command === "list_agents") return mocks.rows;
    return { preview, file: args.previewOnly ? null : FILE };
  });
});
afterEach(cleanup);

const SAME = "Continue with Claude Code (new session)";

/** Pick `label` in the target dropdown. */
function pickTarget(label: string) {
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  fireEvent.click(screen.getByRole("option", { name: label }));
}

it("from the tab menu preselects a new session of the source's own CLI, then the other installed ones", async () => {
  await open();
  expect(screen.getByRole("button", { name: SAME })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(["Claude Code (new session)", "Codex", "OpenCode"]);
});

it("a new session of the same CLI is told it continues an earlier session of it", async () => {
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(lastPrepare()).toMatchObject({ target: "claude", previewOnly: false, summaryNonce: null });
  const added = mocks.add.mock.calls[0][1];
  expect(added.cmd).toBe("claude");
  expect(isResumableAgentTab(added)).toBe(true);
  expect(added.initialInput).toContain("an earlier Claude Code session");
  expect(added.initialInput).toContain(FILE);
});

it("from a limit notice preselects the next installed CLI and leaves the source's own out", async () => {
  await open({ line: "You've hit your usage limit" });
  expect(screen.getByRole("button", { name: "Continue with Codex" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  const options = screen.getAllByRole("option").map((option) => option.textContent);
  expect(options).toEqual(["Codex", "OpenCode"]);
});

it("from a limit notice follows the saved agent order for the default and lets the user pick another", async () => {
  mocks.order = ["claude", "opencode", "codex"];
  await open({ line: "limit" });
  expect(screen.getByRole("button", { name: "Continue with OpenCode" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Continue with" }));
  fireEvent.click(screen.getByRole("option", { name: "Codex" }));
  expect(screen.getByRole("button", { name: "Continue with Codex" })).toBeTruthy();
});

it("shows the counts of a preview-only prepare and re-reads them when the pick changes", async () => {
  await open({ line: "limit" });
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
  pickTarget("Codex");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
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
  await open({ line: "limit" });
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
  await open({ line: "limit" });
  expect(screen.getByRole("alert").textContent).toContain("cannot be handed off");
  expect((screen.getByRole("button", { name: "Continue with Codex" }) as HTMLButtonElement).disabled).toBe(true);
});

it("with no other CLI installed a limit notice says so; the tab menu still offers a new session", async () => {
  mocks.rows = [mocks.rows[0]];
  await open({ line: "limit" });
  expect(screen.getByText("No other CLI is installed.")).toBeTruthy();
  cleanup();
  await open();
  expect(screen.getByRole("button", { name: SAME })).toBeTruthy();
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
  expect((screen.getByRole("button", { name: SAME }) as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.add).not.toHaveBeenCalled();
});

// ── The summary prompt (warm cache only) ──

const ASK = "Ask Claude Code for a summary first";

/** Previews report a cache with `leftMs` to go; once `answered`, a preview naming a nonce reports the summary. */
function withCache(leftMs: number, answered: () => boolean = () => true) {
  mocks.invoke.mockImplementation(async (command: string, args: { previewOnly?: boolean; summaryNonce?: string | null }) => {
    if (command === "list_agents") return mocks.rows;
    const cache = { lastAtMs: Date.now() - 3_600_000 + leftMs, ttlSecs: 3600, contextTokens: 180_000 };
    return { preview: { ...preview, cache, summary: !!args.summaryNonce && answered() }, file: args.previewOnly ? null : FILE };
  });
}

it("with a warm cache Continue asks the source for a summary first, waits for it, then names it in the real prepare", async () => {
  withCache(40 * 60_000 + 30_000);
  await open();
  const box = screen.getByRole("checkbox", { name: new RegExp(ASK) }) as HTMLInputElement;
  expect(box.checked).toBe(true);
  expect(screen.getByText(/about 40 min/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  const [sentTab, text] = mocks.send.mock.calls[0];
  expect(sentTab).toMatchObject({ key: "a" });
  const nonce = /^\[handoff-summary ([0-9a-f]{16})\] /.exec(text)?.[1];
  expect(nonce).toBeTruthy();
  expect(text).toContain("no tools");
  const real = prepareCalls().filter((call) => call.previewOnly === false);
  expect(real).toHaveLength(1);
  expect(real[0]).toMatchObject({ target: "claude", summaryNonce: nonce });
  expect(mocks.add).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalled();
});

it("waits while the source's turn runs, even when a preview already reports the summary", async () => {
  withCache(40 * 60_000);
  mocks.busy = { "project:a": true };
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(mocks.add).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("Waiting for Claude Code's summary");
  mocks.busy = {};
  await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1), { timeout: 5_000 });
});

it("unticked, nothing reaches the source and the file is the chat text", async () => {
  withCache(40 * 60_000);
  await open();
  fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(ASK) }));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(mocks.send).not.toHaveBeenCalled();
  expect(lastPrepare()).toMatchObject({ previewOnly: false, summaryNonce: null });
  expect(mocks.add).toHaveBeenCalledTimes(1);
});

it.each([
  ["a cold cache", 0],
  ["a cache about to expire", 60_000],
])("with %s there is no summary offer, only the cold-cache line", async (_name, leftMs) => {
  withCache(leftMs);
  await open();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.getByText(/prompt cache has expired/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(mocks.send).not.toHaveBeenCalled();
});

it("a limit notice never offers the summary: the limited session cannot answer", async () => {
  withCache(40 * 60_000);
  await open({ line: "limit" });
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByText(/prompt cache has expired/)).toBeNull();
});

it("a summary prompt that cannot be sent says so and Continue then goes on from the chat text", async () => {
  withCache(40 * 60_000);
  mocks.send.mockRejectedValue(new Error("not an agent tab"));
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(screen.getByRole("alert").textContent).toContain("could not be sent");
  expect(mocks.add).not.toHaveBeenCalled();
  expect(screen.queryByRole("checkbox")).toBeNull();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(lastPrepare()).toMatchObject({ previewOnly: false, summaryNonce: null });
  expect(mocks.add).toHaveBeenCalledTimes(1);
});

it("no answer within the wait says so; Continue then names the sent prompt so its half-turn stays out", async () => {
  withCache(40 * 60_000, () => false);
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("No summary came back"), { timeout: 5_000 });
  expect(mocks.add).not.toHaveBeenCalled();
  const nonce = /([0-9a-f]{16})/.exec(mocks.send.mock.calls[0][1])?.[1];
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(lastPrepare()).toMatchObject({ previewOnly: false, summaryNonce: nonce });
  expect(mocks.add).toHaveBeenCalledTimes(1);
});

it("Continue without it stops the wait and opens the tab at once", async () => {
  withCache(40 * 60_000, () => false);
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Continue without it" })); });
  await waitFor(() => expect(mocks.add).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  expect(lastPrepare()).toMatchObject({ previewOnly: false, summaryNonce: expect.stringMatching(/^[0-9a-f]{16}$/) });
});

it("Cancel while waiting closes the dialog and opens nothing", async () => {
  withCache(40 * 60_000, () => false);
  await open();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: SAME })); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(mocks.close).toHaveBeenCalled();
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
  expect(mocks.add).not.toHaveBeenCalled();
});
