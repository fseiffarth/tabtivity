/**
 * A file keeps the name it was sent under. Every send stamps its leaf
 * (`YYYYMMDD-HHMMSS-`) to keep it unique, and a photo the phone sent that an
 * agent sends back carries two: the gallery showed, saved and shared
 * `20260930-101530-20260930-101010-IMG_4711.jpg`. The desktop now lists the
 * stamp-free `original`; the stamped leaf stays what the phone fetches by.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";
import { sentName } from "../../../mobile-web/src/api";
import { shareAs } from "../../../mobile-web/src/outboxShare";

const LEAF = "20260930-101530-20260930-101010-IMG_4711.jpg";
const PHOTO = { name: LEAF, original: "IMG_4711.jpg", kind: "image/jpeg", size: 4, modified: 1_770_000_000 };

function host(files: unknown[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files }), { status: 200 });
    if (url.startsWith("/api/v1/projects/p1/outbox/")) return new Response(new Uint8Array([1, 2, 3, 4]));
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [],
    }), { status: 200 });
  });
}

describe("Mobile outbox — the name a file was sent under", () => {
  let share: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "canShare");
    Reflect.deleteProperty(navigator, "share");
  });

  it("falls back to the leaf when the desktop sent no original", () => {
    expect(sentName(PHOTO)).toBe("IMG_4711.jpg");
    expect(sentName({ ...PHOTO, original: undefined })).toBe(LEAF);
    expect(shareAs(PHOTO)).toEqual({ name: "IMG_4711.jpg", type: "image/jpeg" });
  });

  it("shows, saves and shares the original, and still fetches by the leaf", async () => {
    const fetch = host([PHOTO]);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Files from the agent (1)" }));
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    expect(gallery.textContent).toContain("IMG_4711.jpg");
    expect(gallery.textContent).not.toContain("20260930");
    const save = within(gallery).getByRole("link", { name: "Save IMG_4711.jpg" });
    expect(save.getAttribute("download")).toBe("IMG_4711.jpg");
    expect(save.getAttribute("href")).toBe(`/api/v1/projects/p1/outbox/${LEAF}?download=1`);

    fireEvent.click(within(gallery).getByRole("button", { name: "Share IMG_4711.jpg" }));
    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect((share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0].name).toBe("IMG_4711.jpg");
    expect(fetch).toHaveBeenCalledWith(`/api/v1/projects/p1/outbox/${LEAF}`);
  });
});
