/**
 * The permission modes a session offers, as a list the phone can show — the
 * counterpart of `selectPrompt` for the chip that has no dialog behind it.
 *
 * None of these CLIs opens a picker for its permission mode: the mode is
 * cycled with Shift+Tab, one step at a time, and the only readout is the line
 * the TUI redraws below its input box. So the sheet lists a family's modes and
 * the caller *applies* one by pressing Shift+Tab until `statusLine` reports
 * the mode the user asked for — every step verified against what the session
 * actually printed, never against an assumed cycle order.
 *
 * Which family a session belongs to is decided by the mode it is currently
 * showing, with the tab's agent label breaking ties — "plan" is a mode of both
 * Claude Code and Qwen Code, and only the label says which session this is. A
 * session whose mode no table claims gets no list at all, and the chip keeps
 * cycling as before — an honest fallback beats offering a mode the session may
 * not have. The one exception is a family with a `silent` mode: Claude Code
 * prints *nothing* while in its default mode, so for a tab whose label names
 * such a family, an input frame with no mode text is itself the readout.
 *
 * One family is listed but cannot be *walked*: OpenCode's minimal interface
 * has no key that changes its agent, so its entry is marked `fixed` and the
 * caller shows the list as a readout instead of a switch. A family that binds
 * nothing must not be offered a cycle — the chip would have pressed a key into
 * a session that ignores it and then reported a failed switch.
 *
 * Deliberately absent:
 *   - Vibe / Copilot / Crush / Cline — full-screen (alternate-screen) TUIs;
 *     the Focus view already hands those to the Terminal view. Copilot has
 *     drawn one unconditionally since 1.0.12, and Qwen Code does too by
 *     default since `ui.useTerminalBuffer` (0.23). Plain `opencode` is one of
 *     them; only `opencode --mini` writes scrollback, and only that is what
 *     the OpenCode family below reads.
 *   - Agents whose mode is not on Shift+Tab: Amp (Ctrl+S), Goose and
 *     mini-SWE-agent (a slash command each), Aider (the prompt prefix is the
 *     mode). A walk of Shift+Tab presses would never reach one of theirs.
 *   - Kimi Code, Cursor agent, Grok Build, Antigravity — their mode readouts
 *     are known from source only; they wait for a live capture.
 * See `docs/mobile_focus_cli_survey.md` for what each CLI draws.
 */

import { translate, useI18nStore, type TranslationKey } from "../../../src/lib/i18n";

export interface ModeChoice {
  /** The mode as `statusLine` names it — what an applied switch is checked
   * against. */
  value: string;
  /** The row's name and line, in the phone's language. */
  label: string;
  description: string;
  /** Other names `statusLine` may report for the same mode. */
  aliases?: string[];
  /** The session shows no mode text at all while in this mode; an input frame
   * with no mode line is read as being in it. At most one per family. */
  silent?: boolean;
  /** Claimed only for a tab whose label names this family: the mode's word is
   * another family's too, and without a label it stays theirs. */
  labelled?: boolean;
}

/** A table row: `ModeChoice` with its words as keys, read out in the
 * language live when `modeChoices` hands the list over. */
type ModeRow = Omit<ModeChoice, "label" | "description"> & { label: TranslationKey; description: TranslationKey };

interface ModeFamily {
  /** Matches the tab's agent label ("Claude", "Qwen", …). */
  agent: RegExp;
  choices: ModeRow[];
  /** The session's mode cannot be changed from here: no key this can press
   * switches it. The caller lists the modes as a readout and never walks. */
  fixed?: boolean;
}

/** Claude Code: the Shift+Tab cycle — `accept edits on`, `plan mode on`, `auto
 * mode on`, in that order, read out of the 2.1.272 bundle — plus the mode a
 * session started with `--dangerously-skip-permissions` sits in. Auto is on the
 * cycle only where the account offers auto mode, and bypass is never on the
 * ordinary cycle; both are listed anyway: a session that has one shows it, and
 * one that does not says so when the switch fails to confirm. Default is
 * `silent`: older releases drew no mode line in it, and 2.1.284+ draws
 * `⏸ manual mode on`, which no `statusLine` pattern names — both read as the
 * silent default. Auto is `labelled`:
 * bare "auto" is Codex's and Qwen's word too, and an unlabelled tab showing it
 * has always gone to them. */
