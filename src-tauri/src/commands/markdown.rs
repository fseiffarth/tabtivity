//! Remote images in the markdown preview.
//!
//! The renderer shows an `![](https://…)` image as a placeholder, and the app's
//! CSP (`img-src 'self' data: blob:`) means the webview could not fetch it
//! anyway. A document therefore reaches the network only when the user presses
//! "Load" on it, and then only through this command, which uses the reader
//! fetch with its document-origin rules
//! (`services::browser_engine::fetch_document_image`): https only, nothing on
//! this machine or its local network, size- and type-capped.

use base64::Engine;
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteImage {
    pub mime: String,
    pub data_base64: String,
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn markdown_remote_image(url: String) -> Result<RemoteImage, String> {
    let image = crate::services::browser_engine::fetch_document_image(&url).await?;
    Ok(RemoteImage {
        mime: image.mime,
        data_base64: base64::engine::general_purpose::STANDARD.encode(&image.bytes),
    })
}
