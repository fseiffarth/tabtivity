/**
 * Steering's prompt box carries the Chat view composer's suggestions: text
 * starting with `/` opens the `/` menu under it, and the empty box shows
 * Claude Code's own next-prompt suggestion, read off the pane's screen, which
 * Tab or → takes in. Neither sends anything on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { Terminal } from "@xterm/xterm";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: vi.fn().mockResolvedValue(false),
    setFullscreen: vi.fn(),
  }),
}));
vi.mock("../../lib/terminal/terminalInput", () => ({
  writePtyInput: vi.fn(() => Promise.resolve()),
}));
const live = vi.hoisted(() => ({ suggestion: "" }));
vi.mock("../../lib/agents/readerLive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/agents/readerLive")>();
  return {
    ...actual,
    readReaderLive: (...args: Parameters<typeof actual.readReaderLive>) => ({ ...actual.readReaderLive(...args), suggestion: live.suggestion }),
  };
});

import { invoke } from "@tauri-apps/api/core";
import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringPromptOverlay } from "../../components/layout/SteeringPromptOverlay";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { _clearScheduledAgentInputsForTest, registerScheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { registerTerminal, unregisterTerminal } from "../../lib/terminal/terminalRegistry";
import { readSlashCommands } from "../../../mobile-web/src/slashCommands";
import { useActivityStore } from "../../stores/activity";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const steering = () => useKeyboardSteeringStore.getState();
const box = () => document.querySelector<HTMLTextAreaElement>(".steering-prompt-input");
const menu = () => document.querySelector(".steering-prompt-dialog .terminal-reader-slash");
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function openBox(entry = { key: "t1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", scheduleTargetId: "target" } as TabEntry) {
  useTabsStore.setState({ scope: "p", tabs: [entry], activeKey: entry.key });
  registerScheduledAgentInput("target", {
    ptyId: "p:t1",
    ready: () => true,
    bracketedPaste: () => false,
    recordAuthorizedInput: vi.fn(),
  });
  render(
    <>
      <Harness />
      <SteeringPromptOverlay />
    </>,
  );
  act(() => steering().enter());
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  });
  return box()!;
}

/** A pane screen in this window whose redraws the test sets off. */
function fakePane() {
  const redraw = { fire: () => {} };
  const term = {
    buffer: { active: { length: 0, getLine: () => undefined } },
    onWriteParsed: (listener: () => void) => {
      redraw.fire = listener;
      return { dispose: () => { redraw.fire = () => {}; } };
    },
  } as unknown as Terminal;
  registerTerminal("p:t1", term);
  return { term, redraw };
}

