/**
 * The project screen's swipe-to-close: a right→left flick over a tab card
 * closes that tab through the desktop, as its ✕ does; a left→right one does
 * not, and a refused close slides the card back.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Project } from "../../../mobile-web/src/screens/Project";

function hostWith(closeStatus = 200) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/projects/p1/outbox") return new Response(JSON.stringify({ files: [] }), { status: 200 });
    if (url.startsWith("/api/v1/tabs/") && init?.method === "DELETE") {
      return closeStatus === 200
        ? new Response(JSON.stringify({ closed: true }), { status: 200 })
        : new Response(JSON.stringify({ error: "close_failed" }), { status: closeStatus });
    }
    return new Response(JSON.stringify({
      project: { id: "p1", label: "Alpha", status: "active" },
      desktop_available: true,
      agents: [],
      tabs: [
        { id: "shell-1", label: "Build shell", kind: "shell", available: true, viewer_busy: false },
        { id: "shell-2", label: "Test shell", kind: "shell", available: true, viewer_busy: false },
      ],
    }), { status: 200 });
  });
}

/** A one-finger flick, as `focusSwipe` listens for it. */
function swipe(target: Element, from: number, to: number) {
  act(() => {
    if ("PointerEvent" in window) {
      const init = { bubbles: true, cancelable: true, pointerType: "touch", pointerId: 9, isPrimary: true, clientY: 300 };
      target.dispatchEvent(new PointerEvent("pointerdown", { ...init, clientX: from }));
      target.dispatchEvent(new PointerEvent("pointerup", { ...init, clientX: to }));
    } else {
      const touchEvent = (type: string, clientX: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const touch = { identifier: 9, target, clientX, clientY: 300 };
        Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [touch] });
        Object.defineProperty(event, "changedTouches", { value: [touch] });
        return event;
      };
      target.dispatchEvent(touchEvent("touchstart", from));
      target.dispatchEvent(touchEvent("touchend", to));
    }
  });
}

const deletes = (fetchMock: ReturnType<typeof hostWith>) =>
  fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE").map(([input]) => String(input));

describe("Mobile project — swipe a tab card to close it", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("closes the card a right→left swipe ran over, and only that one", async () => {
    const fetchMock = hostWith();
    vi.stubGlobal("fetch", fetchMock);
    render(<Project id="p1" back={() => undefined} terminal={() => undefined} />);
    swipe(await screen.findByText("Test shell"), 300, 100);
    await waitFor(() => expect(screen.queryByText("Test shell")).toBeNull());
    expect(deletes(fetchMock)).toEqual(["/api/v1/tabs/shell-2"]);
    expect(screen.getByText("Build shell")).toBeTruthy();
  });

  it("closes nothing on a left→right swipe", async () => {
    const fetchMock = hostWith();
    vi.stubGlobal("fetch", fetchMock);
    render(<Project id="p1" back={() => undefined} terminal={() => undefined} />);
    swipe(await screen.findByText("Test shell"), 100, 300);
    expect(deletes(fetchMock)).toEqual([]);
    expect(screen.getByText("Test shell")).toBeTruthy();
  });

  it("slides a card back when the desktop refuses the close", async () => {
    vi.stubGlobal("fetch", hostWith(500));
    render(<Project id="p1" back={() => undefined} terminal={() => undefined} />);
    const label = await screen.findByText("Test shell");
    const card = label.closest(".tab-card");
    swipe(label, 300, 100);
    expect(card?.classList.contains("swiped-out")).toBe(true);
    await waitFor(() => expect(card?.classList.contains("swiped-out")).toBe(false));
    expect(screen.getByText("Test shell")).toBeTruthy();
  });
});
