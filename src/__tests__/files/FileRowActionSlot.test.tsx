/**
 * What a tree row puts in its ONE action slot (docs/files_panel_redesign_plan.md,
 * step A): a sync button, then Run, then a sync mark, the remark count, and
 * last the quiet auto-sync indicator.
 *
 * The regression this pins: with one slot, the passive auto-sync indicator took
 * it from the Run button, so every in-sync script of an auto-synced project lost
 * its Run. A mark the user cannot press never displaces a control.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { FileRow, type FileRowProps } from "../../components/files/FileTree";

const noop = new Proxy({}, { get: () => vi.fn() }) as unknown as FileRowProps["rows"];

function row(over: Partial<FileRowProps>) {
  const props: FileRowProps = {
    entry: { name: "build.sh", path: "/p/build.sh", is_dir: false, size: 1638, extension: ".sh", mime: null },
    scaffold: false,
    doc: null,
    status: undefined,
    ignored: false,
    dirShown: undefined,
    sharePct: null,
    scanExcluded: false,
    canPyRun: false,
    canShRun: false,
    isRunning: false,
    runLocked: false,
    isCompiling: false,
    dragTarget: null,
    isMoveTarget: false,
    selected: false,
    notOnRemote: false,
    syncTracked: false,
    rel: "build.sh",
    syncState: "green",
    autoSync: false,
    pathExcluded: false,
    syncAnyBusy: false,
    syncThisBusy: false,
    remoteListing: false,
    remarkCount: 0,
    ctrlHeld: false,
    moveTargetAttrs: {} as FileRowProps["moveTargetAttrs"],
    rows: noop,
    ...over,
  };
  const { container } = render(<FileRow {...props} />);
  return container.querySelector(".file-act") as HTMLElement;
}

describe("the file row's action slot", () => {
  it("keeps Run on an auto-synced, in-sync script", () => {
    const slot = row({ canShRun: true, syncTracked: true, autoSync: true, syncState: "green" });
    expect(screen.getByRole("button", { name: "Run build.sh" })).toBeTruthy();
    expect(slot.querySelector(".file-autosync-icon")).toBeNull();
  });

  it("keeps Run on a script excluded from sync", () => {
    const slot = row({ canShRun: true, syncTracked: true, pathExcluded: true });
    expect(screen.getByRole("button", { name: "Run build.sh" })).toBeTruthy();
    expect(slot.querySelector(".file-sync-excluded")).toBeNull();
  });

  it("gives the slot to the sync button when the file still has to be pushed", () => {
    const slot = row({ canShRun: true, syncTracked: true, syncState: "none" });
    expect(slot.querySelector(".orange-file-act")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Run build.sh" })).toBeNull();
  });

  it("shows the excluded mark ahead of the remark count, and the count ahead of the auto-sync indicator", () => {
    const excluded = row({ syncTracked: true, pathExcluded: true, remarkCount: 2 });
    expect(excluded.querySelector(".file-sync-excluded")).not.toBeNull();
    expect(excluded.querySelector(".file-remark-count")).toBeNull();

    const counted = row({ syncTracked: true, autoSync: true, syncState: "green", remarkCount: 2 });
    expect(counted.querySelector(".file-remark-count")?.textContent).toBe("2");
    expect(counted.querySelector(".file-autosync-icon")).toBeNull();
  });

  it("shows the auto-sync indicator when the slot has nothing else", () => {
    const slot = row({ syncTracked: true, autoSync: true, syncState: "green" });
    expect(slot.querySelector(".file-autosync-icon")).not.toBeNull();
  });
});
