/**
 * Withdrawing an experiment that owns a tab (`lib/experimental`'s
 * EXPERIMENTAL_TAB_KINDS + `lib/experimentalSweep` + the restore filter in
 * `stores/tabs`), and its permanent cousin: **retirement**.
 *
 * Every other experimental flag only hides a control. The browser owns a whole
 * tab, and for it "off" has to mean the tab is gone — a switch that leaves a
 * network client on screen is not a switch. Three things are locked in here: the
 * withdrawal itself, the two exceptions that keep it from doing damage (an
 * unknown settings state withdraws nothing; a popout's tabs are the popout's to
 * close), and the restore half, without which a swept tab would come back on the
 * next launch.
 *
 * Mail used to be the second such kind and is now the *retired* one — the tab is
 * gone for good, the header overlay is the whole client. That case is the last
 * describe below, and it is deliberately the opposite of a withdrawal in the one
 * way that matters: it is unconditional. A withdrawal waits for settings to load
 * (a flag might be on); a retired kind cannot come back, and the fall-through for
 * its unrecognized `cmd` is `"shell"` — so waiting would mean restoring a
 * terminal that runs `__tabtivity_mail__`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));

import { withdrawnTabKinds } from "../../lib/experimental";
import { useSettingsStore } from "../../stores/settings";
import {
  BROWSER_TAB_CMD,
  MAIL_TAB_CMD,
  RETIRED_TAB_CMDS,
  orderedTabKeys,
  useTabsStore,
  type TabEntry,
} from "../../stores/tabs";
import type { Settings } from "../../types";

const s = (o: Partial<Settings>): Settings => o as Settings;

function resetTabs() {
  useTabsStore.setState({
    scope: "p",
    tabs: [],
    layout: null,
    tabsByScope: {},
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
    hiddenGroupsByScope: {},
  });
}

/** A shell tab and a browser tab in one group. */
function seedTwoTabs(): { shell: TabEntry; browser: TabEntry } {
  const store = useTabsStore.getState();
  const shell = store.addTab({ label: "Shell", cmd: "bash", cwd: "/tmp", kind: "shell" });
  const browser = store.addTab({
    label: "Browser",
    cmd: BROWSER_TAB_CMD,
    cwd: "/tmp",
    kind: "browser",
    url: "https://example.com/",
  });
  return { shell, browser };
}

beforeEach(() => {
  resetTabs();
  useSettingsStore.setState({ settings: null });
});

describe("withdrawnTabKinds", () => {
  it("withdraws nothing while settings have not loaded", () => {
    // The load-bearing case: unknown is not off. The settings store fills in
    // asynchronously, so treating null as "everything is disabled" would close a
    // restored browser tab in the gap before the first read lands.
    expect(withdrawnTabKinds(null)).toEqual([]);
    expect(withdrawnTabKinds(undefined)).toEqual([]);
  });

  it("withdraws the browser tab when its flag is off", () => {
    expect(withdrawnTabKinds(s({}))).toEqual(["browser"]);
  });

  it("withdraws nothing in debug mode — unset follows debug", () => {
    expect(withdrawnTabKinds(s({ debug: true }))).toEqual([]);
  });

  it("follows an explicit flag in either direction", () => {
    expect(withdrawnTabKinds(s({ web_browser: true }))).toEqual([]);
    // Off while in debug mode still means off.
    expect(withdrawnTabKinds(s({ debug: true, web_browser: false }))).toEqual(["browser"]);
  });

  it("does not list mail — it is retired, not switchable", () => {
    // `mail_client` still exists and still gates the header button, but it no
    // longer owns a tab kind, so it has nothing to withdraw from a layout.
    expect(withdrawnTabKinds(s({ mail_client: false }))).not.toContain("mail");
    expect(withdrawnTabKinds(s({ mail_client: false, web_browser: true }))).toEqual([]);
  });
});

describe("closeTabsOfKinds", () => {
  it("closes the withdrawn tabs and leaves everything else alone", () => {
    const { shell, browser } = seedTwoTabs();
    useTabsStore.getState().closeTabsOfKinds(["browser"]);

    const after = useTabsStore.getState();
    expect(after.tabs.map((t) => t.key)).toEqual([shell.key]);
    // The layout follows: the group keeps the shell tab and nothing dangles.
    expect(orderedTabKeys(after.layout)).toEqual([shell.key]);
    expect(after.tabs.find((t) => t.key === browser.key)).toBeUndefined();
  });

  it("sweeps every loaded scope, not just the active one", () => {
    // A project the user switched away from keeps its tabs in `tabsByScope`; a
    // sweep that only reached the active scope would leave a network client
    // running one project pill away.
    seedTwoTabs();
    const other: TabEntry = {
      key: "other-browser",
      label: "Browser",
      cmd: BROWSER_TAB_CMD,
      args: [],
      env: {},
      cwd: "/tmp",
      kind: "browser",
      scope: "q",
    };
    useTabsStore.setState((st) => ({
      tabsByScope: { ...st.tabsByScope, q: [other] },
      layoutByScope: {
        ...st.layoutByScope,
        q: { type: "group", id: "g-q", tabKeys: [other.key], activeKey: other.key },
      },
    }));

    useTabsStore.getState().closeTabsOfKinds(["browser"]);
    expect(useTabsStore.getState().tabsByScope["q"]).toEqual([]);
    // The emptied scope's layout collapses to nothing rather than keeping an
    // empty group around.
    expect(useTabsStore.getState().layoutByScope["q"]).toBeNull();
  });

  it("leaves a popout's tabs to the popout", () => {
    // A detached window is a separate React root with its own store; the main
    // window removing the payload under it would leave it rendering a tab that no
    // longer exists. It sweeps its own (DetachedApp) and streams a close edit back.
    const { browser } = seedTwoTabs();
    useTabsStore.setState((st) => ({
      detachedGroupsByScope: {
        ...st.detachedGroupsByScope,
        p: [
          {
            id: "d1",
            label: "popout-1",
            subtree: { type: "group", id: "d1", tabKeys: [browser.key], activeKey: browser.key },
          },
        ],
      },
    }));

    useTabsStore.getState().closeTabsOfKinds(["browser"]);
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toContain(browser.key);
  });

  it("does nothing when handed no kinds", () => {
    const { shell, browser } = seedTwoTabs();
    useTabsStore.getState().closeTabsOfKinds([]);
    expect(useTabsStore.getState().tabs.map((t) => t.key)).toEqual([shell.key, browser.key]);
  });
});

