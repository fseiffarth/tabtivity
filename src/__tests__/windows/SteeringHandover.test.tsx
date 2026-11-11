/**
 * Steering between windows (the cross-window protocol of
 * `docs/steering_popout_plan.md`): one window steers at a time, and steering
 * follows the keyboard. J walks main → popouts → main, Up from a popout's title
 * bar and its main-only keys hand over to the main window, and a window that
 * did not get the keyboard never announces, so the sender keeps steering.
 *
 * Two (or three) heaps on the two-heap harness: each runs its own `useSteering`
 * on the one shared document, so a key reaches every window's capture listener
 * and only the window that steers acts on it — the same rule that keeps two
 * real windows apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installPopoutContext, loadHeap, resetTabs, type EventBus, type Heap } from "../helpers/detachedHarness";

const shared = vi.hoisted(() => ({
  handlers: new Map<string, Set<(ev: { payload: unknown }) => void>>(),
  emitted: [] as Array<{ event: string; payload: unknown }>,
  calls: [] as Array<{ cmd: string; args: unknown }>,
  focusOk: true,
  hasFocus: true,
  mainFocused: 0,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    shared.calls.push({ cmd, args });
    if (cmd === "focus_detached_window") return Promise.resolve(shared.focusOk);
    return Promise.resolve(undefined);
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    shared.emitted.push({ event, payload });
    for (const h of [...(shared.handlers.get(event) ?? [])]) h({ payload });
    return Promise.resolve();
  },
  listen: (event: string, handler: (ev: { payload: unknown }) => void) => {
    let set = shared.handlers.get(event);
    if (!set) {
      set = new Set();
      shared.handlers.set(event, set);
    }
    set.add(handler);
    return Promise.resolve(() => {
      set.delete(handler);
    });
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    setFocus: () => {
      shared.mainFocused += 1;
      return Promise.resolve();
    },
    unminimize: () => Promise.resolve(),
    isFullscreen: () => Promise.resolve(false),
    setFullscreen: () => Promise.resolve(),
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: { getByLabel: () => Promise.resolve(null) },
  getAllWebviewWindows: () => Promise.resolve([]),
}));

const bus: EventBus = {
  handlers: shared.handlers,
  emitted: shared.emitted,
  emit: (event, payload) => {
    shared.emitted.push({ event, payload });
    for (const h of [...(shared.handlers.get(event) ?? [])]) h({ payload });
    return Promise.resolve();
  },
  listen: (event, handler) => {
    let set = shared.handlers.get(event);
    if (!set) {
      set = new Set();
      shared.handlers.set(event, set);
    }
    set.add(handler);
    return Promise.resolve(() => set.delete(handler));
  },
  reset: () => {
    shared.handlers.clear();
    shared.emitted.length = 0;
  },
};

/** A heap plus what steering in it needs: its own hook, steering store,
 *  popout view and React (`@testing-library/react` from the same registry). */
interface SteerHeap extends Heap {
  hook: typeof import("../../hooks/useSteering");
  steering: typeof import("../../stores/keyboardSteering");
  view: typeof import("../../stores/popoutView");
  react: typeof import("react");
  rtl: typeof import("@testing-library/react");
}

async function steerHeap(): Promise<SteerHeap> {
  const heap = await loadHeap();
  const [hook, steering, view, react, rtl] = await Promise.all([
    import("../../hooks/useSteering"),
    import("../../stores/keyboardSteering"),
    import("../../stores/popoutView"),
    import("react"),
    import("@testing-library/react"),
  ]);
  return { ...heap, hook, steering, view, react, rtl };
}

const unmounts: Array<() => void> = [];

function mountSteering(h: SteerHeap, surface: "main" | "popout") {
  function S() {
    h.hook.useSteering({ surface, onTogglePanels: () => {} });
    return null;
  }
  const r = h.rtl.render(h.react.createElement(S));
  unmounts.push(() => r.unmount());
}

const shell = (label: string) => ({ label, cmd: "bash", cwd: "/p", kind: "shell" as const });

