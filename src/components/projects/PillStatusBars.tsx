import { useMemo } from "react";
import { useActivityStore, type StatusTab, type TabStatusCounts } from "../../stores/activity";
import { useTabsStore } from "../../stores/tabs";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { useT, type TranslationKey } from "../../lib/i18n";

/** Most status bars the strip will draw. A scope with more busy tabs than this
 *  would overflow a narrow pill, so the strip stops here and the tooltip carries
 *  the true tally. */
const MAX_STATUS_BARS = 6;

/** Tooltip spelling out the tally the bars stand for (never truncated). */
export function statusBarTitle(
  c: TabStatusCounts,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (c.working) parts.push(t("pill.statusWorking", { count: c.working }));
  if (c.decision) parts.push(t("pill.statusWaiting", { count: c.decision }));
  if (c.done) parts.push(t("pill.statusFinished", { count: c.done }));
  if (c.interrupted) parts.push(t("pill.statusInterrupted", { count: c.interrupted }));
  return parts.join(" · ");
}

/** Which sentence a single bar's tooltip is built on. */
const BAR_TITLE_KEY: Record<StatusTab["state"], TranslationKey> = {
  working: "pill.statusTabWorking",
  "needs-decision": "pill.statusTabWaiting",
  finished: "pill.statusTabFinished",
  interrupted: "pill.statusTabInterrupted",
};

/** The order the bars are drawn in — the same one `computeStatusScopes` builds
 *  a single scope's list in, so a strip spanning several scopes merges them
 *  without inventing a second reading. */
const STATE_ORDER: Record<StatusTab["state"], number> = {
  working: 0,
  "needs-decision": 1,
  finished: 2,
  interrupted: 3,
};

/** One bar: which tab of which scope, in what state, under what name. */
export interface StatusBarItem {
  /** The tab's scope — a project id, `"root"`, or a `box:<id>`. Carried per
   *  item rather than per strip, because a strip may span several scopes and a
   *  click has to land in the right one. */
  scope: string;
  /** The tab's key within its scope (not the composed PTY id). */
  key: string;
  state: StatusTab["state"];
  /** A working shell tab rather than an agent — its own colour and tooltip. */
  shell?: boolean;
  /** What the bar's tooltip calls the tab (a multi-scope strip puts the scope's
   *  own name in front, or every bar would read as an unattributed tab name). */
  label: string;
}

/** The tally the tooltip spells out. Derived from the untruncated items, so the
 *  sentence stays true for a scope with more busy tabs than the strip draws. */
function tallyItems(items: StatusBarItem[]): TabStatusCounts {
  const tally: TabStatusCounts = { working: 0, decision: 0, done: 0, interrupted: 0 };
  for (const item of items) {
    if (item.state === "working") tally.working++;
    else if (item.state === "needs-decision") tally.decision++;
    else if (item.state === "interrupted") tally.interrupted++;
    else tally.done++;
  }
  return tally;
}

/**
 * The bars themselves — the one place the strip is drawn, whatever built its
 * items: a project pill's single scope, or the box chip's set of them.
 *
 * `interactive` is what a strip rendered INSIDE a button (the box chip's
 * dropdown rows) needs: a button inside a button is invalid markup, so there
 * the bars are inert spans and the row's own click is the way in.
 */
function StatusStrip({
  items,
  interactive = true,
  className,
}: {
  items: StatusBarItem[];
  interactive?: boolean;
  className?: string;
}) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <span
      className={`pill-status-bars${className ? ` ${className}` : ""}`}
      title={statusBarTitle(tallyItems(items), t)}
    >
      {items.slice(0, MAX_STATUS_BARS).map((item) => {
        const label = t(item.shell ? "pill.statusTabRunning" : BAR_TITLE_KEY[item.state], {
          tab: item.label,
        });
        const key = `${item.scope}:${item.key}`;
        const cls = `pill-status-bar ${item.state}${item.shell ? " shell" : ""}`;
        if (!interactive) {
          return <span key={key} className={`${cls} static`} aria-hidden />;
        }
        return (
          <button
            type="button"
            key={key}
            className={cls}
            title={`${label} · ${t("pill.statusTabJump")}`}
            aria-label={label}
            // The pill itself starts a reorder drag on pointerdown and switches
            // project on click; a bar is its own control, so it keeps both to
            // itself.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              jumpToTab(item.scope, item.key);
            }}
          />
        );
      })}
    </span>
  );
}

