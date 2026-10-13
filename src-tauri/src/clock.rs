//! Wall-clock time as Unix seconds or milliseconds — the one copy.
//!
//! A clock set before 1970 reads as 0 rather than failing: every caller stamps
//! or compares, and none has a better answer for a broken clock.

use std::time::{SystemTime, UNIX_EPOCH};

/// `time` as whole seconds since the Unix epoch (0 before it).
pub fn unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Now, in whole seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    unix_secs(SystemTime::now())
}

/// Now, in milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn unix_secs_counts_from_the_epoch_and_floors_before_it() {
        assert_eq!(unix_secs(UNIX_EPOCH), 0);
        assert_eq!(unix_secs(UNIX_EPOCH + Duration::from_millis(90_999)), 90);
        assert_eq!(unix_secs(UNIX_EPOCH - Duration::from_secs(5)), 0);
    }

    #[test]
    fn now_secs_and_now_ms_agree() {
        let secs = now_secs();
        let ms = now_ms();
        // Past 2020, and the two readings within a second or two of each other.
        assert!(secs > 1_577_836_800, "{secs}");
        assert!(ms / 1000 >= secs && ms / 1000 <= secs + 2, "{ms} vs {secs}");
    }
}
