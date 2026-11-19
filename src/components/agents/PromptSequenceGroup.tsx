import type { ReactNode } from "react";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { formatPromptDuration, sentFactLine } from "../../lib/agents/prompt/cardFacts";
import type { PromptLiveState } from "../../lib/agents/prompt/outcome";
import { nextPendingStep, type PromptSequence, type SequenceStep } from "../../lib/agents/prompt/sequences";
import { formatTimelineInstant, promptEndedAt } from "../../lib/agents/prompt/timeline";
import type { PromptLink } from "../../stores/agents/agentPrompts";
import { UntestedTag } from "../common/UntestedTag";
import { CloseIcon, PauseIcon, PlayIcon, SkipForwardIcon, StopIcon } from "../common/icons/Icon";

/** The sequence's one-line standing, as the group header and the inspector say it. */
function useSequenceStanding(sequence: PromptSequence): string {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const first = sequence.steps[0].card;
  switch (sequence.status) {
    case "paused": return t("promptChart.seq.paused");
    case "stopped": return t("promptChart.seq.stopped");
    case "done": return t("promptChart.seq.done");
    case "running": return t("promptChart.seq.stepOf", { n: sequence.current, of: sequence.steps.length });
    default:
      // Nothing has gone out: say when it starts, if it has a minute.
      return first.state === "scheduled" && first.at
        ? t("promptChart.seq.starts", { time: formatTimelineInstant(first.at, lang, use24h, true) })
        : sequence.done > 0
          ? t("promptChart.seq.stepOf", { n: sequence.current, of: sequence.steps.length })
          : t("promptChart.seq.notStarted");
  }
}

/** Pause while the next step is held back by nothing, Resume while it is. */
export function sequencePauseState(sequence: PromptSequence): "pause" | "resume" | null {
  if (sequence.steps.some((step) => step.status === "paused")) return "resume";
  return nextPendingStep(sequence) && sequence.status !== "stopped" ? "pause" : null;
}

/**
 * The heading of a sequence in the Drafts column: "Sequence · N steps", where
 * it stands, and Pause or Resume. Clicking the title selects the sequence in
 * the inspector.
 */
export function PromptSequenceHeader({ sequence, active, onOpen, onPauseToggle }: {
  sequence: PromptSequence;
  active: boolean;
  onOpen: () => void;
  onPauseToggle: () => void;
}) {
  const t = useT();
  const standing = useSequenceStanding(sequence);
  const pause = sequencePauseState(sequence);
  return (
    <div className={`agent-prompt-sequence-head is-${sequence.status}${active ? " is-selected" : ""}`} data-testid="prompt-sequence-head">
      <button type="button" className="agent-prompt-sequence-title" aria-pressed={active} title={t("promptChart.seq.open")} onClick={onOpen}>
        <strong>{t("promptChart.seq.title", { count: sequence.steps.length })}</strong>
        <span data-testid="prompt-sequence-standing">{standing}</span>
      </button>
      <UntestedTag id="promptChart.sequences" />
      {pause && (
        <button type="button" className="settings-btn sm agent-prompt-bar-btn" onClick={onPauseToggle}>
          {pause === "pause" ? <PauseIcon /> : <PlayIcon />}
          {pause === "pause" ? t("promptChart.seq.pause") : t("promptChart.seq.resume")}
        </button>
      )}
    </div>
  );
}

/** A sequence member that lives on the timeline (sent, scheduled, queued): a
 *  one-line row in the group that selects its card. */
export function PromptSequenceRow({ step, selected, onPick }: { step: SequenceStep; selected: boolean; onPick: () => void }) {
  const t = useT();
  return (
    <button type="button" className={`agent-prompt-sequence-row is-${step.status}${selected ? " is-selected" : ""}`} data-testid="prompt-sequence-row" onClick={onPick}>
      <span className="agent-prompt-sequence-num">{step.n}</span>
      <span className="agent-prompt-sequence-text">{step.card.message}</span>
      <small>{t(`promptChart.seq.stepStatus.${step.status}` as "promptChart.seq.stepStatus.done")}</small>
    </button>
  );
}

/** The group of a sequence in the List layout. */
export function PromptSequenceGroup({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <section className="agent-prompt-sequence" data-testid="prompt-sequence">
      {header}
      <div className="agent-prompt-sequence-steps">{children}</div>
    </section>
  );
}

/** The outline drawn around a sequence's draft cards on the Free canvas. */
export function PromptSequenceOutline({ box, header }: { box: { left: number; top: number; width: number; height: number }; header: ReactNode }) {
  return (
    <div className="agent-prompt-sequence-outline" data-testid="prompt-sequence-outline" style={box}>
      {header}
    </div>
  );
}

