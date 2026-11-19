import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { useTexPdfHost, type TexPdfHost } from "../../components/embed/fileViewer/texPdfHost";

let host: TexPdfHost | null = null;
vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: () => {
    host = useTexPdfHost();
    return null;
  },
}));

import { TerminalReaderFiles, type ReaderFile } from "../../components/terminal/TerminalReaderFiles";
import { useEditorJumpStore } from "../../stores/viewers/editorJump";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const tex: FileEntry = {
  name: "paper.tex",
  path: "/proj/paper.tex",
  is_dir: false,
  size: 120,
  extension: ".tex",
  mime: "text/x-tex",
};
const named: ReaderFile = { entry: tex, label: "paper.tex", from: "named" };

function mount(onPick: (entry: FileEntry) => void, disabled?: ReadonlySet<"pdf">) {
  host = null;
  render(
    <TerminalReaderFiles files={[named]} picked={tex} projectId="p1" visible disabled={disabled}
      onPick={onPick} onOpenTab={() => {}} onClose={() => {}} />,
  );
  if (!host) throw new Error("the Data view's viewer has no TeX ⇄ PDF host");
  return host as TexPdfHost;
}

describe("Data view: TeX ⇄ PDF stays in the pane", () => {
  it("shows a compiled PDF the list never named in the pane", () => {
    const onPick = vi.fn();
    expect(mount(onPick).showPdf("/proj/paper.pdf")).toBe(true);
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ path: "/proj/paper.pdf", name: "paper.pdf", extension: ".pdf" }));
  });

  it("shows the source at the clicked line, reusing the list's entry", () => {
    const onPick = vi.fn();
    expect(mount(onPick).showSource(tex.path, 42, 0)).toBe(true);
    expect(onPick).toHaveBeenCalledWith(tex);
    expect(useEditorJumpStore.getState().requestsByPath[tex.path]).toMatchObject({ line: 42, column: 0 });
    useEditorJumpStore.getState().consume(tex.path);
  });

  it("leaves a file its viewer is off for to the tab routing", () => {
    const onPick = vi.fn();
    expect(mount(onPick, new Set(["pdf"])).showPdf("/proj/paper.pdf")).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
  });
});
