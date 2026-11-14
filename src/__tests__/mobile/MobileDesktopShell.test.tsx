// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://home.example.ts.net/"}
/**
 * The desktop switcher around the app (`mobile-web/src/shell/DesktopShell.tsx`,
 * docs/phone_multi_desktop_plan.md Phase 3): the home's lock comes first and
 * unmounts a frame, the shell's gate stands ahead of the home's connect step
 * (a cached list frames another desktop with the home down), and Back with
 * the picker over a frame steps through the home's own history only.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resumeAuth } from "../../../mobile-web/src/auth";

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
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));

import { DesktopShell } from "../../../mobile-web/src/shell/DesktopShell";
import { forgetLinkedDesktops, linkedSnapshot, resetLinkedDesktopsForTests } from "../../../mobile-web/src/shell/linkedDesktops";
import { SHELL_CHANNEL } from "../../../mobile-web/src/shell/frameBridge";
import { resetBackStackForTests } from "../../../mobile-web/src/backStack";
import { storageDashKey } from "../../lib/brand";

const B = "https://laptop.example.ts.net";
const KEY = storageDashKey("linked-desktops");
const fetchMock = vi.fn();
let statusCalls = 0;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  resetLinkedDesktopsForTests();
  statusCalls = 0;
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resumeAuth).mockResolvedValue({ kind: "paired" });
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/status")) {
      statusCalls += 1;
      return new Response(JSON.stringify({ host: "home-pc", linked_desktops: [{ origin: B }, { origin: "http://plain.example.ts.net" }] }), { status: 200 });
    }
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
  forgetLinkedDesktops();
  resetBackStackForTests();
});

const frame = () => document.querySelector<HTMLIFrameElement>("iframe.shell-frame");
const picker = () => screen.queryByRole("dialog", { name: "Desktops" });

function fromFrame(type: string, extra: Record<string, unknown> = {}) {
  const source = frame()!.contentWindow;
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { channel: SHELL_CHANNEL, type, ...extra }, origin: B, source }));
  });
}

async function unlock() {
  fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
}

describe("the desktop shell", () => {
  it("learns the list from the home's status and frames the desktop picked", async () => {
    render(<DesktopShell />);
    await unlock();
    await screen.findByText("Alpha");
    fireEvent.click(await screen.findByRole("button", { name: "Switch desktop" }));
    const sheet = picker()!;
    const rows = within(sheet).getAllByRole("button").filter((button) => !button.classList.contains("sheet-close"));
    expect(rows.map((row) => row.querySelector("strong")?.textContent)).toEqual(["home-pc", "laptop"]);
    // Only the https entry made it in.
    expect(linkedSnapshot().desktops).toEqual([{ origin: B }]);

    fireEvent.click(within(sheet).getByText("laptop"));
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(frame()!.getAttribute("src")).toBe(`${B}/`);
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(picker()).toBeNull();

    // The frame's own switch button asks for the picker; the home is a tap away.
    fromFrame("openPicker");
    fireEvent.click(within(picker()!).getByText("home-pc"));
    await screen.findByText("Alpha");
    expect(frame()).toBeNull();
  });

  it("with the home down still picks the cached desktop", async () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B, name: "Laptop" }], homeName: "home-pc", selected: null }));
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unavailable", reason: "host_down" });
    render(<DesktopShell />);
    // Behind the home's lock: no switch, no frame.
    await screen.findByRole("button", { name: "Unlock now" });
    expect(screen.queryByRole("button", { name: "Switch desktop" })).toBeNull();
    await unlock();
    await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("button", { name: "Switch desktop" }));
    fireEvent.click(within(picker()!).getByText("Laptop"));
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(statusCalls).toBe(0);
  });

  it("opens a selected desktop straight after the unlock, ahead of the home's connect", async () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B }], selected: B }));
    let answer: (value: { kind: "paired" }) => void = () => undefined;
    vi.mocked(resumeAuth).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<DesktopShell />);
    await screen.findByRole("button", { name: "Unlock now" });
    expect(frame()).toBeNull();
    await unlock();
    // The home is still connecting: its splash is not shown, the frame is.
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(screen.queryByText("Connecting…")).toBeNull();
    await act(async () => { answer({ kind: "paired" }); });
    expect(frame()).not.toBeNull();
  });

  it("the home's lock unmounts the frame and closes the picker", async () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B }], selected: B }));
    render(<DesktopShell />);
    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());
    fromFrame("openPicker");
    expect(picker()).not.toBeNull();

    // Back after the idle window: the home locks.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 200_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await screen.findByRole("button", { name: "Unlock now" });
    expect(frame()).toBeNull();
    expect(picker()).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch desktop" })).toBeNull();

    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());
  });

  it("the home's lock still takes the frame away while the home is down", async () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B }], selected: B }));
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unavailable", reason: "host_down" });
    render(<DesktopShell />);
    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());
    // Let the home's connect fail behind the frame.
    await act(async () => { await Promise.resolve(); });
    expect(frame()).not.toBeNull();

    // Back after the idle window: the home locks although it never connected.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 200_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await screen.findByRole("button", { name: "Unlock now" });
    expect(frame()).toBeNull();
    expect(screen.queryByRole("button", { name: "Switch desktop" })).toBeNull();

    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());
  });

  it("a connect still running at the lock does not undo it", async () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B }], selected: B }));
    let answer: (value: { kind: "paired" }) => void = () => undefined;
    vi.mocked(resumeAuth).mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    render(<DesktopShell />);
    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 200_000);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    await screen.findByRole("button", { name: "Unlock now" });
    expect(frame()).toBeNull();

    // The connect started before the lock answers now: the lock holds.
    await act(async () => { answer({ kind: "paired" }); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    expect(screen.getByRole("button", { name: "Unlock now" })).toBeTruthy();
    expect(screen.queryByText("Alpha")).toBeNull();
    expect(frame()).toBeNull();
  });
});

describe("Back with the picker over a frame", () => {
  let entries = 0;
  let pushes = 0;
  let ownBacks = 0;
  /** `history.back()` calls whose `popstate` the test delivers by hand. */
  let pending = 0;

  beforeEach(() => {
    entries = 0;
    pushes = 0;
    ownBacks = 0;
    pending = 0;
    resetBackStackForTests();
    vi.spyOn(window.history, "pushState").mockImplementation(() => { entries += 1; pushes += 1; });
    vi.spyOn(window.history, "back").mockImplementation(() => {
      ownBacks += 1;
      entries = Math.max(0, entries - 1);
      pending += 1;
    });
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: B }], selected: B }));
  });

  const homePop = () => act(() => { window.dispatchEvent(new PopStateEvent("popstate")); });
  /** The framed desktop's own Back: its window's `popstate`, not the home's. */
  const framePop = () => act(() => {
    const inner = frame()!.contentWindow as Window & typeof globalThis;
    inner.dispatchEvent(new inner.PopStateEvent("popstate"));
  });
  async function settle() {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }

  it("Back closes the picker and leaves the frame; the frame's own pops never reach the home", async () => {
    render(<DesktopShell />);
    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());
    expect(entries).toBe(0);

    fromFrame("openPicker");
    expect(entries).toBe(1);
    // The framed desktop stepping back inside itself: the picker stays.
    framePop();
    await settle();
    expect(picker()).not.toBeNull();

    // Back: the home's guard pops, the picker closes, the frame stays.
    entries -= 1;
    homePop();
    await settle();
    expect(picker()).toBeNull();
    expect(frame()).not.toBeNull();
    expect(entries).toBe(0);
    expect(ownBacks).toBe(0);
  });

  it("a frame's popstate cannot consume the home's own pending pop", async () => {
    render(<DesktopShell />);
    await unlock();
    await waitFor(() => expect(frame()).not.toBeNull());

    fromFrame("openPicker");
    expect(pushes).toBe(1);
    // Closed by its own button: the home takes its guard off with a pop of its own.
    fireEvent.click(within(picker()!).getByRole("button", { name: "Close" }));
    await settle();
    expect(ownBacks).toBe(1);
    expect(pending).toBe(1);

    // The frame's Back arrives before the home's own pop.
    framePop();
    // Opened again while the home's pop is still due: no push yet — had the
    // frame's popstate been counted as it, this push would land before the
    // pop, and the pop would then close the picker.
    fromFrame("openPicker");
    await settle();
    expect(pushes).toBe(1);

    pending -= 1;
    homePop();
    await settle();
    expect(picker()).not.toBeNull();
    expect(pushes).toBe(2);
  });
});
