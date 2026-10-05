//! macOS project-window backend — NSRunningApplication hide/unhide "parking".
//!
//! macOS offers no public per-window control over other applications (that
//! would need the private CGS/SkyLight API — rejected as build-fragile), so
//! Tabtivity parks at APP granularity: hiding a tracked window `hide`s its owning
//! application, showing it `unhide`s + best-effort activates it. Window
//! enumeration/geometry ride `CGWindowListCopyWindowInfo`, which needs NO
//! Screen Recording permission for the keys used here (window id, owner pid,
//! owner name, layer, bounds), and `NSRunningApplication hide/unhide` needs NO
//! Accessibility permission.
//!
//! Every X11/Windows safety invariant holds: Tabtivity's own windows are never
//! hidden (owning-process identity — hiding our own app would hide the MAIN
//! window, since hide is app-wide — plus the structural main-window guard),
//! protected shell surfaces (Dock/Finder/…) are never hidden, and cleanup
//! unhides everything Tabtivity hid. Because a hidden app's windows leave the
//! on-screen CGWindowList, the owner pid is recorded at hide time
//! (`MacParkState::mark_parked`) and show/cleanup key on that pid.
//!
//! The pure decision logic lives FFI-free in `super::macos_park` so it is unit
//! tested on any OS; this file is the thin FFI shell (raw `extern "C"` — the
//! same pattern as `sysstat.rs`'s libproc backend; no new crates).

use std::ffi::c_void;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use super::macos_park::{is_protected_owner_name, MacParkState, WinRect};
use super::{WorkspaceBackend, WorkspaceInfo};

// ── Raw CoreFoundation / CoreGraphics / objc FFI ────────────────────────────

type CFTypeRef = *const c_void;
type CFArrayRef = *const c_void;
type CFDictionaryRef = *const c_void;
type CFStringRef = *const c_void;
type CFIndex = isize;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// `kCGWindowListOptionOnScreenOnly`: only windows currently on screen, in
/// front-to-back order — exactly what the occlusion walk needs.
const ON_SCREEN_ONLY: u32 = 1 << 0;
/// `kCGNullWindowID`.
const NULL_WINDOW_ID: u32 = 0;
/// `kCFStringEncodingUTF8`.
const UTF8: u32 = 0x0800_0100;
/// `kCFNumberSInt64Type`.
const SINT64: CFIndex = 4;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    fn CGRectMakeWithDictionaryRepresentation(dict: CFDictionaryRef, rect: *mut CGRect) -> bool;
    fn CGEventCreate(source: *const c_void) -> CFTypeRef;
    fn CGEventGetLocation(event: CFTypeRef) -> CGPoint;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFArrayGetCount(array: CFArrayRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFArrayRef, index: CFIndex) -> *const c_void;
    fn CFDictionaryGetValue(dict: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFStringCreateWithCString(
        alloc: *const c_void,
        c_str: *const std::ffi::c_char,
        encoding: u32,
    ) -> CFStringRef;
    fn CFStringGetCString(
        string: CFStringRef,
        buffer: *mut std::ffi::c_char,
        buffer_size: CFIndex,
        encoding: u32,
    ) -> bool;
    fn CFNumberGetValue(number: *const c_void, number_type: CFIndex, out: *mut c_void) -> bool;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const std::ffi::c_char) -> *mut c_void;
    fn sel_registerName(name: *const std::ffi::c_char) -> *mut c_void;
    fn objc_msgSend();
}

/// `objc_msgSend` cast to `(receiver, selector) -> id/isize`. macOS ships a
/// single untyped `objc_msgSend`; casting it per call signature is the
/// standard raw-FFI pattern (what the `objc` crate does under the hood).
fn msg_send0(receiver: *mut c_void, selector: *mut c_void) -> *mut c_void {
    // SAFETY: transmuting objc_msgSend to the concrete calling signature is
    // the documented way to invoke it; receiver/selector are checked non-null
    // by callers where required (messaging nil is well-defined and returns 0).
    unsafe {
        let f: extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector)
    }
}

/// `objc_msgSend` cast to `(receiver, selector, i32) -> id`.
fn msg_send_i32(receiver: *mut c_void, selector: *mut c_void, arg: i32) -> *mut c_void {
    // SAFETY: see `msg_send0`.
    unsafe {
        let f: extern "C" fn(*mut c_void, *mut c_void, i32) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector, arg)
    }
}

/// `objc_msgSend` cast to `(receiver, selector, usize) -> id` (NSUInteger arg).
fn msg_send_usize(receiver: *mut c_void, selector: *mut c_void, arg: usize) -> *mut c_void {
    // SAFETY: see `msg_send0`.
    unsafe {
        let f: extern "C" fn(*mut c_void, *mut c_void, usize) -> *mut c_void =
            std::mem::transmute(objc_msgSend as *const ());
        f(receiver, selector, arg)
    }
}

