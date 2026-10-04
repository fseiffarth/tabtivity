/**
 * The sections the desktop keeps a phone out of (`App.tsx`): the status probe
 * names them, the tab bar drops them, and the answer is remembered so the next
 * cold open draws the bar without them before the probe returns. The sidecar
 * refuses their routes either way; this only keeps the bar honest.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAuth } from "../../../mobile-web/src/auth";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({ hasLocalUnlock: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({
  LocalUnlock: ({ onUnlocked }: { onUnlocked: () => void }) => <button onClick={onUnlocked}>Unlock now</button>,
}));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));
vi.mock("../../../mobile-web/src/screens/Todo", () => ({ Todo: () => <div>todo board</div> }));

import { App } from "../../../mobile-web/src/App";
import { storageDashKey } from "../../lib/brand";

const fetchMock = vi.fn();
let hidden: string[] = [];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  hidden = [];
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resumeAuth).mockResolvedValue({ kind: "paired" });
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify({ hidden_sections: hidden }), { status: 200 });
    if (url.startsWith("/api/v1/projects")) return new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 });
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sections = () =>
  within(screen.getByRole("navigation", { name: "Sections" }))
    .getAllByRole("button")
    // The glyph is its own span; the label is the text after it.
    .map((button) => button.lastChild?.textContent ?? "");

describe("sections the desktop keeps a phone out of", () => {
  it("drops them from the tab bar and remembers them for the next open", async () => {
    hidden = ["mail", "todo"];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("Alpha");
    await waitFor(() => expect(sections()).toEqual(["Projects", "Calendar"]));
    expect(JSON.parse(localStorage.getItem(storageDashKey("hidden-sections")) ?? "null")).toEqual(["todo", "mail"]);
  });

  it("leaves a section the desktop turns off while the reader is on it", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("Alpha");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Sections" })).getByText("To-do"));
    await screen.findByText("todo board");

    hidden = ["todo"];
    document.dispatchEvent(new Event("visibilitychange"));
    await screen.findByText("Alpha");
    expect(screen.queryByText("todo board")).toBeNull();
    expect(sections()).toEqual(["Projects", "Calendar", "Mail"]);
  });

  it("ignores names it does not know and shows every section again once none is hidden", async () => {
    localStorage.setItem(storageDashKey("hidden-sections"), JSON.stringify(["calendar", "projects", "notes"]));
    hidden = [];
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("Alpha");
    await waitFor(() => expect(sections()).toEqual(["Projects", "To-do", "Calendar", "Mail"]));
  });
});
