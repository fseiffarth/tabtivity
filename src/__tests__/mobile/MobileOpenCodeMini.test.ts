import { describe, expect, it } from "vitest";
import { chatTurns } from "../../../mobile-web/src/terminal/chatTurns";
import { inputFrameStart, sessionStatus, statusFrameLines } from "../../../mobile-web/src/terminal/statusLine";
import { currentMode, modeChoices, modeFixed } from "../../../mobile-web/src/terminal/agentModes";
import { agentWorking } from "../../../mobile-web/src/terminal/agentBusy";
import {
  joinOpenCodeWraps,
  openCodePickKeys,
  readOpenCodePicker,
} from "../../../mobile-web/src/terminal/openCodeMini";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { BRAND } from "../../lib/brand";

/**
 * `opencode --mini` as the phone reads it. Every screen below is a real one:
 * the rows come from captures of an OpenCode 1.18.31 session replayed through
 * the phone's own emulator at 60 and 100 columns, after `readableScreen` (so
 * trailing padding is gone and runs of blanks are one).
 */

let seq = 0;
const line = (text: string): ReadableLine => ({
  key: `l${seq += 1}`,
  text,
  spans: text ? [{ text }] : [],
});
const lines = (...texts: string[]) => texts.map((text) => line(text));
const texts = (rows: readonly { text: string }[]) => rows.map((row) => row.text);

/** The live area at the bottom of every mini frame: the empty input box, then
 * the status row. */
const FRAME = ["", " BUILD                                                    223.0K (21%) · ctrl+p cmd"];

describe(`${BRAND.display} Mobile OpenCode mini status`, () => {
  it("reads the agent, the context and the model a turn footer named", () => {
    expect(sessionStatus(lines(
      "The tests pass.",
      "",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      ...FRAME,
    ), "OpenCode")).toEqual({
      mode: "build",
      context: "79%",
      model: "Muse Spark 1.3 Free",
    });
  });

  it("reads the chip alone, which is all a narrow pane has room for", () => {
    expect(sessionStatus(lines("The tests pass.", "", " PLAN"), "OpenCode"))
      .toEqual({ mode: "plan" });
  });

  it("prefers the model OpenCode notices in the status row after a switch", () => {
    expect(sessionStatus(lines(
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      "",
      " BUILD  model union-alpha                                            ctrl+p cmd",
    ), "OpenCode")?.model).toBe("union-alpha");
  });

  it("is not confused by a notice it does not know", () => {
    expect(sessionStatus(lines("", " BUILD  no variants available                      ctrl+p cmd"), "OpenCode"))
      .toEqual({ mode: "build" });
  });

  it("belongs to a tab whose label names OpenCode, and to no other", () => {
    expect(sessionStatus(lines("The tests pass.", "", ...FRAME), "Claude")).toBeNull();
    expect(sessionStatus(lines("The tests pass.", "", ...FRAME))).toBeNull();
  });

  it("cuts the box and the status row out of the reading view", () => {
    const screen = lines("The tests pass.", "", "▣ Build · Muse Spark 1.3 Free · 6.2s", ...FRAME);
    expect(inputFrameStart(screen, "OpenCode")).toBe(3);
    // Without the label the frame is not found, and nothing is cut.
    expect(inputFrameStart(screen, "Claude")).toBe(screen.length);
  });

  it("takes the empty box's placeholder into the frame", () => {
    const screen = lines(
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
      "",
      "Ask anything... \"Fix a TODO in the codebase\"",
      "",
      " BUILD",
    );
    expect(inputFrameStart(screen, "OpenCode")).toBe(1);
    expect(statusFrameLines(screen, "OpenCode")).toEqual([" BUILD"]);
  });
});

/**
 * The *full* TUI's composer — a plain `opencode` tab — as `readableScreen`
 * leaves it: the box's `┃` stripped with one space of its padding, its `╹▀▀`
 * bottom edge dropped. Built from the 1.18.34 prompt component's source, not
 * a capture; the model row comes with spans so the provider's muted colour
 * can mark where the model's name ends.
 */
