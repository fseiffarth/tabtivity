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
import { MAX_SHARE_MANY, shareAs, shareSize, sizeOfMany, useOutboxShare, useShareMany } from "../../../mobile-web/src/outboxShare";
import { ShareSizeSheet } from "../../../mobile-web/src/components/ShareSizeSheet";
import { MAX_VIEW_FILE, type OutboxFile, type ViewerScope } from "../../../mobile-web/src/api";

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
    // Any other refused file goes as .txt, bytes unchanged (a binary STL).
    expect(shareAs(ARCHIVE)).toEqual({ name: "data.zip.txt", type: "text/plain" });
    expect(shareAs({ ...ARCHIVE, name: "part.stl" })).toEqual({ name: "part.stl.txt", type: "text/plain" });
    // Nothing the share sheet would take, not even as .txt: no button, Save stays.
    chromeCanShare.mockReturnValueOnce(false).mockReturnValueOnce(false);
    expect(shareAs(ARCHIVE)).toBeNull();
    Reflect.deleteProperty(navigator, "share");
    expect(shareAs(PLOT)).toBeNull();
  });

  it("shares a picture straight from its tile", async () => {
    const fetch = host([PLOT, ARCHIVE]);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(2);
    // A refused kind is still offered (as data.zip.txt), and Save stays.
    expect(within(gallery).getByRole("button", { name: "Share data.zip" })).toBeTruthy();
    expect(within(gallery).getByRole("link", { name: "Save data.zip" })).toBeTruthy();

    fireEvent.click(within(gallery).getByRole("button", { name: "Share plot.png" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    const file = shared(share);
    expect(file.name).toBe("plot.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(4);
    expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/outbox/plot.png?v=1770000000-4");
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
    expect(fetch.mock.calls.filter(([url]) => String(url) === "/api/v1/projects/p1/outbox/plot.png?v=1770000000-4")).toHaveLength(1);
    await waitFor(() => expect(within(gallery).getByRole("button", { name: "Share plot.png" })).toBeTruthy());
  });

  it("says so when the held bytes are refused too, or cannot be read", async () => {
    vi.stubGlobal("fetch", host([PLOT, { ...PLOT, name: "gone.png" }], async (url) =>
      url.includes("/gone.png?") ? new Response("", { status: 404 }) : new Response(new Uint8Array([1]))));
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

  it("lets the shown picture load before the Share bytes, and says so while it does or when it fails", async () => {
    const fetch = host([PLOT]);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    const picture = () => viewer.querySelector(".outbox-viewer-stage img")!;
    const reads = () => fetch.mock.calls.filter(([url]) => String(url).startsWith("/api/v1/projects/p1/outbox/plot.png")).length;
    await settle();
    // Nothing competes with the picture on screen for the radio.
    expect(within(viewer).getByRole("status").textContent).toBe("Loading…");
    expect(reads()).toBe(0);

    fireEvent.error(picture());
    expect(within(viewer).getByRole("alert").textContent).toContain("could not be loaded");
    fireEvent.click(within(viewer).getByRole("button", { name: "Retry" }));
    expect(within(viewer).getByRole("status")).toBeTruthy();

    fireEvent.load(picture());
    expect(within(viewer).queryByRole("status")).toBeNull();
    expect(within(viewer).queryByRole("alert")).toBeNull();
    await waitFor(() => expect(reads()).toBe(1));
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

  describe("past the share limit", () => {
    const MB = 1024 * 1024;
    const PART = { name: "part.stl", kind: "application/octet-stream", size: 180 * MB, modified: 1_770_000_100 };
    const HERE: ViewerScope = { files: "p1" };

    function One({ file, scope = HERE }: { file: OutboxFile; scope?: ViewerScope }) {
      const sharing = useOutboxShare(scope);
      return <>
        <button onClick={() => void sharing.share(file)}>go</button>
        {sharing.ready && <button onClick={() => void sharing.share(file)}>again</button>}
        <ShareSizeSheet files={sharing.asking} onShare={sharing.confirm} onClose={sharing.cancel} />
      </>;
    }

    function Many({ files }: { files: OutboxFile[] }) {
      const sharing = useShareMany(HERE);
      return <>
        <button onClick={() => void sharing.share(files)}>go</button>
        <ShareSizeSheet files={sharing.asking} onShare={sharing.confirm} onClose={sharing.cancel} />
      </>;
    }

    it("goes at once under the limit, asks past it, and cannot go where no whole bytes come", () => {
      expect(shareSize(HERE, MAX_VIEW_FILE)).toBe("ok");
      expect(shareSize(HERE, MAX_VIEW_FILE + 1)).toBe("ask");
      // A remote host, a drop box and the outbox hand over at most the limit whole.
      expect(shareSize({ files: "p1", on: "host" }, MAX_VIEW_FILE + 1)).toBeNull();
      expect(shareSize({ inbox: "t1" }, MAX_VIEW_FILE + 1)).toBeNull();
      const small = { ...PART, size: MB };
      expect(sizeOfMany(HERE, [small, small])).toBe("ok");
      expect(sizeOfMany(HERE, [small, PART])).toBe("ask");
      expect(sizeOfMany(HERE, [{ ...small, size: MAX_SHARE_MANY / 2 + 1 }, { ...small, size: MAX_SHARE_MANY / 2 }])).toBe("ask");
      expect(sizeOfMany({ files: "p1", on: "host" }, [small, PART])).toBeNull();
    });

    it("asks before fetching a big file, shares it as it is on yes, and fetches nothing on no", async () => {
      const fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3])));
      vi.stubGlobal("fetch", fetch);
      render(<One file={PART} />);

      fireEvent.click(screen.getByRole("button", { name: "go" }));
      const ask = screen.getByRole("dialog", { name: "Share part.stl (180.0 MB)?" });
      expect(ask.textContent).toContain("memory");
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.click(within(ask).getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(fetch).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "go" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Share anyway" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      expect(screen.queryByRole("dialog")).toBeNull();
      // No zip: the file goes under the name the share sheet takes, bytes unchanged.
      expect(shared(share).name).toBe("part.stl.txt");
      expect(shared(share).size).toBe(3);
    });

    it("does not ask again for the second tap a slow download needs", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]))));
      share.mockImplementationOnce(() => Promise.reject(new DOMException("stale", "NotAllowedError")));
      render(<One file={PART} />);

      fireEvent.click(screen.getByRole("button", { name: "go" }));
      fireEvent.click(screen.getByRole("button", { name: "Share anyway" }));
      fireEvent.click(await screen.findByRole("button", { name: "again" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("asks once for several files past the together limit", async () => {
      const fetch = vi.fn(async () => new Response(new Uint8Array([1])));
      vi.stubGlobal("fetch", fetch);
      const half = { ...PART, size: 30 * MB };
      render(<Many files={[half, { ...half, name: "lid.stl" }]} />);

      fireEvent.click(screen.getByRole("button", { name: "go" }));
      const ask = screen.getByRole("dialog", { name: "Share 2 files (60.0 MB)?" });
      expect(fetch).not.toHaveBeenCalled();
      fireEvent.click(within(ask).getByRole("button", { name: "Share anyway" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const files = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files;
      expect(files.map((file) => file.name)).toEqual(["part.stl.txt", "lid.stl.txt"]);
    });
  });
});
