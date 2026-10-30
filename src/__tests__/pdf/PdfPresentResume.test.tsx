/**
 * The present window's half of the curtain's Back to fullscreen
 * (`lib/viewers/pdfPresent`): reopened with a resume it seeds itself and asks no
 * tab, because a tab's answer would be its own older page; an ordinary open still
 * asks; and it keeps its record current as the sheet turns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const emit = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@tauri-apps/api/event", () => ({
  emit: (...a: unknown[]) => emit(...a),
  listen: vi.fn(async () => () => {}),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({
  availableMonitors: async () => [],
  getCurrentWindow: () => ({
    isFullscreen: async () => true,
    setFullscreen: async () => {},
    onResized: async () => () => {},
    destroy: async () => {},
  }),
}));
vi.mock("../../lib/files/fileAccess", () => ({
  fileMtime: async () => 1,
  readFileBytes: async () => new Uint8Array(1),
}));
vi.mock("../../lib/viewers/pdfLoad", () => ({
  loadPdf: async () => ({
    numPages: 9,
    loadingTask: { destroy: () => {} },
    getPage: async () => null,
  }),
}));
vi.mock("../../lib/useDiskReloadPoll", () => ({ useDiskReloadPoll: () => {} }));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: Object.assign(
    (select: (s: { load: () => Promise<void> }) => unknown) => select({ load: async () => {} }),
    { getState: () => ({ settings: null }) },
  ),
}));
vi.mock("../../hooks/useCrossWindowAppearance", () => ({ useCrossWindowAppearance: () => {} }));

import { PdfPresentApp } from "../../components/embed/pdf/PdfPresentApp";
import {
  PDF_PRESENT_READY,
  pdfPresentLabel,
  readLastPresent,
  writeLastPresent,
} from "../../lib/viewers/pdfPresent";

const last = { path: "/p/talk.pdf", scope: "p", page: 7 };
const label = pdfPresentLabel(last.path);
const asked = () => emit.mock.calls.filter(([event]) => event === PDF_PRESENT_READY);

beforeEach(() => {
  localStorage.clear();
  emit.mockClear();
});

afterEach(cleanup);

describe("<PdfPresentApp /> reopened from the curtain", () => {
  it("seeds itself on the sheet it was left on and asks no tab", async () => {
    writeLastPresent({ ...last, resume: true });
    render(<PdfPresentApp label={label} />);
    await act(async () => {});
    expect(asked()).toEqual([]);
    expect(readLastPresent()).toEqual({ ...last, resume: false });
  });

  it("keeps the record on the sheet as it turns", async () => {
    writeLastPresent({ ...last, resume: true });
    render(<PdfPresentApp label={label} />);
    await act(async () => {});
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(readLastPresent()?.page).toBe(8);
  });

  it("asks as ever when nothing was left for this window", async () => {
    writeLastPresent(last);
    render(<PdfPresentApp label={label} />);
    await act(async () => {});
    expect(asked()).toEqual([[PDF_PRESENT_READY, { label }]]);
  });
});
