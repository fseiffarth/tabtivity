/**
 * DOM regression test for the vertical caret drift ("caret ends up a line below
 * the coloured text further down the file").
 *
 * `NativeEditorCaret.test.ts` proves the `snapToDevicePx` MATH is correct; this
 * test proves the editor actually APPLIES it — i.e. the rendered
 * `--code-line-height` custom property (which both the <textarea> and the glyph
 * <pre> layers read) lands on a whole number of device pixels under a fractional
 * display scale. If a future edit computes the line-height without snapping, the
 * variable falls off the device grid and this fails, instead of the caret
 * silently drifting again in the running app.
 *
 * jsdom has no layout engine and doesn't apply external CSS, so we can only read
 * the inline custom property — but that variable IS the single knob both layers
 * share, so asserting it is snapped guards the whole alignment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { warmFileViewer } from "../helpers/warmViewer";
import { render, screen, act, waitFor } from "@testing-library/react";
import { snapToDevicePx } from "../../components/embed/fileViewer/caretMirror";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));

const { prefsRef } = vi.hoisted(() => ({
  prefsRef: { current: {} as Record<string, { font_size?: number }> },
}));
vi.mock("../../stores/settings", () => {
  const state = () => ({
    settings: { autosave: false, viewer_prefs: prefsRef.current },
    updateSettings: vi.fn(),
  });
  const hook = (sel: (s: unknown) => unknown) => sel(state());
  (hook as unknown as { getState: typeof state }).getState = state;
  return { useSettingsStore: hook };
});

type Tab = { key: string; kind?: string; viewerState?: Record<string, unknown> };
const { tabsRef } = vi.hoisted(() => ({ tabsRef: { current: [] as Tab[] } }));
vi.mock("../../stores/tabs", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const state = () => ({
    tabs: tabsRef.current,
    setActive: vi.fn(),
    setViewerState: vi.fn(),
  });
  const hook = (sel?: (s: unknown) => unknown) => (sel ? sel(state()) : state());
  (hook as unknown as { getState: typeof state }).getState = state;
  return { ...actual, useTabsStore: hook };
});

const SOURCE = "line one\nline two\nline three\n";
const TAB_KEY = "t1";

function setDpr(dpr: number) {
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    value: dpr,
  });
}

async function renderTextViewAt(fontSize: number, dpr: number) {
  prefsRef.current = { text: { font_size: fontSize } };
  setDpr(dpr);
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="text" path="/p/notes.txt" projectId="proj" tabKey={TAB_KEY} />);
  });
  await waitFor(() =>
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(SOURCE),
  );
  return document.querySelector(".file-viewer-code") as HTMLElement;
}

const lineHeightPx = (code: HTMLElement) =>
  parseFloat(code.style.getPropertyValue("--code-line-height"));

warmFileViewer();

describe("editor line-height is snapped to the device-pixel grid", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabsRef.current = [{ key: TAB_KEY, kind: "embed", viewerState: {} }];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_text") return Promise.resolve(SOURCE);
      if (cmd === "file_mtime") return Promise.resolve(1000);
      return Promise.resolve(null);
    });
  });
  afterEach(() => setDpr(1));

  it("lands the rendered line-height on whole device pixels under a fractional scale", async () => {
    // fontSize 14 → raw line-height round(14·1.5)=21; at 150% scale 21·1.5=31.5 is
    // OFF the device grid, so the editor must snap it (→ 32/1.5 = 21.333px).
    const dpr = 1.5;
    const raw = Math.round(14 * 1.5); // 21
    const code = await renderTextViewAt(14, dpr);
    const px = lineHeightPx(code);

    // It landed on the grid …
    expect(Math.abs(px * dpr - Math.round(px * dpr))).toBeLessThan(1e-6);
    // … at the RIGHT grid line (the snap of the raw height, not some other row) …
    expect(px).toBeCloseTo(snapToDevicePx(raw, dpr), 6);
    expect(Math.round(px * dpr)).toBe(Math.round(raw * dpr)); // 32 device px
    // … and it genuinely moved off the un-snapped value (proves snapping ran).
    expect(px).not.toBe(raw);
    // Font-size still tracks the chosen size, so the two layers scale together.
    expect(code.style.getPropertyValue("--code-font-size")).toBe("14px");
  });

  it("is a no-op at an integer scale (line-height stays the raw value)", async () => {
    const code = await renderTextViewAt(16, 2);
    // 16 → 24; 24·2 = 48 already whole, so no correction.
    expect(lineHeightPx(code)).toBe(24);
  });
});
