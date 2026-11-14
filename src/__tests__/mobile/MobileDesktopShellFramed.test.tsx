// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://laptop.example.ts.net/"}
/**
 * This app inside another desktop's frame (`mobile-web/src/shell/`,
 * docs/phone_multi_desktop_plan.md Phase 3): it says `ready` to its shell,
 * its switch button asks the shell for the picker, pairing suggests
 * "‹phone› via ‹home›", and Notifications sends the reader to this desktop's
 * own page in the browser.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../mobile-web/src/auth", () => ({
  hasPairedDevice: vi.fn(async () => true),
  resumeAuth: vi.fn(async () => ({ kind: "paired" })),
  logoutAuth: vi.fn(async () => undefined),
  pair: vi.fn(),
  finishOidcReturn: vi.fn(async () => null),
  oidcProvider: vi.fn(async () => null),
  startOidc: vi.fn(async () => undefined),
}));
vi.mock("../../../mobile-web/src/localLock", () => ({
  hasLocalUnlock: vi.fn(async () => true),
  MIN_NEW_PIN: 6,
  validPin: (pin: string) => /^\d{4,12}$/.test(pin),
  configureLocalUnlock: vi.fn(),
  platformBiometricAvailable: vi.fn(async () => true),
}));
vi.mock("../../../mobile-web/src/screens/LocalUnlock", () => ({
  LocalUnlock: ({ onUnlocked }: { onUnlocked: () => void }) => <button onClick={onUnlocked}>Unlock now</button>,
}));
vi.mock("../../../mobile-web/src/screens/Terminal", () => ({ Terminal: () => <div>terminal</div> }));

import { DesktopShell } from "../../../mobile-web/src/shell/DesktopShell";
import { SHELL_CHANNEL } from "../../../mobile-web/src/shell/frameBridge";
import { Pair } from "../../../mobile-web/src/screens/Pair";
import { NotificationsSheet } from "../../../mobile-web/src/components/NotificationsSheet";
import { pushSupport } from "../../../mobile-web/src/push";

const SHELL = "https://home.example.ts.net";
const parent = { postMessage: vi.fn() };
const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
  Object.defineProperty(window.location, "ancestorOrigins", { configurable: true, value: { length: 1, 0: SHELL, item: () => SHELL, contains: (s: string) => s === SHELL } });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    // This desktop's own list is not the shell's: a frame shows no picker of its own.
    if (url.startsWith("/api/v1/status")) return new Response(JSON.stringify({ host: "laptop-pc", linked_desktops: [{ origin: SHELL }] }), { status: 200 });
    if (url.startsWith("/api/v1/projects")) return new Response(JSON.stringify({ projects: [{ id: "p1", label: "Alpha", status: "active", live_sessions: 1 }] }), { status: 200 });
    if (url.startsWith("/api/v1/alerts")) return new Response(JSON.stringify({ alerts: { enabled: false, items: [] } }), { status: 200 });
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  });
});

afterEach(() => {
  cleanup();
  parent.postMessage.mockReset();
  fetchMock.mockReset();
  Reflect.deleteProperty(window.location, "ancestorOrigins");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sent = () => parent.postMessage.mock.calls.map(([data, target]) => ({ data, target }));

describe("inside another desktop's frame", () => {
  it("says ready with its name, and its switch button asks the shell for the picker", async () => {
    render(<DesktopShell />);
    // Even locked, the shell hears from it and it offers the way out.
    await screen.findByRole("button", { name: "Unlock now" });
    await waitFor(() => expect(sent()).toContainEqual({ data: { channel: SHELL_CHANNEL, type: "ready", name: null, desktopAvailable: false }, target: SHELL }));
    expect(screen.getByRole("button", { name: "Switch desktop" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Unlock now" }));
    await screen.findByText("Alpha");
    await waitFor(() => expect(sent()).toContainEqual({ data: { channel: SHELL_CHANNEL, type: "ready", name: "laptop-pc", desktopAvailable: true }, target: SHELL }));
    // No frame inside a frame, no picker of its own.
    expect(document.querySelector("iframe")).toBeNull();
    parent.postMessage.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Switch desktop" }));
    expect(sent()).toEqual([{ data: { channel: SHELL_CHANNEL, type: "openPicker" }, target: SHELL }]);
    expect(screen.queryByRole("dialog", { name: "Desktops" })).toBeNull();
  });

  it("suggests a device name that says which app the pairing lives in", () => {
    render(<Pair setupLock onDone={() => undefined} />);
    expect((screen.getByLabelText("Device name") as HTMLInputElement).value).toBe("Mobile device via home");
  });

  it("sends the reader to this desktop's own page for notifications", () => {
    expect(pushSupport()).toBe("framed");
    render(<NotificationsSheet onClose={() => undefined} />);
    expect(screen.getByText(/Notifications can't be turned on inside another desktop's app/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open laptop.example.ts.net in the browser" }) as HTMLAnchorElement;
    expect(link.href).toBe("https://laptop.example.ts.net/");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });
});
