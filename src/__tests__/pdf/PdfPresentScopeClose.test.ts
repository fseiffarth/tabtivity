/**
 * A PDF presented fullscreen (its own `present-pdf-*` window) closes when the
 * main window switches scope — project, box or root — instead of staying over
 * the next project. Deck audience windows and popouts are not touched; the
 * sleep inhibitor is released before the window is destroyed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const { invokeMock, labels } = vi.hoisted(() => ({
  invokeMock: vi.fn((..._a: unknown[]) => Promise.resolve(undefined)),
  labels: { current: [] as string[] },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: () => Promise.resolve(labels.current.map((label) => ({ label }))),
}));

import { useTabsStore } from "../../stores/tabs";
import { setDetachedWindowContext } from "../../stores/detachedContext";
import { pdfPresentLabel } from "../../components/embed/pdf/present";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function calls(cmd: string): unknown[] {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd).map((c) => c[1]);
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve(undefined));
  setDetachedWindowContext(null);
  labels.current = ["main", "detached-p1-g-1", "present-abc123", pdfPresentLabel("/p1/talk.pdf")];
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
});

describe("PDF present windows close on a scope change", () => {
  it("a project switch closes only the PDF present window, after releasing sleep", async () => {
    useTabsStore.getState().setScope("p2");
    await flush();
    expect(calls("close_presenter_window")).toEqual([{ label: pdfPresentLabel("/p1/talk.pdf") }]);
    const order = invokeMock.mock.calls.map((c) => c[0]);
    expect(order.indexOf("presenter_release_sleep")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("presenter_release_sleep")).toBeLessThan(order.indexOf("close_presenter_window"));
  });

  it("entering a box closes it too", async () => {
    useTabsStore.getState().setScope("box:b7");
    await flush();
    expect(calls("close_presenter_window")).toHaveLength(1);
  });

  it("no PDF present window: nothing is closed and the inhibitor is left alone", async () => {
    labels.current = ["main", "present-abc123"];
    useTabsStore.getState().setScope("p2");
    await flush();
    expect(calls("close_presenter_window")).toEqual([]);
    expect(calls("presenter_release_sleep")).toEqual([]);
  });

  it("re-setting the same scope closes nothing", async () => {
    useTabsStore.getState().setScope("p1");
    await flush();
    expect(calls("close_presenter_window")).toEqual([]);
  });

  it("a popout's own heap never closes it", async () => {
    setDetachedWindowContext({
      scope: "p1",
      groupId: "g-1",
      label: "detached-p1-g-1",
      targetGroupId: () => "g-1",
      pushEdit: () => {},
      closeTab: () => {},
    });
    useTabsStore.getState().setScope("p2");
    await flush();
    expect(calls("close_presenter_window")).toEqual([]);
    setDetachedWindowContext(null);
  });
});
