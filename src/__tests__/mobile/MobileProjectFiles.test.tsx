/**
 * The project screen's read-only file browser (#31bo, `ProjectFiles`): a drawer
 * a left→right swipe opens while the desktop's "Project files on the phone" switch is on,
 * folders walked by the sealed tokens the sidecar hands out — never a path —
 * and files opened in the outbox's viewer, fetched by their token.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";
import { storageKey } from "../../../src/lib/brand";

const ROOT = {
  entries: [
    { token: "tok-build", name: "build", kind: "dir", size: 0, modified: 1_770_000_000, ignored: true },
    { token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 },
    { token: "tok-agents", name: "AGENTS.md", kind: "text/plain; charset=utf-8", size: 20, modified: 1_770_000_000 },
    { token: "tok-notes", name: "notes.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000, created: 1_760_000_000 },
    { token: "tok-plot", name: "plot.png", kind: "image/png", size: 48_000, modified: 1_770_000_000 },
    { token: "tok-paper", name: "paper.pdf", kind: "application/pdf", size: 90_000, modified: 1_770_000_000 },
    { token: "tok-readme", name: "README.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000 },
    { token: "tok-log", name: "run.log", kind: "text/plain; charset=utf-8", size: 3, modified: 1_770_000_000, ignored: true },
  ],
  truncated: false,
};
const SRC = {
  entries: [
    { token: "tok-main", name: "main.rs", kind: "text/plain; charset=utf-8", size: 13, modified: 1_770_000_000 },
    // Only the project root has a scaffold: a README deeper down is a file.
    { token: "tok-sub-readme", name: "README.md", kind: "text/plain; charset=utf-8", size: 4, modified: 1_770_000_000 },
  ],
  truncated: false,
};

function hostWith(files: boolean, tickets = true) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // A mobile host from before the ticket route: the router knows the path
    // only as a static GET, so the POST is 405 with no body.
    if (url === "/api/v1/open-ticket" && !tickets) return new Response(null, { status: 405 });
    if (url === "/api/v1/open-ticket") {
      const { url: target } = JSON.parse(String(init?.body)) as { url: string };
      return new Response(JSON.stringify({ url: `${target}&ticket=t1` }), { status: 200 });
    }
    if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (url === "/api/v1/projects/p1/files") return new Response(JSON.stringify(ROOT), { status: 200 });
    if (url === "/api/v1/projects/p1/files?dir=tok-src") return new Response(JSON.stringify(SRC), { status: 200 });
    if (url === "/api/v1/projects/p1/files/raw?f=tok-notes") return new Response("# Hello\n", { status: 200 });
    if (url === "/api/v1/projects/p1/files/raw?f=tok-main") return new Response("fn main() {}\n", { status: 200 });
    if (url === "/api/v1/projects/p1/files/search?q=main") return new Response(JSON.stringify({
      hits: [{ ...SRC.entries[0], trail: [{ token: "tok-src", name: "src" }] }], truncated: false,
    }), { status: 200 });
    if (url === "/api/v1/projects/p1/files/search?q=src") return new Response(JSON.stringify({
      hits: [{ ...ROOT.entries[1], trail: [] }], truncated: false,
    }), { status: 200 });
    if (url.startsWith("/api/v1/projects/p1/files/search")) return new Response(JSON.stringify({ hits: [], truncated: false }), { status: 200 });
    if (url.startsWith("/api/v1/projects/p1/files")) return new Response(JSON.stringify({ error: "file_not_found" }), { status: 404 });
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [],
      files,
    }), { status: 200 });
  });
}

/** A one-finger flick from `from` to `to`, dispatched the way `focusSwipe`
 * listens: touch pointer events where the engine has them, touch events
 * otherwise. */
function swipe(target: Element, from: number, to: number) {
  act(() => {
    if ("PointerEvent" in window) {
      const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 7, isPrimary: true, clientY: 300 };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to }));
    } else {
      const touchEvent = (type: string, clientX: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touch = { identifier: 7, target, clientX, clientY: 300 };
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [touch] });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        return event;
      };
      target.dispatchEvent(touchEvent("touchstart", from));
      target.dispatchEvent(touchEvent("touchend", to));
    }
  });
}

