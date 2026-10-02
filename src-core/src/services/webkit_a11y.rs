//! The WebKitGTK accessibility (AT-SPI) opt-out.
//!
//! WebKitGTK exposes the page to assistive clients over the session's
//! accessibility bus from inside the *web process*, and on 2.48 that bridge
//! aborts the whole renderer when a client asks for text at an offset the
//! document no longer has: the `org.a11y.atspi.Text` handler remaps the offset
//! through a table whose bounds check is a `CRASH()`, not a clamp. Tabtivity is
//! the worst case for it — terminals, activity lamps and file trees rewrite
//! their text continuously, so an assistive client's cached offsets are stale
//! by the time its query lands.
//!
//! Seen 2026-09-17 with GNOME's Orca running: two `WebKitWebProcess` SIGABRTs
//! (`…/atspi/Text` → `g_utf8_strlen` → bounds check → abort, read out of the
//! apport core), the window blanking and reloading both times — and the same
//! path's `g_utf8_substring: assertion 'end_pos >= start_pos'` criticals in
//! `tabtivity-dev.log` for days before that. Orca itself crash-loops against the
//! same bridge, so this is WebKit's bug, not the screen reader's.
//!
//! WebKit takes the bus address from `WEBKIT_A11Y_BUS_ADDRESS` whenever that
//! variable is set *at all* — the shipped 2.48 binary is a plain `getenv` and,
//! on a non-null pointer, a `strlen`, with the bus lookup reached only when the
//! pointer is null — so exporting it empty is how a process says "no
//! accessibility bus" without touching anyone else's session. Default-on,
//! because a renderer that dies whenever the desktop's screen reader is toggled
//! on (GNOME binds Super+Alt+S to exactly that) costs the user every open tab;
//! `TABTIVITY_ENABLE_A11Y=1` hands the bridge back to someone who needs it and can
//! live with the crash.
//!
//! The variable is process-wide, so it would otherwise reach every child Tabtivity
//! spawns and silently strip accessibility from any *other* WebKitGTK app
//! launched from a terminal tab or the app launcher. [`installed`] lets those
//! spawn sites drop a variable Tabtivity invented; one the user set themselves is
//! left alone, because then [`install`] never ran.

use std::ffi::OsStr;
use std::sync::atomic::{AtomicBool, Ordering};

/// WebKitGTK's own override for the accessibility bus address.
pub const BUS_ADDRESS_VAR: &str = "WEBKIT_A11Y_BUS_ADDRESS";
/// Tabtivity's opt-in: set it to put the bridge back.
pub const OPT_IN_VAR: &str = crate::app_env!("ENABLE_A11Y");

static INSTALLED: AtomicBool = AtomicBool::new(false);

/// Whether a value counts as "yes" for [`OPT_IN_VAR`]. An empty value, `0` and
/// `false` read as off, so `TABTIVITY_ENABLE_A11Y=0` in a shell profile means what
/// it says instead of accidentally opting in by existing.
fn opted_in(value: Option<&OsStr>) -> bool {
    match value {
        None => false,
        Some(v) => !matches!(
            v.to_string_lossy().trim().to_ascii_lowercase().as_str(),
            "" | "0" | "false" | "no" | "off"
        ),
    }
}

/// Whether to install the opt-out, given the inherited values of the two
/// variables. Pure, so the precedence is testable without touching the
/// process environment: an inherited `WEBKIT_A11Y_BUS_ADDRESS` is someone
/// else's explicit decision (a wrapper script, a sandbox, a user) and always
/// wins, and the opt-in wins over our default.
pub fn should_install(bus_address: Option<&OsStr>, opt_in: Option<&OsStr>) -> bool {
    bus_address.is_none() && !opted_in(opt_in)
}

/// Point WebKit's web process at no accessibility bus, unless the environment
/// already decided. Must run before the first webview is built — the address is
/// read once, when WebKit launches its first web process.
pub fn install() {
    let bus = std::env::var_os(BUS_ADDRESS_VAR);
    let opt_in = crate::brand::env_os("ENABLE_A11Y");
    if !should_install(bus.as_deref(), opt_in.as_deref()) {
        return;
    }
    std::env::set_var(BUS_ADDRESS_VAR, "");
    INSTALLED.store(true, Ordering::Relaxed);
}

/// True when [`install`] set [`BUS_ADDRESS_VAR`] itself, i.e. when a child
/// process inheriting it would be inheriting Tabtivity's decision rather than the
/// user's.
pub fn installed() -> bool {
    INSTALLED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn os(v: &str) -> OsString {
        OsString::from(v)
    }

    #[test]
    fn installs_when_nothing_in_the_environment_says_otherwise() {
        assert!(should_install(None, None));
    }

    #[test]
    fn an_inherited_bus_address_wins() {
        // Even an empty one: the environment already said "no bus", and an
        // address someone else chose is never ours to overwrite.
        assert!(!should_install(Some(&os("unix:path=/run/user/1000/at-spi")), None));
        assert!(!should_install(Some(&os("")), None));
    }

    #[test]
    fn the_opt_in_puts_the_bridge_back() {
        assert!(!should_install(None, Some(&os("1"))));
        assert!(!should_install(None, Some(&os("true"))));
    }

    #[test]
    fn an_off_looking_opt_in_is_not_an_opt_in() {
        for value in ["", " ", "0", "false", "no", "OFF"] {
            assert!(
                should_install(None, Some(&os(value))),
                "{value:?} should not read as an opt-in"
            );
        }
    }
}
