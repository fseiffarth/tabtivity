/**
 * The side panel header's "Open in IDE" button (`IdeHeaderButton`): absent
 * without markers, a direct launch for one found IDE, and the pill menu's
 * rows for several IDEs (or on right-click).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

import { IdeHeaderButton, type IdeCandidate } from "../../components/projects/IdeMenuItems";

const PYCHARM: IdeCandidate = {
  id: "pycharm",
  family: "jetbrains",
  label: "PyCharm",
  markerPath: ".idea",
  target: "/tmp/p1",
  exec: "/usr/bin/pycharm",
  displayName: null,
  source: "path",
  overridden: false,
};

const ZED: IdeCandidate = {
  id: "zed",
  family: "zed",
  label: "Zed",
  markerPath: ".zed",
  target: "/tmp/p1",
  exec: "/usr/bin/zeditor",
  displayName: null,
  source: "path",
  overridden: false,
};

function stub(ides: IdeCandidate[]) {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "detect_project_ides") return Promise.resolve(ides);
    if (cmd === "get_opened_windows") return Promise.resolve([]);
    return Promise.resolve(null);
  });
}

async function renderButton() {
  let container: HTMLElement;
  await act(async () => {
    ({ container } = render(<IdeHeaderButton projectId="p1" projectName="Py" />));
  });
  return container!;
}

describe("side panel · Open in IDE button", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("renders nothing for a project without markers", async () => {
    stub([]);
    const container = await renderButton();
    expect(container.querySelector(".side-panel-ide-btn")).toBeNull();
  });

  it("launches the one found IDE on click", async () => {
    stub([PYCHARM]);
    await renderButton();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open Py in an IDE"));
    });
    expect(invoke).toHaveBeenCalledWith("open_project_in_ide", { projectId: "p1", ideId: "pycharm" });
    expect(screen.queryByText("Open in PyCharm")).toBeNull();
  });

  it("opens the rows for several IDEs instead of launching", async () => {
    stub([PYCHARM, ZED]);
    await renderButton();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Open Py in an IDE"));
    });
    expect(invoke).not.toHaveBeenCalledWith("open_project_in_ide", expect.anything());
    expect(screen.getByText("Open in PyCharm")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Open in Zed"));
    });
    expect(invoke).toHaveBeenCalledWith("open_project_in_ide", { projectId: "p1", ideId: "zed" });
  });

  it("opens the rows on right-click even for a single IDE", async () => {
    stub([PYCHARM]);
    await renderButton();
    await act(async () => {
      fireEvent.contextMenu(screen.getByLabelText("Open Py in an IDE"));
    });
    expect(screen.getByText("Open in PyCharm")).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("open_project_in_ide", expect.anything());
  });
});
