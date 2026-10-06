import { describe, expect, it } from "vitest";
import { chatTurns, isLiveEcho, isPromptEcho } from "../../../mobile-web/src/terminal/chatTurns";
import { questionParts } from "../../../mobile-web/src/terminal/questionParts";
import type { ReadableLine } from "../../../mobile-web/src/terminal/readableScreen";
import { readSelectPrompt } from "../../../mobile-web/src/terminal/selectPrompt";
import { BRAND } from "../../lib/brand";

let seq = 0;
const line = (text: string, className?: string): ReadableLine => ({
  key: `l${seq += 1}`,
  text,
  spans: text ? [{ text, className, color: className ? "#777" : undefined }] : [],
});
const lines = (...texts: string[]) => texts.map((text) => line(text));

describe(`${BRAND.display} Mobile chat turns`, () => {
  it("puts the echoed prompt in a user turn and the answer in an agent turn", () => {
    const turns = chatTurns(lines(
      "> fix the failing test",
      "",
      "⏺ Reading the test first.",
      "  It fails on the second assertion.",
      "",
      "⏺ Done.",
    ));
    // Each ⏺ message is an answer of its own.
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["fix the failing test"]);
    // The blank row after the echo is the seam, not the answer's first line.
    expect(turns[1].lines.map((row) => row.text)).toEqual([
      "⏺ Reading the test first.",
      "  It fails on the second assertion.",
    ]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Reading the test first.", "It fails on the second assertion."]);
    expect(turns[2].lines.map((row) => row.text)).toEqual(["⏺ Done."]);
  });

  it("keeps the printed marker in the lines and strips it only from the bubble", () => {
    const echo = line("> run it", "d");
    const [turn] = chatTurns([echo]);
    expect(turn.lines[0]).toBe(echo);
    expect(turn.key).toBe(echo.key);
    expect(turn.prompt?.[0].spans).toEqual([{ text: "run it", className: "d", color: "#777" }]);
  });

  it("reads Codex's › and a Gemini box with padding as the same echo", () => {
    expect(chatTurns(lines("› explain this repo")).map((turn) => turn.role)).toEqual(["user"]);
    // Gemini frames the echo; readableScreen strips `│ ` and leaves the
    // padding space in front of the marker.
    const [turn] = chatTurns(lines(" > explain this repo", "   and its tests"));
    expect(turn.role).toBe("user");
    expect(turn.prompt?.map((row) => row.text)).toEqual(["explain this repo", " and its tests"]);
  });

  it("keeps a multi-line prompt together by its indent", () => {
    const turns = chatTurns(lines(
      "> first line of the prompt",
      "  second line",
      "  third line",
      "⏺ Sure.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual([
      "first line of the prompt",
      "second line",
      "third line",
    ]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Sure."]);
  });

  it("never reads a dialog row, a bare input marker or an indented quote as a prompt", () => {
    expect(isPromptEcho({ text: "❯ 1. Yes" })).toBe(false);
    expect(isPromptEcho({ text: "> 2) No, and tell Claude what to do differently" })).toBe(false);
    expect(isPromptEcho({ text: ">" })).toBe(false);
    expect(isPromptEcho({ text: "> " })).toBe(false);
    expect(isPromptEcho({ text: "  > a quoted sentence inside the answer" })).toBe(false);
    expect(isPromptEcho({ text: "-> arrow in prose" })).toBe(false);
    const turns = chatTurns(lines("❯ 1. Yes", "  2. No", "> ", "  > quoted"));
    expect(turns.map((turn) => turn.role)).toEqual(["agent"]);
  });

  it("never changes a message's bubble as the agent goes on: the next message is the next bubble", () => {
    // The rows keep their keys from frame to frame, as the screen's do.
    const head = lines("> fix the failing test", "", "⏺ Reading the test first.");
    const frame = (...more: string[]) => chatTurns([...head, ...lines(...more)]);
    const before = frame("", "✻ Thinking… (3s · esc to interrupt)");
    const after = frame(
      "",
      "⏺ Read(src/app.test.ts)",
      "  ⎿  Read 40 lines",
      "",
      "⏺ The assertion compares the wrong field.",
      "",
      "✻ Thinking… (9s · esc to interrupt)",
    );
    const first = (turns: ReturnType<typeof chatTurns>) => turns.find((turn) => turn.key === head[2].key);
    expect(first(before)?.answer?.map((row) => row.text)).toEqual(["Reading the test first."]);
    expect(first(after)?.answer?.map((row) => row.text)).toEqual(["Reading the test first."]);
    expect(after.filter((turn) => turn.answer).map((turn) => turn.answer?.map((row) => row.text))).toEqual([
      ["Reading the test first."],
      ["The assertion compares the wrong field."],
    ]);
  });

  it("drops the blank seam around a prompt but keeps paragraph breaks inside a turn", () => {
    const turns = chatTurns(lines(
      "⏺ First paragraph.",
      "",
      "  Still the first message.",
      "",
      "⏺ Second message.",
      "",
      "> next question",
      "",
      "",
      "⏺ Answer.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent", "agent", "user", "agent"]);
    expect(turns[0].lines.map((row) => row.text)).toEqual(["⏺ First paragraph.", "", "  Still the first message."]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Second message."]);
    expect(turns[3].lines.map((row) => row.text)).toEqual(["⏺ Answer."]);
  });

  it("answers no turns for no lines and one agent turn for plain output", () => {
    expect(chatTurns([])).toEqual([]);
    const turns = chatTurns(lines("$ npm test", "ok"));
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe("agent");
  });

  it("makes each ⏺ message its own answer, marker removed, and leaves Claude's tool calls out", () => {
    const turns = chatTurns(lines(
      "> add a clear button",
      "",
      "⏺ Looking at the composer first.",
      "",
      "⏺ Read(mobile-web/src/screens/Terminal.tsx)",
      "  ⎿  Read 1459 lines",
      "",
      "⏺ Update(mobile-web/src/screens/Terminal.tsx)",
      "  ⎿  Updated mobile-web/src/screens/Terminal.tsx with 3 additions and 1 removal",
      "       12    const draft = \"\";",
      "       13 +  const clear = () => setDraft(\"\");",
      "",
      "⏺ Bash(npm test)",
      "  ⎿  Tests: 12 passed",
      "     … +40 lines (ctrl+o to expand)",
      "",
      "⏺ Done: the ✕ empties the draft.",
      "  It sits beside the textarea.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    // The answer shows without its bullet and its indent; the lines keep both.
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Looking at the composer first."]);
    expect(turns[1].lines.map((row) => row.text)).toEqual(["⏺ Looking at the composer first."]);
    expect(turns[2].answer?.map((row) => row.text)).toEqual(["Done: the ✕ empties the draft.", "It sits beside the textarea."]);
    // The read, the edit and its diff, the command and its output: not laid out.
    const shown = turns.flatMap((turn) => (turn.answer ?? turn.prompt ?? turn.lines).map((row) => row.text)).join("\n");
    expect(shown).not.toContain("Update(");
    expect(shown).not.toContain("additions");
    expect(shown).not.toContain("Tests: 12 passed");
  });

  it("keeps a question the session is waiting on under a tool call, and prose that is not a call", () => {
    const turns = chatTurns(lines(
      "⏺ Bash(rm -rf dist)",
      "  ⎿  Running…",
      "",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "",
      "⏺ Fixed — the build (and lint) passes.",
      "⏺ Ready when you are.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent", "agent", "agent"]);
    expect(turns[0].lines.map((row) => row.text)).toEqual(["Do you want to proceed?", "❯ 1. Yes", "  2. No"]);
    expect(turns[0].answer).toBeUndefined();
    // A `(` later in the sentence is not a tool call: the name is followed by it directly.
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Fixed — the build (and lint) passes."]);
    expect(turns[2].answer?.map((row) => row.text)).toEqual(["Ready when you are."]);
  });

  it("leaves MCP tool calls out too, with or without an argument", () => {
    const turns = chatTurns(lines(
      "● context7 - resolve-library-id (MCP)(libraryName: \"react\")",
      "  ⎿  Available Libraries (top matches):",
      "     - Title: React",
      "",
      `⏺ mcp__github__list_issues (MCP)(repo: "${BRAND.slug}")`,
      "  ⎿  []",
      "",
      "● claude-in-chrome - tabs_context (MCP)",
      "  ⎿  1 tab open",
      "",
      "● The context7 server (MCP) had the docs.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["agent"]);
    // Prose that merely mentions MCP is not a call.
    expect(turns[0].answer?.map((row) => row.text)).toEqual(["The context7 server (MCP) had the docs."]);
  });

  it("reads the ● bullet Claude Code draws on Linux as its message bullet", () => {
    const turns = chatTurns(lines(
      "> why is this shown",
      "",
      "● Bash(git status)",
      "  ⎿  clean",
      "",
      "● The panel shared the rows.",
      "  It is cut off now.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["The panel shared the rows.", "It is cut off now."]);
  });

  it("keeps Gemini's radio dot on the dialog row instead of reading a message bullet", () => {
    const screen = () => lines(
      "✦ Which color?",
      "",
      "● 1.  Red",
      "  2.  Green",
    );
    const gemini = chatTurns(screen(), "Gemini");
    expect(gemini).toHaveLength(2);
    expect(gemini[0].answer?.map((row) => row.text)).toEqual(["Which color?"]);
    // The highlight stays on screen as printed: a plain turn, dot included.
    expect(gemini[1].answer).toBeUndefined();
    expect(gemini[1].lines.map((row) => row.text)).toEqual(["● 1.  Red", "  2.  Green"]);
    // On any other tab `●` is still a message bullet.
    expect(chatTurns(screen(), "Claude")[1].answer?.[0].text).toBe("1.  Red");
  });

  it("leaves another TUI's output as one plain agent turn", () => {
    const turns = chatTurns(lines("› explain", "", "• Sure, this repo is a phone app.", "  It has two screens."));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[1].answer).toBeUndefined();
    expect(turns[1].lines.map((row) => row.text)).toEqual(["• Sure, this repo is a phone app.", "  It has two screens."]);
  });

  it("never reads a select dialog's cursor row as somebody's prompt", () => {
    // `❯` is the highlight cursor `selectPrompt` reads, never an echo — and a
    // picker row carries no number to be excluded by.
    expect(isPromptEcho({ text: "❯ Opus 4.1" })).toBe(false);
    expect(isPromptEcho({ text: "❯ Resume this session" })).toBe(false);
    expect(chatTurns(lines("Select a model:", "❯ Opus 4.1", "  Sonnet 4.5")).map((turn) => turn.role)).toEqual(["agent"]);
  });

  it("cuts a live screen at Claude Code's painted `❯` echo, never at a picker's cursor", () => {
    const painted = (text: string): ReadableLine => ({ key: `l${seq += 1}`, text, spans: [{ text, background: "#5b6273" }] });
    expect(isLiveEcho(painted("❯ Add search to phone file viewer"))).toBe(true);
    expect(isLiveEcho(line("> fix the failing test"))).toBe(true);
    expect(isLiveEcho(line("❯ Opus 4.1"))).toBe(false);
    expect(isLiveEcho(painted("❯ 1. Yes"))).toBe(false);

    // The fullscreen frame an agent's question was drawn onto: the banner,
    // two prompts, the turn's work — the question's context was all of it.
    const screen = [
      line("▐▛███▜▌   Claude Code v2.1.288"),
      line("▝▜█████▛▘  Opus 5.5 with high effort · Claude Max"),
      line("  ▘▘ ▝▝    ~/projects/app"),
      painted("❯ /clear"),
      painted("❯ Add search to phone file viewer"),
      line("  Ran 4 shell commands"),
      line(""),
      line("←  ☐ Search  ✔ Submit  →"),
      line(""),
      line("Which search do you mean for the phone's files?"),
      line(""),
      line("❯ 1. Find files by name"),
      line("     A search box in the Files drawer."),
      line("  2. Filter this folder"),
      line("     Narrows only the folder you're in."),
      line("  3. Type something."),
      line(""),
      line("Enter to select · ↑/↓ to navigate · Esc to cancel"),
    ];
    let start = 0;
    screen.forEach((row, index) => { if (isLiveEcho(row, "Claude")) start = index + 1; });
    const tail = screen.slice(start);
    const question = readSelectPrompt(tail, "Claude");
    expect(question).not.toBeNull();
    const parts = questionParts(tail, question!);
    expect(parts.tabs.map((tab) => tab.label)).toEqual(["Search"]);
    expect(parts.ask.map((row) => row.text)).toEqual(["Which search do you mean for the phone's files?"]);
    expect(parts.context.map((row) => row.text.trim())).toEqual(["Ran 4 shell commands"]);
  });

  it("never reads the empty box's own placeholder as a prompt", () => {
    expect(isPromptEcho({ text: "> Try \"fix the failing test\"" })).toBe(false);
    expect(isPromptEcho({ text: "› Type your message or @path/to/file" })).toBe(false);
    // A prompt that merely opens with the word is still the user's.
    expect(isPromptEcho({ text: "> try the other branch" })).toBe(true);
  });

  it("leaves a box the TUI is still drawing out of the bubbles", () => {
    // A history chunk gets no `inputFrameStart` cut: a frame left behind in
    // the scrollback reaches the layout whole, draft and footer included.
    const turns = chatTurns(lines(
      "> add a clear button",
      "",
      "⏺ Done.",
      "",
      "> half-typed draft",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
      "  ? for shortcuts",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["add a clear button"]);
    // The answer's bubble holds the answer; the frame stays plain rows under it.
    expect(turns[1].answer?.map((row) => row.text)).toEqual(["Done."]);
    expect(turns[2].answer).toBeUndefined();
    const bubbles = turns.filter((turn) => turn.role === "user")
      .flatMap((turn) => (turn.prompt ?? []).map((row) => row.text)).join("\n");
    expect(bubbles).not.toContain("half-typed draft");
    expect(bubbles).not.toContain("accept edits on");
  });

  it("stops a bubble at the rows under it that no prompt's indent can mean", () => {
    const turns = chatTurns(lines(
      "> /model",
      "  ⎿  Set model to Opus 4.1 and saved as the default",
      "",
      "⏺ Switched.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["/model"]);
    // Codex's result gutter and an indented mode row are the TUI's too.
    const codex = chatTurns(lines("› run the tests", "  └ 12 passed, 0 failed", "  ⏸ plan mode"));
    expect(codex.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(codex[0].prompt?.map((row) => row.text)).toEqual(["run the tests"]);
  });

  it("reads ✨ as an echo only for the CLI that draws one", () => {
    expect(isPromptEcho({ text: "✨ refactor the parser" }, "Kimi Code")).toBe(true);
    expect(isPromptEcho({ text: "✨ refactor the parser" })).toBe(false);
    // The statusline row `MobileStatusLine` keeps verbatim is not a prompt.
    expect(isPromptEcho({ text: "✨ vibes: immaculate" }, "Claude")).toBe(false);
    expect(chatTurns(lines("✨ vibes: immaculate"), "Claude").map((turn) => turn.role)).toEqual(["agent"]);
  });

  // ── The false-negative direction: a bubble must also not LOSE the user's
  // words. Every case above pins a leak; these pin the mirror of it.

  it("keeps a pasted tree in the bubble instead of handing its rows to the agent", () => {
    const turns = chatTurns(lines(
      "> here is the tree, fix the layout:",
      "  ├── src",
      "  │   └── app.tsx",
      "  └── tests",
      "  that last folder is new",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual([
      "here is the tree, fix the layout:",
      "├── src",
      "│   └── app.tsx",
      "└── tests",
      "that last folder is new",
    ]);
    // Codex's own result gutter carries text, not more strokes, and still stops.
    const codex = chatTurns(lines("› run it", "  └ 12 passed"));
    expect(codex.map((turn) => turn.role)).toEqual(["user", "agent"]);
  });

  it("reads a prompt that merely opens with the placeholder's words", () => {
    expect(isPromptEcho({ text: '> try "npm ci" first' })).toBe(true);
    expect(isPromptEcho({ text: "> try \u201csmart quotes\u201d here" })).toBe(true);
    expect(isPromptEcho({ text: "> type your message into the box" })).toBe(true);
    // The placeholder itself, whole, is still not a prompt.
    expect(isPromptEcho({ text: '> Try "fix the failing test"' })).toBe(false);
    expect(isPromptEcho({ text: "› Type your message or @path/to/file" })).toBe(false);
  });

  it("keeps an unbulleted agent's answer about a key from swallowing the prompt", () => {
    // Claude is protected by its ⏺; Aider, Goose and a plain Qwen are not.
    const turns = chatTurns(lines(
      "> what does shift+tab do?",
      "",
      "Shift+Tab cycles the permission mode.",
    ));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["what does shift+tab do?"]);
    // A row that is only the hint is still the footer.
    expect(chatTurns(lines("> draft", "Shift+Tab to accept edits")).map((turn) => turn.role)).toEqual(["agent"]);
  });

  it("leaves a stale Gemini frame in the scrollback out of the bubbles", () => {
    // Gemini pins no key hint under its box — it pins the columned status row,
    // and its mode indicator sits above the box where the lookahead cannot see.
    const turns = chatTurns(lines(
      "✦ Done.",
      "> half-typed gemini draft",
      "~/proj  main  gemini-2.5-pro  25% used",
    ));
    expect(turns.some((turn) => turn.role === "user")).toBe(false);
    // One recognized field is a sentence, not a status row: a real prompt
    // answered by prose that names a model keeps its bubble.
    const answered = chatTurns(lines("> which model is this?", "", "You are talking to opus."));
    expect(answered.map((turn) => turn.role)).toEqual(["user", "agent"]);
  });

  it("reads a footer that carries the context beside its hint as the footer", () => {
    // Claude Code prints the hint with the context and cost next to it. Asking
    // for the hint to be the whole row left this draft — and the footer under
    // it — in the reader's own bubble, which is the leak this view is about.
    expect(chatTurns(lines(
      "> half-typed draft",
      "  ? for shortcuts · 85% context left",
    )).some((turn) => turn.role === "user")).toBe(false);
    expect(chatTurns(lines(
      "> half-typed draft",
      "  ? for shortcuts · 85% context left · $0.42",
    )).some((turn) => turn.role === "user")).toBe(false);
    // Codex pins its keys in columns instead.
    expect(chatTurns(lines(
      "› half-typed draft",
      "⏎ send   ⇧⏎ newline   ⌃C quit",
    )).some((turn) => turn.role === "user")).toBe(false);
  });

  it("keeps a prompt whose answer opens with a path the status line also names", () => {
    // `classify` reads a branch out of the same segment as the path before it,
    // so counting *fields* scored this sentence two and handed the prompt to
    // the agent. A status row is two or more columns, not two fields.
    const turns = chatTurns(lines("> where am I?", "", `~/${BRAND.slug}/projects/app (main)`));
    expect(turns.map((turn) => turn.role)).toEqual(["user", "agent"]);
    expect(turns[0].prompt?.map((row) => row.text)).toEqual(["where am I?"]);
    const ran = chatTurns(lines("> what did you run?", "", "Running /usr/bin/foo (again) now"));
    expect(ran.map((turn) => turn.role)).toEqual(["user", "agent"]);
  });
});
