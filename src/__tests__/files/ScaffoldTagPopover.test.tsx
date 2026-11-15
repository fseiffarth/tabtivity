/**
 * The "no scaffold" tag's popover: it names the missing default files from the
 * backend status and offers Repair. Also the tag's opt-in clickability in
 * `projectTypeTags` (hover cards pass no handler and stay plain labels).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

import { ScaffoldTagPopover } from "../../components/files/ScaffoldTagPopover";
import { projectTypeTags } from "../../components/projects/projectTypeTags";
import type { ProjectEntry } from "../../types";

const status = (...missing: string[]) => [
  { name: "AGENTS.md", state: missing.includes("AGENTS.md") ? "missing" : "edited", nestedUnder: null, creatable: true, isDefault: true },
  { name: "README.md", state: missing.includes("README.md") ? "missing" : "edited", nestedUnder: null, creatable: true, isDefault: true },
  { name: "TODO.md", state: "missing", nestedUnder: null, creatable: true, isDefault: false },
];

async function mount(statusResult: unknown) {
  const onRepaired = vi.fn();
  const onClose = vi.fn();
  mockInvoke.mockImplementation((cmd: string) => {
    if (cmd === "project_docs_status") return Promise.resolve(statusResult);
    if (cmd === "repair_project_scaffold") {
      return Promise.resolve({
        projectId: "p1", name: "P", targetDir: "/p",
        report: { createdFiles: ["README.md"], gitignoreLinesAdded: [], gitInitialized: false },
      });
    }
    return Promise.resolve(null);
  });
  await act(async () => {
    render(<ScaffoldTagPopover projectId="p1" x={10} y={10} onClose={onClose} onRepaired={onRepaired} />);
  });
  return { onRepaired, onClose };
}

describe("ScaffoldTagPopover", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the missing defaults, not the creatable extras", async () => {
    await mount(status("README.md"));
    expect(await screen.findByText("Not in the project folder: README.md")).toBeTruthy();
  });

  it("names .gitignore when every default doc is there (the tag fired for the gitignore)", async () => {
    await mount(status());
    expect(await screen.findByText("Not in the project folder: .gitignore")).toBeTruthy();
  });

  it("says something generic when there is no status", async () => {
    await mount(null);
    expect(await screen.findByText("Some default project files are missing.")).toBeTruthy();
  });

  it("repairs on the button, then reports back and closes", async () => {
    const { onRepaired, onClose } = await mount(status("README.md"));
    await screen.findByText(/Not in the project folder/);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Repair/ }));
    });
    expect(mockInvoke).toHaveBeenCalledWith("repair_project_scaffold", { projectId: "p1" });
    await waitFor(() => expect(onRepaired).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});

describe("projectTypeTags · scaffold tag click", () => {
  const t = (k: string) => k;
  const project = { id: "p1", name: "P", git_type: "local" } as unknown as ProjectEntry;

  it("is a plain label unless the caller passes a handler", () => {
    const tag = projectTypeTags(project, true, t as never).find((x) => x.key === "scaffold");
    expect(tag?.onClick).toBeUndefined();
  });

  it("carries the handler on the scaffold tag only", () => {
    const onScaffoldClick = vi.fn();
    const tags = projectTypeTags(project, true, t as never, { onScaffoldClick });
    expect(tags.find((x) => x.key === "scaffold")?.onClick).toBe(onScaffoldClick);
    expect(tags.filter((x) => x.key !== "scaffold").every((x) => x.onClick === undefined)).toBe(true);
  });
});