describe("Mobile project — read-only file browser", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens nothing on a swipe while the desktop's switch is off", async () => {
    const fetch = hostWith(false);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1", expect.anything()));
    swipe(await screen.findByRole("heading", { name: "Alpha" }), 100, 300);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files"))).toBe(false);
  });

  it("finds files and folders by name and moves the drawer to a hit's folder", async () => {
    const fetch = hostWith(true);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    const box = within(sheet).getByRole("searchbox", { name: "Search the project's files" });

    // A hit names its folder; the trail steps aside while searching.
    fireEvent.change(box, { target: { value: "  main " } });
    const hit = await within(sheet).findByRole("button", { name: "Open main.rs" });
    expect(hit.querySelector(".files-hit-place")?.textContent).toBe("src");
    expect(within(sheet).queryByRole("navigation", { name: "Folders" })).toBeNull();
    expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/search?q=main", expect.anything());

    // A file hit opens in the viewer; closed, the results are still there and
    // the drawer stands in the file's folder.
    fireEvent.click(hit);
    const viewer = await screen.findByRole("dialog", { name: "main.rs" });
    await within(viewer).findByText("fn main() {}");
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    await within(screen.getByRole("dialog", { name: "Files" })).findByRole("button", { name: "Open main.rs" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "" } });
    const trail = await screen.findByRole("navigation", { name: "Folders" });
    expect(within(trail).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Alpha", "src"]);

    // A folder hit at the root is walked into, and the search ends there.
    fireEvent.click(within(trail).getByRole("button", { name: "Alpha" }));
    await screen.findByRole("button", { name: "Open notes.md" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "src" } });
    const folder = await screen.findByRole("button", { name: "Open the folder src" });
    expect(folder.querySelector(".files-hit-place")?.textContent).toBe("Project folder");
    fireEvent.click(folder);
    await screen.findByRole("button", { name: "Open main.rs" });
    expect((screen.getByRole("searchbox", { name: "Search the project's files" }) as HTMLInputElement).value).toBe("");
    expect(within(screen.getByRole("navigation", { name: "Folders" })).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Alpha", "src"]);

    // Nothing named so: one line says it.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "zzz" } });
    await screen.findByText("No file or folder has that in its name.");
  });

  it("walks folders by token, back along the trail, and opens files by token", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    expect(sheet.textContent).toContain("Read-only");
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    // Each row's tile names its kind; the scaffold and the gitignored fold
    // shut below the rest, as on the desktop's tree.
    expect(Array.from(sheet.querySelectorAll(".option-list strong")).map((row) => row.textContent))
      .toEqual(["src", "notes.md", "plot.png", "paper.pdf"]);
    expect(Array.from(sheet.querySelectorAll(".files-icon")).map((tile) => tile.className.replace("files-icon files-icon-", "")))
      .toEqual(["dir", "text", "image", "pdf"]);
    // Each row says when it was last edited, and created where the desktop's
    // filesystem keeps a birth time (notes.md here, not the folder).
    const meta = Array.from(sheet.querySelectorAll(".option-list small")).map((row) => row.textContent ?? "");
    expect(meta[0]).toContain("Edited ");
    expect(meta[0]).not.toContain("Created");
    expect(meta[1]).toMatch(/^8 B · Created .+ · Edited .+$/);

    // Into a folder, and back by the trail's first crumb (the project's name).
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    const trail = within(sheet).getByRole("navigation", { name: "Folders" });
    expect(within(trail).getAllByRole("button").map((crumb) => crumb.textContent)).toEqual(["Alpha", "src"]);
    fireEvent.click(within(trail).getByRole("button", { name: "Alpha" }));
    await within(sheet).findByRole("button", { name: "Open notes.md" });

    // A PDF opens in the app's own page view, with Save and Share — never in
    // the phone's PDF viewer, from which the installed app is not got back to.
    fireEvent.click(within(sheet).getByRole("button", { name: "Open paper.pdf" }));
    const pdf = screen.getByRole("dialog", { name: "paper.pdf" });
    expect(within(pdf).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-paper&download=1");
    expect(within(pdf).getByTitle("pdf")).toBeTruthy();
    fireEvent.click(within(pdf).getByRole("button", { name: "Close" }));
    expect(open).not.toHaveBeenCalled();

    // A picture opens full screen, loaded by its token, with Save beside it.
    fireEvent.click(await screen.findByRole("button", { name: "Open plot.png" }));
    const viewer = screen.getByRole("dialog", { name: "plot.png" });
    expect(viewer.querySelector("img")?.getAttribute("src")).toBe("/api/v1/projects/p1/files/raw?f=tok-plot");
    expect(within(viewer).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-plot&download=1");

    // Closing the viewer comes back to the same folder; a text reads inline.
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open notes.md" }));
    const text = screen.getByRole("dialog", { name: "notes.md" });
    await waitFor(() => expect(text.querySelector("pre")?.textContent).toBe("# Hello\n"));
  });

  it("folds the root's scaffold and what git ignores into collapsed sections", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    const scaffold = await within(sheet).findByRole("button", { name: "scaffold (2)" });
    const ignored = within(sheet).getByRole("button", { name: "gitignored (2)" });
    expect([scaffold.getAttribute("aria-expanded"), ignored.getAttribute("aria-expanded")]).toEqual(["false", "false"]);
    expect(within(sheet).queryByRole("button", { name: "Open README.md" })).toBeNull();
    expect(within(sheet).queryByRole("button", { name: "Open the folder build" })).toBeNull();

    fireEvent.click(scaffold);
    expect(scaffold.getAttribute("aria-expanded")).toBe("true");
    expect(within(sheet).getByRole("button", { name: "Open AGENTS.md" })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Open run.log" })).toBeNull();

    fireEvent.click(ignored);
    expect(within(sheet).getByRole("button", { name: "Open run.log" }).closest("li")?.className).toBe("files-folded");
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder build" }));
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "scaffold (2)" })).toBeNull());

    // Below the root a README is an ordinary row.
    fireEvent.click(within(within(sheet).getByRole("navigation", { name: "Folders" })).getByRole("button", { name: "Alpha" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    expect(within(sheet).getByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /^scaffold/ })).toBeNull();
  });

  it("shares a file straight from its row, without opening it", async () => {
    const files = hostWith(true);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "/api/v1/projects/p1/files/raw?f=tok-plot" ? new Response(new Uint8Array([1, 2, 3, 4])) : files(input, init));
    vi.stubGlobal("fetch", fetch);
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    try {
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      const heading = await screen.findByRole("heading", { name: "Alpha" });
      await waitFor(() => {
        swipe(heading, 100, 300);
        expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
      });
      const sheet = screen.getByRole("dialog", { name: "Files" });
      await within(sheet).findByRole("button", { name: "Share plot.png" });
      // Every file gets one; a folder has nothing to share.
      expect(within(sheet).getAllByRole("button", { name: /^Share / }).map((button) => button.getAttribute("aria-label")))
        .toEqual(["Share notes.md", "Share plot.png", "Share paper.pdf"]);

      fireEvent.click(within(sheet).getByRole("button", { name: "Share plot.png" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(within(sheet).getByRole("button", { name: "Share plot.png" }).hasAttribute("disabled")).toBe(false));
      const sent = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
      expect([sent.name, sent.type, sent.size]).toEqual(["plot.png", "image/png", 4]);
      // The bytes came by the file's token, and no viewer opened over the list.
      expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/raw?f=tok-plot");
      expect(screen.queryByRole("dialog", { name: "plot.png" })).toBeNull();
    } finally {
      Reflect.deleteProperty(navigator, "canShare");
      Reflect.deleteProperty(navigator, "share");
    }
  });

  it("says the mobile host is outdated instead of opening a whole file it cannot ticket", async () => {
    const host = hostWith(true, false);
    // A text past what the app reads in itself, so the whole file goes out.
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => String(input) === "/api/v1/projects/p1/files"
      ? new Response(JSON.stringify({ ...ROOT, entries: ROOT.entries.map((entry) => entry.name === "notes.md" ? { ...entry, size: 9_000_000 } : entry) }), { status: 200 })
      : host(input, init)));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => {});
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Open the whole file" }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith(expect.stringContaining("Reconnect")));
    expect(open).not.toHaveBeenCalled();
  });

  it("opens from the screen's left edge, where a drawer is pulled from", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 4, 200);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
  });

  it("opens from the dropdown under the project's name too", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Project menu" })).getByRole("menuitem", { name: "Project files" }));
    expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Project menu" })).toBeNull();
  });

  it("puts the drawer away on a right-to-left swipe over it", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 100, 300);
      expect(screen.getByRole("dialog", { name: "Files" })).toBeTruthy();
    });
    const drawer = screen.getByRole("dialog", { name: "Files" });
    await within(drawer).findByRole("button", { name: "Open the folder src" });
    swipe(drawer, 300, 100);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
  });

  /** The drawer, opened from the name's dropdown. */
  async function openDrawer() {
    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    fireEvent.click(within(screen.getByRole("menu", { name: "Project menu" })).getByRole("menuitem", { name: "Project files" }));
    return screen.getByRole("dialog", { name: "Files" });
  }
  const crumbs = (sheet: HTMLElement) =>
    within(within(sheet).getByRole("navigation", { name: "Folders" })).getAllByRole("button").map((crumb) => crumb.textContent);

  it("opens again in the folder it was put away in, across a reload too", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const first = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    let sheet = await openDrawer();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Close the files" }));
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();

    sheet = await openDrawer();
    expect(crumbs(sheet)).toEqual(["Alpha", "src"]);
    await within(sheet).findByRole("button", { name: "Open main.rs" });

    // The app reloaded: the folder is still where the drawer opens.
    first.unmount();
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    sheet = await openDrawer();
    expect(crumbs(sheet)).toEqual(["Alpha", "src"]);
    await within(sheet).findByRole("button", { name: "Open main.rs" });

    // Back at the root, the root is remembered.
    fireEvent.click(within(within(sheet).getByRole("navigation", { name: "Folders" })).getByRole("button", { name: "Alpha" }));
    await within(sheet).findByRole("button", { name: "Open notes.md" });
    expect(localStorage.getItem(storageKey("mobile.filesPlace"))).toBeNull();
  });

  it("steps back from a remembered folder that is gone", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    localStorage.setItem(storageKey("mobile.filesPlace"), JSON.stringify([["p1", [{ token: "tok-src", name: "src" }, { token: "tok-gone", name: "old" }]]]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openDrawer();
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    expect(crumbs(sheet)).toEqual(["Alpha", "src"]);
    expect(within(sheet).queryByRole("alert")).toBeNull();
  });

  it("keeps a PDF opened from the drawer as a card among the tabs", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openDrawer();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open paper.pdf" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "paper.pdf" })).getByRole("button", { name: "Close" }));
    // Closing the PDF comes back to the drawer, in its folder; a text opened
    // there makes no card.
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Files" })).findByRole("button", { name: "Open notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files" })).getByRole("button", { name: "Close the files" }));

    const card = screen.getByRole("button", { name: "Open paper.pdf" }).closest(".file-tab-card") as HTMLElement;
    expect(card.textContent).toContain("Project folder");
    expect(screen.queryByRole("button", { name: "Open notes.md" })).toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Open paper.pdf" }));
    const pdf = screen.getByRole("dialog", { name: "paper.pdf" });
    expect(within(pdf).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-paper&download=1");
    fireEvent.click(within(pdf).getByRole("button", { name: "Close" }));

    fireEvent.click(within(card).getByRole("button", { name: "Forget paper.pdf on this phone" }));
    expect(screen.queryByRole("button", { name: "Open paper.pdf" })).toBeNull();
  });
});
