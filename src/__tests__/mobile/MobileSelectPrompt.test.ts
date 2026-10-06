import { describe, expect, it } from "vitest";
import { freeTextRow, freeTextWrites, mergeSelectRows, missingSelectRow, questionTabFocus, questionTabKeys, questionTabRowKeys, questionTabsSubmit, readQuestionTabs, readReviewStep, readSelectPrompt, sameSelectStep, selectKeys, selectMoveKeys, selectSignature, UNNUMBERED } from "../../../mobile-web/src/terminal/selectPrompt";
import { currentMode, modeChoices } from "../../../mobile-web/src/terminal/agentModes";
import { inputFrameStart, sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { BRAND } from "../../lib/brand";

const lines = (...texts: string[]) => texts.map((text) => ({ text }));
const ESC = String.fromCharCode(27);

describe(`${BRAND.display} Mobile select dialog`, () => {
  it("reads the rows of a model picker, with the highlighted one", () => {
    // The Claude Code shape, after readableScreen stripped the box frame.
    const prompt = readSelectPrompt(lines(
      "Select Model",
      "Switch between Claude models. Applies to this session.",
      "",
      "  1. Default (recommended)   Opus for up to 50% of usage, then Sonnet",
      "❯ 2. Opus                    For complex tasks",
      "  3. Sonnet                  Most efficient for everyday tasks",
      "",
      "Esc to cancel",
    ));
    expect(prompt).toEqual({
      // The heading is read too: a dialog can be several steps, and it is the
      // only thing on screen that says which one.
      title: "Select Model",
      current: 1,
      // Where the rows start: what sits above them is the question they
      // answer, which a caller listing the rows itself still has to show.
      start: 3,
      // …and where that question starts. Here the heading and its blurb are
      // one block, so the question is both the dialog's own text and all the
      // context there is.
      question: 0,
      context: 0,
      options: [
        { index: 0, number: 1, label: "Default (recommended)", description: "Opus for up to 50% of usage, then Sonnet" },
        { index: 1, number: 2, label: "Opus", description: "For complex tasks" },
        { index: 2, number: 3, label: "Sonnet", description: "Most efficient for everyday tasks" },
      ],
    });
  });

  it("reads a picker whose rows carry no second column", () => {
    const prompt = readSelectPrompt(lines("› 1. gpt-5-codex", "  2. gpt-5"));
    expect(prompt?.current).toBe(0);
    expect(prompt?.options.map((option) => option.label)).toEqual(["gpt-5-codex", "gpt-5"]);
    expect(prompt?.options[0].description).toBeUndefined();
  });

  it("refuses a numbered list that is not a dialog", () => {
    // An agent answering with a numbered list is exactly what the removed
    // semantic parser used to turn into buttons. No highlight, no list.
    expect(readSelectPrompt(lines(
      "Here is the plan:",
      "1. Read the file",
      "2. Change the function",
      "3. Run the tests",
    ))).toBeNull();
  });

  it("refuses rows that are not one contiguous run", () => {
    expect(readSelectPrompt(lines("❯ 1. Opus", "", "  2. Sonnet"))).toBeNull();
    expect(readSelectPrompt(lines("❯ 1. Opus", "some output", "  2. Sonnet"))).toBeNull();
    expect(readSelectPrompt(lines("❯ 1. Opus"))).toBeNull();
  });

  it("refuses a run with more than one highlight", () => {
    expect(readSelectPrompt(lines("❯ 1. Opus", "❯ 2. Sonnet"))).toBeNull();
  });

  it("takes the live dialog when an earlier one is still on screen", () => {
    const prompt = readSelectPrompt(lines(
      "❯ 1. Opus",
      "  2. Sonnet",
      "output in between",
      "  1. Opus",
      "  2. Sonnet",
      "❯ 3. Haiku",
    ));
    expect(prompt?.current).toBe(2);
  });

  it("reads the heading a step drew, and the next step's over it", () => {
    // codex-cli 0.153.4: `/model` is two questions, and only the heading says
    // which one is on screen. Both are drawn in the same place.
    const models = readSelectPrompt(lines(
      "Select Model and Effort",
      "Access legacy models by running codex -m <model_name> or in your config.toml",
      "",
      "  1. gpt-6-astra (default)  Our most capable model for complex, demanding work.",
      "\u203a 2. gpt-5.6-sol (current)  Reliable agentic workhorse for everyday tasks.",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(models?.title).toBe("Select Model and Effort");
    const levels = readSelectPrompt(lines(
      "Select Reasoning Level for gpt-5.6-sol",
      "",
      "  1. Low (default)   Fast responses with lighter reasoning",
      "\u203a 2. High (current)  Greater reasoning depth for complex problems",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(levels?.title).toBe("Select Reasoning Level for gpt-5.6-sol");
    // Which is what tells a sheet that answered the first one that the second
    // is a new question and not the answered list, still painted.
    expect(selectSignature(models!)).not.toBe(selectSignature(levels!));
    // The highlight is not part of it: walking a list is not changing it.
    const walked = readSelectPrompt(lines(
      "Select Reasoning Level for gpt-5.6-sol",
      "",
      "\u203a 1. Low (default)   Fast responses with lighter reasoning",
      "  2. High (current)  Greater reasoning depth for complex problems",
      "",
    ));
    expect(selectSignature(walked!)).toBe(selectSignature(levels!));
  });

  it("collects a Codex model hidden above the visible rows without a hidden-row count", () => {
    // 0.159.3 offers GPT-6.1 Sol first. A short picker can begin at row 2
    // without the `… +N models` note used by Claude's windowed picker.
    const clipped = readSelectPrompt(lines(
      "Select Model and Effort",
      "",
      "  2. gpt-6-astra (current)  Frontier intelligence for the most demanding work.",
      "› 3. gpt-6-sol            Previous generation workhorse model.",
      "  4. gpt-6-luna           Fast and affordable model for easier tasks.",
    ), "Codex");
    expect(clipped?.options.map((option) => option.number)).toEqual([2, 3, 4]);
    const first = mergeSelectRows(null, clipped!);
    expect(missingSelectRow(first, clipped!)).toBe(1);
    expect(selectMoveKeys(clipped!.options[clipped!.current].number, 1)).toEqual([`${ESC}[A`, `${ESC}[A`]);

    const revealed = readSelectPrompt(lines(
      "Select Model and Effort",
      "",
      "› 1. gpt-6.1-sol (default)  Latest workhorse model for coding and everyday work.",
      "  2. gpt-6-astra (current)  Frontier intelligence for the most demanding work.",
      "  3. gpt-6-sol            Previous generation workhorse model.",
    ), "Codex");
    expect(mergeSelectRows(first, revealed!).options.map((option) => option.label)).toContain("gpt-6.1-sol (default)");
    expect(missingSelectRow(mergeSelectRows(first, revealed!), revealed!)).toBeUndefined();
    expect(readSelectPrompt(lines("2. Alpha", "› 3. Beta"), "Claude")).toBeNull();
  });

  it("keeps reading rows past a note wrapped at phone width", () => {
    // codex-cli 0.155.0 at 70 columns: sol's note fits, astra's wraps, and the
    // wrapped line used to end the list after the second row.
    const codex = readSelectPrompt(lines(
      "Select Model and Effort",
      "Access legacy models by running codex -m <model_name> or in your c",
      "",
      "  1. gpt-5.6-sol (default)  Latest frontier agentic coding model.",
      "\u203a 2. gpt-6-astra (current)  Our most capable model for complex,",
      "                            demanding work.",
      "  3. gpt-5.6-terra          Balanced agentic coding model for",
      "                            everyday work.",
      "  4. gpt-5.6-luna           Fast and affordable agentic coding",
      "                            model.",
      "  5. gpt-5.5                Proven previous-generation model for",
      "                            coding and general work.",
      "",
      "Press enter to confirm or esc to go back",
    ));
    expect(codex?.options.map((option) => option.label)).toEqual([
      "gpt-5.6-sol (default)",
      "gpt-6-astra (current)",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
    ]);
    expect(codex?.current).toBe(1);
    expect(codex?.title).toBe("Select Model and Effort");
    expect(codex?.options[1].description).toBe("Our most capable model for complex, demanding work.");
    // Claude Code 50 columns wide wraps every note, the same way.
    const claude = readSelectPrompt(lines(
      "   Select model",
      "   Switch between Claude models.",
      "",
      "     1. Default (recommended)  Opus 5 with 1M",
      "                               context",
      "   \u276f 2. Fable \u2714                Fable 5.1 · Most",
      "                               capable",
      "     3. Haiku                  Haiku 4.5 ·",
      "                               Fastest",
    ));
    expect(claude?.options).toHaveLength(3);
    expect(claude?.current).toBe(1);
    expect(claude?.options[2].description).toBe("Haiku 4.5 · Fastest");
  });

  it("ends the run at text shallower than the note's column", () => {
    const prompt = readSelectPrompt(lines(
      "  1. Opus    Big",
      "\u276f 2. Sonnet  Mid",
      "  some output",
      "  3. Haiku   Small",
    ));
    expect(prompt?.options).toHaveLength(2);
    expect(prompt?.options[1].description).toBe("Mid");
  });

  it("reads a question whose notes sit on the rows under each label", () => {
    // Claude Code 2.1.278's AskUserQuestion dialog (`compact-vertical`): the
    // note is its own row, indented to the label, wrapping at the same indent.
    const prompt = readSelectPrompt(lines(
      "←  ☐ Color  ☐ Size  ✔ Submit  →",
      "",
      "Which color should the banner use?",
      "",
      "❯ 1. Red",
      "     Warm and loud",
      "  2. Green",
      "     Calm, and it matches the logo we",
      "     already ship",
      "  3. Blue",
      "  4. Type something.",
      "",
      "  5. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ));
    expect(prompt?.title).toBe("Which color should the banner use?");
    expect(prompt?.current).toBe(0);
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Red", description: "Warm and loud" },
      { index: 1, number: 2, label: "Green", description: "Calm, and it matches the logo we already ship" },
      { index: 2, number: 3, label: "Blue", description: undefined },
      { index: 3, number: 4, label: "Type something.", description: undefined },
    ]);
    // The highlight walked down: the same dialog, read the same way.
    expect(readSelectPrompt(lines("  1. Red", "     Warm and loud", "❯ 2. Green", "     Calm"))?.current).toBe(1);
  });

  it("keeps a question's preview panel out of its rows", () => {
    // Claude Code 2.1.278's AskUserQuestion with previews, captured off a real
    // session at 215 columns and read back through `readableScreen`: the rows
    // stay on the left and the highlighted row's preview is drawn in a panel
    // beside them. What stands in the rows' second column is that panel's
    // frame, not a note — and the panel's own rows, which `readableScreen`
    // strips the left edge off, end the run.
    const prompt = readSelectPrompt(lines(
      " ☐ Status strip",
      "",
      "In fullscreen Claude, Focus also loses the swipe-in status strip. Restore it from the same frame?",
      "",
      "\u276f 1. Restore it too               \u250c\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510",
      "  2. Just the question            \u2502 swipe \u2192 on the reading view",
      "\u250c\u2500 Status line \u2500\u2500\u2500\u2500\u2500\u2715\u2510",
      `\u2502 ~/${BRAND.slug}/\u2026/project${BRAND.slug}       \u2502`,
      "",
      "Enter to select \u00b7 \u2191/\u2193 to navigate \u00b7 n to add notes \u00b7 Esc to cancel",
    ), "Claude Code");
    expect(prompt?.current).toBe(0);
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Restore it too", description: undefined },
      { index: 1, number: 2, label: "Just the question", description: undefined },
    ]);
  });

  it("offers a multi-select question's unnumbered Submit row", () => {
    // Claude Code 2.1.286's AskUserQuestion with `multiSelect`, captured off a
    // 46×30 pane through the phone's own attach and `readableScreen`. Enter on
    // a checkbox row only ticks it; the question is sent from `Submit`, a row
    // with no number that used to be read as the row above's note — so the
    // phone ticked boxes and the question stayed up as answered.
    const screen = (highlight: number) => {
      const marker = (row: number) => (row === highlight ? "❯" : " ");
      return lines(
        "←  ☒ Colours  ✔ Submit  →",
        "",
        "Which colours do you like?",
        "",
        `${marker(0)} 1. [✔] Red`,
        "         A warm, vibrant colour",
        `${marker(1)} 2. [ ] Green`,
        "         A cool, natural colour",
        `${marker(2)} 3. [ ] Blue`,
        `${marker(3)} 4. [ ] Type something`,
        `${marker(4)}    Submit`,
        `${marker(5)} 5. Chat about this`,
        "",
        "Enter to select · ↑/↓ to navigate · Esc to cancel",
      );
    };
    const prompt = readSelectPrompt(screen(0), "Claude Code");
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "[✔] Red", description: "A warm, vibrant colour" },
      { index: 1, number: 2, label: "[ ] Green", description: "A cool, natural colour" },
      { index: 2, number: 3, label: "[ ] Blue", description: undefined },
      { index: 3, number: 4, label: "[ ] Type something", description: undefined },
      { index: 4, number: UNNUMBERED, label: "Submit" },
      { index: 5, number: 5, label: "Chat about this", description: undefined },
    ]);
    // The highlight walks onto it in screen order, so a tap reaches it.
    expect(selectKeys(prompt!.current, 4)).toEqual(["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B", "\r"]);
    // Highlighted, it is still the dialog's row — not the input box's `❯`.
    const onSubmit = screen(4);
    expect(readSelectPrompt(onSubmit, "Claude Code")?.current).toBe(4);
    expect(inputFrameStart(onSubmit, "Claude Code")).toBe(onSubmit.length);
    // A question with more to come says `Next` there instead.
    const next = screen(4).map((line) => ({ text: line.text.replace("Submit", "Next") }));
    expect(readSelectPrompt(next, "Claude Code")?.options[4].label).toBe("Next");
    // Only under a checkbox row: an ordinary list's `Submit` line is not a row.
    expect(readSelectPrompt(lines("❯ 1. Red", "  2. Green", "   Submit"))?.options).toHaveLength(2);
  });

  it("keeps reading a Codex question whose label wraps beside its note", () => {
    // codex-rs request_user_input `long_option_text` snapshot, narrowed: the
    // label wraps at its own column while the note wraps at the note's.
    const prompt = readSelectPrompt(lines(
      "  Question 1/1 (1 unanswered)",
      "  Choose one option.",
      "",
      "  › 1. Job: running/completed/failed/    Keep async job statuses",
      "       expired (Recommended)             for progress tracking.",
      "    2. Add a short status model          Simpler labels.",
      "",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ));
    expect(prompt?.title).toBe("Question 1/1 (1 unanswered)");
    expect(prompt?.options).toEqual([
      { index: 0, number: 1, label: "Job: running/completed/failed/ expired (Recommended)", description: "Keep async job statuses for progress tracking." },
      { index: 1, number: 2, label: "Add a short status model", description: "Simpler labels." },
    ]);
  });

  it("bounds a Codex question to the dialog, not to the session above it", () => {
    // The real screen of a codex 0.155.1 tab that had not been prompted yet
    // (captured off the pane, replayed through xterm): its whole startup
    // banner sits above the question, and used to be shown as what the rows
    // answered. The question is the block right above them; the context stops
    // at the line that says why it is being asked.
    const prompt = readSelectPrompt(lines(
      ">_ OpenAI Codex (v0.155.1)",
      "model:     gpt-6-astra high   /model to change",
      `directory: ~/${BRAND.slug}/projects/project${BRAND.slug}`,
      "",
      "  Tip: New Use /fast to enable our fastest inference with increased plan usage.",
      "",
      "⚠ clamping SessionEnd hook timeout to 3s in /home/user/.codex/config.toml",
      "",
      "• Automatically switched to Luna Reserve high due to usage limits.",
      "",
      "  You’re now using Luna, a faster model for simpler tasks.",
      "  Add credits or upgrade to continue using the most advanced models, or wait for usage to reset after 15:55.",
      "",
      "› 1. Upgrade",
      "  2. Add Credits",
      "  3. Continue with Luna Reserve",
      "",
      "  Press enter to confirm or esc to continue working",
    ), "Codex");
    expect(prompt?.options.map((option) => option.label)).toEqual(["Upgrade", "Add Credits", "Continue with Luna Reserve"]);
    expect(prompt?.start).toBe(13);
    expect(prompt?.question).toBe(10);
    expect(prompt?.context).toBe(8);
  });

  it("keeps the block above a permission dialog's question — the file it asks about", () => {
    // Claude Code's edit prompt: what is being approved stands above a blank
    // line, so the question alone would not say what the answer applies to.
    const prompt = readSelectPrompt(lines(
      "I'll add the clear button.",
      "",
      "Edit file",
      "  src/lib/i18n.ts",
      "",
      "Do you want to make this edit to i18n.ts?",
      "❯ 1. Yes",
      "  2. No",
    ));
    expect(prompt?.start).toBe(6);
    expect(prompt?.question).toBe(5);
    expect(prompt?.context).toBe(2);
  });

  it("reads a Codex list too narrow for two columns, its notes stacked under the rows", () => {
    // codex-rs list_selection_view `narrow_width_preserves_rows` snapshot.
    const prompt = readSelectPrompt(lines(
      "  Debug",
      "",
      "› 1. Item 1",
      "             xxxxxxxxx",
      "             x",
      "  2. Item 2",
      "             xxxxxxxxx",
    ));
    expect(prompt?.options.map((option) => [option.label, option.description])).toEqual([
      ["Item 1", "xxxxxxxxx x"],
      ["Item 2", "xxxxxxxxx"],
    ]);
  });

  it("reads Gemini CLI's radio dot as the highlight, on a Gemini or Qwen tab only", () => {
    // gemini-cli 0.56 BaseSelectionList: the dot, the number, then the label
    // with its note (AskUser's description, a sublabel) on the row under it.
    const screen = lines(
      "Which color should the banner use?",
      "",
      "  1.  Red",
      "      Warm and loud",
      "● 2.  Green",
      "  3.  Enter a custom value",
    );
    for (const agent of ["Gemini", "Qwen Code"]) {
      const prompt = readSelectPrompt(screen, agent);
      expect(prompt?.current).toBe(1);
      expect(prompt?.options.map((option) => option.label)).toEqual(["Red", "Green", "Enter a custom value"]);
      expect(prompt?.options[0].description).toBe("Warm and loud");
    }
    // On Claude Code (Linux) and Kimi Code `●` opens an answer, and an answer
    // opening with a numbered list is no dialog.
    const answer = lines("● 1. Read the file", "  2. Change the function");
    expect(readSelectPrompt(answer, "Claude")).toBeNull();
    expect(readSelectPrompt(answer)).toBeNull();
    expect(readSelectPrompt(answer, "Gemini")?.current).toBe(0);
  });

  it("does not take text shallower than the label for its note", () => {
    const prompt = readSelectPrompt(lines("❯ 1. Red", "  2. Green", "    not a note", "  3. Blue"));
    expect(prompt?.options.map((option) => option.label)).toEqual(["Red", "Green"]);
    expect(prompt?.options[1].description).toBeUndefined();
  });

  it("does not take Claude's spinner above a mid-turn picker for its heading", () => {
    // `/model` opened while a turn runs is drawn right under the spinner, with
    // no blank between them — and the spinner's verb and timer change every
    // tick, so as the heading every repaint read as a new step.
    const read = (spinner: string) => readSelectPrompt(lines(
      "Some answer text.",
      "",
      spinner,
      "Select model",
      "Switch between Claude models.",
      "",
      "  1. Default (recommended)   Opus",
      "❯ 2. Sonnet                  Everyday tasks",
    ));
    const first = read("✻ Wiggling… (12s · ↓ 2.1k tokens)");
    const later = read("✶ Whirring… (13s · ↓ 2.2k tokens)");
    expect(first?.title).toBe("Select model");
    expect(first?.question).toBe(3);
    // Nothing above the spinner is the dialog's.
    expect(first?.context).toBe(3);
    expect(selectSignature(first!)).toBe(selectSignature(later!));
  });

  it("leaves a dialog untitled rather than titling it with the output above it", () => {
    const prompt = readSelectPrompt(lines(
      "I read the three files and they agree on the shape of the fix,",
      "which is to move the guard up into the caller so the two paths",
      "cannot disagree about it, and then delete the second check.",
      "Which one should I write first?",
      "",
      "\u276f 1. The caller",
      "  2. The callee",
    ));
    expect(prompt?.options).toHaveLength(2);
    expect(prompt?.title).toBeUndefined();
  });

  it("titles a permission prompt whose question sits under a dropped rule", () => {
    // Claude Code 2.1.286, after readableScreen dropped its dashed `╌` rules:
    // no blank separates the question from the command above it any more.
    const prompt = readSelectPrompt([
      { text: " Bash command" },
      { text: " Write Unix timestamp to a.txt" },
      { text: " date +%s > a.txt", afterRule: true },
      { text: " Do you want to proceed?", afterRule: true },
      { text: " \u276f 1. Yes" },
      { text: "   2. No" },
    ]);
    expect(prompt?.options).toHaveLength(2);
    expect(prompt?.title).toBe("Do you want to proceed?");
  });

  // Claude Code 2.1.286 asking to overwrite a plan file in a 60-column pane:
  // the diff runs right up to the dashed rule over the question, and option 2
  // wraps at the pane's edge onto its label's column.
  const OVERWRITE = [
    { text: "  14 +- Preserve original PDF integrity or export cleanly" },
    { text: "  15 +- Fast, responsive interaction even with large docume" },
    { text: "     +nts" },
    { text: "  16 +- Clear visual feedback for all markup actions" },
    { text: " Do you want to overwrite plan.md?", afterRule: true },
    { text: " ❯ 1. Yes" },
    { text: "   2. Yes, and switch to accept edits (auto-approve file" },
    { text: "      edits and common file commands) for this session" },
    { text: "      (shift+tab)" },
    { text: "   3. No" },
  ];

  it("ends a permission prompt's question at the rule over it, leaving the diff as context", () => {
    const prompt = readSelectPrompt(OVERWRITE, "Claude Code", 60);
    expect(prompt?.title).toBe("Do you want to overwrite plan.md?");
    expect(prompt?.question).toBe(4);
    expect(prompt?.context).toBe(0);
  });

  it("keeps a long command's whole permission dialog above its rows", () => {
    // Claude Code 2.1.287's dangerous-rm prompt in auto mode, after
    // readableScreen dropped its rules: tool, description, the command
    // fenced in dashed rules, why it asks and the auto-deny countdown, one
    // block. Capped at ten lines, the phone showed the command's tail under
    // no heading.
    const command: { text: string; afterRule?: boolean }[] = Array.from({ length: 12 }, (_, line) => ({ text: ` diff -U0 $S/cum${line}/a.ts $S/cum${line + 1}/a.ts | grep '^[-+]' |` }));
    command[0] = { ...command[0], afterRule: true };
    const screen = [
      { text: "⏺ Building the nine snapshots." },
      { text: "" },
      { text: " Bash command", afterRule: true },
      { text: " Count each commit's changed lines per file" },
      ...command,
      { text: " Dangerous rm operation on possibly-empty variable path: $B/$f in `rm -f $B/$f`", afterRule: true },
      { text: " ⚠ Claude Code will automatically deny this request in 1:23, to avoid blocking progress on an unattended session" },
      { text: "" },
      { text: " Do you want to proceed?" },
      { text: " ❯ 1. Yes" },
      { text: "   2. No" },
    ];
    const prompt = readSelectPrompt(screen, "Claude Code");
    expect(prompt?.title).toBe("Do you want to proceed?");
    expect(prompt?.question).toBe(screen.length - 3);
    expect(screen[prompt?.context ?? -1].text).toBe(" Bash command");
  });

  it("still bounds a block of plain output above a question", () => {
    const output = Array.from({ length: 15 }, (_, line) => ({ text: `output ${line}` }));
    const prompt = readSelectPrompt([...output, { text: "" }, { text: "Pick one?" }, { text: "❯ 1. A" }, { text: "  2. B" }]);
    expect(prompt?.context).toBe(6);
  });

  it("rejoins a row's label wrapped at the pane's edge instead of reading it as a note", () => {
    const prompt = readSelectPrompt(OVERWRITE, "Claude Code", 60);
    expect(prompt?.options.map((option) => [option.label, option.description])).toEqual([
      ["Yes", undefined],
      ["Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)", undefined],
      ["No", undefined],
    ]);
    // A short label's note under it stays a note at any width.
    const question = readSelectPrompt(lines("❯ 1. Red", "     Warm and loud", "  2. Green"), "Claude Code", 60);
    expect(question?.options[0]).toMatchObject({ label: "Red", description: "Warm and loud" });
  });

  it("knows Claude's free-text row and types into it", () => {
    const single = readSelectPrompt(lines(
      "Which database?",
      "",
      "❯ 1. PostgreSQL",
      "     Relational",
      "  2. SQLite",
      "  3. Type something.",
      "  4. Chat about this",
    ), "Claude Code");
    const other = single!.options[2];
    expect(freeTextRow(other)).toBe(true);
    expect(single!.options.filter(freeTextRow)).toHaveLength(1);
    // Walk onto the field, type the words as one line, Enter.
    expect(freeTextWrites(single!.current, other, " use\n DuckDB ")).toEqual([`${ESC}[B`, `${ESC}[B`, "use DuckDB", "\r"]);
    expect(freeTextWrites(single!.current, other, "   ")).toEqual([]);

    // On a multi-select question typing ticks the box; Enter would untick it.
    const multi = readSelectPrompt(lines(
      "Pick some",
      "",
      "❯ 1. [ ] Red",
      "  2. [ ] Green",
      "  3. [ ] Type something",
      "     Submit",
    ), "Claude Code");
    const box = multi!.options[2];
    expect(freeTextRow(box)).toBe(true);
    expect(freeTextWrites(multi!.current, box, "Blue")).toEqual([`${ESC}[B`, `${ESC}[B`, "Blue"]);
    // A row that only mentions it is an ordinary choice.
    expect(freeTextRow({ index: 0, number: 1, label: "Type something else" })).toBe(false);
  });

  it("moves the highlight the way the arrow row does", () => {
    expect(selectKeys(1, 3)).toEqual([`${ESC}[B`, `${ESC}[B`, "\r"]);
    expect(selectKeys(2, 0)).toEqual([`${ESC}[A`, `${ESC}[A`, "\r"]);
    expect(selectKeys(1, 1)).toEqual(["\r"]);
  });

  // Claude Code 2.1.278's `/model` in an 80×24 pane — the size a phone attach
  // leaves it — draws three of its five rows and scrolls that window with the
  // highlight, marking the hidden side with ↑/↓ and counting under it.
  const WINDOW_TOP = lines(
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new",
    "   sessions. For other/previous model names, specify with --model.",
    "",
    "     1. Default (recommended)  Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "     2. Opus (1M context)      Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "   ❯ 3. Fable ✔                Fable 5.1 · Most capable for your hardest and",
    "                               longest-running tasks",
    "      … +2 models",
    "",
    "   ● High effort (default) ←/→ to adjust",
  );
  const WINDOW_MIDDLE = lines(
    "   Select model",
    "   Switch between Claude models. Your pick becomes the default for new",
    "   sessions. For other/previous model names, specify with --model.",
    "",
    "   ↑ 2. Opus (1M context)      Opus 5 with 1M context · Best for everyday,",
    "                               complex tasks",
    "   ❯ 3. Fable ✔                Fable 5.1 · Most capable for your hardest and",
    "                               longest-running tasks",
    "   ↓ 4. Sonnet                 Sonnet 5 · Efficient for routine tasks",
    "      … +2 models",
  );

  it("reads a windowed picker's slice and how many rows it hides", () => {
    const top = readSelectPrompt(WINDOW_TOP, "Claude");
    expect(top?.title).toBe("Select model");
    expect(top?.hidden).toBe(2);
    expect(top?.current).toBe(2);
    expect(top?.options.map((option) => option.label)).toEqual(["Default (recommended)", "Opus (1M context)", "Fable ✔"]);
    expect(top?.options[2].description).toBe("Fable 5.1 · Most capable for your hardest and longest-running tasks");

    // A slice from the middle: ↑/↓ mark the edges, never the highlight.
    const middle = readSelectPrompt(WINDOW_MIDDLE, "Claude");
    expect(middle?.hidden).toBe(2);
    expect(middle?.options.map((option) => option.number)).toEqual([2, 3, 4]);
    expect(middle?.current).toBe(1);
  });

  it("still refuses a run that starts past 1 without a window's marks", () => {
    expect(readSelectPrompt(lines("❯ 2. Opus", "  3. Sonnet"))).toBeNull();
  });

  it("adds a windowed picker's slices up to the whole list, and asks for what is missing", () => {
    const top = readSelectPrompt(WINDOW_TOP, "Claude")!;
    const middle = readSelectPrompt(WINDOW_MIDDLE, "Claude")!;
    let step = mergeSelectRows(null, top);
    expect(missingSelectRow(step, top)).toBe(4);
    step = mergeSelectRows(step, middle);
    expect(step.options.map((option) => `${option.index}:${option.number}`)).toEqual(["0:1", "1:2", "2:3", "3:4"]);
    expect(missingSelectRow(step, middle)).toBe(5);
    // Nothing new: the same object, so state holding it does not re-render.
    expect(mergeSelectRows(step, middle)).toBe(step);
    // A list that is not a slice of it (the next step) starts over.
    const next = readSelectPrompt(lines("Select effort", "", "❯ 1. Low", "  2. High"))!;
    expect(sameSelectStep(step, next)).toBe(false);
    expect(mergeSelectRows(step, next).options.map((option) => option.label)).toEqual(["Low", "High"]);
    // A picker that draws every row has nothing missing.
    expect(missingSelectRow(mergeSelectRows(null, next), next)).toBeUndefined();
  });

  it("moves the highlight without accepting it", () => {
    expect(selectMoveKeys(3, 5)).toEqual([`${ESC}[B`, `${ESC}[B`]);
    expect(selectMoveKeys(3, 1)).toEqual([`${ESC}[A`, `${ESC}[A`]);
  });
});

