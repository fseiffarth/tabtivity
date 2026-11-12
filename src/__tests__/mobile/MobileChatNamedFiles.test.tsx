import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = { bracketedPasteMode: false };
    textarea = document.createElement("textarea");
    buffer = { active: { length: 0, getLine() { return undefined; } } };
    loadAddon() {}
    open() {}
    write(_value: Uint8Array, callback?: () => void) { callback?.(); }
    onData() { return { dispose() {} }; }
    scrollLines() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));
vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

class FakeWebSocket {
  static OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  binaryType = "";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() { queueMicrotask(() => this.onopen?.()); }
  send() {}
  close() { this.readyState = 3; }
}

import { Terminal } from "../../../mobile-web/src/screens/Terminal";
import { sentFiles } from "../../../mobile-web/src/components/SentFilesIndex";
import { answerHtml } from "../../../mobile-web/src/terminal/answerMarkdown";
import { answerLeaves, changedFiles, rowFile, useNamedFiles } from "../../../mobile-web/src/terminal/chatFiles";
import type { OutboxFile, PhoneMarkupFile } from "../../../mobile-web/src/api";
import { linkPathsInHtml } from "../../lib/terminal/pathCandidates";
import { BRAND, storageKey } from "../../lib/brand";

const TAB = { id: "tab-7", label: "Claude", kind: "agent" as const, agent_label: "Claude Code", available: true, viewer_busy: false };

const row = (name: string, place: string, kind: string, modified = 100): PhoneMarkupFile => ({ token: `sealed-${name}`, name, kind, size: 2_000, modified, place });
const REPORT = row("report.pdf", "out", "application/pdf");
const PLOT = row("plot.png", "figs", "image/png");
const NOTES = row("notes.md", "", "text/markdown");

const settle = () => act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)); });

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sidecar(answer: string, { named, changes = { available: true, version: "c1", changes: [], truncated: false } }: {
  named: Record<string, PhoneMarkupFile>;
  changes?: unknown;
}) {
  const transcript = { available: true, version: "1:1", truncated: false, entries: [{ kind: "answer", text: answer, at: "2026-11-02T10:16:00Z" }] };
  return vi.fn((url: string) => {
    if (url.includes("/named-files?")) {
      const asked = new URL(url, "http://phone").searchParams.get("paths")?.split("\n") ?? [];
      return Promise.resolve(jsonResponse(200, { files: asked.flatMap((path) => (named[path] ? [{ path, file: named[path] }] : [])) }));
    }
    if (url.includes("/changes")) return Promise.resolve(jsonResponse(200, changes));
    if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
    if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript }));
    return Promise.resolve(jsonResponse(404, { error: "not_found" }));
  });
}

describe(`${BRAND.display} Mobile shows the files a chat names and changes`, () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(storageKey("mobile.view.claude-code"), "focus");
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows an answer with the PDF it names as its own message, and opens it", async () => {
    vi.stubGlobal("fetch", sidecar("The report is in `out/report.pdf`, nothing at missing.pdf.", { named: { "out/report.pdf": REPORT } }));
    render(<Terminal tab={TAB} project="p-1" back={() => {}} />);
    await settle();
    await settle();

    const card = screen.getAllByRole("button", { name: /^Open report\.pdf$/ }).find((button) => button.classList.contains("outbox-post-file"));
    expect(card).toBeTruthy();
    // The answer's bubble is not touched: the file is the next message.
    const answer = screen.getByText(/The report is in/).closest(".readable-turn");
    expect(answer?.contains(card as HTMLElement)).toBe(false);
    expect(card?.closest(".outbox-post")?.previousElementSibling).toBe(answer);

    fireEvent.click(card as HTMLElement);
    await settle();
    expect(screen.getByRole("dialog", { name: "report.pdf" })).toBeTruthy();
  });

  it("makes a path in the answer's words open its file", async () => {
    vi.stubGlobal("fetch", sidecar("Read `notes.md` first.", { named: { "notes.md": NOTES } }));
    render(<Terminal tab={TAB} project="p-1" back={() => {}} />);
    await settle();
    await settle();

    const link = screen.getByRole("link", { name: "notes.md" });
    fireEvent.click(link);
    await settle();
    expect(screen.getByRole("dialog", { name: "notes.md" })).toBeTruthy();
  });

  it("lists what the agent changed and named under their own headings", async () => {
    vi.stubGlobal("fetch", sidecar("See out/report.pdf and figs/plot.png.", {
      named: { "out/report.pdf": REPORT, "figs/plot.png": PLOT },
      changes: {
        available: true, version: "c1", truncated: false,
        changes: [
          { path: "out/report.pdf", kind: "edit", diff: "", added: 1, removed: 0, file: REPORT },
          { path: "gone.txt", kind: "delete", diff: "", added: 0, removed: 3 },
        ],
      },
    }));
    render(<Terminal tab={TAB} project="p-1" back={() => {}} />);
    await settle();
    await settle();

    const index = screen.getByRole("navigation", { name: "Files in this conversation" });
    fireEvent.click(within(index).getByRole("button", { name: /^Files \(2\)/ }));
    const sections = within(index).getAllByRole("region");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Changed by the agent (1)", "Mentioned in its answers (1)"]);
    expect(sections[1].querySelector("img")?.getAttribute("src")).toBe(`/api/v1/projects/p-1/files/raw?f=${PLOT.token}`);
    expect(within(index).getByText(/are in Diffs/)).toBeTruthy();

    fireEvent.click(within(sections[0]).getByRole("button", { name: "Open report.pdf · Changed by the agent" }));
    await settle();
    expect(screen.getByRole("dialog", { name: "report.pdf" })).toBeTruthy();
  });

  it("names only what the current conversation's answers name", async () => {
    const fetcher = sidecar("", { named: { "notes.md": NOTES, "out/report.pdf": REPORT } });
    vi.stubGlobal("fetch", fetcher);
    const { result, rerender } = renderHook(({ texts }) => useNamedFiles("tab-7", texts, true), { initialProps: { texts: ["Read notes.md."] } });
    await settle();
    expect([...result.current.keys()]).toEqual(["notes.md"]);
    // A clear: the new chat names another file, and the earlier one drops out.
    rerender({ texts: ["See out/report.pdf."] });
    await settle();
    expect([...result.current.keys()]).toEqual(["out/report.pdf"]);
    // Back on the earlier conversation, its file is known without a new ask.
    const asks = fetcher.mock.calls.length;
    rerender({ texts: ["Read notes.md."] });
    await settle();
    expect([...result.current.keys()]).toEqual(["notes.md"]);
    expect(fetcher.mock.calls.length).toBe(asks);
  });

  it("stays a plain chat where the desktop refuses or there is no project", async () => {
    const fetcher = vi.fn((url: string) => {
      if (url.includes("/named-files?") || url.includes("/changes")) return Promise.resolve(jsonResponse(404, { error: "files_off" }));
      if (url.endsWith("/outbox")) return Promise.resolve(jsonResponse(200, { files: [] }));
      if (url.includes("/transcript")) return Promise.resolve(jsonResponse(200, { transcript: { available: true, version: "1:1", truncated: false, entries: [{ kind: "answer", text: "See out/report.pdf.", at: "2026-11-02T10:16:00Z" }] } }));
      return Promise.resolve(jsonResponse(404, { error: "not_found" }));
    });
    vi.stubGlobal("fetch", fetcher);
    const { unmount } = render(<Terminal tab={TAB} project="p-1" back={() => {}} />);
    await settle();
    await settle();
    expect(screen.getByText(/See out\/report\.pdf/)).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Files in this conversation" })).toBeNull();
    unmount();

    fetcher.mockClear();
    render(<Terminal tab={TAB} back={() => {}} />);
    await settle();
    expect(fetcher.mock.calls.some(([url]) => url.includes("/named-files") || url.includes("/changes"))).toBe(false);
  });
});

