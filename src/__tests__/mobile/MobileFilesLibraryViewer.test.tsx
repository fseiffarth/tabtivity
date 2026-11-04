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

import { ApiError, MAX_VIEW_FILE } from "../../../mobile-web/src/api";
import { resetBackStackForTests } from "../../../mobile-web/src/backStack";
import { FavoritesPage } from "../../../mobile-web/src/components/FavoritesPage";
import { FilesLibrary, failureKey } from "../../../mobile-web/src/components/FilesLibrary";
import { OptionSheet } from "../../../mobile-web/src/components/OptionSheet";
import { OutboxViewer } from "../../../mobile-web/src/components/OutboxViewer";
import { toggleFavorite } from "../../../mobile-web/src/filesPlace";

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

  it("says a picture or PDF past the desktop's cap is too large, with nothing to save, share or mark up", () => {
    const fetch = vi.fn(async () => new Response(new Blob(["x"]), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const markup = { tabId: "t1", projectId: "p1", onSend: () => false as const };
    for (const kind of ["image/png", "application/pdf"]) {
      const name = kind === "image/png" ? "huge.png" : "huge.pdf";
      const file = { name, kind, size: MAX_VIEW_FILE + 1, modified: 1_770_000_000, ref: `tok-${name}` };
      render(<OutboxViewer scope={{ files: "p1" }} file={file} onClose={() => {}} markup={markup} />);
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
