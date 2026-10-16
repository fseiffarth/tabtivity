//! Tauri commands for the Skills Library (`docs/done/skills_plan.md`). Thin wrappers
//! over `services::skills` — every filesystem/git op is offloaded to the
//! blocking pool since a Tauri command otherwise runs on the async runtime's
//! worker (a `git pull`/clone here is the same cost class as `git_clone`).

use crate::schema::skills::{
    InstalledSkill, SkillCatalogEntry, SkillDetail, SkillSource, SkillTarget,
};
use crate::services::skills;

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_list_sources() -> Result<Vec<SkillSource>, String> {
    app_core::rt::try_blocking("skills", || Ok(skills::list_sources())).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_add_source(label: String, url: String) -> Result<SkillSource, String> {
    app_core::rt::try_blocking("skills", move || skills::add_source(label, url)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_remove_source(id: String) -> Result<(), String> {
    app_core::rt::try_blocking("skills", move || skills::remove_source(id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_refresh_source(id: String) -> Result<(), String> {
    app_core::rt::try_blocking("skills", move || skills::refresh_source(&id)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_list_catalog(source_id: String) -> Result<Vec<SkillCatalogEntry>, String> {
    app_core::rt::try_blocking("skills", move || Ok(skills::list_catalog(&source_id))).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_get_detail(source_id: String, rel_path: String) -> Result<SkillDetail, String> {
    app_core::rt::try_blocking("skills", move || skills::get_skill_detail(&source_id, &rel_path)).await
}

/// The install trio takes a `SkillTarget`, never a bare path: the personal
/// scope (the Tabtivity-wide agent layer's `.claude/skills/`, laid into every
/// agent home on this machine) is a
/// variant with no fields, so the frontend can *ask* for it without being able
/// to say where it is. See `schema::skills::SkillTarget`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_install(
    target: SkillTarget,
    source_id: String,
    rel_path: String,
) -> Result<(), String> {
    app_core::rt::try_blocking("skills", move || skills::install_skill(&target, &source_id, &rel_path)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_uninstall(target: SkillTarget, name: String) -> Result<(), String> {
    app_core::rt::try_blocking("skills", move || skills::uninstall_skill(&target, &name)).await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn skills_list_installed(target: SkillTarget) -> Result<Vec<InstalledSkill>, String> {
    app_core::rt::try_blocking("skills", move || Ok(skills::list_installed(&target))).await
}