const composerRow = (agent: string, model: string, provider: string, variant?: string): ReadableLine => {
  const spans = [
    { text: ` ${agent} · `, color: "#a0a0ff" },
    { text: model, color: "#eeeeee" },
    { text: ` ${provider}`, color: "#808080" },
    ...(variant ? [{ text: " · ", color: "#808080" }, { text: variant, color: "#ffaa00" }] : []),
  ];
  return { key: `l${seq += 1}`, text: spans.map((span) => span.text).join(""), spans };
};
const fullFrame = (footer: string, row = composerRow("Build", "Muse Spark 1.3 Free", "OpenCode Zen", "high")) => [
  ...lines("Is there tailscale for ipads?", "", " Ask anything… \"Fix a TODO in the codebase\"", ""),
  row,
  line(footer),
];

describe(`${BRAND.display} Mobile OpenCode full TUI composer`, () => {
  it("reads the agent, the model without its provider, the variant and the context", () => {
    expect(sessionStatus(fullFrame(" ~/projects/app                        12.3K (5%) · $0.02  ctrl+p commands"), "OpenCode"))
      .toEqual({ mode: "build", model: "Muse Spark 1.3 Free", effort: "high", context: "95%" });
  });

  it("keeps the whole model phrase where the row's colours are unknown", () => {
    const screen = lines(
      "",
      " Plan auto · Grok 4.5 GitHub Copilot",
      " ~/projects/app                                   tab agents  ctrl+p commands",
    );
    expect(sessionStatus(screen, "OpenCode")).toEqual({ mode: "plan", model: "Grok 4.5 GitHub Copilot" });
  });

  it("reads the composer while the session works", () => {
    const screen = fullFrame(" ⬝⬝■■■⬝⬝⬝ esc interrupt                 12.3K (5%)  ctrl+p commands");
    expect(sessionStatus(screen, "OpenCode")?.model).toBe("Muse Spark 1.3 Free");
    expect(agentWorking(screen)).toBe(true);
    expect(agentWorking(fullFrame(" ~/projects/app                 12.3K (5%)  ctrl+p commands"))).toBe(false);
  });

  it("cuts the box, its placeholder and the footer out of the reading view", () => {
    const screen = fullFrame(" ~/projects/app                 tab agents  ctrl+p commands");
    expect(inputFrameStart(screen, "OpenCode")).toBe(1);
    expect(statusFrameLines(screen, "OpenCode")).toEqual([
      " Build · Muse Spark 1.3 Free OpenCode Zen · high",
      " ~/projects/app                 tab agents  ctrl+p commands",
    ]);
  });

  it("names no mode in shell mode", () => {
    const screen = lines("", " Shell", " ~/projects/app                 esc exit shell mode");
    expect(sessionStatus(screen, "OpenCode")).toEqual({});
  });

  it("is not found without its footer, or for a tab no label names OpenCode", () => {
    expect(sessionStatus(lines("", " Build · Muse Spark 1.3 Free", " The tests pass."), "OpenCode")).toBeNull();
    expect(sessionStatus(fullFrame(" ~/projects/app    ctrl+p commands"), "Claude")).toBeNull();
  });
});

describe(`${BRAND.display} Mobile OpenCode mini turns`, () => {
  it("drops the banner, the tool calls and the turn footer", () => {
    const turns = chatTurns(lines(
      "█▀▀█  OpenCode",
      `█  █  ~/${BRAND.slug}/projects/project${BRAND.slug}`,
      "",
      "› fix the failing test",
      "",
      "✱ Grep \"describe\" in src",
      "→ Read src/app.test.ts",
      "% WebFetch https://vitest.dev/api",
      "",
      "The second assertion was wrong.",
      "",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
    ), "OpenCode", 60);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(texts(turns[0].prompt ?? [])).toEqual(["fix the failing test"]);
    expect(texts(turns[1].lines)).toEqual(["The second assertion was wrong."]);
  });

  it("keeps the bash tool's own output, which is the session's words", () => {
    const turns = chatTurns(lines(
      "› run echo hi",
      "",
      "Running that for you.",
      "",
      "$ echo hi",
      "",
      "hi",
    ), "OpenCode", 60);
    expect(texts(turns[1].lines)).toEqual(["Running that for you.", "", "$ echo hi", "", "hi"]);
  });

  it("keeps a wrapped tool call whole instead of stranding its tail", () => {
    // OpenCode wraps its own rows; the tail carries no marker at all, and
    // before the block rule it was read as the agent's first answer line.
    const turns = chatTurns(lines(
      "› go on",
      "",
      "✱ Grep \"permitted|AgentCatalog|agents.*=|listAgents|AGENT\"",
      "in src/components/mobile",
      "",
      "Nothing matches.",
    ), "OpenCode", 60);
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(texts(turns[1].lines)).toEqual(["Nothing matches."]);
  });

  it("keeps a wrapped prompt in one bubble", () => {
    const turns = chatTurns(lines(
      "› Is there a good opencode cli terminal wrapper for mobile",
      "phones?",
      "",
      "No official one.",
    ), "OpenCode", 60);
    expect(texts(turns[0].prompt ?? []))
      .toEqual(["Is there a good opencode cli terminal wrapper for mobile phones?"]);
  });

  it("leaves every other family's tab exactly as it was", () => {
    const screen = lines("█▀▀█  OpenCode", "", "› ask", "", "→ Read src/app.ts", "", "done");
    expect(texts(chatTurns(screen, "Claude", 60).flatMap((turn) => turn.lines)))
      .toEqual(["█▀▀█  OpenCode", "› ask", "→ Read src/app.ts", "", "done"]);
  });
});

