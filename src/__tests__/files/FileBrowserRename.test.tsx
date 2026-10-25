/**
 * The middle file browser retargets a renamed file's open viewer tabs to the
 * new absolute path. It used to splice the name in after the last `/`, which on
 * a Windows path (`C:\proj\a.txt`) left the new name behind the whole old path.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../components/files/fileTabSync", () => ({
  closeTabsForDeletedPath: vi.fn(),
  retargetTabsForRenamedPath: vi.fn(),
}));

import { FileBrowser } from "../../components/files/FileBrowser";
import { retargetTabsForRenamedPath } from "../../components/files/fileTabSync";

const invokeMock = vi.mocked(invoke);

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  vi.mocked(retargetTabsForRenamedPath).mockReset();
});

async function renameInBrowser(projectDir: string, sep: string, next: string) {
  const path = `${projectDir}${sep}a.txt`;
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "list_dir") {
      return [{ name: "a.txt", path, is_dir: false, size: 3, extension: "txt", mime: null }];
    }
    return null;
  });
  render(<FileBrowser projectDir={projectDir} projectId={null} active />);
  fireEvent.click(await screen.findByText("a.txt"));
  fireEvent.click(screen.getByText("Rename"));
  const field = (await screen.findByLabelText("Rename to:")) as HTMLInputElement;
  fireEvent.change(field, { target: { value: next } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(retargetTabsForRenamedPath).toHaveBeenCalled());
  return path;
}

describe("FileBrowser rename", () => {
  it("retargets a Windows path to a sibling, not to the old path plus the name", async () => {
    const oldAbs = await renameInBrowser("C:\\proj", "\\", "b.txt");
    expect(retargetTabsForRenamedPath).toHaveBeenCalledWith(oldAbs, "C:\\proj\\b.txt");
  });

  it("retargets a POSIX path to a sibling", async () => {
    const oldAbs = await renameInBrowser("/work/proj", "/", "b.txt");
    expect(retargetTabsForRenamedPath).toHaveBeenCalledWith(oldAbs, "/work/proj/b.txt");
  });
});