/** The main window with tab `a` and `popouts` popped-out subwindows (one tab
 *  each), its detached host listening; each popout a heap of its own. */
async function windows(popouts = 1) {
  const main = await steerHeap();
  resetTabs(main, "p");
  const store = main.tabs.useTabsStore;
  store.getState().addTab(shell("a"));
  const labels: string[] = [];
  const groupIds: string[] = [];
  for (let i = 0; i < popouts; i++) {
    const t = store.getState().addTab(shell(`p${i}`));
    const rootGid = (store.getState().layout as { id: string }).id;
    store.getState().splitWithTab(t.key, rootGid, "right");
    const groupId = (store.getState().layout as { children: Array<{ id: string }> }).children[1].id;
    labels.push(store.getState().detachGroup(groupId, { skipBackend: true })!);
    groupIds.push(groupId);
  }
  unmounts.push(await main.detached.listenDetachedHost());
  mountSteering(main, "main");
  const pops: SteerHeap[] = [];
  for (let i = 0; i < popouts; i++) {
    const pop = await steerHeap();
    resetTabs(pop, "p");
    installPopoutContext(pop, bus, { scope: "p", groupId: groupIds[i], label: labels[i], targetGroupId: () => groupIds[i] });
    const record = store.getState().detachedGroupsByScope["p"]!.find((d) => d.id === groupIds[i])!;
    pop.view.usePopoutViewStore.getState().setView({
      scope: "p",
      popoutId: groupIds[i],
      label: labels[i],
      tree: record.subtree,
      tabs: store.getState().tabsByScope["p"]!,
    });
    mountSteering(pop, "popout");
    unmounts.push(() => pop.context.setDetachedWindowContext(null));
    pops.push(pop);
  }
  /** Popout `i`'s record in the main store. */
  const record = (i: number) => store.getState().detachedGroupsByScope["p"]!.find((d) => d.id === groupIds[i])!;
  /** Popout `i`'s view caught up with its record, as a reseed does. */
  const sync = async (i: number) => {
    await pops[i].rtl.act(async () =>
      pops[i].view.usePopoutViewStore.getState().setView({
        tree: record(i).subtree,
        tabs: store.getState().tabsByScope["p"]!,
      }),
    );
  };
  /** The key of popout `i`'s first tab, and of the main window's tab `a`. */
  const popTab = (i: number) => main.tabLayoutTree.orderedTabKeys(record(i).subtree)[0];
  const mainTab = store.getState().tabsByScope["p"]!.find((t) => t.label === "a")!.key;
  return { main, pops, labels, record, sync, popTab, mainTab, groupIds };
}

/** Mark `key` as asking for a decision, in the main window's classifier (the
 *  one window that sees every PTY). */
async function asks(main: SteerHeap, key: string) {
  await main.rtl.act(async () => {
    main.activity.useActivityStore.setState({ attentionByTab: { [`p:${key}`]: "decision" } });
  });
}

const on = (h: SteerHeap) => h.steering.useKeyboardSteeringStore.getState().active;

async function press(h: SteerHeap, key: string, init: KeyboardEventInit = {}) {
  await h.rtl.act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
    await new Promise((r) => setTimeout(r, 20));
  });
}

beforeEach(() => {
  shared.handlers.clear();
  shared.emitted.length = 0;
  shared.calls.length = 0;
  shared.focusOk = true;
  shared.hasFocus = true;
  shared.mainFocused = 0;
  vi.spyOn(document, "hasFocus").mockImplementation(() => shared.hasFocus);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 10, height: 5, x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 5, toJSON: () => ({}),
  });
  document.body.innerHTML =
    '<div class="detached-titlebar"><div class="detached-titlebar-actions"><button class="detached-dock-btn">d</button></div></div>';
});

