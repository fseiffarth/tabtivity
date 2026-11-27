import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { MutableRefObject } from "react";

vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: (props: { path: string }) => <div data-testid="file-viewer">{props.path}</div>,
}));
// The gesture itself is the file tree's (`startEntryPointerDrag`); here only
// what the Data tab hands it, and what a drag's release click does.
const drag = vi.hoisted(() => vi.fn());
vi.mock("../../components/files/fileTreeDrag", () => ({
  startFilePointerDrag: drag,
  warmDragIcon: () => Promise.resolve(""),
}));

import { TerminalReaderFiles, type ReaderFile } from "../../components/terminal/TerminalReaderFiles";
import type { FileEntry } from "../../lib/viewers/fileUtils";
import { setLinkDragData } from "../../lib/terminal/linkDrag";

const entry: FileEntry = { name: "plot.png", path: "/proj/out/plot.png", is_dir: false, size: 10, extension: ".png", mime: "image/png" };
const file: ReaderFile = { entry, label: "out/plot.png", from: "agent" };
const base = { picked: null, projectId: "p", visible: true, onPick: () => {}, onOpenTab: () => {}, onClose: () => {} };
const row = () => within(screen.getByRole("listbox", { name: "Sent by the agent (1)" })).getByRole("option");

describe("Reader Data: dragging a file row", () => {
  it("starts the file tree's drag with the row's file, the project folder and the host flag", () => {
    render(<TerminalReaderFiles {...base} files={[file]} projectDir="/proj" hostFiles />);
    fireEvent.pointerDown(row(), { button: 0, clientX: 4, clientY: 4 });
    expect(drag).toHaveBeenCalledTimes(1);
    const [, dragged, opts] = drag.mock.calls[0];
    expect(dragged).toBe(entry);
    expect(opts).toMatchObject({ projectId: "p", projectDir: "/proj", host: true, fileDrop: null });
  });

  it("swallows the click a drag's release fires, and a plain click still shows the file", () => {
    const onPick = vi.fn();
    drag.mockImplementationOnce((_e, _entry, opts: { dragClickGuard: MutableRefObject<number> }) => {
      opts.dragClickGuard.current = Date.now();
    });
    render(<TerminalReaderFiles {...base} files={[file]} onPick={onPick} />);
    fireEvent.pointerDown(row(), { button: 0 });
    fireEvent.click(row());
    expect(onPick).not.toHaveBeenCalled();
    // A later press that never moved: its click is the row's own.
    const later = Date.now() + 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    fireEvent.pointerDown(row(), { button: 0 });
    fireEvent.click(row());
    expect(onPick).toHaveBeenCalledWith(entry);
    vi.restoreAllMocks();
  });

  it("drags a link row's address only, and opens nothing", () => {
    const onOpenLink = vi.fn();
    const url = "https://docs.example.org/guide";
    render(<TerminalReaderFiles {...base} files={[]} links={[{ url, host: "docs.example.org", rest: "/guide", from: "agent" }]} onOpenLink={onOpenLink} />);
    const linkRow = within(screen.getByRole("listbox", { name: "Links this conversation names" })).getByRole("option");
    expect(linkRow.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), effectAllowed: "all" };
    fireEvent.dragStart(linkRow, { dataTransfer });
    expect(Object.fromEntries(data)).toEqual({ "text/uri-list": url, "text/plain": url });
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(onOpenLink).not.toHaveBeenCalled();
  });

  it("leaves a missing dataTransfer alone", () => {
    expect(() => setLinkDragData(null, "https://example.org")).not.toThrow();
  });
});
