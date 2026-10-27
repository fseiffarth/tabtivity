//! Skills Library (`docs/done/skills_plan.md`) — fetch + catalog, no manifest, no
//! versioning. A "source" is a git repo (Anthropic's own `anthropics/skills` by
//! default, or any other collection the user points at); its clone is cached
//! under `~/.local/share/tabtivity/skills_cache/<id>/` and walked on demand for
//! `**/SKILL.md` folders. Install is a plain recursive copy into a target's
//! `.claude/skills/<name>/` — the tree itself is the only record of what is
//! installed, matching how `CLAUDE.md`/`AGENTS.md` scaffolding already works.
//!
//! **The catalog is machine state; only the install is scoped.** The source
//! list and every cached clone live in `state_dir()`, shared by every project —
//! which is why a skill can be installed into a project (`.claude/skills/`,
//! travelling with the repo, reaching a container through the identical-path
//! mount and a remote host through lockstep) or into the personal scope: the
//! Tabtivity-wide agent layer's `.claude/skills/` (`services::agent_global`,
//! `<state_dir>/agent-global`), which is copied into every agent home at every
//! spawn — every project here sees it and no other machine ever does. The
//! user's own `~/.claude/skills` belongs to their own Claude Code and is never
//! written (agent tabs do not read it anyway: they run in Tabtivity's agent
//! homes). `SkillTarget` is that choice and nothing more: it is resolved by
//! [`target_skills_dir`] and by no caller, so the personal target — the one
//! with the widest blast radius — is the one whose path never crosses the IPC
//! boundary.

use std::fs;
use std::path::{Path, PathBuf};

use crate::schema::skills::{
    InstalledSkill, SkillCatalogEntry, SkillDetail, SkillSource, SkillTarget,
};
use crate::storage;

fn sources_path() -> PathBuf {
    storage::state_dir().join("skills_sources.json")
}

fn cache_root() -> PathBuf {
    storage::state_dir().join("skills_cache")
}

/// A source's clone, `skills_cache/<id>`. The id arrives from the caller
/// (`skills_list_catalog`, `skills_remove_source`, …), so it must be one plain
/// folder name: `../..` would aim a recursive delete at the state dir's parent.
fn cache_dir(source_id: &str) -> Result<PathBuf, String> {
    Ok(cache_root().join(plain_name(source_id, "skills source id")?))
}

/// `name` as a single plain path component — not empty, `.` or `..`, no
/// separator (either kind, on every OS), not absolute, no drive prefix, no
/// NUL. What every name this module joins onto a folder must be: a skill's
/// folder name in a target, a source id, one segment of a catalog path.
fn plain_name<'a>(name: &'a str, what: &str) -> Result<&'a str, String> {
    let mut parts = Path::new(name).components();
    let single = matches!(parts.next(), Some(std::path::Component::Normal(_))) && parts.next().is_none();
    if !single || name.contains(['/', '\\', '\0']) || name.trim() != name {
        return Err(format!("'{name}' is not a valid {what}"));
    }
    Ok(name)
}

/// A catalog entry's skill folder: `rel_path` (`/`-separated, as the catalog
/// lists it) taken as plain segments under the source's clone, and the folder
/// it resolves to still inside that clone — a link in the repository cannot
/// aim a read or an install copy at a folder elsewhere.
fn skill_folder(source_id: &str, rel_path: &str) -> Result<PathBuf, String> {
    skill_folder_in(&cache_dir(source_id)?, rel_path)
}

fn skill_folder_in(root: &Path, rel_path: &str) -> Result<PathBuf, String> {
    if rel_path.is_empty() {
        return Err("no skill folder named".to_string());
    }
    let mut src = root.to_path_buf();
    for segment in rel_path.split('/') {
        src.push(plain_name(segment, "skill folder")?);
    }
    let real_root = root.canonicalize().map_err(|e| format!("skills source '{}': {e}", root.display()))?;
    let real = src.canonicalize().map_err(|_| format!("'{rel_path}' is not a skill folder (no SKILL.md)"))?;
    if !real.starts_with(&real_root) || real == real_root {
        return Err(format!("'{rel_path}' leads out of its skills source"));
    }
    Ok(real)
}

/// Seeded on first use — Anthropic's own skills repo, doubling as a Claude Code
/// plugin marketplace, but its skill folders are plain files on disk either way.
fn default_sources() -> Vec<SkillSource> {
    vec![SkillSource {
        id: "anthropic".to_string(),
        label: "Anthropic Skills".to_string(),
        url: "https://github.com/anthropics/skills".to_string(),
    }]
}

