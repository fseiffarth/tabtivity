//! Print a PDF the way a PDF app does: the PDF itself goes to the printer,
//! through the system's own print UI.
//!
//! The in-app print path (`lib/viewers/print.ts`) prints an HTML document
//! through the webview, and WebKitGTK has no PDF engine — so a PDF reaches
//! paper there as one raster image per page. However high the resolution, that
//! is not what Evince, Preview or Edge print: they hand the *document* to the
//! print system, text stays vector, and the printer renders it at its own
//! resolution. Each OS does the same here with the engine that OS's PDF app
//! uses:
//!
//!  - **Linux** — `GtkPrintUnixDialog`, then a `GtkPrintJob` whose source file
//!    is the PDF (Evince/Firefox's path; CUPS accepts PDF natively, and the
//!    dialog's page range / copies / pages-per-sheet travel as job options).
//!    gtk-rs 0.18 has no bindings for GTK 3's unix-print half, so the ten
//!    functions used are declared here; they live in the `libgtk-3` the window
//!    already links.
//!  - **Windows** — WebView2 *is* Edge's engine, PDF viewer (PDFium) included:
//!    a print window loads the PDF and opens its print preview
//!    (`ShowPrintUI`), which is exactly Edge printing a PDF. The window stays
//!    up afterwards showing the document, with the viewer's own print button.
//!  - **macOS** — PDFKit's `PDFDocument` print operation, the one Preview runs,
//!    with the system print panel.
//!
//! What crosses the IPC boundary is **bytes, never a path**: the print manager
//! deliberately has no print-this-file command (see `printing.rs`), and this is
//! not one — the frontend builds the arranged PDF (`buildPdf`, blackouts burned
//! in) and nothing prints without the user confirming the system's print UI.

/// Returned when this platform has no native PDF print path; the frontend
/// falls back to its own print preview on seeing it.
pub const UNSUPPORTED: &str = crate::brand::NATIVE_PRINT_UNSUPPORTED;

/// What the system print dialog opens preset to: the paper the frontend laid
/// the document out on (`A4`, `Letter`, …) and colour off for a grayscale job.
/// Linux only; the other paths ignore it.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintSetup {
    pub paper: String,
    pub grayscale: bool,
}

/// GTK's PWG name for a preview paper size; `None` leaves the dialog's default.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn gtk_paper_name(paper: &str) -> Option<&'static str> {
    match paper {
        "A3" => Some("iso_a3"),
        "A4" => Some("iso_a4"),
        "A5" => Some("iso_a5"),
        "Letter" => Some("na_letter"),
        "Legal" => Some("na_legal"),
        _ => None,
    }
}

/// Outcome of a native print: `"sent"` once the job reached the print system,
/// `"cancelled"` when the user closed the dialog, `"opened"` where the system
/// print UI owns the rest and reports nothing back (Windows).
#[tauri::command]
pub async fn print_pdf_native(
    window: tauri::WebviewWindow,
    bytes: Vec<u8>,
    title: String,
    setup: Option<PrintSetup>,
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("nothing to print".into());
    }
    imp::print(window, bytes, title, setup).await
}

