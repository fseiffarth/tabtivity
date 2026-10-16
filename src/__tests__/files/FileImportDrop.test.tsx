import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useImportDrop } from "../../components/files/importDrop";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const openMock = vi.mocked(open);
const onImported = vi.fn();

function ImportHost({ destRel = "incoming" }: { destRel?: string }) {
  const flow = useImportDrop({ projectDir: "/tmp/project", enabled: true, destRel, onImported });
  return <>
    <button type="button" onClick={() => void flow.importViaDialog()}>Import files</button>
    {flow.conflictModal}
  </>;
}

function copies() {
  return invokeMock.mock.calls.filter(([command]) => command === "import_external_file")
    .map(([, args]) => args);
}

async function startImport(paths = ["/tmp/source/notes.txt"]) {
  openMock.mockResolvedValue(paths);
  const view = render(<ImportHost />);
  await userEvent.click(screen.getByRole("button", { name: "Import files" }));
  await screen.findByRole("dialog");
  return view;
}

beforeEach(() => {
  openMock.mockReset();
  onImported.mockReset();
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command, args) => {
    if (command === "project_path_exists") {
      return !(args as { relPath: string }).relPath.includes(" (1)");
    }
    if (command === "import_external_file") return "copied";
    throw new Error(`Unexpected command: ${command}`);
  });
});

describe("external file import collision choices", () => {
  it("skips a collision without issuing a copy", async () => {
    await startImport();
    expect(copies()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(copies()).toEqual([]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("enables overwrite only after Replace is chosen", async () => {
    await startImport();
    expect(copies()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: /^replace$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(copies()).toEqual([{
      projectDir: "/tmp/project", sourcePath: "/tmp/source/notes.txt",
      destRel: "incoming", replace: true, destName: null,
    }]);
  });

  it("keeps both using the edited name without enabling overwrite", async () => {
    await startImport();
    const name = screen.getByRole("textbox");
    expect((name as HTMLInputElement).value).toBe("notes (1).txt");
    fireEvent.change(name, { target: { value: "notes reviewed.txt" } });
    await userEvent.click(screen.getByRole("button", { name: /^keep both$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(copies()).toEqual([{
      projectDir: "/tmp/project", sourcePath: "/tmp/source/notes.txt",
      destRel: "incoming", replace: false, destName: "notes reviewed.txt",
    }]);
  });

  it("applies Keep Both to the batch without reusing the first file's custom name", async () => {
    await startImport(["/tmp/source/notes.txt", "/tmp/source/data.csv"]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "reviewed.txt" } });
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /^keep both$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(copies()).toEqual([
      { projectDir: "/tmp/project", sourcePath: "/tmp/source/notes.txt", destRel: "incoming", replace: false, destName: "reviewed.txt" },
      { projectDir: "/tmp/project", sourcePath: "/tmp/source/data.csv", destRel: "incoming", replace: false, destName: null },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["Skip", "Replace"])("applies %s to all remaining collisions", async (choice) => {
    await startImport(["/tmp/source/notes.txt", "/tmp/source/data.csv"]);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: choice }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    if (choice === "Skip") expect(copies()).toEqual([]);
    else {
      expect(copies()).toHaveLength(2);
      for (const copy of copies()) expect(copy).toMatchObject({ replace: true, destName: null });
    }
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains the batch destination when navigation changes during a conflict prompt", async () => {
    const view = await startImport(["/tmp/source/notes.txt", "/tmp/source/data.csv"]);
    view.rerender(<ImportHost destRel="elsewhere" />);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: /^replace$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
    expect(copies()).toHaveLength(2);
    for (const copy of copies()) expect(copy).toMatchObject({ destRel: "incoming" });
    const probes = invokeMock.mock.calls.filter(([command]) => command === "project_path_exists");
    for (const [, args] of probes) {
      expect((args as { relPath: string }).relPath.startsWith("incoming/")).toBe(true);
    }
  });

  it.each(["../outside.txt", "folder\\outside.txt"])("refuses the custom name %s before copying", async (invalidName) => {
    await startImport();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: invalidName } });
    await userEvent.click(screen.getByRole("button", { name: /^keep both$/i }));
    expect(copies()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/invalid file name/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^skip$/i }));
    await waitFor(() => expect(onImported).toHaveBeenCalledOnce());
  });
});
