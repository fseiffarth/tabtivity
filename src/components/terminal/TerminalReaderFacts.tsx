import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { readAgentUsage } from "../../lib/agents/agentUsage";
import type { ReaderLive } from "../../lib/agents/readerLive";
import { submitScheduledAgentCommand } from "../../lib/agents/scheduledAgentInput";
import { shortPath } from "../../lib/agents/agentReader";
import {
  agentSwitchChoices,
  CARRIES_CONVERSATION,
  sameDir,
  worktreeName,
  worktreeOfPath,
  type GitWorktree,
} from "../../lib/agents/agentWorktrees";
import { RESUMABLE_AGENTS } from "../../lib/agents/agentClis";
import { splitPtyId } from "../../lib/terminal/ptyId";
import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { switchAgentWorktree } from "../../stores/agents/agentWorktreeSwitch";
import { terminalFor } from "../../lib/terminal/terminalRegistry";
import { isClaudeCommand, isCodexCommand } from "../../lib/terminal/terminalControl";
import { UntestedTag } from "../common/UntestedTag";
import { storageKey } from "../../lib/brand";
import { formatTokens } from "../../lib/tokenStats";
import { formatCacheWriteUsd, formatIdleTime, useAgentResumeCostStore } from "../../stores/agents/agentResumeCost";
import { isOpenCodeTab } from "../../../mobile-web/src/terminal/openCodeMini";
import { groupOpenCodeModels, openCodeModelGroupTitle } from "../../../mobile-web/src/terminal/openCodeModelGroups";
import type { TabEntry } from "../../stores/tabs";
import type { SessionUsage } from "../../../mobile-web/src/api";
import { resetCountdown, resetText } from "../../../mobile-web/src/terminal/limitResets";
import { currentMode, modeChoices, modeFixed, shiftTabKey } from "../../../mobile-web/src/terminal/agentModes";
import { readableScreen } from "../../../mobile-web/src/terminal/readableScreen";
import { sessionStatus } from "../../../mobile-web/src/terminal/statusLine";
import { sessionLimits } from "../../../mobile-web/src/terminal/sessionUsage";
import { limitMeters, parseUsageReport, type LimitMeters } from "../../../shared/usageReport";
import { STATUS_AGENTS, TerminalReaderStatus } from "./TerminalReaderStatus";
import { usePoll, type PollRun } from "../../lib/usePoll";
import { CLAUDE_EFFORTS, modelPickOffered, useSessionPicker } from "../../hooks/useSessionPicker";
import { assistantModelChoices, assistantOptions } from "../../lib/assistant";
import { switchAssistantModel } from "../../stores/assistantScope";

/** The tab's label for its move from the worktree `from` to `to`: the "+"
 * menu's `<agent> · <branch>` names the new branch (none in the project
 * folder); a label the user gave stays as it is. */
function movedTabLabel(label: string, from: GitWorktree | undefined, to: GitWorktree, t: ReturnType<typeof useT>): string {
  const branchOf = (w: GitWorktree) => w.branch || worktreeName(w.path);
  const oldTail = from && !from.is_main ? t("newTabMenu.agentWorktreeLabel", { agent: "", branch: branchOf(from) }) : "";
  if (from && !from.is_main && !label.endsWith(oldTail)) return label;
  const base = oldTail ? label.slice(0, -oldTail.length) : label;
  return to.is_main ? base : t("newTabMenu.agentWorktreeLabel", { agent: base, branch: branchOf(to) });
}

/** The phone's pacing: how often the CLI's usage panel is read again (the
 * backend floors it besides), and how often the reset countdowns tick. */
const LIMITS_POLL_MS = 120_000;
/** Whether the limit facts show as bars rather than percentages: a click on
 * either one flips both, and the choice outlives the pane. */
const LIMIT_BARS_KEY = storageKey("readerLimitBars");

function readLimitBars(): boolean {
  try {
    return localStorage.getItem(LIMIT_BARS_KEY) === "1";
  } catch {
    return false;
  }
}
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
 * step it is), and the folder the agent works in with the worktree it is —
 * the branch chip moves the agent to another worktree of the project
 * (`switchAgentWorktree`), its conversation along where its CLI allows. The status facts
 * come off the pane's live screen (`ReaderLive.status`); the limits from the
 * CLI's usage panel (`agent_usage`, which spends no quota), or — Codex, which
 * has none — from the figures its rollout stores.
 */
