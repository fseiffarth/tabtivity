import { describe, expect, it } from "vitest";
import { answerKeys, answerTextKeys, readReaderLive, sameReaderLive, tabStepKeys } from "../../lib/agents/readerLive";
import type { ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";

function plainBuffer(rows: string[]): ReadableBufferLike {
  return { length: rows.length, getLine: (row) => (rows[row] === undefined ? undefined : { translateToString: () => rows[row] }) };
}

/** Claude Code's permission prompt, as the phone's Focus tests paint it. */
const PERMISSION = [
  "> fix the strings",
  "",
  "⏺ I'll update the file.",
  "",
  "Edit file",
  "  src/lib/i18n.ts",
  "",
  "Do you want to make this edit to i18n.ts?",
  "❯ 1. Yes",
  "  2. Yes, allow all edits during this session",
  "  3. No, and tell Claude what to do differently",
  "",
  "  esc to cancel",
];

/** An agent's own question (`AskUserQuestion`), as the phone's Focus tests
 * paint it: its message, the tab row naming the question, the question —
 * both wrapped by Claude Code itself at the pane's width — and the options. */
const AGENT_QUESTION = [
  "> push it",
  "",
  "● My fix is ready and verified, but pushing develop now would also push four",
  "  other commits. I need your call before pushing.",
  "",
  "☐ Push scope",
  "",
  "Four other-session commits sit unpushed on develop. How should I land my",
  "Windows/CodeQL fix?",
  "",
  "❯ 1. Fix only (Recommended)",
  "     Put my fix directly on the pushed main.",
  "  2. Push everything",
  "     Push develop with all four commits.",
  "  3. Type something.",
  "  4. Chat about this",
  "",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];

/** The same kind of question beside Claude Code 2.1.292's fullscreen diff
 * panel (`/diff`), as a 130-column pane drew it: a `│` at column 72 down every
 * row, the panel's file block beside the question and its first row. */
const pane = (left: string, right = "") => `${left.padEnd(72)}│${right}`;
const DIFF_PANEL_QUESTION = [
  pane("● Write(docs/local_drivers_pi_cline_plan.md)", "1 file changed                         source: Current"),
  pane("  ⎿  Wrote 1 line to docs/local_drivers_pi_cline_plan.md"),
  pane("      1 x", "docs/local_drivers_pi_cline_plan.md"),
  `${"─".repeat(72)}│`,
  pane(" ☐ Login sync", "─".repeat(57)),
  pane("", "docs/local_drivers_pi_cline_plan.md (untracked)"),
  pane("│ How should local-model agent homes (<scope>.local) take part in login", "─".repeat(57)),
  pane("│ syncing, so `ollama launch cline` can't push its Ollama setting into", "New file not yet staged."),
  pane("│ your normal Cline tabs?", "Run `git add :/docs/local_drivers_pi_cline_plan.md` to"),
  pane("", "see line counts."),
  pane("❯ 1. Receive-only, all CLIs (Recommended)"),
  pane("     Local-model homes still receive your logins, but nothing written", "+1 file edited before this session (show)"),
  pane("     there ever goes back to other tabs. Cline providers.json is also"),
  pane("     never overwritten there, so the Ollama setting stays put."),
  pane("  2. Skip only Cline"),
  pane("     Narrowest change: only Cline providers.json is skipped in"),
  pane("     local-model homes, in both directions. Every other CLI keeps"),
  pane("     syncing both ways, as it does today."),
  pane("  3. Type something."),
  `${"─".repeat(72)}│`,
  pane("  4. Chat about this"),
  pane(""),
  pane("Enter to select · ↑/↓ to navigate · Esc to cancel"),
];

/** Claude Code 2.1.295's folder-trust question, as a 60-column pane drew it
 * (captured, path replaced): unnumbered rows under a full-screen rule, the
 * folder broken mid-word, the footer where the input box would be. */
const TRUST_FOLDER = [
  "",
  "─".repeat(60),
  " Accessing workspace:",
  "",
  " /home/user/projects/a-rather-long-project-folder-name-that",
  " -wraps/src",
  "",
  " Quick safety check: Is this a project you created or one",
  " you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to",
  " review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files",
  " here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
  "",
  "",
];

describe("the desktop Reader's live screen", () => {
  it("reads a question beside the fullscreen diff panel without the panel", () => {
    const live = readReaderLive(plainBuffer(DIFF_PANEL_QUESTION), "Claude", 130);
    expect(live.tabs).toEqual([{ label: "Login sync", answered: false }]);
    expect(live.ask).toEqual([
      "How should local-model agent homes (<scope>.local) take part in login syncing, so `ollama launch cline` can't push its Ollama setting into your normal Cline tabs?",
    ]);
    expect(live.question?.options.slice(0, 2)).toMatchObject([
      {
        label: "Receive-only, all CLIs (Recommended)",
        description: "Local-model homes still receive your logins, but nothing written there ever goes back to other tabs. Cline providers.json is also never overwritten there, so the Ollama setting stays put.",
      },
      {
        label: "Skip only Cline",
        description: "Narrowest change: only Cline providers.json is skipped in local-model homes, in both directions. Every other CLI keeps syncing both ways, as it does today.",
      },
    ]);
  });

  it("cuts the diff panel off a question whose screen has rows without its divider", () => {
    // Rows printed before the pane opened sit above it (the phone's replayed
    // history), and a row caught mid-repaint lacks the bar: either one left
    // the whole panel glued into the question.
    const rows = [
      "● Earlier output that ran the whole width of the pane before the diff panel opened, long ago.",
      ...DIFF_PANEL_QUESTION.slice(0, 7),
      `${"│ syncing, so `ollama launch cline` can't push its Ollama setting into".padEnd(73)}New file not yet staged.`,
      ...DIFF_PANEL_QUESTION.slice(8),
    ];
    const live = readReaderLive(plainBuffer(rows), "Claude", 130);
    expect(live.ask).toEqual([
      "How should local-model agent homes (<scope>.local) take part in login syncing, so `ollama launch cline` can't push its Ollama setting into your normal Cline tabs?",
    ]);
    expect(live.question?.options[0]).toMatchObject({ label: "Receive-only, all CLIs (Recommended)" });
  });

  it("reads a permission prompt as its question, its context and its options", () => {
    const live = readReaderLive(plainBuffer(PERMISSION), "Claude");
    expect(live.question?.options.map((option) => option.label)).toEqual([
      "Yes",
      "Yes, allow all edits during this session",
      "No, and tell Claude what to do differently",
    ]);
    expect(live.ask.join("\n")).toMatch(/Do you want to make this edit/);
    expect(live.context.join("\n")).toMatch(/src\/lib\/i18n\.ts/);
    expect(live.working).toBeNull();
    expect(live.signature).not.toBe("");
  });

  it("reads an agent's own question: its header as a tab, its question as one paragraph", () => {
    const live = readReaderLive(plainBuffer(AGENT_QUESTION), "Claude");
    expect(live.tabs).toEqual([{ label: "Push scope", answered: false }]);
    expect(live.ask).toEqual([
      "Four other-session commits sit unpushed on develop. How should I land my Windows/CodeQL fix?",
    ]);
    // The agent's message is the conversation's last turn already; neither it
    // nor the tab row's checkbox is repeated as a screen dump.
    expect(live.context).toEqual([]);
    expect(live.question?.options[0]).toMatchObject({ label: "Fix only (Recommended)", description: "Put my fix directly on the pushed main." });
  });

  it("lifts the tab row of a question that asks several, answered ones ticked", () => {
    const live = readReaderLive(plainBuffer([
      "> tag it",
      "",
      "←  ☒ Scope  ☐ Release tag  ✔ Submit  →",
      "",
      "Which tag should the release get?",
      "",
      "❯ 1. v0.2.0",
      "  2. v0.1.100",
      "  3. Type something.",
      "",
      "  4. Chat about this",
      "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude");
    expect(live.tabs).toEqual([{ label: "Scope", answered: true }, { label: "Release tag", answered: false }]);
    expect(live.ask).toEqual(["Which tag should the release get?"]);
    expect(live.context).toEqual([]);
    const next = readReaderLive(plainBuffer([
      "> tag it", "", "←  ☒ Scope  ☒ Release tag  ✔ Submit  →", "", "Which tag should the release get?",
      "", "❯ 1. v0.2.0", "  2. v0.1.100",
    ]), "Claude");
    expect(sameReaderLive(live, next)).toBe(false);
    expect(live.tabSubmit).toBe(true);
    // A plain buffer paints no chip: the step on screen is unknown.
    expect(live.tabFocus).toBeNull();
  });

  it("tells two questions of one dialog apart when they offer the same rows", () => {
    const step = (tabRow: string, ask: string) => readReaderLive(plainBuffer([
      "> ask me", "", tabRow, "", ask, "", "❯ 1. Yes", "  2. No", "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude");
    const first = step("←  ☐ Tests  ☐ Docs  ✔ Submit  →", "Run the tests?");
    const second = step("←  ☒ Tests  ☐ Docs  ✔ Submit  →", "Update the docs?");
    expect(first.signature).not.toBe(second.signature);
  });

  it("reads Codex's several questions off its heading, with no Submit step", () => {
    const live = readReaderLive(plainBuffer([
      "› plan it", "",
      "  Question 2/3 (2 unanswered)",
      "  Which store should the cache use?",
      "",
      "  › 1. Redis (Recommended)    Shared across workers.",
      "    2. In-process LRU         Simplest.",
      "",
      "  tab to add notes | enter to submit answer | ←/→ to navigate questions | esc to interrupt",
    ]), "Codex");
    expect(live.question).not.toBeNull();
    expect(live.tabs.map((tab) => tab.label)).toEqual(["Q1", "Q2", "Q3"]);
    expect(live.tabFocus).toBe(1);
    expect(live.tabSubmit).toBe(false);
    expect(live.tabKeys).toBe("pages");
  });

  it("keeps Gemini's Review page as a card that submits with Enter and walks back with Shift+Tab", () => {
    const live = readReaderLive(plainBuffer([
      "> plan the release", "",
      "← ✓ Scope │ □ Release tag │ ≡ Review →", "",
      "Review your answers:", "",
      "⚠ You have 1 unanswered question", "",
      "Scope → Fix only",
      "Release tag → (not answered)",
      "Enter to submit · Tab/Shift+Tab to edit answers · Esc to cancel",
    ]), "Gemini");
    const question = live.question!;
    expect(question.options.map((option) => option.label)).toEqual(["Submit"]);
    expect(answerKeys(question, question.options[0])).toEqual(["\r"]);
    expect(live.tabs).toEqual([{ label: "Scope", answered: true }, { label: "Release tag", answered: false }]);
    expect(live.tabSubmit).toBe(true);
    expect(live.tabKeys).toBe("tabs");
    expect(live.ask).toEqual(["Review your answers:", "", "⚠ You have 1 unanswered question", "", "Scope → Fix only", "Release tag → (not answered)"]);
    expect(tabStepKeys(live, 2, 1)).toEqual(["\u001b[Z"]);
  });

  // Captured live from Codex 0.163.0 at 100 columns: a fresh folder with five
  // untrusted hooks asks the folder question, then the hooks menu, in place.
  const CODEX_FOLDER = [
    "",
    "  Folder access",
    "  /home/u/projects/new",
    "",
    "  Trust this folder? Codex can read, edit, and run files here, subject to your permission",
    "  settings. Folder settings can run code automatically, even without a model request. Continue",
    "  only if you trust these files. Your trust decision will be saved.",
    "",
    "› 1. Trust and continue",
    "  2. Quit",
    "",
    "  enter continue · esc quit",
  ];
  const CODEX_HOOKS_MENU = [
    "",
    "  Hooks need review",
    "  5 hooks are new or changed.",
    "  Hooks can run outside the sandbox after you trust them.",
    "",
    "",
    "› 1. Review hooks",
    "  2. Trust all and continue",
    "  3. Continue without trusting (hooks won't run)",
    "",
    "  enter confirm · esc skip",
  ];
  const codexHooksPage = (footer: string, review: boolean) => [
    "  >_ OpenAI Codex (v0.163.0)",
    "     ~/projects/new",
    "",
    "  To get started, describe a task or try one of these commands:",
    "",
    "  /init - create an AGENTS.md file with instructions for Codex",
    "",
    "  Hooks",
    "  Lifecycle hooks from config and enabled plugins.",
    "",
    ...(review ? ["  ⚠ 5 hooks need review before they can run.", ""] : []),
    `  Event                 Installed   Active${review ? "      Review" : ""}      Description`,
    "",
    "  PreToolUse            0           0           0           Before a tool executes",
    "› PostToolUse           1           0           1           After a tool executes",
    "  SessionStart          1           0           1           When a new session starts",
    "↓",
    "",
    footer,
  ];

  it("reads Codex's startup folder question and hooks menu, each answered from its own highlight", () => {
    const folder = readReaderLive(plainBuffer(CODEX_FOLDER), "Codex", 100).question!;
    expect(folder.options.map((option) => option.label)).toEqual(["Trust and continue", "Quit"]);
    expect(answerKeys(folder, folder.options[0])).toEqual(["\r"]);
    const menu = readReaderLive(plainBuffer(CODEX_HOOKS_MENU), "Codex", 100);
    const hooks = menu.question!;
    expect(hooks.options.map((option) => option.label)).toEqual([
      "Review hooks", "Trust all and continue", "Continue without trusting (hooks won't run)",
    ]);
    expect(menu.ask[0]).toBe("Hooks need review");
    expect(answerKeys(hooks, hooks.options[1])).toEqual(["\u001b[B", "\r"]);
  });

  it("reads Codex's hooks page, which has no numbered rows, as a card of its footer's answers", () => {
    const live = readReaderLive(plainBuffer(codexHooksPage("  t trust all · enter review · esc close", true)), "Codex", 100);
    const page = live.question!;
    expect(page.title).toBe("Hooks");
    expect(page.options.map((option) => option.label)).toEqual(["Trust all", "Close"]);
    expect(live.ask).toEqual(["Hooks", "Lifecycle hooks from config and enabled plugins.", "", "⚠ 5 hooks need review before they can run."]);
    // Trust every hook, then close the page — where `Trust all and continue`
    // would have got to; or close it as it is.
    expect(answerKeys(page, page.options[0])).toEqual(["t", "\u001b"]);
    expect(answerKeys(page, page.options[1])).toEqual(["\u001b"]);
    // Nothing left to review (`/hooks` after trusting): only Close.
    const done = readReaderLive(plainBuffer(codexHooksPage("  enter details · esc close", false)), "Codex", 100).question!;
    expect(done.options.map((option) => option.label)).toEqual(["Close"]);
    // Another agent's screen of that shape is not Codex's page.
    expect(readReaderLive(plainBuffer(codexHooksPage("  t trust all · enter review · esc close", true)), "Claude", 100).question).toBeNull();
  });

  it("walks a several-question dialog's tabs with the arrows", () => {
    expect(tabStepKeys({ tabKeys: "arrows" }, 2, 1)).toEqual(["\u001b[D"]);
    expect(tabStepKeys({ tabKeys: "arrows" }, 0, 2)).toEqual(["\u001b[C", "\u001b[C"]);
    // Codex: PageUp/PageDown, which also work while a notes field is open.
    expect(tabStepKeys({ tabKeys: "pages" }, 0, 2)).toEqual(["\u001b[6~", "\u001b[6~"]);
    expect(tabStepKeys({ tabKeys: "pages" }, 1, 0)).toEqual(["\u001b[5~"]);
  });

  it("answers with the arrows from the highlight, then Enter", () => {
    const live = readReaderLive(plainBuffer(PERMISSION), "Claude");
    const question = live.question!;
    expect(answerKeys(question, question.options[2])).toEqual(["\u001b[B", "\u001b[B", "\r"]);
    expect(answerKeys(question, question.options[0])).toEqual(["\r"]);
  });

  // Claude Code 2.1.288, captured: Enter on the empty "Type something." row
  // answers "User declined to answer questions" — the whole dialog is gone.
  it("never presses Enter on the free-text row; it answers it with words", () => {
    const live = readReaderLive(plainBuffer([
      "> ask me", "", "←  ☐ Fruit  ☐ Color  ✔ Submit  →", "", "Which fruit?", "",
      "❯ 1. Apple", "     A red fruit that grows on trees in the garden.",
      "  2. Banana", "     A yellow fruit.",
      "  3. Cherry", "     A small red fruit.",
      "  4. Type something.",
      "──────────────────────────────────────────────────────────────────────",
      "  5. Chat about this", "",
      "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
    ]), "Claude");
    const question = live.question!;
    const free = question.options[3];
    expect(free.label).toBe("Type something.");
    expect(answerKeys(question, free)).toEqual([]);
    expect(answerTextKeys(question, free, "  a pear\nplease ")).toEqual(["\u001b[B", "\u001b[B", "\u001b[B", "a pear please", "\r"]);
    expect(answerTextKeys(question, free, "   ")).toEqual([]);
    expect(answerTextKeys(question, question.options[0], "words")).toEqual([]);
  });

  it("reads the agent at work, with its timer and tokens, and nothing when idle", () => {
    const busy = readReaderLive(plainBuffer(["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"]), "Claude");
    expect(busy.question).toBeNull();
    expect(busy.working).toEqual({ elapsed: "9s", tokens: "1.2k" });
    const idle = readReaderLive(plainBuffer(["> fix it", "", "⏺ Done.", "", "> ", "  ? for shortcuts"]), "Claude");
    expect(idle.question).toBeNull();
    expect(idle.working).toBeNull();
  });

  it("calls a screen it cannot read stray, and nothing it reads or a blank one", () => {
    const busy = ["> fix it", "", "✻ Thinking… (9s · ↓ 1.2k tokens · esc to interrupt)", "> ", "  ? for shortcuts"];
    const idle = ["> fix it", "", "⏺ Done.", "", "> ", "  ? for shortcuts"];
    expect(readReaderLive(plainBuffer(busy), "Claude").stray).toBe(false);
    expect(readReaderLive(plainBuffer(idle), "Claude").stray).toBe(false);
    expect(readReaderLive(plainBuffer(PERMISSION), "Claude").stray).toBe(false);
    expect(readReaderLive(plainBuffer(["", ""]), "Claude").stray).toBe(false);
    // OpenCode 2.1.3's start screen (120×40 capture): the box centred under
    // the logo, the version under the box's footer.
    const pad = " ".repeat(23);
    const openCodeStart = [
      ...Array<string>(14).fill(""),
      `${" ".repeat(41)}█▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█`,
      "", "",
      `${pad}┃`, `${pad}┃  Ask anything… "Fix broken tests"`, `${pad}┃`, `${pad}┃  Build · Flint 40B Free OpenCode`,
      `${pad}╹${"▀".repeat(74)}`,
      `${pad}/…/proj  shift+tab agents  ctrl+p commands`,
      ...Array<string>(12).fill(""),
      `${" ".repeat(113)}2.1.3`,
    ];
    const start = readReaderLive(plainBuffer(openCodeStart), "OpenCode", 120);
    expect(start.stray).toBe(false);
    expect(start.status?.mode).toBe("build");
    // A panel of the CLI's own over the input box, and a session that ended.
    const panel = readReaderLive(plainBuffer([
      "> fix it", "", "⏺ Done.", "", " Settings", "   Auto-compact          true", "   Theme                 dark", "", "  Esc to close",
    ]), "Claude");
    expect(panel.question).toBeNull();
    expect(panel.stray).toBe(true);
    const ended = readReaderLive(plainBuffer(["⏺ Done.", "", "Error: connection lost", "user@host:~/project$"]), "Claude");
    expect(ended.stray).toBe(true);
    expect(sameReaderLive(ended, readReaderLive(plainBuffer(idle), "Claude"))).toBe(false);
  });

  it("leaves a dialog answered before the last prompt alone", () => {
    const answered = readReaderLive(plainBuffer([
      "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "> and now the tests", "", "⏺ Running them.", "> ",
    ]), "Claude");
    expect(answered.question).toBeNull();
  });

  it("reads Claude Code's unnumbered folder-trust question, path whole", () => {
    const live = readReaderLive(plainBuffer(TRUST_FOLDER), "Claude", 60);
    expect(live.question?.options).toEqual([
      { index: 0, number: 1, label: "No, exit" },
      { index: 1, number: 2, label: "Yes, I trust this folder" },
    ]);
    expect(live.question?.current).toBe(0);
    expect(live.question?.title).toBe("Accessing workspace:");
    expect(live.ask).toContain("/home/user/projects/a-rather-long-project-folder-name-that-wraps/src");
    expect(live.ask.join("\n")).toMatch(/Quick safety check: Is this a project you created or one you trust\?/);
    expect(live.ask[live.ask.length - 1]).toBe("Security guide");
    expect(answerKeys(live.question!, live.question!.options[1])).toEqual(["\u001b[B", "\r"]);
  });

  it("reads no unnumbered dialog without its footer, or under an input box", () => {
    const rows = TRUST_FOLDER.slice(0, -4);
    expect(readReaderLive(plainBuffer(rows), "Claude", 60).question).toBeNull();
    const twoMarks = TRUST_FOLDER.map((row) => (row === "   Yes, I trust this folder" ? " ❯ Yes, I trust this folder" : row));
    expect(readReaderLive(plainBuffer(twoMarks), "Claude", 60).question).toBeNull();
    const scrolledPast = [...TRUST_FOLDER, "> hello", "", "⏺ Hi.", "", "> ", "  ? for shortcuts"];
    expect(readReaderLive(plainBuffer(scrolledPast), "Claude", 60).question).toBeNull();
  });

  it("reads Claude Code's first-run theme picker, which has no footer, when no input box is on screen", () => {
    const picker = [
      " Welcome to Claude Code v2.1.309",
      "",
      "  Let's get started.",
      "",
      "  Choose the text style that looks best with your terminal",
      "  To change this later, run /theme",
      "",
      "    Auto (match terminal)",
      "  ❯ ✓ Dark mode",
      "    Light mode",
      "    Dark mode (ANSI colors only)",
      "",
      "─".repeat(60),
      "     function greet",
      "  2 -  console.log(\"Hello, World!\");",
      "  2 +  console.log(\"Hello, Claude!\");",
      "─".repeat(60),
      "   Syntax theme: Monokai Extended (ctrl+t to disable)",
      "",
    ];
    const live = readReaderLive(plainBuffer(picker), "Claude", 80);
    expect(live.question?.options.map((option) => option.label)).toEqual(["Auto (match terminal)", "Dark mode", "Light mode", "Dark mode (ANSI colors only)"]);
    expect(live.question?.current).toBe(1);
    expect(live.ask.join("\n")).toMatch(/^Choose the text style that looks best with your terminal/);
    expect(live.stray).toBe(false);
    expect(answerKeys(live.question!, live.question!.options[2])).toEqual(["\u001b[B", "\r"]);
    // Highlighted on its first row, close to the bottom of the screen.
    const first = picker.map((row) => (row === "  ❯ ✓ Dark mode" ? "    ✓ Dark mode" : row === "    Auto (match terminal)" ? "  ❯ Auto (match terminal)" : row));
    const firstLive = readReaderLive(plainBuffer([...first.slice(0, 12), "   Syntax theme: Monokai Extended (ctrl+t to disable)"]), "Claude", 80);
    expect(firstLive.question?.current).toBe(0);
    expect(firstLive.question?.options[1].label).toBe("Dark mode");
    // Under an input box the same rows are output, never a dialog.
    const output = readReaderLive(plainBuffer(["> show me", "", ...picker.slice(6, 11), "", "> ", "  ? for shortcuts"]), "Claude", 80);
    expect(output.question).toBeNull();
  });

  it("reads a first-run screen that waits for Enter as one Continue row", () => {
    const notes = [" Security notes:", "", "  1. Claude can make mistakes", "", " Press Enter to continue…", ""];
    const live = readReaderLive(plainBuffer(notes), "Claude", 80);
    expect(live.question?.options).toEqual([{ index: 0, number: 1, label: "Continue", keys: ["\r"] }]);
    expect(answerKeys(live.question!, live.question!.options[0])).toEqual(["\r"]);
  });

  it("hands the chat the bottom of a screen it cannot read", () => {
    const live = readReaderLive(plainBuffer(["", "⏺ Done.", "", "Error: connection lost", "user@host:~/project$", "", ""]), "Claude");
    expect(live.stray).toBe(true);
    expect(live.screen).toEqual(["⏺ Done.", "", "Error: connection lost", "user@host:~/project$"]);
    expect(readReaderLive(plainBuffer(PERMISSION), "Claude").screen).toEqual([]);
  });

  it("tells a redraw of the same state from a change", () => {
    const a = readReaderLive(plainBuffer(PERMISSION), "Claude");
    const b = readReaderLive(plainBuffer(PERMISSION), "Claude");
    expect(sameReaderLive(a, b)).toBe(true);
    const busy = readReaderLive(plainBuffer(["✻ Thinking… (9s · esc to interrupt)", "> "]), "Claude");
    const later = readReaderLive(plainBuffer(["✻ Thinking… (10s · esc to interrupt)", "> "]), "Claude");
    expect(sameReaderLive(busy, later)).toBe(false);
  });
});
