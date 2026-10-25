/**
 * The desktop model list before the session has drawn its picker: the rows
 * this CLI build's own `/model` picker drew last time (`remembered_model_rows`)
 * are listed at once, a row tapped among them is held and answered in the live
 * picker by its label once it is drawn — never a row the live picker lacks —
 * and the live list is kept for the next opening once it has settled, when it
 * differs and nothing was answered in it first.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => {}),
  rows: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
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
const UP = `${ESC}[A`;
const TAB = { key: "t1", label: "Claude", cmd: "claude", cwd: "/home/u/p", kind: "agent", scheduleTargetId: "s1" } as TabEntry;

/** Claude Code's `/model` picker, its highlight on the current model. */
const PICKER = [
  "   Select model",
  "   Switch between Claude models. Your pick becomes the default for new sessions.",
  "",
  "     1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks",
  "     2.  Fable 5.1              For your toughest challenges",
  "     3.  Opus 5.5               For complex work and everyday tasks",
  "   ❯ 4.  Sonnet 5.5 ✔           Most efficient for simpler tasks",
  "",
  "   Enter to set as default · s to use this session only · Esc to cancel",
];

/** What an earlier opening of the same build kept: Opus listed before Fable. */
const REMEMBERED = {
  title: "Select model",
  rows: [
    { label: "Default (recommended)", description: "Sonnet 5.5 · Efficient for routine tasks", number: 1 },
    { label: "Opus 5.5", description: "For complex work and everyday tasks", number: 2 },
    { label: "Opus 4.1", description: "Legacy", number: 3 },
    { label: "Sonnet 5.5", description: "Most efficient for simpler tasks", number: 4 },
  ],
};

function mount(remembered: unknown = REMEMBERED) {
  vi.mocked(invoke).mockImplementation(async (command: string) => (command === "remembered_model_rows" ? remembered : undefined));
  const typeKeys = vi.fn(async (_keys: string[]) => {});
  const hook = renderHook(() => useSessionPicker({ tab: TAB, ptyId: "p1:t1", agentLabel: "Claude", typeKeys }));
  return { typeKeys, ...hook };
}

const keeps = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === "remember_model_rows");

describe("the model list remembered for the CLI's build", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    mocks.submit.mockClear();
    mocks.rows = [];
  });

  it("lists the remembered rows at once and answers a tapped one in the live picker by its label", async () => {
    const { result, typeKeys } = mount();
    act(() => result.current.open());
    expect(vi.mocked(invoke)).toHaveBeenCalledWith("remembered_model_rows", { agent: "claude" });
    await waitFor(() => expect(result.current.shownStep?.options.map((option) => option.label))
      .toEqual(["Default (recommended)", "Opus 5.5", "Opus 4.1", "Sonnet 5.5"]));
    expect(result.current.remembered).toBe(true);
    expect(result.current.busy).toBe(false);

    act(() => result.current.choose(1));
    expect(result.current.busy).toBe(true);
    expect(typeKeys).not.toHaveBeenCalled();

    // The live picker lists Opus third: the walk goes to it, not to row 2.
    mocks.rows = PICKER;
    await waitFor(() => expect(typeKeys).toHaveBeenCalledWith([UP, "\r"]));
    expect(typeKeys).toHaveBeenCalledTimes(1);
    expect(result.current.remembered).toBe(false);
    // Answered as soon as it was drawn: a list that never settled is not kept.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    expect(keeps()).toHaveLength(0);
  });

  it("keeps a live list that differs from the remembered one once it has settled", async () => {
    const { result } = mount();
    act(() => result.current.open());
    await waitFor(() => expect(result.current.remembered).toBe(true));
    mocks.rows = PICKER;
    await waitFor(() => expect(result.current.remembered).toBe(false));
    expect(keeps()).toHaveLength(0);
    await waitFor(() => expect(keeps()).toHaveLength(1));
    expect(keeps()[0][1]).toMatchObject({
      agent: "claude",
      rows: { rows: [
        { label: "Default (recommended)", number: 1 },
        { label: "Fable 5.1", number: 2 },
        { label: "Opus 5.5", number: 3 },
        { label: "Sonnet 5.5", number: 4 },
      ] },
    });
  });

  it("never answers a remembered row the live picker no longer has", async () => {
    const { result, typeKeys } = mount();
    act(() => result.current.open());
    await waitFor(() => expect(result.current.remembered).toBe(true));
    act(() => result.current.choose(2));
    mocks.rows = PICKER;
    await waitFor(() => expect(result.current.shownStep?.options).toHaveLength(4));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(typeKeys).not.toHaveBeenCalled();
    expect(result.current.shownStep?.options.map((option) => option.label)).toContain("Fable 5.1");
  });

  it("keeps nothing new when the live list is the one remembered", async () => {
    const same = {
      title: "Select model",
      rows: [
        { label: "Default (recommended)", description: "Sonnet 5.5 · Efficient for routine tasks", number: 1 },
        { label: "Fable 5.1", description: "For your toughest challenges", number: 2 },
        { label: "Opus 5.5", description: "For complex work and everyday tasks", number: 3 },
        { label: "Sonnet 5.5", description: "Most efficient for simpler tasks", number: 4 },
      ],
    };
    const { result } = mount(same);
    act(() => result.current.open());
    await waitFor(() => expect(result.current.remembered).toBe(true));
    mocks.rows = PICKER;
    await waitFor(() => expect(result.current.remembered).toBe(false));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
    expect(keeps()).toHaveLength(0);
  });

  it("waits for the live picker as before when nothing is remembered", async () => {
    const { result } = mount(null);
    act(() => result.current.open());
    await act(async () => {});
    expect(result.current.shownStep).toBeNull();
    expect(result.current.busy).toBe(true);
    mocks.rows = PICKER;
    await waitFor(() => expect(result.current.step?.options).toHaveLength(4));
    await waitFor(() => expect(keeps()).toHaveLength(1));
  });
});
