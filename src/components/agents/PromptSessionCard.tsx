import type { PointerEvent as ReactPointerEvent } from "react";
import { toDateStr } from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { formatTimelineInstant, promptEndedAt } from "../../lib/agents/prompt/timeline";
import { sentFactLine } from "../../lib/agents/prompt/cardFacts";
import { promptStateChip } from "../../lib/agents/prompt/stateChip";
import { CARD_OWN_KEYS } from "./PromptCard";
import { PromptAgentPick } from "./PromptAgentPick";

interface Props {
  /** The session's sent prompts inside the window, oldest first. */
  cards: PromptChartCard[];
  /** Each prompt's distance in px from the card's left edge. */
  offsets: number[];
  /** Keys of the cards the chart's filter matches. */
  matchedKeys: Set<string>;
  selected: boolean;
  /** Part of the timeline's multi-selection. */
  multiSelected?: boolean;
  /** Ctrl/⌘ + click: add the card to the selection or take it out. */
  onToggleSelect?: () => void;
  linking: boolean;
  linkOver: boolean;
  color: string;
  register?: (node: HTMLElement | null) => void;
  onSelect: () => void;
  /** Enter or Space: the inspector takes focus. */
  onOpen?: () => void;
  /** Lifts the card up or down its lane (`usePromptChartDrag`'s lift). */
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onLink: () => void;
  /** The duration bar on the top edge, first prompt to last finish. */
  bar?: { anchor: "left" | "right"; width: number };
}

/**
 * Every prompt one session was sent, as one card: it spans the axis from the
 * first prompt to the last with a tick at each and reads the newest on its
 * face; selecting it lists them all in the inspector. Sent prompts are
 * history, so nothing here is dragged. The node is registered under every
 * member's id, so a link to any of them draws to this card.
 */
export function PromptSessionCard({
  cards,
  offsets,
  matchedKeys,
  selected,
  multiSelected,
  onToggleSelect,
  linking,
  linkOver,
  color,
  register,
  onSelect,
  onOpen,
  onPointerDown,
  onPortPointerDown,
  onLink,
  bar,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const when = (at: Date | null, withDate = true) => (at ? formatTimelineInstant(at, lang, use24h, withDate) : "");
  const first = cards[0];
  const latest = cards[cards.length - 1];
  // A session that runs past midnight says so: "23:10 – 01:40" alone reads
  // as a span that ends before it starts.
  const ended = promptEndedAt(latest);
  const end = ended ?? latest.at;
  const crossesDay = !!first.at && !!end && toDateStr(first.at) !== toDateStr(end);
  const chip = promptStateChip(latest);
  const className = [
    "agent-prompt-card todo-card is-sent is-session",
    cards.some((card) => matchedKeys.has(card.key)) ? "" : "is-dimmed",
    selected ? "is-selected" : "",
    multiSelected ? "is-multi-selected" : "",
    linking ? "is-link-target" : "",
    linkOver ? "is-link-over" : "",
  ].filter(Boolean).join(" ");

  return (
    <article
      ref={register}
      className={className}
      data-prompt-card={latest.id}
      data-testid="prompt-chart-session"
      style={{ "--prompt-strand": color } as React.CSSProperties}
      tabIndex={0}
      role="button"
      aria-pressed={selected}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target !== event.currentTarget && (event.target as Element).closest(CARD_OWN_KEYS)) return;
        event.preventDefault();
        onSelect();
        onOpen?.();
      }}
      onClick={(event) => {
        if (onToggleSelect && (event.ctrlKey || event.metaKey)) { onToggleSelect(); return; }
        onSelect();
      }}
      onPointerDown={onPointerDown}
    >
      <span className="agent-prompt-card-port is-in" aria-hidden="true" />
      {bar && <span className={`agent-prompt-card-bar is-${bar.anchor}`} style={{ width: bar.width }} aria-hidden="true" />}
      <div className="agent-prompt-card-top">
        <span className="agent-prompt-card-time">{when(first.at, crossesDay)} – {when(end, crossesDay)}</span>
        <span className={`agent-prompt-chip is-${chip.tone}`}>{t(chip.key)}</span>
      </div>
      <div className="agent-prompt-card-head">
        <span className="agent-prompt-card-message">{latest.message}</span>
      </div>
      <small className="agent-prompt-card-fact">{sentFactLine(cards, t)}</small>
      <PromptAgentPick card={latest} targets={[]} targetLabel={latest.history?.tab_label || undefined} onAgent={async () => {}} />
      <div className="agent-prompt-session-ticks" aria-hidden="true">
        {cards.map((card, index) => (
          <span
            key={card.key}
            className={`agent-prompt-session-tick is-${card.history?.result ?? "delivered"}`}
            style={{ left: offsets[index] ?? 0 }}
          />
        ))}
      </div>
      <button
        className="agent-prompt-card-port is-out"
        type="button"
        data-no-drag
        aria-label={t("promptChart.linkFrom")}
        title={t("promptChart.linkFrom")}
        onPointerDown={onPortPointerDown}
        onClick={(event) => { event.stopPropagation(); onLink(); }}
      />

    </article>
  );
}