export function TerminalReaderFacts({ tab, ptyId, agentLabel, live, modelTag, usage, path, effort, onEffortPicked, visible, typeKeys, onPicking, statusOpen, statusRequest, onStatusRequest, onStatusClose, chipSlot }: {
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
  /** Takes the row's end, where the composer portals its chip row. */
  chipSlot?: (slot: HTMLDivElement | null) => void;
}) {
  const t = useT();
  const resumeCost = useAgentResumeCostStore((state) => state.byPty[ptyId]);
  const status = live.status;
  const [limits, setLimits] = useState<LimitMeters>({});
  const [readAt, setReadAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [limitBars, setLimitBars] = useState(readLimitBars);
  const toggleLimitBars = () => {
    const next = !limitBars;
    setLimitBars(next);
    try {
      localStorage.setItem(LIMIT_BARS_KEY, next ? "1" : "0");
    } catch {
      // Storage unavailable: the view still flips for this pane.
    }
  };

  // An agent without a usage recipe answers unsupported once: no more asking
  // until the view is shown again or the tab's command changes. (Declared
  // before the poll so a re-show clears it before the poll starts.)
  const limitsUnsupported = useRef(false);
  useEffect(() => {
    limitsUnsupported.current = false;
  }, [visible, tab.kind, tab.cmd]);
  const pollLimits = useCallback((poll: PollRun) => {
    if (limitsUnsupported.current) return;
    return readAgentUsage(tab.cmd).then((report) => {
      if (poll.stopped) return;
      if (!report.supported) {
        limitsUnsupported.current = true;
        return;
      }
      if (!report.raw) return;
      const next = limitMeters(parseUsageReport(report.raw));
      if (!next.session && !next.week) return;
      setLimits(next);
      setReadAt(Date.now());
    });
  }, [tab.cmd]);
  // While the Reader shows, with the window in front (`usePoll`).
  usePoll(pollLimits, LIMITS_POLL_MS, { enabled: visible && tab.kind === "agent" });

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => clearInterval(clock);
  }, [visible]);

  // --- The session's model / permission picker -------------------------------
  const session = useSessionPicker({ tab, ptyId, agentLabel, typeKeys });
  const { picking, picker, step, shownStep, busy, listing, choose, close } = session;
  const permissionPicking = picking && session.command === "/permissions";
  const modelPicking = picking && !permissionPicking;
  const codex = isCodexCommand(tab.cmd);
  const modelPickable = modelPickOffered(tab);
  const groupModels = modelPicking && isOpenCodeTab(agentLabel) && shownStep?.title === "Select model";
  const modelGroups = shownStep
    ? groupModels ? groupOpenCodeModels(shownStep.options) : [{ key: "all", options: shownStep.options }]
    : [];
  useEffect(() => { onPicking(picking); }, [picking, onPicking]);

  const openPicker = (command: "/model" | "/permissions" = "/model") => {
    if (picking) return;
    onStatusClose();
    closeModes();
    closeEffort();
    closeWorktrees();
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
    // The footer is the bottom of the screen, and `sessionStatus` reads words
    // only: a screenful or two, no per-cell style walk.
    return term ? sessionStatus(readableScreen(term.buffer.active, 120, { plain: true }).lines, agentLabel) : status;
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
    closeAssistantModels();
    closeWorktrees();
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
    closeAssistantModels();
    closeWorktrees();
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

  // --- A Tabby chat's model ----------------------------------------------
  // Its slash commands are off (`--disable-slash-commands`), so neither
  // `/model` nor `/effort` reaches the session: the model is the chat's launch,
  // and a pick restarts the chat on it (`switchAssistantModel`), resumed.
  const assistantLaunch = tab.assistant;
  const [assistantOpen, setAssistantOpen] = useState(false);
  /** `null` while the choices are read. */
  const [assistantModels, setAssistantModels] = useState<string[] | null>(null);
  const [assistantSwitching, setAssistantSwitching] = useState("");
  const [assistantFailed, setAssistantFailed] = useState(false);
  const closeAssistantModels = () => {
    setAssistantOpen(false);
    setAssistantSwitching("");
  };
  const openAssistantModels = () => {
    if (!assistantLaunch) return;
    if (assistantOpen) {
      closeAssistantModels();
      return;
    }
    onStatusClose();
    closeModes();
    closeEffort();
    closeWorktrees();
    setAssistantFailed(false);
    setAssistantModels(null);
    setAssistantOpen(true);
    void assistantOptions().then(
      (options) => {
        const cli = options.clis.find((c) => c.id === assistantLaunch.cli);
        setAssistantModels(cli ? assistantModelChoices(cli, options) : []);
      },
      () => setAssistantModels([]),
    );
  };
  const chooseAssistantModel = (model: string) => {
    if (assistantSwitching) return;
    if (model === assistantLaunch?.model) {
      closeAssistantModels();
      return;
    }
    setAssistantFailed(false);
    setAssistantSwitching(model);
    void switchAssistantModel(tab.key, model).then((switched) => {
      if (switched) {
        closeAssistantModels();
        return;
      }
      setAssistantSwitching("");
      setAssistantFailed(true);
    });
  };

  // --- The worktree the agent works in --------------------------------------
  // Local projects only, and only an agent whose conversation a restart
  // resumes: the move is a respawn in the new folder.
  const scope = splitPtyId(ptyId)?.scope ?? "";
  const project = useProjectsStore((state) => state.projects.find((p) => p.id === scope));
  const projectDir = project && !project.remote && !project.vm?.enabled ? resolveProjectDirectory(project) : "";
  const worktreeMovable = tab.kind === "agent" && !assistantLaunch && !!tab.sessionId
    && (tab.cmd in RESUMABLE_AGENTS || !!tab.resumeArgs?.length) && !!projectDir;
  const [worktreesOpen, setWorktreesOpen] = useState(false);
  /** `null` while the worktrees are read. */
  const [worktrees, setWorktrees] = useState<GitWorktree[] | null>(null);
  const [worktreeSwitching, setWorktreeSwitching] = useState("");
  const [worktreeFailed, setWorktreeFailed] = useState(false);
  const closeWorktrees = () => {
    setWorktreesOpen(false);
    setWorktreeSwitching("");
  };
  const openWorktrees = () => {
    if (worktreesOpen) {
      closeWorktrees();
      return;
    }
    onStatusClose();
    close();
    closeModes();
    closeEffort();
    closeAssistantModels();
    setWorktreeFailed(false);
    setWorktrees(null);
    setWorktreesOpen(true);
    void invoke<GitWorktree[]>("git_worktree_list", { projectDir, site: "mirror" }).then(
      (list) => setWorktrees(agentSwitchChoices(list ?? [], projectDir)),
      () => setWorktrees([]),
    );
  };
  const chooseWorktree = (wt: GitWorktree) => {
    if (worktreeSwitching) return;
    if (sameDir(wt.path, tab.cwd)) {
      closeWorktrees();
      return;
    }
    const from = worktrees?.find((w) => sameDir(w.path, tab.cwd));
    setWorktreeFailed(false);
    setWorktreeSwitching(wt.path);
    void switchAgentWorktree(scope, tab, wt.path, movedTabLabel(tab.label, from, wt, t)).then((result) => {
      if (result !== "failed") {
        closeWorktrees();
        return;
      }
      setWorktreeSwitching("");
      setWorktreeFailed(true);
    });
  };

  const contextLeft = status?.context ?? (usage?.contextLeft != null ? `${usage.contextLeft}%` : undefined);
  const clock = new Date(now);
  const fromPanel = !!(limits.session || limits.week);
  const shown = fromPanel ? limits : sessionLimits(usage, clock);
  const readTime = fromPanel ? new Date(readAt) : clock;
  const limitFact = (meter: LimitMeters["session"], key: "mobile.facts.session" | "mobile.facts.week") => {
    if (!meter) return null;
    const left = meter.resets ? resetCountdown(meter.resets, clock, readTime) : "";
    const remaining = Math.max(0, Math.min(100, 100 - meter.percent));
    const percentText = t(key, { percent: Math.round(remaining) });
    return (
      <button
        type="button"
        className={`terminal-reader-fact terminal-reader-limit${meter.percent >= 90 ? " high" : ""}`}
        onClick={toggleLimitBars}
        aria-pressed={limitBars}
        aria-label={limitBars ? percentText : undefined}
        title={[meter.resets ? resetText(meter.resets, clock, readTime) : "", t("mobile.facts.limitToggle")].filter(Boolean).join("\n")}
      >
        {limitBars ? <>
          {t(key === "mobile.facts.session" ? "mobile.facts.sessionLabel" : "mobile.facts.weekLabel")}
          <span className="terminal-reader-limit-bar" aria-hidden="true"><span style={{ width: `${remaining}%` }} /></span>
        </> : percentText}
        {left && <> · {t("mobile.facts.resetIn", { time: left })}</>}
      </button>
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
      {statusOpen && STATUS_AGENTS[tab.cmd] && !(assistantLaunch && claude) && <TerminalReaderStatus key={ptyId}
        tab={tab} ptyId={ptyId} agentLabel={agentLabel} visible={visible} request={statusRequest}
        canRefresh={!live.working && !live.question && !picking && !modeOpen}
        model={modelLabel} effort={effortLabel} path={shownPath} contextLeft={contextLeft} usage={usage}
        limits={shown} limitsReadAt={readTime.getTime()}
        onClose={onStatusClose} onRefresh={onStatusRequest}
      />}
      {picking && (
        <div
          className="terminal-reader-picker terminal-reader-picker-steps"
          role="dialog"
          aria-label={shownStep?.title ?? t(permissionPicking ? "terminal.reader.modeTitle" : "terminal.reader.modelTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{shownStep?.title ?? t(permissionPicking ? "terminal.reader.modeTitle" : "terminal.reader.modelTitle")}</strong>
            {isOpenCodeTab(agentLabel) && <UntestedTag id="agents.opencode.modelList" />}
            <button type="button" className="terminal-reader-picker-close" onClick={close} aria-label={t(permissionPicking ? "terminal.reader.modeClose" : "terminal.reader.modelClose")} title={t(permissionPicking ? "terminal.reader.modeClose" : "terminal.reader.modelClose")}>✕</button>
          </div>
          {shownStep ? (
            <div className="terminal-reader-options">
              {modelGroups.map((group) => <div className="terminal-reader-option-group" key={group.key}>
                {groupModels && <div className="terminal-reader-option-group-title">{openCodeModelGroupTitle(group, t)}</div>}
                {group.options.map((option) => (
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
              </div>)}
            </div>
          ) : (
            <small className="terminal-reader-question-more">{t(permissionPicking ? "terminal.reader.permissionsWaiting" : "terminal.reader.modelWaiting")}</small>
          )}
          {listing
            ? <small className="terminal-reader-question-more">{t("terminal.reader.modelListing")}</small>
            : step?.hidden ? <small className="terminal-reader-question-more">{t("terminal.reader.moreChoices")}</small> : null}
        </div>
      )}
      {assistantOpen && assistantLaunch && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={t("terminal.reader.modelTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeAssistantModels(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{t("terminal.reader.modelTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={closeAssistantModels} aria-label={t("terminal.reader.modelClose")} title={t("terminal.reader.modelClose")}>✕</button>
          </div>
          {assistantModels === null ? (
            <small className="terminal-reader-question-more">{t("terminal.reader.assistantModelLoading")}</small>
          ) : assistantModels.length === 0 ? (
            <small className="terminal-reader-question-more">{t("terminal.reader.assistantModelNone")}</small>
          ) : (
            <div className="terminal-reader-options">
              {assistantModels.map((model, index) => (
                <button
                  key={model}
                  type="button"
                  className={model === assistantLaunch.model ? "terminal-reader-option current" : "terminal-reader-option"}
                  disabled={!!assistantSwitching}
                  aria-busy={model === assistantSwitching}
                  onClick={() => chooseAssistantModel(model)}
                >
                  <span className="terminal-reader-option-number">{model === assistantSwitching ? "…" : index + 1}</span>
                  <span className="terminal-reader-option-label"><span>{model}</span></span>
                </button>
              ))}
            </div>
          )}
          {assistantFailed && <small className="terminal-reader-question-more" role="alert">{t("terminal.reader.assistantModelFailed")}</small>}
          <small className="terminal-reader-question-more">{t("terminal.reader.assistantModelNote")}</small>
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
      {worktreesOpen && (
        <div
          className="terminal-reader-picker"
          role="dialog"
          aria-label={t("terminal.reader.worktreeTitle")}
          onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeWorktrees(); } }}
        >
          <div className="terminal-reader-picker-head">
            <strong>{t("terminal.reader.worktreeTitle")}</strong>
            <button type="button" className="terminal-reader-picker-close" onClick={closeWorktrees} aria-label={t("terminal.reader.worktreeClose")} title={t("terminal.reader.worktreeClose")}>✕</button>
          </div>
          {worktrees === null ? (
            <small className="terminal-reader-question-more">{t("terminal.reader.worktreeLoading")}</small>
          ) : worktrees.length === 0 ? (
            <small className="terminal-reader-question-more">{t("terminal.reader.worktreeNone")}</small>
          ) : (
            <div className="terminal-reader-options">
              {worktrees.map((wt, index) => (
                <button
                  key={wt.path}
                  type="button"
                  className={sameDir(wt.path, tab.cwd) ? "terminal-reader-option current" : "terminal-reader-option"}
                  disabled={!!worktreeSwitching}
                  aria-busy={wt.path === worktreeSwitching}
                  title={wt.path}
                  onClick={() => chooseWorktree(wt)}
                >
                  <span className="terminal-reader-option-number">{wt.path === worktreeSwitching ? "…" : index + 1}</span>
                  <span className="terminal-reader-option-label">
                    <span>{wt.branch || worktreeName(wt.path)}</span>
                    <small>{wt.is_main ? t("terminal.reader.worktreeMain") : t("terminal.reader.worktree", { name: worktreeName(wt.path) })}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
          {worktreeFailed && <small className="terminal-reader-question-more" role="alert">{t("terminal.reader.worktreeFailed")}</small>}
          <small className="terminal-reader-question-more">
            {t(CARRIES_CONVERSATION.has(tab.cmd) ? "terminal.reader.worktreeCarries" : "terminal.reader.worktreeFresh", { agent: agentLabel })}
          </small>
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
        {STATUS_AGENTS[tab.cmd] && !(assistantLaunch && claude) && <button type="button" className="terminal-reader-fact-model"
          onClick={statusOpen ? onStatusClose : () => { close(); closeModes(); closeEffort(); closeWorktrees(); onStatusRequest(); }}
          aria-haspopup="dialog" aria-expanded={statusOpen} title={t("terminal.reader.status.hint", { agent: agentLabel })}>
          {t("terminal.reader.status.button")} {tab.cmd === "claude" ? <UntestedTag id="terminal.reader.claudeStatus" /> : <UntestedTag id="terminal.reader.codexStatus" />}
        </button>}
        {assistantLaunch ? (
          <button
            type="button"
            className="terminal-reader-fact-model"
            onClick={openAssistantModels}
            disabled={!assistantOpen && (!!live.working || !!live.question || picking)}
            aria-haspopup="dialog"
            aria-expanded={assistantOpen}
            title={t("terminal.reader.assistantModelHint")}
          >
            {modelLabel ?? assistantLaunch.model ?? t("terminal.reader.model")}
            <UntestedTag id="assistant.modelSwitch" />
          </button>
        ) : modelPickable ? (
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
        ) : modelLabel && <span className="terminal-reader-fact">{modelLabel}</span>}
        {/* Outside Claude the effort is set on the model picker's next step,
            so a local-model tab, which has no picker, only shows it. */}
        {(!claude && !modelPickable) || assistantLaunch ? (
          effortLabel && <span className="terminal-reader-fact">{t("terminal.reader.effort", { effort: effortLabel })}</span>
        ) : (effortLabel || claude) && (
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
        {tab.cmd === "opencode" && <UntestedTag id="agents.opencode.v2" />}
        <UntestedTag id="terminal.reader.facts" />
        <UntestedTag id="terminal.reader.factsMore" />
        {shownPath && <span className="terminal-reader-fact terminal-reader-fact-path" title={shownPath}>{shortPath(shownPath)}</span>}
        {worktree && <span className="terminal-reader-fact worktree" title={t("terminal.reader.worktreeHint")}>{t("terminal.reader.worktree", { name: worktree })}</span>}
        {worktreeMovable ? (
          <button
            type="button"
            className="terminal-reader-fact-model"
            onClick={openWorktrees}
            disabled={!worktreesOpen && (!!live.working || !!live.question || picking)}
            aria-haspopup="dialog"
            aria-expanded={worktreesOpen}
            title={t("terminal.reader.worktreeSwitchHint")}
          >
            ⎇ {status?.branch ?? t("terminal.reader.worktreeButton")}
            <UntestedTag id="terminal.reader.worktreeSwitch" />
          </button>
        ) : status?.branch && <span className="terminal-reader-fact">⎇ {status.branch}</span>}
        {contextLeft && <span className="terminal-reader-fact">{t("terminal.reader.contextLeft", { percent: contextLeft })}</span>}
        {resumeCost && (
          <span
            className="terminal-reader-fact high"
            title={t("terminal.reader.resumeColdHint", { idle: formatIdleTime(resumeCost.secondsIdle) })}
          >
            {t("terminal.reader.resumeCold", {
              tokens: formatTokens(resumeCost.contextTokens),
              cost: formatCacheWriteUsd(resumeCost.cacheWriteUsd),
            })}
            <UntestedTag id="terminal.reader.resumeCold" />
          </span>
        )}
        {limitFact(shown.session, "mobile.facts.session")}
        {limitFact(shown.week, "mobile.facts.week")}
        {(shown.session || shown.week) && <UntestedTag id="terminal.reader.limitBars" />}
      </div>
      <div className="terminal-reader-facts-chips" ref={chipSlot} />
    </div>
  );
}
