/**
 * **The** typed invoke surface for the Skills Library (`docs/done/skills_plan.md`) —
 * one wrapper per `skills_*` command, the convention `lib/mail.ts`/
 * `lib/window/printing.ts` established: no component calls `invoke("skills_*")`
 * directly.
 *
 * There is deliberately no manifest and no install-state tracking on this
 * side either — `installedSkills` is a plain read of what is actually on disk
 * under a target's `.claude/skills/`, so a hand-authored skill shows up the
 * same as one this UI installed.
 *
 * The install trio is addressed by a {@link SkillTarget}, never by a path, and
 * `PERSONAL_SKILLS` is a frozen constant rather than a function for that
 * reason: there is one way to name the personal scope and it takes no argument,
 * so no call site can turn it into a path this side chose.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledSkill,
  SkillCatalogEntry,
  SkillDetail,
  SkillSource,
  SkillTarget,
} from "../../types/skills";

/** `~/.claude/skills/` — read by every project on this machine, and by no
 *  other machine. */
export const PERSONAL_SKILLS: SkillTarget = Object.freeze({ kind: "personal" });

/** `<dir>/.claude/skills/` — this project's own, travelling with its tree. */
export function projectSkills(dir: string): SkillTarget {
  return { kind: "project", dir };
}

export function listSkillSources(): Promise<SkillSource[]> {
  return invoke<SkillSource[]>("skills_list_sources");
}

export function addSkillSource(label: string, url: string): Promise<SkillSource> {
  return invoke<SkillSource>("skills_add_source", { label, url });
}

export function removeSkillSource(id: string): Promise<void> {
  return invoke<void>("skills_remove_source", { id });
}

/** Shallow-clone (first time) or pull (subsequent) a source's repo into its
 *  cache. Can take a while on a slow link — callers show a spinner. */
export function refreshSkillSource(id: string): Promise<void> {
  return invoke<void>("skills_refresh_source", { id });
}

/** A source's catalog, walked fresh off its cached clone every call. */
export function listSkillCatalog(sourceId: string): Promise<SkillCatalogEntry[]> {
  return invoke<SkillCatalogEntry[]>("skills_list_catalog", { sourceId });
}

/** The preview panel's full read of one catalog entry (body + bundled files). */
export function getSkillDetail(sourceId: string, relPath: string): Promise<SkillDetail> {
  return invoke<SkillDetail>("skills_get_detail", { sourceId, relPath });
}

/** Copy the skill folder into the target's `.claude/skills/<name>/`, overwriting
 *  an existing install of the same name. Callers confirm the overwrite first. */
export function installSkill(
  target: SkillTarget,
  sourceId: string,
  relPath: string,
): Promise<void> {
  return invoke<void>("skills_install", { target, sourceId, relPath });
}

export function uninstallSkill(target: SkillTarget, name: string): Promise<void> {
  return invoke<void>("skills_uninstall", { target, name });
}

/** Every skill folder actually on disk under the target's `.claude/skills/`. */
export function listInstalledSkills(target: SkillTarget): Promise<InstalledSkill[]> {
  return invoke<InstalledSkill[]>("skills_list_installed", { target });
}
