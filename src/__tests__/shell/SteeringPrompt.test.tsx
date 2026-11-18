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
import { invoke } from "@tauri-apps/api/core";
import {
  _clearScheduledAgentInputsForTest,
  registerScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { envName } from "../../lib/brand";

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
    press(" ");
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
    press(" ");
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
    press(" ");
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
    press(" ");
    fireEvent.change(box()!, { target: { value: "half a thought" } });
    act(() => {
      box()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(box()).toBeNull();
    press(" ");
    expect(box()?.value).toBe("half a thought");
    fireEvent.keyDown(box()!, { key: "Enter" });
    await vi.waitFor(() => expect(box()).toBeNull());
    press(" ");
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
    press(" ");
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
    press(" ");
    expect(box()).toBeNull();
    expect(steering().active).toBe(true);
  });

  describe("paste", () => {
    const invokeMock = vi.mocked(invoke);
    const openBox = (draft: string) => {
      activeTab({ kind: "agent", scheduleTargetId: "target" });
      render(
        <>
          <Harness />
          <SteeringPromptOverlay />
        </>,
      );
      act(() => steering().enter());
      press(" ");
      fireEvent.change(box()!, { target: { value: draft } });
      box()!.setSelectionRange(draft.length, draft.length);
    };
    const clipboard = (data: Record<string, string>) => ({
      getData: (type: string) => data[type] ?? "",
      files: [],
      types: Object.keys(data),
    });
    afterEach(() => invokeMock.mockReset());

    it("copied files go to the tab's inbox and in as @ references at the caret", async () => {
      invokeMock.mockImplementation(async (cmd) =>
        cmd === "pty_drop_files" ? { items: ["inbox/a.pdf", "inbox/b.png"], error: null } : undefined,
      );
      openBox("look at");
      const pasted = fireEvent.paste(box()!, { clipboardData: clipboard({ "text/uri-list": "file:///home/u/a.pdf\r\nfile:///home/u/b.png" }) });
      expect(pasted).toBe(false);
      await vi.waitFor(() => expect(box()?.value).toBe("look at @inbox/a.pdf @inbox/b.png "));
      expect(invokeMock).toHaveBeenCalledWith("pty_drop_files", expect.objectContaining({
        id: "p:t1",
        paths: ["/home/u/a.pdf", "/home/u/b.png"],
        agent: true,
      }));
    });

    it("an image with no text on the clipboard goes in as its inbox reference", async () => {
      invokeMock.mockImplementation(async (cmd) => (cmd === "pty_paste_clipboard_image" ? "inbox/shot.png" : undefined));
      openBox("");
      fireEvent.paste(box()!, { clipboardData: clipboard({}) });
      await vi.waitFor(() => expect(box()?.value).toBe("@inbox/shot.png "));
    });

    it("text pastes as it always did", () => {
      openBox("");
      const pasted = fireEvent.paste(box()!, { clipboardData: clipboard({ "text/plain": "hello" }) });
      expect(pasted).toBe(true);
      expect(invokeMock).not.toHaveBeenCalledWith("pty_paste_clipboard_image", expect.anything());
    });
  });

  describe("chips", () => {
    function openBox(target = "chips", tab: Partial<TabEntry> = { kind: "agent" }) {
      activeTab({ ...tab, scheduleTargetId: target });
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
      press(" ");
      return box()!;
    }
    const alt = (input: HTMLTextAreaElement, key: string) =>
      fireEvent.keyDown(input, { key, code: `Key${key.toUpperCase()}`, altKey: true });
    const written = () => writeMock.mock.calls.map(([, bytes]) => decode(bytes));

    it("Alt+P / Alt+G lead the text with /plan or /goal and take it off again", () => {
      const input = openBox();
      fireEvent.change(input, { target: { value: "tidy the tests" } });
      alt(input, "p");
      expect(box()!.value).toBe("/plan tidy the tests");
      alt(input, "g");
      expect(box()!.value).toBe("/goal tidy the tests");
      alt(input, "g");
      expect(box()!.value).toBe("tidy the tests");
      expect(writeMock).not.toHaveBeenCalled();
    });

    it("AltGr+E (€ on a German layout) opens the effort list like Alt+E, and types no €", () => {
      const input = openBox();
      // Linux: AltGr is neither Alt nor Ctrl. Windows: Ctrl+Alt as well.
      const linux = fireEvent.keyDown(input, { key: "€", code: "KeyE", modifierAltGraph: true });
      expect(linux).toBe(false); // default prevented: no € in the box
      expect(document.querySelector(".steering-prompt-list")).not.toBeNull();
      fireEvent.keyDown(input, { key: "€", code: "KeyE", ctrlKey: true, altKey: true, modifierAltGraph: true });
      expect(document.querySelector(".steering-prompt-list")).toBeNull();
    });

    it("Ctrl+Alt+E without AltGr is not a chip", () => {
      const input = openBox();
      fireEvent.keyDown(input, { key: "e", code: "KeyE", ctrlKey: true, altKey: true });
      expect(document.querySelector(".steering-prompt-list")).toBeNull();
    });

    it("Alt+C clears only on the second press", async () => {
      const input = openBox();
      alt(input, "c");
      expect(writeMock).not.toHaveBeenCalled();
      expect(document.querySelector(".steering-prompt-chip.on")).not.toBeNull();
      alt(input, "c");
      await vi.waitFor(() => expect(written()).toContain("/clear"));
      expect(box()).not.toBeNull();
    });

    it("another key between the two Alt+C presses disarms Clear", () => {
      const input = openBox();
      alt(input, "c");
      fireEvent.keyDown(input, { key: "a" });
      alt(input, "c");
      expect(writeMock).not.toHaveBeenCalled();
    });

    it("Alt+T lists the three commit prompts: a digit sends one as a prompt of its own and closes the box, the draft kept", async () => {
      const input = openBox();
      fireEvent.change(input, { target: { value: "half a thought" } });
      alt(input, "t");
      expect(document.querySelectorAll(".steering-prompt-list .terminal-reader-option").length).toBe(3);
      fireEvent.keyDown(input, { key: "2" });
      await vi.waitFor(() => expect(written().join("")).toContain("Commit the current state"));
      await vi.waitFor(() => expect(box()).toBeNull());
      // The draft waits for the tab's next open.
      press(" ");
      expect(box()?.value).toBe("half a thought");
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

    it("a local-model tab names its model and offers no model list", () => {
      openBox("chips", {
        kind: "local_agent", label: "qwen3:8b · OpenCode", cmd: "ollama", localDriver: "opencode",
        env: { [envName("LOCAL_MODEL")]: "qwen3:8b" },
      });
      expect(document.querySelector(".steering-prompt-agent")?.textContent).toContain("qwen3:8b");
      const keys = Array.from(document.querySelectorAll(".steering-prompt-chip kbd")).map((k) => k.textContent);
      expect(keys).not.toContain("Alt+M");
      expect(keys).not.toContain("Alt+E");
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
        const chips = ["model", "effort", "clear", "plan", "goal", "commit"] as const;
        expect(chips.map((c) => chipKeyLabel(c))).toEqual([
          "⌥M",
          "⌥E",
          "⌥C",
          "⌥P",
          "⌥G",
          "⌥T",
        ]);
      } finally {
        vi.doUnmock("../../lib/platform");
        vi.resetModules();
      }
    });
  });
});
