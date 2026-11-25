import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: (props: { path: string }) => <div data-testid="file-viewer">{props.path}</div>,
}));
const copied = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("../../lib/terminal/copyText", () => ({ copyText: copied }));

import { TerminalReaderFiles, shellRowsOf, type ReaderFile } from "../../components/terminal/TerminalReaderFiles";
import type { RunningShell } from "../../../mobile-web/src/api";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const entry: FileEntry = { name: "a.md", path: "/proj/a.md", is_dir: false, size: 10, extension: ".md", mime: "text/markdown" };
const file: ReaderFile = { entry, label: "a.md", from: "named" };
const base = { picked: null, projectId: "p", visible: true, onPick: () => {}, onOpenTab: () => {}, onClose: () => {} };
const newest: RunningShell = { command: "cargo test -q\n# then lint", description: "Run the tests", at: "2026-11-25T10:02:00Z" };
const older: RunningShell = { command: "git status", at: "2026-11-25T10:01:00Z", background: true };

describe("Reader Data: Shell commands section", () => {
  it("lists each command by its first line, under its own heading with the count", () => {
    const { container } = render(<TerminalReaderFiles {...base} files={[file]} shells={[newest, older]} />);
    const headings = [...container.querySelectorAll(".terminal-files-heading")].map((el) => el.textContent?.replace(/untested$/, ""));
    expect(headings).toEqual(["Mentioned in its answers (1)", "Shell commands (2)"]);
    const rows = within(screen.getByRole("listbox", { name: "Shell commands this conversation ran" })).getAllByRole("option");
    expect(rows.map((row) => row.querySelector(".terminal-files-shell-line")?.textContent)).toEqual(["cargo test -q", "git status"]);
    expect(rows[0].textContent).toContain("Run the tests");
    expect(rows[1].textContent).toContain("background");
  });

  it("shows the picked command whole in the viewer half, and a file picked after it takes the half back", () => {
    const onPick = vi.fn();
    const { container } = render(<TerminalReaderFiles {...base} picked={entry} files={[file]} shells={[newest]} onPick={onPick} />);
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("listbox", { name: "Shell commands this conversation ran" })).getByRole("option"));
    expect(screen.queryByTestId("file-viewer")).toBeNull();
    expect(container.querySelector(".terminal-files-shell pre")?.textContent).toBe("cargo test -q\n# then lint");
    // The header names no file while a command is shown.
    expect(container.querySelector(".terminal-changes-head .terminal-changes-path")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    expect(copied).toHaveBeenCalledWith("cargo test -q\n# then lint");
    fireEvent.click(within(screen.getByRole("listbox", { name: "Mentioned in its answers (1)" })).getByRole("option"));
    expect(onPick).toHaveBeenCalledWith(entry);
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
  });

  it("asks to pick a command when commands are all there is", () => {
    render(<TerminalReaderFiles {...base} files={[]} shells={[older]} />);
    expect(screen.getByText("No file named yet. Pick a command to see it whole.")).toBeTruthy();
  });

  it("keys a command by its stamp and its place among that stamp's, counted from the oldest", () => {
    const same = (command: string): RunningShell => ({ command, at: "t" });
    const keys = shellRowsOf([same("c"), same("b"), same("a")]).map((row) => row.key);
    expect(keys).toEqual(["shell:t#2", "shell:t#1", "shell:t#0"]);
    // A newer command arriving above keeps the others' keys.
    expect(shellRowsOf([same("d"), same("c"), same("b"), same("a")]).map((row) => row.key).slice(1)).toEqual(keys);
  });
});
