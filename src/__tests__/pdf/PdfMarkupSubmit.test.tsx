/**
 * The desktop markup mode's Submit (`usePdfMarkup` + `PdfMarkupBar`,
 * `docs/pdf_markup_rounds_plan.md` §2.6): the marks go to `pdf_markup_submit`,
 * the prompt it answers is queued for an agent tab of the project and held for
 * the CLI's own queue (`holdPhonePrompt`) — and only then do the marks move to
 * the sent side. Without an agent tab there is nothing to send to; a prompt the
 * scheduler refuses leaves the marks unsent.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../../stores/agents/agentPrompts", () => ({ queuePromptForTab: mocks.queuePromptForTab }));
vi.mock("../../lib/agents/phoneHolds", () => ({ holdPhonePrompt: mocks.holdPhonePrompt }));
vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: mocks.loadLayer,
  saveLayer: mocks.saveLayer,
}));
vi.mock("../../../mobile-web/src/markup/rasterize", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/rasterize")>()),
  layerPng: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
}));

vi.mock("../../components/embed/pdf/markupPage", async (original) => {
  const real = await original<typeof import("../../components/embed/pdf/markupPage")>();
  return { ...real, markupPagePicture: vi.fn(real.markupPagePicture) };
});

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { markupPagePicture } from "../../components/embed/pdf/markupPage";
import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import { useSettingsStore } from "../../stores/settings";
import type { Settings } from "../../types";
import { DEFAULT_PDF_MARKUP_APPLY, markupUndoNote } from "../../lib/viewers/pdfMarkup";
import { SETTLE_MS } from "../../../mobile-web/src/markup/submitState";
import { MARKUP_SUBAGENT_LINE } from "../../../mobile-web/src/markupInstruction";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { EMPTY_LAYER, addMark, type Layer } from "../../../mobile-web/src/markup/layer";
import { BRAND, NAMES } from "../../lib/brand";

const PATH = "/home/u/paper/paper.pdf";
const SIZE: [number, number] = [595, 842];
const STROKE = { kind: "ink" as const, color: "red" as const, width: 1.7, points: [[10, 10, 0.5], [40, 30, 0.5]] as [number, number, number][] };
const LAYER = addMark(EMPTY_LAYER, 1, SIZE, STROKE);

function agentTab(key: string, scheduleTargetId: string, label: string): TabEntry {
  return { key, label, cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId } as TabEntry;
}

function Harness({ onReload = () => {} }: { onReload?: () => void }) {
  const markup = usePdfMarkup({
    projectId: "p1",
    scope: "p1",
    path: PATH,
    active: true,
    visible: true,
    pageCount: 3,
    docSize: 9_000,
    docVersion: 0,
  });
  return <PdfMarkupBar markup={markup} page={1} onReload={onReload} onDone={() => {}} />;
}

const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;
const lastSaved = (): Layer | undefined => {
  const calls = mocks.saveLayer.mock.calls as unknown as [string, Layer][];
  return calls[calls.length - 1]?.[1];
};

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "file_mtime") return 1_790_000_000;
    if (command === "pdf_markup_submit") return { prompt: "Look at the marked copy.", marked: `${NAMES.inboxDir}/x-paper-marked.pdf` };
    return null;
  });
  mocks.queuePromptForTab.mockReset();
  mocks.queuePromptForTab.mockResolvedValue({ pruned: 0, id: "sched-1" });
  mocks.holdPhonePrompt.mockReset();
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 });
  mocks.saveLayer.mockClear();
  useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

describe("desktop markup Submit", () => {
  it("sends each page drawn with its marks and the words they are on", async () => {
    vi.mocked(markupPagePicture).mockResolvedValueOnce({
      png: new Blob(["page"], { type: "image/png" }),
      composed: true,
      anchors: [{ mark: 0, how: "through", words: "teh", line: "teh result" }],
    });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1].pages).toEqual([{
      n: 1, size: SIZE, marks: [STROKE], layerPng: btoa("page"), composed: true,
      anchors: [{ mark: 0, how: "through", words: "teh", line: "teh result" }],
    }]);
  });

  it("bakes the marks, queues the prompt for the agent tab and holds it for its queue", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.getByText("→ Claude")).toBeTruthy();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1]).toEqual({
      projectId: "p1",
      path: PATH,
      pages: [{ n: 1, size: SIZE, marks: [STROKE], layerPng: btoa("png") }],
      // A fresh round id, for the agent's ticks (`markup_done`).
      round: expect.stringMatching(/^[a-z0-9]{8}$/),
      // Apply marks directly is on unset.
      mode: "apply",
    });
    expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", "Look at the marked copy.");
    // Queued first, held second — the hold names the schedule just made.
    expect(mocks.queuePromptForTab.mock.invocationCallOrder[0]).toBeLessThan(mocks.holdPhonePrompt.mock.invocationCallOrder[0]);
    // The round's marks moved to the sent side and the record keeps them.
    await waitFor(() => expect(lastSaved()).toEqual({
      pages: {},
      sent: { pages: LAYER.pages, rounds: 1, log: [{ id: call[1].round, pages: { 1: [STROKE] } }] },
    }));
    expect(screen.getByText("Sent — waiting for the agent")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("sends the desktop's own Mark up prompt setting with the marks", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_instruction: "  Fix only typos.  " } as Settings });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1]).toMatchObject({ instruction: "Fix only typos." });
    expect(call[1]).not.toHaveProperty("ask");
  });

  it("sends the desktop's asking dial once it is off the default", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_ask: 0 } as Settings });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1]).toMatchObject({ ask: 0 });
  });

  it("hands the round to a new subagent in subagent mode, the request unchanged", async () => {
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_subagents: true } as Settings });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", `${MARKUP_SUBAGENT_LINE}\n\nLook at the marked copy.`);
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(Object.keys(call[1]).sort()).toEqual(["mode", "pages", "path", "projectId", "round"]);
  });

  it("offers Make these changes once the agent is done, queues the follow-up and offers it once", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    act(() => useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} }));
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: {} }));
    const apply = await screen.findByRole("button", { name: /Make these changes/ }, { timeout: SETTLE_MS + 2_000 });
    mocks.queuePromptForTab.mockResolvedValueOnce({ pruned: 0, id: "sched-2" });
    fireEvent.click(apply);
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-2"));
    expect(mocks.queuePromptForTab).toHaveBeenLastCalledWith("p1", "s1", DEFAULT_PDF_MARKUP_APPLY);
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
  });

  it("follows the agent tab: working at Submit shows it at work", async () => {
    useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p1:t1": "decision" } }));
    expect(await screen.findByText("The agent is asking something — answer in its tab")).toBeTruthy();
  });

  it("shows the question of a dialog the tab waits on, and leads to the tab to answer it", async () => {
    const screenText = ["Edit file", "  paper.tex", "", "Do you want to make this edit to paper.tex?", "❯ 1. Yes", "  2. No", "", "  esc to cancel"].join("\r\n");
    const base = mocks.invoke.getMockImplementation();
    mocks.invoke.mockImplementation(async (command: string, args?: unknown) =>
      (command === "pty_scrollback" ? { data: screenText, startOffset: 0, endOffset: screenText.length } : base?.(command, args)));
    const setActive = vi.spyOn(useTabsStore.getState(), "setActive").mockImplementation(() => {});
    try {
      render(<Harness />);
      await waitFor(() => expect(submitButton().disabled).toBe(false));
      expect(screen.queryByRole("button", { name: /Answer in tab/ })).toBeNull();
      fireEvent.click(submitButton());
      await screen.findByText("Sent — waiting for the agent");
      act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p1:t1": "decision" } }));
      expect(await screen.findByText("“Do you want to make this edit to paper.tex?”")).toBeTruthy();
      expect(mocks.invoke).toHaveBeenCalledWith("pty_scrollback", { id: "p1:t1" });
      fireEvent.click(screen.getByRole("button", { name: /Answer in tab/ }));
      expect(setActive).toHaveBeenCalledWith("t1");
      // Answered: the tab works again, and the line and the button go.
      act(() => useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} }));
      await waitFor(() => expect(screen.queryByRole("button", { name: /Answer in tab/ })).toBeNull());
      expect(screen.queryByText("“Do you want to make this edit to paper.tex?”")).toBeNull();
    } finally {
      setActive.mockRestore();
    }
  });

  it("names the target's model while it works, by its first word", async () => {
    useAgentModelsStore.setState({ screenByTab: { "p1:t1": "Opus 4.5 · high" } });
    useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} });
    try {
      render(<Harness />);
      await waitFor(() => expect(submitButton().disabled).toBe(false));
      fireEvent.click(submitButton());
      expect(await screen.findByText("Opus is working…")).toBeTruthy();
    } finally {
      useAgentModelsStore.setState({ screenByTab: {} });
    }
  });

  it("keeps Submit off with a hint when the project has no agent tab", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [] } });
    render(<Harness />);
    await waitFor(() => expect(mocks.loadLayer).toHaveBeenCalled());
    expect(screen.getAllByText("Open an agent tab in this project to send").length).toBeGreaterThan(0);
    expect(submitButton().disabled).toBe(true);
    fireEvent.click(submitButton());
    expect(mocks.invoke.mock.calls.some(([command]) => command === "pdf_markup_submit")).toBe(false);
  });

  it("leaves the marks unsent when the prompt is too long to queue", async () => {
    mocks.queuePromptForTab.mockRejectedValue(new Error("message_too_long"));
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText(/the prompt could not be queued \(the prompt is longer than an agent message may be\)/)).toBeTruthy();
    expect(mocks.holdPhonePrompt).not.toHaveBeenCalled();
    // Nothing moved: no record with sent marks, and Submit is there again.
    expect(mocks.saveLayer.mock.calls.length).toBe(0);
    expect(submitButton().disabled).toBe(false);
  });

  it("says why the backend refused, and sends nothing on", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "file_mtime") return 1_790_000_000;
      if (command === "pdf_markup_submit") throw "hidden_path";
      return null;
    });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    expect(await screen.findByText(new RegExp(`Nothing was sent: PDFs in \\.git, \\.${BRAND.slug} or \\.env folders can't be marked up`))).toBeTruthy();
    expect(mocks.queuePromptForTab).not.toHaveBeenCalled();
  });

  it("sends to the tab picked when the project has several", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    const picker = screen.getByRole("combobox") as HTMLSelectElement;
    expect([...picker.options].map((option) => option.textContent)).toEqual(["Claude", "Codex"]);
    fireEvent.change(picker, { target: { value: "s2" } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s2", "Look at the marked copy."));
  });

  it("Go to tab brings the picked agent tab to the front", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    const setActive = vi.spyOn(useTabsStore.getState(), "setActive").mockImplementation(() => {});
    try {
      render(<Harness />);
      await waitFor(() => expect(submitButton().disabled).toBe(false));
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "s2" } });
      fireEvent.click(screen.getByRole("button", { name: /Go to tab/ }));
      expect(setActive).toHaveBeenCalledWith("t2");
    } finally {
      setActive.mockRestore();
    }
  });

  it("falls back to another tab when the chosen one closes", async () => {
    useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude"), agentTab("t2", "s2", "Codex")] } });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "s2" } });
    act(() => useTabsStore.setState({ tabsByScope: { p1: [agentTab("t1", "s1", "Claude")] } }));
    expect(await screen.findByText("→ Claude")).toBeTruthy();
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", "Look at the marked copy."));
  });
});

describe("desktop markup Undo (apply rounds)", () => {
  const UNDO_ID = "0123456789abcdef0123456789abcdef";
  const CHANGES = { files: [{ path: "paper.tex", change: "modified" }], more: 0, pdf: "restored" };
  const undoButton = () => screen.queryByRole("button", { name: "Undo the agent's changes from this round" });

  function backend(overrides: Record<string, () => unknown> = {}) {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (overrides[command]) return overrides[command]();
      if (command === "file_mtime") return 1_790_000_000;
      if (command === "pdf_markup_submit") return { prompt: "Look at the marked copy.", marked: null, mode: "apply", undo: UNDO_ID, noUndo: null };
      if (command === "pdf_markup_undo_preview" || command === "pdf_markup_undo") return CHANGES;
      return null;
    });
  }
  const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);

  /** Submit, then one turn of the agent to finished. */
  async function finishedRound(onReload = vi.fn()) {
    render(<Harness onReload={onReload} />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    expect(undoButton()).toBeNull();
    act(() => useActivityStore.setState({ busyByTab: { "p1:t1": true }, attentionByTab: {} }));
    expect(await screen.findByText("Agent is working…")).toBeTruthy();
    expect(undoButton()).toBeNull();
    act(() => useActivityStore.setState({ busyByTab: {}, attentionByTab: {} }));
    await screen.findByText(/^Agent finished/, undefined, { timeout: SETTLE_MS + 2_000 });
    return onReload;
  }

  it("settles as the round finishes, and the dialog's Undo puts the files back, reloads and queues a note — no new round", async () => {
    backend();
    const onReload = await finishedRound();
    await waitFor(() => expect(calls("pdf_markup_undo_settle")).toEqual([["pdf_markup_undo_settle", { projectId: "p1", undoId: UNDO_ID }]]));
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
    fireEvent.click(undoButton()!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Undo the agent's changes from these marks?");
    expect(dialog.textContent).toContain("Back as before: paper.tex. The PDF goes back to before.");
    expect(calls("pdf_markup_undo_preview")).toEqual([["pdf_markup_undo_preview", { projectId: "p1", undoId: UNDO_ID }]]);
    mocks.queuePromptForTab.mockResolvedValueOnce({ pruned: 0, id: "sched-2" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
    expect(calls("pdf_markup_undo")).toEqual([["pdf_markup_undo", { projectId: "p1", undoId: UNDO_ID }]]);
    expect(mocks.queuePromptForTab).toHaveBeenLastCalledWith("p1", "s1", markupUndoNote(["paper.tex"], 0));
    expect(mocks.holdPhonePrompt).toHaveBeenLastCalledWith("sched-2");
    expect(await screen.findByText("Undone — the files are back as they were before the round.")).toBeTruthy();
    expect(screen.queryByText("Sent — waiting for the agent")).toBeNull();
    expect(undoButton()).toBeNull();
    expect(screen.queryByRole("button", { name: /Make these changes/ })).toBeNull();
  });

  it("says which files changed since when the undo is refused, and reloads nothing", async () => {
    backend({ pdf_markup_undo: () => { throw { code: "undo_conflict", files: ["paper.tex"], more: 0 }; } });
    const onReload = await finishedRound();
    fireEvent.click(undoButton()!);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Can't undo — `paper.tex` changed since. Nothing was changed.")).toBeTruthy();
    expect(onReload).not.toHaveBeenCalled();
    expect(mocks.queuePromptForTab).toHaveBeenCalledTimes(1);
    expect(undoButton()).toBeTruthy();
  });

  it("runs a list round with Make these changes and says why there is no undo", async () => {
    backend({ pdf_markup_submit: () => ({ prompt: "Look at the marked copy.", marked: null, mode: "list", undo: null, noUndo: "too_big" }) });
    await finishedRound();
    expect(screen.getByText("No undo here (too many changed or untracked files) — the agent lists the changes first.")).toBeTruthy();
    const apply = await screen.findByRole("button", { name: /Make these changes/ });
    expect(undoButton()).toBeNull();
    expect(calls("pdf_markup_undo_settle")).toHaveLength(0);
    // The follow-up makes the changes: the line about listing first is past.
    fireEvent.click(apply);
    expect(await screen.findByText("Sent — waiting for the agent")).toBeTruthy();
    expect(screen.queryByText(/No undo here/)).toBeNull();
  });

  it("treats an older backend's answer (no mode) as a list round, with no fallback line", async () => {
    backend({ pdf_markup_submit: () => ({ prompt: "Look at the marked copy.", marked: null }) });
    await finishedRound();
    expect(await screen.findByRole("button", { name: /Make these changes/ })).toBeTruthy();
    expect(undoButton()).toBeNull();
    expect(screen.queryByText(/No undo here/)).toBeNull();
    expect(calls("pdf_markup_undo_settle")).toHaveLength(0);
  });

  it("offers an undo the backend no longer holds no more", async () => {
    backend({ pdf_markup_undo_preview: () => { throw { code: "undo_gone", files: [], more: 0 }; } });
    await finishedRound();
    fireEvent.click(undoButton()!);
    expect(await screen.findByText("This undo is no longer available.")).toBeTruthy();
    expect(undoButton()).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls("pdf_markup_undo")).toHaveLength(0);
  });

  it("sends one preview for a double click, and opens the dialog once it answers", async () => {
    let answer: (changes: unknown) => void = () => {};
    backend({ pdf_markup_undo_preview: () => new Promise((resolve) => { answer = resolve; }) });
    await finishedRound();
    const button = undoButton()!;
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(calls("pdf_markup_undo_preview")).toHaveLength(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { answer(CHANGES); });
    expect((await screen.findByRole("dialog")).textContent).toContain("Back as before: paper.tex.");
  });

  it("asks for a list round with Apply marks directly switched off", async () => {
    backend({ pdf_markup_submit: () => ({ prompt: "Look at the marked copy.", marked: null, mode: "list", undo: null, noUndo: null }) });
    useSettingsStore.setState({ settings: { ...useSettingsStore.getState().settings, pdf_markup_direct: false } as Settings });
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalled());
    expect(calls("pdf_markup_submit")[0][1]).toMatchObject({ mode: "list" });
    expect(screen.queryByText(/No undo here/)).toBeNull();
  });
});