/// A private (0600, unique) spool file holding the PDF, for the print paths
/// that hand the print system a file. Deleted when dropped.
#[cfg(any(target_os = "linux", target_os = "windows"))]
async fn write_spool(bytes: Vec<u8>) -> Result<tempfile::NamedTempFile, String> {
    use std::io::Write;
    tauri::async_runtime::spawn_blocking(move || {
        let mut f = tempfile::Builder::new()
            .prefix(concat!(crate::app_slug!(), "-print-"))
            .suffix(".pdf")
            .tempfile()
            .map_err(|e| format!("print spool: {e}"))?;
        f.write_all(&bytes).map_err(|e| format!("print spool: {e}"))?;
        f.flush().map_err(|e| format!("print spool: {e}"))?;
        Ok(f)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
mod imp {
    pub async fn print(
        _window: tauri::WebviewWindow,
        _bytes: Vec<u8>,
        _title: String,
        _setup: Option<super::PrintSetup>,
    ) -> Result<String, String> {
        Err(super::UNSUPPORTED.into())
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::NSPrintInfo;
    use objc2_foundation::{NSData, NSString};
    use objc2_pdf_kit::{PDFDocument, PDFPrintScalingMode};

    pub async fn print(
        window: tauri::WebviewWindow,
        bytes: Vec<u8>,
        title: String,
        _setup: Option<super::PrintSetup>,
    ) -> Result<String, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        window
            .run_on_main_thread(move || {
                let _ = tx.send(run(bytes, &title));
            })
            .map_err(|e| e.to_string())?;
        rx.await
            .unwrap_or_else(|_| Err("the print panel did not open".into()))
    }

    /// Main thread. `runOperation` runs the print panel app-modally (AppKit
    /// keeps the event loop turning inside it) and answers whether the job
    /// went out — which also keeps the document and the operation alive for
    /// exactly as long as the panel needs them.
    fn run(bytes: Vec<u8>, title: &str) -> Result<String, String> {
        let mtm = MainThreadMarker::new().ok_or("print: not on the main thread")?;
        let data = NSData::with_bytes(&bytes);
        // SAFETY: a fresh allocation initialised from owned bytes; PDFKit
        // answers nil (None) for data it cannot read.
        let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }
            .ok_or("PDFKit could not read the document")?;
        let info = NSPrintInfo::sharedPrintInfo();
        // SAFETY: main thread (`mtm`), live document and print info.
        let op = unsafe {
            doc.printOperationForPrintInfo_scalingMode_autoRotate(
                Some(&info),
                PDFPrintScalingMode::PageScaleDownToFit,
                true,
                mtm,
            )
        }
        .ok_or("PDFKit could not prepare the print job")?;
        op.setJobTitle(Some(&NSString::from_str(title)));
        op.setShowsPrintPanel(true);
        op.setShowsProgressPanel(true);
        Ok(if op.runOperation() { "sent" } else { "cancelled" }.into())
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use tauri::webview::{NewWindowResponse, PageLoadEvent};
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_16, COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER,
    };
    use windows::core::Interface;

    pub async fn print(
        window: tauri::WebviewWindow,
        bytes: Vec<u8>,
        title: String,
        _setup: Option<super::PrintSetup>,
    ) -> Result<String, String> {
        let spool = super::write_spool(bytes).await?;
        let url = tauri::Url::from_file_path(spool.path())
            .map_err(|_| "print spool: no file URL for it".to_string())?;
        // Not in any capability's `webviews`, and a `file:` origin is remote to
        // Tauri, so this window can reach no command and no plugin.
        let label = format!("print-{}", crate::commands::projects::uuid_v4());
        let allowed = url.clone();
        let asked = AtomicBool::new(false);
        let win = WebviewWindowBuilder::new(window.app_handle(), &label, WebviewUrl::External(url))
            .title(format!("{title} — Print"))
            .inner_size(900.0, 1000.0)
            .incognito(true)
            .browser_extensions_enabled(false)
            // The document is attacker-controlled (anything in a project
            // folder is): its links go nowhere, in this window or a new one.
            .on_navigation(move |target| *target == allowed)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_page_load(move |win, payload| {
                if !matches!(payload.event(), PageLoadEvent::Finished)
                    || asked.swap(true, Ordering::SeqCst)
                {
                    return;
                }
                // SAFETY: COM calls on the live controller Tauri hands us, on
                // the webview's own thread. A runtime older than
                // `ICoreWebView2_16` just leaves the viewer up, whose toolbar
                // prints the same way.
                let _ = win.with_webview(|webview| unsafe {
                    if let Ok(core) = webview.controller().CoreWebView2() {
                        if let Ok(core16) = core.cast::<ICoreWebView2_16>() {
                            let _ = core16.ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_BROWSER);
                        }
                    }
                });
            })
            .build()
            .map_err(|e| format!("print window: {e}"))?;
        crate::hook_webview_crash_reporter(&win);
        crate::commands::browser::deny_all_permissions(&win);
        // The spool lives exactly as long as the window showing it.
        let spool = Mutex::new(Some(spool));
        win.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if let Ok(mut held) = spool.lock() {
                    held.take();
                }
            }
        });
        Ok("opened".into())
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use std::ffi::{c_char, c_int, c_uint, c_void, CString};
    use std::os::unix::ffi::OsStrExt;

    use gtk::glib;
    use gtk::glib::translate::{FromGlibPtrNone, ToGlibPtr};
    use gtk::prelude::*;
    use tokio::sync::oneshot;

    type Gp = *mut c_void;
    type Done = oneshot::Sender<Result<String, String>>;

    /// `GTK_PRINT_CAPABILITY_GENERATE_PDF` (`1 << 5` in `gtkprinter.h`): tells
    /// the dialog the document is a PDF, so "Print to File" offers PDF output.
    /// Nothing else is declared manual — page range, copies, collate, reverse
    /// and pages-per-sheet are left to the printer backend, which is what makes
    /// CUPS apply them to the PDF it receives.
    const CAPABILITY_GENERATE_PDF: c_uint = 1 << 5;

    #[link(name = "gtk-3")]
    extern "C" {
        fn gtk_print_unix_dialog_new(title: *const c_char, parent: Gp) -> Gp;
        fn gtk_print_unix_dialog_set_manual_capabilities(dialog: Gp, caps: c_uint);
        fn gtk_print_unix_dialog_set_embed_page_setup(dialog: Gp, embed: c_int);
        fn gtk_print_unix_dialog_set_settings(dialog: Gp, settings: Gp);
        fn gtk_print_unix_dialog_set_page_setup(dialog: Gp, setup: Gp);
        /// transfer none
        fn gtk_print_unix_dialog_get_selected_printer(dialog: Gp) -> Gp;
        /// transfer full
        fn gtk_print_unix_dialog_get_settings(dialog: Gp) -> Gp;
        /// transfer none
        fn gtk_print_unix_dialog_get_page_setup(dialog: Gp) -> Gp;
        fn gtk_printer_accepts_pdf(printer: Gp) -> c_int;
        /// transfer full
        fn gtk_print_job_new(title: *const c_char, printer: Gp, settings: Gp, setup: Gp) -> Gp;
        fn gtk_print_job_set_source_file(
            job: Gp,
            filename: *const c_char,
            error: *mut *mut glib::ffi::GError,
        ) -> c_int;
        fn gtk_print_job_send(
            job: Gp,
            callback: unsafe extern "C" fn(Gp, Gp, *const glib::ffi::GError),
            user_data: Gp,
            dnotify: Option<unsafe extern "C" fn(Gp)>,
        );
    }

    pub async fn print(
        window: tauri::WebviewWindow,
        bytes: Vec<u8>,
        title: String,
        setup: Option<super::PrintSetup>,
    ) -> Result<String, String> {
        // GTK opens the spool when the job is given it, so it is deleted as
        // soon as that has happened.
        let spool = super::write_spool(bytes).await?;

        let (tx, rx) = oneshot::channel::<Result<String, String>>();
        let on_main = window.clone();
        window
            .run_on_main_thread(move || open_dialog(&on_main, spool, title, setup, tx))
            .map_err(|e| e.to_string())?;
        rx.await
            .unwrap_or_else(|_| Err("the print dialog closed without an answer".into()))
    }

    /// Main thread. Shows the dialog without a nested main loop — the answer
    /// arrives through `response` — so the window keeps running behind it.
    fn open_dialog(
        window: &tauri::WebviewWindow,
        spool: tempfile::NamedTempFile,
        title: String,
        setup: Option<super::PrintSetup>,
        tx: Done,
    ) {
        let c_title = CString::new(title.replace('\0', "")).unwrap_or_default();
        // SAFETY: a new toplevel widget, owned by GTK's toplevel list until
        // destroyed; `from_glib_none` takes our own reference to it.
        let dialog: gtk::Dialog = unsafe {
            let raw = gtk_print_unix_dialog_new(c_title.as_ptr(), std::ptr::null_mut());
            gtk_print_unix_dialog_set_manual_capabilities(raw, CAPABILITY_GENERATE_PDF);
            gtk_print_unix_dialog_set_embed_page_setup(raw, 1);
            if let Some(setup) = &setup {
                preset(raw, setup);
            }
            gtk::Dialog::from_glib_none(raw as *mut gtk::ffi::GtkDialog)
        };
        if let Ok(parent) = window.gtk_window() {
            dialog.set_transient_for(Some(&parent));
        }
        dialog.set_modal(true);

        let pending = std::cell::RefCell::new(Some((spool, c_title, tx)));
        dialog.connect_response(move |dialog, response| {
            let Some((spool, c_title, tx)) = pending.borrow_mut().take() else {
                return;
            };
            if response != gtk::ResponseType::Ok {
                let _ = tx.send(Ok("cancelled".into()));
            } else {
                // SAFETY: `dialog` is the GtkPrintUnixDialog created above.
                let raw: *mut gtk::ffi::GtkDialog = dialog.to_glib_none().0;
                if let Err((tx, msg)) = unsafe { send_job(raw as Gp, &spool, &c_title, tx) } {
                    let _ = tx.send(Err(msg));
                }
            }
            // The job holds its own open handle on the spool file by now.
            drop(spool);
            // SAFETY: the dialog is finished with; this ends the toplevel.
            unsafe { dialog.destroy() };
        });
        dialog.show();
    }

    /// Opens the dialog on the paper the pages were laid out on — so CUPS does
    /// not fit them onto another — and, for a grayscale job, with colour off.
    /// Orientation is left alone: a landscape sheet is already landscape-shaped
    /// in the PDF, and CUPS turns it onto the paper itself; asking for landscape
    /// as well would turn it a second time.
    ///
    /// SAFETY: `dialog` must be a live `GtkPrintUnixDialog`.
    unsafe fn preset(dialog: Gp, setup: &super::PrintSetup) {
        let settings = gtk::PrintSettings::new();
        settings.set_use_color(!setup.grayscale);
        if let Some(name) = super::gtk_paper_name(&setup.paper) {
            let paper = gtk::PaperSize::new(Some(name));
            settings.set_paper_size(&paper);
            let page_setup = gtk::PageSetup::new();
            page_setup.set_paper_size(&paper);
            // The dialog takes its own reference to both.
            let page_setup_ptr: *mut gtk::ffi::GtkPageSetup = page_setup.to_glib_none().0;
            gtk_print_unix_dialog_set_page_setup(dialog, page_setup_ptr as Gp);
        }
        let settings_ptr: *mut gtk::ffi::GtkPrintSettings = settings.to_glib_none().0;
        gtk_print_unix_dialog_set_settings(dialog, settings_ptr as Gp);
    }

    /// Builds the job from the dialog's choices and sends it. On failure the
    /// sender comes back with the message, for the caller to deliver.
    ///
    /// SAFETY: `dialog` must be a live `GtkPrintUnixDialog`.
    unsafe fn send_job(
        dialog: Gp,
        spool: &tempfile::NamedTempFile,
        c_title: &CString,
        tx: Done,
    ) -> Result<(), (Done, String)> {
        let printer = gtk_print_unix_dialog_get_selected_printer(dialog);
        if printer.is_null() {
            return Err((tx, "no printer selected".into()));
        }
        if gtk_printer_accepts_pdf(printer) == 0 {
            return Err((tx, "this printer does not accept PDF documents".into()));
        }
        let settings = gtk_print_unix_dialog_get_settings(dialog);
        let setup = gtk_print_unix_dialog_get_page_setup(dialog);
        let job = gtk_print_job_new(c_title.as_ptr(), printer, settings, setup);
        // The job keeps its own references to both.
        glib::gobject_ffi::g_object_unref(settings as *mut _);
        if job.is_null() {
            return Err((tx, "the print job could not be created".into()));
        }
        let path = CString::new(spool.path().as_os_str().as_bytes()).unwrap_or_default();
        let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
        if gtk_print_job_set_source_file(job, path.as_ptr(), &mut err) == 0 {
            let msg = gerror_message(err);
            if !err.is_null() {
                glib::ffi::g_error_free(err);
            }
            glib::gobject_ffi::g_object_unref(job as *mut _);
            return Err((tx, msg));
        }
        // Our reference to `job` rides into the callback and is dropped there.
        let data = Box::into_raw(Box::new(tx)) as Gp;
        gtk_print_job_send(job, job_sent, data, None);
        Ok(())
    }

    unsafe extern "C" fn job_sent(job: Gp, data: Gp, error: *const glib::ffi::GError) {
        // SAFETY: `data` is the boxed sender `send_job` leaked for this call,
        // and GTK calls this exactly once.
        let tx = Box::from_raw(data as *mut Done);
        let result = if error.is_null() {
            Ok("sent".to_string())
        } else {
            Err(gerror_message(error))
        };
        let _ = tx.send(result);
        glib::gobject_ffi::g_object_unref(job as *mut _);
    }

    unsafe fn gerror_message(err: *const glib::ffi::GError) -> String {
        if err.is_null() || (*err).message.is_null() {
            return "the print job failed".into();
        }
        std::ffi::CStr::from_ptr((*err).message)
            .to_string_lossy()
            .into_owned()
    }
}
