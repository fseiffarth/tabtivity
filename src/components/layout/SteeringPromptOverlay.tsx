import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
import { ReaderSlashMenu, slashMenuKey } from "../terminal/ReaderSlashMenu";
import { useT } from "../../lib/i18n";
import {
  STEERING_PROMPT_EVENT,
  clearAgentTab,
  ledDraft,
  sendSteeringPrompt,
  steeringAgentOffer,
  type SteeringAgentCommand,
  type SteeringPromptDetail,
} from "../../lib/shortcuts/steeringAgent";
import { typePaneKeys } from "../../lib/agents/paneKeys";
import { pasteIntoAgentBox } from "../../lib/terminal/terminalDrop";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { readReaderLive } from "../../lib/agents/readerLive";
import { isNewConversationCommand } from "../../lib/agents/typedClear";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isClaudeCommand } from "../../lib/terminal/terminalControl";
import { agentFamily } from "../../../shared/agentComposer";
import {
  completedSlashCommand,
  forgetSlashCommand,
  readSlashCommands,
  rememberSlashCommand,
  slashSuggestions,
  type SlashSuggestion,
} from "../../../mobile-web/src/slashCommands";
import { CLAUDE_EFFORTS, modelPickOffered, useSessionPicker } from "../../hooks/useSessionPicker";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { selectMoveKeys } from "../../../mobile-web/src/terminal/selectPrompt";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { isOpenCodeTab } from "../../../mobile-web/src/terminal/openCodeMini";
import { groupOpenCodeModels, openCodeModelGroupTitle } from "../../../mobile-web/src/terminal/openCodeModelGroups";
import { useActivityStore } from "../../stores/activity";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { chordLabel } from "../../lib/shortcuts/shortcuts";

type Open = Omit<SteeringPromptDetail, "handled">;

/** Unsent text per agent tab (`scope:key`), for the window's lifetime. */
const drafts = new Map<string, string>();

/**
 * Steering's prompt box (the Prompt key, Space by default): a text box in the
 * middle of the window for the active agent tab, so a prompt goes in without
 * leaving the keyboard mode for the terminal. Enter submits it
 * (`sendSteeringPrompt`), Shift+Enter breaks the line; Enter or Escape hands
 * the keyboard back to steering on the level the key was pressed on, as the
 * project jump does. A send that fails keeps the box and the text, with why.
 * Text left unsent (Escape, Cancel) waits in the box for that tab's next open.
 * Plan / Goal chips lead it with `/plan ` / `/goal ` (`ledDraft`).
 *
 * A paste of files (copied in the file manager) or of an image (a screenshot,
 * no text on the clipboard) goes in as a drop onto the tab would
 * (`lib/terminal/terminalDrop`): copied into the tab folder's inbox and typed
 * at the caret as `@<reference>`, which the fenced agent can read.
 *
 * The Chat view composer's suggestions, read the same way: text starting
 * with `/` opens its `/` menu under the box (`ReaderSlashMenu`: ↑/↓, Tab or
 * Enter on a picked row fills it, Esc closes it), and the empty box shows
 * Claude Code's own suggestion for the next prompt, read off the pane's
 * screen, as its placeholder — Tab or → takes it in.
 *
 * Under the text, the phone composer's chips on Alt+keys (the letters type
 * text here): Alt+M lists the session's own `/model` picker, Alt+E the
 * effort (Claude's `/effort` levels; elsewhere the `/model` picker, whose
 * next step it is), Alt+C clears the conversation (pressed twice: it asks
 * first), Alt+P / Alt+G lead the text with `/plan` / `/goal` or
 * take that lead off again. A list takes ↑/↓, Enter and the digits; Escape
 * closes the list before the box.
 *
 * Mounted once in `AppShell`; opened by `STEERING_PROMPT_EVENT`. A modal
 * (`DialogShell`), so steering's key handler stands aside while it is up.
 */