/// Every configured source, seeding + persisting the default set on first call
/// (a missing file, not an error — a fresh install has no sources yet). A file
/// that does not parse (corrupt, or a newer build's) is an error and stays as it
/// is: the user's added sources are never replaced by the seed.
pub fn list_sources() -> Result<Vec<SkillSource>, String> {
    patch_sources(&sources_path(), |sources| Ok(sources.clone()))
}

/// One read-modify-write of the source list, starting from the seed when the
/// file is missing.
fn patch_sources<R>(
    path: &Path,
    patch: impl FnOnce(&mut Vec<SkillSource>) -> Result<R, String>,
) -> Result<R, String> {
    storage::patch_private_json(path, default_sources(), patch)
}

/// A short, filesystem- and JSON-safe id derived from the URL, so a repeated add
/// of the same repo reuses the same cache directory rather than piling up
/// duplicates. Falls back to a label-derived slug when the URL yields nothing
/// usable (e.g. an scp-like host with no path segments).
fn slug_from(url: &str, label: &str) -> String {
    let source = if url.trim().is_empty() { label } else { url };
    let slug: String = source
        .trim()
        .trim_end_matches(".git")
        .rsplit(['/', ':'])
        .find(|s| !s.is_empty())
        .unwrap_or("source")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    if slug.is_empty() {
        "source".to_string()
    } else {
        slug
    }
}

/// Add a source, validating the URL through the same whitelist `git_clone` uses
/// (https/ssh/git/scp-like only — no `ext::`, no local paths). Re-adding the
/// same URL is a no-op that returns the existing entry rather than a duplicate.
pub fn add_source(label: String, url: String) -> Result<SkillSource, String> {
    crate::services::git_hardened::validate_clone_url(&url)?;
    add_source_in(&sources_path(), label, url)
}

fn add_source_in(path: &Path, label: String, url: String) -> Result<SkillSource, String> {
    patch_sources(path, |sources| {
        if let Some(existing) = sources.iter().find(|s| s.url == url) {
            return Ok(existing.clone());
        }
        let base = slug_from(&url, &label);
        let mut id = base.clone();
        let mut n = 2;
        while sources.iter().any(|s| s.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        let entry = SkillSource { id, label, url };
        sources.push(entry.clone());
        Ok(entry)
    })
}

/// Drop a source and its cached clone. Does not touch anything already
/// installed into a project — install is a copy, not a link.
pub fn remove_source(id: String) -> Result<(), String> {
    let dir = cache_dir(&id)?;
    patch_sources(&sources_path(), |sources| {
        sources.retain(|s| s.id != id);
        Ok(())
    })?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shallow-clone a source's repo (first time) or `pull` it (subsequent calls)
/// into its cache dir. Reuses `commands::git`'s hardened clone plumbing rather
/// than adding an HTTP client; the pull path mirrors its no-prompt env so a
/// private repo that lost access fails instead of hanging on a credential
/// prompt Tabtivity has no console to answer.
pub fn refresh_source(id: &str) -> Result<(), String> {
    let sources = list_sources()?;
    let source = sources
        .into_iter()
        .find(|s| s.id == id)
        .ok_or_else(|| format!("Unknown skills source '{id}'"))?;
    let dest = cache_dir(&source.id)?;
    if dest.join(".git").exists() {
        // Bare on purpose: the skills cache is Tabtivity's own clone in the
        // state dir, not a project tree an agent or container can write.
        let mut cmd = crate::paths::command_no_window("git");
        cmd.current_dir(&dest);
        cmd.env("GIT_TERMINAL_PROMPT", "0");
        cmd.env("GIT_SSH_COMMAND", "ssh -o BatchMode=yes");
        cmd.args(["pull", "--ff-only"]);
        let out = cmd.output().map_err(|e| e.to_string())?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(if stderr.trim().is_empty() {
                String::from_utf8_lossy(&out.stdout).to_string()
            } else {
                stderr
            });
        }
        Ok(())
    } else {
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        crate::services::git_hardened::git_clone_blocking(
            source.url.clone(),
            dest.to_string_lossy().to_string(),
        )
        .map(|_| ())
    }
}

/// Parse a `SKILL.md`'s YAML frontmatter (`name` + `description` only — no
/// other field matters at this scope) and split off the body that follows it.
/// Falls back to the folder's own name (and an empty description/full content
/// as body) when the frontmatter is missing or unparsable, so a malformed skill
/// still shows up in the catalog rather than disappearing.
fn parse_skill_md(content: &str, folder_name: &str) -> (String, String, String) {
    let mut name = folder_name.to_string();
    let mut description = String::new();
    let mut body = content.to_string();
    if let Some(rest) = content.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let block = &rest[..end];
            body = rest[end + 4..].trim_start_matches('\n').to_string();
            if let Ok(value) = serde_norway::from_str::<serde_norway::Value>(block) {
                if let Some(n) = value.get("name").and_then(|v| v.as_str()) {
                    name = n.to_string();
                }
                if let Some(d) = value.get("description").and_then(|v| v.as_str()) {
                    description = d.to_string();
                }
            }
        }
    }
    (name, description, body)
}

