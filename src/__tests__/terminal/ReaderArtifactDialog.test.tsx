import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ReaderArtifactDialog } from "../../components/terminal/ReaderArtifactDialog";
import { BRAND } from "../../lib/brand";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const TARGET = "file:///home/user/.gemini/antigravity-cli/brain/ddb72054-fb3d-493d-8ddb-e7f6c32bb591/plan.md";
const request = { projectId: "p1", tabDir: "/work/p1", sessionId: "launch-1", agent: "agy" };

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
});

describe(`${BRAND.display} Chat shows an Antigravity plan`, () => {
  it("asks for the document by the tab's own request and shows its text as Markdown", async () => {
    vi.mocked(invoke).mockResolvedValue({ name: "plan.md", text: "# The plan\n\n- one\n" });
    render(<ReaderArtifactDialog target={TARGET} request={request} onClose={() => undefined} />);
    expect(await screen.findByRole("heading", { name: "The plan" })).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("agent_tab_artifact", { projectId: "p1", tabDir: "/work/p1", sessionId: "launch-1", target: TARGET });
  });

  it("says so when the document cannot be opened", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    render(<ReaderArtifactDialog target={TARGET} request={request} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/could not be opened/u));
  });

  it("says so when the read fails", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("boom"));
    render(<ReaderArtifactDialog target={TARGET} request={{}} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });
});
