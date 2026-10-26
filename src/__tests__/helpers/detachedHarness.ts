/**
 * Group B #240: the two-heap harness — a main window and a popout, in one test.
 *
 * Every suite before this one drove ONE store. That is why none of #224–#236 was
 * under test: each of them is a disagreement BETWEEN the two heaps (an id minted
 * on one side and unknown on the other, a settings snapshot one window kept
 * while the other wrote the file, a record left standing in one when the window
 * backing it died in the other), and a single store cannot disagree with itself.
 *
 * What this gives a test:
 *   - `main` — the real `stores/tabs` + `stores/detached` host, wired exactly as
 *     `AppShell` wires it.
 *   - `popout` — a SECOND module registry (`vi.resetModules` + a fresh dynamic
 *     import), i.e. a genuinely separate `useTabsStore`, `useSettingsStore` and
 *     `useActivityStore` instance, with `stores/detachedContext` installed the
 *     way `DetachedApp` installs it.
 *   - one shared event bus, so an `emit` in either heap reaches the listeners in
 *     both — which is what makes a round trip (popout edit → main store → reseed
 *     → popout state) a thing a test can assert on.
 *
 * The bus is deliberately synchronous: Tauri's is not, but ordering across the
 * two windows is settled by the protocol (a seed is a reply to a request, a
 * reseed follows an edit), so making delivery immediate removes a source of
 * flakiness without removing anything a test is trying to check.
 */
import { vi } from "vitest";

type Handler = (ev: { payload: unknown }) => void;

/** The one bus both heaps' mocked `@tauri-apps/api/event` talks to. */
export interface EventBus {
  handlers: Map<string, Set<Handler>>;
  emitted: Array<{ event: string; payload: unknown }>;
  emit: (event: string, payload?: unknown) => Promise<void>;
  listen: (event: string, handler: Handler) => Promise<() => void>;
  /** Drop every listener and record (between cases). */
  reset: () => void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<Handler>>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  return {
    handlers,
    emitted,
    emit: (event, payload) => {
      emitted.push({ event, payload });
      // Snapshot: a handler may add or drop listeners (a reseed lands while the
      // edit that caused it is still being delivered).
      for (const h of [...(handlers.get(event) ?? [])]) h({ payload });
      return Promise.resolve();
    },
    listen: (event, handler) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return Promise.resolve(() => {
        set.delete(handler);
        if (set.size === 0) handlers.delete(event);
      });
    },
    reset: () => {
      handlers.clear();
      emitted.length = 0;
    },
  };
}

/** Backend calls, recorded rather than performed. */
export interface InvokeLog {
  calls: Array<{ cmd: string; args: unknown }>;
  /** Command → canned answer; anything else resolves undefined. */
  answers: Map<string, unknown>;
  invoke: (cmd: string, args?: unknown) => Promise<unknown>;
  names: () => string[];
  reset: () => void;
}

export function createInvokeLog(): InvokeLog {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const answers = new Map<string, unknown>();
  return {
    calls,
    answers,
    invoke: (cmd, args) => {
      calls.push({ cmd, args });
      return Promise.resolve(answers.has(cmd) ? answers.get(cmd) : undefined);
    },
    names: () => calls.map((c) => c.cmd),
    reset: () => {
      calls.length = 0;
    },
  };
}

/** The live windows a `getAllWebviewWindows`/`getByLabel` stub reports. */
export interface WindowRegistry {
  labels: Set<string>;
  destroyed: string[];
  reset: () => void;
}

export function createWindowRegistry(): WindowRegistry {
  return {
    labels: new Set<string>(),
    destroyed: [],
    reset() {
      this.labels.clear();
      this.destroyed.length = 0;
    },
  };
}

/** One heap's view of the modules a detached test drives. */
export interface Heap {
  tabs: typeof import("../../stores/tabs");
  /** The tab store's pure parts that hold per-heap state or are read per heap. */
  tabLayoutTree: typeof import("../../stores/tabs/layoutTree");
  tabViewerState: typeof import("../../stores/tabs/viewerState");
  detached: typeof import("../../stores/detached");
  settings: typeof import("../../stores/settings");
  activity: typeof import("../../stores/activity");
  context: typeof import("../../stores/detachedContext");
  projects: typeof import("../../stores/projects");
  boxes: typeof import("../../stores/boxes");
  remoteStatus: typeof import("../../stores/remote/remoteStatus");
  usage: typeof import("../../stores/usage");
  runHostPref: typeof import("../../stores/remote/runHostPref");
}

