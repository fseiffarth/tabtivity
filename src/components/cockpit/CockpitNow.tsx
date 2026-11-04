import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";

import { buildDecisions } from "../../lib/cockpit/decisions";
import { buildRoster } from "../../lib/cockpit/roster";
import { storageKey } from "../../lib/brand";
import { useActivityStore } from "../../stores/activity";
import { useCockpitStore } from "../../stores/cockpit";
import { useAlertsFeed } from "../files/useAlertsFeed";
import { useDomainReview } from "../layout/RootReviewStrip";
import { CockpitDetail } from "./CockpitDetail";
import { CockpitRail } from "./CockpitRail";
import { CockpitRoster } from "./CockpitRoster";
import { CockpitViewHeading } from "./CockpitViewHeading";
import {
  useCockpitNow,
  useCockpitScopes,
  useLoadSchedules,
  useMarkupAsks,
  usePushRequests,
  useRosterInputs,
  useScheduleProposals,
} from "./useCockpitData";

const RAIL_KEY = storageKey("cockpitRailWidth");
const DETAIL_KEY = storageKey("cockpitDetailWidth");
const RAIL_DEFAULT = 300;
const DETAIL_DEFAULT = 560;
const MIN_COLUMN = 220;
const MAX_COLUMN = 1100;

const clamp = (w: number) => Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(w)));

/** A remembered column width (per machine; a convenience, never state). */
function readWidth(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? clamp(n) : fallback;
  } catch {
    return fallback;
  }
}

function writeWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Unavailable: the width holds for this session.
  }
}

/** A column's drag handle: the width follows the pointer, and is written once
 *  on release. `sign` is +1 when dragging right widens the column. */
function useColumnWidth(key: string, fallback: number, sign: 1 | -1) {
  const [width, setWidth] = useState(() => readWidth(key, fallback));
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = width;
      let last = start;
      const move = (ev: PointerEvent) => {
        last = clamp(start + sign * (ev.clientX - startX));
        setWidth(last);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        writeWidth(key, last);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [key, sign, width],
  );
  return { width, onPointerDown };
}

/**
 * The Now view (`docs/desktop_cockpit_plan.md`, View 1): the Decisions rail,
 * the roster, and the detail pane, the rail and detail widths resizable and
 * remembered. Mounted only while the cockpit shows this view, so its loads
 * (push requests, schedules, markup asks) and its clock run only then.
 */
export function CockpitNow() {
  const now = useCockpitNow();
  const scopes = useCockpitScopes();
  useLoadSchedules(scopes);
  const inputs = useRosterInputs(scopes, now);
  const push = usePushRequests(scopes);
  const schedules = useScheduleProposals(scopes);
  const markup = useMarkupAsks(scopes);
  const { waiting } = useDomainReview();
  const alerts = useAlertsFeed();
  const stateFilter = useCockpitStore((s) => s.stateFilter);
  const sort = useCockpitStore((s) => s.sort);
  const mode = useCockpitStore((s) => s.rosterMode);
  const query = useCockpitStore((s) => s.query);
  const boxFilter = useCockpitStore((s) => s.boxFilter);
  const scopeFilter = useCockpitStore((s) => s.scopeFilter);
  const selected = useCockpitStore((s) => s.selected);
  const [detailFocused, setDetailFocused] = useState(false);
  const rail = useColumnWidth(RAIL_KEY, RAIL_DEFAULT, 1);
  const detail = useColumnWidth(DETAIL_KEY, DETAIL_DEFAULT, -1);

  const roster = useMemo(
    () => buildRoster(inputs, { stateFilter, sort, mode, query, boxFilter, scopeFilter }),
    [inputs, stateFilter, sort, mode, query, boxFilter, scopeFilter],
  );
  const allRows = useMemo(
    () => buildRoster(inputs, { stateFilter: "all", sort, mode: "flat", query: "", boxFilter, scopeFilter: null }).rows,
    [inputs, sort, boxFilter],
  );
  const names = useMemo(() => Object.fromEntries(scopes.map((entry) => [entry.scope.id, entry.scope.name])), [scopes]);
  const decisions = useMemo(
    () => buildDecisions({ rows: allRows, push, schedules, approvals: waiting, markup, alerts: alerts.enabled ? alerts.items : [], names }),
    [allRows, push, schedules, waiting, markup, alerts.enabled, alerts.items, names],
  );

  // Nothing selected: the top Asking row is what the pane shows.
  const shownId = selected ?? decisions.topAsking;
  const shownRow = allRows.find((row) => row.ptyId === shownId);

  // Selecting an unseen finished turn counts as reading it (the desktop's
  // read mark); a question or an interruption is never cleared by a look.
  const shownDone = shownRow?.state === "done" ? shownRow.ptyId : null;
  useEffect(() => {
    if (shownDone) useActivityStore.getState().clearAttention(shownDone);
  }, [shownDone]);

  return (
    <div className="cockpit-view cockpit-view-now">
      <CockpitViewHeading view="now" />
      <div className="cockpit-now">
        <div className="cockpit-now-rail" style={{ width: rail.width }}>
          <CockpitRail decisions={decisions} selected={shownId} alerts={alerts} />
        </div>
        <div className="cockpit-grip" role="separator" aria-orientation="vertical" onPointerDown={rail.onPointerDown} />
        <div className="cockpit-now-roster">
          <CockpitRoster
            roster={roster}
            selected={shownId}
            now={now}
            onShow={(ptyId) => {
              useCockpitStore.getState().select(ptyId);
              setDetailFocused(true);
            }}
          />
        </div>
        <div className="cockpit-grip" role="separator" aria-orientation="vertical" onPointerDown={detail.onPointerDown} />
        <div
          className="cockpit-now-detail"
          style={{ width: detail.width }}
          onFocusCapture={() => setDetailFocused(true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDetailFocused(false);
          }}
        >
          <CockpitDetail row={shownRow} focused={detailFocused} now={now} />
        </div>
      </div>
    </div>
  );
}
