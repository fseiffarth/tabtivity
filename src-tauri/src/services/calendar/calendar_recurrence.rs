//! Recurrence expansion — the backend twin of `src/lib/calendar/recurrence.ts`.
//!
//! The desktop expands a stored event into the occurrences a view draws in the
//! frontend, and `schema::calendar` deliberately stays dumb about calendar
//! semantics. The Mobile sidecar has to answer the phone's month with no
//! window open (headless owner plan, H0), so the same rules live here too:
//! window-bounded generation from the master's own start, `exdates` dropping
//! occurrences and `overrides` editing them, both keyed by the rule-generated
//! start. Every branch mirrors the TypeScript one by name so the two can be
//! diffed; the tests port the frontend's cases.
//!
//! Stamps are the store's local wall-clock strings (`"YYYY-MM-DD"` or
//! `"YYYY-MM-DDTHH:MM"`); arithmetic is civil, never through a time zone.

use std::collections::{HashMap, HashSet};

use crate::schema::calendar::{
    add_days as add_date_days, add_minutes, days_between, days_from_civil, days_in_month,
    parse_date, Alarm, CalendarEvent, Freq, Rrule,
};

/// Hard ceiling on occurrences generated for one event in one window, so a
/// corrupt rule (a `count` of a billion) can never hang the answer.
const MAX_OCCURRENCES: usize = 2000;

/// One expanded occurrence — the fields the phone's month renders.
#[derive(Debug, Clone, PartialEq)]
pub struct Occurrence {
    pub event_id: String,
    pub calendar_id: String,
    /// The rule-generated start (what `exdates`/`overrides` key on).
    pub occurrence_start: String,
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub title: String,
    pub location: String,
    pub notes: String,
    pub conference: String,
    pub category: String,
    pub status: String,
    pub recurring: bool,
    /// The event's reminders, carried as the frontend's `Occurrence.alarms`
    /// is (an override never changes them).
    pub alarms: Vec<Alarm>,
}

// ── Stamps ──────────────────────────────────────────────────────────────────

/// A parsed stamp (`calendarTime.ts`'s `Civil`).
#[derive(Debug, Clone, Copy)]
struct Civil {
    year: i32,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    date_only: bool,
}

/// `parseStamp`: the date, and the `THH:MM` half when present. Anything after
/// the minute is ignored, as the frontend's anchored regex ignores it.
fn parse_stamp(stamp: &str) -> Option<Civil> {
    let (year, month, day) = parse_date(stamp)?;
    let time = stamp.get(10..);
    match time {
        Some(rest) if rest.starts_with('T') => {
            let hour: u32 = rest.get(1..3)?.parse().ok()?;
            let minute: u32 = rest.get(4..6)?.parse().ok()?;
            if rest.as_bytes().get(3) != Some(&b':') || hour > 23 || minute > 59 {
                return None;
            }
            Some(Civil { year, month, day, hour, minute, date_only: false })
        }
        _ => Some(Civil { year, month, day, hour: 0, minute: 0, date_only: true }),
    }
}

/// The date half of a stamp.
pub fn date_part(stamp: &str) -> &str {
    stamp.split('T').next().unwrap_or(stamp)
}

fn civil_date(year: i32, month: u32, day: u32) -> String {
    format!("{year:04}-{month:02}-{day:02}")
}

fn with_time(date: String, civil: &Civil) -> String {
    if civil.date_only {
        date
    } else {
        format!("{date}T{:02}:{:02}", civil.hour, civil.minute)
    }
}

/// `addDays`: preserves whichever form came in.
pub fn add_days(stamp: &str, n: i64) -> String {
    let Some(civil) = parse_stamp(stamp) else {
        return stamp.to_string();
    };
    with_time(add_date_days(date_part(stamp), n), &civil)
}

/// `addMonths`: clamps the day to the target month's length.
fn add_months(stamp: &str, n: i64) -> String {
    let Some(civil) = parse_stamp(stamp) else {
        return stamp.to_string();
    };
    let total = i64::from(civil.year) * 12 + i64::from(civil.month) - 1 + n;
    let year = total.div_euclid(12) as i32;
    let month = (total.rem_euclid(12) + 1) as u32;
    let day = civil.day.min(days_in_month(year, month));
    with_time(civil_date(year, month, day), &civil)
}

