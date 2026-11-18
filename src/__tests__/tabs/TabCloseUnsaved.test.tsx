/**
 * Closing a file tab whose buffer is unsaved with autosave off (screen
 * 2026-11-12 H10): the pane's buffer used to go with the tab, no question
 * asked, because `DraftSaver.dispose` saves only when autosave is on and
 * `closeTabWithConfirm` confirmed nothing. Now the tab's close guard
 * (`components/tabs/TabCloseGuard`) asks Save / Discard / Cancel through the
 * shared dialogs, and Cancel keeps the tab.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(() => Promise.resolve()), listen: vi.fn(() => Promise.resolve(() => {})) }));

import { DraftSaver } from "../../components/embed/draftSaver";
import { TabCloseGuard } from "../../components/tabs/TabCloseGuard";
import { closeTabInScope, closeTabsWithConfirm } from "../../lib/remote/closeRemoteTab";
import { PaneUnsavedContext, type PaneUnsavedWork } from "../../lib/tabs/tabCloseGuard";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { translate } from "../../lib/i18n";

const en = (key: Parameters<typeof translate>[1], params?: Record<string, string>) => translate("en", key, params);

function seed() {
  useTabsStore.setState({
    scope: "p",
    tabsByScope: {},
    layoutByScope: {},
    detachedGroupsByScope: {},
    focusedGroupByScope: {},
    tabs: [],
    layout: null,
    focusedGroupId: null,
    activeKey: null,
  });
}

function add(label: string): TabEntry {
  return useTabsStore.getState().addTab({ cmd: "", cwd: "/p", kind: "embed", label, embedPath: `/p/${label}` });
}

const open = () => (useTabsStore.getState().tabsByScope.p ?? []).map((t) => t.label);

/** A pane part holding an edited file, the way `useEditableFile` registers. */
function Buffer({ work }: { work: PaneUnsavedWork }) {
  const register = useContext(PaneUnsavedContext);
  useEffect(() => register?.(work), [register, work]);
  return null;
}

function buffer(name: string, opts: { autosave?: boolean; saveFails?: boolean } = {}) {
  const state = { dirty: true, saves: 0 };
  const work: PaneUnsavedWork = {
    lostOnClose: () => state.dirty && !opts.autosave,
    save: async () => {
      state.saves += 1;
      if (opts.saveFails) throw new Error("disk full");
      state.dirty = false;
    },
    label: () => name,
  };
  return { state, work };
}

function mount(tab: TabEntry, work: PaneUnsavedWork) {
  render(
    <TabCloseGuard scope="p" tabKey={tab.key}>
      <Buffer work={work} />
    </TabCloseGuard>,
  );
}

beforeEach(seed);
afterEach(cleanup);

describe("closing a tab with unsaved edits", () => {
  it("asks before closing, and Cancel keeps the tab open", async () => {
    const tab = add("notes.md");
    const { state, work } = buffer("notes.md");
    mount(tab, work);
    let closed: Promise<boolean> | undefined;
    act(() => { closed = closeTabInScope("p", tab.key); });
    expect(screen.getByRole("dialog").textContent).toContain(en("fileViewer.closeUnsavedTitle", { name: "notes.md" }));
    expect(open()).toEqual(["notes.md"]);
    fireEvent.click(screen.getByRole("button", { name: en("common.cancel") }));
    await expect(closed).resolves.toBe(false);
    expect(open()).toEqual(["notes.md"]);
    expect(state.saves).toBe(0);
  });

  it("Discard closes without saving", async () => {
    const tab = add("notes.md");
    const { state, work } = buffer("notes.md");
    mount(tab, work);
    let closed: Promise<boolean> | undefined;
    act(() => { closed = closeTabInScope("p", tab.key); });
    fireEvent.click(screen.getByRole("option", { name: en("fileViewer.closeUnsavedDiscard") }));
    await expect(closed).resolves.toBe(true);
    expect(open()).toEqual([]);
    expect(state.saves).toBe(0);
  });

  it("Save writes the buffer, then closes", async () => {
    const tab = add("notes.md");
    const { state, work } = buffer("notes.md");
    mount(tab, work);
    let closed: Promise<boolean> | undefined;
    act(() => { closed = closeTabInScope("p", tab.key); });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: en("fileViewer.closeUnsavedSave") }));
    });
    await expect(closed).resolves.toBe(true);
    expect(state.saves).toBe(1);
    expect(open()).toEqual([]);
  });

  it("keeps the tab when the save fails", async () => {
    const tab = add("notes.md");
    const { state, work } = buffer("notes.md", { saveFails: true });
    mount(tab, work);
    let closed: Promise<boolean> | undefined;
    act(() => { closed = closeTabInScope("p", tab.key); });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: en("fileViewer.closeUnsavedSave") }));
    });
    await expect(closed).resolves.toBe(false);
    expect(state.saves).toBe(1);
    expect(open()).toEqual(["notes.md"]);
  });

  it("closes at once, asking nothing, when autosave is on or nothing is unsaved", async () => {
    const autosaved = add("a.md");
    mount(autosaved, buffer("a.md", { autosave: true }).work);
    const plain = add("b.md");
    await expect(closeTabInScope("p", autosaved.key)).resolves.toBe(true);
    await expect(closeTabInScope("p", plain.key)).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open()).toEqual([]);
  });

  it("a bulk close asks per tab and stops at a Cancel", async () => {
    const first = add("first.md");
    const dirty = add("dirty.md");
    const last = add("last.md");
    mount(dirty, buffer("dirty.md").work);
    let done: Promise<void> | undefined;
    act(() => { done = closeTabsWithConfirm([first.key, dirty.key, last.key]); });
    await act(async () => {});
    expect(open()).toEqual(["dirty.md", "last.md"]);
    fireEvent.click(screen.getByRole("button", { name: en("common.cancel") }));
    await act(async () => { await done; });
    expect(open()).toEqual(["dirty.md", "last.md"]);
  });
});

describe("DraftSaver.lostOnDispose", () => {
  it("is set only for an unsaved buffer with autosave off", () => {
    const saver = new DraftSaver(async () => {});
    saver.update("edited", "on disk", true, false);
    expect(saver.lostOnDispose).toBe(true);
    saver.update("edited", "on disk", true, true);
    expect(saver.lostOnDispose).toBe(false);
    saver.dispose();
    const clean = new DraftSaver(async () => {});
    clean.update("same", "same", true, false);
    expect(clean.lostOnDispose).toBe(false);
  });
});
