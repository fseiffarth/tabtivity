/**
 * The files library and the viewer laid over it (`docs/phone_files_browsing_plan.md`,
 * batch A): the list stays mounted under an open file and keeps its scroll
 * place per folder, Escape over a viewer is Back, refusals are said, a file
 * the phone cannot draw (or one past the desktop's cap) is a card rather than
 * an empty screen, sheets take the keyboard focus, and the Favorites page's
 * groups hold still while names arrive.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, MAX_LOCAL_VIEW, MAX_VIEW_FILE } from "../../../mobile-web/src/api";
import { resetBackStackForTests } from "../../../mobile-web/src/backStack";
import { FavoritesPage } from "../../../mobile-web/src/components/FavoritesPage";
import { FilesLibrary, failureKey } from "../../../mobile-web/src/components/FilesLibrary";
import { OptionSheet } from "../../../mobile-web/src/components/OptionSheet";
import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";
import { filesPlaceId, recordRecent, toggleFavorite } from "../../../mobile-web/src/filesPlace";
import { DEFAULT_LIBRARY_VIEW, glyphOf, sortEntries, writeLibraryView } from "../../../mobile-web/src/libraryView";

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const ROOT = {
  entries: [
    { token: "tok-src", name: "src", kind: "dir", size: 0, modified: 1_770_000_000 },
    { token: "tok-notes", name: "notes.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1_770_000_000 },
  ],
  truncated: false,
};
const SRC = {
  entries: [{ token: "tok-main", name: "main.rs", kind: "text/plain; charset=utf-8", size: 13, modified: 1_770_000_000 }],
  truncated: false,
};

/** A desktop answering one project's listings (`id`) and its text files. */
function stubHost(id: string) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `/api/v1/projects/${id}/files`) return reply(ROOT);
    if (url === `/api/v1/projects/${id}/files?dir=tok-src`) return reply(SRC);
    if (url.startsWith(`/api/v1/projects/${id}/files/raw`)) return new Response("# Hello\n", { status: 200 });
    return reply({ error: "file_not_found" }, 404);
  }));
}

/** jsdom lays nothing out, so the body's scroll is a plain value here. */
function scrollable(library: HTMLElement): HTMLElement {
  const body = library.querySelector<HTMLElement>(".files-library-body");
  if (!body) throw new Error("no library body");
  let top = 0;
  Object.defineProperty(body, "scrollTop", { configurable: true, get: () => top, set: (value: number) => { top = value; } });
  return body;
}

function scrollTo(body: HTMLElement, top: number) {
  body.scrollTop = top;
  fireEvent.scroll(body);
}