fn add_years(stamp: &str, n: i64) -> String {
    add_months(stamp, n * 12)
}

/// Minutes from local midnight; a date-only stamp is 0.
fn minutes_into_day(stamp: &str) -> i64 {
    parse_stamp(stamp)
        .map(|c| i64::from(c.hour) * 60 + i64::from(c.minute))
        .unwrap_or(0)
}

/// `minutesBetween`, tolerant of date-only stamps on either side.
fn minutes_between(a: &str, b: &str) -> i64 {
    days_between(a, b).unwrap_or(0) * 24 * 60 + (minutes_into_day(b) - minutes_into_day(a))
}

/// Weekday of a stamp, `0` = Sunday.
pub fn weekday_of(stamp: &str) -> u32 {
    let Some((y, m, d)) = parse_date(stamp) else {
        return 0;
    };
    // 1970-01-01 was a Thursday.
    (days_from_civil(y, m, d) + 4).rem_euclid(7) as u32
}

/// `startOfWeek`: `week_start` is 0 (Sunday) or 1 (Monday).
pub fn start_of_week(stamp: &str, week_start: u32) -> String {
    let dow = weekday_of(stamp);
    let back = (dow + 7 - week_start) % 7;
    add_date_days(date_part(stamp), -i64::from(back))
}

/// The `[start, end)` date window of a month grid of `weeks` whole weeks
/// starting with the week of the 1st — what `monthGrid` spans.
pub fn month_window(year: i32, month: u32, week_start: u32, weeks: i64) -> (String, String) {
    let first = civil_date(year, month, 1);
    let start = start_of_week(&first, week_start);
    let end = add_date_days(&start, weeks * 7);
    (start, end)
}

/// A start/end/all-day triple, normalized so a zero-length span still renders.
#[derive(Debug, Clone)]
struct Span {
    start: String,
    end: String,
    all_day: bool,
}

/// `normalizeSpan`: a timed span gets at least `min_minutes`, an all-day one
/// its single day back.
fn normalize_span(span: &Span, min_minutes: i64) -> Span {
    if parse_stamp(&span.start).is_none() {
        return span.clone();
    }
    if span.all_day {
        let start = date_part(&span.start).to_string();
        let end = if parse_stamp(&span.end).is_some() {
            date_part(&span.end).to_string()
        } else {
            String::new()
        };
        let one_day = add_date_days(&start, 1);
        return Span {
            end: if !end.is_empty() && end > start { end } else { one_day },
            start,
            all_day: true,
        };
    }
    let end = if parse_stamp(&span.end).is_some() { span.end.clone() } else { String::new() };
    let ok = !end.is_empty() && minutes_between(&span.start, &end) >= min_minutes;
    Span {
        start: span.start.clone(),
        end: if ok { end } else { add_minutes(&span.start, min_minutes) },
        all_day: false,
    }
}

/// `spanCoversDate`: whether the span covers any part of `date` (exclusive
/// end; a timed span ending exactly at midnight does not claim the next day).
fn span_covers_date(span: &Span, date: &str) -> bool {
    let s = normalize_span(span, 15);
    let d = date_part(date);
    let start_date = date_part(&s.start);
    let end_date = if s.all_day || minutes_into_day(&s.end) == 0 {
        date_part(&s.end).to_string()
    } else {
        add_date_days(date_part(&s.end), 1)
    };
    d >= start_date && d < end_date.as_str()
}

// ── Generation ──────────────────────────────────────────────────────────────

/// The day of month of the `n`th `weekday` (`0` = Sunday) in `month`, counted
/// from the end when `n` is negative. `None` when the month has no such day.
pub fn nth_weekday_of_month(year: i32, month: u32, n: i8, weekday: u32) -> Option<u32> {
    if n == 0 {
        return None;
    }
    let dim = days_in_month(year, month);
    if n > 0 {
        let first_dow = weekday_of(&civil_date(year, month, 1));
        let day = 1 + (weekday + 7 - first_dow) % 7 + 7 * (u32::from(n as u8) - 1);
        return (day <= dim).then_some(day);
    }
    let last_dow = weekday_of(&civil_date(year, month, dim));
    let back = (last_dow + 7 - weekday) % 7 + 7 * (u32::from((-n) as u8) - 1);
    (back < dim).then(|| dim - back)
}