describe("the restore half — loadFromLayout", () => {
  it("does not bring back a tab whose flag is off", () => {
    // Without this the sweep would be undone by the next launch: the layout on
    // disk still names the tab, and only the flag says it may not exist.
    useSettingsStore.setState({ settings: s({ web_browser: false }) });
    seedTwoTabs();
    const saved = useTabsStore.getState().snapshotScopeForSwitch("p");
    resetTabs();

    useTabsStore
      .getState()
      .loadFromLayout(saved.tabs, "/tmp", "p", saved.tabGroups ?? undefined);
    const kinds = useTabsStore.getState().tabs.map((t) => t.kind);
    expect(kinds).toEqual(["shell"]);
    // The saved tree is pruned with it — no group left holding a dropped key.
    expect(orderedTabKeys(useTabsStore.getState().layout)).toHaveLength(1);
  });

  it("restores the browser tab when the flag is on", () => {
    useSettingsStore.setState({ settings: s({ web_browser: true }) });
    seedTwoTabs();
    const saved = useTabsStore.getState().snapshotScopeForSwitch("p");
    resetTabs();

    useTabsStore
      .getState()
      .loadFromLayout(saved.tabs, "/tmp", "p", saved.tabGroups ?? undefined);
    expect(useTabsStore.getState().tabs.map((t) => t.kind).sort()).toEqual(["browser", "shell"]);
  });

  it("restores everything while settings are still unknown", () => {
    // Restore can run before the settings read lands. Dropping the tabs then
    // would be a data-losing race with nothing on the other side of it, so the
    // filter waits and the live sweep closes them a moment later if it must.
    useSettingsStore.setState({ settings: null });
    seedTwoTabs();
    const saved = useTabsStore.getState().snapshotScopeForSwitch("p");
    resetTabs();

    useTabsStore
      .getState()
      .loadFromLayout(saved.tabs, "/tmp", "p", saved.tabGroups ?? undefined);
    expect(useTabsStore.getState().tabs).toHaveLength(2);
  });
});

describe("retirement — the mail tab", () => {
  /** A layout as it was persisted while the mail tab still existed. */
  const savedMailLayout = () => [
    {
      key: "t-shell",
      label: "Shell",
      cmd: "bash",
      args: [],
      env: {},
      cwd: "/tmp",
      kind: "shell" as const,
    },
    // `kind` is deliberately absent, as it is in the oldest saved layouts: the
    // `cmd` is the only thing identifying it, and that is exactly what the filter
    // has to match on.
    { key: "t-mail", label: "Mail", cmd: MAIL_TAB_CMD, args: [], env: {}, cwd: "/tmp" },
  ];

  it("names the retired command", () => {
    expect(RETIRED_TAB_CMDS.has(MAIL_TAB_CMD)).toBe(true);
  });

  it("drops a persisted mail tab even while settings are unknown", () => {
    // The whole point of being separate from `withdrawnTabKinds`: that one waits
    // for settings (a flag might still be on), and waiting here would restore the
    // tab as a *shell* — `cmdToKind` no longer maps this cmd, so its fall-through
    // is a terminal that would try to run `__tabtivity_mail__`.
    useSettingsStore.setState({ settings: null });
    useTabsStore
      .getState()
      .loadFromLayout(savedMailLayout() as never, "/tmp", "p", undefined);

    const tabs = useTabsStore.getState().tabs;
    expect(tabs.map((t) => t.kind)).toEqual(["shell"]);
    expect(tabs.some((t) => t.cmd === MAIL_TAB_CMD)).toBe(false);
  });

  it("drops it with mail switched on, too — the kind is gone, not gated", () => {
    useSettingsStore.setState({ settings: s({ mail_client: true, debug: true }) });
    useTabsStore
      .getState()
      .loadFromLayout(savedMailLayout() as never, "/tmp", "p", undefined);
    expect(useTabsStore.getState().tabs.map((t) => t.cmd)).toEqual(["bash"]);
  });
});
