//! Backend counterpart of shared/usageReport.ts: only positive usage-panel matches.
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use regex::Regex;
use std::sync::LazyLock;

static RESET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bresets\b:?\s*((?:[^·•|,;]|,\s*\d)+)").unwrap());
static ZONE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\(\s*([A-Za-z_]+(?:/[\w+-]+)+|UTC|GMT)\s*\)\s*$").unwrap());
static DATE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}))?\b").unwrap());
static MONTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b").unwrap());
static CLOCK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)(?:^|[\s,])(\d{1,2})(?::(\d{2})\s*(am|pm)?|\s*(am|pm))(?:$|[\s,.])").unwrap());
static DAY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b").unwrap());

fn resolve<T: TimeZone>(text: &str, now: DateTime<T>) -> Option<DateTime<Utc>> {
    let date = DATE.captures(text);
    if date.is_none() && MONTH.is_match(text) { return None; }
    let clock_text = DATE.replace(text, " ");
    let clock = CLOCK.captures(&clock_text)?;
    let mut hour: u32 = clock[1].parse().ok()?;
    let minute: u32 = clock.get(2).map_or(Some(0), |m| m.as_str().parse().ok())?;
    if let Some(meridiem) = clock.get(3).or_else(|| clock.get(4)) {
        if !(1..=12).contains(&hour) { return None; }
        hour %= 12;
        if meridiem.as_str().eq_ignore_ascii_case("pm") { hour += 12; }
    }
    let at = |date: NaiveDate| now.timezone().from_local_datetime(&date.and_hms_opt(hour, minute, 0)?).earliest().map(|d| d.with_timezone(&Utc));
    if let Some(date) = date {
        let month = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].iter().position(|m| date[1].eq_ignore_ascii_case(m))? as u32 + 1;
        let day: u32 = date[2].parse().ok()?;
        if let Some(year) = date.get(3) {
            return at(NaiveDate::from_ymd_opt(year.as_str().parse().ok()?, month, day)?);
        }
        // No year written: a panel read late in December names January's
        // reset without one. This year's date, or next year's when that is
        // already past — never a reset in the past.
        let this_year = at(NaiveDate::from_ymd_opt(now.year(), month, day)?);
        return match this_year {
            Some(candidate) if candidate > now => Some(candidate),
            _ => at(NaiveDate::from_ymd_opt(now.year() + 1, month, day)?),
        };
    }
    let day = DAY.find(text).map(|d| d.as_str().to_ascii_lowercase());
    let today = now.date_naive();
    match day.as_deref() {
        Some("today") => at(today),
        Some("tomorrow") => at(today + Duration::days(1)),
        Some(day) => {
            let weekday = ["mon","tue","wed","thu","fri","sat","sun"].iter().position(|d| day.starts_with(d))? as i64;
            let offset = (weekday - i64::from(today.weekday().num_days_from_monday())).rem_euclid(7);
            let candidate = at(today + Duration::days(offset))?;
            if candidate > now { Some(candidate) } else { at(today + Duration::days(offset + 7)) }
        }
        None => {
            let candidate = at(today)?;
            if candidate > now { Some(candidate) } else { at(today + Duration::days(1)) }
        }
    }
}

pub fn next_reset(raw: &str, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    raw.lines().filter(|line| line.contains('%') && line.contains(':')).filter_map(|line| {
        let reset = RESET.captures(line)?;
        let phrase = reset[1].trim();
        let at = if let Some(zone) = ZONE.captures(phrase) {
            let tz: chrono_tz::Tz = zone[1].parse().ok()?;
            resolve(&phrase[..zone.get(0)?.start()], now.with_timezone(&tz))?
        } else {
            resolve(phrase, now.with_timezone(&Local))?
        };
        (at > now).then_some(at)
    }).min()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dated_panel_uses_its_zone_and_soonest_future_reset() {
        let now = "2026-09-15T12:00:00Z".parse().unwrap();
        let raw = "Current session: 39% used · resets Sep 15, 10:30pm (Europe/Berlin)\nCurrent week (all models): 54% used · resets Sep 17, 2pm (Europe/Berlin)";
        assert_eq!(next_reset(raw, now).unwrap().to_rfc3339(), "2026-09-15T20:30:00+00:00");
        assert!(next_reset("nothing about resets 4pm", now).is_none());
        // A dated phrase without a year that has passed this year is next year's.
        assert_eq!(next_reset("Session: 3% · resets Sep 12, 10pm (UTC)", now).unwrap().to_rfc3339(), "2027-09-12T22:00:00+00:00");
        assert!(next_reset("Session: 3% · resets Sep 12, 2026, 10pm (UTC)", now).is_none(), "a written year is not second-guessed");
        assert_eq!(next_reset("Session: 3% · resets Sep 15, 1pm (UTC)", now).unwrap().to_rfc3339(), "2026-09-15T13:00:00+00:00");
        assert!(next_reset("Session: 3% · resets Sep 15, 25:00 (UTC)", now).is_none());
    }
}
