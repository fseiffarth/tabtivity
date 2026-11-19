import type { PointerEvent as ReactPointerEvent } from "react";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { localWallClock } from "../../lib/agents/agentSchedule";
import { AgentScheduleProposal } from "./AgentScheduleProposal";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { formatTimelineInstant } from "../../lib/agents/prompt/timeline";
import type { SentAgentPrompt } from "../../stores/agents/agentPrompts";
import { UntestedTag } from "../common/UntestedTag";
import { CloseIcon } from "../common/icons/Icon";
import { PromptAgentPick, type PromptCardTarget } from "./PromptAgentPick";

export type { PromptCardTarget } from "./PromptAgentPick";

/** Inside a card, keys aimed at these belong to them, not to the card. */
export const CARD_OWN_KEYS = "input, textarea, select, button, [contenteditable]";

interface Props {
  projectId?: string;
  card: PromptChartCard;
  matched: boolean;
  selected: boolean;
  /** Click-to-link is armed and this card is a candidate target. */
  linking: boolean;
  /** This card is the one being carried; the ghost stands in for it. */
  dragging: boolean;
  /** A link pulled out of another card's port hovers this one. */
  linkOver: boolean;
  /** A later occurrence of a recurring rule: read-only, no ports, unregistered. */
  occurrence?: string;
  /** The instant this card is drawn at on the axis. A recurring rule's first
   *  drawn occurrence in a future window is not `card.at` (the next one from
   *  now), so the fact line prints this one — the one under the card. */
  drawnAt?: Date;
  /** Part of the timeline's multi-selection. */
  multiSelected?: boolean;
  /** Ctrl/⌘ + click: add the card to the selection or take it out. Absent
   *  where a card cannot be selected (the strip, the queue). */
  onToggleSelect?: () => void;
  /** The stripe colour of the tab the card is aimed at. */
  color: string;
  /** The live agent tabs a card can be aimed at. */
  targets: PromptCardTarget[];
  /** What a sent card shows instead of a picker: the tab it went to. */
  targetLabel?: string;
  /** The tab a draft is aimed at, when that tab already holds a scheduled
   *  prompt: the picker no longer lists it, and the card says why. */
  targetBlocked?: string;
  /** For a draft: the picker's first, default choice — a new agent tab
   *  running the chart's agent (`lib/agents/prompt/newTab`). Its value is the
   *  empty target, so an unaimed draft selects it, and Send opens the tab. */
  newTabLabel?: string;
  register?: (node: HTMLElement | null) => void;
  /** A click, Enter or Space: select the card (the chart's inspector shows it). */
  onSelect: () => void;
  /** Enter or Space: the reader means to work on it, so the inspector takes focus. */
  onOpen?: () => void;
  /** A double click: select the card and open the inspector already editing. */
  onEdit?: () => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onAgent: (targetId: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onLink: () => void;
}

/** The card's one line of fact. Its instants are written by the chart's own
 *  clock (`formatTimelineInstant`): the app's language and 12/24-hour
 *  setting, matching the axis above the card. */
export function stateFact(
  card: PromptChartCard,
  t: ReturnType<typeof useT>,
  when: (at: Date | null | undefined) => string,
  occurrence?: string,
  drawnAt?: Date,
): string {
  if (card.state === "queued") return t("promptChart.waiting");
  if (card.state === "chained") {
    if (card.chainStopped) return t("promptChart.chainClosed");
    const commands = card.chainLink?.preface ?? [];
    return commands.length
      ? t("promptChart.chainedPreface", { commands: commands.join(" · ") })
      : t("promptChart.chained");
  }
  if (card.state === "sent") {
    const result = card.history?.result ?? "delivered";
    return `${t(`promptChart.result.${result}` as "promptChart.result.delivered")} · ${when(card.at)}`;
  }
  if (card.state === "scheduled") {
    if (occurrence) return `↻ ${when(localWallClock(occurrence)) || occurrence.replace("T", " ")}`;
    const at = drawnAt ?? card.at;
    return at
      ? `${card.recurring ? "↻ " : ""}${when(at)}`
      : t("promptChart.paused");
  }
  return t("promptChart.draft");
}

export function PromptCard({
  projectId,
  card,
  matched,
  selected,
  linking,
  dragging,
  linkOver,
  occurrence,
  drawnAt,
  multiSelected,
  onToggleSelect,
  color,
  targets,
  targetLabel,
  targetBlocked,
  newTabLabel,
  register,
  onSelect,
  onOpen,
  onEdit,
  onPointerDown,
  onPortPointerDown,
  onAgent,
  onDelete,
  onLink,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const when = (at: Date | null | undefined) => (at ? formatTimelineInstant(at, lang, use24h) : "");
  const readOnly = card.state === "sent" || !!occurrence;
  /** A card on the drafts strip deletes from its face, without selecting. */
  const quickDelete = !occurrence && (card.state === "draft" || card.state === "chained");
  const className = [
    "agent-prompt-card todo-card",
    `is-${card.state}`,
    matched ? "" : "is-dimmed",
    selected ? "is-selected" : "",
    multiSelected ? "is-multi-selected" : "",
    linking ? "is-link-target" : "",
    dragging ? "is-dragging" : "",
    linkOver ? "is-link-over" : "",
    occurrence ? "is-occurrence" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      ref={occurrence ? undefined : register}
      className={className}
      data-prompt-card={occurrence ? undefined : card.id}
      data-testid={`prompt-chart-card-${card.state}`}
      data-agent-authored={card.schedule?.origin || card.history?.schedule_origin ? "true" : undefined}
      style={{ "--prompt-strand": color } as React.CSSProperties}
      // The keyboard route: a card is reached with Tab and selected with Enter
      // or Space, which moves focus to its inspector.
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        // A key typed into one of the card's own controls is that control's.
        if (event.target !== event.currentTarget && (event.target as Element).closest(CARD_OWN_KEYS)) return;
        event.preventDefault();
        onSelect();
        onOpen?.();
      }}
      onClick={(event) => {
        if (onToggleSelect && (event.ctrlKey || event.metaKey)) { onToggleSelect(); return; }
        onSelect();
      }}
      // A double click is the way into the editor: its first click has already
      // selected the card; one on a control (the × on the face) stays that control's.
      onDoubleClick={(event) => {
        if (readOnly || (event.target as HTMLElement).closest("button, input, textarea, .dropdown")) return;
        onEdit?.();
      }}
      onPointerDown={onPointerDown}
    >
      {!occurrence && <span className="agent-prompt-card-port is-in" aria-hidden="true" />}
      <div className={`agent-prompt-card-head${quickDelete ? " has-delete" : ""}`}>
        <span className="agent-prompt-card-message">{card.message}</span>
        {quickDelete && (
          <button
            className="agent-prompt-card-delete"
            type="button"
            aria-label={t("promptChart.deleteDraft")}
            title={t("promptChart.deleteDraft")}
            onClick={(event) => { event.stopPropagation(); void onDelete(); }}
          ><CloseIcon /></button>
        )}
        <span className={`agent-prompt-lamp is-${card.history?.result ?? card.state}`} aria-hidden="true" />
      </div>
      {projectId && card.targetId && card.schedule?.origin && <AgentScheduleProposal projectId={projectId} targetId={card.targetId} schedule={card.schedule} />}
      {(card.history?.schedule_origin || card.history?.phone_device) && <div className="agent-schedule-attribution">
        {card.history.schedule_origin && <span className="agent-schedule-pill" title={card.history.schedule_origin.session}>{t("scheduleMcp.authored")}</span>}
        {card.history.schedule_origin?.from_delivery && <small>{t("scheduleMcp.lineage", { id: card.history.schedule_origin.from_delivery })}</small>}
        <PromptPhoneChip row={card.history} />
      </div>}
      <PromptAgentPick
        card={card}
        occurrence={occurrence}
        targets={targets}
        targetLabel={targetLabel}
        targetBlocked={targetBlocked}
        newTabLabel={newTabLabel}
        onAgent={onAgent}
      />
      <div className="agent-prompt-card-tags">
        {card.tags.map((tag) => <span key={`stored:${tag}`} className="agent-prompt-tag">#{tag}</span>)}
        {card.autoTags.map((tag) => <span key={`auto:${tag}`} className="agent-prompt-tag is-auto">#{tag}</span>)}
      </div>
      <small className="agent-prompt-card-fact">{stateFact(card, t, when, occurrence, drawnAt)}</small>
      {!occurrence && (
        <button
          className="agent-prompt-card-port is-out"
          type="button"
          data-no-drag
          aria-label={t("promptChart.linkFrom")}
          title={t("promptChart.linkFrom")}
          onPointerDown={onPortPointerDown}
          onClick={(event) => { event.stopPropagation(); onLink(); }}
        />
      )}
    </article>
  );
}

/** The paired phone a sent prompt came from, as the row named it when it was
 * written; nothing for a prompt from the desktop. */
export function PromptPhoneChip({ row }: { row?: SentAgentPrompt }) {
  const t = useT();
  if (!row?.phone_device) return null;
  const name = row.phone_name ?? t("promptChart.fromUnpairedPhone");
  return <span className="agent-schedule-pill" data-testid="prompt-phone-chip" title={t("promptChart.fromPhoneTitle", { name })}>📱 {name} <UntestedTag id="promptChart.fromPhoneTitle" /></span>;
}
