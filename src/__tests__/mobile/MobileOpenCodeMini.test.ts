import { afterEach, describe, expect, it, vi } from "vitest";
import { chatTurns } from "../../../mobile-web/src/terminal/chatTurns";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { currentMode, modeChoices, modeFixed } from "../../../mobile-web/src/terminal/agentModes";
import { agentWorking } from "../../../mobile-web/src/terminal/agentBusy";
import {
  joinOpenCodeWraps,
  openCodeDialogCloseKeys,
  mergeOpenCodePage,
  openCodePickKeys,
  OpenCodePickerWalk,
  readOpenCodePicker,
  readOpenCodePickerPage,
  type OpenCodePickerPage,
  type OpenCodePickerRow,
} from "../../../mobile-web/src/terminal/openCodeMini";
import { readableScreen, type ReadableBufferLike, type ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { groupOpenCodeModels } from "../../../mobile-web/src/terminal/openCodeModelGroups";
import { modelPickKeys, readModelPicker, readOpenCodeModelPage } from "../../lib/agents/readerLive";
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
/** A group heading as OpenCode paints it: bold, on the dialog's own
 * background (here none, like the title's). */
const heading = (text: string): ReadableLine => {
  const indent = /^\s*/u.exec(text)![0];
  return { key: `l${seq += 1}`, text, spans: [{ text: indent }, { text: text.slice(indent.length), className: "b" }] };
};

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
  });

  it("reads the start screen's centred box above its own version footer", () => {
    // 2.1.3's start screen at 120×40 (tmux capture; 2.1.2 the same but its
    // version and placeholder), through `readableScreen`: the logo is dropped,
    // the `┃` 23 columns in is not. The composer row carries its colours.
    const pad = " ".repeat(23);
    const composer: ReadableLine = {
      key: `l${seq += 1}`,
      text: `${pad}┃  Build · Flint 40B Free OpenCode`,
      spans: [
        { text: `${pad}┃  ` },
        { text: "Build", color: "#5c9cf5" },
        { text: " · ", color: "#808080" },
        { text: "Flint 40B Free", color: "#eeeeee" },
        { text: " OpenCode", color: "#808080" },
      ],
    };
    const screen = [
      line(`${pad}┃  Ask anything… "What is the tech stack of this project?"`),
      composer,
      line(`${pad}/…/scratchpad/oc/proj  shift+tab agents  ctrl+p commands`),
      line(""),
      line(`${" ".repeat(113)}2.1.3`),
    ];
    expect(inputFrameStart(screen, "OpenCode")).toBe(0);
    expect(sessionStatus(screen, "OpenCode")).toEqual({ mode: "build", model: "Flint 40B Free" });
    // A version printed as output under no box is still not a frame.
    expect(inputFrameStart(lines("Bumped to", "", "2.1.3"), "OpenCode")).toBe(3);
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
  it("shows free models first, then model families and remaining providers without changing picks", () => {
    const options = [
      { label: "GPT-5.4", description: "OpenCode Zen", keys: ["gpt"] },
      { label: "Claude Sonnet 4.5", description: "Anthropic", keys: ["claude"] },
      { label: "Big Pickle", description: "OpenCode Zen · Free", keys: ["free"] },
      { label: "MAI-Code", description: "GitHub Copilot", keys: ["mai"] },
      { label: "Gemini 3.8 Flash", description: "Google", keys: ["gemini"] },
    ];
    const groups = groupOpenCodeModels(options);
    expect(groups.map((group) => group.key)).toEqual(["free", "claude", "openai", "gemini", "provider:GitHub Copilot"]);
    expect(groups.flatMap((group) => group.options)).toEqual([options[2], options[1], options[0], options[4], options[3]]);
    expect(groups[0].options[0]).toBe(options[2]);
  });

  const picker = [
    ...lines(
      "  Select model 25                                                          esc",
      "",
      "  Search",
      "",
    ),
    heading("  OpenCode Zen"),
    ...lines(
      "  Big Pickle                                                              Free",
      "  Muse Spark 1.3 Free                                                     Free",
    ),
  ];

  it("reads the rows of OpenCode's own picker", () => {
    const read = readOpenCodePicker(picker);
    expect(read?.title).toBe("Select model");
    // The heading is the provider of the rows under it, not a row to pick.
    expect(read?.options.map((option) => option.label)).toEqual(["Big Pickle", "Muse Spark 1.3 Free"]);
    expect(read?.options[0].description).toBe("OpenCode Zen · Free");
    // Mini draws its highlight in colour alone, which is not read: no row is
    // reported as the session's current one.
    expect(read?.current).toBe(-1);
  });

  it("answers a row with its name and its provider, which the search matches together", () => {
    // One name can stand under two providers; typed alone, Enter took the
    // first. A heading typed into the field picked its group's first model.
    const read = readOpenCodePicker(picker);
    expect(read?.options[0].keys).toEqual(["\u0015", "Big Pickle OpenCode Zen", "\r"]);
    expect(modelPickKeys(read!, read!.options[0], "OpenCode")).toEqual(["\u0015", "Big Pickle OpenCode Zen", "\r"]);
  });

  it("tells a heading at a frame's top from the highlighted row, which is bold too", () => {
    const read = readOpenCodePicker([
      ...lines("  Select model                                                 esc", "", "  Search", ""),
      { key: "active", text: "  Big Pickle                         Free", spans: [{ text: "  " }, { text: "Big Pickle                         Free", className: "b", background: "#fab283" }] },
      ...lines("  Muse Spark 1.3 Free                Free"),
    ]);
    expect(read?.options.map((option) => option.label)).toEqual(["Big Pickle", "Muse Spark 1.3 Free"]);
  });

  it("keeps a provider group that the blank row under the list opens", () => {
    // Mini's list is one block per provider, blank-separated like the full
    // TUI's. Ending the list at the first blank stopped it at the first group.
    const read = readOpenCodePicker([
      ...lines(
        "  Select model 25                                                          esc",
        "",
        "  Search",
        "",
      ),
      heading("  OpenCode Zen"),
      ...lines(
        "  Big Pickle                                                              Free",
        "",
        // The blank row above it is what says this is a heading.
        "  GitHub Copilot",
        "  Grok 4.6",
      ),
    ]);
    expect(read?.options.map((option) => option.label)).toEqual(["Big Pickle", "Grok 4.6"]);
    expect(read?.options.map((option) => option.description)).toEqual(["OpenCode Zen · Free", "GitHub Copilot"]);
  });

  /** The same overlay as the *full* TUI draws it — the interface an `opencode`
   * tab runs unless it was started `--mini`. From a capture of 1.18.31 on a
   * 215-column pane, moved left to the dialog's own band (the rules are all
   * relative to the title's column): the dialog is centred rather than two
   * columns in, its highlight is a `●` two columns left of the labels, its
   * groups are blank-separated, its rows carry the provider in the label, and
   * it is painted over the composer box and the status bar — whose `┃`, whose
   * text and whose `ctrl+p commands` show up on either side of it. */
  const fullPicker = [
    ...lines(
      "            Select model                         esc",
      "",
      "            Search",
      "",
    ),
    heading("            Recent"),
    ...lines(
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
    ),
  ];

  it("reads the full TUI's centred picker, its groups and its highlight", () => {
    const read = readOpenCodePicker(fullPicker);
    expect(read?.title).toBe("Select model");
    // A Recent row prints its provider after its name: split off wherever a
    // provider's heading names it.
    expect(read?.options.map((option) => option.label)).toEqual([
      "Muse Spark 1.3 Free",
      "MAI-Code-1.1-Flash",
      "Ling 3.0 Flash Fin Free",
      "Nemotron 3.5 Lightning Free",
      "Gemini 3.8 Flash",
    ]);
    // The row the dialog is on, which mini never says.
    expect(read?.current).toBe(0);
    // What the screen behind the overlay left on either side is not the row's:
    // not the composer box's `┃ Build`, not the status bar's `commands`.
    expect(read?.options.map((option) => option.description)).toEqual([
      "OpenCode Zen · Free",
      "GitHub Copilot",
      "OpenCode Zen · Free",
      "OpenCode Zen · Free",
      "GitHub Copilot",
    ]);
    // A Recent row is typed as printed; a group's row with its group's name.
    expect(read?.options[0].keys?.[1]).toBe("Muse Spark 1.3 Free OpenCode Zen");
    expect(read?.options[2].keys?.[1]).toBe("Ling 3.0 Flash Fin Free OpenCode Zen");
  });

  it("reads the picker over a conversation the dimmed screen still shows", () => {
    // In a session the full TUI dims rather than clears what is behind the
    // overlay, so the title row carries the transcript's words to its left
    // and the sidebar's to its right. Unread, the sheet gave up and left the
    // picker up in the session, where the next message landed in it.
    const read = readOpenCodePicker(lines(
      "  The dialog card   Select model                         esc     Context",
      "  is the right one",
      "  so I'll add it.   Search",
      "",
      "  > Recent        ● Muse Spark 1.3 Free OpenCode Zen    Free     12.3K tokens",
      "                    Big Pickle OpenCode Zen             Free",
      "",
      "                    Connect provider ctrl+a  Favorite ctrl+f",
    ));
    expect(read?.title).toBe("Select model");
    expect(read?.options.map((option) => option.label))
      .toEqual(["Muse Spark 1.3 Free OpenCode Zen", "Big Pickle OpenCode Zen"]);
    // The dialog ends at its `esc`: the sidebar beyond it is not a column of the row.
    expect(read?.options[0].description).toBe("Free");
    // The transcript's `>` far left of the labels is not the highlight.
    expect(read?.current).toBe(0);
  });

  it("reads the rows beside the composer box at the dialog's own column", () => {
    // The phone's narrow pane, as a capture showed it (2026-10-18): the full
    // TUI's composer box sits three columns in behind the dialog, so the rows
    // beside it start with its `┃`. `readableScreen` takes that edge off the
    // front of a row, and the picker read those rows five columns short:
    // `Recent` as `t`, `Muse Spark 1.3 Free…` as `Spark 1.3 Free…`.
    const rows = [
      "              Select model                          esc",
      "",
      "              Search",
      "",
      "   ┃  Ask     Recent",
      "   ┃        ● Muse Spark 1.3 Free OpenCode Zen     Free",
      "   ┃  Build   MiMo-V2.6-Flash Free OpenCode Zen    Free",
      "",
      "              OpenCode Zen",
      "              Ling 3.0 Flash Fin Free               Free",
      "",
      "              Connect provider ctrl+a  Favorite ctrl+f",
    ];
    const buffer: ReadableBufferLike = {
      length: rows.length,
      getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }),
    };
    const drawn = [
      "Recent",
      "Muse Spark 1.3 Free OpenCode Zen",
      "MiMo-V2.6-Flash Free OpenCode Zen",
      "OpenCode Zen",
      "Ling 3.0 Flash Fin Free",
    ];
    // The phone reads the screen through `readableScreen`, the desktop's
    // Chat view through `readOpenCodeModelPage`: both get the whole rows.
    const phone = readOpenCodePickerPage(readableScreen(buffer).lines);
    expect(phone?.rows.map((row) => row.text)).toEqual(drawn);
    expect(phone?.rows[1]).toMatchObject({ marked: true, tag: "Free" });
    expect(readOpenCodeModelPage(buffer)?.rows.map((row) => row.text)).toEqual(drawn);
    // Unstyled, the top heading has nothing to tell it by; `OpenCode Zen` has
    // the blank row above it, and the rows above it carry its name.
    expect(readModelPicker(buffer, "OpenCode")?.options.map((option) => option.label))
      .toEqual(["Recent", "Muse Spark 1.3 Free", "MiMo-V2.6-Flash Free", "Ling 3.0 Flash Fin Free"]);
  });

  it("is no picker for a conversation that only mentions one", () => {
    expect(readOpenCodePicker(lines("  I opened   Select model to check", "", "  Search", "  Big Pickle"))).toBeNull();
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

describe(`${BRAND.display} Mobile OpenCode dialogs over the composer`, () => {
  it("closes any dialog it has up before a message goes in", () => {
    // The model picker, and the provider list its Ctrl+A opens — the one the
    // composer's own line reset reached when a "yes" was typed into the picker.
    expect(openCodeDialogCloseKeys(["            Select model                         esc"])).toEqual(["\u001b"]);
    expect(openCodeDialogCloseKeys([
      "  The dialog card   Connect a provider                   esc     Context",
      "                    Search",
    ])).toEqual(["\u001b"]);
    // Painted over the composer box, whose `┃` stands right of the `esc`.
    expect(openCodeDialogCloseKeys(["  ┃         Rename session                   esc       ┃"])).toEqual(["\u001b"]);
    // Read lines as the phone's reading view hands them over work the same.
    expect(openCodeDialogCloseKeys(lines("            Select model 25                      esc"))).toEqual(["\u001b"]);
  });

  it("presses nothing without one: Escape is half an interrupt while it works", () => {
    expect(openCodeDialogCloseKeys([
      "  The tests pass.",
      " ⬝⬝■■■⬝⬝⬝ esc interrupt                 12.3K (5%)  ctrl+p commands",
    ])).toEqual([]);
    expect(openCodeDialogCloseKeys([" ~/projects/app                 esc exit shell mode"])).toEqual([]);
    expect(openCodeDialogCloseKeys(["  press esc to close it"])).toEqual([]);
    expect(openCodeDialogCloseKeys([])).toEqual([]);
  });
});

/**
 * OpenCode's model dialog as 1.18.31 scrolls it (`ui/dialog-select.tsx`): a
 * window `height` lines tall over the list, a blank line above every heading
 * but the first, the highlight starting on the session's model, ↓ moving it
 * one model on — from the last to the first — and the window centred on it.
 */
function openCodeDialog(groups: [string, string[]][], height: number, currentModel: string) {
  const layout: (OpenCodePickerRow | null)[] = [];
  groups.forEach(([name, models], index) => {
    if (index > 0) layout.push(null);
    layout.push({ text: name, heading: true, marked: false });
    for (const model of models) layout.push({ text: model, heading: false, marked: model === currentModel });
  });
  const models = layout.flatMap((row, at) => (row && !row.heading ? [at] : []));
  let selected = models.findIndex((at) => layout[at]?.text === currentModel);
  let top = 0;
  const centre = () => {
    top = Math.max(0, Math.min(layout.length - height, models[selected] - Math.floor(height / 2)));
  };
  centre();
  return {
    page: (): OpenCodePickerPage => ({
      title: "Select model",
      start: 0,
      rows: layout.slice(top, top + height).flatMap((row) => (row ? [row] : [])),
    }),
    press: (key: string) => {
      if (key !== "\u001b[B") throw new Error(`a walk only presses ↓, not ${JSON.stringify(key)}`);
      selected = (selected + 1) % models.length;
      centre();
    },
  };
}

describe(`${BRAND.display} Mobile OpenCode model picker walk`, () => {
  afterEach(() => vi.useRealTimers());

  const zen = Array.from({ length: 12 }, (_, index) => `Zen model ${index + 1}`);
  const copilot = Array.from({ length: 14 }, (_, index) => `Copilot model ${index + 1}`);
  const groups: [string, string[]][] = [
    ["Recent", ["Muse Spark 1.3 Free OpenCode Zen"]],
    ["OpenCode Zen", zen],
    ["GitHub Copilot", copilot],
    ["Anthropic", ["Claude Sonnet 4.5"]],
  ];
  const everyModel = ["Muse Spark 1.3 Free", ...zen, ...copilot, "Claude Sonnet 4.5"];

  /** Runs the walk to its end against `dialog`, as a caller does: every key
   * it types reaches the dialog, and every frame after one is read. */
  function walkThrough(dialog: ReturnType<typeof openCodeDialog>) {
    vi.useFakeTimers();
    const typed: string[] = [];
    const walk = new OpenCodePickerWalk((keys) => typed.push(...keys));
    let pressed = 0;
    walk.read(dialog.page());
    for (let turn = 0; turn < 1_000 && walk.walking(); turn += 1) {
      if (pressed < typed.length) {
        typed.slice(pressed).forEach((key) => dialog.press(key));
        pressed = typed.length;
        walk.read(dialog.page());
      } else {
        vi.advanceTimersByTime(600);
      }
    }
    return { walk, typed };
  }

  it("lists the whole list from a frame that opened in its middle", () => {
    // Nine lines of a 33-line list, opened on a Copilot model: the frame
    // shows neither the top of the list nor its end.
    const { walk } = walkThrough(openCodeDialog(groups, 9, "Copilot model 4"));
    expect(walk.walking()).toBe(false);
    const prompt = walk.prompt()!;
    expect(prompt.options.map((option) => option.label)).toEqual(everyModel);
    expect(prompt.hidden).toBeUndefined();
    expect(prompt.current).toBe(everyModel.indexOf("Copilot model 4"));
    expect(prompt.options[prompt.options.length - 1].description).toBe("Anthropic");
    expect(prompt.options[0].description).toBe("OpenCode Zen");
  });

  it("lists it from a frame at the top, and from one at the end", () => {
    for (const current of ["Zen model 1", "Claude Sonnet 4.5"]) {
      const { walk } = walkThrough(openCodeDialog(groups, 7, current));
      expect(walk.prompt()?.options.map((option) => option.label)).toEqual(everyModel);
    }
  });

  it("presses a few keys and stops when the list fits its frame", () => {
    const small: [string, string[]][] = [["OpenCode Zen", ["Big Pickle", "Muse Spark 1.3 Free"]]];
    const { walk, typed } = walkThrough(openCodeDialog(small, 20, "Big Pickle"));
    expect(walk.walking()).toBe(false);
    expect(typed.length).toBeLessThanOrEqual(3);
    expect(walk.prompt()?.options.map((option) => option.label)).toEqual(["Big Pickle", "Muse Spark 1.3 Free"]);
  });

  it("says the list is still being read while it is", () => {
    vi.useFakeTimers();
    const dialog = openCodeDialog(groups, 9, "Zen model 2");
    const walk = new OpenCodePickerWalk(() => {});
    walk.read(dialog.page());
    expect(walk.walking()).toBe(true);
    expect(walk.prompt()?.hidden).toBe(1);
  });

  it("types nothing more once a row is tapped, and nothing at all for no picker", () => {
    vi.useFakeTimers();
    const typed: string[] = [];
    const walk = new OpenCodePickerWalk((keys) => typed.push(...keys));
    walk.read(openCodeDialog(groups, 9, "Zen model 2").page());
    const sent = typed.length;
    walk.hold();
    vi.advanceTimersByTime(10_000);
    expect(typed.length).toBe(sent);
    walk.read(null);
    expect(walk.prompt()).toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(typed.length).toBe(sent);
  });

  it("starts over for the dialog's next step", () => {
    vi.useFakeTimers();
    const walk = new OpenCodePickerWalk(() => {});
    walk.read(openCodeDialog(groups, 9, "Zen model 2").page());
    walk.hold();
    walk.read({ title: "Select variant", start: 0, rows: [
      { text: "low", heading: false, marked: false },
      { text: "high", heading: false, marked: true },
    ] });
    expect(walk.walking()).toBe(true);
    expect(walk.prompt()?.options.map((option) => option.label)).toEqual(["low", "high"]);
  });

  it("puts a frame that wrapped to the top before the rows it opened on", () => {
    const row = (text: string): OpenCodePickerRow => ({ text, heading: false, marked: false });
    const opened = mergeOpenCodePage(null, ["c", "d", "e"].map(row));
    const end = mergeOpenCodePage(opened, ["d", "e", "f"].map(row));
    const wrapped = mergeOpenCodePage(end, ["a", "b"].map(row));
    expect(wrapped.done).toBe(false);
    const met = mergeOpenCodePage(wrapped, ["b", "c", "d"].map(row));
    expect(met.done).toBe(true);
    expect(met.main.map((entry) => entry.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});
