/**
 * Mark up on a picture (`ImageView` → `usePdfMarkup` with `picture`): one
 * page in the picture's pixels; Submit sends the marks alone as the page's
 * layer and the picture with them drawn on as `picturePng` — the phone's
 * picture Submit — and the strip speaks of the picture, not a PDF.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  queuePromptForTab: vi.fn(),
  holdPhonePrompt: vi.fn(),
  loadLayer: vi.fn(),
  saveLayer: vi.fn(async () => true),
  composedPng: vi.fn(async () => new Blob(["composed"], { type: "image/png" })),
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
  layerPng: vi.fn(async () => new Blob(["layer"], { type: "image/png" })),
  composedPng: mocks.composedPng,
}));

import { PdfMarkupBar } from "../../components/embed/pdf/PdfMarkupBar";
import { usePdfMarkup } from "../../components/embed/pdf/usePdfMarkup";
import { useActivityStore } from "../../stores/activity";
import { useSettingsStore } from "../../stores/settings";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { EMPTY_LAYER, addMark } from "../../../mobile-web/src/markup/layer";

const PATH = "/home/u/paper/figure.png";
const SIZE: [number, number] = [1600, 900];
const STROKE = { kind: "ink" as const, color: "red" as const, width: 4, points: [[10, 10, 0.5], [400, 300, 0.5]] as [number, number, number][] };
const LAYER = addMark(EMPTY_LAYER, 1, SIZE, STROKE);
const IMAGE = document.createElement("img");

function Harness() {
  const markup = usePdfMarkup({
    projectId: "p1",
    scope: "p1",
    path: PATH,
    active: true,
    visible: true,
    pageCount: 1,
    docSize: 9_000,
    docVersion: 0,
    picture: IMAGE,
  });
  return <PdfMarkupBar markup={markup} page={1} onReload={() => {}} onDone={() => {}} picture />;
}

const submitButton = () => screen.getByRole("button", { name: "Submit" }) as HTMLButtonElement;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "file_mtime") return 1_790_000_000;
    if (command === "pdf_markup_submit") return { prompt: "Look at the marked picture.", marked: null, mode: "list", noUndo: "not_pdf" };
    return null;
  });
  mocks.queuePromptForTab.mockReset();
  mocks.queuePromptForTab.mockResolvedValue({ pruned: 0, id: "sched-1" });
  mocks.holdPhonePrompt.mockReset();
  mocks.composedPng.mockClear();
  mocks.loadLayer.mockReset();
  mocks.loadLayer.mockResolvedValue({ layer: LAYER, fingerprint: { size: 9_000, modified: 1_790_000_000 }, saved: 1 });
  mocks.saveLayer.mockClear();
  useTabsStore.setState({ tabsByScope: { p1: [{ key: "t1", label: "Claude", cmd: "claude", cwd: "/home/u/paper", kind: "agent", scheduleTargetId: "s1" } as TabEntry] } });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: {} });
  useSettingsStore.setState({ settings: null });
});
afterEach(() => cleanup());

describe("desktop picture Mark up", () => {
  it("sends the marks alone and the picture with them drawn on", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(mocks.holdPhonePrompt).toHaveBeenCalledWith("sched-1"));
    const call = mocks.invoke.mock.calls.find(([command]) => command === "pdf_markup_submit")!;
    expect(call[1].pages).toEqual([{ n: 1, size: SIZE, marks: [STROKE], layerPng: btoa("layer") }]);
    expect(call[1].picturePng).toBe(btoa("composed"));
    expect(mocks.composedPng).toHaveBeenCalledWith(IMAGE, LAYER.pages[1]);
    expect(mocks.queuePromptForTab).toHaveBeenCalledWith("p1", "s1", "Look at the marked picture.");
    // A picture gets no undo, and the strip says why.
    expect(await screen.findByText(/only a PDF gets an undo/)).toBeTruthy();
  });

  it("offers no Clear page and finds no words for the text marks", async () => {
    render(<Harness />);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: /Clear page/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Clear all/ })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Mark text" }));
    expect(await screen.findByText("No text on this page — draw instead")).toBeTruthy();
  });
});