/** A scope's non-idle tabs as strip items, named by the tab labels the scope
 *  currently holds. `prefix` is the scope's own name, for a strip that stands
 *  for more than one of them. */
function itemsForScope(
  scope: string,
  statusTabs: StatusTab[] | undefined,
  tabs: { key: string; label: string }[] | undefined,
  prefix?: string,
): StatusBarItem[] {
  if (!statusTabs?.length) return [];
  return statusTabs.map((st) => {
    const label = tabs?.find((tab) => tab.key === st.key)?.label ?? "";
    return {
      scope,
      key: st.key,
      state: st.state,
      ...(st.shell ? { shell: true } : {}),
      label: prefix ? `${prefix} · ${label}` : label,
    };
  });
}

/**
 * One little bar per non-idle tab along the bottom edge of a pill, so a glance
 * at the switcher says how many tabs of each scope are working (green dots),
 * finished unseen (green, solid), waiting on a decision (amber) or cut off
 * mid-turn (the interrupted colour) — nothing
 * animated, the tab ring's own vocabulary (`--status-*`).
 *
 * Each bar is a **button that opens its own tab** — the strip already knows
 * which tab it is drawing (`statusTabsByScope`), and "an agent over there wants
 * something" is a statement whose only useful next step is going there; without
 * the click that meant switching project and then hunting the tab bar for the
 * one that was glowing. Hence the bars are also sized to be hit: a 3px sliver is
 * a readable signal but not a target.
 *
 * A *component* rather than a snippet each pill repeats, because the root
 * terminal is a scope like any other: its tabs run the same agents, and a pill
 * that showed nothing while an agent worked in it could only be read as "nothing
 * is running there". One component is what keeps the surfaces from drifting into
 * two different answers to the same question — the scope chip, which stands for
 * root and every box at once, is the other one, via
 * `ScopeSetStatusBars`.
 *
 * The SELECTED scope keeps its bars: the strip is a tally of what the scope is
 * doing, not a list of what still needs a glance, and the scope you are in is
 * the one whose agents you most need to see running. Only "finished unseen" is
 * inherently about unread output, and it can't arise for a tab on screen.
 *
 * Positioned absolutely, so the host must be a positioned box (`.project-pill`
 * and `.box-chip` both are).
 */
export function PillStatusBars({ scope }: { scope: string }) {
  // Per-scope subscriptions, not the whole maps: there is one of these per pill,
  // and a tab going busy in one project must not re-render every other pill.
  const statusTabs = useActivityStore((s) => s.statusTabsByScope[scope]);
  const tabs = useTabsStore((s) => s.tabsByScope[scope]);
  const items = useMemo(() => itemsForScope(scope, statusTabs, tabs), [scope, statusTabs, tabs]);
  return <StatusStrip items={items} />;
}

/**
 * The same strip for a SET of scopes at once — what the boxes chip needs, since
 * one chip stands for every box (and, when it names one, for that box's
 * `box:<id>` scope, whose tabs run the same agents as any project's).
 *
 * Bars from different scopes are merged in the strip's own urgency order and
 * each still opens its own tab: `jumpToTab` knows how to enter a box scope, so
 * a bar on the collapsed chip is the whole way from "something in a box wants
 * you" to the tab that does.
 *
 * Subscribes to the whole status maps rather than per scope — the set is not
 * fixed, and there are only ever a handful of these on screen. Pass memoized
 * `scopes`/`nameByScope`, or the strip recomputes its items every render.
 */
export function ScopeSetStatusBars({
  scopes,
  nameByScope,
  interactive,
  className,
}: {
  scopes: string[];
  /** Scope → the name put in front of each of its tabs, so a strip standing for
   *  several scopes says WHICH one wants something. Omit when the host already
   *  names the single scope it is showing. */
  nameByScope?: Record<string, string>;
  interactive?: boolean;
  className?: string;
}) {
  const statusTabsByScope = useActivityStore((s) => s.statusTabsByScope);
  const tabsByScope = useTabsStore((s) => s.tabsByScope);
  const items = useMemo(
    () =>
      scopes
        .flatMap((scope) =>
          itemsForScope(scope, statusTabsByScope[scope], tabsByScope[scope], nameByScope?.[scope]),
        )
        .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state]),
    [scopes, nameByScope, statusTabsByScope, tabsByScope],
  );
  return <StatusStrip items={items} interactive={interactive} className={className} />;
}
