/**
 * The archive's list, in the side panel's Archive view and in the + menu's
 * Archived tabs dialog: a toolbar with the filter and the bulk delete, then
 * one two-line row per tab saying what kind of tab it was.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve([])) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));

import { TabArchiveDialog, TabArchiveList } from "../../components/tabs/TabArchiveList";
import { useTabArchiveStore, type ArchivedTab } from "../../stores/tabArchive";

const ENTRIES: ArchivedTab[] = [
  { id: "a", archivedAt: 3_000, tab: { key: "k1", label: "Thumb cluster keymap", cmd: "claude", cwd: "/p", kind: "agent" } },
  { id: "b", archivedAt: 2_000, tab: { key: "k2", label: "zmk_build.sh", cmd: "bash", cwd: "/p", kind: "shell" } },
  { id: "c", archivedAt: 1_000, tab: { key: "k3", label: "guide.pdf", cmd: "", cwd: "/p", kind: "embed", viewer: "pdf", embedPath: "/p/guide.pdf" } },
];

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => (command === "tab_archive_list" ? ENTRIES : command === "tab_archive_take" ? null : []));
  useTabArchiveStore.setState({ byScope: {} });
});

describe("TabArchiveList", () => {
  it("shows each row's label over its kind word, the agent's CLI for an agent", async () => {
    await act(async () => { render(<TabArchiveList scope="p" />); });
    const rows = screen.getAllByTestId("tab-archive-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => within(row).getByTestId("tab-archive-kind").textContent)).toEqual(["Claude", "Shell", "PDF viewer"]);
    expect(within(rows[0]).getByText("Thumb cluster keymap")).toBeTruthy();
    // Delete is an icon button with its own name; the bulk delete sits in the toolbar.
    expect(within(rows[1]).getByRole("button", { name: "Delete zmk_build.sh from the archive" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete 3" }).closest(".sp-toolbar")).not.toBeNull();
  });

  it("filters the rows and the bulk delete follows the filter", async () => {
    await act(async () => { render(<TabArchiveList scope="p" />); });
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter archived tabs" }), { target: { value: "zmk" } });
    expect(screen.getAllByTestId("tab-archive-row")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Delete \d/ })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter archived tabs" }), { target: { value: "nothing" } });
    expect(screen.getByText("No archived tab matches the filter.")).toBeTruthy();
  });

  it("restores from the dialog and closes it", async () => {
    const onClose = vi.fn();
    await act(async () => { render(<TabArchiveDialog scope="p" onClose={onClose} />); });
    expect(screen.getAllByTestId("tab-archive-row")).toHaveLength(3);
    await act(async () => { fireEvent.click(screen.getByTitle("Open guide.pdf again")); });
    expect(vi.mocked(invoke).mock.calls.some(([name]) => name === "tab_archive_take")).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
