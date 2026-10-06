/**
 * Group B: the cases that need TWO windows (#240's harness in use).
 *
 * A popout is a second React root with its own Zustand heap, kept in step by a
 * streamed protocol — and every bug in this group is one place that forgot it.
 * Each case here drives a real main-window host against a real second heap and
 * asserts the two agree afterwards; none of #224–#236 could be tested before,
 * because a single store cannot disagree with itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { waitFor } from "@testing-library/react";

import {
  installPopoutContext,
  loadHeap,
  mountFakePopout,
  resetTabs,
  type EventBus,
} from "../helpers/detachedHarness";
import { BRAND } from "../../lib/brand";

// Hoisted so both heaps' mocked modules reach the SAME doubles: that shared bus
// is what makes one window's emit arrive at the other window's listener.
const shared = vi.hoisted(() => ({
  handlers: new Map<string, Set<(ev: { payload: unknown }) => void>>(),
  emitted: [] as Array<{ event: string; payload: unknown }>,
  calls: [] as Array<{ cmd: string; args: unknown }>,
  answers: new Map<string, unknown>(),
  fail: new Set<string>(),
  live: new Set<string>(),
  destroyed: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: unknown) => {
    shared.calls.push({ cmd, args });
    if (shared.fail.has(cmd)) return Promise.reject(new Error(`${cmd} failed`));
    return Promise.resolve(shared.answers.has(cmd) ? shared.answers.get(cmd) : undefined);
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
      if (set.size === 0) shared.handlers.delete(event);
    });
  },
}));
const fakeWindow = (label: string) => ({
  label,
  destroy: () => {
    shared.live.delete(label);
    shared.destroyed.push(label);
    return Promise.resolve();
  },
});
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: {
    getByLabel: (label: string) =>
      Promise.resolve(shared.live.has(label) ? fakeWindow(label) : null),
  },
  getAllWebviewWindows: () => Promise.resolve([...shared.live].map(fakeWindow)),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main", setFocus: () => Promise.resolve() }),
}));

/** The bus the harness helpers emit/listen on — the same maps the mocks use. */
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
    return Promise.resolve(() => {
      set.delete(handler);
      if (set.size === 0) shared.handlers.delete(event);
    });
  },
  reset: () => {
    shared.handlers.clear();
    shared.emitted.length = 0;
  },
};

function shell(label: string) {
  return { label, cmd: "bash", cwd: "/p", kind: "shell" as const };
}

const teardown: Array<() => void> = [];

/** Main heap + one detached group holding tab `b` — what every case starts from. */
async function setup(project?: Record<string, unknown>) {
  const main = await loadHeap();
  resetTabs(main, "p");
  main.projects.useProjectsStore.setState({ projects: project ? [project as never] : [] });
  const a = main.tabs.useTabsStore.getState().addTab(shell("a"));
  const b = main.tabs.useTabsStore.getState().addTab(shell("b"));
  const rootGid = (main.tabs.useTabsStore.getState().layout as { id: string }).id;
  main.tabs.useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
  const root = main.tabs.useTabsStore.getState().layout as { children: Array<{ id: string }> };
  const groupId = root.children[1].id;
  const label = main.tabs.useTabsStore.getState().detachGroup(groupId, { skipBackend: true })!;
  shared.live.add(label);
  const unhost = await main.detached.listenDetachedHost();
  teardown.push(unhost);
  return { main, a, b, groupId, label };
}

/** A second heap standing in for the popout's renderer, seam installed. */
async function popoutHeapFor(scope: string, groupId: string, label: string) {
  const heap = await loadHeap();
  resetTabs(heap, scope);
  installPopoutContext(heap, bus, { scope, groupId, label, targetGroupId: () => groupId });
  teardown.push(() => heap.context.setDetachedWindowContext(null));
  return heap;
}

