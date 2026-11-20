/**
 * Favorites, hidden projects and named groups on the phone's project list.
 *
 * All three are the phone's own (`projectGroups.ts`): stored in
 * `localStorage`, never sent. Worth pinning: which section a project is drawn
 * in when it is more than one thing at once, that a group lives exactly as
 * long as it holds a project, that a spoilt store reads as nothing sorted, and
 * that the hold sheet on Home really moves rows between sections.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Home } from "../../../mobile-web/src/screens/Home";
import {
  EMPTY_SORTING, cleanGroupName, createGroup, moveToGroup, parseSorting, placeInSection, readProjectSorting,
  renameGroup, sectionProjects, setFavorite, setHidden, shiftGroup, ungroup, writeProjectSorting,
} from "../../../mobile-web/src/projectGroups";
import { storageKey } from "../../lib/brand";

const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const idOf = (row: { id: string }) => row.id;

describe("Mobile project groups — the model", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  it("draws hidden over favorite over group, each section in the list's own order", () => {
    let sorting = createGroup(EMPTY_SORTING, "Teaching", "d", "g1");
    sorting = moveToGroup(sorting, "b", "g1");
    sorting = setFavorite(sorting, "c", true);
    sorting = setFavorite(sorting, "b", true);
    sorting = setHidden(sorting, "e", true);
    // A hidden favorite stays hidden; unhiding brings it back as a favorite.
    sorting = setFavorite(sorting, "e", true);
    const out = sectionProjects(rows, idOf, sorting);
    expect(ids(out.favorites)).toEqual(["b", "c"]);
    expect(out.groups.map(({ group, rows: members }) => [group.name, ids(members)])).toEqual([["Teaching", ["d"]]]);
    expect(ids(out.loose)).toEqual(["a"]);
    expect(ids(out.hidden)).toEqual(["e"]);
    expect(ids(sectionProjects(rows, idOf, setHidden(sorting, "e", false)).favorites)).toEqual(["b", "c", "e"]);
  });

  it("leaves out a group none of the listed rows sits in", () => {
    const sorting = createGroup(EMPTY_SORTING, "Idle", "not-listed", "g1");
    expect(sectionProjects(rows, idOf, sorting).groups).toEqual([]);
    expect(sorting.groups).toHaveLength(1);
  });

  it("drops a group with its last project, and dissolves one on Ungroup", () => {
    let sorting = createGroup(EMPTY_SORTING, "One", "a", "g1");
    sorting = moveToGroup(sorting, "b", "g1");
    sorting = moveToGroup(sorting, "a", null);
    expect(sorting.groups.map((group) => group.id)).toEqual(["g1"]);
    sorting = moveToGroup(sorting, "b", null);
    expect(sorting.groups).toEqual([]);

    let two = createGroup(EMPTY_SORTING, "Two", "a", "g2");
    two = moveToGroup(two, "c", "g2");
    two = ungroup(two, "g2");
    expect(two.groups).toEqual([]);
    expect(two.member).toEqual({});
  });

  it("names, renames and orders groups", () => {
    expect(cleanGroupName("  Research \n stuff ")).toBe("Research stuff");
    expect(cleanGroupName("   ")).toBe("");
    expect(createGroup(EMPTY_SORTING, "  ", "a")).toBe(EMPTY_SORTING);
    let sorting = createGroup(EMPTY_SORTING, "One", "a", "g1");
    sorting = createGroup(sorting, "Two", "b", "g2");
    sorting = renameGroup(sorting, "g1", " First ");
    sorting = shiftGroup(sorting, "g2", -1);
    expect(sorting.groups).toEqual([{ id: "g2", name: "Two" }, { id: "g1", name: "First" }]);
    // Already first: nothing moves.
    expect(shiftGroup(sorting, "g2", -1)).toBe(sorting);
  });

  it("moves a dropped project into the section it landed in", () => {
    let sorting = createGroup(EMPTY_SORTING, "One", "a", "g1");
    sorting = placeInSection(sorting, "b", { kind: "favorites" });
    expect(sorting.favorites).toEqual(["b"]);
    sorting = placeInSection(sorting, "b", { kind: "group", id: "g1" });
    expect(sorting.favorites).toEqual([]);
    expect(sorting.member.b).toBe("g1");
    sorting = placeInSection(sorting, "b", { kind: "loose" });
    expect(sorting.member.b).toBeUndefined();
  });

  it("reads back what it stored, and a spoilt store as nothing sorted, field by field", () => {
    const sorting = setHidden(createGroup(EMPTY_SORTING, "One", "a", "g1"), "z", true);
    writeProjectSorting(sorting);
    expect(readProjectSorting()).toEqual(sorting);
    localStorage.setItem(storageKey("mobile.projectSorting"), "[1,2]");
    expect(readProjectSorting()).toEqual(EMPTY_SORTING);
    expect(parseSorting({ favorites: "a", hidden: ["h"], groups: [{ id: "g1", name: "One" }, { id: 3 }], member: { a: "g1", b: "gone" }, folded: ["g1", "gone"] }))
      .toEqual({ favorites: [], hidden: ["h"], groups: [{ id: "g1", name: "One" }], member: { a: "g1" }, folded: ["g1"] });
  });
});

describe("Mobile home — favorites, groups and hiding", () => {
  const PROJECTS = [
    { id: "p1", label: "Alpha", status: "active", live_sessions: 1 },
    { id: "p2", label: "Beta", status: "active", live_sessions: 0 },
    { id: "p3", label: "Gamma", status: "active", live_sessions: 0 },
  ];
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/v1/activity")) return new Response(JSON.stringify({ tabs: [] }), { status: 200 });
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
  });
  const listed = () => screen.getAllByRole("button")
    .filter((node) => node.classList.contains("card"))
    .map((node) => node.querySelector("strong")?.textContent);
  const noop = () => {};
  const home = () => render(<Home tabby={noop} open={noop} openTab={noop} todo={noop} mail={noop} />);
  const hold = (label: string) => fireEvent.contextMenu(screen.getByText(label).closest("button")!);
  const sheet = () => within(screen.getByRole("dialog"));

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    fetchMock.mockClear();
  });

  it("stars a project from its hold sheet into a Favorites section on top", async () => {
    home();
    await screen.findByText("Gamma");
    hold("Gamma");
    fireEvent.click(sheet().getByText("Add to favorites"));
    await waitFor(() => expect(listed()).toEqual(["Gamma", "Alpha", "Beta"]));
    expect(screen.getByRole("heading", { name: /Favorites/ })).toBeTruthy();
    expect(screen.getByText("Other projects")).toBeTruthy();
    // Stored, not sent.
    expect(JSON.parse(localStorage.getItem(storageKey("mobile.projectSorting")) ?? "{}").favorites).toEqual(["p3"]);
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method)).toBe(false);
  });

  it("hides a project into the Hidden fold, and brings it back from there", async () => {
    home();
    await screen.findByText("Beta");
    hold("Beta");
    fireEvent.click(sheet().getByText("Hide from the list"));
    await waitFor(() => expect(listed()).toEqual(["Alpha", "Gamma"]));
    fireEvent.click(screen.getByText("Hidden (1)"));
    hold("Beta");
    fireEvent.click(sheet().getByText("Show in the list"));
    await waitFor(() => expect(listed()).toEqual(["Alpha", "Beta", "Gamma"]));
    expect(screen.queryByText("Hidden (1)")).toBeNull();
  });

  it("makes a new group from the sheet, folds it, and dissolves it", async () => {
    home();
    await screen.findByText("Alpha");
    hold("Alpha");
    fireEvent.click(sheet().getByText("Move to group"));
    fireEvent.click(sheet().getByText("New group"));
    fireEvent.change(sheet().getByLabelText("Name"), { target: { value: "Teaching" } });
    fireEvent.click(sheet().getByText("Save"));
    const head = await screen.findByRole("button", { name: /Teaching/ });
    expect(listed()).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(head.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(head);
    await waitFor(() => expect(listed()).toEqual(["Beta", "Gamma"]));

    fireEvent.contextMenu(head);
    fireEvent.click(sheet().getByText("Ungroup"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Teaching/ })).toBeNull());
    expect(listed()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("moves a row across into another section with the grip's arrow keys", async () => {
    writeProjectSorting(setFavorite(EMPTY_SORTING, "p1", true));
    home();
    await screen.findByText("Alpha");
    expect(listed()).toEqual(["Alpha", "Beta", "Gamma"]);
    // Beta is the first ungrouped row; one step up lands it beside the
    // favorite, so it becomes one.
    fireEvent.keyDown(screen.getByLabelText("Move Beta"), { key: "ArrowUp" });
    await waitFor(() => expect(JSON.parse(localStorage.getItem(storageKey("mobile.projectSorting")) ?? "{}").favorites).toContain("p2"));
    expect(listed()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("still opens the project on a tap", async () => {
    const opened: string[] = [];
    render(<Home tabby={noop} open={(id) => opened.push(id)} openTab={noop} todo={noop} mail={noop} />);
    await screen.findByText("Alpha");
    fireEvent.click(screen.getByText("Alpha"));
    expect(opened).toEqual(["p1"]);
  });
});
