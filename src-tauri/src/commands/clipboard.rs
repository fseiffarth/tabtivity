//! System-clipboard bridge (images both ways, plus terminal text out):
//!
//! - **In:** the file tree turns an image already on the OS clipboard into a PNG
//!   file inside the project ([`clipboard_has_image`] / [`save_clipboard_image`]).
//!   The path side reuses `fs`'s relative-path confinement so a paste can only
//!   ever land inside the project root.
//! - **Out:** [`copy_image_to_clipboard`] / [`copy_png_file_to_clipboard`] /
//!   [`copy_png_bytes_to_clipboard`] put an image *on* the clipboard, so a
//!   screenshot Tabtivity files into the project — or a region selected in the PDF
//!   viewer — is pasteable straight into a chat, an editor, or an agent tab.
//!   [`copy_text_to_clipboard`] does the same for terminal text: OSC 52
//!   requests and the user's own copies out of a pane.

use std::borrow::Cow;
use std::path::Path;

use crate::commands::fs::{canonical_or_new, enforce_confinement};

/// Whether the system clipboard currently holds an image. Used to decide if the
/// file tree's context menu should offer "Paste screenshot". Any failure
/// (no clipboard, no image, unsupported platform) reports `false` rather than
/// erroring so the menu simply omits the option.
///
/// Runs on a blocking worker rather than the main thread: on X11 the `arboard`
/// probe stalls while negotiating the clipboard selection (notably when there is
/// *no* image, where it waits out a transfer timeout). A synchronous Tauri
/// command executes on the main thread and would freeze the webview for that
/// whole stall — which made the file-tree context menu take a long time to
/// appear, since it fires this probe as it opens. Keeping the work off-thread
/// lets the menu paint immediately and the "Paste screenshot" item appear once
/// the probe resolves.
#[tauri::command]
pub async fn clipboard_has_image() -> bool {
    tauri::async_runtime::spawn_blocking(|| match arboard::Clipboard::new() {
        Ok(mut cb) => cb.get_image().is_ok(),
        Err(_) => false,
    })
    .await
    .unwrap_or(false)
}

/// Read the clipboard image and write it as a PNG at `project_dir`/`rel_path`.
/// The destination is confined to the project root and must not already exist.
#[tauri::command]
pub fn save_clipboard_image(project_dir: String, rel_path: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    let img = cb
        .get_image()
        .map_err(|_| "no image on the clipboard".to_string())?;

    let root = std::fs::canonicalize(&project_dir).map_err(|e| e.to_string())?;
    let dest = root.join(&rel_path);
    let dest_c = canonical_or_new(&dest)?;
    enforce_confinement(&root, &dest_c)?;
    if dest_c.exists() {
        return Err(format!("'{}' already exists", dest.display()));
    }
    if let Some(parent) = dest_c.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let png = encode_png(img.width, img.height, &img.bytes)?;
    // `create_new` + `O_NOFOLLOW`: a file or link that appeared since the
    // check is refused, never overwritten or followed.
    crate::commands::projects::write_no_follow(&dest_c, &png, true).map_err(|e| e.to_string())
}

/// Put raw RGBA8 pixels on the system clipboard as an image.
///
/// On X11/Wayland the clipboard has no OS-owned store: the *owning process*
/// serves the data on request, and arboard tears its serving window down as soon
/// as the last `Clipboard` handle drops — so a set-then-drop would leave nothing
/// to paste. Hence the Linux path hands the image to a thread that calls
/// `.wait()`, which keeps serving until another app takes the selection over
/// (including the next Tabtivity screenshot). It therefore returns before the image
/// is necessarily on the clipboard, and a failure there is silent. Windows and
/// macOS copy the bytes into an OS-owned clipboard, so there they are set inline.
pub fn copy_image_to_clipboard(width: usize, height: usize, rgba: Vec<u8>) -> Result<(), String> {
    let expected = width.checked_mul(height).and_then(|p| p.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err("image has an unexpected size".to_string());
    }
    let image = arboard::ImageData {
        width,
        height,
        bytes: Cow::Owned(rgba),
    };

    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        std::thread::spawn(move || {
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set().wait().image(image);
            }
        });
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_image(image).map_err(|e| e.to_string())
    }
}

/// Longest text [`copy_text_to_clipboard`] takes. A terminal's OSC 52 request
/// is capped far below this already (`OSC52_MAX_CHARS`); a longer user copy
/// falls back to the webview. This bounds what the command itself will hold
/// and serve.
const MAX_CLIPBOARD_TEXT: usize = 1 << 20;

fn check_clipboard_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_CLIPBOARD_TEXT {
        return Err("text is too long for the clipboard".to_string());
    }
    Ok(())
}

