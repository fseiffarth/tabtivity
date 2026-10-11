import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { CopilotCompletionProvider, CopilotFeedback, copilotServes } from "../../lib/viewers/completion/copilotCompletionProvider";
import type { CompletionDocument } from "../../lib/viewers/completion/completionProvider";
import type { Settings } from "../../types";

const consented = {
  code_completion_provider: "copilot",
  completion_project_policies: { one: { directory: "/one", copilot: true, local_only: false } },
} as Settings;

function doc(text: string): CompletionDocument {
  return { path: "/one/a.ts", version: 3, text, caret: text.length, language: "typescript" };
}

function provider() {
  return new CopilotCompletionProvider({ projectId: "one", editor: "e", automatic: true, tabSize: 2, insertSpaces: true });
}

beforeEach(() => invoke.mockReset().mockResolvedValue(undefined));

describe("copilotServes", () => {
  it("needs the flag, the provider, a consenting local project and a code language", () => {
    const ts = "/one/a.ts";
    expect(copilotServes(consented, true, "one", false, "typescript", ts)).toBe(true);
    expect(copilotServes(consented, false, "one", false, "typescript", ts)).toBe(false);
    expect(copilotServes(consented, true, "two", false, "typescript", ts)).toBe(false);
    expect(copilotServes(consented, true, null, false, "typescript", ts)).toBe(false);
    expect(copilotServes(consented, true, "one", true, "typescript", ts)).toBe(false);
    for (const language of ["", "plain", "markdown", "tex"]) {
      expect(copilotServes(consented, true, "one", false, language, "/one/notes.md")).toBe(false);
    }
    expect(copilotServes({ ...consented, code_completion_provider: undefined }, true, "one", false, "typescript", ts)).toBe(false);
    const localOnly = { ...consented, completion_project_policies: { one: { directory: "/one", copilot: true, local_only: true } } };
    expect(copilotServes(localOnly, true, "one", false, "typescript", ts)).toBe(false);
  });

  it("serves text files only under the project's text consent, and never credential files", () => {
    const text = { ...consented, completion_project_policies: {
      one: { directory: "/one", copilot: true, local_only: false, copilot_text: true } } } as Settings;
    for (const [language, path] of [["markdown", "/one/a.md"], ["tex", "/one/p.tex"], ["plain", "/one/n.txt"], ["plain", "/one/NOTES"]]) {
      expect(copilotServes(text, true, "one", false, language, path)).toBe(true);
    }
    expect(copilotServes(text, true, "one", false, "", "/one/x")).toBe(false);
    const textOnly = { ...consented, completion_project_policies: {
      one: { directory: "/one", copilot: false, local_only: false, copilot_text: true } } } as Settings;
    expect(copilotServes(textOnly, true, "one", false, "markdown", "/one/a.md")).toBe(false);
    for (const path of ["/one/.env", "/one/.env.local", "/one/prod.env", "/one/id_ed25519", "/one/tls.pem", "C:\\one\\server.KEY"]) {
      expect(copilotServes(text, true, "one", false, "toml", path)).toBe(false);
    }
  });
});

describe("CopilotCompletionProvider", () => {
  it("cancels a reservation that arrives after abort without sending document content", async () => {
    let reserve!: (id: string) => void;
    invoke.mockImplementation((command: string) => command === "copilot_prepare"
      ? new Promise((done) => { reserve = done; }) : Promise.resolve());
    const ctl = new AbortController();
    const pending = provider().complete(doc("private text"), ctl.signal, vi.fn());
    const rejected = expect(pending).rejects.toThrow();
    ctl.abort();
    reserve("late-reservation");
    await rejected;
    expect(invoke).toHaveBeenCalledWith("copilot_cancel", { projectId: "one", editor: "e", requestId: "late-reservation" });
    expect(invoke.mock.calls.some(([command]) => command === "copilot_complete")).toBe(false);
  });
  it("sends the document with a UTF-16 position and keeps only representable candidates", async () => {
    invoke.mockResolvedValueOnce("reservation").mockResolvedValueOnce([
      { id: "9:0", insertText: "const a = 1;", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } },
      { id: "9:1", insertText: "let b", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } } },
      { id: "9:2", insertText: " = 2", range: null },
    ]);
    const publish = vi.fn();
    const result = await provider().complete(doc("// 😀\nconst "), new AbortController().signal, publish);
    expect(invoke).toHaveBeenCalledWith("copilot_complete", expect.objectContaining({
      projectId: "one", editor: "e", version: 3, position: { line: 1, character: 6 }, automatic: true, tabSize: 2,
    }));
    expect(result.map((c) => [c.id, c.text, c.model])).toEqual([["9:0", "a = 1;", "copilot"], ["9:2", " = 2", "copilot"]]);
    expect(publish).toHaveBeenCalledWith(result);
  });

  it("cancels the backend request on abort and publishes nothing afterwards", async () => {
    let resolve!: (items: unknown[]) => void;
    invoke.mockImplementation((command: string) => command === "copilot_complete"
      ? new Promise((done) => { resolve = done; }) : Promise.resolve("reservation"));
    const ctl = new AbortController();
    const publish = vi.fn();
    const pending = provider().complete(doc("const "), ctl.signal, publish);
    await Promise.resolve();
    ctl.abort();
    expect(invoke).toHaveBeenCalledWith("copilot_cancel", { projectId: "one", editor: "e", requestId: "reservation" });
    resolve([{ id: "1:0", insertText: "late" }]);
    await expect(pending).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("CopilotFeedback", () => {
  it("reports shown once, partial acceptance cumulatively and full acceptance once", async () => {
    invoke.mockResolvedValueOnce("reservation").mockResolvedValueOnce([{ id: "4:0", insertText: "foo bar" }]);
    const [candidate] = await provider().complete(doc("x "), new AbortController().signal, () => {});
    invoke.mockClear();
    const feedback = new CopilotFeedback("one", "e");
    feedback.show(candidate);
    feedback.show({ ...candidate, text: "bar" }); // same candidate, remainder still ghosted
    expect(invoke.mock.calls).toEqual([["copilot_shown", { projectId: "one", editor: "e", candidate: "4:0" }]]);
    feedback.accept("foo");
    feedback.accept(" bar");
    feedback.accept("again");
    expect(invoke.mock.calls.slice(1)).toEqual([
      ["copilot_accepted", { projectId: "one", editor: "e", candidate: "4:0", acceptedLength: 3 }],
      ["copilot_accepted", { projectId: "one", editor: "e", candidate: "4:0", acceptedLength: undefined }],
    ]);
  });

  it("ignores Ollama candidates and text that is not the ghost's front", async () => {
    const feedback = new CopilotFeedback("one", "e");
    feedback.show({ provider: "ollama", id: "k", version: 1, text: "abc", at: 0, acceptedPrefix: 0,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } });
    feedback.accept("abc");
    expect(invoke).not.toHaveBeenCalled();
  });
});
