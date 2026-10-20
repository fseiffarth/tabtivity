/**
 * The project screen's read-only file browser (#31bo): the drawer a
 * right→left swipe or the header's ☰ opens (`ProjectFiles`) holds, below its
 * own rows and while the desktop's "Project files on the phone" switch is on,
 * a Files row that opens the full-screen library (`FilesLibrary`) — folders
 * walked by the sealed tokens the sidecar hands out, never a path, and files
 * opened in the outbox's viewer, fetched by their token.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_INBOX_FILE } from "../../../mobile-web/src/api";
import { FilesLibrary } from "../../../mobile-web/src/components/FilesLibrary";
import { Project } from "../../../mobile-web/src/screens/Project";
import { storageKey } from "../../../src/lib/brand";

const ROOT = {
  entries: [
    { token: "tok-build", name: "build", kind: "dir", size: 0, modified: 1_770_000_000, ignored: true },
    { token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000, items: 3 },
    { token: "tok-agents", name: "AGENTS.md", kind: "text/plain; charset=utf-8", size: 20, modified: 1_770_000_000 },
    { token: "tok-notes", name: "notes.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000, created: 1_760_000_000 },
    { token: "tok-plot", name: "plot.png", kind: "image/png", size: 48_000, modified: 1_770_000_000, created: 1_765_000_000 },
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
    // An older desktop's folder: no `items`, so no count.
    { token: "tok-deep", name: "deep", kind: "dir", size: 0, modified: 1_770_000_000 },
  ],
  truncated: false,
};
const DEEP = {
  entries: [{ token: "tok-leaf", name: "leaf.txt", kind: "text/plain; charset=utf-8", size: 1, modified: 1_770_000_000 }],
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
    if (url === "/api/v1/projects/p1/git") return new Response(JSON.stringify({
      repo: false, worktrees: [], worktrees_total: 0, branches: [], branches_total: 0, remote_branches: [], remote_total: 0,
    }), { status: 200 });
    if (url === "/api/v1/projects/p1/files") return new Response(JSON.stringify(ROOT), { status: 200 });
    if (url === "/api/v1/projects/p1/files?dir=tok-src") return new Response(JSON.stringify(SRC), { status: 200 });
    if (url === "/api/v1/projects/p1/files?dir=tok-deep") return new Response(JSON.stringify(DEEP), { status: 200 });
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

/** The drawer, opened from the header's ☰ once the project is read. */
async function openDrawer() {
  fireEvent.click(await screen.findByRole("button", { name: "Project menu" }));
  return screen.getByRole("dialog", { name: "Alpha" });
}

/** The full-screen library, from the drawer's Files row. */
async function openLibrary() {
  const drawer = await openDrawer();
  fireEvent.click(within(drawer).getByRole("button", { name: "Open the project's files" }));
  return screen.getByRole("dialog", { name: "Files" });
}

/** The folders the path menu lists, root first, and the one it ticks; the
 * menu is put away again. */
function pathOf(library: HTMLElement) {
  fireEvent.click(within(library).getByRole("button", { name: / — show the folders above$/ }));
  const sheet = screen.getByRole("dialog", { name: "Folders" });
  const rows = within(sheet).getAllByRole("button").filter((button) => button.closest(".option-list"));
  const names = rows.map((row) => row.querySelector("strong")?.textContent ?? "");
  const current = rows.find((row) => row.getAttribute("aria-current") === "true")?.querySelector("strong")?.textContent;
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
  return { names, current };
}

/** Picks `label` in the ⋯ view menu and puts the menu away. */
function viewPick(library: HTMLElement, ...labels: string[]) {
  fireEvent.click(within(library).getByRole("button", { name: "View options" }));
  const sheet = screen.getByRole("dialog", { name: "View options" });
  for (const label of labels) fireEvent.click(within(sheet).getByRole("button", { name: label }));
  fireEvent.click(within(sheet).getByRole("button", { name: "Close" }));
}

/** The names the library shows, in order (grid tiles or list rows). */
const shownNames = (library: HTMLElement) =>
  Array.from(library.querySelectorAll(".files-tile-open strong, .files-list li > button:first-child strong")).map((name) => name.textContent);

