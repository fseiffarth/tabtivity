import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { SettingRow, SettingsHeader, SettingsSection } from "../layout/settingsUi";
import { UntestedTag } from "../common/UntestedTag";
import { useT } from "../../lib/i18n";
import { summarizeScaffoldRepair } from "./scaffold";
import {
  migrationApplyIsEmpty,
  migrationStepCopy,
  type MigrationApplyReport,
  type MigrationPlan,
} from "./migration";
import type { ProjectEntry } from "../../types";
import { ErrorNote } from "../common/ErrorNote";

/**
 * "Migrate project": update an old project to the current Tabtivity state, one
 * reviewed step at a time. The backend's `project_migration_plan` is a pure
 * dry-run; every step renders with what it would change and an Accept/Decline
 * choice, and only the accepted ids are sent to `project_migration_apply` —
 * which re-checks each condition on disk, so a stale accept degrades to a
 * no-op rather than an overwrite.
 */
export function ProjectMigrationDialog({
  project,
  onClose,
}: {
  project: ProjectEntry;
  onClose: () => void;
}) {
  const t = useT();
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [declined, setDeclined] = useState<ReadonlySet<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<MigrationApplyReport | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<MigrationPlan>("project_migration_plan", { projectId: project.id })
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const steps = plan?.steps ?? [];
  const acceptedIds = steps.filter((s) => !declined.has(s.id)).map((s) => s.id);

  const setStepAccepted = (id: string, accepted: boolean) => {
    setDeclined((prev) => {
      const next = new Set(prev);
      if (accepted) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = () => {
    if (!plan || applying || acceptedIds.length === 0) return;
    setApplying(true);
    setError(null);
    invoke<MigrationApplyReport>("project_migration_apply", {
      projectId: project.id,
      accepted: acceptedIds,
    })
      .then(setResult)
      .catch((e) => setError(String(e)))
      .finally(() => setApplying(false));
  };

  return createPortal(
    <div className="modal-backdrop how-to-start-backdrop" onMouseDown={onClose}>
      <div className="settings-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <SettingsHeader
          title={
            <>
              {t("migrate.title")} <UntestedTag id="migrate.title" />
            </>
          }
          onClose={onClose}
        />
        <div className="dialog-scroll">
          {result ? (
            <>
              <SettingsSection
                title={t("migrate.done")}
                help={
                  migrationApplyIsEmpty(result)
                    ? t("migrate.nothingApplied")
                    : [
                        result.entryNormalized ? t("migrate.entryNormalized") : "",
                        summarizeScaffoldRepair(result.report),
                      ]
                        .filter(Boolean)
                        .join("; ")
                }
              />
              <div className="settings-link-row">
                <button type="button" className="settings-btn primary" onClick={onClose}>
                  {t("common.close")}
                </button>
              </div>
            </>
          ) : (
            <>
              <SettingsSection title={project.name} help={t("migrate.help")} />
              {error && <ErrorNote className="settings-error" error={error} />}
              {!plan && !error && (
                <div className="settings-empty">{t("migrate.loading")}</div>
              )}
              {plan && steps.length === 0 && (
                <div className="settings-empty">{t("migrate.upToDate")}</div>
              )}
              {steps.map((step) => {
                const copy = migrationStepCopy(step);
                const accepted = !declined.has(step.id);
                return (
                  <SettingRow
                    key={step.id}
                    label={t(copy.titleKey, copy.params)}
                    help={
                      <>
                        {t(copy.helpKey, copy.params)}
                        {step.details.length > 0 && (
                          <>
                            {" "}
                            <code>{step.details.join(", ")}</code>
                          </>
                        )}
                      </>
                    }
                    control={
                      <>
                        <button
                          type="button"
                          className={`settings-btn sm${accepted ? " primary" : ""}`}
                          aria-pressed={accepted}
                          onClick={() => setStepAccepted(step.id, true)}
                        >
                          {t("migrate.accept")}
                        </button>
                        <button
                          type="button"
                          className={`settings-btn sm${accepted ? "" : " danger"}`}
                          aria-pressed={!accepted}
                          onClick={() => setStepAccepted(step.id, false)}
                        >
                          {t("migrate.decline")}
                        </button>
                      </>
                    }
                  />
                );
              })}
              {plan && steps.length > 0 && (
                <div className="settings-link-row">
                  <button
                    type="button"
                    className="settings-btn primary"
                    disabled={applying || acceptedIds.length === 0}
                    onClick={apply}
                  >
                    {applying
                      ? t("migrate.applying")
                      : t("migrate.apply", { count: String(acceptedIds.length) })}
                  </button>
                  <button type="button" className="settings-btn" onClick={onClose}>
                    {t("common.cancel")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