fn sel(name: &std::ffi::CStr) -> *mut c_void {
    // SAFETY: sel_registerName copies the NUL-terminated name; always valid.
    unsafe { sel_registerName(name.as_ptr()) }
}

/// The `NSRunningApplication` instance for `pid`, or null if the process is
/// not a running application (a daemon, or already gone).
fn running_application(pid: u32) -> *mut c_void {
    // SAFETY: objc_getClass on a static NUL-terminated name; messaging the
    // class object with a pid is the documented constructor. AppKit is loaded
    // (Tauri's window layer is AppKit), so the class resolves.
    let cls = unsafe { objc_getClass(c"NSRunningApplication".as_ptr()) };
    if cls.is_null() {
        return std::ptr::null_mut();
    }
    msg_send_i32(
        cls,
        sel(c"runningApplicationWithProcessIdentifier:"),
        pid as i32,
    )
}

// ── CGWindowList enumeration ────────────────────────────────────────────────

/// One on-screen window as reported by `CGWindowListCopyWindowInfo`, in
/// front-to-back order.
struct WindowInfo {
    id: u64,
    pid: u32,
    layer: i32,
    owner_name: String,
    bounds: CGRect,
}

/// Read an i64 out of a CFNumber dictionary value; 0 when absent/mistyped.
fn dict_i64(dict: CFDictionaryRef, key: CFStringRef) -> i64 {
    // SAFETY: CFDictionaryGetValue returns a borrowed reference (may be null);
    // CFNumberGetValue only writes `out` when it returns true.
    unsafe {
        let value = CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return 0;
        }
        let mut out: i64 = 0;
        if CFNumberGetValue(value, SINT64, &mut out as *mut i64 as *mut c_void) {
            out
        } else {
            0
        }
    }
}

/// Read a String out of a CFString dictionary value; empty when absent.
fn dict_string(dict: CFDictionaryRef, key: CFStringRef) -> String {
    // SAFETY: the value is borrowed; CFStringGetCString NUL-terminates into
    // the provided buffer and returns false on truncation/absence.
    unsafe {
        let value = CFDictionaryGetValue(dict, key);
        if value.is_null() {
            return String::new();
        }
        let mut buf = [0i8; 256];
        if CFStringGetCString(value, buf.as_mut_ptr(), buf.len() as CFIndex, UTF8) {
            std::ffi::CStr::from_ptr(buf.as_ptr())
                .to_string_lossy()
                .into_owned()
        } else {
            String::new()
        }
    }
}

/// Snapshot every on-screen window (front-to-back). Needs no Screen Recording
/// permission for these keys (id/pid/owner-name/layer/bounds); without that
/// permission only `kCGWindowName` would be withheld, which is not read.
fn window_list() -> Vec<WindowInfo> {
    let mut out = Vec::new();
    // SAFETY: every Create/Copy ref made here (the key strings, the array) is
    // CFReleased before returning; dictionary values are borrowed and read
    // only while the array is alive.
    unsafe {
        let key_number =
            CFStringCreateWithCString(std::ptr::null(), c"kCGWindowNumber".as_ptr(), UTF8);
        let key_pid =
            CFStringCreateWithCString(std::ptr::null(), c"kCGWindowOwnerPID".as_ptr(), UTF8);
        let key_owner =
            CFStringCreateWithCString(std::ptr::null(), c"kCGWindowOwnerName".as_ptr(), UTF8);
        let key_layer =
            CFStringCreateWithCString(std::ptr::null(), c"kCGWindowLayer".as_ptr(), UTF8);
        let key_bounds =
            CFStringCreateWithCString(std::ptr::null(), c"kCGWindowBounds".as_ptr(), UTF8);

        let array = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY, NULL_WINDOW_ID);
        if !array.is_null() {
            for i in 0..CFArrayGetCount(array) {
                let dict = CFArrayGetValueAtIndex(array, i);
                if dict.is_null() {
                    continue;
                }
                let id = dict_i64(dict, key_number);
                if id <= 0 {
                    continue;
                }
                let mut bounds = CGRect::default();
                let bounds_dict = CFDictionaryGetValue(dict, key_bounds);
                if !bounds_dict.is_null() {
                    // Writes `bounds` only on success; the default (zero rect)
                    // is harmless for the occlusion walk otherwise.
                    let _ = CGRectMakeWithDictionaryRepresentation(bounds_dict, &mut bounds);
                }
                out.push(WindowInfo {
                    id: id as u64,
                    pid: dict_i64(dict, key_pid).max(0) as u32,
                    layer: dict_i64(dict, key_layer) as i32,
                    owner_name: dict_string(dict, key_owner),
                    bounds,
                });
            }
            CFRelease(array);
        }
        for key in [key_number, key_pid, key_owner, key_layer, key_bounds] {
            if !key.is_null() {
                CFRelease(key);
            }
        }
    }
    out
}

