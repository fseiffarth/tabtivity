/**
 * The privacy curtain (docs/privacy_curtain_plan.md): presenting covers every
 * other app window; only the user's Show click (or the shortcut) lifts it, per
 * window; nothing behind it takes keys; a deck presenter stays visible.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const handlers = new Map<string, (ev: { payload: unknown }) => void>();
let presentingNow = { presenting: false, kind: null as string | null, curtain: true };

const invoke = vi.fn(async (cmd: string, _args?: unknown) => {
  if (cmd === "presenting_state") return presentingNow;
  return null;
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
const emit = vi.fn(async (event: string) => {
  handlers.get(event)?.({ payload: null });
});
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, cb: (ev: { payload: unknown }) => void) => {
    handlers.set(event, cb);
    return () => handlers.delete(event);
  }),
  emit: (event: string) => emit(event),
}));

import { PrivacyCurtain } from "../../components/layout/PrivacyCurtain";
import {
  curtainKeyVerdict,
  notificationsHeld,
  PRESENTING_CHANGED,
  usePrivacyCurtainStore,
} from "../../lib/window/privacyCurtain";
import { usePresentationStore } from "../../stores/viewers/presentation";

const presenting = (on: boolean, kind: "pdf" | "deck" | null = on ? "pdf" : null, curtain = true) =>
  act(() => handlers.get(PRESENTING_CHANGED)?.({ payload: { presenting: on, kind, curtain } }));

const key = (init: KeyboardEventInit, target: EventTarget = window) => {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
};

const protectCalls = () =>
  invoke.mock.calls.filter(([cmd]) => cmd === "privacy_curtain_set").map(([, args]) => args);

beforeEach(() => {
  handlers.clear();
  invoke.mockClear();
  emit.mockClear();
  presentingNow = { presenting: false, kind: null, curtain: true };
  usePrivacyCurtainStore.setState({ presenting: false, auto: true, up: false });
  usePresentationStore.setState({ presenting: 0, armed: 0 });
});

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.privacyCurtain;
  document.querySelectorAll("[data-curtain-keep]").forEach((n) => n.remove());
});

describe("curtainKeyVerdict", () => {
  const plain = { ctrlKey: false, altKey: false, metaKey: false, shiftKey: false };
  it("drops every modified key in both modes", () => {
    expect(curtainKeyVerdict({ ...plain, key: "Tab", ctrlKey: true }, "cover", true)).toBe("drop");
    expect(curtainKeyVerdict({ ...plain, key: "Tab", ctrlKey: true }, "keep", false)).toBe("drop");
    expect(curtainKeyVerdict({ ...plain, key: "1", altKey: true }, "keep", false)).toBe("drop");
  });
  it("cover passes plain keys only on the curtain itself", () => {
    expect(curtainKeyVerdict({ ...plain, key: "Enter" }, "cover", true)).toBe("pass");
    expect(curtainKeyVerdict({ ...plain, key: "a" }, "cover", false)).toBe("drop");
  });
  it("keep passes the presenter's plain keys but not F-keys or Shift+Space", () => {
    expect(curtainKeyVerdict({ ...plain, key: "ArrowRight" }, "keep", false)).toBe("pass");
    expect(curtainKeyVerdict({ ...plain, key: "b" }, "keep", false)).toBe("pass");
    expect(curtainKeyVerdict({ ...plain, key: "F1" }, "keep", false)).toBe("drop");
    expect(curtainKeyVerdict({ ...plain, key: " ", shiftKey: true }, "keep", false)).toBe("drop");
  });
});

describe("the curtain store", () => {
  it("raises when presenting starts and stays up when it ends", () => {
    const s = usePrivacyCurtainStore.getState();
    s.applyPresenting({ presenting: true, kind: "pdf", curtain: true });
    expect(usePrivacyCurtainStore.getState().up).toBe(true);
    expect(notificationsHeld()).toBe(true);
    s.applyPresenting({ presenting: false, kind: null, curtain: true });
    expect(usePrivacyCurtainStore.getState().up).toBe(true);
    expect(notificationsHeld()).toBe(false);
    expect(protectCalls()).toEqual([{ up: true }]);
  });

  it("does not re-raise a lifted curtain while the same talk runs", () => {
    const s = usePrivacyCurtainStore.getState();
    s.applyPresenting({ presenting: true, kind: "pdf", curtain: true });
    s.lift();
    // A second PDF opened during the talk, or a deck window closing under it.
    s.applyPresenting({ presenting: true, kind: "deck", curtain: true });
    expect(usePrivacyCurtainStore.getState().up).toBe(false);
    expect(protectCalls()).toEqual([{ up: true }, { up: false }]);
  });

  it("with the setting off, presenting raises nothing and holds nothing", () => {
    usePrivacyCurtainStore.getState().applyPresenting({ presenting: true, kind: "pdf", curtain: false });
    expect(usePrivacyCurtainStore.getState().up).toBe(false);
    expect(notificationsHeld()).toBe(false);
  });
});

describe("<PrivacyCurtain />", () => {
  it("covers the window on present and lifts only on Show", async () => {
    render(<PrivacyCurtain />);
    await act(async () => {});
    presenting(true);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Hidden while presenting");
    expect(document.documentElement.dataset.privacyCurtain).toBe("cover");
    expect(document.activeElement?.textContent).toBe("Show");

    presenting(false);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByText("Show"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.documentElement.dataset.privacyCurtain).toBeUndefined();
  });

  it("keeps keys from reaching anything behind the cover", async () => {
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<PrivacyCurtain />);
      await act(async () => {});
      presenting(true);
      const tab = key({ key: "Tab", ctrlKey: true });
      expect(tab.defaultPrevented).toBe(true);
      key({ key: "a" }, document.body);
      expect(behind).not.toHaveBeenCalled();
      // Enter on the Show button is the curtain's own.
      key({ key: "Enter" }, screen.getByText("Show"));
      expect(behind).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("starts curtained when it mounts mid-talk", async () => {
    presentingNow = { presenting: true, kind: "pdf", curtain: true };
    render(<PrivacyCurtain />);
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("leaves a deck presenter visible and its plain keys live", async () => {
    const presenter = document.createElement("div");
    presenter.setAttribute("data-curtain-keep", "");
    presenter.tabIndex = -1;
    document.body.appendChild(presenter);
    usePresentationStore.setState({ presenting: 1 });
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    try {
      render(<PrivacyCurtain />);
      await act(async () => {});
      presenting(true, "deck");
      expect(document.documentElement.dataset.privacyCurtain).toBe("keep");
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("status").textContent).toContain("Show");
      expect(document.activeElement).toBe(presenter);

      key({ key: "ArrowRight" }, presenter);
      expect(behind).toHaveBeenCalledTimes(1);
      key({ key: "Tab", ctrlKey: true }, presenter);
      expect(behind).toHaveBeenCalledTimes(1);

      // The talk ends in this window: the cover takes over.
      act(() => usePresentationStore.setState({ presenting: 0 }));
      expect(document.documentElement.dataset.privacyCurtain).toBe("cover");
      expect(screen.getByRole("dialog")).toBeTruthy();
    } finally {
      window.removeEventListener("keydown", behind);
    }
  });

  it("the shortcut raises every window, and pressed again shows this one", async () => {
    render(<PrivacyCurtain />);
    await act(async () => {});
    await act(async () => {
      key({ key: "H", ctrlKey: true, shiftKey: true, altKey: true });
    });
    expect(emit).toHaveBeenCalledWith("privacy-curtain-raise");
    expect(screen.getByRole("dialog")).toBeTruthy();
    await act(async () => {
      key({ key: "H", ctrlKey: true, shiftKey: true, altKey: true }, screen.getByText("Show"));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
