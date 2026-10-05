/**
 * The session lifecycle as one state machine (`App.tsx`).
 *
 * Facts pinned: a cold open always asks — the sessionStorage flag that
 * used to let a restored page skip the lock is gone, so an app the OS killed
 * and reopened meets the PIN — while a pull-to-refresh of a page left
 * unlocked seconds ago carries on without it; and a 401 met while the reader is active is
 * renewed silently with the device key, with the request that met it sent
 * again, no PIN in between. A renewal that fails puts the lock screen up.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hasPairedDevice, resumeAuth, type ResumeResult } from "../../../mobile-web/src/auth";
import { hasLocalUnlock } from "../../../mobile-web/src/localLock";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({ hasLocalUnlock: vi.fn(async () => true) }));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({
  LocalUnlock: ({ setup, onUnlocked }: { setup: boolean; onUnlocked: () => void }) =>
    <button onClick={onUnlocked}>{setup ? "Set up the lock" : "Unlock now"}</button>,
}));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));
vi.mock("../../../mobile-web/src/screens/Pair", () => ({ Pair: ({ setupLock, onDone }: { setupLock: boolean; onDone: () => void }) => <button onClick={onDone}>{setupLock ? "Connect and secure" : "Pair this phone"}</button> }));

import { App } from "../../../mobile-web/src/App";
import { BRAND, storageKey } from "../../lib/brand";

const fetchMock = vi.fn();

function answers(projects: () => Response) {
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/v1/projects")) return projects();
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
}

const paired: ResumeResult = { kind: "paired" };
const ok = () => new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 });
const lapsed = () => new Response(JSON.stringify({ error: "authentication_required" }), { status: 401 });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(resumeAuth).mockReset();
  vi.mocked(resumeAuth).mockResolvedValue(paired);
  vi.mocked(hasPairedDevice).mockResolvedValue(true);
  vi.mocked(hasLocalUnlock).mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(`${BRAND.display} Mobile session lifecycle`, () => {
  it("opens the workspace after the combined first connection without another PIN screen", async () => {
    vi.mocked(hasPairedDevice).mockResolvedValue(false);
    vi.mocked(hasLocalUnlock).mockResolvedValue(false);
    answers(ok);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect and secure" }));
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlock now" })).toBeNull();
    expect(resumeAuth).toHaveBeenCalledOnce();
  });

  it("asks for the lock on every cold open, whatever a restored page remembers", async () => {
    // The flag the old shortcut read. It must mean nothing now.
    sessionStorage.setItem(`${BRAND.slug}-mobile-local-unlocked`, "1");
    answers(ok);
    render(<App />);
    await screen.findByRole("button", { name: "Unlock now" });
    expect(resumeAuth).not.toHaveBeenCalled();
  });

  it("carries on unlocked across a pull-to-refresh, and stamps the page it leaves", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as PerformanceNavigationTiming]);
    sessionStorage.setItem(storageKey("mobile.reloadGrace"), String(Date.now() - 1_000));
    answers(ok);
    render(<App />);
    await screen.findByText("Alpha");
    expect(screen.queryByRole("button", { name: "Unlock now" })).toBeNull();
    expect(resumeAuth).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(storageKey("mobile.reloadGrace"))).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(sessionStorage.getItem(storageKey("mobile.reloadGrace"))).toMatch(/^\d+$/);
  });

  it("asks on a reload whose stamp is stale", async () => {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as PerformanceNavigationTiming]);
    sessionStorage.setItem(storageKey("mobile.reloadGrace"), String(Date.now() - 60_000));
    answers(ok);
    render(<App />);
    await screen.findByRole("button", { name: "Unlock now" });
    expect(resumeAuth).not.toHaveBeenCalled();
  });

  it("reloads once on a failed connect, carrying the unlock across, and shows the splash the second time", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unavailable", reason: "timeout" });
    answers(ok);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    // The new page signs straight back in: the unlock rides the reload grace.
    expect(sessionStorage.getItem(storageKey("mobile.reloadGrace"))).toMatch(/^\d+$/);
    cleanup();

    // The reloaded page fails too: no second reload, the splash says why.
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as PerformanceNavigationTiming]);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlock now" })).toBeNull();
    expect(reload).toHaveBeenCalledOnce();

    // A connect that works earns the next failure its reload back.
    vi.mocked(resumeAuth).mockResolvedValue(paired);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Alpha");
    expect(sessionStorage.getItem(storageKey("mobile.connectReload"))).toBeNull();
  });

  it("shows the splash without reloading when the desktop app is closed", async () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.mocked(resumeAuth).mockResolvedValue({ kind: "unavailable", reason: "desktop_down" });
    answers(ok);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await screen.findByRole("button", { name: "Retry" });
    expect(reload).not.toHaveBeenCalled();
  });

  it("renews a lapsed session silently while the reader is active and sends the request again", async () => {
    let calls = 0;
    answers(() => (++calls === 1 ? lapsed() : ok()));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    // The list arrives from the retried request; no lock screen in between.
    expect(await screen.findByText("Alpha")).toBeTruthy();
    expect(calls).toBe(2);
    // Once to sign in after the unlock, once to renew behind the 401.
    expect(resumeAuth).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Unlock now" })).toBeNull();
  });

  it("locks when the silent renewal fails, and sends a rejected device to pair", async () => {
    answers(lapsed);
    vi.mocked(resumeAuth)
      .mockResolvedValueOnce(paired)
      .mockResolvedValueOnce({ kind: "unavailable", reason: "unreachable" });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Unlock now" }));
    await waitFor(() => expect(resumeAuth).toHaveBeenCalledTimes(2));
    await screen.findByRole("button", { name: "Unlock now" });

    vi.mocked(resumeAuth).mockReset();
    vi.mocked(resumeAuth)
      .mockResolvedValueOnce(paired)
      .mockResolvedValueOnce({ kind: "unpaired" });
    fireEvent.click(screen.getByRole("button", { name: "Unlock now" }));
    await screen.findByText("Pair this phone");
    // Not a loop: the device is refused once and sent to pair, not asked again.
    expect(resumeAuth).toHaveBeenCalledTimes(2);
  });
});