describe(`${BRAND.display} Mobile OpenCode wrapped rows`, () => {
  const joined = (columns: number, ...rows: string[]) => texts(joinOpenCodeWraps(lines(...rows), columns));

  it("puts back the space a word wrap broke at", () => {
    expect(joined(60,
      "Thinking: Summarizing community mobile wrappers for",
      "opencode using Web UI and HTTP/SSE with auth and streaming.",
    )).toEqual(["Thinking: Summarizing community mobile wrappers for opencode using Web UI and HTTP/SSE with auth and streaming."]);
  });

  it("leaves a break the session meant alone", () => {
    // The next word would have fitted, so the newline was the session's.
    expect(joined(60, "opencode web --hostname 0.0.0.0 --port 4096", "# with auth:"))
      .toEqual(["opencode web --hostname 0.0.0.0 --port 4096", "# with auth:"]);
  });

  it("rejoins a long token broken at its own punctuation", () => {
    expect(joined(60,
      "- Android: OpenCode: AI Coding Agent (github.com/dzianisv/",
      "  opencode-mobile, MIT, Play Store) — streaming, diff",
    )).toEqual(["- Android: OpenCode: AI Coding Agent (github.com/dzianisv/opencode-mobile, MIT, Play Store) — streaming, diff"]);
    expect(joined(60,
      "- src-tauri/src/services/sandbox.rs:1815 — fence mounts ~/.",
      "  local/share/opencode rw so --continue survives",
    )).toEqual(["- src-tauri/src/services/sandbox.rs:1815 — fence mounts ~/.local/share/opencode rw so --continue survives"]);
  });

  it("gives the space back when the wrap kept it past the hanging indent", () => {
    expect(joined(60,
      "- Alt wrapper: bmpenuelas/opencode-mobile-client (Capacitor,",
      "   wraps Web UI, server profiles, basic-auth, secure",
    )).toEqual(["- Alt wrapper: bmpenuelas/opencode-mobile-client (Capacitor, wraps Web UI, server profiles, basic-auth, secure"]);
  });

  it("never joins onto a row that opens a block of OpenCode's own", () => {
    expect(joined(60,
      "The change is in src/components/mobile/MobileBridgeHost.tsx,",
      "› and the next prompt",
    )).toHaveLength(2);
    expect(joined(60,
      "It reads the catalog, the tabs and the schedules in order,",
      "▣ Build · Muse Spark 1.3 Free · 6.2s",
    )).toHaveLength(2);
  });

  it("does nothing without the pane's width", () => {
    expect(joined(0, "a row that was wrapped", "and its tail")).toHaveLength(2);
  });
});

describe(`${BRAND.display} Mobile OpenCode mode chip`, () => {
  it("lists the agents a mini session can be in, for a tab labelled OpenCode", () => {
    const choices = modeChoices("build", "OpenCode");
    expect(choices.map((choice) => choice.value)).toEqual(["build", "plan"]);
    expect(currentMode(choices, "build")).toBe("build");
    // "plan" is four other families' word; the label decides.
    expect(modeChoices("plan", "OpenCode").map((choice) => choice.value)).toEqual(["build", "plan"]);
    expect(modeChoices("plan", "Claude").map((choice) => choice.value)).toContain("accept edits");
  });

  it("never claims a session no label names", () => {
    expect(modeChoices("build")).toEqual([]);
    expect(modeChoices("build", "Codex")).toEqual([]);
  });

  it("says the mode is fixed, so the chip presses nothing", () => {
    expect(modeFixed("OpenCode")).toBe(true);
    expect(modeFixed("Claude")).toBe(false);
    expect(modeFixed()).toBe(false);
  });
});

