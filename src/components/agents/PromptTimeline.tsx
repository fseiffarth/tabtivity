import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { formatTime, weekdayLabel } from "../../lib/calendar/calendarTime";
import { useI18nStore, useT } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import type { PromptChartCard } from "../../lib/agents/prompt/chart";
import type { UsageResetMark } from "../../lib/agents/agentUsageResets";
import {
  TIMELINE_CARD_WIDTH,
  TIMELINE_LANE_HEIGHT,
  TIMELINE_MIN_LANES,
  TIMELINE_ZOOM_NOTCH,
  dayClusters,
  formatTimelineInstant,
  packLanes,
  queuedStack,
  sessionItems,
  timelineItems,
  timelineTicks,
  timelineTimeAt,
  timelineX,
  type SessionSpan,
  type TimelineWindow,
} from "../../lib/agents/prompt/timeline";
import type { ChartDrag } from "./usePromptChartDrag";

interface Props {
  win: TimelineWindow;
  cards: PromptChartCard[];
  now: Date;
  drag: ChartDrag | null;
  /** The scrolling body — measured by the drag hook for its hit test. */
  bodyRef: RefObject<HTMLDivElement>;
  /** The now band — the "send now" drop zone, measured the same way. */
  nowBandRef: RefObject<HTMLDivElement>;
  /** Draws one card; `session` is set when the card stands for a whole
   *  session's sent prompts, `drawnAt` is the instant the card sits at and
   *  `bar` the duration bar on its anchored corner. */
  renderCard: (card: PromptChartCard, occurrence?: string, session?: SessionSpan, drawnAt?: Date, bar?: { anchor: "left" | "right"; width: number }) => ReactNode;
  /** Month view: a day's cluster asks to be looked at up close. */
  onRefine: (date: string) => void;
  /** The badge text for the card being carried, decided by the chart. */
  dropLabel: string | null;
  /** The badge names a refusal (a zone that means something, but not for
   *  this card): drawn in the blocked style, like a drop over nothing. */
  dropBlocked?: boolean;
  /** One line of guidance in an empty timeline, where there is nothing to drop on. */
  emptyHint?: string;
  /** Ctrl + wheel over the axis: one view finer or coarser, around the
   *  instant under the pointer. */
  onZoom?: (direction: "in" | "out", at: Date) => void;
  /** How far the reader lifted each item off its lane, in px, by item key. */
  lifts?: Record<string, number>;
  /** Where the agents' own rate-limit windows roll over. */
  resets?: UsageResetMark[];
  /** A press on the empty lanes (not on a card): the selection marquee. */
  onBodyPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** A click on the folded night (`win.fold`): show this day in full. */
  onUnfold?: () => void;
  /** Where the prompt the composer holds would land, drawn dashed. */
  preview?: { at: Date; message: string } | null;
  /** Ids of the sent cards whose turn is running: their bar grows with `now`. */
  running?: ReadonlySet<string>;
}

const BODY_PADDING = 8;
/** The band is the width of the line plus a grip either side. */
const NOW_BAND_WIDTH = 22;
/** Half the Now pill's width, so the pill stays inside the axis at both ends. */
const NOW_PILL_HALF = 46;
/** The queue's caption above its first card. */
const QUEUE_LABEL_HEIGHT = 16;