/** What one step is doing, in a line. */
function useStepLine(step: SequenceStep, live: ReadonlyMap<string, PromptLiveState>, now: Date): string {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const { card } = step;
  const agent = card.autoTags.find((tag) => tag.startsWith("agent:"))?.slice(6) ?? card.history?.agent ?? "";
  const when = (at: Date | null | undefined) => (at ? formatTimelineInstant(at, lang, use24h, false) : "");
  switch (step.status) {
    case "done": {
      const ended = promptEndedAt(card);
      const facts = sentFactLine([card], t);
      return [t("promptChart.seq.line.done", { time: when(ended ?? card.at) }), facts].filter(Boolean).join(" · ");
    }
    case "running": {
      const state = live.get(card.id);
      const so = card.at ? formatPromptDuration(Math.max(0, now.getTime() - card.at.getTime()), t) : "";
      return state === "needsAnswer"
        ? t("promptChart.seq.line.needsAnswer", { agent })
        : t("promptChart.seq.line.running", { agent, duration: so });
    }
    case "paused": return t("promptChart.seq.line.paused");
    case "stopped":
      return card.state === "sent"
        ? sentFactLine([card], t)
        : t("promptChart.seq.line.stopped");
    case "next":
      if (card.state === "scheduled") return t("promptChart.seq.line.scheduled", { time: when(card.at) });
      if (card.state === "queued") return t("promptChart.waiting");
      return t("promptChart.seq.line.next", { n: step.n - 1 });
    default:
      return t("promptChart.seq.line.waiting", { agent });
  }
}

function StepRow({ step, live, now, onPick }: {
  step: SequenceStep;
  live: ReadonlyMap<string, PromptLiveState>;
  now: Date;
  onPick: () => void;
}) {
  const line = useStepLine(step, live, now);
  return (
    <button type="button" className={`agent-prompt-seq-step is-${step.status}`} data-testid="prompt-sequence-step" onClick={onPick}>
      <span className="agent-prompt-sequence-num">{step.n}</span>
      <span className="agent-prompt-seq-step-body">
        <span className="agent-prompt-seq-step-message">{step.card.message}</span>
        <small>{line}</small>
      </span>
    </button>
  );
}

/**
 * The sequence as a whole, in the chart's right column: progress, the three
 * commands (Pause or Resume, Skip next step, Stop), each step with one line of
 * what it is doing, and the commands typed between two prompts.
 */
export function PromptSequenceInspector({ sequence, live, now, onPickStep, onPauseToggle, onSkip, onStop, onEditLink, onClose }: {
  sequence: PromptSequence;
  live: ReadonlyMap<string, PromptLiveState>;
  now: Date;
  onPickStep: (step: SequenceStep) => void;
  onPauseToggle: () => void;
  onSkip: () => void;
  onStop: () => void;
  /** Open an edge's editor (its commands) at a client point. */
  onEditLink: (link: PromptLink, x: number, y: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const standing = useSequenceStanding(sequence);
  const pause = sequencePauseState(sequence);
  const pending = nextPendingStep(sequence);
  const total = sequence.steps.length;
  return (
    <aside className="agent-prompt-inspector agent-prompt-sequence-inspector" aria-label={t("promptChart.seq.inspector")} data-testid="prompt-sequence-inspector">
      <div className="agent-prompt-inspector-head">
        <strong>{t("promptChart.seq.name")}</strong>
        <span className="agent-prompt-tag">{t("promptChart.seq.steps", { count: total })}</span>
        <UntestedTag id="promptChart.sequences" />
        <div className="agent-prompt-bar-spacer" />
        <button className="settings-btn sm is-icon" type="button" aria-label={t("promptChart.closeInspector")} title={t("promptChart.closeInspector")} onClick={onClose}><CloseIcon /></button>
      </div>
      <div className="agent-prompt-seq-progress">
        <div className="agent-prompt-seq-segments" role="img" aria-label={t("promptChart.seq.progress", { done: sequence.done, total, running: sequence.running })}>
          {sequence.steps.map((step) => <span key={step.card.key} className={`is-${step.status}`} />)}
        </div>
        <small data-testid="prompt-sequence-summary">
          {t("promptChart.seq.summary", { done: sequence.done, running: sequence.running, pending: sequence.pending })} · {standing}
        </small>
      </div>
      <div className="agent-prompt-inspector-actions agent-prompt-seq-actions">
        {pause && (
          <button type="button" className="settings-btn sm" onClick={onPauseToggle}>
            {pause === "pause" ? <PauseIcon /> : <PlayIcon />}
            {pause === "pause" ? t("promptChart.seq.pause") : t("promptChart.seq.resume")}
          </button>
        )}
        <button type="button" className="settings-btn sm" disabled={!pending} onClick={onSkip}><SkipForwardIcon />{t("promptChart.seq.skip")}</button>
        <button type="button" className="settings-btn sm danger" disabled={!pending} onClick={onStop}><StopIcon />{t("promptChart.seq.stop")}</button>
      </div>
      <ol className="agent-prompt-seq-steps">
        {sequence.steps.map((step) => (
          <li key={step.card.key}>
            {step.edge && (
              <div className="agent-prompt-seq-between">
                <small>{t("promptChart.seq.between")}</small>
                <code>{(step.edge.preface?.length ?? 0) > 0 ? step.edge.preface!.join(" · ") : t("promptChart.seq.noCommands")}</code>
                <button
                  type="button"
                  className="agent-composer-chip"
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onEditLink(step.edge!, rect.left, rect.bottom);
                  }}
                >{t("common.edit")}</button>
              </div>
            )}
            <StepRow step={step} live={live} now={now} onPick={() => onPickStep(step)} />
          </li>
        ))}
      </ol>
      <p className="agent-prompt-seq-note">{t("promptChart.seq.note")}</p>
    </aside>
  );
}
