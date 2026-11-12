import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const seen: Array<{ path: string; tabKey?: string }> = [];
vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: (props: { path: string; tabKey?: string }) => {
    seen.push({ path: props.path, tabKey: props.tabKey });
    return <div data-testid="file-viewer">{props.path}</div>;
  },
}));

import { TerminalReaderFiles } from "../../components/terminal/TerminalReaderFiles";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const pdf: FileEntry = {
  name: "paper.pdf",
  path: "/proj/out/paper.pdf",
  is_dir: false,
  size: 10,
  extension: ".pdf",
  mime: "application/pdf",
};

const props = {
  files: [],
  picked: pdf,
  projectId: "p1",
  visible: true,
  onPick: () => {},
  onOpenTab: () => {},
  onClose: () => {},
};

describe("Reader Files: the picked file keeps its position", () => {
  it("hands the viewer a per-file key under the agent tab, so a remount restores the position", () => {
    seen.length = 0;
    render(<TerminalReaderFiles {...props} tabKey="tab-7" />);
    expect(screen.getByTestId("file-viewer")).toBeTruthy();
    expect(seen[seen.length - 1]).toEqual({ path: pdf.path, tabKey: `tab-7#${pdf.path}` });
  });

  it("gives no key when the Reader has no tab", () => {
    seen.length = 0;
    render(<TerminalReaderFiles {...props} />);
    expect(seen[seen.length - 1]?.tabKey).toBeUndefined();
  });
});