/**
 * Import a fresh copy of the store modules — a second JS heap, as far as module
 * state is concerned. `vi.resetModules()` clears the registry, so the dynamic
 * imports that follow evaluate the modules again and hand back new store
 * instances; the mocks (which are hoisted and registry-independent) still point
 * at the shared bus, so the two heaps can talk.
 */
export async function loadHeap(): Promise<Heap> {
  vi.resetModules();
  const [tabs, tabLayoutTree, tabViewerState, detached, settings, activity, context, projects, boxes, remoteStatus, usage, runHostPref] =
    await Promise.all([
      import("../../stores/tabs"),
      import("../../stores/tabs/layoutTree"),
      import("../../stores/tabs/viewerState"),
      import("../../stores/detached"),
      import("../../stores/settings"),
      import("../../stores/activity"),
      import("../../stores/detachedContext"),
      import("../../stores/projects"),
      import("../../stores/boxes"),
      import("../../stores/remote/remoteStatus"),
      import("../../stores/usage"),
      import("../../stores/remote/runHostPref"),
    ]);
  return {
    tabs,
    tabLayoutTree,
    tabViewerState,
    detached,
    settings,
    activity,
    context,
    projects,
    boxes,
    remoteStatus,
    usage,
    runHostPref,
  };
}

/** Reset a heap's tab store to an empty scope. */
export function resetTabs(heap: Heap, scope = "p"): void {
  heap.tabs.useTabsStore.setState({
    scope,
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
    pendingRespawnByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
    fullscreenGroupId: null,
  });
}

/**
 * Install the popout's store seam in `heap`, the way `DetachedApp` does: edits
 * are streamed on the shared bus, so the main heap's host applies them.
 */
export function installPopoutContext(
  heap: Heap,
  bus: EventBus,
  opts: { scope: string; groupId: string; label: string; targetGroupId: () => string },
): void {
  heap.context.setDetachedWindowContext({
    scope: opts.scope,
    groupId: opts.groupId,
    label: opts.label,
    targetGroupId: opts.targetGroupId,
    pushEdit: (edit) => {
      void bus.emit(heap.detached.DETACHED_EDIT, {
        scope: opts.scope,
        groupId: opts.groupId,
        edit,
      });
    },
    closeTab: (key) => {
      void bus.emit(heap.detached.DETACHED_EDIT, {
        scope: opts.scope,
        groupId: opts.groupId,
        edit: { kind: "close", key },
      });
    },
  });
}

/**
 * A popout's renderer state, driven by the seeds the host emits — the part of
 * `DetachedApp` a store test needs: it holds the streamed subtree and tab
 * payloads, so a test can assert that the two windows agree.
 */
export interface FakePopout {
  label: string;
  scope: string;
  groupId: string;
  subtree: import("../../stores/tabs").LayoutNode | null;
  tabs: import("../../stores/tabs").TabEntry[];
  remote: import("../../stores/detached").DetachedRemoteInfo | undefined;
  seeds: number;
  landedKeys: string[];
  /** Ask the host for a seed, as the real popout does on mount. */
  requestSeed: () => Promise<void>;
  dispose: () => void;
}

export async function mountFakePopout(
  heap: Heap,
  bus: EventBus,
  opts: { scope: string; groupId: string; label: string },
): Promise<FakePopout> {
  const popout: FakePopout = {
    label: opts.label,
    scope: opts.scope,
    groupId: opts.groupId,
    subtree: null,
    tabs: [],
    remote: undefined,
    seeds: 0,
    landedKeys: [],
    requestSeed: async () => {
      await bus.emit(heap.detached.DETACHED_REQUEST_SEED, {
        label: opts.label,
        scope: opts.scope,
        groupId: opts.groupId,
      });
    },
    dispose: () => un(),
  };
  const un = await bus.listen(heap.detached.detachedSeedEvent(opts.label), (ev) => {
    const seed = ev.payload as import("../../stores/detached").DetachedSeed & {
      landedKey?: string;
    };
    popout.seeds += 1;
    popout.subtree = seed.subtree;
    popout.tabs = seed.tabs;
    popout.remote = seed.remote;
    if (seed.landedKey) popout.landedKeys.push(seed.landedKey);
  });
  return popout;
}
