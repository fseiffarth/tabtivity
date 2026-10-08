/**
 * Tests for the animated-GIF viewer (#gifviewer): the REAL decoder runs over a
 * hand-built two-frame GIF served through the mocked `read_file_bytes`, and the
 * transport (frame counter, play/pause, stepping) drives a stubbed canvas
 * context (jsdom has none). Auto-reload parity with the image viewer (#68) is
 * covered by the mtime-advance case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor, fireEvent, screen } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("../../stores/windows", () => ({
  useWindowsStore: { getState: () => ({ openFile: () => Promise.resolve() }) },
}));
vi.mock("../../stores/settings", () => ({
  useSettingsStore: (sel: (s: unknown) => unknown) =>
    sel({ settings: { viewer_prefs: {} } }),
}));

// A real 1×1 two-frame GIF89a (2-entry palette: red, green), each frame with an
// authored 10s delay so autoplay can't advance mid-assertion. Byte-for-byte:
// header + LSD + GCT, then per frame a GCE (delay 1000 hundredths) + descriptor
// + a literal LZW stream (clear, index, EOI), then the trailer.
// prettier-ignore
const TWO_FRAME_GIF = [
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61,             // "GIF89a"
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,       // 1×1, global color table (2)
  0xff, 0x00, 0x00,  0x00, 0xff, 0x00,            // palette: red, green
  0x21, 0xf9, 0x04, 0x00, 0xe8, 0x03, 0x00, 0x00, // GCE: delay 1000 (10 s)
  0x2c, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00, // frame 1 descriptor
  0x02, 0x02, 0x44, 0x01, 0x00,                   // LZW: clear, 0, EOI
  0x21, 0xf9, 0x04, 0x00, 0xe8, 0x03, 0x00, 0x00, // GCE: delay 1000 (10 s)
  0x2c, 0, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x00, // frame 2 descriptor
  0x02, 0x02, 0x4c, 0x01, 0x00,                   // LZW: clear, 1, EOI
  0x3b,                                           // trailer
];

let diskMtime = 1000;

function countReadBytes() {
  return mockInvoke.mock.calls.filter((c) => c[0] === "read_file_bytes").length;
}

const putImageData = vi.fn();

async function renderGifView() {
  vi.resetModules();
  const { FileViewerPane } = await import("../../components/embed/FileViewerPane");
  await act(async () => {
    render(<FileViewerPane viewer="gif" path="/p/anim.gif" projectId="proj" />);
  });
}

describe("GifView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diskMtime = 1000;
    // jsdom has no canvas backend: getContext returns null and would leave the
    // draw effect dead. A putImageData spy is all the viewer itself needs, but
    // this prototype override is global, so it also answers every canvas the
    // FileViewerPane chrome mounts alongside it — including PresentationOverlay's
    // marker/laser canvases, which need a full no-op 2D context or they throw.
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () =>
        ({
          putImageData,
          clearRect: vi.fn(),
          save: vi.fn(),
          restore: vi.fn(),
          beginPath: vi.fn(),
          moveTo: vi.fn(),
          lineTo: vi.fn(),
          arc: vi.fn(),
          stroke: vi.fn(),
          fill: vi.fn(),
        }) as unknown as CanvasRenderingContext2D,
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    // This jsdom build exposes no ImageData global; the viewer only ever hands
    // it to the (stubbed) putImageData, so a data/width/height shell suffices.
    globalThis.ImageData ??= class {
      constructor(
        public data: Uint8ClampedArray,
        public width: number,
        public height: number,
      ) {}
    } as unknown as typeof ImageData;
    // jsdom may lack rAF depending on visual pretence; the playback loop only
    // needs it to exist (the 10 s frame delay keeps it from ever advancing).
    globalThis.requestAnimationFrame ??= (cb) =>
      setTimeout(() => cb(performance.now()), 16) as unknown as number;
    globalThis.cancelAnimationFrame ??= (id) => clearTimeout(id);
    globalThis.URL.createObjectURL ??= vi.fn(() => "blob:mock");
    globalThis.URL.revokeObjectURL ??= vi.fn();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_bytes") return Promise.resolve([...TWO_FRAME_GIF]);
      if (cmd === "file_mtime") return Promise.resolve(diskMtime);
      return Promise.resolve(null);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("decodes the frames, autoplays, and steps/pauses via the transport", async () => {
    await renderGifView();

    // The real decoder ran over the mock bytes: 2 frames, frame 1 on screen.
    await waitFor(() => expect(screen.getByText(/1 \/ 2/)).toBeTruthy());
    // The draw is a passive effect after the commit that shows the counter; the
    // viewer is a lazily split chunk now (perf plan §6), so under a loaded test
    // run that effect can land a beat after the text — wait for it too.
    await waitFor(() => expect(putImageData).toHaveBeenCalled());
    const draws = putImageData.mock.calls.length;

    // Autoplay is on (matches the old <img> behavior), so the toggle says Pause.
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();

    // Stepping pauses and advances the counter + redraws the canvas.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Next frame" }));
    });
    expect(screen.getByText(/2 \/ 2/)).toBeTruthy();
    expect(putImageData.mock.calls.length).toBeGreaterThan(draws);
    expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();

    // Prev wraps back to frame 1.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Previous frame" }));
    });
    expect(screen.getByText(/1 \/ 2/)).toBeTruthy();

    // The readout shows the authored 10 s delay verbatim (≥20ms is honored).
    expect(screen.getByText(/10000 ms/)).toBeTruthy();
  });

  it("re-reads and re-decodes when the file's mtime advances on disk (#68)", async () => {
    await renderGifView();
    await waitFor(() => expect(countReadBytes()).toBe(1));

    diskMtime = 2000;
    await waitFor(() => expect(countReadBytes()).toBe(2), { timeout: 12000 });

    // No further change → no further read.
    await new Promise((r) => setTimeout(r, 1800));
    expect(countReadBytes()).toBe(2);
  });

  it("degrades to native <img> playback when the bytes aren't a decodable GIF", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "read_file_bytes") return Promise.resolve([1, 2, 3, 4, 5, 6, 7, 8]);
      if (cmd === "file_mtime") return Promise.resolve(diskMtime);
      return Promise.resolve(null);
    });
    await renderGifView();
    await waitFor(() => expect(screen.getByText(/native playback/)).toBeTruthy());
    // The fallback <img> is up; the transport is not.
    expect(document.querySelector(".gif-fallback img")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next frame" })).toBeNull();
  });
});