describe(`${BRAND.display} Mobile OpenCode model picker`, () => {
  const picker = lines(
    "  Select model 25                                                          esc",
    "",
    "  Search",
    "",
    "  OpenCode Zen",
    "  Big Pickle                                                              Free",
    "  Muse Spark 1.3 Free                                                     Free",
  );

  it("reads the rows of OpenCode's own picker", () => {
    const read = readOpenCodePicker(picker);
    expect(read?.title).toBe("Select model");
    expect(read?.options.map((option) => option.label))
      .toEqual(["OpenCode Zen", "Big Pickle", "Muse Spark 1.3 Free"]);
    expect(read?.options[1].description).toBe("Free");
    // Mini draws its highlight in colour alone, which is not read: no row is
    // reported as the session's current one.
    expect(read?.current).toBe(-1);
  });

  it("keeps a provider group that the blank row under the list opens", () => {
    // Mini's list is one block per provider, blank-separated like the full
    // TUI's. Ending the list at the first blank stopped it at the first group.
    const read = readOpenCodePicker(lines(
      "  Select model 25                                                          esc",
      "",
      "  Search",
      "",
      "  OpenCode Zen",
      "  Big Pickle                                                              Free",
      "",
      "  GitHub Copilot",
      "  Grok 4.6",
    ));
    expect(read?.options.map((option) => option.label))
      .toEqual(["OpenCode Zen", "Big Pickle", "GitHub Copilot", "Grok 4.6"]);
  });

  /** The same overlay as the *full* TUI draws it — the interface an `opencode`
   * tab runs unless it was started `--mini`. From a capture of 1.18.31 on a
   * 215-column pane, moved left to the dialog's own band (the rules are all
   * relative to the title's column): the dialog is centred rather than two
   * columns in, its highlight is a `●` two columns left of the labels, its
   * groups are blank-separated, its rows carry the provider in the label, and
   * it is painted over the composer box and the status bar — whose `┃`, whose
   * text and whose `ctrl+p commands` show up on either side of it. */
  const fullPicker = lines(
    "            Select model                         esc",
    "",
    "            Search",
    "",
    "            Recent",
    "          ● Muse Spark 1.3 Free OpenCode Zen    Free",
    "            MAI-Code-1.1-Flash GitHub Copilot",
    "",
    "            OpenCode Zen",
    "  Ask a   ┃ Ling 3.0 Flash Fin Free             Free",
    "  Build   ┃ Nemotron 3.5 Lightning Free         Free",
    "",
    "            GitHub Copilot                          ommands",
    "            Gemini 3.8 Flash",
    "",
    "            Connect provider ctrl+a  Favorite ctrl+f",
  );

  it("reads the full TUI's centred picker, its groups and its highlight", () => {
    const read = readOpenCodePicker(fullPicker);
    expect(read?.title).toBe("Select model");
    expect(read?.options.map((option) => option.label)).toEqual([
      "Recent",
      "Muse Spark 1.3 Free OpenCode Zen",
      "MAI-Code-1.1-Flash GitHub Copilot",
      "OpenCode Zen",
      "Ling 3.0 Flash Fin Free",
      "Nemotron 3.5 Lightning Free",
      "GitHub Copilot",
      "Gemini 3.8 Flash",
    ]);
    // The row the dialog is on, which mini never says.
    expect(read?.current).toBe(1);
    // What the screen behind the overlay left on either side is not the row's:
    // not the composer box's `┃ Build`, not the status bar's `commands`.
    expect(read?.options[4].description).toBe("Free");
    expect(read?.options[6].description).toBeUndefined();
  });

  it("stops at the picker's key hints rather than listing them", () => {
    expect(readOpenCodePicker(fullPicker)?.options.some((option) => /ctrl\+/u.test(option.label)))
      .toBe(false);
  });

  it("is not a picker when none is on screen", () => {
    expect(readOpenCodePicker(lines("The tests pass.", "", " BUILD"))).toBeNull();
  });

  it("answers by typing into the picker's search field", () => {
    expect(openCodePickKeys("Muse Spark 1.3 Free")).toEqual(["", "Muse Spark 1.3 Free", "\r"]);
    // A label the pane truncated is typed without its ellipsis: the picker
    // filters on a prefix, and the `…` itself matches nothing.
    expect(openCodePickKeys("Ling 3.0 Flash Fin…")).toEqual(["", "Ling 3.0 Flash Fin", "\r"]);
  });
});