/// Recursively walk `dir` for `SKILL.md` files, parsing each one found. Works
/// unchanged whether the source repo is a flat collection or a Claude Code
/// plugin marketplace (`anthropics/skills`) — the marketplace manifest is never
/// parsed, since the skill folders exist as plain files on disk either way.
fn walk_for_skills(root: &Path, dir: &Path, source_id: &str, out: &mut Vec<SkillCatalogEntry>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Never through a link: a repository's link would lead the walk out
        // of the clone, or round a loop until the stack ran out.
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            if path.file_name().is_some_and(|n| n == ".git") {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            if skill_md.is_file() {
                if let Ok(content) = fs::read_to_string(&skill_md) {
                    let folder_name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let (name, description, _) = parse_skill_md(&content, &folder_name);
                    let rel_path = path
                        .strip_prefix(root)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let has_scripts = path.join("scripts").is_dir();
                    out.push(SkillCatalogEntry {
                        name,
                        description,
                        source_id: source_id.to_string(),
                        rel_path,
                        has_scripts,
                    });
                }
            }
            walk_for_skills(root, &path, source_id, out);
        }
    }
}

/// The catalog for one source, re-derived from its cache on every call —
/// nothing about it is persisted.
pub fn list_catalog(source_id: &str) -> Vec<SkillCatalogEntry> {
    let Ok(root) = cache_dir(source_id) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    walk_for_skills(&root, &root, source_id, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Every other file under `dir`, relative to `root`, for the preview panel's
/// bundled-file list. Skips `SKILL.md` itself (already shown as `body`).
fn list_bundled_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            list_bundled_files(root, &path, out);
        } else if kind.is_file() && path.file_name().is_some_and(|n| n != "SKILL.md") {
            out.push(
                path.strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        }
    }
}

/// Full read of one catalog entry for the preview panel: parsed name/
/// description, the rendered-elsewhere markdown body, and the bundled file
/// list (scripts flagged separately so an install is never a silent "and it
/// can also execute things").
pub fn get_skill_detail(source_id: &str, rel_path: &str) -> Result<SkillDetail, String> {
    let src = skill_folder(source_id, rel_path)?;
    let skill_md = src.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("'{rel_path}' is not a skill folder (no SKILL.md)"));
    }
    let content = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let folder_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let (name, description, body) = parse_skill_md(&content, &folder_name);
    let mut files = Vec::new();
    list_bundled_files(&src, &src, &mut files);
    files.sort();
    Ok(SkillDetail {
        name,
        description,
        body,
        files,
        has_scripts: src.join("scripts").is_dir(),
    })
}

fn project_skills_dir(project_dir: &str) -> PathBuf {
    Path::new(project_dir).join(".claude").join("skills")
}

/// The `.claude/skills/` directory a target names. `Personal` resolves to the
/// Tabtivity-wide agent layer (`agent_global::global_dir()`), never the user's
/// own `~/.claude` — the frontend never says where that is, so no caller can
/// turn the personal scope into an arbitrary destination.
///
/// An empty project dir is refused rather than silently resolving to a relative
/// `.claude/skills` under whatever the working directory happens to be: a
/// project whose directory could not be resolved must fail, not install
/// somewhere unrelated.
fn target_skills_dir(target: &SkillTarget) -> Result<PathBuf, String> {
    match target {
        SkillTarget::Project { dir } => {
            if dir.trim().is_empty() {
                return Err("No project directory for this skills install".to_string());
            }
            Ok(project_skills_dir(dir))
        }
        SkillTarget::Personal => Ok(crate::services::agent_global::global_dir()
            .join(".claude")
            .join("skills")),
    }
}

