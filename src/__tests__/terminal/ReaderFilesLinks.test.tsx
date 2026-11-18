import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("../../components/embed/FileViewerPane", () => ({
  FileViewerPane: (props: { path: string }) => <div data-testid="file-viewer">{props.path}</div>,
}));

import { TerminalReaderFiles, type ReaderFile } from "../../components/terminal/TerminalReaderFiles";
import type { ChatLink } from "../../../mobile-web/src/terminal/chatLinks";
import type { FileEntry } from "../../lib/viewers/fileUtils";

const entry: FileEntry = { name: "a.md", path: "/proj/a.md", is_dir: false, size: 10, extension: ".md", mime: "text/markdown" };
const file: ReaderFile = { entry, label: "a.md", from: "named" };
const link = (url: string, over: Partial<ChatLink> = {}): ChatLink => {
  const parsed = new URL(url);
  return { url, host: parsed.host, rest: parsed.pathname === "/" ? "" : parsed.pathname, from: "agent", ...over };
};
const pr = link("https://github.com/o/r/pull/7", { label: "the PR", at: "2026-11-10T08:00:00Z" });
const doc = link("https://docs.example.org/guide", { from: "you" });

const base = { picked: null, projectId: "p", visible: true, onPick: () => {}, onOpenTab: () => {}, onClose: () => {} };

describe("Reader Data: Files and Links sections", () => {
  it("heads both groups once files and links both exist", () => {
    const { container } = render(<TerminalReaderFiles {...base} files={[file]} links={[pr, doc]} onOpenLink={() => {}} />);
    expect(screen.getByRole("complementary", { name: "Data" })).toBeTruthy();
    const headings = [...container.querySelectorAll(".terminal-files-heading")].map((el) => el.textContent);
    expect(headings.map((text) => text?.replace(/untested$/, ""))).toEqual(["Mentioned in its answers (1)", "Links"]);
    expect(within(screen.getByRole("listbox", { name: "Links this conversation names" })).getAllByRole("option")).toHaveLength(2);
    expect(within(screen.getByRole("listbox", { name: "Mentioned in its answers (1)" })).getAllByRole("option")).toHaveLength(1);
  });

  it("groups the files as the phone does, agent's sends first, yours last, each group in its own order", () => {
    const at = (name: string, from: ReaderFile["from"]): ReaderFile => ({ entry: { ...entry, name, path: `/proj/${name}` }, label: name, from });
    const files = [at("mine.png", "you"), at("named.md", "named"), at("sent.pdf", "agent"), at("mine2.txt", "you"), at("named2.md", "named")];
    const { container } = render(<TerminalReaderFiles {...base} files={files} links={[]} />);
    const headings = [...container.querySelectorAll(".terminal-files-heading")].map((el) => el.textContent?.replace(/untested$/, ""));
    expect(headings).toEqual(["Sent by the agent (1)", "Mentioned in its answers (2)", "Sent by you (2)"]);
    expect(container.querySelector(".terminal-files-heading")?.getAttribute("title")).toBe("Sent to you from this chat");
    const names = (group: string) => within(screen.getByRole("listbox", { name: group })).getAllByRole("option").map((el) => el.textContent);
    expect(names("Sent by the agent (1)")).toEqual(["sent.pdf"]);
    expect(names("Mentioned in its answers (2)")).toEqual(["named.md", "named2.md"]);
    expect(names("Sent by you (2)")).toEqual(["mine.png", "mine2.txt"]);
  });

  it("heads the one group when files are the only section", () => {
    const { container } = render(<TerminalReaderFiles {...base} files={[file]} links={[]} onOpenLink={() => {}} />);
    expect(container.querySelector(".terminal-files-heading")?.textContent?.replace(/untested$/, "")).toBe("Mentioned in its answers (1)");
    expect(screen.queryByRole("listbox", { name: "Links this conversation names" })).toBeNull();
  });

  it("opens a link through onOpenLink with the exact URL, and fetches nothing", () => {
    const onOpenLink = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<TerminalReaderFiles {...base} files={[file]} links={[pr]} onOpenLink={onOpenLink} />);
    const row = within(screen.getByRole("listbox", { name: "Links this conversation names" })).getByRole("option");
    expect(row.tagName).toBe("BUTTON");
    expect(row.getAttribute("title")).toContain("https://github.com/o/r/pull/7");
    fireEvent.click(row);
    expect(onOpenLink).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
    expect(container.querySelector("a[href], img, iframe")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("shows the target host and path, the label apart from it, and who wrote it", () => {
    render(<TerminalReaderFiles {...base} files={[]} links={[pr, doc]} onOpenLink={() => {}} />);
    const [first, second] = screen.getAllByRole("option");
    expect(first.querySelector("strong")?.textContent).toBe("github.com");
    expect(first.textContent).toContain("/o/r/pull/7");
    expect(first.textContent).toContain("the PR");
    expect(first.textContent).toContain("Agent");
    expect(second.textContent).toContain("You");
  });

  it("cuts a long path in its middle", () => {
    const long = link(`https://example.com/${"a".repeat(40)}/${"b".repeat(40)}`);
    render(<TerminalReaderFiles {...base} files={[]} links={[long]} onOpenLink={() => {}} />);
    const rest = screen.getByRole("option").querySelector(".terminal-files-link-rest")?.textContent ?? "";
    expect(rest).toContain("…");
    expect(rest.length).toBeLessThan(long.rest.length);
    expect(rest.startsWith("/aaaa")).toBe(true);
    expect(rest.endsWith("bbbb")).toBe(true);
  });

  it("says a link opens in the browser when only links exist", () => {
    render(<TerminalReaderFiles {...base} files={[]} links={[pr]} onOpenLink={() => {}} />);
    expect(screen.getByText("Links")).toBeTruthy();
    expect(screen.getByText("No file named yet. A link opens in your browser once you confirm.")).toBeTruthy();
  });

  it("keeps the empty text with neither", () => {
    render(<TerminalReaderFiles {...base} files={[]} links={[]} onOpenLink={() => {}} />);
    expect(screen.getByText("This conversation has not named any file or link yet.")).toBeTruthy();
  });

  it("draws no Links section without onOpenLink", () => {
    render(<TerminalReaderFiles {...base} files={[file]} links={[pr]} />);
    expect(screen.queryByRole("listbox", { name: "Links this conversation names" })).toBeNull();
  });
});
