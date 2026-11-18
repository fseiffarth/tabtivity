import { describe, expect, it } from "vitest";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { BRAND } from "../../lib/brand";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));

// Rows copied from the Codex 0.167-0.169 captures (tmp/verify-cli/codex), home
// path shortened. The footer is `<model> <effort> · <dir>`; the model is the
// session's own, here a local Ollama name.
describe(`${BRAND.display} Codex footer status`, () => {
  it("reads a local model and its effort from the idle footer", () => {
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  nemotron-3.5-bolt:e4b default · ~/work",
      "  ← for agents · ? for shortcuts                                           ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({ model: "nemotron-3.5-bolt:e4b", path: "~/work" });
  });

  it("reads a hosted model, with its effort, in Plan mode at 100 and 60 columns", () => {
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  gpt-5.2-codex medium · ~/work",
      "  ← for agents · ? for shortcuts          Plan mode (shift+tab to cycle) · ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({ model: "gpt-5.2-codex", effort: "medium", path: "~/work", mode: "plan" });
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  nemotron-3.5-bolt:e4b medium · ~/work",
      "  ← for agents         Plan mode · ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({ model: "nemotron-3.5-bolt:e4b", effort: "medium", path: "~/work", mode: "plan" });
  });

  it("reads the footer under a working turn (queued questions above the box)", () => {
    expect(sessionStatus(lines(
      "• Working (6s • esc to interrupt)",
      "• Queued follow-up inputs",
      "  ? 1 question",
      "    shift+← to answer",
      "› Ask Codex to do anything",
      "  GPT-6.1-Sol default · ~/work",
      "  ← for agents · ? for shortcuts                                                    ⚠ 2 warnings · f2 to view",
    ), "Codex")).toEqual({ model: "GPT-6.1-Sol", path: "~/work" });
  });

  it("reads the remaining context and an xhigh effort of a configured status line", () => {
    expect(sessionStatus(lines(
      "› ",
      "  o3 xhigh · ~/work · Context 85% left",
    ), "Codex")).toEqual({ model: "o3", effort: "xhigh", path: "~/work", context: "85%" });
    expect(sessionStatus(lines(
      "› ",
      "  llama3.2:3b · ~/work · Context 40% used",
    ), "Codex")).toEqual({ model: "llama3.2:3b", path: "~/work", context: "60%" });
    expect(sessionStatus(lines(
      "› ",
      "  ? for shortcuts                                              100% context left",
    ), "Codex")?.context).toBe("100%");
  });

  it("drops a directory the footer cut to fit, keeping the model and mode beside it", () => {
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  nemotron-3.5-bolt:e4b default · /home/dev/project/deeply/nested/…",
      "  ← for agents · ? for shortcuts                                           ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({ model: "nemotron-3.5-bolt:e4b" });
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  nemotron-3.5-bolt:e4b medium · /home/dev/project/… Plan mode",
      "  ← for agents · ? for shortcuts   ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({ model: "nemotron-3.5-bolt:e4b", effort: "medium", mode: "plan" });
  });

  it("reads no model from a footer without one, or from another agent's tab", () => {
    expect(sessionStatus(lines(
      "› Ask Codex to do anything",
      "  ← for agents · ? for shortcuts                                           ⚠ 1 warning · f2 to view",
    ), "Codex")).toEqual({});
    // A plain word before an effort-like one is no model on the first row.
    expect(sessionStatus(lines("› ", "  esc · ~/work"), "Codex")).toEqual({ path: "~/work" });
    // The reading is the Codex tab's: Claude's footer keeps its own rules.
    expect(sessionStatus(lines("> ", "  nemotron-3.5-bolt:e4b default · ~/work"), "Claude")).toEqual({ path: "~/work" });
  });

  it("reads no directory from a command named in the interrupted-turn row of the lock screen", () => {
    expect(sessionStatus(lines(
      "› say hi",
      "■ Conversation interrupted - use /feedback if something went wrong",
      "  🔒  This conversation is open in another app                                          r to retry",
      "      Close it there and press R to continue here.",
      "   r retry   f fork   ←/esc command center   ^c/q exit   ^t transcript",
    ), "Codex")?.path).toBeUndefined();
  });

  it("never reads output above the frame as the footer, and cuts the frame at the box", () => {
    const rows = lines(
      "• The model gpt-5.2-codex high is set in config.toml, see ~/work/config.toml",
      "  llama3.2:3b default · was my first try",
      "",
      "› Ask Codex to do anything",
      "  nemotron-3.5-bolt:e4b default · ~/work",
      "  ← for agents · ? for shortcuts                                           ⚠ 1 warning · f2 to view",
    );
    expect(sessionStatus(rows, "Codex")).toEqual({ model: "nemotron-3.5-bolt:e4b", path: "~/work" });
    expect(inputFrameStart(rows, "Codex")).toBe(2); // the blank row over the box belongs to the frame
  });
});
