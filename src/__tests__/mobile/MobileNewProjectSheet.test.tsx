/**
 * `NewProjectSheet`: a new project from the phone is made by name alone —
 * the request carries `{ name }` and nothing else, the sheet shows the folder
 * the name becomes, and each refusal is named.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { projectFolderName } from "../../../mobile-web/src/api";
import { NewProjectSheet } from "../../../mobile-web/src/screens/NewProjectSheet";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

const posts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");

describe("Mobile new project sheet", () => {
  it("names the folder as the backend's sanitize_name does", () => {
    expect(projectFolderName("  My Paper ")).toBe("my-paper");
    expect(projectFolderName("my!project@2")).toBe("my-project-2");
    expect(projectFolderName("a---b_c")).toBe("a-b_c");
    expect(projectFolderName("café")).toBe("caf");
    expect(projectFolderName("!!!")).toBe("");
  });

  it("POSTs only the trimmed name and hands back the new row", async () => {
    const row = { id: "p-new", label: "My Paper", status: "inactive", live_sessions: 0 };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ project: row }), { status: 201 }));
    const onCreated = vi.fn();
    render(<NewProjectSheet onClose={() => {}} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  My Paper  " } });
    expect(screen.getByText("Folder: my-paper")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(row));
    const [url, init] = posts()[0];
    expect(String(url)).toBe("/api/v1/projects");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ name: "My Paper" });
  });

  it("refuses a name with no folder in it without a request", () => {
    render(<NewProjectSheet onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "!!!" } });
    fireEvent.keyDown(screen.getByLabelText("Project name"), { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("letter or digit");
    expect(posts()).toHaveLength(0);
  });

  it("names a taken folder, and an unavailable host, and stays usable", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "project_exists" }), { status: 409 }));
    render(<NewProjectSheet onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Paper" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("folder named paper");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "mobile_unavailable" }), { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("tmux"));
  });
});