export function SteeringPromptOverlay() {
  const [open, setOpen] = useState<Open | null>(null);

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent<SteeringPromptDetail>).detail;
      detail.handled = true;
      setOpen({ scope: detail.scope, tab: detail.tab, level: detail.level, lead: detail.lead });
    };
    window.addEventListener(STEERING_PROMPT_EVENT, onRequest);
    return () => window.removeEventListener(STEERING_PROMPT_EVENT, onRequest);
  }, []);

  if (!open) return null;
  const close = () => {
    setOpen(null);
    const steering = useKeyboardSteeringStore.getState();
    steering.enter();
    if (open.level !== "tabs") steering.setLevel(open.level);
  };
  // Keyed by the tab, so a box reopened for another tab takes that tab's draft.
  const id = `${open.scope}:${open.tab.key}`;
  return <PromptBox key={id} draftKey={id} target={open} onClose={close} />;
}

const CHIP_KEYS = { model: "m", effort: "e", clear: "c", plan: "p", goal: "g" } as const;
type Chip = keyof typeof CHIP_KEYS;

/** A chip's key as its `<kbd>` names it: `chordLabel`'s Alt — "Alt+M", or
 *  "⌥M" on macOS, where the key is Option. */
export function chipKeyLabel(chip: Chip): string {
  return chordLabel({ key: CHIP_KEYS[chip], alt: true });
}

function chipFor(e: ReactKeyboardEvent): Chip | null {
  if (e.metaKey || e.shiftKey) return null;
  // AltGr counts as Alt here (the user's choice): Linux reports it as neither
  // Alt nor Ctrl, Windows as Ctrl+Alt, and its letter as another character
  // (AltGr+E is € on a German layout) — so it matches by `code` below. The
  // cost: AltGr's € µ ¢ þ ŋ are not typed in this one box.
  if (!e.getModifierState("AltGraph") && (!e.altKey || e.ctrlKey)) return null;
  for (const chip of Object.keys(CHIP_KEYS) as Chip[]) {
    const key = CHIP_KEYS[chip];
    // `code` too: Option+letter types another character on macOS.
    if (e.key.toLowerCase() === key || e.code === `Key${key.toUpperCase()}`) return chip;
  }
  return null;
}

/** The digit of a 1–9 key, or null. */
function digitOf(e: ReactKeyboardEvent): number | null {
  if (e.altKey || e.ctrlKey || e.metaKey) return null;
  return /^[1-9]$/.test(e.key) ? Number(e.key) : null;
}

/** How long the pane's output rests before its prompt suggestion is read
 *  again: one read per redraw, not per chunk of it. */
const SUGGESTION_SETTLE_MS = 120;

/** Claude Code's prompt suggestion on pane `ptyId`'s screen, or "" (another
 *  CLI, a turn running, a dialog up, no screen in this window). */
function promptSuggestionOf(ptyId: string, agent: string): string {
  const term = terminalFor(ptyId);
  return term ? readReaderLive(term.buffer.active, agent).suggestion : "";
}

