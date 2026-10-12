//! The approval half of `services::exec_trust`: the frontend calls this after
//! the user reviewed what a gated action would run.

use std::path::Path;

use crate::services::exec_trust::{approve, TrustKind};

#[cfg_attr(feature = "desktop", tauri::command)]
pub fn exec_trust_approve(kind: String, dir: String, fingerprint: String) -> Result<(), String> {
    let kind = TrustKind::parse(&kind).ok_or_else(|| format!("unknown trust kind '{kind}'"))?;
    approve(kind, Path::new(&dir), &fingerprint)
}