/// Put text on the system clipboard.
///
/// For a terminal program's OSC 52 copy request (tmux copy-mode, an agent
/// CLI's own copy command) and every copy the user makes in a terminal pane.
/// The webview's `navigator.clipboard` writes only while WebKit still counts a
/// click or key press as being handled: an OSC 52 request arrives with PTY
/// output, so there it was always refused, and even mouse-up copies were
/// dropped now and then — silently. The pane falls back to the webview only
/// when this command fails.
///
/// Serves the text the way [`copy_image_to_clipboard`] serves an image: on Linux
/// a thread owns the selection until another app takes it over. It reports back
/// once it has a clipboard connection, so a missing clipboard is an error here,
/// but a failure after that (the set itself) is silent. Off the main thread
/// throughout: arboard can stall negotiating with X11 (see [`clipboard_has_image`]).
#[tauri::command]
pub async fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    check_clipboard_text(&text)?;

    #[cfg(target_os = "linux")]
    {
        use arboard::SetExtLinux;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || match arboard::Clipboard::new() {
            Ok(mut cb) => {
                let _ = tx.send(Ok(()));
                let _ = cb.set().wait().text(text);
            }
            Err(e) => {
                let _ = tx.send(Err(e.to_string()));
            }
        });
        tauri::async_runtime::spawn_blocking(move || {
            rx.recv()
                .unwrap_or_else(|_| Err("the clipboard thread ended early".to_string()))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(not(target_os = "linux"))]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_text(text).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Read a PNG file and put it on the system clipboard as an image.
pub fn copy_png_file_to_clipboard(path: &Path) -> Result<(), String> {
    let (width, height, rgba) = decode_png_rgba(path)?;
    copy_image_to_clipboard(width, height, rgba)
}

/// Put an in-memory PNG on the system clipboard as an image.
///
/// The PDF viewer renders a selected rectangle into a small PNG in the webview
/// and sends those compressed bytes here. Keeping the IPC payload compressed is
/// important: a moderately sized selection can contain several million RGBA
/// bytes, while the PNG is normally a fraction of that size.
#[tauri::command]
pub fn copy_png_bytes_to_clipboard(png: Vec<u8>) -> Result<(), String> {
    let (width, height, rgba) = decode_png_bytes_rgba(&png)?;
    copy_image_to_clipboard(width, height, rgba)
}

/// Decode a PNG file to RGBA8. Capture tools emit whatever color type they like
/// (grayscale, palette, RGB, 16-bit), while the clipboard wants plain RGBA8:
/// `normalize_to_color8` folds palette/16-bit/sub-byte-gray down to 8-bit
/// channels, leaving only the four channel layouts expanded below.
fn decode_png_rgba(path: &Path) -> Result<(usize, usize, Vec<u8>), String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    decode_png_bytes_rgba(&bytes)
}

/// Decode PNG bytes to the one pixel layout `arboard` accepts.
fn decode_png_bytes_rgba(bytes: &[u8]) -> Result<(usize, usize, Vec<u8>), String> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).map_err(|e| e.to_string())?;
    let px = &buf[..info.buffer_size()];

    let rgba = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        // `as_chunks::<N>` rather than `chunks_exact(N)`: the chunk size is a
        // constant, so each pixel arrives as a fixed-size array the compiler can
        // see through instead of a slice it must bounds-check. `.0` is the whole
        // chunks — the `.1` remainder is the trailing partial pixel, which
        // `chunks_exact` dropped too, so this is the same data.
        png::ColorType::Rgb => px
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[1], c[2], 0xFF])
            .collect(),
        png::ColorType::GrayscaleAlpha => px
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|&g| [g, g, g, 0xFF]).collect(),
        png::ColorType::Indexed => return Err("indexed PNG was not expanded".to_string()),
    };
    Ok((info.width as usize, info.height as usize, rgba))
}

/// Encode raw RGBA8 pixels as a PNG byte buffer.
pub(crate) fn encode_png(width: usize, height: usize, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected = width.checked_mul(height).and_then(|p| p.checked_mul(4));
    if expected != Some(rgba.len()) {
        return Err("clipboard image has an unexpected size".to_string());
    }
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_png_round_trips_dimensions() {
        // 2x1 RGBA image → decodes back to the same dimensions.
        let rgba = vec![255u8, 0, 0, 255, 0, 255, 0, 255];
        let png_bytes = encode_png(2, 1, &rgba).unwrap();
        let decoder = png::Decoder::new(png_bytes.as_slice());
        let reader = decoder.read_info().unwrap();
        let info = reader.info();
        assert_eq!((info.width, info.height), (2, 1));
    }

    #[test]
    fn clipboard_text_is_capped() {
        assert!(check_clipboard_text("hello").is_ok());
        assert!(check_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT)).is_ok());
        assert!(check_clipboard_text(&"x".repeat(MAX_CLIPBOARD_TEXT + 1)).is_err());
    }

    #[test]
    fn encode_png_rejects_size_mismatch() {
        // 3 bytes can't be a 2x1 RGBA image (needs 8).
        assert!(encode_png(2, 1, &[0, 0, 0]).is_err());
    }

    /// Capture tools emit plain RGB PNGs (no alpha); the clipboard needs RGBA, so
    /// the decoder has to widen them rather than reject them.
    #[test]
    fn decode_png_rgba_widens_an_rgb_png() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rgb.png");
        let file = std::fs::File::create(&path).unwrap();
        let mut encoder = png::Encoder::new(file, 2, 1);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[255, 0, 0, 0, 255, 0]).unwrap();
        drop(writer);

        let (width, height, rgba) = decode_png_rgba(&path).unwrap();
        assert_eq!((width, height), (2, 1));
        assert_eq!(rgba, vec![255, 0, 0, 255, 0, 255, 0, 255]);
    }

    /// An RGBA PNG (what Tabtivity itself writes) round-trips unchanged.
    #[test]
    fn decode_png_rgba_round_trips_rgba() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rgba.png");
        let rgba = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        std::fs::write(&path, encode_png(2, 1, &rgba).unwrap()).unwrap();

        assert_eq!(decode_png_rgba(&path).unwrap(), (2, 1, rgba));
    }

    #[test]
    fn decode_png_bytes_round_trips_rgba() {
        let rgba = vec![1u8, 2, 3, 4, 5, 6, 7, 8];
        let png = encode_png(2, 1, &rgba).unwrap();

        assert_eq!(decode_png_bytes_rgba(&png).unwrap(), (2, 1, rgba));
    }

    #[test]
    fn copy_image_rejects_size_mismatch() {
        assert!(copy_image_to_clipboard(2, 1, vec![0, 0, 0]).is_err());
    }
}