fn interval_of(rule: &Rrule) -> i64 {
    i64::from(rule.interval.max(1))
}

/// `stepPeriod`: advance a start to the next period under `rule`.
fn step_period(stamp: &str, rule: &Rrule) -> String {
    let interval = interval_of(rule);
    match rule.freq {
        Freq::Daily => add_days(stamp, interval),
        Freq::Weekly => add_days(stamp, 7 * interval),
        Freq::Monthly => add_months(stamp, interval),
        Freq::Yearly => add_years(stamp, interval),
    }
}

/// Where a generation stops: the rule's end, the window's end, or the cap.
struct Stop<'a> {
    until: Option<&'a str>,
    window_end: &'a str,
    count: Option<usize>,
}

impl Stop<'_> {
    fn at(&self, candidate: &str, generated: usize) -> bool {
        if self.until.is_some_and(|until| date_part(candidate) > until) {
            return true;
        }
        if date_part(candidate) > self.window_end {
            return true;
        }
        if self.count.is_some_and(|count| generated >= count) {
            return true;
        }
        generated >= MAX_OCCURRENCES
    }

    /// The between-period checks every branch repeats on a month/week probe.
    fn past(&self, probe: &str, generated: usize) -> bool {
        probe > self.window_end
            || self.until.is_some_and(|until| probe > until)
            || self.count.is_some_and(|count| generated >= count)
            || generated >= MAX_OCCURRENCES
    }
}