function hhmm(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The axis and the lanes: one proportional scale across the body's width,
 * cards at their instant, packed into lanes where they overlap. Everything
 * that moves during a drag (the ghost, the indicator, the badge) is drawn from
 * the hook's state, never by moving the card itself.
 *
 * What marks *time* rather than a card — the past band, the grid lines, the
 * now line and its drop band, the drop indicator — is drawn in layers beside
 * the scrolling body, not inside it: an absolutely placed `top: 0; bottom: 0`
 * child of a scroller spans only its first screenful, so an expanded card
 * that scrolled the body took the now line away with it. The axis, with the
 * NOW label, is sticky, so scrolling the tab keeps the clock in view too.
 */
export function PromptTimeline({ win, cards, now, drag, bodyRef, nowBandRef, renderCard, onRefine, dropLabel, dropBlocked, emptyHint, onZoom, lifts, resets = [], onBodyPointerDown, onUnfold, preview, running }: Props) {
  const t = useT();
  const lang = useI18nStore((s) => s.lang);
  const use24h = useUse24h();
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(onZoom);
  zoomRef.current = onZoom;

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => setWidth(body.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [bodyRef]);

  // Ctrl + wheel zooms the axis, the way a map does, centred on the instant
  // under the pointer. A native, non-passive listener: React's `onWheel` is
  // passive, and only `preventDefault` keeps the webview from zooming the
  // page instead. Notches accumulate so a trackpad's stream steps once.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let notches = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const zoom = zoomRef.current;
      const body = bodyRef.current;
      if (!zoom || !body) return;
      notches += event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? event.deltaY : event.deltaY * TIMELINE_ZOOM_NOTCH;
      if (Math.abs(notches) < TIMELINE_ZOOM_NOTCH) return;
      const direction = notches < 0 ? "in" : "out";
      notches = 0;
      const rect = body.getBoundingClientRect();
      zoom(direction, timelineTimeAt(event.clientX - rect.left + body.scrollLeft, win, rect.width));
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, [bodyRef, win]);

  const items = useMemo(() => timelineItems(cards, win, now), [cards, now, win]);
  // A session's sent prompts share one card on the lanes; the month's lamps
  // stay one per prompt.
  const laneItems = useMemo(() => (win.view === "month" ? items : sessionItems(items)), [items, win.view]);
  const packed = useMemo(() => packLanes(laneItems, win, width, now, undefined, undefined, running), [laneItems, now, running, width, win]);
  const clusters = useMemo(() => (win.view === "month" ? dayClusters(items, win, width) : []), [items, width, win]);
  const queued = useMemo(() => queuedStack(cards, now), [cards, now]);
  const ticks = useMemo(() => timelineTicks(win, width), [width, win]);
  const nowInside = now >= win.start && now < win.end;
  const nowX = Math.max(0, Math.min(width, timelineX(now, win, width)));
  // The pill's centre: on the line, but never so near an end that it is cut.
  const pillX = Math.max(NOW_PILL_HALF, Math.min(width - NOW_PILL_HALF, nowX));
  const lanes = Math.max(TIMELINE_MIN_LANES, win.view === "month" ? TIMELINE_MIN_LANES : packed.lanes);
  // The queue is a column at the now line, outside the lanes: the body is as
  // tall as the taller of the two, so no waiting card sits below the edge.
  // What still outgrows it (an expanded card) scrolls inside the body.
  const queueHeight = queued.length > 0 ? QUEUE_LABEL_HEIGHT + queued.length * TIMELINE_LANE_HEIGHT : 0;
  // A card the reader lifted sits off its lane: the stored lift, never above
  // the body's top edge (a repack can move the lane under it), plus the
  // distance of a lift in flight.
  const laneTop = (item: { lane: number }) => BODY_PADDING + item.lane * TIMELINE_LANE_HEIGHT;
  const lifting = (key: string) => drag?.kind === "lift" && drag.keys.includes(key);
  const itemTop = (item: { key: string; lane: number }) =>
    Math.max(0, laneTop(item) + (lifts?.[item.key] ?? 0))
    + (drag?.kind === "lift" && lifting(item.key) ? drag.dy : 0);
  const liftedBottom = win.view === "month" ? 0 : Math.max(0, ...packed.items.map((item) => itemTop(item) + TIMELINE_LANE_HEIGHT));
  const bodyHeight = Math.max(Math.max(lanes * TIMELINE_LANE_HEIGHT, queueHeight) + BODY_PADDING * 2, liftedBottom + BODY_PADDING);

  const tickLabel = (at: Date, label: "hour" | "day", major: boolean): string => {
    if (label === "hour") return formatTime(hhmm(at), use24h);
    if (win.view === "week" || major) return `${weekdayLabel(lang, at.getDay(), "short")} ${at.getDate()}`;
    return String(at.getDate());
  };

  const visibleResets = resets.filter((mark) => mark.at >= win.start && mark.at < win.end);
  // The agent is named on the label only once there is more than one to tell apart.
  const resetAgents = new Set(visibleResets.map((mark) => mark.agent)).size;
  const resetText = (mark: UsageResetMark) =>
    `${resetAgents > 1 ? `${mark.agent} ` : ""}${t(`promptChart.reset.${mark.kind}` as "promptChart.reset.session")}`;
  const resetTitle = (mark: UsageResetMark) => t("promptChart.resetTitle", {
    agent: mark.agent,
    labels: mark.labels.join(", "),
    percent: Math.round(mark.percent),
    resets: `${mark.resets} (${formatTimelineInstant(mark.at, lang, use24h, true)})`,
  });

  const dropAt = drag?.kind === "card" && drag.zone.kind === "time" ? drag.zone.at : null;
  // The band lights for every drop that sends now: the band itself, and the
  // past body for a single card — not for a refused one (a selection, a
  // queued card), whose badge is blocked instead.
  const dropNow = drag?.kind === "card" && (drag.zone.kind === "now" || (drag.zone.kind === "past" && !dropBlocked));
  // Inside one day, the date is the range label's to say.
  const dropDate = (at: Date) => formatTimelineInstant(at, lang, use24h, win.view !== "day" && win.view !== "hour");

  return (
    <div className={`agent-prompt-timeline is-${win.view}`} data-testid="prompt-timeline" ref={rootRef}>
      <div className="agent-prompt-timeline-axis">
        <div className="agent-prompt-timeline-axis-marks" aria-hidden="true">
          {/* Keyed by position, not instant: on a spring-forward day two wall
              hours are one instant, and the key would repeat. */}
          {ticks.filter((tick) => tick.major || win.view === "day" || win.view === "hour").map((tick, index) => (
            <span key={index} className={`agent-prompt-timeline-tick${tick.major ? " is-major" : ""}`} style={{ left: tick.x }}>
              {tick.labelled ? tickLabel(tick.at, tick.label, tick.major) : ""}
            </span>
          ))}
          {visibleResets.map((mark) => (
            <span key={`reset:${mark.key}`} className={`agent-prompt-timeline-reset-label is-${mark.kind}`} style={{ left: timelineX(mark.at, win, width) }} title={resetTitle(mark)}>
              {resetText(mark)}
            </span>
          ))}
          <span className={`agent-prompt-timeline-now-pill${nowInside ? "" : " is-outside"}`} style={{ left: pillX }} title={t("promptChart.nowBand")}>
            {t("promptChart.nowAt", { time: formatTime(hhmm(now), use24h) })}
          </span>
        </div>
        {win.fold && (
          <button
            type="button"
            className="agent-prompt-timeline-fold"
            data-testid="prompt-timeline-fold"
            style={{ width: win.fold.px }}
            title={t("promptChart.foldTitle")}
            aria-label={t("promptChart.foldTitle")}
            onClick={onUnfold}
          >
            {String(win.fold.start.getHours()).padStart(2, "0")}–{String(win.fold.end.getHours()).padStart(2, "0")}
          </button>
        )}
      </div>
      <div className="agent-prompt-timeline-stage">
        <div className="agent-prompt-timeline-underlay" aria-hidden="true">
          {win.fold && <div className="agent-prompt-timeline-fold-shade" style={{ width: win.fold.px }} />}
          {(nowInside || now >= win.end) && <div className="agent-prompt-timeline-past" style={{ width: nowInside ? nowX : width }} />}
          {ticks.map((tick, index) => (
            <span key={`line:${index}`} className={`agent-prompt-timeline-line${tick.major ? " is-major" : ""}`} style={{ left: tick.x }} />
          ))}
          {visibleResets.map((mark) => (
            <span key={`reset:${mark.key}`} className={`agent-prompt-timeline-reset is-${mark.kind}`} style={{ left: timelineX(mark.at, win, width) }} />
          ))}
        </div>
        <div
          className="agent-prompt-timeline-body"
          ref={bodyRef}
          data-testid="prompt-timeline-body"
          // Only a press on the lanes themselves: a card's press is its own.
          onPointerDown={win.view === "month" || !onBodyPointerDown ? undefined : (event) => {
            if (event.target === event.currentTarget) onBodyPointerDown(event);
          }}
        >
          <div className="agent-prompt-timeline-sizer" style={{ height: bodyHeight }} aria-hidden="true" />
          {emptyHint && <div className="file-tree-empty" data-testid="prompt-timeline-empty">{emptyHint}</div>}
          {win.view === "month"
            ? clusters.map((cluster) => (
              <button
                key={cluster.date}
                type="button"
                className={`agent-prompt-timeline-day${cluster.items.length ? "" : " is-empty"}`}
                style={{ left: cluster.x, width: cluster.width }}
                title={t("promptChart.refineDay")}
                onClick={() => onRefine(cluster.date)}
              >
                {cluster.items.slice(0, 6).map((item) => (
                  <span
                    key={item.key}
                    className={`agent-prompt-lamp is-${item.card.history?.result ?? item.card.state}`}
                    title={item.card.message}
                  />
                ))}
                {cluster.items.length > 6 && <small>{t("promptChart.more", { count: cluster.items.length - 6 })}</small>}
              </button>
            ))
            : packed.items.map((item) => (
              <div
                key={item.key}
                className={`agent-prompt-timeline-item${lifting(item.key) ? " is-lifting" : ""}`}
                style={{ left: item.x, top: itemTop(item), width: item.width }}
                data-lane-top={laneTop(item)}
                data-item-key={item.key}
              >
                {renderCard(item.card, item.occurrence, item.members && {
                  cards: item.members.map((member) => member.card),
                  offsets: item.members.map((member) => timelineX(member.at, win, width) - item.x),
                }, item.at, { anchor: item.anchor, width: item.barWidth })}
              </div>
            ))}
          {queued.length > 0 && (
            <div className="agent-prompt-timeline-queue" style={{ left: Math.min(nowX + NOW_BAND_WIDTH / 2 + 4, Math.max(0, width - TIMELINE_CARD_WIDTH)), width: TIMELINE_CARD_WIDTH }} data-testid="prompt-timeline-queue">
              <small>{t("promptChart.queue", { count: queued.length })}</small>
              {queued.map((card) => renderCard(card))}
            </div>
          )}
        </div>
        <div className="agent-prompt-timeline-overlay" aria-hidden="true">
          {nowInside && <div className="agent-prompt-timeline-now" style={{ left: nowX }} />}
          <div
            className={`agent-prompt-timeline-now-band${dropNow ? " is-drop-over" : ""}${nowInside ? "" : " is-outside"}`}
            ref={nowBandRef}
            data-testid="prompt-timeline-now-band"
            style={{ left: nowX - NOW_BAND_WIDTH / 2, width: NOW_BAND_WIDTH }}
          />
          {preview && win.view !== "month" && preview.at >= win.start && preview.at < win.end && (
            <div
              className="agent-prompt-timeline-preview"
              data-testid="prompt-timeline-preview"
              style={{ left: Math.max(win.fold?.px ?? 0, Math.min(timelineX(preview.at, win, width), width - TIMELINE_CARD_WIDTH)), top: BODY_PADDING, width: TIMELINE_CARD_WIDTH }}
            >
              <span className="agent-prompt-card-top">
                <strong>{formatTime(hhmm(preview.at), use24h)}</strong>
                <span>{t("promptChart.lands")}</span>
              </span>
              <span className="agent-prompt-card-message">{preview.message}</span>
            </div>
          )}
          {dropAt && (
            <div className="agent-prompt-timeline-indicator" style={{ left: timelineX(dropAt, win, width) }}>
              <span className={`agent-prompt-timeline-badge${dropBlocked ? " is-blocked" : ""}`}>{dropLabel ? `${dropLabel} · ` : ""}{dropDate(dropAt)}</span>
            </div>
          )}
        </div>
      </div>
      {drag?.kind === "marquee" && (
        <div
          className="agent-prompt-timeline-marquee"
          data-testid="prompt-timeline-marquee"
          aria-hidden="true"
          style={{
            left: Math.min(drag.x1, drag.x),
            top: Math.min(drag.y1, drag.y),
            width: Math.abs(drag.x - drag.x1),
            height: Math.abs(drag.y - drag.y1),
          }}
        />
      )}
      {drag?.kind === "card" && (
        <div
          className="agent-prompt-timeline-ghost"
          style={{ width: drag.width, transform: `translate(${drag.x - drag.grabDx}px, ${drag.y - drag.grabDy}px)` }}
          aria-hidden="true"
        >
          <span className="agent-prompt-card-message">{drag.card.message}</span>
          {drag.zone.kind !== "time" && dropLabel && (
            <span className={`agent-prompt-timeline-badge${drag.zone.kind === "none" || dropBlocked ? " is-blocked" : ""}`}>{dropLabel}</span>
          )}
        </div>
      )}
    </div>
  );
}