describe(`${BRAND.display} Mobile permission modes`, () => {
  it("offers the family of the mode the session is showing", () => {
    expect(modeChoices("plan").map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    expect(modeChoices("full access").map((choice) => choice.value))
      .toEqual(["working", "plan", "read only", "auto", "full access"]);
    expect(modeChoices("yolo").map((choice) => choice.value))
      .toEqual(["ask permissions", "plan", "auto-accept", "auto", "yolo"]);
  });

  it("offers nothing for a session whose mode no family claims", () => {
    expect(modeChoices(undefined)).toEqual([]);
    expect(modeChoices("something else")).toEqual([]);
    expect(modeChoices("something else", "Claude")).toEqual([]);
  });

  it("lets the agent label break a tie between families sharing a mode", () => {
    // "plan" is a mode of both Claude Code and Qwen Code; only the tab's
    // label says which session this is.
    expect(modeChoices("plan", "Qwen").map((choice) => choice.value))
      .toEqual(["ask permissions", "plan", "auto-accept", "auto", "yolo"]);
    expect(modeChoices("plan", "Claude 2").map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    // "auto" is Codex's without a label and Qwen's with one.
    expect(modeChoices("auto", "Qwen")[0].value).toBe("ask permissions");
    expect(modeChoices("auto")[0].value).toBe("working");
    // "plan" is Codex's too since 0.151 — the label is again the only tie-break,
    // and without it Claude Code's list wins by declaration order.
    expect(modeChoices("plan mode", "Codex").map((choice) => choice.value))
      .toEqual(["working", "plan", "read only", "auto", "full access"]);
  });

  it("never hands a labelled tab another family's list for a mode its own does not know", () => {
    // The label names the family; a mode it does not list earns no list,
    // rather than walking the session through another family's choices.
    expect(modeChoices("read only", "Qwen")).toEqual([]);
    expect(modeChoices("full access", "Claude")).toEqual([]);
  });

  it("gives Claude Code's auto mode to a Claude tab, and only to one", () => {
    // Claude Code draws "auto mode on" (read out of the 2.1.272 bundle). Bare
    // "auto" is Codex's and Qwen's word too, so only the label hands it to
    // Claude — unlabelled, the first family that always claimed it still wins.
    const claude = modeChoices("auto", "Claude");
    expect(claude.map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    expect(currentMode(claude, "auto", true)).toBe("auto");
    expect(modeChoices("auto")[0].value).toBe("working");
    expect(modeChoices("auto", "Qwen")[0].value).toBe("ask permissions");
  });

  it("reads a frame without mode text as a silent-mode family's default", () => {
    // Claude Code prints nothing while in default mode, so the label alone
    // earns the list — but only for a family that has a silent mode.
    const claude = modeChoices(undefined, "Claude");
    expect(claude.map((choice) => choice.value))
      .toEqual(["default", "accept edits", "plan", "auto", "bypass permissions"]);
    expect(currentMode(claude, undefined, true)).toBe("default");
    // With no input frame on screen, absence of text says nothing.
    expect(currentMode(claude, undefined, false)).toBeUndefined();
    // Codex draws no mode line while it is working (verified against
    // codex-cli 0.151.0), so a framed Codex tab with no mode text reads the
    // same way a Claude one does.
    const codex = modeChoices(undefined, "Codex");
    expect(codex.map((choice) => choice.value)).toEqual(["working", "plan", "read only", "auto", "full access"]);
    expect(currentMode(codex, undefined, true)).toBe("working");
    // Qwen draws one for every mode; no text means no readout.
    expect(modeChoices(undefined, "Qwen")).toEqual([]);
  });

  it("maps an alias onto the mode it lists", () => {
    const claude = modeChoices("auto-accept");
    expect(currentMode(claude, "auto-accept")).toBe("accept edits");
    expect(currentMode(claude, "plan")).toBe("plan");
    expect(currentMode(claude, "read only")).toBeUndefined();
    const qwen = modeChoices("yolo");
    expect(currentMode(qwen, "accept edits")).toBe("auto-accept");
  });

  it("reads Codex's bare auto mode without claiming Claude's auto-compact", () => {
    expect(sessionStatus(lines("> ", "auto"))?.mode).toBe("auto");
    expect(sessionStatus(lines("> ", "~/projects/auto  ·  auto-compact left: 12%"))?.mode).toBeUndefined();
  });
});

describe(`${BRAND.display} Mobile input frame`, () => {
  const cut = (...texts: string[]) => {
    const rows = lines(...texts);
    return rows.slice(0, inputFrameStart(rows)).map((row) => row.text);
  };

  it("cuts the input box, its rule and the status lines under it", () => {
    // The bottom of a live Claude Code screen, as readableScreen renders it:
    // the box's side edges are already stripped, its labelled top rule is not.
    expect(cut(
      "● Done — the reading view now stops above the box.",
      "",
      `${"\u2500".repeat(40)} Project${BRAND.display} \u2500`,
      "\u276f",
      `  ~/${BRAND.slug}/projects/project${BRAND.slug} (develop) \u00b7 Opus 5 \u00b7 ctx 93%`,
      "  \u23f5\u23f5 auto mode on (shift+tab to cycle)",
    )).toEqual(["● Done — the reading view now stops above the box."]);
  });

  it("keeps a dialog the session is waiting on", () => {
    // `\u276f 1. Yes` opens with the input line's own marker. Cutting there
    // would hide the question and leave the reader tapping at nothing.
    const dialog = [
      "Do you want to proceed?",
      "\u276f 1. Yes",
      "  2. No, and tell Claude what to do differently",
    ];
    expect(cut(...dialog)).toEqual(dialog);
  });

  it("keeps a screen that is not showing an input frame at all", () => {
    const output = ["$ npm test", " \u2713 MobileReadableScreen.test.ts (11 tests)", ""];
    expect(cut(...output)).toEqual(output);
    // A prompt further up than the frame window is scrolled-past output.
    expect(cut("\u276f ", "a", "b", "c", "d", "e", "f", "g", "h", "i").length).toBe(10);
  });
});

describe(`${BRAND.display} Mobile question tabs`, () => {
  it("reads the header row Claude Code draws over an agent's question", () => {
    expect(readQuestionTabs("☐ Push scope")).toEqual([{ label: "Push scope", answered: false }]);
    // Several questions: answered ones are ticked, and Submit is navigation.
    expect(readQuestionTabs("←  ☒ Scope  ☐ Release tag  ✔ Submit  →")).toEqual([
      { label: "Scope", answered: true },
      { label: "Release tag", answered: false },
    ]);
  });

  it("is not fooled by a sentence", () => {
    expect(readQuestionTabs("✔ Done")).toBeNull();
    expect(readQuestionTabs("Push scope")).toBeNull();
    expect(readQuestionTabs("● ☐ is how the box looks")).toBeNull();
  });

  it("tells which step the dialog is on from the chip painted on a background", () => {
    const tabs = readQuestionTabs("←  ☒ Scope  ☐ Release tag  ✔ Submit  →")!;
    const row = (painted: string) => ["←  ", "☒ Scope", "  ", "☐ Release tag", "  ", "✔ Submit", "  →"].map((text) =>
      text === painted ? { text: ` ${text} `, background: "#b1b9f9" } : { text });
    expect(questionTabFocus(row("☒ Scope"), tabs)).toBe(0);
    expect(questionTabFocus(row("☐ Release tag"), tabs)).toBe(1);
    expect(questionTabFocus(row("✔ Submit"), tabs)).toBe(2);
    // Nothing painted, or a chip that is not one of the steps: unknown.
    expect(questionTabFocus(row(""), tabs)).toBeNull();
    expect(questionTabFocus([{ text: "← " }, { text: "☐ Other", background: "#fff" }], tabs)).toBeNull();
    // Painted by its colour alone, the dimmed arrow at an end aside.
    expect(questionTabFocus([{ text: "← ", color: "#888" }, { text: "☒ Scope  " }, { text: "☐ Release tag", color: "#b1b9f9" }, { text: "  ✔ Submit  →" }], tabs)).toBe(1);
    expect(questionTabsSubmit("←  ☒ Scope  ☐ Release tag  ✔ Submit  →")).toBe(true);
    expect(questionTabsSubmit("☐ Push scope")).toBe(false);
  });

  it("reads Gemini CLI's tab row, its current step underlined, walked with Tab", () => {
    const text = "← □ Scope │ ✓ Release tag │ ≡ Review →";
    const tabs = readQuestionTabs(text)!;
    expect(tabs).toEqual([{ label: "Scope", answered: false }, { label: "Release tag", answered: true }]);
    expect(questionTabsSubmit(text)).toBe(true);
    expect(questionTabRowKeys(text)).toBe("tabs");
    expect(questionTabRowKeys("←  ☒ Scope  ☐ Release tag  ✔ Submit  →")).toBe("arrows");
    // TabHeader: every icon and header in a colour, the current header bold
    // and underlined.
    const row = [
      { text: "← ", color: "#888" }, { text: "□ ", color: "#888" }, { text: "Scope", color: "#888" },
      { text: " │ ", color: "#888" }, { text: "✓ ", color: "#888" }, { text: "Release tag", color: "#6c6", className: "b u" },
      { text: " │ ", color: "#888" }, { text: "≡ ", color: "#888" }, { text: "Review", color: "#888" }, { text: " →", color: "#888" },
    ];
    expect(questionTabFocus(row, tabs)).toBe(1);
    expect(questionTabFocus(row.map((span) => (span.text === "Review" ? { ...span, className: "b u" } : { ...span, className: undefined })), tabs)).toBe(2);
    expect(questionTabKeys(0, 2, "tabs")).toEqual(["\t", "\t"]);
    expect(questionTabKeys(2, 1, "tabs")).toEqual([`${ESC}[Z`]);
    // Without its Review step it is a sentence with boxes in it.
    expect(readQuestionTabs("□ Scope │ ✓ Tag")).toBeNull();
  });

  it("reads Gemini CLI's Review page as one Submit row under its tab row", () => {
    const screen = lines(
      "> plan the release",
      "",
      "← ✓ Scope │ ✓ Release tag │ ≡ Review →",
      "",
      "Review your answers:",
      "",
      "Scope → Fix only",
      "Release tag → v0.2.0",
      "Enter to submit · Tab/Shift+Tab to edit answers · Esc to cancel",
    );
    for (const agent of ["Gemini", "Qwen Code"]) {
      const review = readReviewStep(screen, agent);
      expect(review?.options).toEqual([{ index: 0, number: 1, label: "Submit" }]);
      expect(review?.current).toBe(0);
      expect(screen[review!.question].text).toMatch(/≡ Review/);
      expect(review?.start).toBe(8);
    }
    expect(readReviewStep(screen, "Claude")).toBeNull();
    expect(readReviewStep(lines("Review your answers:", "Scope → Fix only"), "Gemini")).toBeNull();
  });

  it("walks the tabs with the arrows Claude Code switches them with", () => {
    expect(questionTabKeys(2, 0)).toEqual([`${ESC}[D`, `${ESC}[D`]);
    expect(questionTabKeys(0, 1)).toEqual([`${ESC}[C`]);
    expect(questionTabKeys(1, 1)).toEqual([]);
  });
});