const CLAUDE: ModeFamily = {
  agent: /claude/iu,
  choices: [
    { value: "default", label: "mobile.mode.default", description: "mobile.mode.defaultHint", silent: true },
    { value: "accept edits", label: "mobile.mode.acceptEdits", description: "mobile.mode.acceptEditsHint", aliases: ["auto-accept"] },
    { value: "plan", label: "mobile.mode.plan", description: "mobile.mode.planHint" },
    { value: "auto", label: "mobile.mode.auto", description: "mobile.mode.autoHint", labelled: true },
    { value: "bypass permissions", label: "mobile.mode.bypass", description: "mobile.mode.bypassHint" },
  ],
};

/** Codex: its approval modes, as its own status line names them. Its working
 * mode is `silent` — verified against codex-cli 0.151.0, which draws a mode
 * line for "Plan mode" and nothing at all while it is working — so without the
 * silent entry a Codex session sitting in its ordinary mode had no list, and
 * one showing "plan mode" was claimed by Claude Code's family instead (both
 * offer a plan, and only the label parts them). Which of the working modes a
 * session actually has is its own business: `applyMode` verifies every step
 * against what the session printed, so one it does not offer simply fails to
 * confirm rather than being reported as applied. */
const CODEX: ModeFamily = {
  agent: /codex/iu,
  choices: [
    { value: "working", label: "mobile.mode.working", description: "mobile.mode.workingHint", silent: true },
    { value: "plan", label: "mobile.mode.plan", description: "mobile.mode.planHint", aliases: ["plan mode"] },
    { value: "read only", label: "mobile.mode.readOnly", description: "mobile.mode.readOnlyHint" },
    { value: "auto", label: "mobile.mode.auto", description: "mobile.mode.autoWorkspaceHint" },
    { value: "full access", label: "mobile.mode.fullAccess", description: "mobile.mode.fullAccessHint" },
  ],
};

/** Qwen Code: all five approval modes are on its Shift+Tab cycle and every one
 * draws its own indicator text ("⏸ Ask permissions", "plan mode",
 * "auto-accept edits", "Auto mode", "YOLO mode"), so each is verifiable. */
const QWEN: ModeFamily = {
  agent: /qwen/iu,
  choices: [
    { value: "ask permissions", label: "mobile.mode.askPermissions", description: "mobile.mode.askPermissionsHint" },
    { value: "plan", label: "mobile.mode.plan", description: "mobile.mode.planHint" },
    { value: "auto-accept", label: "mobile.mode.acceptEdits", description: "mobile.mode.acceptEditsHint", aliases: ["accept edits"] },
    { value: "auto", label: "mobile.mode.auto", description: "mobile.mode.autoToolsHint" },
    { value: "yolo", label: "mobile.mode.yolo", description: "mobile.mode.yoloHint" },
  ],
};

/** Gemini CLI: `default`, `auto-accept edits` and `plan` on its Shift+Tab
 * cycle, YOLO on a key of its own (Ctrl+Y) — read out of the 0.56.0 bundle's
 * `ApprovalModeIndicator` and unchanged in 0.60.0. It draws the mode on the row
 * *above* its input box (`statusLine` reads it there), and in its default mode
 * draws only the hint `Shift+Tab to accept edits`, so default is `silent`.
 * YOLO is listed because a session can be in it; a walk to it fails to
 * confirm, since no Shift+Tab reaches it. Plan is on the cycle only where the
 * session allows plan mode. Listed last: without a label, bare "yolo" stays
 * Qwen's and "accept edits"/"plan" stay Claude Code's, as they always were. */
const GEMINI: ModeFamily = {
  agent: /gemini/iu,
  choices: [
    { value: "default", label: "mobile.mode.default", description: "mobile.mode.defaultHint", silent: true },
    { value: "accept edits", label: "mobile.mode.acceptEdits", description: "mobile.mode.acceptEditsHint", aliases: ["auto-accept"] },
    { value: "plan", label: "mobile.mode.plan", description: "mobile.mode.planHint" },
    { value: "yolo", label: "mobile.mode.yolo", description: "mobile.mode.yoloGeminiHint" },
  ],
};

/** OpenCode: what it calls the *agent* — `build` and `plan` are the two
 * primary ones it ships, and a project can add more — is what the phone's mode
 * chip shows, read out of the capitals in its status row (` BUILD  …`).
 *
 * `fixed`, because `opencode --mini` binds no key that switches it: its
 * `agent.cycle`/`agent.cycle.reverse` (Tab and Shift+Tab) and its leader
 * keybinds belong to the full-screen TUI, and pressing any of them in a mini
 * session does nothing at all — verified against 1.18.31, whose command
 * palette (ctrl+p, the only commands mini has) offers "Switch model" and
 * "Variant cycle" and no agent switch. The agent a mini session runs as is the
 * one it started with (`opencode --mini --agent plan`).
 *
 * Both are `labelled`: "plan" is Claude Code's, Codex's, Qwen's and Gemini's
 * word too, and "build" would otherwise be claimed for any session whose
 * status line happens to say it. */