/// Copy the skill folder `src` to `dest`, which must not exist yet (a
/// re-install removes the old one first, so an old and a new install's files
/// never merge). The copy is [`tree_copy`]'s, bounded in entries, bytes and
/// depth; a link in the skill is skipped, not followed: a repository's
/// `notes -> ~/.ssh` would otherwise copy that folder into the project.
///
/// [`tree_copy`]: crate::services::tree_copy
fn copy_skill(src: &Path, dest: &Path) -> std::io::Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    crate::services::tree_copy::copy_tree_without_links(src, dest).map(|_| ())
}

/// `<target>/.claude/skills/<name>`, for a `name` that is one plain folder
/// name. A project's `.claude/skills` is the project's — attacker-controlled
/// content — so it must still resolve inside the project: a planted
/// `.claude/skills -> ~/.config` would aim the delete and the copy there.
fn installed_skill_dir(target: &SkillTarget, name: &str) -> Result<PathBuf, String> {
    let name = plain_name(name, "skill name")?;
    let skills = target_skills_dir(target)?;
    if let SkillTarget::Project { dir } = target {
        let project = crate::paths::canonical_or_new(Path::new(dir))?;
        let real = crate::paths::canonical_or_new(&skills)?;
        if !real.starts_with(&project) {
            return Err(format!("'{}' leads out of the project", skills.display()));
        }
        return Ok(real.join(name));
    }
    Ok(skills.join(name))
}

/// Copy a skill folder verbatim into the target's `.claude/skills/<name>/`.
/// Overwrites an existing install of the same name (e.g. after a source
/// refresh) — no commit-pin, no drift detection; the frontend confirms the
/// overwrite before calling this.
pub fn install_skill(target: &SkillTarget, source_id: &str, rel_path: &str) -> Result<(), String> {
    let src = skill_folder(source_id, rel_path)?;
    if !src.join("SKILL.md").is_file() {
        return Err(format!("'{rel_path}' is not a skill folder (no SKILL.md)"));
    }
    let content = fs::read_to_string(src.join("SKILL.md")).map_err(|e| e.to_string())?;
    let folder_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    // The name comes from the catalog's own SKILL.md: a repository's
    // `name: ../../..` must not pick the folder that is deleted and refilled.
    let (name, _, _) = parse_skill_md(&content, &folder_name);
    let dest = installed_skill_dir(target, &name)?;
    if fs::symlink_metadata(&dest).is_ok() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    copy_skill(&src, &dest).map_err(|e| e.to_string())
}

