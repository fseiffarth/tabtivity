import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { buildDecisions, type DecisionGroupId } from "../../lib/cockpit/decisions";
import { buildRoster, pickFollow, type RosterRow } from "../../lib/cockpit/roster";
import { storageKey } from "../../lib/brand";
import { useT } from "../../lib/i18n";
import { useFrameBandValue } from "../../lib/window/frameBand";
import { useActivityStore } from "../../stores/activity";
import { useCockpitStore } from "../../stores/cockpit";
import { useAlertsFeed } from "../files/useAlertsFeed";
import { ChevronLeftIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { CockpitDetail } from "./CockpitDetail";
import { CockpitRail } from "./CockpitRail";
import { CockpitRailIcons } from "./CockpitRailIcons";
import { CockpitRoster } from "./CockpitRoster";
import { NeedsYouChip, NeedsYouPopover, type NeedsYouAnchor } from "./NeedsYouPopover";
import { ColumnGrip, useColumnWidth } from "./useColumnWidth";
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
/** The detail's floor and ceiling beside the roster in the middle band: it
 *  gives up width before the roster does, but never below a readable pane. */
const MID_DETAIL_MIN = 360;
const MID_DETAIL_MAX = "55%";

/**
 * The Now view (`docs/desktop_cockpit_plan.md`, View 1): the Decisions rail,
 * the roster, and the detail pane, the rail and detail widths resizable and
 * remembered. Mounted only while the cockpit shows this view, so its loads
 * (push requests, schedules, markup asks) and its clock run only then.
 *
 * The window's band (`lib/window/frameBand`) decides which of the three
 * columns exist: `wide` all three; `mid` the rail is the 40 px icon rail (its
 * full form in a popover) and roster and detail sit side by side; `narrow`
 * master and detail, the roster or the detail alone, a "Needs you N" chip
 * for the rail and a back button from the detail. The column that is not
 * shown is not mounted, so a hidden detail attaches no terminal.
 */
export function CockpitNow() {
  const t = useT();
  const band = useFrameBandValue();
  const rootRef = useRef<HTMLDivElement>(null);
  const iconsRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Narrow only: which of master and detail fills the window.
  // Tonight's "Show" asks for the detail (`detailAsked`); a request made before
  // this mounted is honoured on the first render, so the roster never flashes.
  const [pane, setPane] = useState<"list" | "detail">(() => (useCockpitStore.getState().detailAsked ? "detail" : "list"));
  const detailAsked = useCockpitStore((s) => s.detailAsked);
  const [needsYou, setNeedsYou] = useState<NeedsYouAnchor | null>(null);
  const now = useCockpitNow();
  const scopes = useCockpitScopes();
  useLoadSchedules(scopes);
  const inputs = useRosterInputs(scopes, now);
  const push = usePushRequests(scopes);
  const schedules = useScheduleProposals(scopes);
  const markup = useMarkupAsks(scopes);
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
    () => buildDecisions({ rows: allRows, push, schedules, markup, alerts: alerts.enabled ? alerts.items : [], names }),
    [allRows, push, schedules, markup, alerts.enabled, alerts.items, names],
  );

  // The wide band has the full rail in its column; no popover outlives it.
  useEffect(() => {
    if (band === "wide") setNeedsYou(null);
  }, [band]);

  /** Hang the full rail from the chip (narrow) or the icon rail (mid). */
  const openNeedsYou = (group: DecisionGroupId | null) => {
    const rect = (band === "mid" ? iconsRef.current : chipRef.current)?.getBoundingClientRect();
    if (!rect) return;
    setNeedsYou(band === "mid" ? { x: rect.right + 4, y: rect.top, group } : { x: rect.left, y: rect.bottom + 4, group });
  };
  useEffect(() => {
    if (!detailAsked) return;
    useCockpitStore.setState({ detailAsked: false });
    setPane("detail");
    setDetailFocused(true);
  }, [detailAsked]);
  const openDetail = () => setPane("detail");
  const backToList = () => {
    setPane("list");
    setDetailFocused(false);
    // The roster takes the keys back (its list mounts with the pane).
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(".cockpit-roster-list")?.focus());
  };
  const onBackKeys = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    // Handled here: the window's own Escape (close) must not also run.
    e.preventDefault();
    backToList();
  };

  // Nothing selected: the top Asking row is what the pane shows, else the latest
  // working agent. That one is sticky (`pickFollow`): every switch re-attaches a
  // terminal, so it is kept while it works and re-picked only once it stops.
  const [followId, setFollowId] = useState<string | null>(null);
  const followed = pickFollow(allRows, followId);
  useEffect(() => {
    if (followed !== followId) setFollowId(followed);
  }, [followed, followId]);
  const shownId = selected ?? decisions.topAsking ?? followed;
  const following = !selected && !decisions.topAsking && followed != null;
  const shownRow = allRows.find((row) => row.ptyId === shownId);

  // Selecting an unseen finished turn counts as reading it (the desktop's
  // read mark); a question or an interruption is never cleared by a look.
  const shownDone = shownRow?.state === "done" ? shownRow.ptyId : null;
  useEffect(() => {
    if (shownDone) useActivityStore.getState().clearAttention(shownDone);
  }, [shownDone]);

  const showRoster = band !== "narrow" || pane === "list";
  const showDetailPane = band !== "narrow" || pane === "detail";
  const detailStyle =
    band === "wide"
      ? { width: detail.width }
      : band === "mid"
        ? { width: detail.width, flexShrink: 1, minWidth: MID_DETAIL_MIN, maxWidth: MID_DETAIL_MAX }
        : undefined;
  // The narrow band has no rail column: its chip rides the first row of
  // whichever pane is up (the roster's head, the detail's back bar).
  const narrowChip =
    band === "narrow" ? (
      <>
        <NeedsYouChip
          chipRef={chipRef}
          decisions={decisions}
          open={needsYou != null}
          onClick={() => (needsYou ? setNeedsYou(null) : openNeedsYou(null))}
        />
        <UntestedTag id="cockpit.narrow" />
      </>
    ) : null;
  return (
    <div className="cockpit-view cockpit-view-now" ref={rootRef} role="region" aria-label={t("cockpit.now.heading")}>
      <div className={`cockpit-now${band === "narrow" ? " narrow" : ""}`}>
        {band === "wide" && (
          <>
            <div className="cockpit-now-rail" style={{ width: rail.width }}>
              <CockpitRail decisions={decisions} selected={shownId} alerts={alerts} />
            </div>
            <ColumnGrip onPointerDown={rail.onPointerDown} />
          </>
        )}
        {band === "mid" && (
          <div className="cockpit-now-icons" ref={iconsRef}>
            <CockpitRailIcons decisions={decisions} onExpand={openNeedsYou} />
          </div>
        )}
        {showRoster && (
          <div className="cockpit-now-roster">
            <CockpitRoster
              roster={roster}
              selected={shownId}
              now={now}
              onShow={(ptyId) => {
                useCockpitStore.getState().select(ptyId);
                setDetailFocused(true);
                openDetail();
              }}
              onOpen={openDetail}
              headExtra={narrowChip}
            />
          </div>
        )}
        {showRoster && showDetailPane && (
          <ColumnGrip onPointerDown={detail.onPointerDown} />
        )}
        {showDetailPane && (
          <div
            className="cockpit-now-detail"
            style={detailStyle}
            onFocusCapture={() => setDetailFocused(true)}
            onBlurCapture={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDetailFocused(false);
            }}
          >
            {band === "narrow" && (
              <div className="cockpit-narrow-back" onKeyDown={onBackKeys}>
                <button type="button" className="settings-btn sm" onClick={backToList}>
                  <ChevronLeftIcon /> {t("cockpit.narrow.back")}
                </button>
                {narrowChip}
              </div>
            )}
            <CockpitDetail row={shownRow} focused={detailFocused} now={now} following={following} />
          </div>
        )}
      </div>
      {needsYou && (
        <NeedsYouPopover
          anchor={needsYou}
          decisions={decisions}
          alerts={alerts}
          selected={shownId}
          onPick={(row: RosterRow) => {
            useCockpitStore.getState().select(row.ptyId);
            openDetail();
          }}
          onClose={() => setNeedsYou(null)}
        />
      )}
    </div>
  );
}
