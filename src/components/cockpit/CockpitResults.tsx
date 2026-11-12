import { useMemo, useState } from "react";

import type { RosterRow } from "../../lib/cockpit/roster";
import { currentResults } from "../../lib/cockpit/agentNotes";
import { openCockpitResult, type ResultOutcome } from "../../lib/cockpit/openResult";
import { useT, type TranslationKey } from "../../lib/i18n";
import { disabledViewers } from "../../lib/viewers/fileUtils";
import { useSettingsStore } from "../../stores/settings";
import { UntestedTag } from "../common/UntestedTag";
import { formatAgo } from "./cockpitFormat";

const NOTE: Record<Exclude<ResultOutcome, "opened">, TranslationKey> = {
  unavailable: "cockpit.notes.resultUnavailable",
  refused: "cockpit.notes.resultRefused",
  stale: "cockpit.notes.resultStale",
  noViewer: "cockpit.notes.resultNoViewer",
};

/**
 * The results an agent listed for its own tab (`tab_set_results`): a plain-text
 * label and the project-relative path per item, under the handoff. Nothing here
 * reads, previews or checks a file: an item opens only when it is clicked, and
 * the host decides then (`openCockpitResult`). A click that opens nothing says
 * so next to the item - "Unavailable" for a file that is not there.
 */
export function CockpitResults({ row, now }: { row: RosterRow; now: number }) {
  const t = useT();
  const list = currentResults(row.tab.cockpitMeta);
  const viewerPrefs = useSettingsStore((s) => s.settings?.viewer_prefs);
  const disabled = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  // The last click's outcome, for the list it was made on only.
  const listKey = `${row.ptyId}\u0001${row.tab.cockpitMeta?.revision}`;
  const [said, setSaid] = useState<{ listKey: string; index: number; outcome: ResultOutcome } | null>(null);
  if (!list) return null;

  const open = async (index: number) => {
    const outcome = await openCockpitResult(row, index, { t, disabled });
    setSaid({ listKey, index, outcome });
  };
  return (
    <details className="cockpit-detail-fold cockpit-agent-note cockpit-agent-results" open>
      <summary>
        {t("cockpit.notes.results")} <UntestedTag id="cockpit.mcp.results" />
      </summary>
      <p className="cockpit-meta">{t("cockpit.notes.resultsMeta", { ago: formatAgo(list.setAt, now) })}</p>
      <ul className="cockpit-result-list">
        {list.items.map((item, index) => {
          const outcome = said && said.listKey === listKey && said.index === index && said.outcome !== "opened" ? said.outcome : undefined;
          return (
            <li key={index}>
              <button type="button" className="inline-link-btn" title={t("cockpit.notes.resultOpen")} onClick={() => void open(index)}>
                {item.label}
              </button>
              <span className="cockpit-result-path">{item.relativePath}</span>
              {outcome && (
                <span className="cockpit-result-note" role="status">
                  {t(NOTE[outcome])}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
