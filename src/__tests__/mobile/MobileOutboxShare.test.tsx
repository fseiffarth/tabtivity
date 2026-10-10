/**
 * Sharing what the agent sent — to Signal, WhatsApp, anything on the phone's
 * share sheet — straight from a gallery tile, and from the full-screen viewer.
 *
 * The viewer's Share used to appear only once the whole file had come over
 * the radio and the browser had accepted it as sent, with the sidecar's
 * `text/plain; charset=utf-8` and whatever extension it had: on a phone it
 * mostly never appeared. The button now stands from the first frame, decided
 * by name and type alone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";
import { shareAs } from "../../../mobile-web/src/outboxShare";

/** Chrome on Android: a short list of extensions, and a bare media type. */
const CHROME = /\.(png|jpe?g|gif|webp|pdf|txt|csv)$/i;
const chromeCanShare = vi.fn(({ files }: { files: File[] }) =>
  files.every((file) => CHROME.test(file.name) && !file.type.includes(";")));

const PLOT = { name: "plot.png", kind: "image/png", size: 4, modified: 1_770_000_000 };
const NOTES = { name: "notes.md", kind: "text/plain; charset=utf-8", size: 5, modified: 1_769_999_000 };
const ARCHIVE = { name: "data.zip", kind: "application/octet-stream", size: 4, modified: 1_769_998_000 };

function host(files: unknown[], bytes: (url: string) => Promise<Response> = async () => new Response(new Uint8Array([1, 2, 3, 4]))) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files }), { status: 200 });
    if (url.startsWith("/api/v1/projects/p1/outbox/")) return bytes(url);
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [],
    }), { status: 200 });
  });
}

async function openGallery(count: number) {
  fireEvent.click(await screen.findByRole("button", { name: "Project menu" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: `Files from the agent (${count})` }));
  return screen.getByRole("dialog", { name: "Files from the agent" });
}

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });
const shared = (share: ReturnType<typeof vi.fn>, call = 0) =>
  (share.mock.calls[call] as unknown as [{ files: File[] }])[0].files[0];

describe("Mobile outbox — sharing a file", () => {
  let share: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: chromeCanShare });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("shares by name and bare type, and a refused text extension as .txt", () => {
    expect(shareAs(PLOT)).toEqual({ name: "plot.png", type: "image/png" });
    expect(shareAs(NOTES)).toEqual({ name: "notes.md.txt", type: "text/plain" });
    expect(shareAs({ ...NOTES, name: "notes.txt" })).toEqual({ name: "notes.txt", type: "text/plain" });
    // Nothing the share sheet would take: no button, Save stays.
    expect(shareAs(ARCHIVE)).toBeNull();
    Reflect.deleteProperty(navigator, "share");
    expect(shareAs(PLOT)).toBeNull();
  });

  it("shares a picture straight from its tile", async () => {
    const fetch = host([PLOT, ARCHIVE]);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(2);
    // Offered only where the share sheet takes the file.
    expect(within(gallery).queryByRole("button", { name: "Share data.zip" })).toBeNull();
    expect(within(gallery).getByRole("link", { name: "Save data.zip" })).toBeTruthy();

    fireEvent.click(within(gallery).getByRole("button", { name: "Share plot.png" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const file = shared(share);
    expect(file.name).toBe("plot.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/outbox/plot.png");
  });

  it("asks for a second tap when the download outlived the first, and shares the held bytes", async () => {
    const fetch = host([PLOT]);
    vi.stubGlobal("fetch", fetch);
    share.mockImplementationOnce(() => Promise.reject(new DOMException("stale", "NotAllowedError")));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Share plot.png" }));
    const again = await within(gallery).findByRole("button", { name: "Share plot.png now" });
    expect(again.textContent).toContain("Share now");
    expect(within(gallery).queryByRole("alert")).toBeNull();

    fireEvent.click(again);
    await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
    expect(shared(share, 1).name).toBe("plot.png");
    // The bytes came over once.
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/projects/p1/outbox/plot.png")).toHaveLength(1);
    await waitFor(() => expect(within(gallery).getByRole("button", { name: "Share plot.png" })).toBeTruthy());
  });

  it("says so when the held bytes are refused too, or cannot be read", async () => {
    vi.stubGlobal("fetch", host([PLOT, { ...PLOT, name: "gone.png" }], async (url) =>
      url.endsWith("/gone.png") ? new Response("", { status: 404 }) : new Response(new Uint8Array([1]))));
    share.mockImplementation(() => Promise.reject(new DOMException("no", "NotAllowedError")));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(2);
    fireEvent.click(within(gallery).getByRole("button", { name: "Share plot.png" }));
    fireEvent.click(await within(gallery).findByRole("button", { name: "Share plot.png now" }));
    // Nothing was waited for this time: the refusal is a real one.
    expect((await within(gallery).findByRole("alert")).textContent).toContain("could not be shared");

    fireEvent.click(within(gallery).getByRole("button", { name: "Share gone.png" }));
    await waitFor(() => expect(within(gallery).getAllByRole("alert")).toHaveLength(1));
    expect(within(gallery).getByRole("alert").closest(".outbox-entry")?.textContent).toContain("gone.png");
  });

  it("takes closing the share sheet as no answer, not a failure", async () => {
    vi.stubGlobal("fetch", host([PLOT]));
    share.mockImplementationOnce(() => Promise.reject(new DOMException("closed", "AbortError")));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Share plot.png" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await settle();
    expect(within(gallery).queryByRole("alert")).toBeNull();
    expect(within(gallery).getByRole("button", { name: "Share plot.png" })).toBeTruthy();
  });

  it("stands in the full-screen viewer before the bytes have arrived", async () => {
    // The picture's bytes never arrive: the old viewer drew no Share at all.
    vi.stubGlobal("fetch", host([PLOT], () => new Promise<Response>(() => {})));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    expect(within(viewer).getByRole("button", { name: "Share…" })).toBeTruthy();
  });

  it("shares a Markdown file from the viewer as .txt, which the share sheet takes", async () => {
    vi.stubGlobal("fetch", host([NOTES], async () => new Response("# hi\n")));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Open notes.md" }));
    const viewer = screen.getByRole("dialog", { name: "notes.md" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Share…" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(shared(share).name).toBe("notes.md.txt");
    expect(shared(share).type).toBe("text/plain");
  });
});
