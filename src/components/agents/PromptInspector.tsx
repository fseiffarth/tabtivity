import { useEffect, useRef, useState } from "react";
import { formatTags, parseTags } from "../../lib/agents/prompt/tags";
import { promptStateChip } from "../../lib/agents/prompt/stateChip";
import { sentFactLine } from "../../lib/agents/prompt/cardFacts";
import type { PromptLiveState } from "../../lib/agents/prompt/outcome";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { formatTimelineInstant } from "../../lib/agents/prompt/timeline";
import type { PromptLink } from "../../stores/agents/agentPrompts";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { MarkdownPromptField } from "../common/MarkdownPromptField";
import { UntestedTag } from "../common/UntestedTag";
import { CheckIcon, CloseIcon } from "../common/icons/Icon";
import { AgentScheduleProposal } from "./AgentScheduleProposal";
import { PromptAgentPick, type PromptCardTarget } from "./PromptAgentPick";
import { PromptLimitWarning, PromptPhoneChip, stateFact, type LimitNotice } from "./PromptCard";

interface Props {
  projectId?: string;
  card: PromptChartCard;
  /** The card's whole session, oldest first, when it is one of several sent
   *  prompts of a session: the inspector then lists them all. */
  session?: PromptChartCard[];
  /** The card's turn is running, or waiting for an answer, right now. */
  live?: PromptLiveState;
  now?: Date;
  limit?: LimitNotice;
  onMoveAfterReset?: () => void;
  /** The prompt is open in the editor (a double click on its card opens the
   *  inspector already editing, so the chart owns this). */
  editing: boolean;
  onEditing: (editing: boolean) => void;
  /** Moves focus to the heading each time it changes (Enter on a card). */
  focusToken: number;
  retimeEarlierDisabled?: boolean;
  /** The tab's colour, worn by the dot before its name. */
  color?: string;
  targets: PromptCardTarget[];
  targetLabel?: string;
  targetBlocked?: string;
  newTabLabel?: string;
  links: PromptLink[];
  /** A short reading of the card at the other end of a link. */
  linkLabel: (id: string) => string;
  onAgent: (targetId: string) => Promise<void>;
  onSave: (message: string, tags: string[]) => Promise<void>;
  onDelete: () => Promise<void>;
  onSend: () => void;
  onSchedule: () => void;
  onUnschedule: () => Promise<void>;
  onCollect: () => Promise<void>;
  onRetime: (minutes: number) => Promise<void>;
  onQueueMove: (step: -1 | 1) => Promise<void>;
  onLink: () => void;
  onUnlink: (linkId: string) => Promise<void>;
  /** Open a link's editor (its kind, the commands between the prompts) at a client point. */
  onEditLink?: (link: PromptLink, x: number, y: number) => void;
  onGoToTab?: () => void;
  /** A session view's per-prompt actions. */
  onCollectCard: (card: PromptChartCard) => Promise<void>;
  onDeleteCard: (card: PromptChartCard) => Promise<void>;
  onClose: () => void;
}

/**
 * The selected card, in full, in the chart's right column. It replaces the
 * body that used to open inside a card: nothing grows inside the timeline any
 * more, so a lane never has to make room for an editor. A sent card shows what
 * its turn did; a draft, a rule or a queued prompt shows what can be done to
 * it. A session of several sent prompts lists them all.
 */