/// `generateStarts`: the rule-generated starts of `event`, from its own start
/// until the rule ends or the generated start passes `window_end`. Runs
/// forward from the master because `count` and `bymonthday` clamping depend
/// on the ordinal position.
fn generate_starts(event: &CalendarEvent, window_end: &str) -> Vec<String> {
    let first = event.start.as_str();
    let Some(first_civil) = parse_stamp(first) else {
        return Vec::new();
    };
    let Some(rule) = event.rrule.as_ref() else {
        return vec![first.to_string()];
    };
    let interval = interval_of(rule);
    let stop = Stop {
        until: rule.until.as_deref().map(date_part),
        window_end: date_part(window_end),
        count: rule.count.filter(|c| *c > 0).map(|c| c as usize),
    };
    let time = if event.all_day { "" } else { first.split('T').nth(1).unwrap_or("") };
    let stamp = |date: String| if time.is_empty() { date } else { format!("{date}T{time}") };
    let first_date = date_part(first);
    let mut starts: Vec<String> = Vec::new();

    // Weekly + byweekday: each period is a week, firing on each selected
    // weekday. Anchored to the (Sunday-based) week the master starts in.
    if rule.freq == Freq::Weekly && !rule.byweekday.is_empty() {
        let mut days: Vec<u32> = rule
            .byweekday
            .iter()
            .filter(|d| **d <= 6)
            .map(|d| u32::from(*d))
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        days.sort_unstable();
        if days.is_empty() {
            return vec![first.to_string()];
        }
        let first_dow = weekday_of(first);
        let mut week_start = add_date_days(first_date, -i64::from(first_dow));
        loop {
            for d in &days {
                let date = add_date_days(&week_start, i64::from(*d));
                if date.as_str() < first_date {
                    continue;
                }
                let candidate = stamp(date);
                if stop.at(&candidate, starts.len()) {
                    return starts;
                }
                starts.push(candidate);
            }
            week_start = add_date_days(&week_start, 7 * interval);
            if stop.past(&week_start, starts.len()) {
                return starts;
            }
        }
    }

    // Monthly + bymonthday: pin the day, skipping months too short for it.
    if rule.freq == Freq::Monthly && rule.bymonthday.is_some() && rule.bynthweekday.is_empty() {
        let day = u32::from(rule.bymonthday.unwrap_or(1));
        let mut year = first_civil.year;
        let mut month = first_civil.month;
        loop {
            if day <= days_in_month(year, month) {
                let date = civil_date(year, month, day);
                if date.as_str() >= first_date {
                    let candidate = stamp(date);
                    if stop.at(&candidate, starts.len()) {
                        return starts;
                    }
                    starts.push(candidate);
                }
            }
            let total = i64::from(year) * 12 + i64::from(month) - 1 + interval;
            year = total.div_euclid(12) as i32;
            month = (total.rem_euclid(12) + 1) as u32;
            if stop.past(&civil_date(year, month, 1), starts.len()) {
                return starts;
            }
        }
    }

    // Numbered weekdays ("the 2nd Tuesday", "the last Friday"): each period is
    // a month, or the master's month in every Nth year.
    let nth: Vec<(i8, u32)> = rule
        .bynthweekday
        .iter()
        .filter(|e| e.n != 0 && e.n.abs() <= 5 && e.day <= 6)
        .map(|e| (e.n, u32::from(e.day)))
        .collect();
    if matches!(rule.freq, Freq::Monthly | Freq::Yearly) && !nth.is_empty() {
        let step = if rule.freq == Freq::Monthly { interval } else { 12 * interval };
        let mut year = first_civil.year;
        let mut month = first_civil.month;
        loop {
            let mut days: Vec<u32> = nth
                .iter()
                .filter_map(|(n, day)| nth_weekday_of_month(year, month, *n, *day))
                .collect::<HashSet<_>>()
                .into_iter()
                .collect();
            days.sort_unstable();
            for day in days {
                let date = civil_date(year, month, day);
                if date.as_str() < first_date {
                    continue;
                }
                let candidate = stamp(date);
                if stop.at(&candidate, starts.len()) {
                    return starts;
                }
                starts.push(candidate);
            }
            let total = i64::from(year) * 12 + i64::from(month) - 1 + step;
            year = total.div_euclid(12) as i32;
            month = (total.rem_euclid(12) + 1) as u32;
            if stop.past(&civil_date(year, month, 1), starts.len()) {
                return starts;
            }
        }
    }

    // Plain daily / weekly / monthly / yearly: step the period from the master.
    let mut cur = first.to_string();
    loop {
        if stop.at(&cur, starts.len()) {
            return starts;
        }
        starts.push(cur.clone());
        cur = step_period(&cur, rule);
    }
}

// ── Expansion ───────────────────────────────────────────────────────────────