beforeEach(() => {
  _clearScheduledAgentInputsForTest();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  useSettingsStore.setState({ settings: null });
  steering().exit();
  live.suggestion = "";
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe("steering prompt box suggestions", () => {
  it("offers the / menu: arrows pick a row, Enter fills the box without sending, Esc closes only the menu", () => {
    const input = openBox();
    expect(menu()).toBeNull();
    fireEvent.change(input, { target: { value: "/cle" } });
    expect(menu()?.textContent).toContain("/clear");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(menu()?.querySelector(".terminal-reader-slash-row.active")?.textContent).toContain("/clear");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(box()?.value).toBe("/clear");
    expect(writeMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "/" } });
    expect(menu()).not.toBeNull();
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(menu()).toBeNull();
    expect(box()).not.toBeNull();
    // With no menu up, Escape closes the box.
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(box()).toBeNull();
  });

  it("Tab fills a command that takes words with a space after it, and a sent one is offered again first", async () => {
    const input = openBox();
    fireEvent.change(input, { target: { value: "/compa" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(box()?.value).toBe("/compact ");
    fireEvent.change(input, { target: { value: "/compact keep the plan" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.waitFor(() => expect(box()).toBeNull());
    expect(writeMock.mock.calls.map(([, bytes]) => decode(bytes))).toContain("/compact keep the plan");
    expect(readSlashCommands("claude")).toEqual(["/compact keep the plan"]);
  });

  it("shows Claude's suggestion in the empty box, Tab or → takes it in, and a redraw reads it again", async () => {
    const { term, redraw } = fakePane();
    live.suggestion = "run the tests";
    try {
      const input = openBox();
      expect(input.placeholder).toContain("run the tests");
      expect(document.querySelector(".suggestion-source-chip .suggestion-source-name")?.textContent).toBe("Claude");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(box()?.value).toBe("run the tests");
      expect(writeMock).not.toHaveBeenCalled();

      // Typed text hides it; → in a box with text is the caret's own.
      fireEvent.change(input, { target: { value: "" } });
      live.suggestion = "commit this";
      act(() => redraw.fire());
      await vi.waitFor(() => expect(box()?.placeholder).toContain("commit this"));
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(box()?.value).toBe("commit this");
    } finally {
      unregisterTerminal("p:t1", term);
    }
  });

  it("shows the local model's suggestion where the CLI draws none, Tab takes it, nothing is sent", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(((command: string) => Promise.resolve(command === "agent_next_prompt"
      ? { text: "run the tests", turnKey: "e1", status: "ok" }
      : undefined)) as never);
    // A fresh tab: earlier cases left a draft (and a send) on `t1`.
    useActivityStore.setState({ busyByTab: {} });
    try {
      const input = openBox({ key: "t9", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "target", sessionId: "s-1" } as TabEntry);
      await vi.waitFor(() => expect(box()?.placeholder).toContain("run the tests"));
      expect(input.getAttribute("aria-label")).toContain("Local model suggests");
      // No model named (an older backend): the chip says "Local model".
      expect(document.querySelector(".suggestion-source-chip .suggestion-source-name")?.textContent).toBe("Local model");
      expect(invokeMock).toHaveBeenCalledWith("agent_next_prompt", expect.objectContaining({ agent: "codex", sessionId: "s-1", phase: "final" }));
      fireEvent.keyDown(input, { key: "Tab" });
      expect(box()?.value).toBe("run the tests");
      expect(writeMock).not.toHaveBeenCalled();
      expect(invokeMock.mock.calls.filter(([command]) => command === "agent_next_prompt")).toHaveLength(1);
    } finally {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(undefined);
    }
  });

  it("draws how a typed prompt goes on after it; Tab takes it in, nothing is sent", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(((command: string, args?: { phase?: string }) => Promise.resolve(command !== "agent_next_prompt" ? undefined
      : args?.phase === "complete" ? { text: " and commit it", status: "ok", model: "qwen3:4b" }
      : { text: null, status: "ok" })) as never);
    useActivityStore.setState({ busyByTab: {} });
    try {
      const input = openBox({ key: "t10", label: "Codex", cmd: "codex", cwd: "/p", kind: "agent", scheduleTargetId: "target", sessionId: "s-2" } as TabEntry);
      fireEvent.change(input, { target: { value: "fix the lint" } });
      await vi.waitFor(() => expect(document.querySelector(".steering-prompt-dialog .prompt-ghost-rest")?.textContent).toBe(" and commit it"));
      expect(invokeMock).toHaveBeenCalledWith("agent_next_prompt", expect.objectContaining({ agent: "codex", sessionId: "s-2", phase: "complete", draft: "fix the lint" }));
      expect(document.querySelector(".steering-prompt-head .suggestion-source-name")?.textContent).toBe("qwen3:4b");
      fireEvent.keyDown(input, { key: "Tab" });
      expect(box()?.value).toBe("fix the lint and commit it");
      expect(writeMock).not.toHaveBeenCalled();
      // A `/` command is the menu's, never completed.
      fireEvent.change(input, { target: { value: "/model opus now" } });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(invokeMock.mock.calls.filter(([command, args]) => command === "agent_next_prompt" && (args as { phase?: string }).phase === "complete" && (args as { draft?: string }).draft?.startsWith("/"))).toHaveLength(0);
    } finally {
      invokeMock.mockReset();
      invokeMock.mockResolvedValue(undefined);
    }
  });
});