describe("Files library — the list under an open file", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the list mounted and inert under a file, and its place when the file closes", async () => {
    stubHost("keep");
    render(<FilesLibrary projectId="keep" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    const body = scrollable(library);
    scrollTo(body, 120);

    fireEvent.click(within(library).getByRole("button", { name: "Open notes.md" }));
    const viewer = screen.getByRole("dialog", { name: "notes.md" });
    // The same list element, still there under the viewer, out of reach.
    expect(library.isConnected).toBe(true);
    expect(library.hasAttribute("inert")).toBe(true);
    expect(body.scrollTop).toBe(120);

    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "notes.md" })).toBeNull();
    expect(library.hasAttribute("inert")).toBe(false);
    expect(body.scrollTop).toBe(120);
  });

  it("puts each folder's scroll back when ‹ goes up, and a folder seen first starts at the top", async () => {
    stubHost("up");
    render(<FilesLibrary projectId="up" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    const body = scrollable(library);
    scrollTo(body, 200);

    fireEvent.click(within(library).getByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    expect(body.scrollTop).toBe(0);
    scrollTo(body, 30);

    fireEvent.click(within(library).getByRole("button", { name: "Up to Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });
    await waitFor(() => expect(body.scrollTop).toBe(200));
  });

  it("closes a viewer on Escape through Back, leaving the library open", async () => {
    stubHost("esc");
    const onClose = vi.fn();
    render(<FilesLibrary projectId="esc" label="Alpha" onClose={onClose} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(library).findByRole("button", { name: "Open notes.md" }));
    expect(screen.getByRole("dialog", { name: "notes.md" })).toBeTruthy();

    // An Escape something else already handled (a field's own) is left alone.
    const handled = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    handled.preventDefault();
    act(() => { window.dispatchEvent(handled); });
    expect(screen.getByRole("dialog", { name: "notes.md" })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "notes.md" })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Files" })).toBe(library);
  });

  it("says each refusal of a listing or search rather than a bare error", () => {
    const said = (code: string) => failureKey(new ApiError(400, code));
    expect(said("project_unavailable")).toBe("mobile.files.unavailable");
    expect(said("files_unavailable")).toBe("mobile.files.notBrowsable");
    expect(said("read_failed")).toBe("mobile.files.readFailed");
    expect(said("file_too_large")).toBe("mobile.files.tooLarge");
    expect(said("query_too_long")).toBe("mobile.files.queryTooLong");
    expect(said("timeout")).toBe("mobile.files.timeout");
    expect(said("offline")).toBe("mobile.files.offline");
    expect(said("files_off")).toBe("mobile.files.off");
    expect(said("something_new")).toBe("mobile.files.error");
    expect(failureKey(new ApiError(400, "something_new"), "mobile.files.searchError")).toBe("mobile.files.searchError");
  });
});

describe("Files library — an iPad's wide screen and keyboard", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A screen that is (or is not) wide and held sideways. */
  const wide = (on: boolean) => vi.stubGlobal("matchMedia", (query: string) =>
    ({ matches: on && query.includes("min-width: 900px"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));

  it("shows an open file beside the folder, which stays usable and marks it; another tap swaps it", async () => {
    wide(true);
    stubHost("split");
    render(<FilesLibrary projectId="split" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(library).findByRole("button", { name: "Open notes.md" }));
    const viewer = screen.getByRole("dialog", { name: "notes.md" });
    expect(library.classList.contains("files-split")).toBe(true);
    expect(library.hasAttribute("inert")).toBe(false);
    expect(viewer.classList.contains("paned")).toBe(true);
    expect(viewer.getAttribute("aria-modal")).toBe("false");
    expect(within(library).getByRole("button", { name: "Open notes.md" }).getAttribute("aria-current")).toBe("true");

    fireEvent.click(within(library).getByRole("button", { name: "Open the folder src" }));
    fireEvent.click(await within(library).findByRole("button", { name: "Open main.rs" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "notes.md" })).toBeNull());
    expect(screen.getByRole("dialog", { name: "main.rs" }).classList.contains("paned")).toBe(true);

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "main.rs" })).toBeNull());
    expect(library.classList.contains("files-split")).toBe(false);
  });

  it("keeps a file over the folder on a narrow or upright screen", async () => {
    wide(false);
    stubHost("narrow");
    render(<FilesLibrary projectId="narrow" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(library).findByRole("button", { name: "Open notes.md" }));
    expect(screen.getByRole("dialog", { name: "notes.md" }).classList.contains("paned")).toBe(false);
    expect(library.hasAttribute("inert")).toBe(true);
  });

  it("walks the items with the arrows, searches on /, and goes up on Backspace but not past the root", async () => {
    stubHost("keys");
    const onClose = vi.fn();
    render(<FilesLibrary projectId="keys" label="Alpha" onClose={onClose} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    const notes = await within(library).findByRole("button", { name: "Open notes.md" });
    const src = within(library).getByRole("button", { name: "Open the folder src" });
    (document.activeElement as HTMLElement | null)?.blur();

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(src);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(document.activeElement).toBe(notes);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(document.activeElement).toBe(src);

    fireEvent.keyDown(window, { key: "Backspace" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(within(library).getByRole("searchbox", { name: "Search the project's files" }));
    // Typed into the search box, / and Backspace are the text's.
    fireEvent.keyDown(document.activeElement!, { key: "Backspace" });
    expect(onClose).not.toHaveBeenCalled();
    act(() => (document.activeElement as HTMLElement).blur());

    // The search box's focus showed the recents in the list's place: the
    // folder row is drawn anew.
    fireEvent.click(await within(library).findByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    fireEvent.keyDown(window, { key: "ArrowUp", metaKey: true });
    await within(library).findByRole("button", { name: "Open notes.md" });
  });
});

describe("Files library — drop, new folder, zip and selecting files", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** A desktop whose root takes uploads, answering the write routes. */
  function stubWriter(id: string, zip: "ok" | "too_large" = "ok") {
    const calls: { method: string; url: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      if (url === `/api/v1/projects/${id}/files`) return reply({ ...ROOT, uploads: true });
      if (url.startsWith(`/api/v1/projects/${id}/files/folder?name=`) && method === "POST") {
        return reply({ entry: { token: "tok-made", name: "figures", kind: "dir", size: 0, modified: 1_770_000_000 } }, 201);
      }
      if (url === `/api/v1/projects/${id}/files/folder?f=tok-made` && method === "DELETE") return reply({ removed: true });
      if (url.startsWith(`/api/v1/projects/${id}/files/upload?name=`)) {
        return reply({ file: { token: "tok-up", name: "drop.bin", kind: "application/octet-stream", size: 3, modified: 1_770_000_000 } }, 201);
      }
      if (url === `/api/v1/projects/${id}/files/zip?check=1`) {
        return zip === "ok" ? reply({ files: 2, bytes: 21 }) : reply({ error: "folder_too_large" }, 413);
      }
      return reply({ error: "file_not_found" }, 404);
    }));
    return calls;
  }

  const openViewMenu = (library: HTMLElement) => fireEvent.click(within(library).getByRole("button", { name: "View options" }));

  it("ticks files in Select files, stars them, and leaves on Esc without closing the library", async () => {
    stubHost("pick");
    const onClose = vi.fn();
    render(<FilesLibrary projectId="pick" label="Alpha" onClose={onClose} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    openViewMenu(library);
    fireEvent.click(screen.getByRole("button", { name: "Select files" }));
    const tick = within(library).getByRole("button", { name: "Select notes.md" });
    expect(tick.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(tick);
    expect(tick.getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("dialog", { name: "notes.md" })).toBeNull();
    const bar = within(library).getByRole("toolbar", { name: "Select files" });
    expect(bar.textContent).toContain("1 selected");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(within(library).queryByRole("toolbar")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    openViewMenu(library);
    fireEvent.click(screen.getByRole("button", { name: "Select files" }));
    fireEvent.click(within(library).getByRole("button", { name: "Select notes.md" }));
    fireEvent.click(within(within(library).getByRole("toolbar")).getByRole("button", { name: "☆ Favorite" }));
    expect(within(library).queryByRole("toolbar")).toBeNull();
    expect(within(library).getByRole("region", { name: "Favorites" }).textContent).toContain("notes.md");
  });

  it("makes a new folder from ⋯ and takes it back with Undo", async () => {
    const calls = stubWriter("folder");
    render(<FilesLibrary projectId="folder" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    openViewMenu(library);
    fireEvent.click(screen.getByRole("button", { name: "New folder…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Folder name" }), { target: { value: "figures" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(await within(library).findByText("New folder made")).toBeTruthy();
    expect(calls.some((call) => call.method === "POST" && call.url === "/api/v1/projects/folder/files/folder?name=figures")).toBe(true);
    fireEvent.click(within(library).getByRole("button", { name: "Undo adding figures" }));
    expect(await within(library).findByText("Folder taken back")).toBeTruthy();
    expect(calls.some((call) => call.method === "DELETE" && call.url === "/api/v1/projects/folder/files/folder?f=tok-made")).toBe(true);
  });

  it("downloads the folder as a zip after asking whether it can, and says when it cannot", async () => {
    stubWriter("zip");
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(`${this.getAttribute("href")} ${this.download}`); });
    render(<FilesLibrary projectId="zip" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    openViewMenu(library);
    fireEvent.click(screen.getByRole("button", { name: "Download this folder as a zip" }));
    await waitFor(() => expect(clicked).toEqual(["/api/v1/projects/zip/files/zip Alpha.zip"]));
    cleanup();

    stubWriter("big", "too_large");
    render(<FilesLibrary projectId="big" label="Alpha" onClose={() => {}} />);
    const again = screen.getByRole("dialog", { name: "Files" });
    await within(again).findByRole("button", { name: "Open notes.md" });
    openViewMenu(again);
    fireEvent.click(screen.getByRole("button", { name: "Download this folder as a zip" }));
    expect((await within(again).findByRole("alert")).textContent).toContain("too large to download as a zip");
    expect(clicked).toHaveLength(1);
  });

  it("uploads files dropped on the list, past the chat's 24 MB and up to 1 GB", async () => {
    const calls = stubWriter("drop");
    render(<FilesLibrary projectId="drop" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    const body = library.querySelector<HTMLElement>(".files-library-body")!;
    const big = new File(["abc"], "drop.bin");
    Object.defineProperty(big, "size", { value: MAX_VIEW_FILE + 1 });
    const huge = new File(["abc"], "huge.bin");
    Object.defineProperty(huge, "size", { value: 1024 * 1024 * 1024 + 1 });
    fireEvent.dragOver(body, { dataTransfer: { types: ["Files"], files: [] } });
    expect(body.classList.contains("files-dropping")).toBe(true);
    fireEvent.drop(body, { dataTransfer: { types: ["Files"], files: [big, huge] } });
    expect(body.classList.contains("files-dropping")).toBe(false);
    await waitFor(() => expect(calls.some((call) => call.method === "POST" && call.url.includes("/files/upload?name=drop.bin"))).toBe(true));
    expect(calls.some((call) => call.url.includes("name=huge.bin"))).toBe(false);
    expect(within(library).getByText(/larger than 1 GB/)).toBeTruthy();
  });
});

describe("Viewer — files the phone cannot draw", () => {
  beforeEach(() => {
    resetBackStackForTests();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["x"]), { status: 200 })));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("names an office file on a card with Save, not an empty screen", () => {
    const file = { name: "report.docx", kind: "application/octet-stream", size: 2048, modified: 1_770_000_000, ref: "tok-doc" };
    render(<OutboxViewer scope={{ files: "p1" }} file={file} onClose={() => {}} />);
    const viewer = screen.getByRole("dialog", { name: "report.docx" });
    const card = viewer.querySelector<HTMLElement>(".outbox-no-preview");
    expect(card?.textContent).toContain("cannot show this kind of file");
    expect(within(card!).getByRole("link", { name: "Save" }).getAttribute("href")).toBe("/api/v1/projects/p1/files/raw?f=tok-doc&download=1");
  });

  it("says a picture or PDF past a remote host's cap is too large, with nothing to save, share or mark up", () => {
    const fetch = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const markup = { tabId: "t1", projectId: "p1", onSend: () => false as const };
    for (const kind of ["image/png", "application/pdf"]) {
      const name = kind === "image/png" ? "huge.png" : "huge.pdf";
      const file = { name, kind, size: MAX_VIEW_FILE + 1, modified: 1_770_000_000, ref: `tok-${name}` };
      render(<OutboxViewer scope={{ files: "p1", on: "host" }} file={file} onClose={() => {}} markup={markup} />);
      const viewer = screen.getByRole("dialog", { name });
      expect(viewer.querySelector("img")).toBeNull();
      expect(viewer.textContent).toContain("larger than 24 MB");
      expect(within(viewer).queryByRole("link", { name: "Save" })).toBeNull();
      expect(within(viewer).queryByRole("button", { name: /^Share/ })).toBeNull();
      expect(within(viewer).queryByRole("button", { name: /Mark up/ })).toBeNull();
      cleanup();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("draws a big picture of this computer's, and past what the phone can hold offers Save only", () => {
    const big = { name: "scan.png", kind: "image/png", size: MAX_VIEW_FILE + 1, modified: 1_770_000_000, ref: "tok-scan" };
    render(<OutboxViewer scope={{ files: "p1" }} file={big} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "scan.png" }).querySelector("img")?.getAttribute("src")).toBe("/api/v1/projects/p1/files/raw?f=tok-scan");
    cleanup();
    const huge = { ...big, name: "huge.png", size: MAX_LOCAL_VIEW + 1 };
    render(<OutboxViewer scope={{ files: "p1" }} file={huge} onClose={() => {}} />);
    const viewer = screen.getByRole("dialog", { name: "huge.png" });
    expect(viewer.querySelector("img")).toBeNull();
    expect(viewer.textContent).toContain("larger than 200 MB");
    expect(within(viewer.querySelector<HTMLElement>(".outbox-no-preview")!).getByRole("link", { name: "Save" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/files/raw?f=tok-scan&download=1");
    expect(within(viewer).queryByRole("button", { name: /^Share/ })).toBeNull();
  });

  it("plays a film or a sound in the phone's player, whatever its size and side", () => {
    const film = { name: "talk.mp4", kind: "video/mp4", size: 900 * 1024 * 1024, modified: 1_770_000_000, ref: "tok-talk" };
    render(<OutboxViewer scope={{ files: "p1", on: "host" }} file={film} onClose={() => {}} />);
    const video = screen.getByRole("dialog", { name: "talk.mp4" }).querySelector("video");
    expect(video?.getAttribute("src")).toBe("/api/v1/projects/p1/files/raw?f=tok-talk&on=host");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.getAttribute("preload")).toBe("metadata");
    cleanup();
    const sound = { name: "memo.m4a", kind: "audio/mp4", size: 4096, modified: 1_770_000_000, ref: "tok-memo" };
    render(<OutboxViewer scope={{ files: "p1" }} file={sound} onClose={() => {}} />);
    expect(screen.getByRole("dialog", { name: "memo.m4a" }).querySelector("audio")?.getAttribute("src")).toBe("/api/v1/projects/p1/files/raw?f=tok-memo");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names a film the phone cannot play, or a HEIC it cannot decode, on the card with Save", () => {
    const film = { name: "clip.mov", kind: "video/quicktime", size: 4096, modified: 1_770_000_000, ref: "tok-clip" };
    render(<OutboxViewer scope={{ files: "p1" }} file={film} onClose={() => {}} />);
    fireEvent.error(screen.getByRole("dialog", { name: "clip.mov" }).querySelector("video")!);
    let viewer = screen.getByRole("dialog", { name: "clip.mov" });
    expect(viewer.querySelector("video")).toBeNull();
    expect(viewer.querySelector(".outbox-no-preview")?.textContent).toContain("cannot show this kind of file");
    cleanup();
    const markup = { tabId: "t1", projectId: "p1", onSend: () => false as const };
    const photo = { name: "IMG_1.heic", kind: "image/heic", size: 4096, modified: 1_770_000_000, ref: "tok-heic" };
    render(<OutboxViewer scope={{ files: "p1" }} file={photo} onClose={() => {}} markup={markup} />);
    viewer = screen.getByRole("dialog", { name: "IMG_1.heic" });
    expect(within(viewer).queryByRole("button", { name: /Mark up/ })).toBeNull();
    fireEvent.error(viewer.querySelector("img")!);
    expect(viewer.querySelector("img")).toBeNull();
    expect(within(viewer.querySelector<HTMLElement>(".outbox-no-preview")!).getByRole("link", { name: "Save" })).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("gives films and sounds their own tile, sorted after pictures", () => {
    expect(["video/mp4", "audio/mpeg", "image/heic", "application/octet-stream"].map(glyphOf)).toEqual(["media", "media", "image", "file"]);
    const view = { ...DEFAULT_LIBRARY_VIEW, sort: "kind" as const, foldersFirst: false };
    const rows = [
      { token: "a", name: "a.txt", kind: "text/plain; charset=utf-8", size: 1, modified: 1 },
      { token: "b", name: "b.mp4", kind: "video/mp4", size: 1, modified: 1 },
      { token: "c", name: "c.png", kind: "image/png", size: 1, modified: 1 },
    ];
    expect(sortEntries(rows, view).map((row) => row.name)).toEqual(["c.png", "b.mp4", "a.txt"]);
  });
});

/** A screen with an opener and the sheet it opens, as the library lays one. */
function SheetHost({ field = false }: { field?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div>
    <main>
      {field ? <input aria-label="Search" onFocus={() => setOpen(true)} /> : <button onClick={() => setOpen(true)}>Opener</button>}
    </main>
    {open && <OptionSheet title="Pick" waiting="" busy={false} onClose={() => setOpen(false)} onPick={() => setOpen(false)}
      options={[{ key: "a", label: "First", current: false }, { key: "b", label: "Second", current: false }]} />}
  </div>;
}

describe("Sheets — keyboard focus", () => {
  beforeEach(() => resetBackStackForTests());
  afterEach(() => cleanup());

  it("moves the focus to the first choice, keeps Tab inside, quiets the screen behind and gives the focus back", () => {
    render(<SheetHost />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    fireEvent.click(opener);
    const sheet = screen.getByRole("dialog", { name: "Pick" });
    const first = within(sheet).getByRole("button", { name: "First" });
    const second = within(sheet).getByRole("button", { name: "Second" });
    expect(document.activeElement).toBe(first);
    expect(opener.closest("main")?.hasAttribute("inert")).toBe(true);

    second.focus();
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(document.activeElement).toBe(within(sheet).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);

    fireEvent.click(first);
    expect(screen.queryByRole("dialog", { name: "Pick" })).toBeNull();
    expect(opener.closest("main")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("leaves a text field that opened it with the focus, so the phone's keyboard stays up", () => {
    render(<SheetHost field />);
    const field = screen.getByRole("textbox", { name: "Search" });
    act(() => field.focus());
    screen.getByRole("dialog", { name: "Pick" });
    expect(document.activeElement).toBe(field);
    expect(field.closest("main")?.hasAttribute("inert")).toBe(false);
  });
});

describe("Favorites page — groups hold still while names arrive", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps the stored order until every project is named, then sorts once", async () => {
    toggleFavorite("p1", { kind: "dir", name: "src", token: "t-src", trail: [] });
    toggleFavorite("p2", { kind: "application/pdf", name: "paper.pdf", token: "t-paper", trail: [] });
    const answers = new Map<string, (detail: unknown) => void>();
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request) => new Promise<Response>((resolve) => {
      const id = String(input).split("/").pop() ?? "";
      answers.set(id, (label) => resolve(reply({ project: { id, label, kind: "project" }, tabs: [] })));
    })));
    render(<FavoritesPage />);
    const order = () => Array.from(document.querySelectorAll(".home-favorites .files-list strong")).map((name) => name.textContent);
    const stored = order();
    expect(stored).toHaveLength(2);
    await waitFor(() => expect(answers.size).toBe(2));

    // Whichever project is named first, nothing moves yet — "Alpha" would
    // sort ahead of the other group's placeholder "Project".
    const later = stored[0] === "src" ? "p2" : "p1";
    const first = later === "p2" ? "p1" : "p2";
    await act(async () => { answers.get(first)?.(first === "p2" ? "Alpha" : "Zeta"); });
    await screen.findByRole("heading", { name: first === "p2" ? "Alpha" : "Zeta" });
    expect(order()).toEqual(stored);

    await act(async () => { answers.get(later)?.(later === "p2" ? "Alpha" : "Zeta"); });
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 }).map((head) => head.textContent)).toEqual(["Alpha", "Zeta"]));
    expect(order()).toEqual(["paper.pdf", "src"]);
  });
});

/** Every URL the stubbed desktop was asked, in order. */
const asked = () => (globalThis.fetch as unknown as { mock: { calls: [string | URL | Request][] } }).mock.calls.map(([url]) => String(url));

describe("Files library — reaching folders and files", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows the folders down to this one as a bar, and a tap on one goes there", async () => {
    stubHost("bar");
    render(<FilesLibrary projectId="bar" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    expect(within(library).queryByRole("navigation", { name: "Folders" })).toBeNull();
    fireEvent.click(within(library).getByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    const bar = within(library).getByRole("navigation", { name: "Folders" });
    expect(bar.querySelector("[aria-current]")?.textContent).toBe("src");
    fireEvent.click(within(bar).getByRole("button", { name: "Alpha" }));
    await within(library).findByRole("button", { name: "Open notes.md" });
  });

  it("lists the folder again on Refresh and when a file opened from it closes", async () => {
    stubHost("again");
    render(<FilesLibrary projectId="again" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    await within(library).findByRole("button", { name: "Open notes.md" });
    const listings = () => asked().filter((url) => url === "/api/v1/projects/again/files").length;
    expect(listings()).toBe(1);

    fireEvent.click(within(library).getByRole("button", { name: "View options" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "View options" })).getByRole("button", { name: "Refresh this folder" }));
    await waitFor(() => expect(listings()).toBe(2));

    fireEvent.click(within(library).getByRole("button", { name: "Open notes.md" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(listings()).toBe(3));
    // The rows stood the whole time: a re-list does not blank the folder.
    expect(within(library).getByRole("button", { name: "Open notes.md" })).toBeTruthy();
  });

  it("opens an item's menu on a long-press or a right-click, and the press opens nothing", async () => {
    stubHost("hold");
    render(<FilesLibrary projectId="hold" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    const notes = await within(library).findByRole("button", { name: "Open notes.md" });
    fireEvent.pointerDown(notes, { button: 0, clientX: 10, clientY: 10 });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); });
    expect(screen.getByRole("dialog", { name: "notes.md" }).querySelector(".option-list")).toBeTruthy();
    fireEvent.pointerUp(notes);
    fireEvent.click(notes);
    expect(screen.queryByRole("dialog", { name: "notes.md" })?.querySelector("pre")).toBeFalsy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "notes.md" })).getByRole("button", { name: "Close" }));

    fireEvent.contextMenu(within(library).getByRole("button", { name: "Open the folder src" }));
    expect(screen.getByRole("dialog", { name: "src" })).toBeTruthy();
  });

  it("shows the recent files from a link at the root, keyboard down, and hides them again", async () => {
    stubHost("recent");
    recordRecent(filesPlaceId("recent", "here"), { token: "tok-notes", name: "notes.md", kind: "text/plain; charset=utf-8", size: 8, modified: 1, trail: [] });
    render(<FilesLibrary projectId="recent" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(library).findByRole("button", { name: "Recent files (1)" }));
    const recent = within(library).getByRole("region", { name: "Recent" });
    expect(document.activeElement).not.toBe(within(library).getByRole("searchbox"));
    expect(within(recent).getByRole("button", { name: "Open notes.md" })).toBeTruthy();
    fireEvent.click(within(recent).getByRole("button", { name: "Hide" }));
    expect(within(library).queryByRole("region", { name: "Recent" })).toBeNull();
  });

  it("says a folder past the cap is sorted only among the first entries by name", async () => {
    writeLibraryView({ ...DEFAULT_LIBRARY_VIEW, sort: "modified" });
    vi.stubGlobal("fetch", vi.fn(async () => reply({ ...ROOT, truncated: true })));
    render(<FilesLibrary projectId="cap" label="Alpha" onClose={() => {}} />);
    expect(await screen.findByText(/first 2 entries by name, sorted among themselves/)).toBeTruthy();
  });
});

