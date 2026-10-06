/**
 * The desktop markup mode's pure rules (`docs/pdf_markup_rounds_plan.md` §2.6,
 * `lib/viewers/pdfMarkup.ts`): when the viewer offers Mark up, where an on-disk
 * change goes while marks are on the pages, one marking viewer per file, the
 * command's refusal codes, and which agent tab a Submit goes to.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  _clearMarkupClaimsForTest,
  claimMarkup,
  diskChangeAction,
  markupErrorCode,
  markupGate,
  markupHolder,
  markupReasonKey,
  MAX_MARKUP_PDF,
  releaseMarkup,
} from "../../lib/viewers/pdfMarkup";
import { agentTargets, defaultTarget } from "../../components/embed/pdf/usePdfMarkup";
import { agentTabStateOf } from "../../stores/activity";
import type { TabEntry } from "../../stores/tabs";
import { en } from "../../lib/i18n";

const OPEN = {
  scope: "p1",
  source: "none" as const,
  detached: false,
  size: 40_000,
  pristine: true,
  dirty: false,
  claimedElsewhere: false,
};

describe("markupGate", () => {
  it("offers Mark up on a local project's pristine PDF in the main window", () => {
    expect(markupGate(OPEN)).toEqual({ show: true, blocked: null });
  });

  it("hides it for the root scope, a box, a remote project and a popout", () => {
    expect(markupGate({ ...OPEN, scope: null }).show).toBe(false);
    expect(markupGate({ ...OPEN, scope: "root" }).show).toBe(false);
    expect(markupGate({ ...OPEN, scope: "box:b1" }).show).toBe(false);
    expect(markupGate({ ...OPEN, source: "remote" }).show).toBe(false);
    expect(markupGate({ ...OPEN, source: "local" }).show).toBe(false);
    expect(markupGate({ ...OPEN, detached: true }).show).toBe(false);
  });

  it("hides it until the file is loaded and past what the backend reads", () => {
    expect(markupGate({ ...OPEN, size: null }).show).toBe(false);
    expect(markupGate({ ...OPEN, size: MAX_MARKUP_PDF }).show).toBe(true);
    expect(markupGate({ ...OPEN, size: MAX_MARKUP_PDF + 1 }).show).toBe(false);
  });

  it("holds it back on an arranged or unsaved document", () => {
    expect(markupGate({ ...OPEN, pristine: false })).toEqual({ show: true, blocked: "arranged" });
    expect(markupGate({ ...OPEN, dirty: true })).toEqual({ show: true, blocked: "arranged" });
  });

  it("holds it back while another pane marks the same file", () => {
    expect(markupGate({ ...OPEN, claimedElsewhere: true })).toEqual({ show: true, blocked: "claimed" });
  });
});

describe("diskChangeAction — the three reload paths share it", () => {
  it("reloads on its own with markup off, as before", () => {
    expect(diskChangeAction({ dirty: false, markupHolds: false })).toBe("reload");
  });

  it("offers Reload instead while marks are on the pages", () => {
    expect(diskChangeAction({ dirty: false, markupHolds: true })).toBe("markup");
  });

  it("keeps the stale banner for unsaved page edits", () => {
    expect(diskChangeAction({ dirty: true, markupHolds: false })).toBe("stale");
    expect(diskChangeAction({ dirty: true, markupHolds: true })).toBe("stale");
  });

  it("loads a changed PDF under the marks while the setting is on, unless a note or a Submit is open", () => {
    expect(diskChangeAction({ dirty: false, markupHolds: true, autoReload: true })).toBe("underMarks");
    expect(diskChangeAction({ dirty: false, markupHolds: true, autoReload: true, noteOpen: true })).toBe("markup");
    expect(diskChangeAction({ dirty: false, markupHolds: true, autoReload: false })).toBe("markup");
    expect(diskChangeAction({ dirty: true, markupHolds: true, autoReload: true })).toBe("stale");
    expect(diskChangeAction({ dirty: false, markupHolds: false, autoReload: true })).toBe("reload");
  });
});

describe("one marking viewer per file per window", () => {
  afterEach(() => _clearMarkupClaimsForTest());

  it("refuses a second pane, and lets it in once the first lets go", () => {
    expect(claimMarkup("p1:files:/p/a.pdf", "pane-1")).toBe(true);
    expect(claimMarkup("p1:files:/p/a.pdf", "pane-1")).toBe(true);
    expect(claimMarkup("p1:files:/p/a.pdf", "pane-2")).toBe(false);
    expect(markupHolder("p1:files:/p/a.pdf")).toBe("pane-1");
    // Another file is free.
    expect(claimMarkup("p1:files:/p/b.pdf", "pane-2")).toBe(true);
    // Only the holder releases.
    releaseMarkup("p1:files:/p/a.pdf", "pane-2");
    expect(markupHolder("p1:files:/p/a.pdf")).toBe("pane-1");
    releaseMarkup("p1:files:/p/a.pdf", "pane-1");
    expect(claimMarkup("p1:files:/p/a.pdf", "pane-2")).toBe(true);
  });
});

describe("refusal codes", () => {
  it("reads the command's bare code, a queueing error and the schedule cap", () => {
    expect(markupErrorCode("hidden_path")).toBe("hidden_path");
    expect(markupErrorCode(new Error("message_too_long"))).toBe("message_too_long");
    expect(markupErrorCode("a tab may have at most 32 schedules")).toBe("schedule_cap");
    expect(markupErrorCode(new Error("Something odd happened"))).toBe("other");
  });

  it("has words for every code the command answers", () => {
    const codes = [
      "remote_project", "project_not_found", "outside_project", "hidden_path", "file_not_found",
      "file_too_large", "read_failed", "project_unavailable", "unsupported_source", "invalid_markup",
      "invalid_layer", "layer_missing", "inbox_full", "write_failed", "empty_file", "markup_failed",
      "message_too_long", "schedule_cap",
    ];
    for (const code of codes) {
      const key = markupReasonKey(code);
      expect(key, code).not.toBe("pdfMarkup.reason.other");
      expect(en[key], code).toBeTruthy();
    }
    expect(markupReasonKey("brand_new")).toBe("pdfMarkup.reason.other");
  });
});

describe("Submit targets", () => {
  const tab = (key: string, kind: TabEntry["kind"], scheduleTargetId?: string, label = key): TabEntry =>
    ({ key, label, cmd: "claude", cwd: "/p", kind, scheduleTargetId }) as TabEntry;

  it("lists the project's agent tabs that take a scheduled prompt", () => {
    const targets = agentTargets("p1", [
      tab("t1", "agent", "s1", "Claude"),
      tab("t2", "shell"),
      tab("t3", "local_agent", "s3", "Qwen"),
      tab("t4", "agent"),
    ]);
    expect(targets).toEqual([
      { scheduleTargetId: "s1", label: "Claude", ptyId: "p1:t1" },
      { scheduleTargetId: "s3", label: "Qwen", ptyId: "p1:t3" },
    ]);
  });

  it("defaults to the tab last deliberately opened, else the first", () => {
    const targets = agentTargets("p1", [tab("t1", "agent", "s1"), tab("t2", "agent", "s2")]);
    expect(defaultTarget(targets, () => undefined)?.scheduleTargetId).toBe("s1");
    expect(defaultTarget(targets, (pty) => (pty === "p1:t2" ? 50 : 10))?.scheduleTargetId).toBe("s2");
    expect(defaultTarget([], () => 1)).toBeNull();
  });

  it("reads the tab's live state off the activity lamps", () => {
    expect(agentTabStateOf({ busyByTab: { a: true }, attentionByTab: {} }, "a")).toBe("working");
    expect(agentTabStateOf({ busyByTab: {}, attentionByTab: { a: "decision" } }, "a")).toBe("question");
    expect(agentTabStateOf({ busyByTab: {}, attentionByTab: { a: "done" } }, "a")).toBe("idle");
  });
});