describe("Mobile project — read-only file browser", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the drawer without the Files row while the desktop's switch is off", async () => {
    const fetch = hostWith(false);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 300, 100);
      expect(screen.getByRole("dialog", { name: "Alpha" })).toBeTruthy();
    });
    const sheet = screen.getByRole("dialog", { name: "Alpha" });
    expect(within(sheet).getByRole("menuitem", { name: /^Git/ })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Open the project's files" })).toBeNull();
    expect(within(sheet).queryByRole("searchbox")).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files"))).toBe(false);
  });

  it("opens the library from the drawer's Files row, and ‹ Back at the root comes back to the drawer", async () => {
    const fetch = hostWith(true);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const drawer = await openDrawer();
    // The drawer lists no files itself any more.
    expect(within(drawer).queryByRole("searchbox")).toBeNull();
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files"))).toBe(false);

    fireEvent.click(within(drawer).getByRole("button", { name: "Open the project's files" }));
    const library = screen.getByRole("dialog", { name: "Files" });
    expect(screen.queryByRole("dialog", { name: "Alpha" })).toBeNull();
    await within(library).findByRole("button", { name: "Open the folder src" });
    // The root's title is the project's name; ‹ reads Back there.
    expect(within(library).getByRole("button", { name: "Alpha — show the folders above" })).toBeTruthy();
    const back = within(library).getByRole("button", { name: "Close the files" });
    expect(back.textContent).toBe("Back");

    fireEvent.click(back);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeTruthy();
  });

  it("goes up by ‹, jumps along the path menu, and steps up on a swipe from the left edge", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    fireEvent.click(await within(library).findByRole("button", { name: "Open the folder src" }));
    fireEvent.click(await within(library).findByRole("button", { name: "Open the folder deep" }));
    await within(library).findByRole("button", { name: "Open leaf.txt" });

    // ‹ names the parent folder; the title is this one.
    expect(within(library).getByRole("button", { name: "Up to src" }).textContent).toBe("src");
    expect(within(library).getByRole("button", { name: "deep — show the folders above" })).toBeTruthy();
    expect(pathOf(library)).toEqual({ names: ["Alpha", "src", "deep"], current: "deep" });

    // ‹ goes up one.
    fireEvent.click(within(library).getByRole("button", { name: "Up to src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    fireEvent.click(within(library).getByRole("button", { name: "Open the folder deep" }));
    await within(library).findByRole("button", { name: "Open leaf.txt" });

    // The path menu jumps straight to the root.
    fireEvent.click(within(library).getByRole("button", { name: "deep — show the folders above" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Folders" })).getByRole("button", { name: /^Alpha/ }));
    expect(screen.queryByRole("dialog", { name: "Folders" })).toBeNull();
    await within(library).findByRole("button", { name: "Open notes.md" });
    expect(within(library).getByRole("button", { name: "Close the files" })).toBeTruthy();

    // A right swipe from the left edge goes up one folder, and at the root
    // closes the library back to the drawer.
    fireEvent.click(within(library).getByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    swipe(library, 4, 200);
    await within(library).findByRole("button", { name: "Open notes.md" });
    swipe(library, 4, 200);
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Alpha" })).toBeTruthy();
  });

  it("switches between grid and list, remembered on the phone", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const first = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    let library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    // A grid by default: tiles with a cover and a ▾ item menu each.
    expect(library.querySelector(".files-grid")).not.toBeNull();
    expect(library.querySelector(".files-list")).toBeNull();
    expect(within(library).getByRole("button", { name: "More for plot.png" }).className).toBe("files-tile-menu");

    viewPick(library, "List");
    expect(library.querySelector(".files-grid")).toBeNull();
    expect(library.querySelector(".files-list")).not.toBeNull();
    expect(within(library).getByRole("button", { name: "More for plot.png" }).className).toBe("files-more");
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesLibraryView")) ?? "{}")).toMatchObject({ layout: "list" });

    first.unmount();
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    expect(library.querySelector(".files-list")).not.toBeNull();
  });

  it("sorts on the phone: folders on top, natural names, a missing created time last either way", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    // Name, ascending, folders on top; the scaffold and the gitignored stay folded at the end.
    expect(shownNames(library)).toEqual(["src", "notes.md", "paper.pdf", "plot.png"]);

    viewPick(library, "Descending");
    expect(shownNames(library)).toEqual(["src", "plot.png", "paper.pdf", "notes.md"]);

    // paper.pdf has no created time: last when ascending and when descending.
    viewPick(library, "Created", "Ascending");
    expect(shownNames(library)).toEqual(["src", "notes.md", "plot.png", "paper.pdf"]);
    viewPick(library, "Descending");
    expect(shownNames(library)).toEqual(["src", "plot.png", "notes.md", "paper.pdf"]);

    viewPick(library, "Kind", "Ascending", "Folders on top");
    expect(shownNames(library)).toEqual(["src", "paper.pdf", "plot.png", "notes.md"]);
    viewPick(library, "Descending");
    expect(shownNames(library)).toEqual(["notes.md", "plot.png", "paper.pdf", "src"]);
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesLibraryView")) ?? "{}"))
      .toEqual({ layout: "grid", sort: "kind", desc: true, foldersFirst: false, thumbs: true });

    // The sections follow the rest, sorted on their own.
    fireEvent.click(within(library).getByRole("button", { name: "scaffold (2)" }));
    expect(shownNames(library)).toEqual(["notes.md", "plot.png", "paper.pdf", "src", "AGENTS.md", "README.md"]);
  });

  it("counts a folder's items only where the desktop counted them", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    const src = await within(library).findByRole("button", { name: "Open the folder src" });
    expect(src.querySelector("small")?.textContent).toBe("3 items");
    // A file's tile says when and how big.
    expect(within(library).getByRole("button", { name: "Open notes.md" }).querySelector("small")?.textContent).toMatch(/ · 8 B$/);

    fireEvent.click(src);
    const deep = await within(library).findByRole("button", { name: "Open the folder deep" });
    expect(deep.querySelector("small")).toBeNull();
    expect(library.textContent).not.toMatch(/\b0 items/);
  });

  it("finds files and folders by name and moves the library to a hit's folder", async () => {
    const fetch = hostWith(true);
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    const box = within(library).getByRole("searchbox", { name: "Search the project's files" });

    // A hit names its folder.
    fireEvent.change(box, { target: { value: "  main " } });
    const hit = await within(library).findByRole("button", { name: "Open main.rs" });
    expect(hit.querySelector(".files-hit-place")?.textContent).toBe("src");
    expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/search?q=main", expect.anything());

    // A file hit opens in the viewer; closed, the results are still there and
    // the library stands in the file's folder.
    fireEvent.click(hit);
    const viewer = await screen.findByRole("dialog", { name: "main.rs" });
    await within(viewer).findByText("fn main() {}");
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    await within(screen.getByRole("dialog", { name: "Files" })).findByRole("button", { name: "Open main.rs" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "" } });
    expect(pathOf(screen.getByRole("dialog", { name: "Files" })).names).toEqual(["Alpha", "src"]);

    // A folder hit at the root is walked into, and the search ends there.
    fireEvent.click(screen.getByRole("button", { name: "Up to Alpha" }));
    await screen.findByRole("button", { name: "Open notes.md" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "src" } });
    const folder = await screen.findByRole("button", { name: "Open the folder src" });
    expect(folder.querySelector(".files-hit-place")?.textContent).toBe("Project folder");
    fireEvent.click(folder);
    await screen.findByRole("button", { name: "Open main.rs" });
    expect((screen.getByRole("searchbox", { name: "Search the project's files" }) as HTMLInputElement).value).toBe("");
    expect(pathOf(screen.getByRole("dialog", { name: "Files" })).names).toEqual(["Alpha", "src"]);

    // Show in folder, from a hit's item menu: the library stands there, nothing opens.
    fireEvent.click(screen.getByRole("button", { name: "Up to Alpha" }));
    await screen.findByRole("button", { name: "Open notes.md" });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "main" } });
    fireEvent.click(await screen.findByRole("button", { name: "More for main.rs" }));
    const menu = screen.getByRole("dialog", { name: "main.rs" });
    expect(within(menu).getAllByRole("button").map((button) => button.textContent).filter((text) => text !== "✕"))
      .toEqual(["Open", "Favorite", "Show in folder"]);
    fireEvent.click(within(menu).getByRole("button", { name: "Show in folder" }));
    await screen.findByRole("button", { name: "Open the folder deep" });
    expect((screen.getByRole("searchbox", { name: "Search the project's files" }) as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("dialog", { name: "main.rs" })).toBeNull();

    // Nothing named so: one line says it.
    fireEvent.change(screen.getByRole("searchbox", { name: "Search the project's files" }), { target: { value: "zzz" } });
    await screen.findByText("No file or folder has that in its name.");
  });

  it("walks folders by token, back by ‹, and opens files by token", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const sheet = await openLibrary();
    expect(sheet.textContent).toContain("Read-only");
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    viewPick(sheet, "List");
    // Each row's tile names its kind; the scaffold and the gitignored fold
    // shut below the rest, as on the desktop's tree.
    expect(Array.from(sheet.querySelectorAll(".files-list li > button:first-child strong")).map((row) => row.textContent))
      .toEqual(["src", "notes.md", "paper.pdf", "plot.png"]);
    expect(Array.from(sheet.querySelectorAll(".files-icon")).map((tile) => tile.className.replace("files-icon files-icon-", "")))
      .toEqual(["dir", "text", "pdf", "image"]);
    // Each row says when it was last edited, and created where the desktop's
    // filesystem keeps a birth time (notes.md here, not the folder).
    const meta = Array.from(sheet.querySelectorAll(".files-list small")).map((row) => row.textContent ?? "");
    expect(meta[0]).toContain("Edited ");
    expect(meta[0]).not.toContain("Created");
    expect(meta[1]).toMatch(/^8 B · Created .+ · Edited .+$/);

    // Into a folder, and back by ‹ (the project's name at the root).
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Up to Alpha" }));
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

    // Closing the viewer comes back to the same folder; a text reads inline,
    // opened from its item menu this time.
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "More for notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Open" }));
    const text = screen.getByRole("dialog", { name: "notes.md" });
    await waitFor(() => expect(text.querySelector("pre")?.textContent).toBe("# Hello\n"));
  });

  it("folds the root's scaffold and what git ignores into collapsed sections", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openLibrary();
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
    expect(within(sheet).getByRole("button", { name: "Open run.log" }).closest("li")?.classList.contains("files-folded")).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder build" }));
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "scaffold (2)" })).toBeNull());

    // Below the root a README is an ordinary entry.
    fireEvent.click(within(sheet).getByRole("button", { name: "Up to Alpha" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    expect(within(sheet).getByRole("button", { name: "Open README.md" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /^scaffold/ })).toBeNull();
  });

  it("shares a file from its item menu, or a list row's ↗, without opening it", async () => {
    const files = hostWith(true);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      String(input) === "/api/v1/projects/p1/files/raw?f=tok-plot" ? new Response(new Uint8Array([1, 2, 3, 4])) : files(input, init));
    vi.stubGlobal("fetch", fetch);
    const share = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", { configurable: true, value: share });
    try {
      render(<Project id="p1" back={() => {}} terminal={() => {}} />);
      const sheet = await openLibrary();
      // A folder's menu has nothing to share.
      fireEvent.click(await within(sheet).findByRole("button", { name: "More for src" }));
      expect(within(screen.getByRole("dialog", { name: "src" })).queryByRole("button", { name: "Share" })).toBeNull();
      fireEvent.click(within(screen.getByRole("dialog", { name: "src" })).getByRole("button", { name: "Close" }));

      fireEvent.click(within(sheet).getByRole("button", { name: "More for plot.png" }));
      fireEvent.click(within(screen.getByRole("dialog", { name: "plot.png" })).getByRole("button", { name: "Share" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
      const sent = (share.mock.calls[0] as unknown as [{ files: File[] }])[0].files[0];
      expect([sent.name, sent.type, sent.size]).toEqual(["plot.png", "image/png", 4]);
      // The bytes came by the file's token, and no viewer opened over the list.
      expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/raw?f=tok-plot");
      expect(screen.queryByRole("dialog", { name: "plot.png" })).toBeNull();

      // In the list every file row carries ↗ Share; a folder has nothing to share.
      viewPick(sheet, "List");
      expect(within(sheet).getAllByRole("button", { name: /^Share / }).map((button) => button.getAttribute("aria-label")))
        .toEqual(["Share notes.md", "Share paper.pdf", "Share plot.png"]);
      fireEvent.click(within(sheet).getByRole("button", { name: "Share plot.png" }));
      await waitFor(() => expect(share).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(within(sheet).getByRole("button", { name: "Share plot.png" }).hasAttribute("disabled")).toBe(false));
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
    // Said in the viewer, where the reader is looking — never a browser `alert()`.
    const alert = vi.spyOn(window, "alert").mockImplementation(() => { throw new Error("window.alert must not be used"); });
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openLibrary();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open notes.md" }));
    const viewer = screen.getByRole("dialog", { name: "notes.md" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Open the whole file" }));
    await waitFor(() => expect(within(viewer).getByRole("alert").textContent).toContain("Reconnect"));
    expect(alert).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens from the screen's right edge, where the drawer is pulled from", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, window.innerWidth - 4, window.innerWidth - 200);
      expect(screen.getByRole("dialog", { name: "Alpha" })).toBeTruthy();
    });
  });

  it("goes back on a left→right swipe, the screen's left edge included", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    render(<Project id="p1" back={back} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    swipe(heading, 100, 300);
    expect(back).toHaveBeenCalledTimes(1);
    swipe(heading, 4, 200);
    expect(back).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog", { name: "Alpha" })).toBeNull();
  });

  it("opens from the header's ☰ beside the ＋ too, its own rows above Files", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openDrawer();
    const menu = within(sheet).getByRole("menu", { name: "Project menu" });
    expect(within(menu).getAllByRole("menuitem").map((row) => row.textContent)).toEqual([expect.stringMatching(/^⎇Git/)]);
    expect(within(sheet).getByRole("button", { name: "Open the project's files" })).toBeTruthy();
    // A row puts the drawer away for the sheet it opens.
    fireEvent.click(within(menu).getByRole("menuitem", { name: /^Git/ }));
    expect(screen.queryByRole("dialog", { name: "Alpha" })).toBeNull();
    expect(await screen.findByRole("dialog", { name: "Git · Alpha" })).toBeTruthy();
  });

  it("puts the drawer away on a left-to-right swipe over it", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const back = vi.fn();
    render(<Project id="p1" back={back} terminal={() => {}} />);
    const heading = await screen.findByRole("heading", { name: "Alpha" });
    await waitFor(() => {
      swipe(heading, 300, 100);
      expect(screen.getByRole("dialog", { name: "Alpha" })).toBeTruthy();
    });
    const drawer = screen.getByRole("dialog", { name: "Alpha" });
    swipe(drawer, 100, 300);
    // The drawer takes that swipe; the screen does not also go back.
    expect(back).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Alpha" })).toBeNull();
  });

  it("opens again in the folder it was put away in, across a reload too", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    const first = render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    let sheet = await openLibrary();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    // Escape puts the library away, back to the drawer, and closes that too.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Files" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Alpha" })).getByRole("button", { name: "Close the files" }));
    expect(screen.queryByRole("dialog", { name: "Alpha" })).toBeNull();

    sheet = await openLibrary();
    expect(pathOf(sheet).names).toEqual(["Alpha", "src"]);
    await within(sheet).findByRole("button", { name: "Open main.rs" });

    // The app reloaded: the folder is still where the library opens.
    first.unmount();
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    sheet = await openLibrary();
    expect(pathOf(sheet).names).toEqual(["Alpha", "src"]);
    await within(sheet).findByRole("button", { name: "Open main.rs" });

    // Back at the root, the root is remembered.
    fireEvent.click(within(sheet).getByRole("button", { name: "Up to Alpha" }));
    await within(sheet).findByRole("button", { name: "Open notes.md" });
    expect(localStorage.getItem(storageKey("mobile.filesPlace"))).toBeNull();
  });

  it("steps back from a remembered folder that is gone", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    localStorage.setItem(storageKey("mobile.filesPlace"), JSON.stringify([["p1", [{ token: "tok-src", name: "src" }, { token: "tok-gone", name: "old" }]]]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openLibrary();
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    expect(pathOf(sheet).names).toEqual(["Alpha", "src"]);
    expect(within(sheet).queryByRole("alert")).toBeNull();
  });

  it("keeps a PDF opened from the library as a card among the tabs", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openLibrary();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open paper.pdf" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "paper.pdf" })).getByRole("button", { name: "Close" }));
    // Closing the PDF comes back to the library, in its folder; a text opened
    // there makes no card.
    fireEvent.click(await within(screen.getByRole("dialog", { name: "Files" })).findByRole("button", { name: "Open notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Files" })).getByRole("button", { name: "Close the files" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Alpha" })).getByRole("button", { name: "Close the files" }));

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

describe("Mobile project — Upload here", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  type Entry = (typeof SRC.entries)[number];
  /** The desktop with uploads on in `src` (not at the root): `post` answers
   * each upload, and what landed is listed in `src` until undone. */
  function uploadHost(post: (url: string, landed: Entry[]) => Promise<Response> | Response) {
    const host = hostWith(true);
    const landed: Entry[] = [];
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/projects/p1/files/upload?name=") && init?.method === "POST") return post(url, landed);
      if (url.startsWith("/api/v1/projects/p1/files/upload?f=") && init?.method === "DELETE") {
        const token = new URL(url, "http://phone").searchParams.get("f");
        const at = landed.findIndex((entry) => entry.token === token);
        if (at < 0) return new Response(JSON.stringify({ error: "file_not_found" }), { status: 404 });
        landed.splice(at, 1);
        return new Response(JSON.stringify({ undone: true }), { status: 200 });
      }
      if (url === "/api/v1/projects/p1/files?dir=tok-src") return new Response(JSON.stringify({ ...SRC, entries: [...SRC.entries, ...landed], uploads: true }), { status: 200 });
      return host(input, init);
    });
  }

  /** The library, opened from the drawer and walked into `src`. */
  async function openSrc() {
    const sheet = await openLibrary();
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open the folder src" }));
    await within(sheet).findByRole("button", { name: "Open main.rs" });
    return sheet;
  }

  function pick(files: File[]) {
    const input = screen.getByTestId("project-files-upload-input") as HTMLInputElement;
    Object.defineProperty(input, "files", { value: files, configurable: true });
    fireEvent.change(input);
  }

  const posts = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST").map(([url]) => String(url));

  it("offers Upload here only where the listing allows it", async () => {
    vi.stubGlobal("fetch", uploadHost(() => new Response(null, { status: 500 })));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openLibrary();
    // The root's listing carries no `uploads` (an older desktop, or a dot folder).
    await within(sheet).findByRole("button", { name: "Open the folder src" });
    expect(within(sheet).queryByRole("button", { name: /^Upload here/ })).toBeNull();
    expect(sheet.textContent).toContain("Read-only");

    fireEvent.click(within(sheet).getByRole("button", { name: "Open the folder src" }));
    expect(await within(sheet).findByRole("button", { name: /^Upload here/ })).toBeTruthy();
    expect(sheet.textContent).toContain("Add-only");
    expect(sheet.textContent).not.toContain("Read-only");
  });

  it("uploads the picks one after another into the folder, lists them, and undoes one", async () => {
    let release: (() => void) | undefined;
    const fetch = uploadHost(async (url, landed) => {
      const name = new URL(url, "http://phone").searchParams.get("name") ?? "";
      // The first answer waits, so the second file must not be out yet.
      if (name === "notes.txt") await new Promise<void>((resolve) => { release = resolve; });
      const entry = { token: `tok-${name}`, name: name === "main.rs" ? "main-2.rs" : name, kind: "text/plain; charset=utf-8", size: 5, modified: 1_770_000_100 };
      landed.push(entry);
      return new Response(JSON.stringify({ file: entry }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openSrc();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Upload here/ }));
    pick([new File(["notes"], "notes.txt", { type: "text/plain" }), new File(["fn x"], "main.rs")]);
    await waitFor(() => expect(posts(fetch)).toEqual(["/api/v1/projects/p1/files/upload?name=notes.txt&dir=tok-src"]));
    expect(within(sheet).getAllByText("Uploading…")).toHaveLength(2);
    release?.();

    // Each landed file is listed again in the folder; a taken name came back
    // as the desktop's own (`main-2.rs`).
    await within(sheet).findByRole("button", { name: "Open main-2.rs" });
    expect(posts(fetch)).toEqual([
      "/api/v1/projects/p1/files/upload?name=notes.txt&dir=tok-src",
      "/api/v1/projects/p1/files/upload?name=main.rs&dir=tok-src",
    ]);
    await within(sheet).findByRole("button", { name: "Open notes.txt" });
    expect(within(sheet).getAllByText("Added to src")).toHaveLength(2);

    // Undo deletes by the landed file's token, and the folder lists without it.
    fireEvent.click(within(sheet).getByRole("button", { name: "Undo adding main-2.rs" }));
    await within(sheet).findByText("Removed again.");
    expect(fetch).toHaveBeenCalledWith("/api/v1/projects/p1/files/upload?f=tok-main.rs", expect.objectContaining({ method: "DELETE" }));
    await waitFor(() => expect(within(sheet).queryByRole("button", { name: "Open main-2.rs" })).toBeNull());

    // Out of the folder, the other row keeps saying where it went, without Undo.
    fireEvent.click(within(sheet).getByRole("button", { name: "Up to Alpha" }));
    await within(sheet).findByRole("button", { name: "Open notes.md" });
    expect(within(sheet).getByText("Added to src")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "Undo adding notes.txt" })).toBeNull();
  });

  it("says why a file was not added, by the desktop's code", async () => {
    vi.stubGlobal("fetch", uploadHost((url) => {
      const name = new URL(url, "http://phone").searchParams.get("name");
      if (name === "full.pdf") return new Response(JSON.stringify({ error: "uploads_full" }), { status: 507 });
      if (name === "dot.pdf") return new Response(JSON.stringify({ error: "upload_refused" }), { status: 403 });
      // A body past the route's limit: axum's own 413, no JSON.
      if (name === "huge.pdf") return new Response("length limit exceeded", { status: 413 });
      return new Response(JSON.stringify({ error: "write_failed" }), { status: 500 });
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openSrc();
    fireEvent.click(within(sheet).getByRole("button", { name: /^Upload here/ }));
    pick(["full.pdf", "dot.pdf", "huge.pdf", "disk.pdf"].map((name) => new File(["x"], name)));
    await waitFor(() => expect(within(sheet).getAllByRole("alert")).toHaveLength(4));
    expect(within(sheet).getAllByRole("alert").map((row) => row.textContent)).toEqual([
      "full.pdfdid not fit — this project's 1 GB of uploads a day is used up.✕",
      "dot.pdfwas not added — this folder takes no uploads.✕",
      "huge.pdfis larger than 24 MB.✕",
      "disk.pdfcould not be added to the project.✕",
    ]);
  });

  it("refuses a file past 24 MB before anything is sent", async () => {
    const fetch = uploadHost(() => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openSrc();
    const big = new File(["x"], "movie.mp4");
    Object.defineProperty(big, "size", { value: MAX_INBOX_FILE + 1 });
    fireEvent.click(within(sheet).getByRole("button", { name: /^Upload here/ }));
    pick([big]);
    expect((await within(sheet).findByRole("alert")).textContent).toContain("is larger than 24 MB.");
    expect(posts(fetch)).toEqual([]);
  });

  it("a re-list that fails hides Upload here, and the next good one clears the refusal", async () => {
    const landed: Entry[] = [];
    let lists = 0;
    const host = hostWith(true);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/v1/projects/p1/files/upload?name=") && init?.method === "POST") {
        const name = new URL(url, "http://phone").searchParams.get("name") ?? "";
        const entry = { token: `tok-${name}`, name, kind: "text/plain; charset=utf-8", size: 1, modified: 1_770_000_100 };
        landed.push(entry);
        return new Response(JSON.stringify({ file: entry }), { status: 201 });
      }
      if (url === "/api/v1/projects/p1/files?dir=tok-src") {
        lists += 1;
        // The re-list after the first upload meets a refusal.
        if (lists === 2) return new Response(JSON.stringify({ error: "files_unavailable" }), { status: 503 });
        return new Response(JSON.stringify({ ...SRC, entries: [...SRC.entries, ...landed], uploads: true }), { status: 200 });
      }
      return host(input, init);
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const sheet = await openSrc();

    fireEvent.click(within(sheet).getByRole("button", { name: /^Upload here/ }));
    pick([new File(["a"], "a.txt")]);
    await within(sheet).findByText("The folder could not be read.");
    expect(within(sheet).queryByRole("button", { name: /^Upload here/ })).toBeNull();

    // The picker's input stays (still stamped with `src`): the next landing
    // lists the folder again, and that answer replaces the refusal.
    pick([new File(["b"], "b.txt")]);
    await within(sheet).findByRole("button", { name: "Open b.txt" });
    expect(within(sheet).queryByText("The folder could not be read.")).toBeNull();
    expect(within(sheet).getByRole("button", { name: /^Upload here/ })).toBeTruthy();
  });
});

describe("Mobile project — favorites, recent files, folder colours, thumbnails", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Picks `label` in `name`'s item menu (▾ / ⋯). */
  function itemPick(library: HTMLElement, name: string, label: string) {
    fireEvent.click(within(library).getByRole("button", { name: `More for ${name}` }));
    fireEvent.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: label }));
  }
  const strip = (library: HTMLElement) => within(library).queryByRole("region", { name: "Favorites" });
  /** The folder's own listing, below the strip. */
  const listed = (library: HTMLElement, folder: string) => within(within(library).getByRole("list", { name: folder }));

  it("stars a folder and a file into the root's strip, opens them from there, and unstars them", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    let library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    expect(strip(library)).toBeNull();

    itemPick(library, "src", "Favorite");
    // A file deeper down keeps the folders above it.
    fireEvent.click(listed(library, "Alpha").getByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    itemPick(library, "main.rs", "Favorite");
    fireEvent.click(within(library).getByRole("button", { name: "Up to Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });

    const favorites = strip(library)!;
    expect(Array.from(favorites.querySelectorAll(".files-tile-open strong")).map((name) => name.textContent)).toEqual(["main.rs", "src"]);
    expect(Array.from(favorites.querySelectorAll(".files-hit-place")).map((place) => place.textContent)).toEqual(["src", "Project folder"]);
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesFavorites")) ?? "{}").p1).toEqual([
      { kind: "text/plain; charset=utf-8", name: "main.rs", token: "tok-main", trail: [{ token: "tok-src", name: "src" }] },
      { kind: "dir", name: "src", token: "tok-src", trail: [] },
    ]);

    // A favorite folder is walked into, found again by its folder's listing.
    fireEvent.click(within(favorites).getByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open the folder deep" });
    expect(strip(library)).toBeNull();
    fireEvent.click(within(library).getByRole("button", { name: "Up to Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });

    // A favorite file opens in the viewer, the library standing in its folder.
    fireEvent.click(within(strip(library)!).getByRole("button", { name: "Open main.rs" }));
    const viewer = await screen.findByRole("dialog", { name: "main.rs" });
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    await screen.findByRole("button", { name: "Open the folder deep" });
    // The viewer took the library's place; this is the library drawn again.
    library = screen.getByRole("dialog", { name: "Files" });

    // Show in folder from the strip, and Unfavorite from any menu.
    fireEvent.click(within(library).getByRole("button", { name: "Up to Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });
    fireEvent.click(within(strip(library)!).getByRole("button", { name: "More for main.rs" }));
    const menu = screen.getByRole("dialog", { name: "main.rs" });
    expect(within(menu).getAllByRole("button").map((button) => button.textContent).filter((text) => text !== "✕"))
      .toEqual(["Open", "Unfavorite", "Show in folder"]);
    fireEvent.click(within(menu).getByRole("button", { name: "Show in folder" }));
    await within(library).findByRole("button", { name: "Open the folder deep" });
    itemPick(library, "main.rs", "Unfavorite");
    fireEvent.click(within(library).getByRole("button", { name: "Up to Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });
    fireEvent.click(listed(library, "Alpha").getByRole("button", { name: "More for src" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "src" })).getByRole("button", { name: "Unfavorite" }));
    expect(strip(library)).toBeNull();
  });

  it("dims a favorite that was moved or deleted, says so, and offers Remove", async () => {
    localStorage.setItem(storageKey("mobile.filesFavorites"), JSON.stringify({
      p1: [
        { kind: "application/pdf", name: "old.pdf", token: "tok-old", trail: [] },
        // Its folder's token no longer opens either.
        { kind: "dir", name: "gone", token: "tok-gone", trail: [{ token: "tok-renamed", name: "renamed" }] },
      ],
    }));
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    const favorites = strip(library)!;

    fireEvent.click(within(favorites).getByRole("button", { name: "Open old.pdf" }));
    const sheet = await screen.findByRole("dialog", { name: "old.pdf" });
    expect(sheet.textContent).toContain("old.pdf was moved or deleted.");
    expect(within(favorites).getByRole("button", { name: "Open old.pdf" }).closest("li")?.className).toContain("files-stale");
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));

    fireEvent.click(within(strip(library)!).getByRole("button", { name: "Open the folder gone" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "gone" })).getByRole("button", { name: "Remove" }));
    expect(strip(library)).toBeNull();
    expect(localStorage.getItem(storageKey("mobile.filesFavorites"))).toBeNull();
    // Nothing opened meanwhile.
    expect(screen.queryByRole("dialog", { name: "old.pdf" })).toBeNull();
  });

  it("lists the files opened here under the focused empty search box, newest first, and opens them again", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    const search = within(library).getByRole("searchbox", { name: "Search the project's files" });
    fireEvent.focus(search);
    expect(within(library).getByRole("region", { name: "Recent" }).textContent).toContain("No files opened here yet.");
    fireEvent.blur(search);

    fireEvent.click(await within(library).findByRole("button", { name: "Open notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open the folder src" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open main.rs" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "main.rs" })).getByRole("button", { name: "Close" }));
    // A folder walked into is not a recent.
    await screen.findByRole("button", { name: "Open the folder deep" });

    const box = screen.getByRole("searchbox", { name: "Search the project's files" });
    fireEvent.focus(box);
    const recent = screen.getByRole("region", { name: "Recent" });
    expect(Array.from(recent.querySelectorAll(".files-tile-open strong")).map((name) => name.textContent)).toEqual(["main.rs", "notes.md"]);
    // In place of the listing, while the box is empty.
    expect(screen.queryByRole("button", { name: "Open the folder deep" })).toBeNull();
    fireEvent.change(box, { target: { value: "ma" } });
    expect(screen.queryByRole("region", { name: "Recent" })).toBeNull();
    fireEvent.change(box, { target: { value: "" } });

    fireEvent.click(within(screen.getByRole("region", { name: "Recent" })).getByRole("button", { name: "Open notes.md" }));
    const text = await screen.findByRole("dialog", { name: "notes.md" });
    await waitFor(() => expect(text.querySelector("pre")?.textContent).toBe("# Hello\n"));
    fireEvent.click(within(text).getByRole("button", { name: "Close" }));
    // It opened in its own folder, the root, and is the newest recent now.
    await screen.findByRole("button", { name: "Open the folder src" });
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesRecents")) ?? "{}").p1.map((item: { name: string }) => item.name))
      .toEqual(["notes.md", "main.rs"]);
  });

  it("colours a folder on this phone: its tile's cover, its list icon, and No colour clears it", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    // Files have no colour entry.
    fireEvent.click(within(library).getByRole("button", { name: "More for notes.md" }));
    expect(within(screen.getByRole("dialog", { name: "notes.md" })).queryByRole("button", { name: "Folder colour" })).toBeNull();
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));

    itemPick(library, "src", "Folder colour");
    const sheet = screen.getByRole("dialog", { name: "Colour for src" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Green" }));
    expect(within(sheet).getByRole("button", { name: "Green" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    const icon = () => within(library).getByRole("button", { name: "Open the folder src" }).querySelector<HTMLElement>(".files-icon")!;
    expect(icon().style.color).toBe("rgb(89, 185, 106)");
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesFolderColors")) ?? "{}")).toEqual({ p1: [["src", "green"]] });

    viewPick(library, "List");
    expect(icon().style.color).toBe("rgb(89, 185, 106)");
    // An id this bundle does not know draws as no colour.
    localStorage.setItem(storageKey("mobile.filesFolderColors"), JSON.stringify({ p1: [["src", "magenta"]] }));
    itemPick(library, "src", "Folder colour");
    fireEvent.click(within(screen.getByRole("dialog", { name: "Colour for src" })).getByRole("button", { name: "No colour" }));
    expect(icon().style.color).toBe("");
    expect(localStorage.getItem(storageKey("mobile.filesFolderColors"))).toBeNull();
  });

  it("watches covers for thumbnails only with Thumbnails on; off, the kind icons stay", async () => {
    const observed: Element[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      observe(node: Element) { observed.push(node); }
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("indexedDB", {});
    vi.stubGlobal("createImageBitmap", () => Promise.reject(new Error("decode")));
    vi.stubGlobal("fetch", hostWith(true));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);
    const library = await openLibrary();
    await within(library).findByRole("button", { name: "Open the folder src" });
    // On by default: the picture's and the PDF's covers wait to be on screen.
    await waitFor(() => expect(observed.map((node) => node.closest("li")?.querySelector("strong")?.textContent).sort()).toEqual(["paper.pdf", "plot.png"]));

    viewPick(library, "Thumbnails");
    observed.length = 0;
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.filesLibraryView")) ?? "{}")).toMatchObject({ thumbs: false });
    const cover = within(library).getByRole("button", { name: "Open plot.png" }).querySelector(".files-tile-cover")!;
    expect(cover.querySelector(".files-icon-image")).not.toBeNull();
    expect(library.querySelector("img.files-thumb")).toBeNull();
    // Nothing was fetched for a cover.
    const fetch = vi.mocked(globalThis.fetch);
    expect(fetch.mock.calls.some(([url]) => String(url).includes("/files/raw"))).toBe(false);
    expect(observed).toEqual([]);
  });

  it("offers Mark up for a PDF and a picture where the library can, and opens the viewer marking", async () => {
    vi.stubGlobal("fetch", hostWith(true));
    render(<FilesLibrary projectId="p1" label="Alpha" onClose={() => {}} showTab={() => {}} />);
    const library = await screen.findByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open the folder src" });
    for (const name of ["notes.md", "src"]) {
      fireEvent.click(within(library).getByRole("button", { name: `More for ${name}` }));
      expect(within(screen.getByRole("dialog", { name })).queryByRole("button", { name: "Mark up" })).toBeNull();
      fireEvent.click(within(screen.getByRole("dialog", { name })).getByRole("button", { name: "Close" }));
    }

    // Tapped, the PDF reads first; Mark up opens it marking.
    fireEvent.click(within(library).getByRole("button", { name: "Open paper.pdf" }));
    const pdf = screen.getByRole("dialog", { name: "paper.pdf" });
    expect(pdf.className).not.toContain("marking");
    expect(pdf.querySelector(".markup-toggle")).not.toBeNull();
    fireEvent.click(within(pdf).getByRole("button", { name: "Close" }));
    itemPick(await screen.findByRole("dialog", { name: "Files" }), "paper.pdf", "Mark up");
    const marking = document.querySelector(".markup-view.marking");
    expect(marking?.querySelector(".markup-submit")).not.toBeNull();
  });
});