/// The current pointer location in the CG global coordinate space — the SAME
/// top-left-origin space `kCGWindowBounds` uses, so the two compare directly.
fn pointer_location() -> Option<(f64, f64)> {
    // SAFETY: CGEventCreate(null) returns a new event snapshotting the current
    // pointer state; it is CFReleased after the location is read.
    unsafe {
        let event = CGEventCreate(std::ptr::null());
        if event.is_null() {
            return None;
        }
        let point = CGEventGetLocation(event);
        CFRelease(event);
        Some((point.x, point.y))
    }
}

// ── Backend ─────────────────────────────────────────────────────────────────

pub struct MacBackend {
    /// Pure parking state: parkable override, main-window guard, parked map.
    state: Mutex<MacParkState>,
    /// Tabtivity's own pid — the structural backbone of "never hide Tabtivity":
    /// hide is app-granular, so hiding our own app would hide the MAIN window.
    self_pid: u32,
    /// Idempotency latch for `cleanup` (mirrors x11.rs/windows.rs).
    cleaned_up: Mutex<bool>,
}

impl MacBackend {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(MacParkState::default()),
            self_pid: std::process::id(),
            cleaned_up: Mutex::new(false),
        }
    }

    /// Resolve the owning pid + owner name for a window id from the on-screen
    /// list. `None` when the window is gone (or its app already hidden).
    fn owner_of(&self, window_id: u64) -> Option<(u32, String)> {
        window_list()
            .into_iter()
            .find(|w| w.id == window_id)
            .map(|w| (w.pid, w.owner_name))
    }

    /// `unhide` + best-effort activate the app owning `pid`.
    fn unhide_pid(&self, pid: u32) {
        let app = running_application(pid);
        if app.is_null() {
            return; // app quit while parked — nothing to restore
        }
        let _ = msg_send0(app, sel(c"unhide"));
        // NSApplicationActivateIgnoringOtherApps (1 << 1): best-effort raise;
        // failure just leaves the app unhidden behind the current window.
        let _ = msg_send_usize(app, sel(c"activateWithOptions:"), 1 << 1);
    }
}

impl Default for MacBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl WorkspaceBackend for MacBackend {
    fn name(&self) -> &'static str {
        "macos"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "mac".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn show_window(&self, window_id: u64) -> Result<(), String> {
        // A parked window's app has left the on-screen list, so the pid comes
        // from the parked map; fall back to a live scan for a window that was
        // never actually hidden.
        let pid = self
            .state
            .lock()
            .unwrap()
            .parked_pid(window_id)
            .or_else(|| self.owner_of(window_id).map(|(pid, _)| pid));
        if let Some(pid) = pid {
            if pid != self.self_pid {
                self.unhide_pid(pid);
            }
        }
        self.state.lock().unwrap().unmark_parked(window_id);
        Ok(())
    }

    fn hide_window(&self, window_id: u64) -> Result<(), String> {
        let Some((pid, owner_name)) = self.owner_of(window_id) else {
            return Ok(()); // window already gone/hidden — nothing to do
        };
        // NEVER hide Tabtivity itself — hide is app-granular, so this would take
        // down the MAIN window. Unlike X11/Windows, the parkable override can
        // NOT bypass this: popout self-parking is deferred on macOS for
        // exactly this reason (see the intentional-gaps register).
        if pid == self.self_pid {
            return Ok(());
        }
        if !self.state.lock().unwrap().is_parkable(window_id)
            && is_protected_owner_name(&owner_name)
        {
            return Ok(());
        }
        let app = running_application(pid);
        if app.is_null() {
            return Ok(()); // not an application (daemon) or already gone
        }
        let _ = msg_send0(app, sel(c"hide"));
        self.state.lock().unwrap().mark_parked(window_id, pid);
        Ok(())
    }

    fn make_sticky(&self, _app_pid: u32) -> Result<(), String> {
        // No public Spaces API to pin an app to every Space. Leave Tabtivity on
        // the user-selected Space.
        Ok(())
    }

    fn set_parkable(&self, window_id: u64) {
        self.state.lock().unwrap().add_parkable(window_id);
    }

