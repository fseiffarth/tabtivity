/**
 * The side panel's Remarks view: a toolbar that walks the remarks and always
 * opens REMARKS.md, one head per file whose "+" adds a remark to that file,
 * and rows with the done box first and go-to second.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { jump } = vi.hoisted(() => ({ jump: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("../../components/embed/fileViewer/sourceJump", () => ({ jumpToSource: jump }));
vi.mock("../../lib/files/fileAccess", async (orig) => ({
  ...(await orig<typeof import("../../lib/files/fileAccess")>()),
  fileMtime: vi.fn(() => Promise.resolve(7)),
}));

import { RemarksPane } from "../../components/files/RemarksPane";
import { useProjectRemarksStore } from "../../stores/projectRemarks";
import type { ProjectRemark } from "../../lib/projects/projectRemarks";

const remark = (file: string, line: number | null, text: string, done = false, at = 0): ProjectRemark =>
  ({ file, line, text, done, srcStart: at, srcEnd: at + 1, invalidPath: false });

beforeEach(() => {
  jump.mockReset();
  useProjectRemarksStore.setState({
    byProject: {
      p: {
        remarks: [remark("docs/guide.tex", 42, "Photo of the diodes", false, 1), remark("docs/guide.tex", 118, "Torque values", true, 2), remark("flash.sh", 17, "Wait for the second half", false, 3)],
        countsByFile: {},
        fileMissing: {},
        mtime: 7,
        loading: false,
        error: null,
      },
    },
  });
});

describe("RemarksPane", () => {
  it("groups the remarks under one head per file and counts them in the toolbar", async () => {
    await act(async () => { render(<RemarksPane projectId="p" projectDir="/proj" visible />); });
    expect(screen.getByTestId("remarks-counts").textContent).toBe("2 open · 1 done");
    const guide = screen.getByRole("region", { name: "docs/guide.tex" });
    const rows = within(guide).getAllByTestId("project-remark-row");
    expect(rows).toHaveLength(2);
    // Column 1 is the done box, column 2 the go-to.
    expect(rows[0].firstElementChild?.querySelector("input[type=checkbox]")).not.toBeNull();
    expect(within(rows[0].children[1] as HTMLElement).getByRole("button", { name: "Go to docs/guide.tex:42" })).toBeTruthy();
    expect(within(rows[1]).getByRole("checkbox", { name: "Done: Torque values" })).toHaveProperty("checked", true);
    expect(within(rows[0]).getByText("Line 42")).toBeTruthy();
  });

  it("opens the add dialog for the file whose + was pressed", async () => {
    await act(async () => { render(<RemarksPane projectId="p" projectDir="/proj" visible />); });
    fireEvent.click(screen.getByRole("button", { name: "Add file remark to flash.sh" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Add file remark")).toBeTruthy();
    expect(within(dialog).getByText("flash.sh")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers Open REMARKS.md in the toolbar with remarks present, and with none", async () => {
    const { unmount } = await act(async () => render(<RemarksPane projectId="p" projectDir="/proj" visible />));
    fireEvent.click(screen.getByRole("button", { name: "Open REMARKS.md" }));
    expect(jump).toHaveBeenCalledWith(expect.stringContaining("REMARKS.md"), 1);
    unmount();
    useProjectRemarksStore.setState((s) => ({ byProject: { p: { ...s.byProject.p, remarks: [] } } }));
    await act(async () => { render(<RemarksPane projectId="p" projectDir="/proj" visible />); });
    expect(screen.getByText("No project remarks yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open REMARKS.md" }).closest(".sp-toolbar")).not.toBeNull();
  });
});
