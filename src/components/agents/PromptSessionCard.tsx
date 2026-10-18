import { useState, type PointerEvent as ReactPointerEvent } from "react";
import { toDateStr } from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import { formatTimelineInstant } from "../../lib/agents/prompt/timeline";
import { CARD_OWN_KEYS, PromptPhoneChip } from "./PromptCard";

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
  /** Lifts the card up or down its lane (`usePromptChartDrag`'s lift). */
  onPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPortPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onLink: () => void;
  onCollect: (card: PromptChartCard) => Promise<void>;
  onDelete: (card: PromptChartCard) => Promise<void>;
  onGoToTab?: () => void;
}

/**
 * Every prompt one session was sent, as one card: it spans the axis from the
 * first prompt to the last with a tick at each, reads the newest on its face,
 * and lists them all — newest first — when opened. Sent prompts are history,
 * so nothing here is dragged; each row keeps what a sent card offers (collect
 * again, delete), and the card as a whole links and jumps to its tab. The
 * node is registered under every member's id, so a link to any of them draws
 * to this card.
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
  onPointerDown,
  onPortPointerDown,
  onLink,
  onCollect,
  onDelete,
  onGoToTab,
}: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const when = (at: Date | null, withDate = true) => (at ? formatTimelineInstant(at, lang, use24h, withDate) : "");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const first = cards[0];
  const latest = cards[cards.length - 1];
  const sessionId = latest.history?.session_id;
  // A session that runs past midnight says so: "23:10 – 01:40" alone reads
  // as a span that ends before it starts.
  const crossesDay = !!first.at && !!latest.at && toDateStr(first.at) !== toDateStr(latest.at);
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
      aria-expanded={expanded}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        if (event.target !== event.currentTarget && (event.target as Element).closest(CARD_OWN_KEYS)) return;
        event.preventDefault();
        onSelect();
        setExpanded((value) => !value);
      }}
      onClick={(event) => {
        if (onToggleSelect && (event.ctrlKey || event.metaKey)) { onToggleSelect(); return; }
        onSelect();
        setExpanded((value) => !value);
      }}
      onPointerDown={onPointerDown}
    >
      <span className="agent-prompt-card-port is-in" aria-hidden="true" />
      <div className="agent-prompt-card-head">
        <span className="agent-prompt-card-message">{latest.message}</span>
        <span className={`agent-prompt-lamp is-${latest.history?.result ?? latest.state}`} aria-hidden="true" />
      </div>
      <div className="agent-prompt-card-agent">
        <small>{latest.history?.tab_label || t("promptChart.noAgent")}</small>
      </div>
      <small className="agent-prompt-card-fact">
        {t("promptChart.sessionPrompts", { count: cards.length })} · {when(first.at, crossesDay)} – {when(latest.at, crossesDay)}
      </small>
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

      {expanded && (
        <div className="agent-prompt-card-expanded" onClick={(event) => event.stopPropagation()}>
          {sessionId && (
            <button
              className="agent-prompt-session"
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(sessionId);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "✓ " : "⧉ "}{t("promptChart.session", { id: sessionId })}
            </button>
          )}
          <ol className="agent-prompt-session-list">
            {[...cards].reverse().map((card) => (
              <li key={card.key} className={matchedKeys.has(card.key) ? "" : "is-dimmed"} data-testid="prompt-chart-session-row">
                <div className="agent-prompt-session-row-head">
                  <span className={`agent-prompt-lamp is-${card.history?.result ?? "delivered"}`} aria-hidden="true" />
                  <small>{t(`promptChart.result.${card.history?.result ?? "delivered"}` as "promptChart.result.delivered")} · {when(card.at)}</small>
                  <PromptPhoneChip row={card.history} />
                </div>
                <p className="agent-prompt-card-full">{card.message}</p>
                {(card.history?.files?.length ?? 0) > 0 && (
                  <ul className="agent-prompt-files">
                    {card.history?.files?.map((file) => <li key={file}>{file}</li>)}
                  </ul>
                )}
                <div className="agent-prompt-card-actions">
                  <button className="settings-btn sm" type="button" onClick={() => void onCollect(card)}>{t("promptChart.collectAgain")}</button>
                  <button className="settings-btn sm danger" type="button" onClick={() => void onDelete(card)}>{t("common.delete")}</button>
                </div>
              </li>
            ))}
          </ol>
          <div className="agent-prompt-card-actions">
            {onGoToTab && <button className="settings-btn sm" type="button" onClick={onGoToTab}>{t("agentPrompts.jump")}</button>}
            <button className="settings-btn sm" type="button" onClick={onLink}>{t("promptChart.link")}</button>
          </div>
        </div>
      )}
    </article>
  );
}
