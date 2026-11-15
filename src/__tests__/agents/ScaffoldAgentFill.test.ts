import { describe, expect, it } from "vitest";
import {
  agentForScaffoldFillMode,
  buildDescriptionFillPrompt,
  buildScaffoldFillPrompt,
  collectScaffoldAgentFills,
} from "../../components/layout/ProjectSwitcher";

describe("scaffold agent fill guidance", () => {
  it("resolves agent choice to the configured default agent", () => {
    expect(agentForScaffoldFillMode("agent_choice", "codex")).toBe("codex");
    expect(agentForScaffoldFillMode("gemini", "codex")).toBe("gemini");
  });

  it("runs a default agent's registry id as its binary", () => {
    expect(agentForScaffoldFillMode("agent_choice", "antigravity")).toBe("agy");
    expect(agentForScaffoldFillMode("agent_choice", "continue")).toBe("cn");
    // A custom agent's command is no registry id and stays as it is.
    expect(agentForScaffoldFillMode("agent_choice", "my-agent")).toBe("my-agent");
  });

  it("groups only missing scaffold files selected for agent filling", () => {
    const fills = collectScaffoldAgentFills(
      [
        { path: "AGENTS.md", exists: false, kind: "file" },
        { path: "TODO.md", exists: false, kind: "file" },
        { path: "README.md", exists: false, kind: "file" },
        { path: "CLAUDE.md", exists: true, kind: "file" },
        { path: ".git", exists: false, kind: "directory" },
      ],
      {
        "AGENTS.md": "agent_choice",
        "TODO.md": "codex",
        "README.md": "manual",
        "CLAUDE.md": "claude",
        ".git": "codex",
      },
      "claude",
    );

    expect([...fills.entries()]).toEqual([
      ["claude", ["AGENTS.md"]],
      ["codex", ["TODO.md"]],
    ]);
  });

  it("builds a concrete prompt with the selected scaffold files", () => {
    const prompt = buildScaffoldFillPrompt(["AGENTS.md", "TODO.md"]);

    expect(prompt).toContain("Inspect the project first");
    expect(prompt).toContain("- AGENTS.md");
    expect(prompt).toContain("- TODO.md");
    // AGENTS.md is the one file agents load; no pointer files are made any more.
    expect(prompt).toContain("All agent guidance belongs in AGENTS.md");
    expect(prompt).not.toContain("CLAUDE.md");
    expect(prompt).not.toContain("GEMINI.md");
    expect(prompt).not.toContain("`@AGENTS.md`");
    // AGENTS.md is loaded every session: overviews belong elsewhere.
    expect(prompt).toContain("Overviews and architecture go in README.md");
  });

  it("gives PROJECT.md and REMARKS.md advice only when that file is being filled", () => {
    const plain = buildScaffoldFillPrompt(["AGENTS.md", "README.md"]);
    expect(plain).not.toContain("PROJECT.md");
    expect(plain).not.toContain("REMARKS.md");
    const withProject = buildScaffoldFillPrompt(["AGENTS.md", "PROJECT.md"]);
    expect(withProject).toContain("PROJECT.md is the navigation map");
    expect(withProject).not.toContain("REMARKS.md");
    expect(buildScaffoldFillPrompt(["REMARKS.md"])).toContain("REMARKS.md keeps its format note");
  });

  it("builds a concrete prompt for agent-filled project descriptions", () => {
    const prompt = buildDescriptionFillPrompt("Example");

    expect(prompt).toContain("Example");
    expect(prompt).toContain("top-level description field");
    expect(prompt).toContain("project switcher hover popup");
  });
});