/// `expandEvent`: the occurrences of `event` overlapping `[window_start,
/// window_end)`, compared by date, with `exdates` dropped and `overrides`
/// applied.
pub fn expand_event(event: &CalendarEvent, window_start: &str, window_end: &str) -> Vec<Occurrence> {
    if parse_stamp(&event.start).is_none() {
        return Vec::new();
    }
    let exdates: HashSet<&str> = event.exdates.iter().map(String::as_str).collect();
    let overrides: HashMap<&str, _> = event
        .overrides
        .iter()
        .map(|o| (o.occurrence_start.as_str(), o))
        .collect();

    // An override can pull a slot the rule generates after the window back
    // into it, so generation reaches every such slot too.
    let mut generate_to = window_end.to_string();
    for o in &event.overrides {
        let Some(start) = o.start.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if date_part(start) >= date_part(window_end) {
            continue;
        }
        if date_part(&o.occurrence_start) > date_part(&generate_to) {
            generate_to = o.occurrence_start.clone();
        }
    }
    let starts = generate_starts(event, &generate_to);

    // Duration comes from the master and is carried to every occurrence.
    let master = normalize_span(
        &Span { start: event.start.clone(), end: event.end.clone(), all_day: event.all_day },
        15,
    );
    let duration_min = if event.all_day { 0 } else { minutes_between(&master.start, &master.end) };
    let duration_days = if event.all_day {
        days_between(date_part(&master.start), date_part(&master.end))
            .unwrap_or(1)
            .max(1)
    } else {
        0
    };

    let window_dates = {
        let mut dates = Vec::new();
        let mut d = date_part(window_start).to_string();
        let end = date_part(window_end);
        while d.as_str() < end {
            let next = add_date_days(&d, 1);
            dates.push(d);
            d = next;
        }
        dates
    };

    let mut out = Vec::new();
    for occurrence_start in starts {
        if exdates.contains(occurrence_start.as_str()) {
            continue;
        }
        let mut start = occurrence_start.clone();
        let mut end = if event.all_day {
            add_date_days(date_part(&occurrence_start), duration_days)
        } else {
            add_minutes(&occurrence_start, duration_min)
        };
        let mut title = event.title.clone();
        let mut location = event.location.clone();
        let mut notes = event.notes.clone();
        if let Some(ov) = overrides.get(occurrence_start.as_str()) {
            if let Some(moved) = ov.start.as_deref().filter(|s| !s.is_empty()) {
                start = moved.to_string();
                // An override that moves the start but not the end keeps the
                // duration.
                end = if event.all_day {
                    add_date_days(date_part(&start), duration_days)
                } else {
                    add_minutes(&start, duration_min)
                };
            }
            if let Some(ends) = ov.end.as_deref().filter(|s| !s.is_empty()) {
                end = ends.to_string();
            }
            if let Some(t) = &ov.title {
                title = t.clone();
            }
            if let Some(l) = &ov.location {
                location = l.clone();
            }
            if let Some(n) = &ov.notes {
                notes = n.clone();
            }
        }
        let span = Span { start: start.clone(), end: end.clone(), all_day: event.all_day };
        if !window_dates.iter().any(|d| span_covers_date(&span, d)) {
            continue;
        }
        out.push(Occurrence {
            event_id: event.id.clone(),
            calendar_id: event.calendar_id.clone(),
            occurrence_start,
            start,
            end,
            all_day: event.all_day,
            title,
            location,
            notes,
            conference: event.conference.clone(),
            category: event.category.clone(),
            status: event.status.clone(),
            recurring: event.rrule.is_some(),
            alarms: event.alarms.clone(),
        });
    }
    out
}

