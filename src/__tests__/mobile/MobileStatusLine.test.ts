import { describe, expect, it } from "vitest";
import { sessionStatus, shortenPath, statusFrameLines } from "../../../mobile-web/src/terminal/statusLine";
import { BRAND } from "../../lib/brand";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

describe(`${BRAND.display} Mobile session status line`, () => {
  it("reads path, branch, model, mode and context from a statusline", () => {
    // The Claude Code shape: input box (already unframed by readableScreen),
    // then the configured statusline below it.
    expect(sessionStatus(lines(
      "● Done.",
      "",
      ">",
      `~/${BRAND.slug}/projects/project${BRAND.slug} (develop) · Opus 4.1 · plan mode on (shift+tab to cycle) · 85% context left`,
    ))).toEqual({
      path: `~/${BRAND.slug}/projects/project${BRAND.slug}`,
      branch: "develop",
      model: "Opus 4.1",
      mode: "plan",
      context: "85%",
    });
  });

  it("reads the default Claude Code footer without inventing fields", () => {
    const status = sessionStatus(lines("> ", "? for shortcuts · 85% context left"));
    expect(status).toEqual({ context: "85%" });
  });

  it("reads the mode line drawn below the input box", () => {
    expect(sessionStatus(lines("> try it", "⏵⏵ accept edits on (shift+tab to cycle)")))
      .toEqual({ mode: "accept edits" });
    expect(sessionStatus(lines(">", "⏵⏵ bypass permissions on (shift+tab to cycle)")))
      .toEqual({ mode: "bypass permissions" });
  });

  it("reads a Codex-shaped footer", () => {
    expect(sessionStatus(lines(
      "› ",
      "/home/dev/proj (main) · gpt-5-codex · 97% context left",
    ))).toEqual({
      path: "/home/dev/proj",
      branch: "main",
      model: "gpt-5-codex",
      context: "97%",
    });
  });

  it("reads Codex permission updates above its otherwise silent footer", () => {
    for (const label of ["Ask for approval", "Approve for me", "Default", "Workspace"]) {
      expect(sessionStatus(lines(
        `• Permissions updated to ${label}`,
        "",
        "› ",
        "? for shortcuts",
      ), "Codex")?.mode).toBe("auto");
    }
    expect(sessionStatus(lines(
      "• Permissions updated to Read Only",
      "",
      "› ",
      "? for shortcuts",
    ), "Codex")?.mode).toBe("read only");
    // The same prose in another agent's output is not a mode readout.
    expect(sessionStatus(lines(
      "• Permissions updated to Ask for approval",
      "",
      "> ",
      "? for shortcuts",
    ), "Claude")?.mode).toBeUndefined();
  });

  it("never mistakes the cycle hint or a count for a branch", () => {
    const status = sessionStatus(lines(">", "~/proj (3) · plan mode on (shift+tab to cycle)"));
    expect(status?.branch).toBeUndefined();
    expect(status?.mode).toBe("plan");
  });

  it("answers null when the bottom of the screen is not an input frame", () => {
    // A markdown quote in ordinary output must not be read as the input box.
    expect(sessionStatus(lines(
      "> a quoted sentence from the answer",
      ...Array.from({ length: 9 }, (_, index) => `prose line ${index}`),
    ))).toBeNull();
    expect(sessionStatus(lines("dev@host:~/proj$ npm test"))).toBeNull();
  });

  it("does not read 'auto-compact' in the context notice as a mode", () => {
    const status = sessionStatus(lines(">", "Context left until auto-compact: 34%"));
    expect(status).toEqual({ context: "34%" });
  });

  it("reads every Qwen Code approval-mode indicator", () => {
    // The exact AutoAcceptIndicator strings qwen-code draws below its input
    // box, cycle hint included (English locale — the CLI's default).
    expect(sessionStatus(lines(">", "⏸ Ask permissions (shift + tab to cycle)"))?.mode)
      .toBe("ask permissions");
    // "auto-accept edits" contains "accept edits", so the earlier, more
    // general pattern reports it — the Qwen family lists that as an alias.
    expect(sessionStatus(lines(">", "auto-accept edits (shift + tab to cycle)"))?.mode)
      .toBe("accept edits");
    expect(sessionStatus(lines(">", "Auto mode (shift + tab to cycle)"))?.mode)
      .toBe("auto");
    expect(sessionStatus(lines(">", "plan mode (shift + tab to cycle)"))?.mode)
      .toBe("plan");
    // YOLO switches the prompt prefix to `*`, so the input line itself changes.
    expect(sessionStatus(lines("* ", "YOLO mode (shift + tab to cycle)"))?.mode)
      .toBe("yolo");
  });

  it("reads a decimal context percentage and Gemini's bare '% used', as remaining", () => {
    // Qwen prints "45.2% context used"; the old integer-only match read the
    // trailing "2%" out of it. A "used" figure is flipped to what is left.
    expect(sessionStatus(lines(">", "45.2% context used"))?.context).toBe("54.8%");
    expect(sessionStatus(lines(">", "ctx 30% used"))?.context).toBe("70%");
    expect(sessionStatus(lines(">", "ctx 30%"))?.context).toBe("30%");
    // Gemini's footer column says "25% used" with no word "context" at all.
    expect(sessionStatus(lines(">", "~/proj  main  gemini-2.5-pro  25% used"))).toMatchObject({
      path: "~/proj",
      model: "gemini-2.5-pro",
      context: "75%",
    });
    // A percentage inside a sentence is not a context readout.
    expect(sessionStatus(lines(">", "Downloading 50% done"))?.context).toBeUndefined();
  });

  it("shortens a long path to its last two components", () => {
    expect(shortenPath(`~/${BRAND.slug}/projects/project${BRAND.slug}`)).toBe(`…/projects/project${BRAND.slug}`);
    expect(shortenPath("~/proj")).toBe("~/proj");
    expect(shortenPath("/home/dev/work/app")).toBe("…/work/app");
  });
});