    fn unset_parkable(&self, window_id: u64) {
        self.state.lock().unwrap().remove_parkable(window_id);
    }

    fn set_main_window_id(&self, window_id: u64) {
        self.state.lock().unwrap().set_main(window_id);
    }

    fn cleanup(&self) -> Result<(), String> {
        let mut cleaned_up = self.cleaned_up.lock().unwrap();
        if *cleaned_up {
            return Ok(());
        }
        *cleaned_up = true;
        drop(cleaned_up);

        // Unhide exactly the apps Tabtivity hid (dedup by pid — several tracked
        // windows can share one app, and unhide is app-granular anyway).
        let parked = self.state.lock().unwrap().drain_parked();
        let mut seen = std::collections::HashSet::new();
        for (_window_id, pid) in parked {
            if pid != self.self_pid && seen.insert(pid) {
                self.unhide_pid(pid);
            }
        }
        Ok(())
    }
}

impl Drop for MacBackend {
    fn drop(&mut self) {
        // Mirrors x11.rs/windows.rs: normal teardown always unhides project
        // apps even if the explicit cleanup command is missed.
        let _ = self.cleanup();
    }
}

// ── Free helpers (command-layer window resolution) ──────────────────────────

/// All on-screen layer-0 window ids, front-to-back. Non-zero layers (menu bar,
/// Dock, overlays) are not app windows and never enter tracked sets.
pub fn list_window_ids() -> Vec<u64> {
    window_list()
        .into_iter()
        .filter(|w| w.layer == 0)
        .map(|w| w.id)
        .collect()
}

/// Resolve a window owned by `pid` OR any of its descendants — a launcher stub
/// commonly spawns the real GUI process as a child, so the visible window's
/// owning pid is a descendant of (not equal to) the spawned pid. Mirrors
/// `windows::find_window_for_pid`; `attempts == 1` does a single no-sleep scan
/// (the hide-time resolver must not block the switch worker).
pub fn find_window_for_pid(pid: u32, attempts: usize) -> Option<u64> {
    for attempt in 0..attempts {
        let pids = crate::sysstat::descendant_pids(&[pid]);
        if let Some(win) = window_list()
            .into_iter()
            .find(|w| w.layer == 0 && pids.contains(&w.pid))
        {
            return Some(win.id);
        }
        if attempt + 1 < attempts {
            thread::sleep(Duration::from_millis(100));
        }
    }
    None
}

/// First window id not present in `before`, polling up to `attempts` times.
/// Mirrors x11's `!w.protected` filter: never latch onto Tabtivity's own or a
/// protected shell window that happens to appear during the poll.
pub fn find_new_window(before: &[u64], attempts: usize) -> Option<u64> {
    let self_pid = std::process::id();
    for attempt in 0..attempts {
        if let Some(win) = window_list()
            .into_iter()
            .filter(|w| {
                w.layer == 0 && w.pid != self_pid && !is_protected_owner_name(&w.owner_name)
            })
            .find(|w| !before.contains(&w.id))
        {
            return Some(win.id);
        }
        if attempt + 1 < attempts {
            thread::sleep(Duration::from_millis(100));
        }
    }
    None
}

/// The layer-0 window currently under the pointer, for the popout occlusion
/// check (#42). Pointer location and window bounds share the CG global
/// top-left coordinate space; the front-to-back walk itself is the pure,
/// unit-tested `macos_park::frontmost_at_point`.
pub fn frontmost_window_under_pointer() -> Option<u64> {
    let (x, y) = pointer_location()?;
    let rects: Vec<WinRect> = window_list()
        .into_iter()
        .map(|w| WinRect {
            id: w.id,
            layer: w.layer,
            x: w.bounds.origin.x,
            y: w.bounds.origin.y,
            w: w.bounds.size.width,
            h: w.bounds.size.height,
        })
        .collect();
    super::macos_park::frontmost_at_point(&rects, x, y)
}

/// The `CGWindowID` of an `NSWindow*`, via its `windowNumber` property (the
/// two are the same numbering). Used at startup to bind the MAIN window id for
/// the structural parkable guard. Must be called on the main thread (AppKit
/// rule for NSWindow access), which Tauri's `setup` is.
pub fn ns_window_id(ns_window: *mut c_void) -> Option<u64> {
    if ns_window.is_null() {
        return None;
    }
    // SAFETY: messaging a live NSWindow with the argless `windowNumber`
    // selector returns its NSInteger window number.
    let number = unsafe {
        let f: extern "C" fn(*mut c_void, *mut c_void) -> isize =
            std::mem::transmute(objc_msgSend as *const ());
        f(ns_window, sel(c"windowNumber"))
    };
    (number > 0).then_some(number as u64)
}