afterEach(() => {
  for (const fn of unmounts.splice(0).reverse()) fn();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("steering follows the keyboard between windows", () => {
  it("J: main → popout → main, with one popout", async () => {
    const { main, pops, labels } = await windows(1);
    await main.rtl.act(async () => main.steering.useKeyboardSteeringStore.getState().enter());
    await press(main, "j");
    expect(shared.calls).toContainEqual({ cmd: "focus_detached_window", args: { label: labels[0] } });
    expect(on(pops[0])).toBe(true);
    expect(on(main)).toBe(false);
    await press(pops[0], "j");
    expect(on(main)).toBe(true);
    expect(main.steering.useKeyboardSteeringStore.getState().level).toBe("tabs");
    expect(on(pops[0])).toBe(false);
    expect(shared.mainFocused).toBeGreaterThan(0);
  });

  it("J: main → first → second → main, with two popouts", async () => {
    const { main, pops, labels } = await windows(2);
    await main.rtl.act(async () => main.steering.useKeyboardSteeringStore.getState().enter());
    await press(main, "j");
    expect([on(main), on(pops[0]), on(pops[1])]).toEqual([false, true, false]);
    await press(pops[0], "j");
    expect(shared.calls.filter((c) => c.cmd === "focus_detached_window").pop()?.args).toEqual({ label: labels[1] });
    expect([on(main), on(pops[0]), on(pops[1])]).toEqual([false, false, true]);
    await press(pops[1], "j");
    expect([on(main), on(pops[0]), on(pops[1])]).toEqual([true, false, false]);
    // And round again from the first.
    await press(main, "j");
    expect([on(main), on(pops[0]), on(pops[1])]).toEqual([false, true, false]);
  });

  it("Up from a popout's title bar hands the keyboard to the main window", async () => {
    const { main, pops } = await windows(1);
    const pop = pops[0];
    await pop.rtl.act(async () => pop.steering.useKeyboardSteeringStore.getState().enter());
    await press(pop, "ArrowUp");
    expect(pop.steering.useKeyboardSteeringStore.getState()).toMatchObject({ level: "region", region: "chrome" });
    await press(pop, "ArrowUp");
    expect(on(main)).toBe(true);
    expect(main.steering.useKeyboardSteeringStore.getState().level).toBe("tabs");
    expect(on(pop)).toBe(false);
  });

  it("a main-only key in a popout runs in the main window: / (settings) opens settings there", async () => {
    const { main, pops } = await windows(1);
    const opened = vi.fn();
    window.addEventListener("app:open-settings", opened);
    try {
      const pop = pops[0];
      await pop.rtl.act(async () => pop.steering.useKeyboardSteeringStore.getState().enter());
      await press(pop, "/");
      expect(opened).toHaveBeenCalledTimes(1);
      expect(main.steering.useKeyboardSteeringStore.getState()).toMatchObject({ active: true, level: "region", region: "settings" });
      expect(on(pop)).toBe(false);
    } finally {
      window.removeEventListener("app:open-settings", opened);
    }
  });

  it("a window that does not get the keyboard never announces: the sender keeps steering", async () => {
    const { main, pops } = await windows(1);
    const pop = pops[0];
    await pop.rtl.act(async () => pop.steering.useKeyboardSteeringStore.getState().enter());
    shared.hasFocus = false;
    await press(pop, "ArrowUp");
    await press(pop, "ArrowUp");
    await main.rtl.act(async () => {
      await new Promise((r) => setTimeout(r, 900));
    });
    expect(on(main)).toBe(false);
    expect(on(pop)).toBe(true);
    // A focus that arrives after the wait no longer pulls steering over.
    await main.rtl.act(async () => void window.dispatchEvent(new Event("focus")));
    expect(on(main)).toBe(false);
  });
});

describe("status jumps across windows", () => {
  const raised = () => shared.calls.filter((c) => c.cmd === "focus_detached_window").map((c) => (c.args as { label: string }).label);

  it("Q in a popout to a tab in the main window: the main window takes it, on that tab", async () => {
    const { main, pops, mainTab } = await windows(1);
    await asks(main, mainTab);
    const pop = pops[0];
    await pop.rtl.act(async () => pop.steering.useKeyboardSteeringStore.getState().enter());
    await press(pop, "q");
    expect(on(main)).toBe(true);
    expect(on(pop)).toBe(false);
    expect(main.tabs.useTabsStore.getState().activeKey).toBe(mainTab);
    expect(shared.mainFocused).toBeGreaterThan(0);
  });

  it("Q in a popout to a tab in another popout: that popout takes it", async () => {
    const { main, pops, labels, popTab } = await windows(2);
    await asks(main, popTab(1));
    await pops[0].rtl.act(async () => pops[0].steering.useKeyboardSteeringStore.getState().enter());
    await press(pops[0], "q");
    expect(raised()).toContain(labels[1]);
    expect([on(main), on(pops[0]), on(pops[1])]).toEqual([false, false, true]);
    expect(shared.mainFocused).toBe(0);
  });

  it("Q in a popout to a tab in the same popout: it stays, on that tab", async () => {
    const { main, pops, record, sync, groupIds, popTab } = await windows(1);
    const store = main.tabs.useTabsStore;
    const first = popTab(0);
    const second = store.getState().addDetachedTab("p", groupIds[0], shell("p0b"), groupIds[0])!;
    // Back on the first, the second asks.
    store.getState().applyDetachedEdit("p", groupIds[0], { kind: "activate", key: first });
    await sync(0);
    await asks(main, second);
    const pop = pops[0];
    await pop.rtl.act(async () => pop.steering.useKeyboardSteeringStore.getState().enter());
    await press(pop, "q");
    expect(on(pop)).toBe(true);
    expect(on(main)).toBe(false);
    expect(main.tabLayoutTree.allGroups(record(0).subtree)[0].activeKey).toBe(second);
    expect(shared.mainFocused).toBe(0);
  });

  it("Q in the main window to a tab in a popout, and Back across again", async () => {
    const { main, pops, labels, popTab, mainTab } = await windows(1);
    await asks(main, popTab(0));
    await main.rtl.act(async () => main.steering.useKeyboardSteeringStore.getState().enter());
    await press(main, "q");
    expect(raised()).toContain(labels[0]);
    expect(on(pops[0])).toBe(true);
    expect(on(main)).toBe(false);
    // Back, pressed in the popout: to the main window's tab the jump left.
    await pops[0].rtl.act(async () => pops[0].view.usePopoutViewStore.getState().setView({ tabs: main.tabs.useTabsStore.getState().tabsByScope["p"]! }));
    await press(pops[0], "Backspace");
    expect(on(main)).toBe(true);
    expect(on(pops[0])).toBe(false);
    expect(main.tabs.useTabsStore.getState().activeKey).toBe(mainTab);
  });

  it("the return after a digit answer moves only while the jump landed on that tab", async () => {
    const { main, pops, labels, popTab, groupIds, mainTab } = await windows(1);
    await asks(main, popTab(0));
    await main.rtl.act(async () => main.steering.useKeyboardSteeringStore.getState().enter());
    await press(main, "q");
    expect(on(pops[0])).toBe(true);
    const returnFrom = (key: string) =>
      main.rtl.act(async () => {
        await bus.emit(main.detached.DETACHED_STEER, {
          scope: "p",
          groupId: groupIds[0],
          label: labels[0],
          act: { kind: "action", action: "jumpBack", shift: false, auto: true },
          shown: { scope: "p", key },
        });
      });
    // Steering walked on to another tab meanwhile: nothing moves.
    await returnFrom("elsewhere");
    expect(on(main)).toBe(false);
    await returnFrom(popTab(0));
    expect(on(main)).toBe(true);
    expect(main.tabs.useTabsStore.getState().activeKey).toBe(mainTab);
  });

  it("the main window's counts reach the popout's bar", async () => {
    const { main, pops, popTab } = await windows(1);
    await asks(main, popTab(0));
    expect(pops[0].view.usePopoutViewStore.getState().status).toMatchObject({ decision: 1, working: 0, done: 0 });
  });
});
