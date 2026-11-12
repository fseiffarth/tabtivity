/**
 * Home's Favorites segment (`FavoritesPage`): what was starred in any project,
 * grouped by project, opened by its folder's listing.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FavoritesPage } from "../../../mobile-web/src/components/FavoritesPage";
import { filesPlaceId, readFavorites, readFilesPlace, setFolderColor, toggleFavorite } from "../../../mobile-web/src/filesPlace";

vi.mock("../../../mobile-web/src/components/OutboxViewer", () => ({
  OutboxViewer: ({ file, scope, onClose }: { file: { name: string; ref?: string }; scope: unknown; onClose: () => void }) =>
    <div data-testid="viewer" data-ref={file.ref} data-scope={JSON.stringify(scope)}><button onClick={onClose}>Close viewer</button></div>,
}));

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const detail = (label: string, host_label?: string) => ({ project: { id: "x", label, kind: "project" }, tabs: [], host_label });

function host(routes: Record<string, () => Response>) {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    return route ? routes[route]() : reply({ error: "not_found" }, 404);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** The row's own button, not its ⋯ ("More for …"). */
const PAPER = /^(?!More for).*paper\.pdf/;
const SRC = /^(?!More for).*src/;
const PDF = { kind: "application/pdf", name: "paper.pdf", token: "old", trail: [{ token: "t-docs", name: "docs" }] };
const FOLDER = { kind: "dir", name: "src", token: "t-src", trail: [] };

describe("Favorites page", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("says how to star something while nothing is starred, asking nothing", () => {
    const fetch = host({});
    render(<FavoritesPage />);
    expect(screen.getByText("No favorites yet")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("groups by project, keeps a remote side apart and wears a folder's colour", async () => {
    toggleFavorite("p2", PDF);
    toggleFavorite("p1", FOLDER);
    toggleFavorite(filesPlaceId("p1", "host"), PDF);
    setFolderColor("p1", "src", "green");
    host({ "/api/v1/projects/p1": () => reply(detail("Alpha", "cluster")), "/api/v1/projects/p2": () => reply(detail("Beta")) });
    render(<FavoritesPage />);
    await screen.findByRole("region", { name: "Beta" });
    expect(screen.getAllByRole("heading", { level: 3 }).map((head) => head.textContent)).toEqual(["Alpha", "Alpha · cluster", "Beta"]);
    const folder = within(screen.getByRole("region", { name: "Alpha" })).getByRole("button", { name: SRC });
    expect(folder.querySelector<HTMLElement>(".files-icon")?.getAttribute("style")).toContain("background");
  });

  it("opens a file by its one row, under its fresh token and back to the page", async () => {
    toggleFavorite("p1", PDF);
    const fresh = { name: "paper.pdf", kind: "application/pdf", size: 3, modified: 5, token: "fresh" };
    const fetch = host({
      "/api/v1/projects/p1/files/entry": () => reply({ entry: fresh }),
      "/api/v1/projects/p1/files": () => reply({ entries: [fresh], truncated: false }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: PAPER }));
    const viewer = await screen.findByTestId("viewer");
    expect(viewer.dataset.ref).toBe("fresh");
    expect(JSON.parse(viewer.dataset.scope ?? "{}")).toEqual({ files: "p1" });
    const asked = fetch.mock.calls.map(([url]) => String(url));
    expect(asked).toContain("/api/v1/projects/p1/files/entry?name=paper.pdf&dir=t-docs");
    expect(asked).not.toContain("/api/v1/projects/p1/files?dir=t-docs");
    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    expect(screen.queryByTestId("viewer")).toBeNull();
    expect(screen.getByRole("button", { name: PAPER })).toBeTruthy();
  });

  it("asks an older desktop with no row route by listing the folder, as before", async () => {
    toggleFavorite("p1", PDF);
    const fresh = { name: "paper.pdf", kind: "application/pdf", size: 3, modified: 5, token: "fresh" };
    const fetch = host({
      "/api/v1/projects/p1/files/entry": () => new Response(null, { status: 404 }),
      "/api/v1/projects/p1/files": () => reply({ entries: [fresh], truncated: false }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: PAPER }));
    expect((await screen.findByTestId("viewer")).dataset.ref).toBe("fresh");
    expect(fetch.mock.calls.map(([url]) => String(url))).toContain("/api/v1/projects/p1/files?dir=t-docs");
  });

  it("does not open a file that now stands where a starred folder was", async () => {
    toggleFavorite("p1", FOLDER);
    host({
      "/api/v1/projects/p1/files/entry": () => reply({ entry: { name: "src", kind: "text/plain; charset=utf-8", size: 1, modified: 1, token: "t-file" } }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: SRC }));
    expect((await screen.findByRole("dialog", { name: "src" })).textContent).toContain("was moved or deleted");
  });

  it("opens a folder as the library standing in it", async () => {
    toggleFavorite("p1", FOLDER);
    host({
      "/api/v1/projects/p1/files/entry": () => reply({ entry: { name: "src", kind: "dir", size: 0, modified: 1, token: "t-src2" } }),
      "/api/v1/projects/p1/files": () => reply({ entries: [{ name: "src", kind: "dir", size: 0, modified: 1, token: "t-src2" }], truncated: false }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: SRC }));
    await screen.findByRole("dialog", { name: "Files" });
    expect(readFilesPlace("p1")).toEqual([{ token: "t-src2", name: "src" }]);
  });

  it("dims a moved favorite and offers to remove it", async () => {
    toggleFavorite("p1", PDF);
    host({
      "/api/v1/projects/p1/files/entry": () => reply({ error: "file_not_found" }, 404),
      "/api/v1/projects/p1/files": () => reply({ entries: [], truncated: false }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: PAPER }));
    const sheet = await screen.findByRole("dialog", { name: "paper.pdf" });
    expect(sheet.textContent).toContain("was moved or deleted");
    fireEvent.click(within(sheet).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(readFavorites("p1")).toEqual([]));
    expect(await screen.findByText("No favorites yet")).toBeTruthy();
  });

  it("keeps a project no longer shared, names that and says so at the tap", async () => {
    toggleFavorite("p1", PDF);
    host({
      "/api/v1/projects/p1/files": () => reply({ error: "project_not_found" }, 404),
      "/api/v1/projects/p1": () => reply({ error: "project_not_found" }, 404),
    });
    render(<FavoritesPage />);
    expect(await screen.findByRole("heading", { name: "No longer shared" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: PAPER }));
    expect((await screen.findByRole("alert")).textContent).toContain("no longer shared with this phone");
    expect(readFavorites("p1")).toHaveLength(1);
  });

  it("says the desktop's switch is off at the tap, keeping the list", async () => {
    toggleFavorite("p1", PDF);
    host({
      "/api/v1/projects/p1/files": () => reply({ error: "files_off" }, 404),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: PAPER }));
    expect((await screen.findByRole("alert")).textContent).toContain("switched off");
    expect(screen.getByRole("button", { name: PAPER })).toBeTruthy();
  });

  it("unstars from an item's menu and shows a file's folder", async () => {
    toggleFavorite("p1", PDF);
    host({
      "/api/v1/projects/p1/files": () => reply({ entries: [], truncated: false }),
      "/api/v1/projects/p1": () => reply(detail("Alpha")),
    });
    render(<FavoritesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "More for paper.pdf" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "paper.pdf" })).getByRole("button", { name: "Show in folder" }));
    await screen.findByRole("dialog", { name: "Files" });
    expect(readFilesPlace("p1")).toEqual(PDF.trail);
  });
});
