import { useProjectsStore } from "../../stores/projects";
import { resolveProjectDirectory } from "../../types";
import { SkillsLibraryView } from "./SkillsLibraryView";

interface Props {
  /** The tab's scope: a project id, or `"root"` — where there is no project to
   *  install into and the view falls back to the personal scope alone. */
  scope: string;
  /** Fallback cwd, used only if the scope's project can't be resolved. */
  cwd: string;
  visible?: boolean;
}

/**
 * The Skills Library tab (`docs/done/skills_plan.md`): a thin host, `ProjectFilesTab`'s
 * shape applied to a simpler view — it resolves the project from its own
 * `scope` (so it works identically in a popout, which has no store-resolved
 * `projectDir` to hand it) and renders `SkillsLibraryView`, which owns
 * everything else.
 *
 * An unresolvable project is no longer an error state. It was, and it had to
 * be while a project was the only place a skill could land; now that the
 * personal scope exists the tab still has something to do — browse the catalog,
 * which is machine state, and install for every project on this machine — so it
 * hands the view a `null` project rather than a "no project selected" wall.
 * That is also what lets the tab exist at the root scope at all.
 */
export function SkillsLibraryTab({ scope, cwd, visible = true }: Props) {
  const projects = useProjectsStore((s) => s.projects);
  const project = projects.find((p) => p.id === scope) ?? null;
  const projectDir = (project ? resolveProjectDirectory(project) : cwd) || null;

  return <SkillsLibraryView projectDir={scope === "root" ? null : projectDir} visible={visible} />;
}
