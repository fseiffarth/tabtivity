import { describe, expect, it } from "vitest";
import { isPermissionDialog, permissionSubject } from "../../../mobile-web/src/terminal/permissionSubject";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";

const T0 = "2026-11-18T09:00:00.000Z";
const T1 = "2026-11-18T09:00:05.000Z";
const T2 = "2026-11-18T09:00:09.000Z";

describe("what a permission dialog is about", () => {
  it("is the waiting Bash call's command, not a backgrounded one", () => {
    expect(permissionSubject({ shells: [{ command: "npm run dev", at: T0, background: true }, { command: "rm -f probe-file", at: T1 }] }))
      .toEqual({ kind: "command", tool: "Bash", subject: "rm -f probe-file" });
    // Only a backgrounded shell: nothing waits for approval.
    expect(permissionSubject({ shells: [{ command: "npm run dev", at: T0, background: true }] })).toBeNull();
  });

  it("is a file tool's path, a fetch's URL, any other tool's name", () => {
    const only = (name: string, subject?: string) => permissionSubject({ waitingTools: [{ name, ...(subject ? { subject } : {}), at: T1 }] });
    expect(only("Edit", "src/a.rs")).toEqual({ kind: "file", tool: "Edit", subject: "src/a.rs" });
    expect(only("NotebookEdit", "nb.ipynb")).toEqual({ kind: "file", tool: "NotebookEdit", subject: "nb.ipynb" });
    expect(only("WebFetch", "https://docs.example.org")).toEqual({ kind: "url", tool: "WebFetch", subject: "https://docs.example.org" });
    expect(only("ExitPlanMode")).toEqual({ kind: "tool", tool: "ExitPlanMode", subject: "" });
    // The phone's mask can leave a URL empty: the tool's name is what is known.
    expect(only("WebFetch")).toEqual({ kind: "tool", tool: "WebFetch", subject: "" });
    // A subject a tool that takes none carries is not shown.
    expect(only("Read", "src/secret.rs")).toEqual({ kind: "tool", tool: "Read", subject: "" });
  });

  it("is the newest waiting call of either list", () => {
    const shells = [{ command: "make", at: T0 }];
    expect(permissionSubject({ shells, waitingTools: [{ name: "Edit", subject: "a.rs", at: T1 }] })?.tool).toBe("Edit");
    expect(permissionSubject({ shells: [{ command: "make", at: T2 }], waitingTools: [{ name: "Edit", subject: "a.rs", at: T1 }] })?.tool).toBe("Bash");
    // Oldest first: of two with one time, the later in the list.
    expect(permissionSubject({ waitingTools: [{ name: "Edit", subject: "a.rs", at: T1 }, { name: "Write", subject: "b.rs", at: T1 }] })?.subject).toBe("b.rs");
    expect(permissionSubject({ shells: [{ command: "one" }, { command: "two" }] })?.subject).toBe("two");
  });

  it("is nothing when nothing waits, and bounded when a lot does", () => {
    expect(permissionSubject(null)).toBeNull();
    expect(permissionSubject({})).toBeNull();
    expect(permissionSubject({ shells: [] })).toBeNull();
    const long = permissionSubject({ shells: [{ command: "x".repeat(900) }] });
    expect(long?.subject.length).toBeLessThanOrEqual(500);
    const many = permissionSubject({ shells: [{ command: Array.from({ length: 30 }, (_, n) => `line ${n}`).join("\n") }] });
    expect(many?.subject.split("\n")).toHaveLength(8);
  });
});

describe("which card is a permission dialog", () => {
  const prompt = (extra: Partial<SelectPrompt> = {}): SelectPrompt => ({ options: [], current: 0, start: 0, question: 0, context: 0, ...extra });
  it("is a dialog with no tab row, from the screen, that is not the review step", () => {
    expect(isPermissionDialog(prompt(), 0)).toBe(true);
    expect(isPermissionDialog(null, 0)).toBe(false);
    expect(isPermissionDialog(prompt(), 2)).toBe(false);
    expect(isPermissionDialog(prompt({ review: true }), 0)).toBe(false);
    expect(isPermissionDialog(prompt({ source: "entry" }), 0)).toBe(false);
    expect(isPermissionDialog(prompt({ source: "opencode" }), 0)).toBe(false);
  });
});