function PromptBox({ draftKey, target, onClose }: { draftKey: string; target: Open; onClose: () => void }) {
  const t = useT();
  const modelsByTab = useAgentModelsStore((state) => state.byTab);
  const screenModels = useAgentModelsStore((state) => state.screenByTab);
  const ptyId = `${target.scope}:${target.tab.key}`;
  const working = useActivityStore((state) => !!state.busyByTab[ptyId]);
  // Which agent the prompt goes to, in the words its own status line uses.
  const agent = agentTabLabel(target.tab);
  const offer = steeringAgentOffer(target.tab);
  const claude = isClaudeCommand(target.tab.cmd);
  const cli = agentFamily(agent);
  const [value, setValue] = useState(() => ledDraft(drafts.get(draftKey) ?? "", target.lead));
  /** The `/` menu (the Chat view's `ReaderSlashMenu`): the commands sent to
   * this CLI before, the row ↑/↓ moved to and whether Esc closed it for the
   * text as it stands. */
  const [usedSlash, setUsedSlash] = useState(() => readSlashCommands(cli));
  const [slashAt, setSlashAt] = useState<number | null>(null);
  const [slashClosed, setSlashClosed] = useState(false);
  /** Claude Code's suggestion for the next prompt, dimmed in its empty input
   * box: read off the pane's screen now and again as it draws. */
  const [suggestion, setSuggestion] = useState(() => promptSuggestionOf(ptyId, agent));
  useEffect(() => {
    const term = terminalFor(ptyId);
    if (!term || !isClaudeCommand(target.tab.cmd)) return;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const writes = term.onWriteParsed(() => {
      settle ??= setTimeout(() => {
        settle = undefined;
        setSuggestion(promptSuggestionOf(ptyId, agent));
      }, SUGGESTION_SETTLE_MS);
    });
    return () => {
      writes.dispose();
      if (settle) clearTimeout(settle);
    };
  }, [ptyId, agent, target.tab.cmd]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const input = useRef<HTMLTextAreaElement>(null);

  // The model and effort the session's status line shows, read again once a
  // picker is done.
  const readStatus = () => {
    const term = terminalFor(ptyId);
    return term ? sessionStatus(readableScreen(term.buffer.active).lines, agent) : null;
  };
  const [status, setStatus] = useState(readStatus);
  const model = status?.model ?? agentTabModelTag(target.scope, target.tab, modelsByTab, screenModels);
  const [pickedEffort, setPickedEffort] = useState<string | undefined>();
  const effort = pickedEffort ?? status?.effort;

  const session = useSessionPicker({
    tab: target.tab,
    ptyId,
    agentLabel: agent,
    typeKeys: (keys) => typePaneKeys(ptyId, keys),
  });
  // Which list is under the text: the session's picker, or Claude's levels.
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortCursor, setEffortCursor] = useState(0);
  const [effortSending, setEffortSending] = useState("");
  const [note, setNote] = useState<"effortFailed" | "cleared" | "clearFailed" | null>(null);
  const [clearArmed, setClearArmed] = useState(false);
  const picking = session.picking;
  // The pane's picker can only be listed while its screen is in this window,
  // and opens once the agent is idle (the Reader's rule).
  const canPick = !!terminalFor(ptyId) && !!target.tab.scheduleTargetId && !working;
  // A local-model tab keeps the model it was launched on: no picker to list.
  const modelPickable = modelPickOffered(target.tab);
  // Not while the session's picker is up: the text would land in it.
  const submittable = !busy && !picking && value.trim().length > 0;
  // Not over a model or effort list: ↑/↓ and Enter are that list's.
  const slashMenu = useMemo(
    () => (slashClosed || picking || effortOpen ? [] : slashSuggestions(value, cli, usedSlash)),
    [slashClosed, picking, effortOpen, value, cli, usedSlash],
  );
  /** Claude's suggestion while the box is empty, as its own CLI shows it:
   * the placeholder, taken into the box by Tab or →, so the user still
   * sends, edits or ignores it. */
  const shownSuggestion = suggestion && !value && !busy && !working && !picking && !effortOpen ? suggestion : "";

  // A picker just gone: the status line may name another model or effort.
  const [wasPicking, setWasPicking] = useState(picking);
  if (wasPicking !== picking) {
    setWasPicking(picking);
    if (!picking) setStatus(readStatus());
  }
  // Leaving the box leaves no picker open in the session.
  const latest = useRef(session);
  useEffect(() => { latest.current = session; });
  useEffect(() => () => { if (latest.current.picking) latest.current.close(); }, []);

  const refocus = () => input.current?.focus();
  /** The text changed (typed, picked, led): kept as the tab's draft, and the
   *  `/` menu offered afresh for it. */
  const editValue = (next: string) => {
    setValue(next);
    if (next) drafts.set(draftKey, next);
    else drafts.delete(draftKey);
    setError(null);
    setSlashAt(null);
    setSlashClosed(false);
  };
  const closeLists = () => {
    if (picking) session.close();
    setEffortOpen(false);
    setEffortSending("");
  };
  const openModel = () => {
    if (picking) {
      session.close();
      return;
    }
    if (!canPick || !modelPickable) return;
    setEffortOpen(false);
    setNote(null);
    session.open("/model");
  };
  const openEffort = () => {
    if (!claude) {
      openModel();
      return;
    }
    if (effortOpen) {
      setEffortOpen(false);
      return;
    }
    if (picking) session.close();
    setNote(null);
    const at = CLAUDE_EFFORTS.indexOf(effort as (typeof CLAUDE_EFFORTS)[number]);
    setEffortCursor(at >= 0 ? at : 0);
    setEffortOpen(true);
  };
  const chooseEffort = (level: string) => {
    if (effortSending) return;
    const id = target.tab.scheduleTargetId;
    if (!id) {
      setNote("effortFailed");
      return;
    }
    setEffortSending(level);
    void submitScheduledAgentCommand(id, `/effort ${level}`).then(
      () => {
        setPickedEffort(level);
        setEffortOpen(false);
        setEffortSending("");
      },
      () => {
        setEffortSending("");
        setNote("effortFailed");
      },
    );
  };
  const clear = () => {
    if (!offer.clear) return;
    if (!clearArmed) {
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    void clearAgentTab(target.scope, target.tab).then((done) => setNote(done ? "cleared" : "clearFailed"));
  };
  const lead = (command: SteeringAgentCommand) => {
    const led = new RegExp(`^${command}(?:\\s+|$)`, "u");
    editValue(led.test(value) ? value.replace(led, "") : ledDraft(value, command));
  };
  /** The `/` menu's row taken into the box: only filled, the user still
   *  sends it, so a stray pick never runs `/clear` on the session. */
  const pickSlash = (picked: SlashSuggestion) => {
    editValue(picked.args ? `${picked.line} ` : picked.line);
    refocus();
  };
  const forgetSlash = (line: string) => {
    forgetSlashCommand(cli, line);
    setUsedSlash(readSlashCommands(cli));
    setSlashAt(null);
  };
  /** The `/` menu's keys (`slashMenuKey`); true when one was taken. */
  const slashKey = (e: ReactKeyboardEvent): boolean => {
    const action = slashMenuKey(e, slashMenu.length, slashAt);
    if (action === null) return false;
    if (action === "close") {
      setSlashClosed(true);
      setSlashAt(null);
    } else if ("move" in action) setSlashAt(action.move);
    else pickSlash(slashMenu[action.pick]);
    return true;
  };
  /** Tab or → in the empty box takes Claude's suggestion into it. */
  const suggestionKey = (e: ReactKeyboardEvent): boolean => {
    if (!shownSuggestion || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false;
    if (e.key !== "Tab" && e.key !== "ArrowRight") return false;
    editValue(shownSuggestion);
    return true;
  };
  const runChip = (chip: Chip) => {
    if (chip !== "clear") setClearArmed(false);
    if (chip === "model") openModel();
    else if (chip === "effort") openEffort();
    else if (chip === "clear") clear();
    else if (offer[chip]) lead(chip === "plan" ? "/plan" : "/goal");
  };

  /** The keys a list takes while it is open; true when one was taken. */
  const listKey = (e: ReactKeyboardEvent): boolean => {
    if (!picking && !effortOpen) return false;
    if (e.key === "Escape") {
      closeLists();
      return true;
    }
    if (picking) {
      const step = session.step;
      const digit = digitOf(e);
      if (digit !== null) {
        const option = step?.options.find((entry) => entry.number === digit);
        if (option) session.choose(option.index);
        return true;
      }
      // ↑/↓ go to the session's own picker, so its highlight is the cursor
      // and it scrolls its window to the rows it does not draw.
      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && session.picker && !session.busy) {
        const from = session.picker.current;
        void typePaneKeys(ptyId, selectMoveKeys(from, from + (e.key === "ArrowDown" ? 1 : -1))).catch(() => {});
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        if (step) session.choose(step.current);
        return true;
      }
      return false;
    }
    if (effortOpen) {
      const n = CLAUDE_EFFORTS.length;
      const digit = digitOf(e);
      if (digit !== null) {
        if (digit <= n) chooseEffort(CLAUDE_EFFORTS[digit - 1]);
        return true;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        setEffortCursor((at) => (at + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        return true;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        chooseEffort(CLAUDE_EFFORTS[effortCursor]);
        return true;
      }
    }
    return false;
  };

  /** Put `text` at the caret, spaced off the word before it, as the Reader's
   *  composer takes a drop. */
  const insertAtCaret = (text: string) => {
    const box = input.current;
    setValue((current) => {
      const at = box ? Math.min(box.selectionEnd, current.length) : current.length;
      const before = current.slice(0, at);
      const next = `${before}${before && !/\s$/.test(before) ? " " : ""}${text}${current.slice(at)}`;
      drafts.set(draftKey, next);
      return next;
    });
    setError(null);
    box?.focus();
  };
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    pasteIntoAgentBox(event, ptyId, ({ text, error }) => {
      if (text) insertAtCaret(text);
      if (error) setError(t(error));
    });
  };

  async function submit() {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      // A prefix the CLI's popup completes (`/clea`) runs that command.
      const command = completedSlashCommand(value, cli, usedSlash) ?? value;
      // A new conversation goes in as the Clear chip's does, so the window
      // knows of it at once (Codex's hook says so only with the next prompt).
      if (offer.clear && isNewConversationCommand(command)) {
        if (!(await clearAgentTab(target.scope, target.tab))) throw new Error(t("steering.prompt.clearFailed"));
      } else {
        await sendSteeringPrompt(target.tab, value);
      }
      // Offered again by the `/` menu, newest first.
      rememberSlashCommand(cli, command);
      drafts.delete(draftKey);
      onClose();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  const shownStep = session.shownStep;
  const chips: { chip: Chip; label: string; shown: boolean; disabled?: boolean; on?: boolean; title?: string }[] = [
    {
      chip: "model",
      label: t("steering.prompt.chipModel", { model: model ?? "…" }),
      shown: modelPickable,
      disabled: !picking && !canPick,
      on: picking,
      title: working ? t("steering.prompt.chipWorking") : undefined,
    },
    {
      chip: "effort",
      label: effort ? t("steering.prompt.chipEffort", { effort }) : t("steering.prompt.chipEffortUnknown"),
      shown: claude || (modelPickable && !!effort),
      disabled: claude ? false : !picking && !canPick,
      on: claude ? effortOpen : picking,
    },
    {
      chip: "clear",
      label: t(clearArmed ? "steering.prompt.chipClearAgain" : "steering.prompt.chipClear"),
      shown: offer.clear,
      on: clearArmed,
    },
    { chip: "plan", label: t("steering.prompt.chipPlan"), shown: offer.plan, on: /^\/plan(?:\s|$)/u.test(value) },
    { chip: "goal", label: t("steering.prompt.chipGoal"), shown: offer.goal, on: /^\/goal(?:\s|$)/u.test(value) },
  ];

  return (
    <DialogShell className="steering-prompt-dialog" onDismiss={() => !busy && onClose()}>
      <h2 className="steering-prompt-head">
        <span className="steering-prompt-title">{t("steering.prompt.title", { tab: target.tab.label })}</span>
        {(agent !== target.tab.label || model) && (
          <span className="steering-prompt-agent">{[agent !== target.tab.label ? agent : "", model].filter(Boolean).join(" · ")}</span>
        )}
        <UntestedTag id="steering.agentPrompt" />
        <UntestedTag id="steering.promptPaste" />
        <UntestedTag id="steering.promptAltGr" />
        {(slashMenu.length > 0 || shownSuggestion) && <UntestedTag id="steering.promptSuggestions" />}
      </h2>
      <textarea
        ref={input}
        className="file-paste-name steering-prompt-input"
        autoFocus
        rows={4}
        aria-label={shownSuggestion ? `${t("terminal.reader.suggestion")}: ${shownSuggestion}` : t("steering.prompt.placeholder")}
        placeholder={shownSuggestion ? t("terminal.reader.suggestionPlaceholder", { text: shownSuggestion }) : t("steering.prompt.placeholder")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        onPaste={onPaste}
        // A kept draft: the caret goes after it, not before.
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => editValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const chip = chipFor(e);
          if (chip) {
            e.preventDefault();
            runChip(chip);
            return;
          }
          if (e.key !== "Alt") setClearArmed(false);
          if (listKey(e) || slashKey(e) || suggestionKey(e)) {
            // Taken here: the box's own Escape, Enter and Tab stand aside.
            e.preventDefault();
            return;
          }
          if (e.key !== "Enter" || e.shiftKey) return;
          e.preventDefault();
          void submit();
        }}
      />
      {slashMenu.length > 0 && <ReaderSlashMenu suggestions={slashMenu} at={slashAt} onPick={pickSlash} onForget={forgetSlash} />}
      {(picking || effortOpen) && (
        <div className="steering-prompt-list" role="listbox"
          aria-label={picking ? shownStep?.title ?? t("terminal.reader.modelTitle") : t("terminal.reader.effortTitle")}>
          <div className="steering-prompt-list-head">
            {picking ? shownStep?.title ?? t("terminal.reader.modelTitle") : t("terminal.reader.effortTitle")}
          </div>
          {picking ? (
            shownStep ? (
              (isOpenCodeTab(agent) && shownStep.title === "Select model"
                ? groupOpenCodeModels(shownStep.options)
                : [{ key: "all", options: shownStep.options }]).map((group) => <div className="steering-prompt-option-group" role="group" aria-label={group.key !== "all" ? openCodeModelGroupTitle(group, t) : undefined} key={group.key}>
                {group.key !== "all" && <div className="terminal-reader-option-group-title" role="presentation">{openCodeModelGroupTitle(group, t)}</div>}
                {group.options.map((option) => (
                <button
                  key={`${option.index}:${option.label}`}
                  type="button"
                  role="option"
                  aria-selected={!!session.picker && option.index === session.picker.current}
                  className="terminal-reader-option"
                  disabled={session.busy}
                  onClick={() => { session.choose(option.index); refocus(); }}
                >
                  <span className="terminal-reader-option-number">{option.number}</span>
                  <span className="terminal-reader-option-label">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
                ))}
              </div>)
            ) : (
              <small className="terminal-reader-question-more">{t("terminal.reader.modelWaiting")}</small>
            )
          ) : (
            CLAUDE_EFFORTS.map((level, index) => (
              <button
                key={level}
                type="button"
                role="option"
                aria-selected={index === effortCursor}
                className="terminal-reader-option"
                disabled={!!effortSending}
                aria-busy={level === effortSending}
                onClick={() => { chooseEffort(level); refocus(); }}
              >
                <span className="terminal-reader-option-number">{level === effortSending ? "…" : index + 1}</span>
                <span className="terminal-reader-option-label">
                  <span>{level === "auto" ? t("terminal.reader.effortAuto") : t("terminal.reader.effort", { effort: level })}</span>
                  {level === effort && <small>{t("steering.prompt.current")}</small>}
                </span>
              </button>
            ))
          )}
          {picking && session.step?.hidden ? <small className="terminal-reader-question-more">{t("steering.prompt.moreRows")}</small> : null}
          <small className="terminal-reader-question-more">{t("steering.prompt.listKeys")}</small>
        </div>
      )}
      {note && (
        <small className="steering-prompt-note" role={note === "cleared" ? "status" : "alert"}>
          {t(`steering.prompt.${note}`)}
        </small>
      )}
      <div className="steering-prompt-chips">
        {chips.filter((chip) => chip.shown).map((chip) => (
          <button
            key={chip.chip}
            type="button"
            className={chip.on ? "steering-prompt-chip on" : "steering-prompt-chip"}
            disabled={busy || chip.disabled}
            aria-pressed={chip.on}
            title={chip.title}
            onClick={() => { runChip(chip.chip); refocus(); }}
          >
            <kbd>{chipKeyLabel(chip.chip)}</kbd>
            <span>{chip.label}</span>
          </button>
        ))}
        <UntestedTag id="steering.promptChips" />
      </div>
      {error && <ErrorNote id={errorId} role="alert" className="file-delete-path file-delete-error" error={error} />}
      <div className="file-delete-actions">
        <span className="steering-prompt-hint">
          <span><kbd>{t("steering.prompt.keyEnter")}</kbd> {t("steering.prompt.hintSend")}</span>
          <span><kbd>{t("steering.prompt.keyShiftEnter")}</kbd> {t("steering.prompt.hintNewLine")}</span>
          <span><kbd>{t("steering.prompt.keyEsc")}</kbd> {t("steering.prompt.hintBack")}</span>
        </span>
        <button type="button" onClick={onClose} disabled={busy}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn-primary" onClick={() => void submit()} disabled={!submittable}>
          {t("steering.prompt.send")}
        </button>
      </div>
    </DialogShell>
  );
}
