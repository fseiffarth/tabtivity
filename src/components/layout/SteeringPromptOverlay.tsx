import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { DialogShell } from "../common/PromptDialogs";
import { ErrorNote } from "../common/ErrorNote";
import { UntestedTag } from "../common/UntestedTag";
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
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isClaudeCommand } from "../../lib/terminal/terminalControl";
import { CLAUDE_EFFORTS, useSessionPicker } from "../../hooks/useSessionPicker";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { selectMoveKeys } from "../../../mobile-web/src/terminal/selectPrompt";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { useActivityStore } from "../../stores/activity";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../stores/agents/agentModels";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";

type Open = Omit<SteeringPromptDetail, "handled">;

/** Unsent text per agent tab (`scope:key`), for the window's lifetime. */
const drafts = new Map<string, string>();

/**
 * Steering's prompt box (the Prompt key, I by default): a text box in the
 * middle of the window for the active agent tab, so a prompt goes in without
 * leaving the keyboard mode for the terminal. Enter submits it
 * (`sendSteeringPrompt`), Shift+Enter breaks the line; Enter or Escape hands
 * the keyboard back to steering on the level the key was pressed on, as the
 * project jump does. A send that fails keeps the box and the text, with why.
 * Text left unsent (Escape, Cancel) waits in the box for that tab's next open.
 * Plan / Goal open it led with `/plan ` / `/goal ` (`ledDraft`).
 *
 * Under the text, the phone composer's chips on Alt+keys (the letters type
 * text here): Alt+M lists the session's own `/model` picker, Alt+E the
 * effort (Claude's `/effort` levels; elsewhere the `/model` picker, whose
 * next step it is), Alt+K clears the conversation (pressed twice: it asks
 * first, as K does), Alt+L / Alt+G lead the text with `/plan` / `/goal` or
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

/** The chips' Alt+keys, beside the steering keys that do the same on the
 *  tab level (K, L, G). */
const CHIP_KEYS = { model: "m", effort: "e", clear: "k", plan: "l", goal: "g" } as const;
type Chip = keyof typeof CHIP_KEYS;

function chipFor(e: ReactKeyboardEvent): Chip | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
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
  const [value, setValue] = useState(() => ledDraft(drafts.get(draftKey) ?? "", target.lead));
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
  // Not while the session's picker is up: the text would land in it.
  const submittable = !busy && !picking && value.trim().length > 0;

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
    if (!canPick) return;
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
    const next = led.test(value) ? value.replace(led, "") : ledDraft(value, command);
    setValue(next);
    if (next) drafts.set(draftKey, next);
    else drafts.delete(draftKey);
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

  async function submit() {
    if (!submittable) return;
    setBusy(true);
    setError(null);
    try {
      await sendSteeringPrompt(target.tab, value);
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
      shown: true,
      disabled: !picking && !canPick,
      on: picking,
      title: working ? t("steering.prompt.chipWorking") : undefined,
    },
    {
      chip: "effort",
      label: effort ? t("steering.prompt.chipEffort", { effort }) : t("steering.prompt.chipEffortUnknown"),
      shown: claude || !!effort,
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
      </h2>
      <textarea
        ref={input}
        className="file-paste-name steering-prompt-input"
        autoFocus
        rows={4}
        aria-label={t("steering.prompt.placeholder")}
        placeholder={t("steering.prompt.placeholder")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={value}
        disabled={busy}
        // A kept draft: the caret goes after it, not before.
        onFocus={(e) => {
          const end = e.currentTarget.value.length;
          e.currentTarget.setSelectionRange(end, end);
        }}
        onChange={(e) => {
          setValue(e.target.value);
          if (e.target.value) drafts.set(draftKey, e.target.value);
          else drafts.delete(draftKey);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          const chip = chipFor(e);
          if (chip) {
            e.preventDefault();
            runChip(chip);
            return;
          }
          if (e.key !== "Alt") setClearArmed(false);
          if (listKey(e)) {
            // Taken here: the box's own Escape and Enter stand aside.
            e.preventDefault();
            return;
          }
          if (e.key !== "Enter" || e.shiftKey) return;
          e.preventDefault();
          void submit();
        }}
      />
      {(picking || effortOpen) && (
        <div className="steering-prompt-list" role="listbox"
          aria-label={picking ? shownStep?.title ?? t("terminal.reader.modelTitle") : t("terminal.reader.effortTitle")}>
          <div className="steering-prompt-list-head">
            {picking ? shownStep?.title ?? t("terminal.reader.modelTitle") : t("terminal.reader.effortTitle")}
          </div>
          {picking ? (
            shownStep ? (
              shownStep.options.map((option) => (
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
              ))
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
            <kbd>{t("steering.prompt.keyAlt", { key: CHIP_KEYS[chip.chip].toUpperCase() })}</kbd>
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
