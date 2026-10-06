/**
 * The project screen's way to what was sent this project with `tabtivity-send`
 * (`.tabtivity/outbox/`): the 🖼 in the dropdown under its name, which opens the same gallery
 * sheet the Focus screen does. There is no shelf under the tab cards any more
 * — it showed the same files a second time, under another name.
 *
 * The files belong to the project, not to one of its sessions, so this screen
 * reads them by the project id — a file sent from a tab that has since been
 * closed is still there.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

const TABS = [
  { id: "t-agent", label: "Claude", kind: "agent", available: true, viewer_busy: false },
];

function hostWith(files: unknown[]) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") {
      return new Response(JSON.stringify({ files }), { status: 200 });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: TABS,
    }), { status: 200 });
  });
}

const picture = (name: string, modified: number) => ({ name, kind: "image/png", size: 48_000, modified });

/** Opens the gallery from the dropdown under the project's name, whose row counts the files. */
async function openGallery(count: number) {
  fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
  fireEvent.click(await screen.findByRole("menuitem", { name: `Files from the agent (${count})` }));
  return screen.getByRole("dialog", { name: "Files from the agent" });
}

describe("Mobile project — the files the agent sent", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reaches them from the header, by the project, with no second shelf under the tabs", async () => {
    vi.stubGlobal("fetch", hostWith([
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    // The header row keeps no 🖼 of its own: the name opens a dropdown that has it.
    const header = document.querySelector("header") as HTMLElement;
    const name = await within(header).findByRole("button", { name: "Alpha" });
    expect(within(header).queryByRole("button", { name: /^Files from the agent/ })).toBeNull();
    fireEvent.click(name);
    const button = within(screen.getByRole("menu", { name: "Project menu" })).getByRole("menuitem", { name: "Files from the agent (2)" });
    expect(document.querySelector(".outbox-shelf")).toBeNull();
    expect(screen.queryByText("From the desktop")).toBeNull();

    fireEvent.click(button);
    const gallery = screen.getByRole("dialog", { name: "Files from the agent" });
    expect(gallery.textContent).toContain("2 files in the project's outbox");
    expect(Array.from(gallery.querySelectorAll(".outbox-entry strong")).map((name) => name.textContent))
      .toEqual(["plot.png", "notes.txt"]);
    expect(gallery.querySelector("img")?.getAttribute("src")).toBe("/api/v1/projects/p1/outbox/plot.png");

    // The picture opens full screen, from the same project-scoped URL.
    fireEvent.click(within(gallery).getByRole("button", { name: "Open plot.png" }));
    expect(screen.getByRole("dialog", { name: "plot.png" }).querySelector("img")?.getAttribute("src"))
      .toBe("/api/v1/projects/p1/outbox/plot.png");
  });

  it("lists every file, and opens a PDF in the app's own page view", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("fetch", hostWith([
      { name: "paper.pdf", kind: "application/pdf", size: 4_000, modified: 1_770_000_009 },
      ...Array.from({ length: 7 }, (_, i) => picture(`shot-${i}.png`, 1_770_000_000 - i)),
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(8);
    expect(gallery.querySelectorAll(".outbox-entry").length).toBe(8);

    fireEvent.click(within(gallery).getByRole("button", { name: "Open paper.pdf" }));
    // Never the phone's own PDF viewer: the installed app is not got back to
    // from there. ✕ comes back to the gallery.
    const viewer = await screen.findByRole("dialog", { name: "paper.pdf" });
    expect(within(viewer).getByTitle("pdf")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close" }));

    fireEvent.click(within(await screen.findByRole("dialog", { name: "Files from the agent" })).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Files from the agent" })).toBeNull());
  });

  it("offers Save on every tile, the picture included", async () => {
    vi.stubGlobal("fetch", hostWith([
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(2);
    // A thumbnail carries no ⋯, so saving a picture meant opening it full
    // screen first and finding Save in there.
    const save = within(gallery).getByRole("link", { name: "Save plot.png" });
    expect(save.getAttribute("href")).toBe("/api/v1/projects/p1/outbox/plot.png?download=1");
    expect(save.getAttribute("download")).toBe("plot.png");
    expect(within(gallery).getByRole("link", { name: "Save notes.txt" }).getAttribute("href"))
      .toBe("/api/v1/projects/p1/outbox/notes.txt?download=1");
  });

  it("deletes a file from its tile, after asking, and drops the tile without waiting for a poll", async () => {
    const calls: string[] = [];
    let files = [
      picture("plot.png", 1_770_000_000),
      { name: "notes.txt", kind: "text/plain", size: 900, modified: 1_769_999_000 },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files }), { status: 200 });
      if (url.startsWith("/api/v1/projects/p1/outbox/")) {
        files = files.filter((file) => !url.endsWith(`/${file.name}`));
        return new Response(JSON.stringify({ removed: true }), { status: 200 });
      }
      return new Response(JSON.stringify({
        project: { id: "p1", label: "Alpha", status: "active" },
        desktop_available: true,
        agents: [],
        tabs: TABS,
      }), { status: 200 });
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(2);
    // One tap does not delete: the 🗑 sits a thumb-width from the tile that
    // opens the picture, and nothing here can be undone.
    fireEvent.click(within(gallery).getByRole("button", { name: "Delete plot.png" }));
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(gallery).getByRole("button", { name: "Keep" }));
    expect(within(gallery).getByRole("button", { name: "Delete plot.png" })).toBeTruthy();

    fireEvent.click(within(gallery).getByRole("button", { name: "Delete plot.png" }));
    fireEvent.click(within(within(gallery).getByRole("group", { name: "Delete plot.png?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain("DELETE /api/v1/projects/p1/outbox/plot.png"));
    // Gone at once, and the counts with it — the poll is 8 s away.
    await waitFor(() => expect(Array.from(gallery.querySelectorAll(".outbox-entry strong")).map((n) => n.textContent)).toEqual(["notes.txt"]));
    expect(gallery.textContent).toContain("1 file in the project's outbox");
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(screen.getByRole("menuitem", { name: "Files from the agent (1)" })).toBeTruthy();
  });

  it("keeps the tile when the sidecar refuses the delete", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/projects/p1/outbox") {
        return new Response(JSON.stringify({ files: [picture("plot.png", 1_770_000_000)] }), { status: 200 });
      }
      if (init?.method === "DELETE") return new Response(JSON.stringify({ error: "delete_failed" }), { status: 500 });
      return new Response(JSON.stringify({
        project: { id: "p1", label: "Alpha", status: "active" },
        desktop_available: true,
        agents: [],
        tabs: TABS,
      }), { status: 200 });
    }));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    const gallery = await openGallery(1);
    fireEvent.click(within(gallery).getByRole("button", { name: "Delete plot.png" }));
    fireEvent.click(within(within(gallery).getByRole("group", { name: "Delete plot.png?" })).getByRole("button", { name: "Delete" }));

    // A file that is still there must not read as gone.
    expect((await within(gallery).findByRole("alert")).textContent).toBe("The file could not be deleted.");
    expect(Array.from(gallery.querySelectorAll(".outbox-entry strong")).map((n) => n.textContent)).toEqual(["plot.png"]);
  });

  it("shows no 🖼 at all when nothing was sent", async () => {
    vi.stubGlobal("fetch", hostWith([]));
    render(<Project id="p1" back={() => {}} terminal={() => {}} />);

    await screen.findByRole("button", { name: "Open Claude" });
    expect(screen.queryByRole("button", { name: /^Files from the agent/ })).toBeNull();
    // Nor a 🖼 entry in the name's dropdown, which a project now always has
    // for its ⎇ Git overview.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    const menu = screen.getByRole("menu", { name: "Project menu" });
    expect(within(menu).queryByRole("menuitem", { name: /^Files from the agent/ })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: /^Git/ })).toBeTruthy();
  });
});