describe("Group B — two heaps, one protocol", () => {
  beforeEach(() => {
    shared.handlers.clear();
    shared.emitted.length = 0;
    shared.calls.length = 0;
    shared.answers.clear();
    shared.fail.clear();
    shared.live.clear();
    shared.destroyed.length = 0;
  });
  afterEach(() => {
    for (const fn of teardown.splice(0)) fn();
    vi.useRealTimers();
  });

  // ── #240: the harness itself ────────────────────────────────────────────
  it("a popout and the main window are genuinely separate store instances", async () => {
    const { main, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);

    expect(popout.tabs.useTabsStore).not.toBe(main.tabs.useTabsStore);
    // The popout's store holds no tabs and no layout — the one fact every bug in
    // this group comes back to.
    expect(popout.tabs.useTabsStore.getState().tabs).toHaveLength(0);
    expect(main.tabs.useTabsStore.getState().tabs.length).toBeGreaterThan(0);
  });

  // ── #231: pane writes made in a popout reach the main store ─────────────
  it("viewer state set in a popout lands on the main window's tab payload", async () => {
    const { main, b, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);

    // A breakpoint set in a popped-out .py: `setViewerState` against a store
    // with no such tab, which returned `{}` — so scroll, zoom, sort, delimiter
    // and breakpoints were all lost at the next relaunch.
    popout.tabs.useTabsStore.getState().setViewerState(b.key, { breakpoints: [12] });

    const payload = main.tabs.useTabsStore
      .getState()
      .tabsByScope["p"]!.find((t) => t.key === b.key);
    expect(payload?.viewerState?.breakpoints).toEqual([12]);
    // The popout's own seed registry knows it too, so a pane remounting before
    // the next reseed still recovers what it just wrote.
    expect(popout.tabs.getDetachedViewerState(b.key)?.breakpoints).toEqual([12]);
  });

  it("a tmux rename and a browsed folder from a popout reach the main payload", async () => {
    const { main, b, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);

    popout.tabs.useTabsStore.getState().setTabTmuxName("p", b.key, `${BRAND.slug}-p--shell-renamed`);
    popout.tabs.useTabsStore.getState().setTabFolder(b.key, "src/deep");

    const payload = main.tabs.useTabsStore
      .getState()
      .tabsByScope["p"]!.find((t) => t.key === b.key);
    // Without the forward, a renamed session reattached to its OLD name.
    expect(payload?.tmuxSession).toBe(`${BRAND.slug}-p--shell-renamed`);
    expect(payload?.folder).toBe("src/deep");
  });

  it("opening a link in a popout mints the tab in the main window, inside the popout", async () => {
    const { main, groupId, label } = await setup();
    const view = await mountFakePopout(main, bus, { scope: "p", groupId, label });
    teardown.push(view.dispose);
    const popout = await popoutHeapFor("p", groupId, label);

    // Ctrl+click on a link in a popped-out README: `addTab` against a store with
    // no layout, which used to file the tab into a phantom group nobody renders.
    popout.tabs.useTabsStore.getState().addTab({
      label: "readme.md",
      cmd: "",
      cwd: "/p",
      kind: "embed",
      embedPath: "/p/readme.md",
      viewer: "markdown",
    });

    const rec = main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]![0];
    expect(main.tabs.orderedTabKeys(rec.subtree)).toHaveLength(2);
    const created = main.tabs.useTabsStore
      .getState()
      .tabsByScope["p"]!.find((t) => t.embedPath === "/p/readme.md");
    expect(created).toBeDefined();
    // …and the popout is re-seeded so it renders (and attaches to) the new tab.
    expect(view.landedKeys).toContain(created!.key);
  });

  it("a shell added from a popout inherits the project's run-host preference", async () => {
    const { main, groupId, label } = await setup();
    // The preference is read by the MAIN heap (it mints the tab), so it is that
    // heap's store instance the test has to set.
    main.runHostPref.useRunHostPrefStore.setState({ byProject: { p: "host:w1" } } as never);
    const popout = await popoutHeapFor("p", groupId, label);

    // "Pick machine X ⇒ every shell runs on X" — which "+ Shell" in a popout
    // ignored, because `addDetachedTab` applied `withTmuxSession` and not
    // `withRunHostDefault`: the tab silently ran on the wrong machine.
    popout.tabs.useTabsStore.getState().addTab(shell("new"));

    const created = main.tabs.useTabsStore
      .getState()
      .tabsByScope["p"]!.find((t) => t.label === "new");
    expect(created?.location).toBe("host:w1");
  });

  // ── #234: a popped-out agent's activity reaches the classifier ──────────
  it("input typed in a popout flips the main window's classifier for that tab", async () => {
    vi.useFakeTimers();
    const { main, b, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);
    const ptyId = `p:${b.key}`;

    // "working" requires input THIS SESSION (so a restored tab's resume banner
    // never reads as work). A popout recorded that into its own, never-read
    // activity store, so a popped-out agent could never light the project pill.
    popout.activity.noteUserInput(ptyId);
    vi.advanceTimersByTime(200); // past ECHO_MS: the agent's frames, not the keystroke's echo
    main.activity.notePtyOutput(ptyId, "thinking…");
    vi.advanceTimersByTime(700);
    main.activity.notePtyOutput(ptyId, "still…");
    vi.advanceTimersByTime(700);
    main.activity.notePtyOutput(ptyId, "nearly…");
    vi.advanceTimersByTime(200);
    main.activity.useActivityStore.getState().recompute();

    expect(main.activity.useActivityStore.getState().busyByTab[ptyId]).toBe(true);
  });

  it("the main window mirrors its verdict back, and the popout adopts it", async () => {
    const { main, b, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);
    const rec = main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]![0];

    const status = main.detached.statusForEntry(
      "p",
      rec,
      main.tabs.useTabsStore.getState().tabsByScope["p"]!,
      { [`p:${b.key}`]: true },
      {},
    );
    // A shell tab: busy with a command, which is its own colour.
    expect(status[b.key]).toBe("working-shell");

    popout.activity.applyDetachedStatus("p", status);
    // The popout's strip reads exactly what `TabBar` reads.
    expect(popout.activity.useActivityStore.getState().busyByTab[`p:${b.key}`]).toBe(true);
    expect(popout.activity.useActivityStore.getState().busyKindByTab[`p:${b.key}`]).toBe("shell");

    // What the tab is busy WITH rides along too, so a popped-out agent working
    // with a shell of its own wears the same two marks a docked one does.
    const both = main.detached.statusForEntry(
      "p",
      rec,
      main.tabs.useTabsStore.getState().tabsByScope["p"]!,
      { [`p:${b.key}`]: true },
      {},
      { [`p:${b.key}`]: "both" },
    );
    expect(both[b.key]).toBe("working-both");
    popout.activity.applyDetachedStatus("p", both);
    expect(popout.activity.useActivityStore.getState().busyKindByTab[`p:${b.key}`]).toBe("both");
  });

  it("a popout's usage bumps leave its own accumulator empty and reach the main one", async () => {
    const { main, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);

    popout.usage.bumpUsage("p", "agent.prompt.claude", 1);

    // The popout's accumulator is never flushed (only the shell flushes), so a
    // prompt typed there used to be dropped on the floor.
    expect(popout.usage._pendingUsageForTest()).toEqual({});
    expect(main.usage._pendingUsageForTest()["p"]?.["agent.prompt.claude"]).toBe(1);
    main.usage._resetUsageForTest();
  });

  // ── #226: settings written in one window do not clobber the other ───────
  it("a popout sends an atomic patch and adopts the backend's merged settings", async () => {
    const { groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);

    // The popout loaded settings once, at mount.
    shared.answers.set("get_settings", { color_scheme: "fancy_dark", hpc_hosts: [] });
    popout.settings.useSettingsStore.setState({
      settings: { color_scheme: "fancy_dark", hpc_hosts: [] } as never,
      loaded: true,
    });
    // The main window then changed the theme and added an HPC host.
    shared.answers.set("patch_settings", {
      color_scheme: "soft_dark",
      hpc_hosts: ["login.example"],
      files_alerts_muted: ["m1"],
    });

    // Now the popout mutes one alert. Before #226 this spread its own stale
    // snapshot over the whole file and both of those changes were gone.
    await popout.settings.useSettingsStore
      .getState()
      .updateSettings({ files_alerts_muted: ["m1"] } as never);

    const write = [...shared.calls].reverse().find((c) => c.cmd === "patch_settings");
    expect((write!.args as { patch: Record<string, unknown> }).patch).toEqual({
      files_alerts_muted: ["m1"],
    });
    expect(shared.calls.some((call) => call.cmd === "save_settings")).toBe(false);
    expect(popout.settings.useSettingsStore.getState().settings).toMatchObject({
      files_alerts_muted: ["m1"],
      color_scheme: "soft_dark",
      hpc_hosts: ["login.example"],
    });
  });

  it("the settings broadcast updates every window's store, not just its DOM", async () => {
    const { main } = await setup();
    const other = await loadHeap();
    const un = await other.settings.listenSettingsChanged();
    teardown.push(un);

    shared.answers.set("patch_settings", { color_scheme: "soft_dark" });
    shared.answers.set("get_settings", { color_scheme: "soft_dark" });
    await main.settings.useSettingsStore.getState().setTheme("soft_dark");

    // The other window's STORE follows — which is what its xterm palette, its
    // shortcut map and its Fast-mode read all key off.
    await waitFor(() => {
      expect(other.settings.useSettingsStore.getState().settings?.color_scheme).toBe("soft_dark");
    });
  });

  // ── #224: a popout's death, and a detach that never opened ──────────────
  it("a popout destroyed behind the store's back reopens separately", async () => {
    const { main, b, label } = await setup();

    // `xkill`, a renderer crash, the seed timeout: the window is gone and the
    // record still stands. It used to stay standing — tabs out of the layout,
    // PTYs running hidden, `detached: true` persisted so the failure repeated at
    // every launch, and no dock-back gesture to recover with.
    shared.live.delete(label);
    await bus.emit("detached-window-destroyed", { label });

    expect(main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
    expect(main.tabs.orderedTabKeys(main.tabs.useTabsStore.getState().layout)).not.toContain(b.key);
    expect(shared.calls.some((c) => c.cmd === "detach_subwindow")).toBe(true);
  });

  it("a popout a Wayland scope-out retired comes back from its kept record", async () => {
    const { main, b, groupId, label } = await setup();
    const store = main.tabs.useTabsStore;
    const detachCalls = () => shared.calls.filter((c) => c.cmd === "detach_subwindow");

    // Leaving the scope: the backend closes the window as a planned retire,
    // which it does NOT report as a death — so nothing docks back.
    store.getState().setScope("q");
    shared.live.delete(label);
    await waitFor(() =>
      expect(shared.calls.some((c) => c.cmd === "sync_detached_scope")).toBe(true),
    );
    expect(store.getState().detachedGroupsByScope["p"]).toHaveLength(1);
    expect(detachCalls()).toHaveLength(0);

    // Returning asks for it again, under the same label …
    store.getState().setScope("p");
    await waitFor(() => expect(detachCalls()).toHaveLength(1));
    expect(detachCalls()[0].args).toMatchObject({ projectId: "p", groupId });

    // … and the rebuilt window is seeded from the record the retire kept.
    const view = await mountFakePopout(main, bus, { scope: "p", groupId, label });
    teardown.push(view.dispose);
    await view.requestSeed();
    expect(main.tabs.orderedTabKeys(view.subtree)).toEqual([b.key]);

    // A real crash after that reopens the detached window from its record.
    shared.live.delete(label);
    await bus.emit("detached-window-destroyed", { label });
    expect(store.getState().detachedGroupsByScope["p"]).toHaveLength(1);
    expect(main.tabs.orderedTabKeys(store.getState().layout)).not.toContain(b.key);
    await waitFor(() => expect(detachCalls()).toHaveLength(2));
  });

  it("a detach whose window fails to open docks after bounded retries", async () => {
    const main = await loadHeap();
    resetTabs(main, "p");
    main.tabs.useTabsStore.getState().addTab(shell("a"));
    const b = main.tabs.useTabsStore.getState().addTab(shell("b"));
    const rootGid = (main.tabs.useTabsStore.getState().layout as { id: string }).id;
    main.tabs.useTabsStore.getState().splitWithTab(b.key, rootGid, "right");
    const root = main.tabs.useTabsStore.getState().layout as { children: Array<{ id: string }> };
    shared.fail.add("detach_subwindow");

    vi.useFakeTimers();
    try {
      main.tabs.useTabsStore.getState().detachGroup(root.children[1].id);
      await Promise.resolve();
      expect(main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
      // Switching to one screen reconfigures the outputs for seconds: still
      // detached well after the old 3 s and 30 s budgets.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(150_000);

      // A permanent failure still leaves the tabs reachable in the main layout.
      expect(main.tabs.useTabsStore.getState().detachedGroupsByScope["p"] ?? []).toHaveLength(0);
      expect(main.tabs.orderedTabKeys(main.tabs.useTabsStore.getState().layout)).toContain(b.key);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── #228: emptying a scope takes its popouts with it ────────────────────
  it("closing all tabs kills the popout's PTYs and drops its record", async () => {
    const { main, b, label } = await setup();
    shared.calls.length = 0;

    main.tabs.useTabsStore.getState().closeAllTabs("p");

    // The record used to survive, so `isDetachedPtyId` still said "detached" and
    // the unmounting panes skipped their kill — orphaned shells, a popout
    // rendering keys with no payload, and an × that did nothing.
    expect(main.tabs.useTabsStore.getState().detachedGroupsByScope["p"] ?? []).toHaveLength(0);
    expect(shared.calls).toContainEqual({ cmd: "pty_kill", args: { id: `p:${b.key}` } });
    expect(shared.calls).toContainEqual({
      cmd: "attach_subwindow",
      args: { registryId: label },
    });
  });

  // ── #225: a reload must not leave two popouts for one group ─────────────
  it("startup destroys popout windows the store knows nothing about", async () => {
    const main = await loadHeap();
    resetTabs(main, "p");
    // A reload: the windows survived, the store did not.
    shared.live.add("detached-p-g-7");
    shared.live.add("detached-p-g-9");
    shared.live.add("main");

    await main.detached.closeOrphanedPopouts();

    expect(shared.destroyed).toEqual(
      expect.arrayContaining(["detached-p-g-7", "detached-p-g-9"]),
    );
    expect(shared.destroyed).not.toContain("main");
  });

  it("startup leaves a popout the store still tracks", async () => {
    const { label } = await setup();
    shared.live.add("detached-p-stale");

    await (await loadHeapKeeping()).detached.closeOrphanedPopouts();

    expect(shared.destroyed).toContain("detached-p-stale");
    expect(shared.destroyed).not.toContain(label);
  });

  // ── #230: a dock into a popout keeps its project context ────────────────
  it("a reseed after a dock carries the same project context as the first seed", async () => {
    const { main, a, groupId, label } = await setup({
      id: "p",
      name: "p",
      directory: "/p",
      local_file: "/p/project.json",
      remote: { host: "host.example", user: "u", path: "/remote/p" },
    });
    const view = await mountFakePopout(main, bus, { scope: "p", groupId, label });
    teardown.push(view.dispose);

    await view.requestSeed();
    expect((view.remote as { primaryHost?: string })?.primaryHost).toBe("host.example");

    // Dock the main window's other tab into the popout and reseed — the path
    // that called `buildSeed` with five arguments and dropped `remote`, so every
    // dock wiped a remote project's popout: locality badges gone, its docked
    // viewer reading the tree as a plain local folder.
    main.tabs.useTabsStore.getState().dockTabIntoDetached("p", groupId, a.key);
    main.detached.reseedDetached("p", groupId, a.key);

    expect((view.remote as { primaryHost?: string })?.primaryHost).toBe("host.example");
    expect(view.landedKeys).toContain(a.key);
  });

  // ── #232: every project scope gets an identity, not just remote ones ────
  it("a LOCAL project's popout is seeded with its project entry", async () => {
    const { main } = await setup({
      id: "p",
      name: "p",
      directory: "/p",
      local_file: "/p/project.json",
    });

    const info = main.detached.projectInfoForScope("p");

    // `undefined` before #232 for any project without a `remote` — which is why
    // a local project's popout showed a bare tree: no git bar, no history, no
    // Apps/Sessions, no remarks, no type tags.
    expect(info?.project?.id).toBe("p");
    expect(info?.primaryHost).toBeUndefined();
  });

  it("a box seed carries both its record and its member projects", async () => {
    const main = await loadHeap();
    main.projects.useProjectsStore.setState({
      projects: [
        { id: "p1", name: "one", status: "active", position: 1, local_file: "/p1/project.json" },
        { id: "p2", name: "two", status: "active", position: 2, local_file: "/p2/project.json" },
      ] as never,
    });
    main.boxes.useBoxesStore.setState({
      boxes: [{ id: "b1", name: "box", member_ids: ["p1", "p2"], position: 1 }],
      loaded: true,
    });

    const info = main.detached.projectInfoForScope("box:b1");

    expect(info?.box?.id).toBe("b1");
    expect(info?.boxMembers?.map((project) => project.id)).toEqual(["p1", "p2"]);
  });

  it("a worker status change is included in the next automatic reseed", async () => {
    vi.useFakeTimers();
    const { main, groupId, label } = await setup({
      id: "p",
      name: "p",
      status: "active",
      position: 1,
      local_file: "/p/project.json",
      remote: { host: "host.example", user: "u", path: "/remote/p" },
      compute_hosts: [
        { id: "worker-1", host: "worker.example", remote_path: "/remote/p", label: "GPU" },
      ],
    });
    const view = await mountFakePopout(main, bus, { scope: "p", groupId, label });
    teardown.push(view.dispose);
    await view.requestSeed();

    main.remoteStatus.useRemoteStatusStore.getState().setSsh("p", "connected", "worker-1");
    await vi.advanceTimersByTimeAsync(151);

    expect(view.remote?.hostStates?.["worker-1"]?.ssh).toBe("connected");
  });

  // ── #227: both windows name a popout-side split identically ─────────────
  it("a split minted in the popout is adopted by the main store", async () => {
    const { main, b, groupId, label } = await setup();
    const popout = await popoutHeapFor("p", groupId, label);
    const rec = main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]![0];

    // The popout's counter starts at 0 in ITS heap; the ids are namespaced by
    // label and checked against the tree it already renders, so a counter reset
    // by a webview reload cannot re-mint an id that tree still carries.
    const ids = popout.detached.mintDetachedSplitIds(
      label,
      popout.tabs.allNodeIds(rec.subtree),
    );
    const edit = {
      kind: "split" as const,
      key: b.key,
      targetGroupId: (rec.subtree as { id: string }).id,
      edge: "right" as const,
      newGroupId: ids.groupId,
      newSplitId: ids.splitId,
    };
    const popoutTree = popout.detached.applyEditToSubtree(rec.subtree, edit);
    main.tabs.useTabsStore.getState().applyDetachedEdit("p", groupId, edit);
    const mainTree = main.tabs.useTabsStore.getState().detachedGroupsByScope["p"]![0].subtree;

    // Same names on both sides — so a drop target the popout reports, and a
    // divider it resizes, address a node the main store actually has.
    expect(popout.tabs.allNodeIds(popoutTree)).toEqual(main.tabs.allNodeIds(mainTree));
  });

  it("a fresh popout heap cannot re-mint an id its tree already carries", async () => {
    const heap = await loadHeap();
    const taken = ["g-detached-p-g-1-1", "s-detached-p-g-1-1"];
    const ids = heap.detached.mintDetachedSplitIds("detached-p-g-1", taken);
    expect(taken).not.toContain(ids.groupId);
    expect(taken).not.toContain(ids.splitId);
  });

  // ── #238: a stale close cannot delete a tab that already moved ──────────
  it("a close edit that races a dock does not delete the docked tab", async () => {
    const { main, b, groupId } = await setup();

    // The tab is dragged out of the popout into the main layout…
    main.tabs.useTabsStore
      .getState()
      .attachDetachedTab("p", groupId, b.key, { skipBackend: true });
    // …and the popout's in-flight `close` for it lands afterwards.
    main.tabs.useTabsStore.getState().applyDetachedEdit("p", groupId, {
      kind: "close",
      key: b.key,
    });

    // The payload survives: it lives in the main layout now, not in that popout.
    expect(
      main.tabs.useTabsStore.getState().tabsByScope["p"]!.some((t) => t.key === b.key),
    ).toBe(true);
  });
});

/** Re-import the store modules WITHOUT resetting them — the same instances the
 *  current `setup()` is driving, so `closeOrphanedPopouts` sees its records. */
async function loadHeapKeeping() {
  return { detached: await import("../../stores/detached") };
}
