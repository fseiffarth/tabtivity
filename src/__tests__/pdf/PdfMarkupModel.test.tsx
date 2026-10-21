/**
 * The markup strip's model chip (`PdfMarkupModel`): the target tab's model,
 * whose click asks the tab's own session for `/model` — only while the agent
 * is idle and its screen is in this window; a local-model tab only says its
 * model.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  submit: vi.fn(async () => {}),
  terminal: vi.fn((): unknown => ({ buffer: { active: { length: 0, getLine: () => undefined } } })),
}));
vi.mock("../../lib/agents/scheduledAgentInput", () => ({ submitScheduledAgentCommand: mocks.submit, holdSessionPicker: () => () => {} }));
vi.mock("../../lib/terminal/terminalRegistry", () => ({ terminalFor: mocks.terminal }));
vi.mock("../../lib/agents/paneKeys", () => ({ typePaneKeys: vi.fn(async () => {}) }));

import { PdfMarkupModel } from "../../components/embed/pdf/PdfMarkupModel";
import type { TabEntry } from "../../stores/tabs";

const TAB = { key: "t1", label: "Claude", cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId: "s1" } as TabEntry;

function chip(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Opus 4\.7/ });
}

describe("PdfMarkupModel", () => {
  beforeEach(() => {
    mocks.submit.mockClear();
    mocks.terminal.mockClear();
  });
  afterEach(cleanup);

  it("opens the tab's own model list on a click while the agent is idle", () => {
    render(<PdfMarkupModel tab={TAB} ptyId="p1:t1" label="Claude" model="Opus 4.7" agent="idle" disabled={false} />);
    fireEvent.click(chip());
    expect(mocks.submit).toHaveBeenCalledWith("s1", "/model");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(chip().getAttribute("aria-expanded")).toBe("true");
  });

  it("waits while the agent works, or while its screen is not in this window", () => {
    const { rerender } = render(<PdfMarkupModel tab={TAB} ptyId="p1:t1" label="Claude" model="Opus 4.7" agent="working" disabled={false} />);
    expect(chip().disabled).toBe(true);
    mocks.terminal.mockReturnValue(undefined);
    rerender(<PdfMarkupModel tab={TAB} ptyId="p1:t1" label="Claude" model="Opus 4.7" agent="idle" disabled={false} />);
    expect(chip().disabled).toBe(true);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("only says the model of a local-model tab", () => {
    render(<PdfMarkupModel tab={{ ...TAB, kind: "local_agent" } as TabEntry} ptyId="p1:t1" label="Claude" model="qwen3" agent="idle" disabled={false} />);
    expect(screen.getByText("qwen3")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
