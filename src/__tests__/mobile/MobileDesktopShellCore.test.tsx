// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://home.example.ts.net/"}
/**
 * The desktop switcher's parts (`mobile-web/src/shell/`,
 * docs/phone_multi_desktop_plan.md Phase 3): the cached list and what it
 * refuses, the frame bridge's source and origin checks both ways, the framed
 * page's idea of its shell, and the explanation when a frame never says ready.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  firstLabel,
  forgetLinkedDesktops,
  linkedOrigin,
  linkedSnapshot,
  noteDesktopReady,
  noteHomeStatus,
  resetLinkedDesktopsForTests,
  selectDesktop,
} from "../../../mobile-web/src/shell/linkedDesktops";
import { acceptsFromShell, parseFrameMessage, postToShell, SHELL_CHANNEL, shellOrigin } from "../../../mobile-web/src/shell/frameBridge";
import { DesktopStage, FRAME_ALLOW, READY_TIMEOUT_MS } from "../../../mobile-web/src/shell/DesktopFrame";
import { forgetDeviceData } from "../../../mobile-web/src/forgetDeviceData";
import { storageDashKey } from "../../lib/brand";

const B = "https://laptop.example.ts.net";
const C = "https://desk.example.ts.net:10000";
const KEY = storageDashKey("linked-desktops");

beforeEach(() => {
  localStorage.clear();
  resetLinkedDesktopsForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  forgetLinkedDesktops();
});

describe("the switcher's list", () => {
  it("keeps only https origins in this page's tailnet, never its own, at most eight", () => {
    expect(linkedOrigin(B)).toBe(B);
    expect(linkedOrigin(`${B}/`)).toBe(B);
    expect(linkedOrigin("https://LAPTOP.example.ts.net:443")).toBe(B);
    expect(linkedOrigin(C)).toBe(C);
    expect(linkedOrigin("http://laptop.example.ts.net")).toBeNull();
    expect(linkedOrigin(`${B}/phone`)).toBeNull();
    expect(linkedOrigin("https://laptop.other.ts.net")).toBeNull();
    expect(linkedOrigin("https://laptop.c.ts.net")).toBeNull();
    expect(linkedOrigin("https://evil.example.com")).toBeNull();
    expect(linkedOrigin("https://home.example.ts.net")).toBeNull();
    expect(linkedOrigin("javascript:alert(1)")).toBeNull();
    expect(linkedOrigin(42)).toBeNull();

    const many = Array.from({ length: 10 }, (_, i) => ({ origin: `https://m${i}.example.ts.net` }));
    noteHomeStatus({ host: "home-pc", linked_desktops: [{ origin: "http://laptop.example.ts.net" }, "junk", null, { origin: B }, { origin: B }, ...many] });
    const { desktops, homeName } = linkedSnapshot();
    expect(homeName).toBe("home-pc");
    expect(desktops[0]).toEqual({ origin: B });
    expect(desktops).toHaveLength(8);
    // Cached for a home that is down.
    resetLinkedDesktopsForTests();
    expect(linkedSnapshot().desktops).toHaveLength(8);
  });

  it("drops a cached entry this build would refuse and a selection no longer listed", () => {
    localStorage.setItem(KEY, JSON.stringify({ desktops: [{ origin: "https://laptop.other.ts.net" }, { origin: B, name: 7 }], selected: "https://laptop.other.ts.net" }));
    expect(linkedSnapshot()).toEqual({ desktops: [{ origin: B }], selected: null });

    selectDesktop(B);
    expect(linkedSnapshot().selected).toBe(B);
    selectDesktop("https://unknown.example.ts.net");
    expect(linkedSnapshot().selected).toBeNull();

    selectDesktop(B);
    noteHomeStatus({ linked_desktops: [{ origin: C }] });
    expect(linkedSnapshot().selected).toBeNull();
    expect(linkedSnapshot().desktops).toEqual([{ origin: C }]);
  });

  it("names a row from its frame's ready, else its first DNS label", () => {
    noteHomeStatus({ linked_desktops: [{ origin: B }] });
    expect(firstLabel(B)).toBe("laptop");
    noteDesktopReady(B, "  Laptop  ", true);
    expect(linkedSnapshot().desktops).toEqual([{ origin: B, name: "Laptop", available: true }]);
    // A later status keeps the name the frame gave.
    noteHomeStatus({ linked_desktops: [{ origin: B }] });
    expect(linkedSnapshot().desktops[0].name).toBe("Laptop");
  });

  it("is forgotten with the device", async () => {
    noteHomeStatus({ host: "home-pc", linked_desktops: [{ origin: B }] });
    selectDesktop(B);
    await forgetDeviceData();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(linkedSnapshot()).toEqual({ desktops: [], selected: null });
  });
});

function envelope(data: Record<string, unknown>) {
  return { channel: SHELL_CHANNEL, ...data };
}

describe("the frame bridge", () => {
  it("reads only this app's messages", () => {
    expect(parseFrameMessage(envelope({ type: "ready", name: "Laptop", desktopAvailable: true }))).toEqual({ type: "ready", name: "Laptop", desktopAvailable: true });
    expect(parseFrameMessage(envelope({ type: "openPicker" }))).toEqual({ type: "openPicker" });
    expect(parseFrameMessage({ type: "openPicker" })).toBeNull();
    expect(parseFrameMessage(envelope({ type: "navigate", to: "/" }))).toBeNull();
    expect(parseFrameMessage("openPicker")).toBeNull();
  });

  it("the shell ignores a wrong source and a wrong origin", () => {
    noteHomeStatus({ linked_desktops: [{ origin: B }, { origin: C }] });
    const { container } = render(<DesktopStage origin={B} />);
    const frame = container.querySelector("iframe")!;
    const ready = envelope({ type: "ready", name: "Laptop", desktopAvailable: true });
    const other = document.createElement("iframe");
    document.body.appendChild(other);

    act(() => { window.dispatchEvent(new MessageEvent("message", { data: ready, origin: B, source: other.contentWindow })); });
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: ready, origin: B, source: window })); });
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: ready, origin: C, source: frame.contentWindow })); });
    expect(linkedSnapshot().desktops.find((row) => row.origin === B)?.name).toBeUndefined();

    act(() => { window.dispatchEvent(new MessageEvent("message", { data: ready, origin: B, source: frame.contentWindow })); });
    expect(linkedSnapshot().desktops.find((row) => row.origin === B)?.name).toBe("Laptop");
    other.remove();
  });

  it("sets the frame's allow list and source before attaching it", () => {
    noteHomeStatus({ linked_desktops: [{ origin: B }] });
    const seen: { src: string | null; allow: string | null }[] = [];
    const append = Node.prototype.appendChild;
    vi.spyOn(Node.prototype, "appendChild").mockImplementation(function (this: Node, child) {
      if (child instanceof HTMLIFrameElement) seen.push({ src: child.getAttribute("src"), allow: child.getAttribute("allow") });
      return append.call(this, child);
    });
    render(<DesktopStage origin={B} />);
    expect(seen.length).toBeGreaterThan(0);
    for (const frame of seen) expect(frame).toEqual({ src: `${B}/`, allow: FRAME_ALLOW });
  });
});

describe("a frame that never says ready", () => {
  async function stageAfterTimeout(healthz: () => Promise<Response>) {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      if (String(input) === `${B}/healthz`) return healthz();
      throw new Error(`unexpected ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    noteHomeStatus({ linked_desktops: [{ origin: B }] });
    noteDesktopReady(B, "Laptop", false);
    const view = render(<DesktopStage origin={B} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS - 1); });
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    return { view, fetchMock };
  }

  it("says the desktop has not linked this app when its healthz answers", async () => {
    const { fetchMock } = await stageAfterTimeout(async () => new Response(null, { status: 200 }));
    expect(screen.getByRole("alert").textContent).toContain("Laptop hasn't linked this app yet: add https://home.example.ts.net in its Settings → Mobile.");
    // Opaque on purpose: a desktop that has not linked this app sends no CORS header.
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ mode: "no-cors" });
    // The frame stays: a slow desktop that says ready late is shown.
    const frame = document.querySelector("iframe")!;
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: envelope({ type: "ready", name: "Laptop", desktopAvailable: true }), origin: B, source: frame.contentWindow })); });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says it is not answering when nothing does", async () => {
    await stageAfterTimeout(async () => { throw new TypeError("Failed to fetch"); });
    expect(screen.getByRole("alert").textContent).toContain("Laptop isn't answering.");
  });

  it("stays quiet once the frame said ready in time", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    noteHomeStatus({ linked_desktops: [{ origin: B }] });
    render(<DesktopStage origin={B} />);
    const frame = document.querySelector("iframe")!;
    act(() => { window.dispatchEvent(new MessageEvent("message", { data: envelope({ type: "ready", name: null, desktopAvailable: false }), origin: B, source: frame.contentWindow })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS * 2); });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the framed page's side", () => {
  const SHELL = "https://desk.example.ts.net";

  function frameUnder(parent: { postMessage: (data: unknown, target: string) => void }, ancestors: string[] | null, referrer = "") {
    vi.spyOn(window, "parent", "get").mockReturnValue(parent as unknown as Window);
    if (ancestors) {
      Object.defineProperty(window.location, "ancestorOrigins", { configurable: true, value: { length: ancestors.length, 0: ancestors[0], item: (i: number) => ancestors[i] ?? null, contains: (s: string) => ancestors.includes(s) } });
    }
    vi.spyOn(document, "referrer", "get").mockReturnValue(referrer);
  }

  afterEach(() => {
    Reflect.deleteProperty(window.location, "ancestorOrigins");
  });

  it("at the top there is no shell", () => {
    expect(shellOrigin()).toBeNull();
    expect(postToShell({ type: "openPicker" })).toBe(false);
  });

  it("trusts the parent's origin from ancestorOrigins, with no fallback past it", () => {
    const parent = { postMessage: vi.fn() };
    frameUnder(parent, [SHELL], "https://elsewhere.example.ts.net/");
    expect(shellOrigin()).toBe(SHELL);
    expect(postToShell({ type: "openPicker" })).toBe(true);
    expect(parent.postMessage).toHaveBeenCalledWith(envelope({ type: "openPicker" }), SHELL);

    Reflect.deleteProperty(window.location, "ancestorOrigins");
    frameUnder(parent, [], "https://elsewhere.example.ts.net/");
    expect(shellOrigin()).toBeNull();
  });

  it("falls back to the referrer's origin where ancestorOrigins is missing, never its own", () => {
    const parent = { postMessage: vi.fn() };
    frameUnder(parent, null, `${SHELL}/`);
    expect(shellOrigin()).toBe(SHELL);
    frameUnder(parent, null, "https://home.example.ts.net/some/page");
    expect(shellOrigin()).toBeNull();
    frameUnder(parent, null, "");
    expect(shellOrigin()).toBeNull();
    frameUnder(parent, null, "http://desk.example.ts.net/");
    expect(shellOrigin()).toBeNull();
  });

  it("accepts a message only from the parent at the shell's origin", () => {
    const parent = { postMessage: vi.fn() };
    frameUnder(parent, [SHELL]);
    const from = (source: unknown, origin: string) => acceptsFromShell(new MessageEvent("message", { data: {}, origin, source: source as Window }));
    const other = document.createElement("iframe");
    document.body.appendChild(other);
    // jsdom's MessageEvent wants a real window as source: check the parent by identity.
    vi.spyOn(window, "parent", "get").mockReturnValue(other.contentWindow!);
    expect(from(other.contentWindow, SHELL)).toBe(true);
    expect(from(other.contentWindow, B)).toBe(false);
    expect(from(window, SHELL)).toBe(false);
    other.remove();
  });
});
