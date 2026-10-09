/**
 * Steering's prompt box: I on the tab level opens a text box for the active
 * agent tab; Enter submits it into the agent and steering comes back on the
 * level it was pressed on, Escape comes back without sending.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

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

import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringPromptOverlay } from "../../components/layout/SteeringPromptOverlay";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

function press(key: string) {
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

const steering = () => useKeyboardSteeringStore.getState();
const box = () => document.querySelector<HTMLTextAreaElement>(".steering-prompt-input");
const writeMock = vi.mocked(writePtyInput);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

function activeTab(tab: Partial<TabEntry>) {
  const entry = { key: "t1", label: "Claude", cmd: "claude", cwd: "/p", ...tab } as TabEntry;
  useTabsStore.setState({ scope: "p", tabs: [entry], activeKey: entry.key });
}

beforeEach(() => {
  _clearScheduledAgentInputsForTest();
  writeMock.mockReset();
  writeMock.mockResolvedValue(undefined);
  useSettingsStore.setState({ settings: null });
  steering().exit();
});

afterEach(() => {
  cleanup();
});

describe("steering prompt box", () => {
  it("sends the text to the active agent and comes back on the level it left", async () => {
    activeTab({ kind: "agent", scheduleTargetId: "target" });
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
    act(() => {
      steering().enter();
      steering().setLevel("panes");
    });
    press("i");
    expect(steering().active).toBe(false);
    const input = box()!;
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "run the tests" } });
    // Shift+Enter is a new line, not a send.
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(writeMock).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    // The writes go in a few milliseconds apart; the box closes after the last.
    await vi.waitFor(() => expect(box()).toBeNull());

    expect(writeMock.mock.calls.map(([id, bytes]) => [id, decode(bytes)])).toEqual([
      ["p:t1", "\u0001\u000b"],
      ["p:t1", "run the tests"],
      ["p:t1", "\r"],
    ]);
    expect(steering()).toMatchObject({ active: true, level: "panes" });
  });

  it("keeps the box and the text when the agent cannot take it", async () => {
    activeTab({ kind: "agent", scheduleTargetId: "target" });
    render(
      <>
        <Harness />
        <SteeringPromptOverlay />
      </>,
    );
    act(() => steering().enter());
    press("i");
    fireEvent.change(box()!, { target: { value: "hello" } });
    await act(async () => {
      fireEvent.keyDown(box()!, { key: "Enter" });
    });
    expect(box()?.value).toBe("hello");
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(steering().active).toBe(false);
  });

  it("sends while the agent works, as a prompt typed then would", async () => {
    activeTab({ kind: "agent", scheduleTargetId: "target" });
    registerScheduledAgentInput("target", {
      ptyId: "p:t1",
      ready: () => false,
      started: () => true,
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
    press("i");
    fireEvent.change(box()!, { target: { value: "and then this" } });
    fireEvent.keyDown(box()!, { key: "Enter" });
    await vi.waitFor(() => expect(box()).toBeNull());
    expect(writeMock.mock.calls.map(([, bytes]) => decode(bytes))).toContain("and then this");
  });

  it("keeps an unsent prompt for that tab's next open, and not after a send", async () => {
    activeTab({ kind: "agent", scheduleTargetId: "keep" });
    registerScheduledAgentInput("keep", {
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
    press("i");
    fireEvent.change(box()!, { target: { value: "half a thought" } });
    act(() => {
      box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(box()).toBeNull();
    press("i");
    expect(box()?.value).toBe("half a thought");
    fireEvent.keyDown(box()!, { key: "Enter" });
    await vi.waitFor(() => expect(box()).toBeNull());
    press("i");
    expect(box()?.value).toBe("");
  });

  it("Escape returns to steering without sending", () => {
    activeTab({ kind: "agent", scheduleTargetId: "target" });
    render(
      <>
        <Harness />
        <SteeringPromptOverlay />
      </>,
    );
    act(() => steering().enter());
    press("i");
    fireEvent.change(box()!, { target: { value: "never mind" } });
    act(() => {
      box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(box()).toBeNull();
    expect(writeMock).not.toHaveBeenCalled();
    expect(steering()).toMatchObject({ active: true, level: "tabs" });
  });

  it("does nothing on a tab that is not an agent", () => {
    activeTab({ kind: "shell" });
    render(
      <>
        <Harness />
        <SteeringPromptOverlay />
      </>,
    );
    act(() => steering().enter());
    press("i");
    expect(box()).toBeNull();
    expect(steering().active).toBe(true);
  });

  describe("chips", () => {
    function openBox(target = "chips") {
      activeTab({ kind: "agent", scheduleTargetId: target });
      registerScheduledAgentInput(target, {
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
      press("i");
      return box()!;
    }
    const alt = (input: HTMLTextAreaElement, key: string) =>
      fireEvent.keyDown(input, { key, code: `Key${key.toUpperCase()}`, altKey: true });
    const written = () => writeMock.mock.calls.map(([, bytes]) => decode(bytes));

    it("Alt+L / Alt+G lead the text with /plan or /goal and take it off again", () => {
      const input = openBox();
      fireEvent.change(input, { target: { value: "tidy the tests" } });
      alt(input, "l");
      expect(box()!.value).toBe("/plan tidy the tests");
      alt(input, "g");
      expect(box()!.value).toBe("/goal tidy the tests");
      alt(input, "g");
      expect(box()!.value).toBe("tidy the tests");
      expect(writeMock).not.toHaveBeenCalled();
    });

    it("Alt+K clears only on the second press", async () => {
      const input = openBox();
      alt(input, "k");
      expect(writeMock).not.toHaveBeenCalled();
      expect(document.querySelector(".steering-prompt-chip.on")).not.toBeNull();
      alt(input, "k");
      await vi.waitFor(() => expect(written()).toContain("/clear"));
      expect(box()).not.toBeNull();
    });

    it("another key between the two Alt+K presses disarms Clear", () => {
      const input = openBox();
      alt(input, "k");
      fireEvent.keyDown(input, { key: "a" });
      alt(input, "k");
      expect(writeMock).not.toHaveBeenCalled();
    });

    it("Alt+E lists Claude's efforts: ↓ and Enter send one, Escape closes the list first", async () => {
      const input = openBox();
      alt(input, "e");
      expect(document.querySelector(".steering-prompt-list")).not.toBeNull();
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      await vi.waitFor(() => expect(written()).toContain("/effort medium"));
      await vi.waitFor(() => expect(document.querySelector(".steering-prompt-list")).toBeNull());

      alt(input, "e");
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(document.querySelector(".steering-prompt-list")).toBeNull();
      expect(box()).not.toBeNull();
      // With no list up, Escape closes the box again.
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      });
      expect(box()).toBeNull();
    });

    it("names each chip's key the way the platform does (Alt+M here)", () => {
      openBox();
      const keys = Array.from(document.querySelectorAll(".steering-prompt-chip kbd")).map((k) => k.textContent);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(key).toMatch(/^Alt\+[A-Z]$/);
    });

    /** `IS_MAC` is an import-time constant: read the label from a fresh module
     *  graph under a mocked `lib/platform`. */
    it("names the chip keys with Option (⌥) on macOS", async () => {
      vi.resetModules();
      vi.doMock("../../lib/platform", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../../lib/platform")>()),
        IS_MAC: true,
        IS_WINDOWS: false,
        IS_LINUX: false,
        PLATFORM: "macos",
      }));
      try {
        const { chipKeyLabel } = await import("../../components/layout/SteeringPromptOverlay");
        const chips = ["model", "effort", "clear", "plan", "goal"] as const;
        expect(chips.map((c) => chipKeyLabel(c))).toEqual([
          "⌥M",
          "⌥E",
          "⌥K",
          "⌥L",
          "⌥G",
        ]);
      } finally {
        vi.doUnmock("../../lib/platform");
        vi.resetModules();
      }
    });
  });
});
