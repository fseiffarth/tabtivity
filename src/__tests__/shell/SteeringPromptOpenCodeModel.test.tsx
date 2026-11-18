/**
 * Steering's prompt box over OpenCode's model picker: the picker is answered
 * by typing a row's query (never by walking its highlight), and the `current`
 * it reports is the model in use, not the highlight. ↑/↓ move the box's own
 * cursor over the rows as shown, Enter answers that row, and no arrow goes
 * into the session (where it would fight the list walk).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { SessionPicker } from "../../hooks/useSessionPicker";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";

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

const choose = vi.fn();
let picker: SelectPrompt | null = null;
vi.mock("../../hooks/useSessionPicker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSessionPicker")>()),
  useSessionPicker: (): SessionPicker => ({
    picking: true,
    command: "/model",
    picker,
    step: picker,
    shownStep: picker,
    remembered: false,
    busy: false,
    listing: false,
    open: vi.fn(),
    choose,
    close: vi.fn(),
  }),
}));

import { useKeyboard } from "../../hooks/useKeyboard";
import { SteeringPromptOverlay } from "../../components/layout/SteeringPromptOverlay";
import { writePtyInput } from "../../lib/terminal/terminalInput";
import { _clearScheduledAgentInputsForTest } from "../../lib/agents/scheduledAgentInput";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";

function Harness() {
  useKeyboard({ onTogglePanels: () => {} });
  return null;
}

const steering = () => useKeyboardSteeringStore.getState();
const box = () => document.querySelector<HTMLTextAreaElement>(".steering-prompt-input")!;
const selected = () => document.querySelector('.steering-prompt-list [aria-selected="true"] .terminal-reader-option-label span')?.textContent;

/** OpenCode's model list as `openCodePickerPrompt` builds it: `current` the
 *  `●` row (none on mini), each row answered by its own search keys. */
function openCodeList(current: number): SelectPrompt {
  const rows = [
    { label: "Claude Sonnet 5.5", description: "Anthropic" },
    { label: "Claude Opus 5.5", description: "Anthropic" },
    { label: "Grok 4.5", description: "xAI" },
  ];
  return {
    options: rows.map((row, index) => ({ index, number: index + 1, ...row, keys: ["\u007f", row.label, "\r"] })),
    current,
    title: "Select model",
    start: 0,
    question: 0,
    context: 0,
  };
}

function openBox() {
  const entry = { key: "t1", label: "OpenCode", cmd: "opencode", cwd: "/p", kind: "agent", scheduleTargetId: "oc" } as TabEntry;
  useTabsStore.setState({ scope: "p", tabs: [entry], activeKey: entry.key });
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
  return box();
}

beforeEach(() => {
  _clearScheduledAgentInputsForTest();
  vi.mocked(writePtyInput).mockReset();
  choose.mockReset();
  useSettingsStore.setState({ settings: null });
  steering().exit();
});

afterEach(() => {
  cleanup();
});

describe("steering prompt box · OpenCode's model picker", () => {
  it("↓/↑ walk the box's own cursor from the model in use, Enter answers that row", () => {
    picker = openCodeList(0);
    const input = openBox();
    expect(selected()).toBe("Claude Sonnet 5.5");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe("Claude Opus 5.5");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Wraps round to the top.
    expect(selected()).toBe("Claude Sonnet 5.5");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(selected()).toBe("Grok 4.5");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(choose).toHaveBeenCalledWith(2);
    // Nothing was typed into the session: the walk owns its highlight.
    expect(writePtyInput).not.toHaveBeenCalled();
  });

  it("mini marks no row: ↓ starts at the first, Enter before it picks nothing", () => {
    picker = openCodeList(-1);
    const input = openBox();
    expect(selected()).toBeUndefined();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(choose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(selected()).toBe("Claude Sonnet 5.5");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(choose).toHaveBeenCalledWith(0);
    expect(writePtyInput).not.toHaveBeenCalled();
  });
});
