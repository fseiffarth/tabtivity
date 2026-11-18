import { describe, expect, it } from "vitest";
import { isPermissionDialog, permissionSubject } from "../../../mobile-web/src/terminal/permissionSubject";
import type { SelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";

const T0 = "2026-11-18T09:00:00.000Z";
const T1 = "2026-11-18T09:00:05.000Z";
const T2 = "2026-11-18T09:00:09.000Z";

const BASH_DIALOG = ["Bash command", "rm -f probe-file", "Do you want to proceed?", "1. Yes", "2. Yes, and always allow access to /work/proj from this project", "3. No"];
const EDIT_DIALOG = ["Edit file", "src/a.rs", "Do you want to make this edit to a.rs?", "1. Yes", "2. Yes, allow all edits during this session", "3. No"];
const CREATE_DIALOG = ["Create file", "src/b.rs", "Do you want to create b.rs?", "1. Yes", "2. No"];
const FETCH_DIALOG = ["Fetch", "https://docs.example.org", "Do you want to allow Claude to fetch this content?", "1. Yes", "2. No"];

describe("what a permission dialog is about", () => {
  it("is the waiting Bash call whose command the dialog prints, not a backgrounded one", () => {
    expect(permissionSubject({ shells: [{ command: "npm run dev", at: T0, background: true }, { command: "rm -f probe-file", at: T1 }] }, BASH_DIALOG))
      .toEqual({ kind: "command", tool: "Bash", subject: "rm -f probe-file" });
    // Only a backgrounded shell: nothing waits for approval.
    expect(permissionSubject({ shells: [{ command: "rm -f probe-file", at: T0, background: true }] }, BASH_DIALOG)).toBeNull();
  });

  it("picks, of parallel Bash calls, the one on screen, whatever their order", () => {
    const shells = [{ command: "rm -f probe-file", at: T0 }, { command: "make all", at: T1 }];
    expect(permissionSubject({ shells }, BASH_DIALOG)?.subject).toBe("rm -f probe-file");
    expect(permissionSubject({ shells }, ["Bash command", "make all", "Do you want to proceed?"])?.subject).toBe("make all");
    // Two printed: the newest.
    expect(permissionSubject({ shells: [{ command: "make", at: T0 }, { command: "make all", at: T1 }] }, ["make all", "Do you want to proceed?"])?.subject).toBe("make all");
  });

  it("matches a command the phone's mask changed, word by word", () => {
    const dialog = ["Bash command", "cat /work/proj/src/lib.rs /home/me/notes.txt && deploy --token sk-abc123", "Do you want to proceed?"];
    const masked = [{ command: "cat src/lib.rs …/notes.txt && deploy --token •••", at: T1 }];
    expect(permissionSubject({ shells: masked }, dialog)?.tool).toBe("Bash");
    // A command that is nothing but masked words proves nothing.
    expect(permissionSubject({ shells: [{ command: "•••", at: T1 }] }, dialog)).toBeNull();
    // Not this dialog's command.
    expect(permissionSubject({ shells: [{ command: "cat other.rs", at: T1 }] }, dialog)).toBeNull();
  });

  it("is a file tool's path in an edit or create dialog, a fetch's URL in a fetch dialog", () => {
    const only = (dialog: string[], name: string, subject?: string) => permissionSubject({ waitingTools: [{ name, ...(subject ? { subject } : {}), at: T1 }] }, dialog);
    expect(only(EDIT_DIALOG, "Edit", "src/a.rs")).toEqual({ kind: "file", tool: "Edit", subject: "src/a.rs" });
    expect(only(CREATE_DIALOG, "Write", "src/b.rs")).toEqual({ kind: "file", tool: "Write", subject: "src/b.rs" });
    expect(only(EDIT_DIALOG, "NotebookEdit", "nb.ipynb")).toEqual({ kind: "file", tool: "NotebookEdit", subject: "nb.ipynb" });
    expect(only(FETCH_DIALOG, "WebFetch", "https://docs.example.org")).toEqual({ kind: "url", tool: "WebFetch", subject: "https://docs.example.org" });
    // The phone's mask can leave a URL empty: the tool's name is what is known.
    expect(only(FETCH_DIALOG, "WebFetch")).toEqual({ kind: "tool", tool: "WebFetch", subject: "" });
  });

  it("is the newest call of the dialog's own family, preferring the file it names", () => {
    const tools = [{ name: "Edit", subject: "src/a.rs", at: T0 }, { name: "Write", subject: "src/b.rs", at: T1 }, { name: "Edit", subject: "src/c.rs", at: T2 }];
    // The dialog names a.rs: that call, though two are newer.
    expect(permissionSubject({ waitingTools: tools }, EDIT_DIALOG)?.subject).toBe("src/a.rs");
    // Naming none of them: the newest of the family.
    expect(permissionSubject({ waitingTools: tools }, ["Edit file", "Do you want to make this edit to z.rs?"])?.subject).toBe("src/c.rs");
    // Oldest first: of two with one time, the later in the list.
    expect(permissionSubject({ waitingTools: [{ name: "Edit", subject: "x.rs", at: T1 }, { name: "Write", subject: "y.rs", at: T1 }] }, ["Do you want to make this edit?"])?.subject).toBe("y.rs");
  });

  it("never heads a dialog with a call it is not about", () => {
    // An Agent run and a running approved command are in flight behind a file dialog.
    const flight = { shells: [{ command: "npm test", at: T2 }], waitingTools: [{ name: "Agent", at: T2 }, { name: "Edit", subject: "src/a.rs", at: T0 }] };
    expect(permissionSubject(flight, EDIT_DIALOG)).toEqual({ kind: "file", tool: "Edit", subject: "src/a.rs" });
    // A Bash dialog with no matching shell, only an Agent and an Edit in flight: nothing.
    expect(permissionSubject({ waitingTools: flight.waitingTools }, BASH_DIALOG)).toBeNull();
    // A fetch dialog has no fetch call waiting: not the Edit.
    expect(permissionSubject({ waitingTools: flight.waitingTools }, FETCH_DIALOG)).toBeNull();
    // A dialog of no known kind (an MCP tool, the plan): no subject.
    expect(permissionSubject({ shells: flight.shells, waitingTools: [{ name: "ExitPlanMode", at: T2 }] }, ["Ready to code?", "1. Yes", "2. No"])).toBeNull();
    // A subject on a tool that takes none is not shown.
    expect(permissionSubject({ waitingTools: [{ name: "Read", subject: "src/secret.rs", at: T1 }] }, EDIT_DIALOG)).toBeNull();
  });

  it("is nothing when nothing waits, and bounded when a lot does", () => {
    expect(permissionSubject(null, BASH_DIALOG)).toBeNull();
    expect(permissionSubject({}, BASH_DIALOG)).toBeNull();
    expect(permissionSubject({ shells: [] }, BASH_DIALOG)).toBeNull();
    const long = permissionSubject({ shells: [{ command: "x".repeat(900) }] }, ["x".repeat(900)]);
    expect(long?.subject.length).toBeLessThanOrEqual(500);
    const lines = Array.from({ length: 30 }, (_, n) => `line ${n}`);
    const many = permissionSubject({ shells: [{ command: lines.join("\n") }] }, lines);
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
