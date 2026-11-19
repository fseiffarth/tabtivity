import { useRef, useState, type ReactNode } from "react";
import type { TimelineView } from "../../lib/agents/prompt/timeline";
import { useT } from "../../lib/i18n";
import { ContextMenuPortal } from "../common/ContextMenuPortal";
import { UntestedTag } from "../common/UntestedTag";
import { ArrowLeftIcon, ArrowRightIcon, FilterIcon, SearchIcon } from "../common/icons/Icon";

const VIEWS: TimelineView[] = ["hour", "day", "week", "month"];

/**
 * A command-bar button that drops a popover under itself: the shared
 * `ContextMenuPortal` frame (it clamps, layers and closes on a click away or
 * Escape), anchored to the button rather than to a cursor. The filters, the
 * options and the help all open this way.
 */
export function PromptChartPopoverButton({ label, icon, text, active, testId, popoverClass, children }: {
  /** The accessible name, and the tooltip of an icon-only button. */
  label: string;
  icon: ReactNode;
  /** A visible word beside the icon, where the button has one. */
  text?: string;
  active?: boolean;
  testId?: string;
  popoverClass?: string;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`settings-btn sm agent-prompt-bar-btn${text ? "" : " is-icon"}${active ? " is-active" : ""}`}
        aria-label={text ? undefined : label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        data-testid={testId}
        onClick={() => {
          if (anchor) { setAnchor(null); return; }
          const rect = button.current?.getBoundingClientRect();
          setAnchor({ x: rect?.left ?? 0, y: (rect?.bottom ?? 0) + 4 });
        }}
      >
        {icon}{text}
      </button>
      {anchor && (
        <ContextMenuPortal x={anchor.x} y={anchor.y} keepBelow onClose={() => setAnchor(null)} className={`context-menu agent-prompt-popover${popoverClass ? ` ${popoverClass}` : ""}`}>
          <div role="dialog" aria-label={label}>{children}</div>
        </ContextMenuPortal>
      )}
    </>
  );
}

interface Props {
  text: string;
  onText: (text: string) => void;
  /** How many facets of the filter are set, shown on the Filters button. */
  filterCount: number;
  /** The Filters popover's body. */
  filterPanel: ReactNode;
  view: TimelineView;
  onView: (view: TimelineView) => void;
  onPrev: () => void;
  onToday: () => void;
  onNext: () => void;
  rangeLabel: string;
  selectedCount: number;
  onClearSelection: () => void;
  /** Cards were lifted off their lanes in this view. */
  viewLifted: boolean;
  onResetLifts: () => void;
  /** A link is armed on another card: the bar says so, and cancels it. */
  linkArmed: boolean;
  /** What the armed chip asks for, when it is not "pick the other card". */
  linkArmedText?: string;
  onCancelLink: () => void;
  /** The options and help buttons. */
  trailing?: ReactNode;
}

/**
 * The chart's one command row: the heading, the one search, the filters, the
 * view switch and its navigation, then what applies right now (the selection,
 * Reset positions, an armed link). Everything that used to sit in three
 * toolbars and two filter bars; the gestures it no longer prints inline are
 * the help popover's.
 */
export function PromptChartCommandBar({
  text, onText, filterCount, filterPanel, view, onView, onPrev, onToday, onNext, rangeLabel,
  selectedCount, onClearSelection, viewLifted, onResetLifts, linkArmed, linkArmedText, onCancelLink, trailing,
}: Props) {
  const t = useT();
  return (
    <header className="agent-prompt-command-bar" data-testid="prompt-chart-command-bar">
      <h3 className="settings-section-title">{t("promptChart.heading")} <UntestedTag id="promptChart.heading" /></h3>
      <label className="agent-prompt-search">
        <SearchIcon />
        <input type="search" value={text} placeholder={t("promptChart.search")} aria-label={t("promptChart.search")} onChange={(event) => onText(event.target.value)} />
      </label>
      <PromptChartPopoverButton
        label={t("promptChart.filters")}
        text={t("promptChart.filters")}
        icon={<FilterIcon />}
        active={filterCount > 0}
        testId="prompt-chart-filters"
        popoverClass="agent-prompt-filter-popover"
      >
        {filterPanel}
      </PromptChartPopoverButton>
      <div className="agent-prompt-bar-spacer" />
      {linkArmed && (
        <span className="agent-prompt-chart-selection" data-testid="prompt-chart-link-armed">
          {linkArmedText ?? t("promptChart.pickLink")}
          <button type="button" className="agent-composer-chip" onClick={onCancelLink}>{t("common.cancel")}</button>
        </span>
      )}
      {viewLifted && (
        <button type="button" className="agent-composer-chip" onClick={onResetLifts}>{t("promptChart.resetPositions")}</button>
      )}
      {selectedCount > 0 && (
        <span className="agent-prompt-chart-selection" data-testid="prompt-chart-selection">
          {t("promptChart.selectedCount", { count: selectedCount })}
          <button type="button" className="agent-composer-chip" onClick={onClearSelection}>{t("promptChart.clearSelection")}</button>
        </span>
      )}
      <div className="agent-prompt-chart-views" role="group" aria-label={t("promptChart.zoom")}>
        {VIEWS.map((item) => (
          <button key={item} type="button" className={`agent-composer-chip${view === item ? " active" : ""}`} aria-pressed={view === item} onClick={() => onView(item)}>
            {t(`promptChart.view.${item}` as "promptChart.view.day")}
          </button>
        ))}
      </div>
      <div className="agent-prompt-chart-nav">
        <button className="settings-btn sm" type="button" aria-label={t("promptChart.prev")} title={t("promptChart.prev")} onClick={onPrev}><ArrowLeftIcon /></button>
        <button className="settings-btn sm" type="button" onClick={onToday}>{t("promptChart.today")}</button>
        <button className="settings-btn sm" type="button" aria-label={t("promptChart.next")} title={t("promptChart.next")} onClick={onNext}><ArrowRightIcon /></button>
      </div>
      <strong className="agent-prompt-chart-range" data-testid="prompt-chart-range">{rangeLabel}</strong>
      {trailing}
    </header>
  );
}