/// Delete `<target>/.claude/skills/<name>/`.
pub fn uninstall_skill(target: &SkillTarget, name: &str) -> Result<(), String> {
    let dir = installed_skill_dir(target, name)?;
    if fs::symlink_metadata(&dir).is_ok() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every skill folder actually on disk under the target's `.claude/skills/` —
/// so a hand-authored or agent-authored skill shows up too, not just ones
/// installed through this UI. Deliberately the only source of truth for "is
/// this skill here"; there is no separate tracked install state.
pub fn list_installed(target: &SkillTarget) -> Vec<InstalledSkill> {
    let Ok(dir) = target_skills_dir(target) else {
        return Vec::new();
    };
    list_installed_at(&dir)
}

/// The read half of [`list_installed`], against an already-resolved directory —
/// the seam a unit test can drive without a home directory to redirect.
fn list_installed_at(dir: &Path) -> Vec<InstalledSkill> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let Ok(content) = fs::read_to_string(&skill_md) else {
            continue;
        };
        let folder_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let (name, description, _) = parse_skill_md(&content, &folder_name);
        out.push(InstalledSkill { name, description });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A source list that does not parse is left as it is: neither a read nor
    /// an add replaces the user's sources with the seed. A missing one is seeded.
    #[test]
    fn an_unreadable_source_list_is_never_replaced_by_the_seed() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("skills_sources.json");
        let unreadable = r#"[{"id":"mine","label":"Mine","url":"https://example.com/s.git"}"#;
        std::fs::write(&path, unreadable).unwrap();
        assert!(patch_sources(&path, |s| Ok(s.clone())).is_err());
        assert!(add_source_in(&path, "Other".into(), "https://example.com/o.git".into()).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), unreadable);

        std::fs::remove_file(&path).unwrap();
        let added = add_source_in(&path, "Other".into(), "https://example.com/o.git".into()).unwrap();
        let ids: Vec<String> = patch_sources(&path, |s| Ok(s.iter().map(|s| s.id.clone()).collect())).unwrap();
        assert_eq!(ids, vec!["anthropic".to_string(), added.id]);
    }

    #[test]
    fn parse_skill_md_reads_frontmatter_and_strips_it() {
        let content = "---\nname: pdf-fill\ndescription: Fill PDF forms\n---\n# Body\ntext\n";
        let (name, description, body) = parse_skill_md(content, "fallback");
        assert_eq!(name, "pdf-fill");
        assert_eq!(description, "Fill PDF forms");
        assert_eq!(body, "# Body\ntext\n");
    }

    #[test]
    fn parse_skill_md_falls_back_without_frontmatter() {
        let content = "# Just a body\n";
        let (name, description, body) = parse_skill_md(content, "fallback-name");
        assert_eq!(name, "fallback-name");
        assert_eq!(description, "");
        assert_eq!(body, content);
    }

    #[test]
    fn slug_from_derives_from_url_path() {
        assert_eq!(
            slug_from("https://github.com/anthropics/skills", ""),
            "skills"
        );
        assert_eq!(
            slug_from("https://github.com/anthropics/skills.git", ""),
            "skills"
        );
        assert_eq!(slug_from("git@host:owner/Some_Repo.git", ""), "some-repo");
        assert_eq!(slug_from("", "My Label"), "my-label");
    }

    #[test]
    fn install_then_list_then_uninstall_roundtrip() {
        let cache = tempfile::tempdir().expect("tempdir");
        let skill_dir = cache.path().join("pdf-fill");
        fs::create_dir_all(skill_dir.join("scripts")).unwrap();
        fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: pdf-fill\ndescription: Fill PDF forms\n---\nBody\n",
        )
        .unwrap();
        fs::write(skill_dir.join("scripts").join("run.py"), "print('hi')").unwrap();

        let project = tempfile::tempdir().expect("tempdir");
        let project_dir = project.path().to_string_lossy().to_string();
        let target = SkillTarget::Project {
            dir: project_dir.clone(),
        };

        // install_skill/get_skill_detail resolve against the source's cache dir
        // (state_dir()/skills_cache/<id>), which a unit test can't redirect
        // without touching global state — so this test drives the copy helper
        // and the project-side read paths directly instead.
        let dest = project_skills_dir(&project_dir).join("pdf-fill");
        copy_skill(&skill_dir, &dest).unwrap();
        assert!(dest.join("SKILL.md").is_file());
        assert!(dest.join("scripts").join("run.py").is_file());

        let installed = list_installed(&target);
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, "pdf-fill");
        assert_eq!(installed[0].description, "Fill PDF forms");

        uninstall_skill(&target, "pdf-fill").unwrap();
        assert!(!dest.exists());
        assert!(list_installed(&target).is_empty());
    }

    #[test]
    fn target_skills_dir_resolves_both_scopes() {
        let project = target_skills_dir(&SkillTarget::Project {
            dir: "/tmp/proj".into(),
        })
        .unwrap();
        assert_eq!(
            project,
            Path::new("/tmp/proj").join(".claude").join("skills")
        );

        // Personal resolves to the Tabtivity-wide agent layer, which every
        // agent home is laid from — never the user's own `~/.claude/skills`
        // (another app's config). No argument reached it, so no caller can aim
        // it elsewhere.
        let personal = target_skills_dir(&SkillTarget::Personal).unwrap();
        assert_eq!(
            personal,
            crate::services::agent_global::global_dir()
                .join(".claude")
                .join("skills")
        );
        let home_skills = Path::new(&crate::paths::home_dir_string()).join(".claude").join("skills");
        assert_ne!(personal, home_skills);
    }

    #[test]
    fn target_skills_dir_refuses_an_empty_project_dir() {
        // Would otherwise resolve to a relative `.claude/skills` under whatever
        // the working directory happens to be — an install somewhere unrelated
        // reported as a success.
        assert!(target_skills_dir(&SkillTarget::Project { dir: String::new() }).is_err());
        assert!(target_skills_dir(&SkillTarget::Project { dir: "  ".into() }).is_err());
        assert!(list_installed(&SkillTarget::Project { dir: String::new() }).is_empty());
    }

    #[test]
    fn a_name_joined_onto_a_folder_is_one_plain_component() {
        for bad in ["", ".", "..", "../..", "a/b", "a\\b", "/etc", " x", "x\0"] {
            assert!(plain_name(bad, "name").is_err(), "{bad:?}");
        }
        if cfg!(windows) {
            assert!(plain_name("C:", "name").is_err());
        }
        assert_eq!(plain_name("pdf-fill", "name").unwrap(), "pdf-fill");
        assert!(cache_dir("../..").is_err(), "a source id never climbs out of the cache");
        assert!(cache_dir("/").is_err());
        assert!(cache_dir("anthropic").is_ok());
    }

    #[test]
    fn uninstall_never_leaves_the_targets_skills_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let victim = tmp.path().join("victim");
        fs::create_dir_all(&victim).unwrap();
        let project = tmp.path().join("p");
        fs::create_dir_all(project.join(".claude").join("skills")).unwrap();
        let target = SkillTarget::Project { dir: project.to_string_lossy().into_owned() };
        for name in ["../../victim", &victim.to_string_lossy(), "..", ""] {
            assert!(uninstall_skill(&target, name).is_err(), "{name:?}");
        }
        assert!(victim.is_dir(), "nothing outside the skills folder was deleted");
    }

    #[test]
    fn a_catalog_path_stays_inside_its_source() {
        let tmp = tempfile::tempdir().unwrap();
        let clone = tmp.path().join("clone");
        fs::create_dir_all(clone.join("good")).unwrap();
        fs::write(clone.join("good").join("SKILL.md"), "x").unwrap();
        let elsewhere = tmp.path().join("elsewhere");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join("SKILL.md"), "x").unwrap();
        assert!(skill_folder_in(&clone, "good").is_ok());
        for bad in ["../elsewhere", "good/../../elsewhere", &elsewhere.to_string_lossy(), "", "good/"] {
            assert!(skill_folder_in(&clone, bad).is_err(), "{bad:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&elsewhere, clone.join("link")).unwrap();
            assert!(skill_folder_in(&clone, "link").is_err(), "a link in the repository leads nowhere outside it");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_link_is_never_followed_by_an_install() {
        let tmp = tempfile::tempdir().unwrap();
        let secret = tmp.path().join("secret");
        fs::create_dir_all(&secret).unwrap();
        fs::write(secret.join("id_key"), "k").unwrap();
        // A skill whose folder carries a link out of the repository.
        let skill = tmp.path().join("skill");
        fs::create_dir_all(&skill).unwrap();
        fs::write(skill.join("SKILL.md"), "x").unwrap();
        std::os::unix::fs::symlink(&secret, skill.join("notes")).unwrap();
        std::os::unix::fs::symlink(secret.join("id_key"), skill.join("key")).unwrap();
        let dest = tmp.path().join("dest");
        copy_skill(&skill, &dest).unwrap();
        assert!(dest.join("SKILL.md").is_file());
        assert!(fs::symlink_metadata(dest.join("notes")).is_err(), "a linked folder is not copied");
        assert!(fs::symlink_metadata(dest.join("key")).is_err(), "a linked file is not copied");
        // A project whose `.claude/skills` leads out of it.
        let project = tmp.path().join("p");
        fs::create_dir_all(project.join(".claude")).unwrap();
        std::os::unix::fs::symlink(&secret, project.join(".claude").join("skills")).unwrap();
        let target = SkillTarget::Project { dir: project.to_string_lossy().into_owned() };
        assert!(installed_skill_dir(&target, "id_key").is_err());
        assert!(uninstall_skill(&target, "id_key").is_err());
        assert!(secret.join("id_key").is_file());
    }

    #[test]
    fn list_catalog_walks_nested_skill_folders() {
        let root = tempfile::tempdir().expect("tempdir");
        let a = root.path().join("category").join("skill-a");
        fs::create_dir_all(&a).unwrap();
        fs::write(
            a.join("SKILL.md"),
            "---\nname: skill-a\ndescription: A\n---\n",
        )
        .unwrap();

        let b = root.path().join("skill-b");
        fs::create_dir_all(&b).unwrap();
        fs::write(
            b.join("SKILL.md"),
            "---\nname: skill-b\ndescription: B\n---\n",
        )
        .unwrap();

        let mut out = Vec::new();
        walk_for_skills(root.path(), root.path(), "src", &mut out);
        out.sort_by(|x, y| x.name.cmp(&y.name));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "skill-a");
        assert_eq!(out[0].rel_path, "category/skill-a");
        assert_eq!(out[1].name, "skill-b");
        assert_eq!(out[1].rel_path, "skill-b");
    }
}
