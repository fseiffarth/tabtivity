/**
 * A prompt sent from the chat into a Claude no turn has begun in yet: its
 * Enter can be taken as a newline or dropped while the CLI still starts, so
 * Enter goes again until a hook turn shows the prompt went (`freshSubmit.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: vi.fn(() => Promise.resolve()),
}));

import { writePtyInput } from "../../lib/terminal/terminalInput";
import { FRESH_SUBMIT_CHECK_MS, FRESH_SUBMIT_TRIES } from "../../lib/agents/freshSubmit";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { sendSteeringPrompt } from "../../lib/shortcuts/steeringAgent";
import type { TabEntry } from "../../stores/tabs";

const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);
const enters = () => writeMock.mock.calls.filter(([, bytes]) => decode(bytes) === "\r").length;
const tab = { key: "t1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "target" } as TabEntry;

function register(agent: string) {
  registerScheduledAgentInput("target", {
    ptyId: "p:t1",
    ready: () => true,
    bracketedPaste: () => false,
    agent,
    recordAuthorizedInput: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  _clearScheduledAgentInputsForTest();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a chat prompt into a fresh Claude", () => {
  it("presses Enter again while no turn has begun", async () => {
    register("claude");
    const sent = sendSteeringPrompt(tab, "fix the bug");
    await vi.advanceTimersByTimeAsync(100);
    await sent;
    expect(enters()).toBe(1);
    await vi.advanceTimersByTimeAsync(FRESH_SUBMIT_CHECK_MS * FRESH_SUBMIT_TRIES + 100);
    expect(enters()).toBe(1 + FRESH_SUBMIT_TRIES);
  });

  it("leaves a slash command and another CLI's prompt at one Enter", async () => {
    register("claude");
    const command = sendSteeringPrompt(tab, "/model");
    await vi.advanceTimersByTimeAsync(100);
    await command;
    register("codex");
    const other = sendSteeringPrompt({ ...tab, label: "Codex", cmd: "codex" }, "fix the bug");
    await vi.advanceTimersByTimeAsync(100);
    await other;
    await vi.advanceTimersByTimeAsync(FRESH_SUBMIT_CHECK_MS * FRESH_SUBMIT_TRIES + 100);
    expect(enters()).toBe(2);
  });
});