/// `expandEvents`: every event's occurrences in the window, all-day first,
/// then chronological, then by title. `visible_calendars` drops the rest.
pub fn expand_events(
    events: &[CalendarEvent],
    window_start: &str,
    window_end: &str,
    visible_calendars: Option<&HashSet<String>>,
) -> Vec<Occurrence> {
    let mut out: Vec<Occurrence> = events
        .iter()
        .filter(|e| visible_calendars.is_none_or(|v| v.contains(&e.calendar_id)))
        .flat_map(|e| expand_event(e, window_start, window_end))
        .collect();
    out.sort_by(|a, b| {
        b.all_day
            .cmp(&a.all_day)
            .then_with(|| a.start.cmp(&b.start))
            .then_with(|| a.title.cmp(&b.title))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::calendar::{EventOverride, NthWeekday};

    fn event() -> CalendarEvent {
        CalendarEvent {
            id: "e1".into(),
            calendar_id: "default".into(),
            start: "2026-07-08T09:00".into(),
            end: "2026-07-08T10:00".into(),
            title: "standup".into(),
            ..Default::default()
        }
    }

    fn rule() -> Rrule {
        Rrule { freq: Freq::Daily, interval: 1, ..Default::default() }
    }

    fn starts(e: &CalendarEvent, a: &str, b: &str) -> Vec<String> {
        expand_event(e, a, b).into_iter().map(|o| o.occurrence_start).collect()
    }

    #[test]
    fn stamps_parse_and_step() {
        assert!(parse_stamp("2026-07-08").unwrap().date_only);
        assert_eq!(parse_stamp("2026-07-08T09:30").unwrap().minute, 30);
        assert!(parse_stamp("2026-08-28T10:00:00Z").is_some(), "trailing seconds are ignored");
        assert!(parse_stamp("nope").is_none());
        assert_eq!(add_days("2026-07-31T09:00", 1), "2026-08-01T09:00");
        assert_eq!(add_months("2026-01-31", 1), "2026-02-28");
        assert_eq!(add_years("2028-02-29T08:00", 1), "2029-02-28T08:00");
        assert_eq!(weekday_of("2026-07-08"), 3, "a Wednesday");
        assert_eq!(start_of_week("2026-07-08", 1), "2026-07-06");
        assert_eq!(start_of_week("2026-07-08", 0), "2026-07-05");
        assert_eq!(month_window(2026, 7, 1, 6), ("2026-06-29".into(), "2026-08-10".into()));
    }

    #[test]
    fn nth_weekdays() {
        assert_eq!(nth_weekday_of_month(2026, 7, 2, 2), Some(14), "2nd Tuesday of July 2026");
        assert_eq!(nth_weekday_of_month(2026, 7, -1, 5), Some(31), "last Friday");
        assert_eq!(nth_weekday_of_month(2026, 7, 5, 4), Some(30), "5th Thursday exists");
        assert_eq!(nth_weekday_of_month(2026, 7, 5, 1), None, "no 5th Monday");
        assert_eq!(nth_weekday_of_month(2026, 7, 0, 1), None);
    }

    #[test]
    fn non_recurring_events() {
        let out = expand_event(&event(), "2026-07-01", "2026-08-01");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].start, "2026-07-08T09:00");
        assert_eq!(out[0].end, "2026-07-08T10:00");
        assert!(!out[0].recurring);
        assert!(expand_event(&event(), "2026-09-01", "2026-10-01").is_empty());
        // A conference running Jun 29 – Jul 3 still shows in July.
        let conf = CalendarEvent { start: "2026-06-29".into(), end: "2026-07-04".into(), all_day: true, ..event() };
        assert_eq!(expand_event(&conf, "2026-07-01", "2026-08-01").len(), 1);
        let garbage = CalendarEvent { start: "nope".into(), ..event() };
        assert!(expand_event(&garbage, "2026-07-01", "2026-08-01").is_empty());
    }

    #[test]
    fn daily_recurrence() {
        let e = CalendarEvent { rrule: Some(rule()), ..event() };
        assert_eq!(
            starts(&e, "2026-07-08", "2026-07-12"),
            ["2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00", "2026-07-11T09:00"]
        );
        let every3 = CalendarEvent { rrule: Some(Rrule { interval: 3, ..rule() }), ..event() };
        assert_eq!(
            starts(&every3, "2026-07-08", "2026-07-18"),
            ["2026-07-08T09:00", "2026-07-11T09:00", "2026-07-14T09:00", "2026-07-17T09:00"]
        );
        let zero = CalendarEvent { rrule: Some(Rrule { interval: 0, ..rule() }), ..event() };
        assert_eq!(starts(&zero, "2026-07-08", "2026-07-11").len(), 3);
        let half_hour = CalendarEvent { end: "2026-07-08T09:30".into(), rrule: Some(rule()), ..event() };
        let out = expand_event(&half_hour, "2026-07-08", "2026-07-10");
        assert_eq!((out[1].start.as_str(), out[1].end.as_str()), ("2026-07-09T09:00", "2026-07-09T09:30"));
        assert_eq!(starts(&e, "2026-07-01", "2026-07-10")[0], "2026-07-08T09:00", "never before the master");
        let dst = CalendarEvent { start: "2026-03-27T09:00".into(), end: "2026-03-27T10:00".into(), rrule: Some(rule()), ..event() };
        assert_eq!(
            starts(&dst, "2026-03-27", "2026-03-31"),
            ["2026-03-27T09:00", "2026-03-28T09:00", "2026-03-29T09:00", "2026-03-30T09:00"]
        );
    }

    #[test]
    fn weekly_recurrence() {
        let plain = CalendarEvent { rrule: Some(Rrule { freq: Freq::Weekly, ..rule() }), ..event() };
        assert_eq!(starts(&plain, "2026-07-08", "2026-07-23"), ["2026-07-08T09:00", "2026-07-15T09:00", "2026-07-22T09:00"]);
        // Mon + Wed, master on a Wednesday: the master's own weekday counts.
        let mw = CalendarEvent { rrule: Some(Rrule { freq: Freq::Weekly, byweekday: vec![1, 3], ..rule() }), ..event() };
        assert_eq!(
            starts(&mw, "2026-07-08", "2026-07-16"),
            ["2026-07-08T09:00", "2026-07-13T09:00", "2026-07-15T09:00"]
        );
        let biweekly = CalendarEvent { rrule: Some(Rrule { freq: Freq::Weekly, byweekday: vec![3], interval: 2, ..rule() }), ..event() };
        assert_eq!(starts(&biweekly, "2026-07-08", "2026-08-01"), ["2026-07-08T09:00", "2026-07-22T09:00"]);
    }

    #[test]
    fn monthly_recurrence() {
        let plain = CalendarEvent { rrule: Some(Rrule { freq: Freq::Monthly, ..rule() }), ..event() };
        assert_eq!(
            starts(&plain, "2026-07-08", "2026-11-01"),
            ["2026-07-08T09:00", "2026-08-08T09:00", "2026-09-08T09:00", "2026-10-08T09:00"]
        );
        let jan31 = CalendarEvent { start: "2026-01-31T09:00".into(), end: "2026-01-31T10:00".into(), rrule: Some(Rrule { freq: Freq::Monthly, ..rule() }), ..event() };
        let got = starts(&jan31, "2026-01-01", "2026-04-01");
        assert!(got.contains(&"2026-02-28T09:00".to_string()), "stepping clamps: {got:?}");
        let pinned = CalendarEvent { rrule: Some(Rrule { freq: Freq::Monthly, bymonthday: Some(31), ..rule() }), ..jan31.clone() };
        assert_eq!(starts(&pinned, "2026-01-01", "2026-05-01"), ["2026-01-31T09:00", "2026-03-31T09:00"], "no February, no April");
        let fifteenth = CalendarEvent { start: "2026-01-15T09:00".into(), end: "2026-01-15T10:00".into(), rrule: Some(Rrule { freq: Freq::Monthly, bymonthday: Some(15), interval: 2, ..rule() }), ..event() };
        assert_eq!(starts(&fifteenth, "2026-01-01", "2026-06-01"), ["2026-01-15T09:00", "2026-03-15T09:00", "2026-05-15T09:00"]);
        // The 2nd Tuesday of each month, from a master on July's (the 14th).
        let second_tuesday = CalendarEvent {
            start: "2026-07-14T09:00".into(),
            end: "2026-07-14T10:00".into(),
            rrule: Some(Rrule { freq: Freq::Monthly, bynthweekday: vec![NthWeekday { n: 2, day: 2 }], ..rule() }),
            ..event()
        };
        assert_eq!(starts(&second_tuesday, "2026-07-01", "2026-10-01"), ["2026-07-14T09:00", "2026-08-11T09:00", "2026-09-08T09:00"]);
    }

    #[test]
    fn yearly_recurrence_and_ends() {
        let yearly = CalendarEvent { rrule: Some(Rrule { freq: Freq::Yearly, ..rule() }), ..event() };
        assert_eq!(starts(&yearly, "2026-07-01", "2028-08-01"), ["2026-07-08T09:00", "2027-07-08T09:00", "2028-07-08T09:00"]);
        let leap = CalendarEvent { start: "2028-02-29T09:00".into(), end: "2028-02-29T10:00".into(), rrule: Some(Rrule { freq: Freq::Yearly, ..rule() }), ..event() };
        assert_eq!(starts(&leap, "2029-02-01", "2029-03-05"), ["2029-02-28T09:00"]);
        let counted = CalendarEvent { rrule: Some(Rrule { count: Some(3), ..rule() }), ..event() };
        assert_eq!(starts(&counted, "2026-07-08", "2026-08-01"), ["2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00"]);
        assert_eq!(starts(&counted, "2026-07-10", "2026-08-01"), ["2026-07-10T09:00"], "count is from the series start");
        let until = CalendarEvent { rrule: Some(Rrule { until: Some("2026-07-10".into()), ..rule() }), ..event() };
        assert_eq!(starts(&until, "2026-07-08", "2026-08-01"), ["2026-07-08T09:00", "2026-07-09T09:00", "2026-07-10T09:00"]);
        let endless = CalendarEvent { rrule: Some(rule()), ..event() };
        assert_eq!(expand_event(&endless, "2026-07-08", "2026-07-15").len(), 7);
    }

    #[test]
    fn exdates_and_overrides() {
        let e = CalendarEvent { rrule: Some(rule()), exdates: vec!["2026-07-09T09:00".into()], ..event() };
        assert_eq!(starts(&e, "2026-07-08", "2026-07-12"), ["2026-07-08T09:00", "2026-07-10T09:00", "2026-07-11T09:00"]);
        let renamed = CalendarEvent {
            rrule: Some(rule()),
            overrides: vec![EventOverride { occurrence_start: "2026-07-09T09:00".into(), title: Some("retro".into()), ..Default::default() }],
            ..event()
        };
        let out = expand_event(&renamed, "2026-07-08", "2026-07-11");
        assert_eq!(out.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(), ["standup", "retro", "standup"]);
        let moved = CalendarEvent {
            rrule: Some(rule()),
            overrides: vec![EventOverride { occurrence_start: "2026-07-09T09:00".into(), start: Some("2026-07-09T14:00".into()), ..Default::default() }],
            ..event()
        };
        let out = expand_event(&moved, "2026-07-09", "2026-07-10");
        assert_eq!((out[0].start.as_str(), out[0].end.as_str()), ("2026-07-09T14:00", "2026-07-09T15:00"));
        assert_eq!(out[0].occurrence_start, "2026-07-09T09:00", "keyed on the original start");
        // Next week's slot pulled back into this window.
        let pulled = CalendarEvent {
            rrule: Some(Rrule { freq: Freq::Weekly, ..rule() }),
            overrides: vec![EventOverride { occurrence_start: "2026-07-15T09:00".into(), start: Some("2026-07-10T09:00".into()), ..Default::default() }],
            ..event()
        };
        let out = expand_event(&pulled, "2026-07-09", "2026-07-12");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].occurrence_start, "2026-07-15T09:00");
    }

    #[test]
    fn all_day_spans() {
        let e = CalendarEvent { start: "2026-07-08".into(), end: "2026-07-09".into(), all_day: true, rrule: Some(rule()), ..event() };
        let out = expand_event(&e, "2026-07-08", "2026-07-11");
        assert_eq!((out[0].start.as_str(), out[0].end.as_str()), ("2026-07-08", "2026-07-09"));
        assert_eq!((out[1].start.as_str(), out[1].end.as_str()), ("2026-07-09", "2026-07-10"));
        let block = CalendarEvent { start: "2026-07-08".into(), end: "2026-07-11".into(), all_day: true, rrule: Some(Rrule { freq: Freq::Weekly, ..rule() }), ..event() };
        let out = expand_event(&block, "2026-07-08", "2026-07-20");
        assert_eq!((out[0].start.as_str(), out[0].end.as_str()), ("2026-07-08", "2026-07-11"));
        assert_eq!((out[1].start.as_str(), out[1].end.as_str()), ("2026-07-15", "2026-07-18"));
    }

    #[test]
    fn expand_events_sorts_and_filters() {
        let events = vec![
            CalendarEvent { id: "b".into(), start: "2026-07-08T14:00".into(), end: "2026-07-08T15:00".into(), title: "late".into(), ..event() },
            CalendarEvent { id: "a".into(), title: "early".into(), ..event() },
            CalendarEvent { id: "c".into(), start: "2026-07-08".into(), end: "2026-07-09".into(), all_day: true, title: "allday".into(), ..event() },
            CalendarEvent { id: "d".into(), calendar_id: "work".into(), title: "hidden".into(), ..event() },
        ];
        let out = expand_events(&events, "2026-07-08", "2026-07-09", None);
        assert_eq!(out.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(), ["allday", "early", "hidden", "late"]);
        let visible: HashSet<String> = ["default".to_string()].into_iter().collect();
        let out = expand_events(&events, "2026-07-08", "2026-07-09", Some(&visible));
        assert_eq!(out.iter().map(|o| o.title.as_str()).collect::<Vec<_>>(), ["allday", "early", "late"]);
    }
}
