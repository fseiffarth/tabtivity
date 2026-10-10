import { useEffect, useRef, useState } from "react";
import { useT } from "../../lib/i18n";
import { readAgentUsage } from "../../lib/agents/agentUsage";
import type { ReaderLive } from "../../lib/agents/readerLive";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { shortPath } from "../../lib/agents/agentReader";
import { worktreeOfPath } from "../../lib/agents/agentWorktrees";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isClaudeCommand, isCodexCommand } from "../../lib/terminal/terminalControl";
import { UntestedTag } from "../common/UntestedTag";
import type { TabEntry } from "../../stores/tabs";
import type { SessionUsage } from "../../../mobile-web/src/api";
import { resetCountdown, resetText } from "../../../mobile-web/src/terminal/limitResets";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../../../mobile-web/src/terminal/agentModes";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { sessionLimits } from "../../../mobile-web/src/terminal/sessionUsage";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import { TerminalReaderStatus } from "./TerminalReaderStatus";
import { CLAUDE_EFFORTS, useSessionPicker } from "../../hooks/useSessionPicker";

/** The phone's pacing: how often the CLI's usage panel is read again (the
 * backend floors it besides), and how often the reset countdowns tick. */
const LIMITS_POLL_MS = 120_000;
const CLOCK_MS = 30_000;
/** The phone's mode walk (`mobile-web` `Terminal.tsx` `applyMode`): how long a
 * Shift+Tab is given to redraw the mode line, and how many presses a lap may
 * take before the walk gives up. */
const MODE_SETTLE_MS = 340;
const MODE_CYCLE_LIMIT = 6;

/**
 * The Reader's facts row — the phone's (`mobile-web` `Terminal.tsx`
 * `.session-facts`) on the desktop: the model the session prints (a button
 * that opens its own `/model` picker as a list here), the branch, the
 * context left and the account's 5-hour and weekly limits — plus, as the
 * phone's chips, the permission mode (a list walked with Shift+Tab, or one
 * press where the session's modes are unknown) and the reasoning effort (a
 * list sent as Claude's `/effort`; elsewhere the `/model` picker, whose next
 * step it is), and the folder the agent works in with the worktree it is. The status facts
 * come off the pane's live screen (`ReaderLive.status`); the limits from the
 * CLI's usage panel (`agent_usage`, which spends no quota), or — Codex, which
 * has none — from the figures its rollout stores.
 */
