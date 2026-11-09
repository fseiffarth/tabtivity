/**
 * Spoken navigation to a project with no agent tab closes the terminal and shows
 * the project (`App.tsx`'s `openProject`). It lands on the Projects section like
 * every other project open, whichever section the terminal had been opened from.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAuth } from "../../../mobile-web/src/auth";
import type { TabRow } from "../../../mobile-web/src/api";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
  finishOidcReturn: vi.fn(async () => null),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({ hasLocalUnlock: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({
  LocalUnlock: ({ onUnlocked }: { onUnlocked: () => void }) => <button onClick={onUnlocked}>Unlock now</button>,
}));
const seen = vi.hoisted(() => ({ openTab: null as null | ((project: string, row: unknown) => void) }));
vi.mock("../../../mobile-web/src/screens/Home", () => ({
  Home: ({ openTab }: { openTab: (project: string, row: unknown) => void }) => {
    seen.openTab = openTab;
    return <div>home list</div>;
  },
}));
vi.mock("../../../mobile-web/src/screens/Project", () => ({ Project: ({ id }: { id: string }) => <div>project screen {id}</div> }));
vi.mock("../../../mobile-web/src/screens/Todo", () => ({ Todo: () => <div>todo board</div> }));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({
  Terminal: ({ openProject }: { openProject?: (id: string) => void }) => (
    <button onClick={() => openProject?.("p1")}>open the project</button>
  ),
}));

import { App } from "../../../mobile-web/src/App";

const fetchMock = vi.fn();
const ROW: TabRow = { id: "t1", label: "Claude", kind: "agent", agent_label: "Claude Code", available: true, viewer_busy: false };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  seen.openTab = null;
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resumeAuth).mockResolvedValue({ kind: "paired" });
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify({ hidden_sections: [] }), { status: 200 });
    if (url.startsWith("/api/v1/projects")) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
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

describe("a spoken jump to a project that has no agent tab", () => {
  it("shows that project on the Projects section, even from a terminal opened under another one", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByText("home list");
    // A terminal opened from Home while the reader has since moved to another section.
    const openFromHome = seen.openTab;
    expect(openFromHome).not.toBeNull();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Sections" })).getByText("To-do"));
    await screen.findByText("todo board");
    act(() => openFromHome?.("p1", ROW));
    fireEvent.click(await screen.findByRole("button", { name: "open the project" }));
    expect(await screen.findByText("project screen p1")).toBeTruthy();
    expect(screen.queryByText("todo board")).toBeNull();
  });
});