describe("the chat's file helpers", () => {
  const named = new Map<string, OutboxFile>([
    ["out/report.pdf", rowFile(REPORT, "out/report.pdf")],
    ["figs/plot.png", rowFile(PLOT, "figs/plot.png")],
    ["/home/me/p/figs/plot.png", rowFile(PLOT, "/home/me/p/figs/plot.png")],
    ["notes.md", rowFile(NOTES, "notes.md")],
  ]);

  it("previews an answer's pictures and PDFs in order, each once, at most four", () => {
    const text = "figs/plot.png, notes.md, /home/me/p/figs/plot.png and out/report.pdf";
    expect(answerLeaves(text, named, new Set())).toEqual(["figs/plot.png", "out/report.pdf"]);
    expect(answerLeaves(text, named, new Set(["figs/plot.png"]))).toEqual(["out/report.pdf"]);
    const many = new Map([..."abcde"].map((c) => [`${c}.png`, rowFile(row(`${c}.png`, "", "image/png"), `${c}.png`)]));
    expect(answerLeaves("a.png b.png c.png d.png e.png", many, new Set())).toHaveLength(4);
  });

  it("reads the changes newest first, each file once, and says when the record holds more", () => {
    const old = row("a.ts", "src", "text/plain", 1);
    const fresh = row("a.ts", "src", "text/plain", 2);
    const change = (file?: PhoneMarkupFile) => ({ path: "x", kind: "edit" as const, diff: "", added: 0, removed: 0, file });
    const read = changedFiles({ changes: [change(old), change(NOTES), change(fresh)], truncated: false });
    expect(read.files.map((file) => [file.name, file.modified])).toEqual([["src/a.ts", 2], ["/notes.md", 100]]);
    expect(read.more).toBe(false);
    expect(changedFiles({ changes: [change()], truncated: false }).more).toBe(true);
    expect(changedFiles({ changes: [change(old)], truncated: true }).more).toBe(true);
  });

  it("stands one file once, sent before changed before named", () => {
    const sentCopy = { name: "report.pdf", kind: "application/pdf", size: 2_000, modified: 300, from_tab: true, file_row: REPORT };
    const rows = sentFiles([sentCopy], [], new Map(), [rowFile(REPORT), rowFile(NOTES)], named);
    expect(rows.map(({ file, from }) => [file.original ?? file.name, from]).sort()).toEqual([
      ["notes.md", "changed"], ["plot.png", "named"], ["report.pdf", "agent"],
    ]);
  });

  it("turns a Markdown link to a file into a path link only once the file is known", () => {
    const html = answerHtml("[the report](out/report.pdf) and [off](https://example.com/a.pdf) and [x](javascript:alert(1))");
    expect(html).toContain('data-path="out/report.pdf"');
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("data-path-link");
    const linked = linkPathsInHtml(html, new Map([["out/report.pdf", true]]));
    expect(linked).toContain('data-path-link="out/report.pdf"');
    expect(linked.match(/data-path-link/g)).toHaveLength(1);
    expect(linkPathsInHtml(html, new Map([["other.pdf", true]]))).not.toContain("data-path-link");
  });
});
