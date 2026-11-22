/**
 * The Downloads section under the file tree takes one line while the chosen
 * window holds no downloads — the label, what the window holds, the window
 * picker and refresh — and the full resizable section when it has rows or the
 * user opens it (docs/files_panel_redesign_plan.md, step A item 6).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/path", () => ({ downloadDir: () => Promise.resolve("/home/u/Downloads") }));
vi.mock("../../stores/settings", () => {
  const state = { settings: null };
  return {
    useSettingsStore: (selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state),
  };
});

import { DownloadsSection } from "../../components/files/DownloadsSection";

function download(name: string) {
  return {
    name,
    path: `/home/u/Downloads/${name}`,
    is_dir: false,
    size: 2048,
    extension: name.slice(name.lastIndexOf(".")),
    mime: null,
    modified_secs: Math.floor(Date.now() / 1000) - 60,
  };
}

async function renderSection() {
  const r = await act(async () =>
    render(
      <DownloadsSection projectDir="/tmp/p" projectId="p" targetFolder="" isRemote={false} onClose={() => {}} />,
    ),
  );
  return r.container;
}

describe("Downloads section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is one line while the window holds nothing, naming the window", async () => {
    mockInvoke.mockResolvedValue([]);
    const container = await renderSection();
    await waitFor(() => expect(screen.getByText("None in the last hour")).toBeTruthy());
    expect(container.querySelector(".downloads-section--line")).not.toBeNull();
    expect(container.querySelector(".downloads-list")).toBeNull();
    expect(container.querySelector(".downloads-resize")).toBeNull();
    // The window picker and refresh stay on the line.
    const picker = screen.getByRole("group", { name: "Downloads from the last" });
    expect(picker.classList.contains("seg")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(screen.getByText("None in the last 24 hours")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    await waitFor(() => expect(screen.getByText("None yet")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("opens to the full section by hand, and folds back to the line", async () => {
    mockInvoke.mockResolvedValue([]);
    const container = await renderSection();
    const toggle = await screen.findByRole("button", { name: "Downloads" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(container.querySelector(".downloads-list")).not.toBeNull();
    expect(container.querySelector(".downloads-resize")).not.toBeNull();
    const fold = screen.getByRole("button", { name: "Downloads" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    expect(container.querySelector(".downloads-section--line")).not.toBeNull();
  });

  it("is the full section when the window holds downloads, rows on the tree's grid", async () => {
    mockInvoke.mockResolvedValue([download("paper.pdf")]);
    const container = await renderSection();
    await screen.findByText("paper.pdf");
    expect(container.querySelector(".downloads-section--line")).toBeNull();
    expect(container.querySelector(".downloads-list")).not.toBeNull();
    const row = container.querySelector(".downloads-row") as HTMLElement;
    const [state, act, main] = Array.from(row.children);
    expect(state.classList.contains("file-state")).toBe(true);
    expect(act.querySelector(".dl-copy-btn")).not.toBeNull();
    expect(main.querySelector(".file-name")?.textContent).toBe("paper.pdf");
  });
});