const OPENCODE: ModeFamily = {
  agent: /open\s*code/iu,
  fixed: true,
  choices: [
    { value: "build", label: "mobile.mode.build", description: "mobile.mode.buildHint", labelled: true },
    { value: "plan", label: "mobile.mode.plan", description: "mobile.mode.planHint", labelled: true },
  ],
};

const FAMILIES = [CLAUDE, CODEX, QWEN, GEMINI, OPENCODE];

function claims(choice: Pick<ModeChoice, "value" | "aliases">, mode: string) {
  return choice.value === mode || (choice.aliases?.includes(mode) ?? false);
}

/** The modes to offer for a session showing `mode`, or an empty list when no
 * family recognizes it. `agentLabel` — the tab's label — breaks a tie between
 * families sharing a mode name, and is the only way in for a family's silent
 * mode: with no mode text on screen, only a label naming a silent-mode family
 * earns a list. */
export function modeChoices(mode?: string, agentLabel?: string): ModeChoice[] {
  const lang = useI18nStore.getState().lang;
  return familyChoices(mode, agentLabel).map((choice) => ({
    ...choice,
    label: translate(lang, choice.label),
    description: translate(lang, choice.description),
  }));
}

function familyChoices(mode?: string, agentLabel?: string): ModeRow[] {
  const labelled = agentLabel
    ? FAMILIES.find((family) => family.agent.test(agentLabel))
    : undefined;
  if (!mode) {
    // No mode text. Only a family that draws none for one of its modes can
    // read that as a state; for every other family it just means the bottom of
    // the screen is not a status readout right now.
    return labelled?.choices.some((choice) => choice.silent) ? labelled.choices : [];
  }
  const normalized = mode.trim().toLowerCase();
  const claimants = FAMILIES.filter((family) =>
    family.choices.some((choice) =>
      claims(choice, normalized) && (!choice.labelled || family === labelled)));
  if (claimants.length === 0) return [];
  if (labelled) {
    // The label names the session's family. A mode that family does not list
    // (a Claude Code tab showing a mode newer than this table) is *that*
    // family's unknown mode, not a reason to hand the tab another family's
    // list — the sheet would have walked a Claude session through Codex's
    // choices. No list: the chip keeps cycling, which is the honest fallback.
    return claimants.includes(labelled) ? labelled.choices : [];
  }
  return claimants[0].choices;
}

/** Whether this tab's family has a mode the phone cannot change — OpenCode's
 * mini interface, whose agent is settled when the session starts. The caller
 * shows the list as a readout and presses nothing. */
export function modeFixed(agentLabel?: string): boolean {
  if (!agentLabel) return false;
  return FAMILIES.some((family) => family.fixed && family.agent.test(agentLabel));
}

/** Which listed choice the session is in right now, by value or alias.
 * `framed` says whether an input frame is on screen at all — required before
 * the absence of mode text may be read as the family's silent mode. */
export function currentMode(
  choices: readonly ModeChoice[],
  mode?: string,
  framed?: boolean,
): string | undefined {
  if (!mode) {
    return framed ? choices.find((choice) => choice.silent)?.value : undefined;
  }
  const normalized = mode.trim().toLowerCase();
  return choices.find((choice) => claims(choice, normalized))?.value;
}

/** Shift+Tab, the way a terminal without the kitty keyboard protocol sends it:
 * the legacy backtab. */
const LEGACY_SHIFT_TAB = "\u001b[Z";

/** Shift+Tab as the kitty protocol's CSI-u form - Tab (9) with Shift (2). */
const CSI_U_SHIFT_TAB = "\u001b[9;2u";

/** The bytes a Shift+Tab must arrive as for this session's TUI to act on it.
 *
 * Claude Code and Qwen Code cycle on the legacy backtab. Codex does not: it
 * binds its mode cycle to Tab-with-Shift and reads only the CSI-u encoding, so
 * a backtab leaves it exactly where it was - the walk in `applyMode` would run
 * a whole lap and report a failed switch on a session that offers the mode.
 * Codex accepts CSI-u whether or not the terminal answered its keyboard-
 * enhancement probe. The desktop pane re-encodes the same key for the same
 * reason (`src/lib/terminal/terminalControl.ts`). */
export function shiftTabKey(agentLabel?: string): string {
  return agentLabel && CODEX.agent.test(agentLabel) ? CSI_U_SHIFT_TAB : LEGACY_SHIFT_TAB;
}