export function TerminalReaderFacts({ tab, ptyId, agentLabel, live, modelTag, usage, path, effort, onEffortPicked, visible, typeKeys, onPicking, statusOpen, statusRequest, onStatusRequest, onStatusClose }: {
  tab: TabEntry;
  ptyId: string;
  agentLabel: string;
  live: ReaderLive;
  /** The tab's model tag when the screen shows no status line. */
  modelTag: string | undefined;
  /** The stored session's own figures (Codex), for what the screen and the
   * usage panel leave out. */
  usage: SessionUsage | undefined;
  /** The folder the agent works in, when the screen prints none. */
  path: string | undefined;
  /** The reasoning effort last seen (busy row, transcript), when the status
   * line has none. */
  effort: string | undefined;
  /** A level was sent from the effort list: shown until the session says. */
  onEffortPicked: (effort: string) => void;
  visible: boolean;
  typeKeys: (keys: string[]) => Promise<void>;
  /** Whether a session picker is up: the Reader then leaves it out of
   * its own answer buttons. */
  onPicking: (picking: boolean) => void;
  statusOpen: boolean;
  statusRequest: number;
  onStatusRequest: () => void;
  onStatusClose: () => void;
}) {
  const t = useT();
  const status = live.status;
  const [limits, setLimits] = useState<LimitMeters>({});
  const [readAt, setReadAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible || tab.kind !== "agent") return;
    let stopped = false;
    const poll = () => {
      void readAgentUsage(tab.cmd).then((report) => {
        if (stopped) return;
        if (!report.supported) {
          stopped = true;
          return;
        }
        if (!report.raw) return;
        const next = limitMeters(parseUsageReport(report.raw));
        if (!next.session && !next.week) return;
        setLimits(next);
        setReadAt(Date.now());
      });
    };
    poll();
    const timer = setInterval(() => { if (!stopped) poll(); }, LIMITS_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [visible, tab.kind, tab.cmd]);

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(clock);
  }, [visible]);

  // --- The session's model / permission picker -------------------------------
  const session = useSessionPicker({ tab, ptyId, agentLabel, typeKeys });
  const { picking, picker, step, shownStep, busy, choose, close } = session;
  const permissionPicking = picking && session.command === "/permissions";
  const modelPicking = picking && !permissionPicking;
  const codex = isCodexCommand(tab.cmd);
  useEffect(() => { onPicking(picking); }, [picking, onPicking]);

  const openPicker = (command: "/model" | "/permissions" = "/model") => {
    if (picking) return;
    onStatusClose();
    closeModes();
    closeEffort();
    session.open(command);
  };

  // --- The permission mode ---------------------------------------------------
  const [modeOpen, setModeOpen] = useState(false);
  const [switching, setSwitching] = useState("");
  const [switchFailed, setSwitchFailed] = useState("");
  /** The status line as the pane draws it right now — read straight off the
   * screen, since the Reader's own reading may lag a settling redraw. */
  const readStatus = () => {
    const term = terminalFor(ptyId);
    return term ? sessionStatus(readableScreen(term.buffer.active).lines, agentLabel) : status;
  };
  const modeWalk = useRef(0);
  const modes = modeChoices(status?.mode, agentLabel);
  const activeMode = currentMode(modes, status?.mode, status != null);
  const fixedMode = modeFixed(agentLabel);
  const shiftTab = shiftTabKey(agentLabel);
  useEffect(() => () => { modeWalk.current += 1; }, []);
  const closeModes = () => {
    modeWalk.current += 1;
    setSwitching("");
    setModeOpen(false);
  };
  const openModes = () => {
    if (codex) {
      if (permissionPicking) close();
      else openPicker("/permissions");
      return;
    }
    onStatusClose();
    if (modeOpen) {
      closeModes();
      return;
    }
    if (modes.length === 0 && !fixedMode) {
      void typeKeys([shiftTab]).catch(() => {});
      return;
    }
    closeEffort();
    setSwitchFailed("");
    setModeOpen(true);
  };
  /** Walks the Shift+Tab cycle to `value`, reading the redrawn status line
   * after every press — the phone's walk: no cycle order is assumed, and a
   * full lap back to the start ends it as a failed switch. */
  const applyMode = async (value: string) => {
    if (switching || fixedMode) return;
    const before = readStatus();
    const start = before?.mode;
    if (currentMode(modes, start, before != null) === value) {
      setModeOpen(false);
      return;
    }
    const walk = modeWalk.current + 1;
    modeWalk.current = walk;
    setSwitchFailed("");
    setSwitching(value);
    for (let step = 0; step < MODE_CYCLE_LIMIT; step += 1) {
      const pressed = await typeKeys([shiftTab]).then(() => true, () => false);
      if (!pressed) break;
      await new Promise((resolve) => { setTimeout(resolve, MODE_SETTLE_MS); });
      if (modeWalk.current !== walk) return;
      const after = readStatus();
      const now = after?.mode;
      if (currentMode(modes, now, after != null) === value) {
        setSwitching("");
        setModeOpen(false);
        return;
      }
      if (step > 0 && now !== undefined && now === start) break;
    }
    if (modeWalk.current !== walk) return;
    setSwitching("");
    setSwitchFailed(value);
  };

  // --- The reasoning effort ------------------------------------------------
  const claude = isClaudeCommand(tab.cmd);
  const [effortOpen, setEffortOpen] = useState(false);
  const [effortSending, setEffortSending] = useState("");
  const [effortFailed, setEffortFailed] = useState(false);
  const closeEffort = () => {
    setEffortOpen(false);
    setEffortSending("");
  };
  /** Claude takes the level as `/effort <level>`; every other CLI sets it on
   * its `/model` picker's next step, so that picker opens instead. */
  const openEffort = () => {
    if (!claude) {
      openPicker();
      return;
    }
    onStatusClose();
    if (effortOpen) {
      closeEffort();
      return;
    }
    close();
    closeModes();
    setEffortFailed(false);
    setEffortOpen(true);
  };
  const chooseEffort = (level: string) => {
    if (effortSending) return;
    if (!tab.scheduleTargetId) {
      setEffortFailed(true);
      return;
    }
    setEffortFailed(false);
    setEffortSending(level);
    void submitScheduledAgentCommand(tab.scheduleTargetId, `/effort ${level}`).then(
      () => {
        onEffortPicked(level);
        closeEffort();
      },
      () => {
        setEffortSending("");
        setEffortFailed(true);
      },
    );
  };

  const contextLeft = status?.context ?? (usage?.contextLeft != null ? `${usage.contextLeft}%` : undefined);
  const clock = new Date(now);
  const fromPanel = !!(limits.session || limits.week);
  const shown = fromPanel ? limits : sessionLimits(usage, clock);
  const readTime = fromPanel ? new Date(readAt) : clock;
  const limitFact = (meter: LimitMeters["session"], key: "mobile.facts.session" | "mobile.facts.week") => {
    if (!meter) return null;
    const left = meter.resets ? resetCountdown(meter.resets, clock, readTime) : "";
    return (
      <span
        className={meter.percent >= 90 ? "terminal-reader-fact high" : "terminal-reader-fact"}
        title={meter.resets ? resetText(meter.resets, clock, readTime) : undefined}
      >
        {t(key, { percent: Math.round(100 - meter.percent) })}
        {left && <> · {t("mobile.facts.resetIn", { time: left })}</>}
      </span>
    );
  };
  const modelLabel = status?.model ?? modelTag;
  const effortLabel = status?.effort ?? effort;
  const modeLabel = modes.find((choice) => choice.value === activeMode)?.label ?? status?.mode;
  const shownPath = status?.path ?? path;
  const worktree = worktreeOfPath(shownPath);
  const failedMode = modes.find((choice) => choice.value === switchFailed);

  return (
    <div className="terminal-reader-facts-wrap">
      {statusOpen && tab.cmd === "codex" && <TerminalReaderStatus key={ptyId}
        tab={tab} ptyId={ptyId} visible={visible} request={statusRequest}
        canRefresh={!live.working && !live.question && !picking && !modeOpen}
        model={modelLabel} effort={effortLabel} path={shownPath} contextLeft={contextLeft} usage={usage}
        onClose={onStatusClose} onRefresh={onStatusRequest}
      />}
      {picking && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={shownStep?.title ?? t(permissionPicking ? "terminal.reader.modeTitle" : "terminal.reader.modelTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{shownStep?.title ?? t(permissionPicking ? "terminal.reader.modeTitle" : "terminal.reader.modelTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={close} aria-label={t(permissionPicking ? "terminal.reader.modeClose" : "terminal.reader.modelClose")} title={t(permissionPicking ? "terminal.reader.modeClose" : "terminal.reader.modelClose")}>✕</button>
          </div>
          {shownStep ? (
            <div className="terminal-reader-options">
              {shownStep.options.map((option) => (
                <button
                  key={`${option.index}:${option.label}`}
                  type="button"
                  className={picker && option.index === picker.current ? "terminal-reader-option current" : "terminal-reader-option"}
                  disabled={busy}
                  onClick={() => choose(option.index)}
                >
                  <span className="terminal-reader-option-number">{option.number}</span>
                  <span className="terminal-reader-option-label">
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <small className="terminal-reader-question-more">{t(permissionPicking ? "terminal.reader.permissionsWaiting" : "terminal.reader.modelWaiting")}</small>
          )}
          {step?.hidden ? <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small> : null}
        </div>
      )}
      {effortOpen && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={t("terminal.reader.effortTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeEffort(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{t("terminal.reader.effortTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={closeEffort} aria-label={t("terminal.reader.effortClose")} title={t("terminal.reader.effortClose")}>✕</button>
          </div>
          <div className="terminal-reader-options">
            {CLAUDE_EFFORTS.map((level, index) => (
              <button
                key={level}
                type="button"
                className={level === effortLabel ? "terminal-reader-option current" : "terminal-reader-option"}
                disabled={!!effortSending}
                aria-busy={level === effortSending}
                onClick={() => chooseEffort(level)}
              >
                <span className="terminal-reader-option-number">{level === effortSending ? "…" : index + 1}</span>
                <span className="terminal-reader-option-label">
                  <span>{level === "auto" ? t("terminal.reader.effortAuto") : t("terminal.reader.effort", { effort: level })}</span>
                </span>
              </button>
            ))}
          </div>
          {effortFailed && <small className="terminal-reader-question-more" role="alert">{t("terminal.reader.effortFailed")}</small>}
          <small className="terminal-reader-question-more">{t("terminal.reader.effortNote")}</small>
        </div>
      )}
      {modeOpen && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={t("terminal.reader.modeTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeModes(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{t("terminal.reader.modeTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={closeModes} aria-label={t("terminal.reader.modeClose")} title={t("terminal.reader.modeClose")}>✕</button>
          </div>
          <div className="terminal-reader-options">
            {modes.map((choice, index) => (
              <button
                key={choice.value}
                type="button"
                className={choice.value === activeMode ? "terminal-reader-option current" : "terminal-reader-option"}
                disabled={fixedMode || !!switching}
                aria-busy={choice.value === switching}
                onClick={() => void applyMode(choice.value)}
              >
                <span className="terminal-reader-option-number">{choice.value === switching ? "…" : index + 1}</span>
                <span className="terminal-reader-option-label"><span>{choice.label}</span></span>
              </button>
            ))}
          </div>
          {failedMode && <small className="terminal-reader-question-more" role="alert">{t("terminal.reader.modeFailed", { mode: failedMode.label })}</small>}
          {fixedMode && <small className="terminal-reader-question-more">{t("terminal.reader.modeFixed")}</small>}
        </div>
      )}
      <div className="terminal-reader-facts">
        {tab.cmd === "codex" && <button type="button" className="terminal-reader-fact-model"
          onClick={statusOpen ? onStatusClose : () => { close(); closeModes(); closeEffort(); onStatusRequest(); }}
          aria-haspopup="dialog" aria-expanded={statusOpen} title={t("terminal.reader.status.hint")}>
          {t("terminal.reader.status.button")} <UntestedTag id="terminal.reader.codexStatus" />
        </button>}
        <button
          type="button"
          className="terminal-reader-fact-model"
          onClick={() => modelPicking ? close() : openPicker()}
          disabled={!modelPicking && (!!live.working || !!live.question || picking)}
          aria-haspopup="dialog"
          aria-expanded={modelPicking}
          title={t("terminal.reader.modelHint")}
        >
          {modelLabel ?? t("terminal.reader.model")}
        </button>
        {(effortLabel || claude) && (
          <button
            type="button"
            className="terminal-reader-fact-model"
            onClick={claude ? openEffort : modelPicking ? close : openEffort}
            disabled={claude ? !effortOpen && (!!live.question || picking) : !modelPicking && (!!live.working || !!live.question || picking)}
            aria-haspopup="dialog"
            aria-expanded={claude ? effortOpen : modelPicking}
            title={t(claude ? "terminal.reader.effortHint" : "terminal.reader.effortModelHint")}
          >
            {effortLabel ? t("terminal.reader.effort", { effort: effortLabel }) : t("terminal.reader.effortUnknown")}
            <UntestedTag id="terminal.reader.effortPick" />
          </button>
        )}
        {tab.kind === "agent" && (
          <button
            type="button"
            className={status?.mode === "plan" ? "terminal-reader-fact-model plan" : "terminal-reader-fact-model"}
            onClick={openModes}
            disabled={codex ? !permissionPicking && (!!live.working || !!live.question || picking) : !modeOpen && (!!live.question || picking)}
            aria-haspopup={codex || modes.length > 0 || fixedMode ? "dialog" : undefined}
            aria-expanded={codex ? permissionPicking : modes.length > 0 || fixedMode ? modeOpen : undefined}
            title={t(codex ? "terminal.reader.permissionsHint" : modes.length > 0 || fixedMode ? "terminal.reader.modeHint" : "terminal.reader.modeCycle")}
          >
            {modeLabel ?? t("terminal.reader.mode")}
            {codex && <UntestedTag id="terminal.reader.permissionsPick" />}
          </button>
        )}
        <UntestedTag id="terminal.reader.facts" />
        <UntestedTag id="terminal.reader.factsMore" />
        {shownPath && <span className="terminal-reader-fact" title={shownPath}>{shortPath(shownPath)}</span>}
        {worktree && <span className="terminal-reader-fact worktree" title={t("terminal.reader.worktreeHint")}>{t("terminal.reader.worktree", { name: worktree })}</span>}
        {status?.branch && <span className="terminal-reader-fact">⎇ {status.branch}</span>}
        {contextLeft && <span className="terminal-reader-fact">{t("terminal.reader.contextLeft", { percent: contextLeft })}</span>}
        {limitFact(shown.session, "mobile.facts.session")}
        {limitFact(shown.week, "mobile.facts.week")}
      </div>
    </div>
  );
}
