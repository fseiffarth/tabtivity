/**
 * Arranging the phone's project list by hand.
 *
 * Unlike the tab order this one never leaves the phone: it is a `localStorage`
 * preference, so a drag needs no desktop and the Tabtivity window's own project
 * pills are left where their owner put them. Three things are worth pinning:
 * the remembered order wins over the host's while the host's stays the fallback
 * for a project that has never been placed, a move survives the re-mount every
 * tab switch causes, and a search result is not arranged at all.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../../mobile-web/src/screens/Home";
import { arrangeProjects, mergeProjectOrder, scopeCaption } from "../../../mobile-web/src/projectOrder";
import { readOrder, writeOrder } from "../../../mobile-web/src/prefs";
import { storageKey } from "../../lib/brand";

describe("Mobile scope caption", () => {
  it("names a box and the root console instead of a status, and counts root's waiting proposals", () => {
    expect(scopeCaption({ kind: "project", status: "active" })).toBe("active");
    expect(scopeCaption({ status: "paused" })).toBe("paused");
    expect(scopeCaption({ kind: "box", status: "active" })).toBe("⬡ box");
    expect(scopeCaption({ kind: "root", status: "active", pending_reviews: 0 })).toBe("★ root");
    expect(scopeCaption({ kind: "root", status: "active", pending_reviews: 2 })).toBe("★ root · 2 awaiting approval at the desk");
  });
});

describe("Mobile project order — the list surgery", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const ids = (list: { id: string }[]) => list.map((row) => row.id);

  it("puts placed projects first and leaves the rest in the host's order", () => {
    expect(ids(arrangeProjects(rows, (row) => row.id, ["c", "a"]))).toEqual(["c", "a", "b"]);
    // Nothing placed: the list is the host's, untouched.
    expect(ids(arrangeProjects(rows, (row) => row.id, []))).toEqual(["a", "b", "c"]);
    // A project that has only just become active joins the end rather than
    // landing in the middle of a list arranged by hand.
    expect(ids(arrangeProjects([...rows, { id: "new" }], (row) => row.id, ["c", "b", "a"]))).toEqual(["c", "b", "a", "new"]);
  });

  it("folds the new on-screen order into the stored one", () => {
    expect(mergeProjectOrder([], ["b", "a"])).toEqual(["b", "a"]);
    expect(mergeProjectOrder(["a", "b", "c"], ["c", "b", "a"])).toEqual(["c", "b", "a"]);
  });

  it("keeps a project that is not listed right now at its own place", () => {
    // `idle` has no live session, so the active list does not carry it. A drag
    // among the listed ones must not demote it: it sat first and stays first.
    expect(mergeProjectOrder(["idle", "a", "b"], ["b", "a"])).toEqual(["idle", "b", "a"]);
    expect(mergeProjectOrder(["a", "idle", "b"], ["b", "a"])).toEqual(["b", "a", "idle"]);
    // None of the listed projects has ever been placed: they lead, because they
    // are the ones being looked at.
    expect(mergeProjectOrder(["idle"], ["b", "a"])).toEqual(["b", "a", "idle"]);
  });

  it("reads a stored order back, and treats a spoilt one as nothing placed", () => {
    writeOrder("projectOrder", ["p2", "p1"]);
    expect(readOrder("projectOrder")).toEqual(["p2", "p1"]);
    localStorage.setItem(storageKey("mobile.projectOrder"), "{\"p1\":1}");
    expect(readOrder("projectOrder")).toEqual([]);
    localStorage.setItem(storageKey("mobile.projectOrder"), "[\"p1\",7]");
    expect(readOrder("projectOrder")).toEqual([]);
  });
});

describe("Mobile home — arranging projects by hand", () => {
  const PROJECTS = [
    { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
    { id: "p2", label: "Beta", status: "active", live_sessions: 0 },
    { id: "p3", label: "Gamma", status: "active", live_sessions: 0 },
  ];

  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    if (url.includes("view=search")) return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
  });

  const listed = () => screen.getAllByRole("button")
    .filter((node) => node.classList.contains("card"))
    .map((node) => node.querySelector("strong")?.textContent);

  const noop = () => {};
  const home = () => render(<Home open={noop} openTab={noop} todo={noop} mail={noop} />);

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("moves a project one place from the grip's arrow keys and remembers it", async () => {
    home();
    await screen.findByText("Alpha");
    expect(listed()).toEqual(["Alpha", "Beta", "Gamma"]);

    fireEvent.keyDown(screen.getByLabelText("Move Alpha"), { key: "ArrowDown" });
    await waitFor(() => expect(listed()).toEqual(["Beta", "Alpha", "Gamma"]));
    // Stored, not sent: no request left the phone for this.
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.projectOrder")) ?? "[]")).toEqual(["p2", "p1", "p3"]);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method)).toBe(false);

    // The last row has nowhere below it: nothing moves.
    fireEvent.keyDown(screen.getByLabelText("Move Gamma"), { key: "ArrowDown" });
    await waitFor(() => expect(listed()).toEqual(["Beta", "Alpha", "Gamma"]));
  });

  it("opens in the remembered order after the re-mount a tab switch causes", async () => {
    writeOrder("projectOrder", ["p3", "p1", "p2"]);
    home();
    await screen.findByText("Alpha");
    expect(listed()).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("still opens the project the row is for", async () => {
    const opened: string[] = [];
    render(<Home open={(id) => opened.push(id)} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByText("Alpha"));
    expect(opened).toEqual(["p1"]);
  });

  it("offers no grip on a search result, which is an answer rather than a list", async () => {
    home();
    await screen.findByText("Alpha");
    expect(screen.getByLabelText("Move Alpha")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(screen.queryByLabelText("Move Alpha")).toBeNull());
  });
});
