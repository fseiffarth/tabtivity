import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "../common/UntestedTag";

/** One lookup that still found something under the app's old name. */
interface LegacyHit {
  id: string;
  count: number;
  first: string;
  last: string;
}

/** One migration step that has not finished. */
interface UnfinishedStep {
  id: string;
  state: "started" | "pending" | "lazy" | "done";
  note: string;
}

export interface LegacyNameStatus {
  renamed: boolean;
  hits: LegacyHit[];
  unfinished: UnfinishedStep[];
}

/**
 * Settings → Updates, after a rename of the app: the summary of the fallback
 * log (`<state>/legacy-hits.json`) and of the steps that are not done yet
 * (`<state>/migrations.json`). The log answers one question — may the
 * old-name lookups be removed — so an empty list is the good news.
 *
 * Renders nothing while the app's name is unchanged (`renamed` is false) and
 * when the backend cannot be asked.
 */
export function LegacyNamesSummary() {
  const t = useT();
  const [status, setStatus] = useState<LegacyNameStatus | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve(invoke<LegacyNameStatus>("legacy_name_status"))
      .then((answer) => {
        if (alive) setStatus(answer ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!status?.renamed) return null;
  return (
    <section className="legacy-names" data-testid="legacy-names">
      <h3 className="settings-section-title">
        {t("updates.legacyTitle")} <UntestedTag id="updates.legacyNames" />
      </h3>
      <p className="settings-help">{t("updates.legacyHelp")}</p>
      {status.hits.length === 0 ? (
        <p className="settings-help">{t("updates.legacyNone")}</p>
      ) : (
        <ul className="legacy-names-list">
          {status.hits.map((hit) => (
            <li key={hit.id}>
              {t("updates.legacyHit", { id: hit.id, count: hit.count, last: hit.last.slice(0, 10) })}
            </li>
          ))}
        </ul>
      )}
      {status.unfinished.length > 0 && (
        <>
          <p className="settings-help">{t("updates.legacyUnfinished")}</p>
          <ul className="legacy-names-list">
            {status.unfinished.map((step) => (
              <li key={step.id}>{step.note ? `${step.id}: ${step.note}` : step.id}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
