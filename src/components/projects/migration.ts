import type { ScaffoldRepairReport } from "../../lib/projects/scaffold";
import { scaffoldRepairIsEmpty } from "../../lib/projects/scaffold";
import type { TranslationKey } from "../../lib/i18n";

/** One step of `project_migration_plan` — mirrors the backend's
 *  `MigrationStep`. `id` is echoed back to `project_migration_apply` for the
 *  steps the user accepted; declined ids are simply not sent. */
export interface MigrationStep {
  id: string;
  kind: string;
  path?: string | null;
  details: string[];
}

/** Backend `MigrationPlan`: the dry-run list the dialog walks step by step.
 *  Empty `steps` means the project is already up to date. */
export interface MigrationPlan {
  projectId: string;
  name: string;
  targetDir?: string | null;
  steps: MigrationStep[];
}

/** Backend `MigrationApplyReport` — what an apply actually changed. */
export interface MigrationApplyReport {
  entryNormalized: boolean;
  report: ScaffoldRepairReport;
}

export function migrationApplyIsEmpty(r: MigrationApplyReport): boolean {
  return !r.entryNormalized && scaffoldRepairIsEmpty(r.report);
}

/** The i18n keys a step renders with. Pure, so the kind→copy mapping is
 *  testable; an unknown kind (a newer backend's step) degrades to a generic
 *  line naming the id rather than an empty row. */
export function migrationStepCopy(step: MigrationStep): {
  titleKey: TranslationKey;
  helpKey: TranslationKey;
  params: Record<string, string>;
} {
  const params = { path: step.path ?? "", id: step.id };
  switch (step.kind) {
    case "entry":
      return { titleKey: "migrate.step.entry", helpKey: "migrate.step.entryHelp", params };
    case "createFile":
      return { titleKey: "migrate.step.createFile", helpKey: "migrate.step.createFileHelp", params };
    case "upgradeStub":
      return { titleKey: "migrate.step.upgradeStub", helpKey: "migrate.step.upgradeStubHelp", params };
    case "gitignore":
      return { titleKey: "migrate.step.gitignore", helpKey: "migrate.step.gitignoreHelp", params };
    case "gitInit":
      return { titleKey: "migrate.step.gitInit", helpKey: "migrate.step.gitInitHelp", params };
    default:
      return { titleKey: "migrate.step.generic", helpKey: "migrate.step.genericHelp", params };
  }
}
