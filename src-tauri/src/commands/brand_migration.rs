//! Tauri surface of `services::brand_migration`: what Settings → Updates
//! shows about the app's rename.

use crate::services::brand_migration::{self, Status};

/// Which lookups still found something under the app's old name, and which
/// migration steps are not done. Empty while the name is unchanged.
#[cfg_attr(feature = "desktop", tauri::command)]
pub fn legacy_name_status() -> Status {
    brand_migration::status()
}