describe(`${BRAND.display} Mobile status frame lines`, () => {
  it("returns the rows under a Claude-style input box", () => {
    // readableScreen has already stripped the box: the rules are gone and the
    // labelled top edge survives only as frameText.
    expect(statusFrameLines([
      { text: "● Done." },
      { text: "" },
      { text: `Project${BRAND.display}`, frameText: `──────── Project${BRAND.display} ─` },
      { text: ">" },
      { text: "  ⏵⏵ accept edits on (shift+tab to cycle)   " },
      { text: `  ~/${BRAND.slug}/projects/project${BRAND.slug} (develop) · Opus 4.1 · 85% context left` },
    ])).toEqual([
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
      `  ~/${BRAND.slug}/projects/project${BRAND.slug} (develop) · Opus 4.1 · 85% context left`,
    ]);
    expect(statusFrameLines(lines("> ", "? for shortcuts · 85% context left")))
      .toEqual(["? for shortcuts · 85% context left"]);
  });

  it("returns a Codex-shaped footer, skipping the composer's padding", () => {
    expect(statusFrameLines(lines(
      "• The change is ready.",
      "› ",
      "",
      "/home/dev/proj (main) · gpt-5-codex · 97% context left",
    ))).toEqual(["/home/dev/proj (main) · gpt-5-codex · 97% context left"]);
    expect(statusFrameLines(lines(
      "› Summarize recent commits",
      "",
      "  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit   97% context left",
    ))).toEqual(["  ⏎ send   ⌃J newline   ⌃T transcript   ⌃C quit   97% context left"]);
  });

  it("answers [] when the bottom of the screen is not an input frame", () => {
    expect(statusFrameLines([])).toEqual([]);
    expect(statusFrameLines(lines("dev@host:~/proj$ npm test", "PASS 12 tests"))).toEqual([]);
    expect(statusFrameLines(lines(
      "> a quoted sentence from the answer",
      ...Array.from({ length: 9 }, (_, index) => `prose line ${index}`),
    ))).toEqual([]);
    // An input line with nothing under it is a frame with no status.
    expect(statusFrameLines(lines("● Done.", ">"))).toEqual([]);
  });

  it("answers [] under a select dialog, whose rows are its answers", () => {
    expect(statusFrameLines(lines(
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently",
      "Esc to cancel",
    ))).toEqual([]);
  });

  it("skips the rows of a multi-line draft", () => {
    expect(statusFrameLines(lines(
      "> fix the flaky test",
      "  and add a regression case",
      "  then run the suite",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ))).toEqual(["  ⏵⏵ accept edits on (shift+tab to cycle)"]);
    // A labelled bottom edge right under the draft is the box, not status.
    expect(statusFrameLines([
      { text: "› first line" },
      { text: "  second line" },
      { text: "Opus 4.1", frameText: "──────── Opus 4.1 ─" },
      { text: "~/proj (main) · 40% context left" },
    ])).toEqual(["~/proj (main) · 40% context left"]);
    // A row less indented than the draft is not part of it.
    expect(statusFrameLines(lines("> one", "unrecognized footer"))).toEqual(["unrecognized footer"]);
  });

  it("keeps a custom statusline verbatim, emoji and segments included", () => {
    const custom = `🤖 Opus 4.1 │ 📁 project${BRAND.slug} │ 🌿 develop │ 💰 $0.42 │ ⏱ 12m`;
    expect(statusFrameLines(lines("> ", custom, "", "✨ vibes: immaculate"))).toEqual([custom, "✨ vibes: immaculate"]);
    // Recognized even while a draft is typed: the branch marks it as status.
    expect(statusFrameLines(lines("> draft", `  ${custom}`))).toEqual([`  ${custom}`]);
  });
});
