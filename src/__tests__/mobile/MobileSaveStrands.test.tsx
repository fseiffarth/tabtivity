/**
 * Save in the installed app on an iPhone or iPad. A download there (an
 * `<a download>`) covers the app with the file, a PDF most of all, and leaves
 * no way back. So there Save is not a link: the share sheet's Save or share…
 * (its Save to Files) keeps the file, and a file tile opens the viewer instead
 * of downloading. A browser tab keeps its plain Save link.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../mobile-web/src/markup/store", async (original) => ({
  ...(await original<typeof import("../../../mobile-web/src/markup/store")>()),
  loadLayer: vi.fn(async () => null),
  saveLayer: vi.fn(async () => true),
}));

import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";
import { OutboxGrid } from "../../../mobile-web/src/components/OutboxGrid";

const ZIP = { name: "data.zip", kind: "application/zip", size: 9_000, modified: 1_790_000_000 };
const PDF = { name: "paper.pdf", kind: "application/pdf", size: 9_000, modified: 1_790_000_000 };

let share: ReturnType<typeof vi.fn>;
/** An iPad (a Mac's user agent that takes touches), installed or in Safari. */
function onIpad(installed: boolean) {
  share = vi.fn(async () => {});
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    maxTouchPoints: 5,
    standalone: installed,
    share,
    canShare: () => true,
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OutboxViewer · Save in the installed iPad app", () => {
  it("offers no download link, only the share sheet, which gets the file", async () => {
    onIpad(true);
    render(<OutboxViewer scope={{ tab: "t1" }} file={ZIP} onClose={() => {}} />);
    expect(screen.queryByRole("link", { name: "Save" })).toBeNull();
    const buttons = screen.getAllByRole("button", { name: "Save or share…" });
    // The head's and the no-preview card's: the same share sheet.
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect((share.mock.calls[0][0] as ShareData).files?.[0].name).toBe("data.zip");
  });

  it("gives a PDF's reader Save or share… in place of the link", async () => {
    onIpad(true);
    render(<OutboxViewer scope={{ tab: "t1" }} file={PDF} onClose={() => {}} />);
    expect(await screen.findByRole("button", { name: "Save or share…" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Share…" })).toBeNull();
  });

  it("keeps the plain Save link in Safari's own tab", () => {
    onIpad(false);
    render(<OutboxViewer scope={{ tab: "t1" }} file={ZIP} onClose={() => {}} />);
    expect(screen.getAllByRole("link", { name: "Save" })[0].getAttribute("download")).toBe("data.zip");
    expect(screen.getByRole("button", { name: "Share…" })).toBeTruthy();
  });
});

describe("OutboxGrid · Save in the installed iPad app", () => {
  it("opens a file it cannot show in the viewer, and saves through the share sheet", () => {
    onIpad(true);
    const onOpen = vi.fn();
    render(<OutboxGrid scope={{ tab: "t1" }} files={[ZIP]} onOpen={onOpen} onDetails={() => {}} />);
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open data.zip" }));
    expect(onOpen).toHaveBeenCalledWith(ZIP);
    expect(screen.getByRole("button", { name: "Save or share data.zip" })).toBeTruthy();
  });

  it("downloads it from Safari's own tab as before", () => {
    onIpad(false);
    render(<OutboxGrid scope={{ tab: "t1" }} files={[ZIP]} onOpen={() => {}} onDetails={() => {}} />);
    expect(screen.getByRole("link", { name: "Open data.zip" }).getAttribute("download")).toBe("data.zip");
    expect(screen.getByRole("link", { name: "Save data.zip" })).toBeTruthy();
  });
});
