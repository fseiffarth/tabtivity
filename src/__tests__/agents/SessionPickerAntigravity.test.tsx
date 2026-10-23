/**
 * The desktop Chat view's model list against Antigravity's `Switch Model`
 * dialog (`agy` 1.4.5): one dialog for the model and its effort. A model tap
 * only walks the highlight there; the effort the dialog then draws for that
 * model is the second step, and Enter goes out with it. A model with no slider
 * is accepted as soon as the walk lands. The screens are what `agy` paints.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => {}),
  rows: [] as string[],
}));
vi.mock("../../lib/agents/scheduledAgentInput", () => ({ submitScheduledAgentCommand: mocks.submit, holdSessionPicker: () => () => {} }));
vi.mock("../../lib/terminal/terminalRegistry", () => ({
  terminalFor: () => ({
    rows: 40,
    buffer: {
      active: {
        get length() { return mocks.rows.length; },
        getLine: (row: number) => (mocks.rows[row] == null ? undefined : { isWrapped: false, translateToString: () => mocks.rows[row] }),
      },
    },
  }),
}));

import { useSessionPicker } from "../../hooks/useSessionPicker";
import type { TabEntry } from "../../stores/tabs";

const ESC = String.fromCharCode(27);
const DOWN = `${ESC}[B`;
const LEFT = `${ESC}[D`;
const TAB = { key: "t1", label: "Google Antigravity", cmd: "agy", cwd: "/home/u/p", kind: "agent", scheduleTargetId: "s1" } as TabEntry;

const MODELS = [
  "Gemini 3.8 Flash",
  "Claude Sonnet 4.6 (Thinking)",
  "Claude Opus 4.6 (Thinking)",
];

/** The dialog with row `at` highlighted; the slider only under a Gemini row. */
function dialog(at: number): string[] {
  const rows = [
    ">",
    "Switch Model",
    "  Search:",
    "          ────────────────────",
    ...MODELS.map((label, index) => `${index === at ? ">" : " "} ${label}${index === 0 ? "             (current)" : ""}`),
  ];
  if (at === 0) {
    rows.push(
      "",
      "  Effort  ◂        ●━━━━━━━━━━━━━━●━━━━━━━━━━━━━━◉        ▸",
      "                  low          medium          high",
      "            Deepest reasoning for complex problems — slower but strongest",
    );
  }
  rows.push("Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back", "                                                          Gemini 3.8 Flash · high");
  return rows;
}

function mount() {
  const typeKeys = vi.fn(async (_keys: string[]) => {});
  const hook = renderHook(() => useSessionPicker({ tab: TAB, ptyId: "p1:t1", agentLabel: "Google Antigravity", typeKeys }));
  return { typeKeys, ...hook };
}

describe("the Chat view's model list on Antigravity's dialog", () => {
  beforeEach(() => {
    mocks.submit.mockClear();
    mocks.rows = dialog(0);
  });

  it("lists the dialog's rows, which carry no numbers", async () => {
    const { result } = mount();
    act(() => result.current.open());
    await waitFor(() => expect(result.current.step?.options.map((option) => option.label)).toEqual(MODELS));
    expect(mocks.submit).toHaveBeenCalledWith("s1", "/model");
  });

  it("walks to a Claude model and accepts it, there being no effort to ask", async () => {
    const { result, typeKeys } = mount();
    act(() => result.current.open());
    await waitFor(() => expect(result.current.step).not.toBeNull());
    act(() => result.current.choose(2));
    expect(typeKeys).toHaveBeenCalledWith([DOWN, DOWN]);
    expect(typeKeys).toHaveBeenCalledTimes(1);
    mocks.rows = dialog(2);
    await waitFor(() => expect(typeKeys).toHaveBeenLastCalledWith(["\r"]));
  });

  it("asks the effort of a Gemini model once the highlight is on it, and applies both on Enter", async () => {
    mocks.rows = dialog(1);
    const { result, typeKeys } = mount();
    act(() => result.current.open());
    await waitFor(() => expect(result.current.step).not.toBeNull());
    act(() => result.current.choose(0));
    expect(typeKeys).toHaveBeenLastCalledWith([`${ESC}[A`]);
    // The model list stays up while the highlight walks.
    expect(result.current.shownStep?.options).toHaveLength(3);
    expect(result.current.busy).toBe(true);
    mocks.rows = dialog(0);
    await waitFor(() => expect(result.current.step?.options.map((option) => option.label)).toEqual(["low", "medium", "high"]));
    expect(result.current.step?.title).toContain("Gemini 3.8 Flash");
    expect(result.current.step?.current).toBe(2);
    act(() => result.current.choose(0));
    expect(typeKeys).toHaveBeenLastCalledWith([LEFT, LEFT, "\r"]);
  });
});
