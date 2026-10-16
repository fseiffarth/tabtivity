/**
 * The Skills Library's wire types — the exact shapes `commands::skills`
 * serializes. See `docs/done/skills_plan.md` for the feature's scope and
 * `lib/agents/skills.ts` for the invoke wrappers built on them.
 */

/** A git repository the catalog is built from. Persisted verbatim server-side —
 *  no per-skill version/commit tracking. */
export interface SkillSource {
  id: string;
  label: string;
  url: string;
}

/** One `SKILL.md` found while walking a source's cached clone. Re-derived from
 *  disk on every open/refresh — nothing here is persisted. */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  source_id: string;
  /** The skill's own folder, relative to the source's cache root. Opaque to
   *  the frontend — passed back verbatim to `skills_get_detail`/`skills_install`. */
  rel_path: string;
  has_scripts: boolean;
}

/**
 * Where an install lands — the two scopes Claude Code actually reads, and the
 * only thing about this feature that is scoped at all (the source list and the
 * cached clones are machine state, shared by every project).
 *
 * The variants are asymmetric on purpose, and the asymmetry is the boundary:
 * `project` names a directory because only the caller knows which project is
 * meant, while `personal` carries **nothing** — the backend resolves it against
 * its own home, so the widest-reaching target in the feature is the one this
 * side cannot aim. Never build a `{ kind: "project", dir: <a home path> }` to
 * reach the personal scope; that is the exact thing the split prevents.
 */
export type SkillTarget =
  /** `<dir>/.claude/skills/` — travels with the repo, reaches a container
   *  through the identical-path mount and a remote host through git lockstep. */
  | { kind: "project"; dir: string }
  /** `~/.claude/skills/` — every project on **this machine**, and no other
   *  machine at all. */
  | { kind: "personal" };

/** A skill already present in a target's `.claude/skills/<name>/`, whether it
 *  got there via install or was hand-authored. */
export interface InstalledSkill {
  name: string;
  description: string;
}

/** The preview panel's full read of one catalog entry. */
export interface SkillDetail {
  name: string;
  description: string;
  /** `SKILL.md`'s body with the frontmatter already stripped, rendered through
   *  the ordinary sanitized markdown viewer. */
  body: string;
  /** Every other file in the skill's folder, relative to it. */
  files: string[];
  has_scripts: boolean;
}
