//! No-op workspace backend — used on non-Linux, unsupported compositors,
//! or when X11/DBus connections fail. Never errors; always reports a safe state.

use super::{WorkspaceBackend, WorkspaceInfo};

pub struct NullBackend;

impl WorkspaceBackend for NullBackend {
    fn name(&self) -> &'static str {
        "null"
    }

    fn info(&self) -> WorkspaceInfo {
        WorkspaceInfo {
            label: "–".to_string(),
            current_desktop: None,
            desktop_count: None,
        }
    }

    fn show_window(&self, _window_id: u64) -> Result<(), String> {
        Ok(())
    }

    fn hide_window(&self, _window_id: u64) -> Result<(), String> {
        Ok(())
    }

    fn can_park(&self) -> bool {
        false
    }

    fn make_sticky(&self, _app_pid: u32) -> Result<(), String> {
        Ok(())
    }

    fn cleanup(&self) -> Result<(), String> {
        Ok(())
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_backend_name() {
        assert_eq!(NullBackend.name(), "null");
    }

    #[test]
    fn null_backend_info_has_no_desktop_info() {
        let info = NullBackend.info();
        assert!(info.current_desktop.is_none());
        assert!(info.desktop_count.is_none());
    }

    #[test]
    fn null_backend_show_window_never_errors() {
        assert!(NullBackend.show_window(0).is_ok());
        assert!(NullBackend.show_window(u64::MAX).is_ok());
    }

    #[test]
    fn null_backend_hide_window_never_errors() {
        assert!(NullBackend.hide_window(0).is_ok());
        assert!(NullBackend.hide_window(u64::MAX).is_ok());
    }

    #[test]
    fn null_backend_switch_never_errors() {
        assert!(NullBackend.switch_to_project(None, None, &[], &[]).is_ok());
        assert!(NullBackend
            .switch_to_project(Some("p1"), Some("p0"), &[1, 2], &[3])
            .is_ok());
    }

    #[test]
    fn null_backend_make_sticky_never_errors() {
        assert!(NullBackend.make_sticky(1234).is_ok());
    }

    #[test]
    fn null_backend_cleanup_never_errors() {
        assert!(NullBackend.cleanup().is_ok());
    }

    #[test]
    fn null_backend_cleanup_is_idempotent() {
        assert!(NullBackend.cleanup().is_ok());
        assert!(NullBackend.cleanup().is_ok());
    }
}