export function PromptInspector({
  projectId,
  card,
  session,
  live,
  now,
  limit,
  onMoveAfterReset,
  editing,
  onEditing,
  focusToken,
  retimeEarlierDisabled,
  color,
  targets,
  targetLabel,
  targetBlocked,
  newTabLabel,
  links,
  linkLabel,
  onAgent,
  onSave,
  onDelete,
  onSend,
  onSchedule,
  onUnschedule,
  onCollect,
  onRetime,
  onQueueMove,
  onLink,
  onUnlink,
  onEditLink,
  onGoToTab,
  onCollectCard,
  onDeleteCard,
  onClose,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const when = (at: Date | null | undefined) => (at ? formatTimelineInstant(at, lang, use24h) : "");
  const heading = useRef<HTMLHeadingElement>(null);
  const [message, setMessage] = useState(card.message);
  const [tags, setTags] = useState(formatTags(card.tags));
  const [copied, setCopied] = useState(false);
  const storedTags = formatTags(card.tags);
  const readOnly = card.state === "sent";
  const chip = promptStateChip(card, links, live);
  const liveFact = live && now ? { state: live, now } : undefined;
  const ownLinks = links.filter((link) => link.from === card.id || link.to === card.id);
  const canSend = targets.length > 0 || (card.state === "draft" && !!newTabLabel);
  const sessionId = card.history?.session_id;

  useEffect(() => {
    setMessage(card.message);
    setTags(storedTags);
  }, [card.message, storedTags]);
  useEffect(() => {
    if (focusToken > 0) heading.current?.focus();
  }, [focusToken]);

  const save = async () => {
    if (!message.trim()) return;
    try {
      await onSave(message.trim(), parseTags(tags));
      onEditing(false);
    } catch { /* the chart reports it; the editor keeps the text */ }
  };
  const cancelEdit = () => {
    setMessage(card.message);
    setTags(storedTags);
    onEditing(false);
  };
  const copySession = (id: string) => {
    void navigator.clipboard?.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const timeRow = (
    <div className="agent-prompt-inspector-when">
      {card.schedule && !card.recurring && (
        <button className="settings-btn sm" type="button" disabled={retimeEarlierDisabled} aria-label={t("promptChart.fiveMinutesEarlier")} title={t("promptChart.fiveMinutesEarlier")} onClick={() => void onRetime(-5)}>−5</button>
      )}
      <span className="agent-prompt-inspector-when-text">{stateFact(card, t, when)}</span>
      {card.schedule && !card.recurring && (
        <button className="settings-btn sm" type="button" aria-label={t("promptChart.fiveMinutesLater")} title={t("promptChart.fiveMinutesLater")} onClick={() => void onRetime(5)}>+5</button>
      )}
      {card.state === "queued" && (
        <>
          <button className="settings-btn sm" type="button" aria-label={t("promptChart.queueEarlier")} title={t("promptChart.queueEarlier")} onClick={() => void onQueueMove(-1)}>↑</button>
          <button className="settings-btn sm" type="button" aria-label={t("promptChart.queueLater")} title={t("promptChart.queueLater")} onClick={() => void onQueueMove(1)}>↓</button>
        </>
      )}
      {card.schedule && card.recurring && <button className="settings-btn sm" type="button" onClick={onSchedule}>{t("promptChart.editRule")}</button>}
    </div>
  );

  return (
    <aside className="agent-prompt-inspector" aria-label={t("promptChart.inspector")} data-testid="prompt-chart-inspector">
      <div className="agent-prompt-inspector-head">
        <span className={`agent-prompt-chip is-${chip.tone}`}>{t(chip.key, chip.params)}</span>
        <UntestedTag id="promptChart.inspector" />
        <div className="agent-prompt-bar-spacer" />
        <button className="settings-btn sm is-icon" type="button" aria-label={t("promptChart.closeInspector")} title={t("promptChart.closeInspector")} onClick={onClose}><CloseIcon /></button>
      </div>

      {session ? (
        <>
          <h4 className="agent-prompt-inspector-label" tabIndex={-1} ref={heading}>{t("promptChart.sessionPrompts", { count: session.length })}</h4>
          {sessionId && (
            <button className="agent-prompt-session" type="button" onClick={() => copySession(sessionId)}>
              {copied ? <><CheckIcon />{" "}</> : "⧉ "}{t("promptChart.session", { id: sessionId })}
            </button>
          )}
          <ol className="agent-prompt-session-list">
            {[...session].reverse().map((item) => {
              const itemChip = promptStateChip(item, [], item.id === card.id ? live : undefined);
              return (
                <li key={item.key} data-testid="prompt-chart-session-row">
                  <div className="agent-prompt-session-row-head">
                    <span className={`agent-prompt-chip is-${itemChip.tone}`}>{t(itemChip.key)}</span>
                    <small>{when(item.at)}</small>
                    <PromptPhoneChip row={item.history} />
                  </div>
                  <p className="agent-prompt-card-full">{item.message}</p>
                  {(item.history?.files?.length ?? 0) > 0 && (
                    <ul className="agent-prompt-files">
                      {item.history?.files?.map((file) => <li key={file}>{file}</li>)}
                    </ul>
                  )}
                  <div className="agent-prompt-card-actions">
                    <button className="settings-btn sm" type="button" onClick={() => void onCollectCard(item)}>{t("promptChart.collectAgain")}</button>
                    <button className="settings-btn sm danger" type="button" onClick={() => void onDeleteCard(item)}>{t("common.delete")}</button>
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="agent-prompt-inspector-actions">
            {onGoToTab && <button className="settings-btn sm" type="button" onClick={onGoToTab}>{t("agentPrompts.jump")}</button>}
            <button className="settings-btn sm" type="button" onClick={onLink}>{t("promptChart.link")}</button>
          </div>
        </>
      ) : (
        <>
          <div className="agent-prompt-inspector-field">
            <h4 className="agent-prompt-inspector-label" tabIndex={-1} ref={heading}>{t("promptChart.promptLabel")}</h4>
            {editing ? (
              <>
                <MarkdownPromptField
                  rows={6}
                  autoFocus
                  value={message}
                  ariaLabel={t("agentPrompts.placeholder")}
                  onChange={setMessage}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); cancelEdit(); }
                    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void save(); }
                  }}
                />
                <input value={tags} aria-label={t("agentPrompts.tags")} placeholder={t("agentPrompts.tagsPlaceholder")} onChange={(event) => setTags(event.target.value)} />
                <div className="agent-prompt-card-actions">
                  <button className="settings-btn sm primary" type="button" onClick={() => void save()}>{t("common.save")}</button>
                  <button className="settings-btn sm" type="button" onClick={cancelEdit}>{t("common.cancel")}</button>
                </div>
              </>
            ) : (
              <p className="agent-prompt-card-full" data-testid="prompt-chart-inspector-prompt">{card.message}</p>
            )}
          </div>

          {limit && <PromptLimitWarning limit={limit} onMove={onMoveAfterReset} />}

          {projectId && card.targetId && card.schedule?.origin && <AgentScheduleProposal projectId={projectId} targetId={card.targetId} schedule={card.schedule} />}

          <dl className="agent-prompt-inspector-grid">
            <dt>{t("promptChart.window")}</dt>
            <dd>{timeRow}</dd>
            {card.state === "sent" && sentFactLine([card], t, liveFact) && (
              <>
                <dt>{t("promptChart.outcome")}</dt>
                <dd data-testid="prompt-chart-inspector-outcome">{sentFactLine([card], t, liveFact)} <UntestedTag id="promptChart.outcome" /></dd>
              </>
            )}
            <dt>{t("promptChart.agent")}</dt>
            <dd>
              <PromptAgentPick
                className="agent-prompt-inspector-agent"
                card={card}
                color={color}
                targets={targets}
                targetLabel={targetLabel}
                targetBlocked={targetBlocked}
                newTabLabel={newTabLabel}
                onAgent={onAgent}
              />
            </dd>
            {(card.tags.length > 0 || card.autoTags.length > 0) && (
              <>
                <dt>{t("agentPrompts.tags")}</dt>
                <dd className="agent-prompt-card-tags">
                  {card.tags.map((tag) => <span key={`stored:${tag}`} className="agent-prompt-tag">#{tag}</span>)}
                  {card.autoTags.map((tag) => <span key={`auto:${tag}`} className="agent-prompt-tag is-auto">#{tag}</span>)}
                </dd>
              </>
            )}
          </dl>

          {(card.history?.schedule_origin || card.history?.phone_device) && (
            <div className="agent-schedule-attribution">
              {card.history.schedule_origin && <span className="agent-schedule-pill" title={card.history.schedule_origin.session}>{t("scheduleMcp.authored")}</span>}
              {card.history.schedule_origin?.from_delivery && <small>{t("scheduleMcp.lineage", { id: card.history.schedule_origin.from_delivery })}</small>}
              <PromptPhoneChip row={card.history} />
            </div>
          )}

          {sessionId && (
            <button className="agent-prompt-session" type="button" onClick={() => copySession(sessionId)}>
              {copied ? <><CheckIcon />{" "}</> : "⧉ "}{t("promptChart.session", { id: sessionId })}
            </button>
          )}
          {(card.history?.files?.length ?? 0) > 0 && (
            <ul className="agent-prompt-files">
              {card.history?.files?.map((file) => <li key={file}>{file}</li>)}
            </ul>
          )}

          {ownLinks.length > 0 && (
            <div className="agent-prompt-inspector-links">
              {ownLinks.map((link) => (
                <div key={link.id} className="agent-prompt-link-row">
                  <span>
                    {link.from === card.id ? (link.kind === "after" ? "→ " : "— ") : (link.kind === "after" ? "← " : "— ")}
                    {linkLabel(link.from === card.id ? link.to : link.from)}
                    {link.kind === "after" && (link.preface?.length ?? 0) > 0 && <em> · {link.preface!.join(" · ")}</em>}
                  </span>
                  {onEditLink && (
                    <button
                      type="button"
                      className="agent-composer-chip"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect();
                        onEditLink(link, rect.left, rect.bottom);
                      }}
                    >{t("common.edit")}</button>
                  )}
                  <button type="button" className="agent-composer-chip" onClick={() => void onUnlink(link.id)}>{t("common.remove")}</button>
                </div>
              ))}
            </div>
          )}

          <div className="agent-prompt-inspector-actions">
            {canSend && <button className="settings-btn sm primary" type="button" onClick={onSend}>{t("agentPrompts.send")}</button>}
            {(card.state === "draft" || card.state === "chained") && <button className="settings-btn sm" type="button" onClick={onSchedule}>{t("agentPrompts.schedule")}</button>}
            {card.state === "sent" && <button className="settings-btn sm" type="button" onClick={() => void onCollect()}>{t("promptChart.collectAgain")}</button>}
            {!readOnly && !editing && <button className="settings-btn sm" type="button" onClick={() => onEditing(true)}>{t("common.edit")}</button>}
            {card.schedule && <button className="settings-btn sm" type="button" onClick={() => void onUnschedule()}>{t("promptChart.unschedule")}</button>}
            {onGoToTab && <button className="settings-btn sm" type="button" onClick={onGoToTab}>{t("agentPrompts.jump")}</button>}
            <button className="settings-btn sm" type="button" onClick={onLink}>{t("promptChart.link")}</button>
            <button className="settings-btn sm danger agent-prompt-inspector-delete" type="button" onClick={() => void onDelete()}>{t("common.delete")}</button>
          </div>
        </>
      )}
    </aside>
  );
}
