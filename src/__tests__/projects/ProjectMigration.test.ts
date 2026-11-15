import { describe, expect, it } from "vitest";
import {
  migrationApplyIsEmpty,
  migrationStepCopy,
  type MigrationApplyReport,
  type MigrationStep,
} from "../../components/projects/migration";

const step = (kind: string, path?: string): MigrationStep => ({
  id: path ? `${kind}:${path}` : kind,
  kind,
  path: path ?? null,
  details: [],
});

describe("migration step copy", () => {
  it("maps every backend kind onto its own i18n pair", () => {
    expect(migrationStepCopy(step("entry")).titleKey).toBe("migrate.step.entry");
    expect(migrationStepCopy(step("createFile", "AGENTS.md"))).toEqual({
      titleKey: "migrate.step.createFile",
      helpKey: "migrate.step.createFileHelp",
      params: { path: "AGENTS.md", id: "createFile:AGENTS.md" },
    });
    expect(migrationStepCopy(step("upgradeStub", "AGENTS.md")).titleKey).toBe(
      "migrate.step.upgradeStub",
    );
    expect(migrationStepCopy(step("gitignore", ".gitignore")).titleKey).toBe(
      "migrate.step.gitignore",
    );
    expect(migrationStepCopy(step("gitInit")).titleKey).toBe("migrate.step.gitInit");
  });

  it("degrades an unknown kind (a newer backend's step) to the generic line", () => {
    const copy = migrationStepCopy({ id: "future:x", kind: "somethingNew", details: [] });
    expect(copy.titleKey).toBe("migrate.step.generic");
    expect(copy.params.id).toBe("future:x");
  });
});

describe("migration apply report", () => {
  it("is empty only when neither the entry nor the scaffold changed", () => {
    const empty: MigrationApplyReport = {
      entryNormalized: false,
      report: { createdFiles: [], gitignoreLinesAdded: [], gitInitialized: false },
    };
    expect(migrationApplyIsEmpty(empty)).toBe(true);
    expect(migrationApplyIsEmpty({ ...empty, entryNormalized: true })).toBe(false);
    expect(
      migrationApplyIsEmpty({
        entryNormalized: false,
        report: { createdFiles: ["README.md"], gitignoreLinesAdded: [], gitInitialized: false },
      }),
    ).toBe(false);
  });
});