describe("Files library — search inside a folder, and what git ignores", () => {
  beforeEach(() => {
    localStorage.clear();
    resetBackStackForTests();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("asks inside the folder and for ignored files from its chips, and keeps an older desktop's hits inside", async () => {
    const outside = { token: "tok-o", name: "main.txt", kind: "text/plain; charset=utf-8", size: 1, modified: 1, trail: [] };
    const inside = { ...SRC.entries[0], trail: [{ token: "tok-src", name: "src" }] };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "/api/v1/projects/chips/files") return reply(ROOT);
      if (url === "/api/v1/projects/chips/files?dir=tok-src") return reply(SRC);
      // An older desktop: the scope is not heard, the whole project answers.
      if (url.startsWith("/api/v1/projects/chips/files/search")) return reply({ hits: [outside, inside], truncated: false });
      return reply({ error: "file_not_found" }, 404);
    }));
    render(<FilesLibrary projectId="chips" label="Alpha" onClose={() => {}} />);
    const library = screen.getByRole("dialog", { name: "Files" });
    fireEvent.click(await within(library).findByRole("button", { name: "Open the folder src" }));
    await within(library).findByRole("button", { name: "Open main.rs" });
    fireEvent.change(within(library).getByRole("searchbox"), { target: { value: "main" } });
    await within(library).findByRole("button", { name: "Open main.txt" });

    fireEvent.click(within(library).getByRole("button", { name: "Only in src" }));
    await waitFor(() => expect(asked()).toContain("/api/v1/projects/chips/files/search?q=main&dir=tok-src"));
    await waitFor(() => expect(within(library).queryByRole("button", { name: "Open main.txt" })).toBeNull());
    expect(within(library).getByRole("button", { name: "Open main.rs" })).toBeTruthy();

    fireEvent.click(within(library).getByRole("button", { name: "Include ignored files" }));
    await waitFor(() => expect(asked()).toContain("/api/v1/projects/chips/files/search?q=main&dir=tok-src&ignored=1"));
  });

  it("sorts names in the app's language", () => {
    const entries = ["zeta", "äpfel"].map((name) => ({ token: name, name, kind: "text/plain", size: 1, modified: 1 }));
    const view = { sort: "name" as const, desc: false, foldersFirst: true };
    expect(sortEntries(entries, view, "de").map((entry) => entry.name)).toEqual(["äpfel", "zeta"]);
    expect(sortEntries(entries, view, "sv").map((entry) => entry.name)).toEqual(["zeta", "äpfel"]);
  });
});
