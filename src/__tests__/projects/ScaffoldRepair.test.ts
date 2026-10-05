import { describe, expect, it } from "vitest";
import {
  describeScaffoldRepair,
  scaffoldRepairIsEmpty,
  summarizeScaffoldRepair,
  type ProjectScaffoldRepair,
} from "../../components/projects/scaffold";
import { BRAND } from "../../lib/brand";

describe("scaffold repair summaries", () => {
  it("reports an empty report as already up to date", () => {
    const report = { createdFiles: [], gitignoreLinesAdded: [], gitInitialized: false };
    expect(scaffoldRepairIsEmpty(report)).toBe(true);
    expect(summarizeScaffoldRepair(report)).toBe("already up to date");
  });

  it("summarizes created files, gitignore lines, and git init together", () => {
    const report = {
      createdFiles: ["DOCUMENTATION.md", ".claude/settings.json"],
      gitignoreLinesAdded: ["project.json"],
      gitInitialized: true,
    };
    expect(scaffoldRepairIsEmpty(report)).toBe(false);
    expect(summarizeScaffoldRepair(report)).toBe(
      "added DOCUMENTATION.md, .claude/settings.json; .gitignore +project.json; git init",
    );
  });

  it("reports upgraded legacy agent stubs separately from created files", () => {
    const report = {
      createdFiles: ["DOCUMENTATION.md"],
      updatedFiles: ["AGENTS.md", "CLAUDE.md"],
      gitignoreLinesAdded: [],
      gitInitialized: false,
    };
    expect(scaffoldRepairIsEmpty(report)).toBe(false);
    expect(summarizeScaffoldRepair(report)).toBe(
      "added DOCUMENTATION.md; updated AGENTS.md, CLAUDE.md",
    );
  });

  it("treats an updates-only report as a change, and an older backend's as empty", () => {
    // `updatedFiles` is absent when a still-running older backend answers.
    expect(
      scaffoldRepairIsEmpty({ createdFiles: [], gitignoreLinesAdded: [], gitInitialized: false }),
    ).toBe(true);
    const updatesOnly = {
      createdFiles: [],
      updatedFiles: ["GEMINI.md"],
      gitignoreLinesAdded: [],
      gitInitialized: false,
    };
    expect(scaffoldRepairIsEmpty(updatesOnly)).toBe(false);
    expect(summarizeScaffoldRepair(updatesOnly)).toBe("updated GEMINI.md");
  });

  it("prefixes the project name for a multi-project toast", () => {
    const repair: ProjectScaffoldRepair = {
      projectId: "abc",
      name: "MyProject",
      targetDir: `/home/u/${BRAND.slug}/projects/myproject`,
      report: { createdFiles: ["TODO.md"], gitignoreLinesAdded: [], gitInitialized: false },
    };
    expect(describeScaffoldRepair(repair)).toBe("MyProject: added TODO.md");
  });
});
