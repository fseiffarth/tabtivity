//! Types for the Skills Library (`docs/skills_plan.md`): a browsable catalog of
//! git-hosted Claude Code skills (plain `<name>/SKILL.md` folders) that can be
//! copied into a project's own `.claude/skills/` or into the machine's personal
//! `~/.claude/skills/`. See `services::skills` for the logic; these are just the
//! wire shapes.

use serde::{Deserialize, Serialize};

/// Where an install lands — the two scopes Claude Code actually reads.
///
/// The variants are asymmetric on purpose. `Project` names a directory, because
/// only the caller knows which project is meant; `Personal` carries **nothing**,
/// because the frontend must not be able to say *where* home is. That is what
/// keeps this a scope choice rather than an install-anything-anywhere primitive:
/// `services::skills` resolves `Personal` against `paths::home_dir()` itself, so
/// the widest-reaching target in the feature is also the one no caller can aim.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SkillTarget {
    /// `<dir>/.claude/skills/` — travels with the repo, reaches a container
    /// through the identical-path mount and a remote host through lockstep.
    Project { dir: String },
    /// `~/.claude/skills/` — every project on **this machine**, and no other
    /// machine at all.
    Personal,
}

/// A git repository the catalog is built from (e.g. `anthropics/skills`).
/// Persisted verbatim in `skills_sources.json` — no per-skill version/commit
/// tracking, see the plan for why.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSource {
    pub id: String,
    pub label: String,
    pub url: String,
}

/// One `SKILL.md` found while walking a source's cached clone. Nothing here is
/// persisted — the catalog is re-derived from disk on each open/refresh.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillCatalogEntry {
    pub name: String,
    pub description: String,
    pub source_id: String,
    /// Path to the skill's own folder, relative to the source's cache root.
    pub rel_path: String,
    /// True when the folder holds a `scripts/` directory — surfaced in the
    /// preview panel so an install is never a silent "and it can also execute
    /// things" surprise.
    pub has_scripts: bool,
}

/// A skill already present in a target's `.claude/skills/<name>/`, whether it
/// got there via install or was hand-authored. `list_installed` is the only
/// source of truth — there is no separate Tabtivity-tracked "is this installed"
/// flag, and asking a target is the only way to know what it holds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledSkill {
    pub name: String,
    pub description: String,
}

/// The preview panel's full read of one catalog entry: `SKILL.md`'s body
/// (frontmatter stripped — name/description are already broken out) rendered
/// through the ordinary sanitized markdown viewer, plus the bundled file list so
/// an install is never a surprise about what else comes along.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDetail {
    pub name: String,
    pub description: String,
    pub body: String,
    /// Every other file in the skill's folder, relative to it (SKILL.md itself
    /// excluded — its content is already `body`).
    pub files: Vec<String>,
    pub has_scripts: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scope choice is tagged by `kind`, and `Personal` carries nothing: a
    /// caller that tries to smuggle a `dir` along with it still gets the
    /// home-resolved scope, never a directory of its choosing.
    #[test]
    fn skill_target_is_kind_tagged_and_personal_cannot_be_aimed() {
        let project: SkillTarget =
            serde_json::from_str(r#"{"kind":"project","dir":"/work/p"}"#).unwrap();
        assert!(matches!(project, SkillTarget::Project { ref dir } if dir == "/work/p"));
        assert_eq!(
            serde_json::to_value(&SkillTarget::Personal).unwrap(),
            serde_json::json!({"kind":"personal"})
        );
        let personal: SkillTarget =
            serde_json::from_str(r#"{"kind":"personal","dir":"/etc"}"#).unwrap();
        assert!(matches!(personal, SkillTarget::Personal));
        assert!(serde_json::from_str::<SkillTarget>(r#"{"kind":"project"}"#).is_err());
        assert!(serde_json::from_str::<SkillTarget>(r#"{"kind":"Personal"}"#).is_err());
    }

    /// The wire shapes are snake_case, matching the frontend's typed wrappers.
    #[test]
    fn catalog_and_detail_shapes_are_snake_case() {
        let entry = SkillCatalogEntry {
            name: "pdf".into(),
            description: "PDF tools".into(),
            source_id: "anthropics".into(),
            rel_path: "skills/pdf".into(),
            has_scripts: true,
        };
        let out = serde_json::to_value(&entry).unwrap();
        assert_eq!(out["source_id"], "anthropics");
        assert_eq!(out["rel_path"], "skills/pdf");
        assert_eq!(out["has_scripts"], true);
        let source: SkillSource = serde_json::from_str(
            r#"{"id":"s","label":"Anthropic","url":"https://github.com/anthropics/skills"}"#,
        )
        .unwrap();
        assert_eq!(source.label, "Anthropic");
        let detail: SkillDetail = serde_json::from_value(serde_json::json!({
            "name":"n","description":"d","body":"# hi","files":["scripts/run.sh"],"has_scripts":true
        }))
        .unwrap();
        assert_eq!(detail.files, vec!["scripts/run.sh"]);
    }
}
