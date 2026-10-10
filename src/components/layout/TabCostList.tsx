import { useState } from "react";
import { useT } from "../../lib/i18n";
import {
  describeTabCost,
  loadedPdfCount,
  rankTabCosts,
  tabCost,
  untabbedPdfCost,
  type PdfCost,
  type RankedTabCost,
  type TabCost,
} from "../../lib/tabCost";
import { closeTabInScope } from "../../lib/remote/closeRemoteTab";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { UntestedTag } from "../common/UntestedTag";
import { SettingsCard } from "./settingsUi";

interface Row {
  scope: string;
  key: string;
  label: string;
  cost: TabCost | null;
}

interface Snapshot {
  costs: RankedTabCost<Row>;
  untabbed: PdfCost | null;
  pdfs: number;
}

/** Every open tab of every loaded scope, read once: the current scope from
 *  the live `tabs`, the others from `tabsByScope`. Keys are unique across
 *  scopes, so the untabbed PDF check needs no scope. */
function readSnapshot(): Snapshot {
  const { scope: current, tabs, tabsByScope } = useTabsStore.getState();
  const rows: Row[] = [];
  const keys = new Set<string>();
  const add = (scope: string, list: readonly TabEntry[]) => {
    for (const tab of list) {
      keys.add(tab.key);
      rows.push({ scope, key: tab.key, label: tab.label, cost: tabCost(scope, tab) });
    }
  };
  add(current, tabs);
  for (const [scope, list] of Object.entries(tabsByScope)) {
    if (scope !== current) add(scope, list);
  }
  return { costs: rankTabCosts(rows), untabbed: untabbedPdfCost(keys), pdfs: loadedPdfCount() };
}

/**
 * Settings → Performance → "What open tabs hold" (`docs/tab_cost_plan.md`
 * step 1): every tab's estimate from `lib/tabCost`, largest first, with Show
 * (current project only — switching project from inside Settings is not
 * trivial) and Close. Main window only. Read on mount and on Refresh; no timer.
 */
export function TabCostList({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [snap, setSnap] = useState<Snapshot>(readSnapshot);
  const current = useTabsStore((s) => s.scope);
  const refresh = () => setSnap(readSnapshot());
  const { ranked, others } = snap.costs;
  const empty = ranked.length === 0 && others === 0 && !snap.untabbed;

  return (
    <SettingsCard className="tab-cost-list">
      <div className="settings-card-row">
        <span className="settings-card-label">
          {t("settings.tabCosts")} <UntestedTag id="settings.tabCosts" />
        </span>
        <button type="button" className="settings-btn sm" onClick={refresh}>
          {t("settings.tabCostsRefresh")}
        </button>
      </div>
      <p className="settings-help">
        {t("settings.tabCostsHelp")} {t("settings.tabCostsPdfCount", { n: snap.pdfs })}
      </p>
      {empty && <p className="settings-empty">{t("settings.tabCostsEmpty")}</p>}
      {ranked.map((row) => (
        <div className="settings-card-row" key={`${row.scope}\u0000${row.key}`} data-tab-cost={row.key}>
          <span className="settings-card-label">
            {row.label} <span className="settings-help">{describeTabCost(row.cost, t)}</span>
          </span>
          <span className="settings-link-row">
            {row.scope === current && (
              <button
                type="button"
                className="settings-btn sm"
                onClick={() => {
                  useTabsStore.getState().setActive(row.key);
                  onClose();
                }}
              >
                {t("settings.tabCostsShow")}
              </button>
            )}
            <button
              type="button"
              className="settings-btn sm"
              onClick={() => {
                closeTabInScope(row.scope, row.key);
                refresh();
              }}
            >
              {t("settings.tabCostsClose")}
            </button>
          </span>
        </div>
      ))}
      {snap.untabbed && (
        <p className="settings-help">
          {t("settings.tabCostsUntabbed", { n: snap.untabbed.docs })}{" "}
          {describeTabCost({ kind: "pdf", ...snap.untabbed }, t)}
        </p>
      )}
      {others > 0 && <p className="settings-help">{t("settings.tabCostsOthers", { n: others })}</p>}
    </SettingsCard>
  );
}
