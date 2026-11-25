//! Which of the user's languages a dictation is in (docs/voice_language_detection_plan.md).
//!
//! Whisper's own detection picks among ~99 languages, so on a short phrase
//! German drifts to Dutch. A session instead gets a few candidates, picks the
//! best of those for each final, and locks on one once a final is long and
//! sure enough. Pure policy, no whisper: compiled in every build so CI tests
//! it without a model. `stt.rs` maps the indices used here to whisper's ids.

/// A final needs this much audio to lock the session's language. The voice
/// detector already cut the trailing silence to 200 ms, so the audio's length
/// is the speech's. A starting value: docs/voice_language_detection_plan.md,
/// step 4, tunes it.
pub const LOCK_MIN_SPEECH_MS: usize = 1500;
/// …and the renormalised probability of its pick at least this.
pub const LOCK_MIN_P: f32 = 0.6;

/// The best candidate and its probability renormalised over the candidates.
/// `probs` is whisper's vector indexed by language id, `candidates` the ids.
/// Mass on a non-candidate is ignored, a tie keeps the first candidate, an id
/// outside the vector counts as 0 and all-zero answers the first with 0.
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub fn pick(probs: &[f32], candidates: &[i32]) -> (usize, f32) {
    let p = |id: i32| usize::try_from(id).ok().and_then(|i| probs.get(i)).copied().filter(|p| p.is_finite() && *p > 0.0).unwrap_or(0.0);
    let (mut best, mut best_p, mut sum) = (0, 0.0_f32, 0.0_f32);
    for (index, &id) in candidates.iter().enumerate() {
        let p = p(id);
        sum += p;
        if p > best_p {
            (best, best_p) = (index, p);
        }
    }
    if sum > 0.0 {
        (best, best_p / sum)
    } else {
        (0, 0.0)
    }
}

/// The lock policy over `n` candidates, by index. Lives in the worker: it
/// runs finals and partials in order, so it needs no message back from the
/// session thread.
#[derive(Debug)]
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub struct LangPicker {
    n: usize,
    /// What a partial, a seam prefix and a failed detection use before any
    /// pick: the request's fallback when it is a candidate, else the first.
    start: usize,
    last: Option<usize>,
    locked: Option<usize>,
    /// Whether the lock was reported (by a final's `locked`).
    announced: bool,
}

#[cfg_attr(not(feature = "voice"), allow(dead_code))]
impl LangPicker {
    /// One candidate is locked from the start: nothing to choose between.
    pub fn new(n: usize, start: usize) -> Self {
        let start = if start < n { start } else { 0 };
        Self { n, start, last: None, locked: (n == 1).then_some(0), announced: false }
    }

    /// Whether the next final should be detected: before the lock, among more
    /// than one candidate. Seam prefixes and partials never detect.
    pub fn needs_detect(&self) -> bool {
        self.locked.is_none() && self.n > 1
    }

    /// The candidate a run that does not detect uses: the lock, else the last
    /// kept pick, else the start.
    pub fn current(&self) -> usize {
        self.locked.or(self.last).unwrap_or(self.start)
    }

    /// A final was transcribed in candidate `used`, with `p` the renormalised
    /// probability of its pick (0 when nothing was detected), `speech_ms` of
    /// audio, and `kept` whether the phantom filter let its text through. A
    /// filtered final never locks and its pick is not remembered. Answers
    /// whether this final is the one that locked: true once per session.
    pub fn finished(&mut self, used: usize, p: f32, speech_ms: usize, kept: bool) -> bool {
        if !kept || used >= self.n {
            return false;
        }
        if self.locked.is_none() {
            self.last = Some(used);
            if speech_ms >= LOCK_MIN_SPEECH_MS && p >= LOCK_MIN_P {
                self.locked = Some(used);
            }
        }
        self.locked.is_some() && !std::mem::replace(&mut self.announced, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mass_on_a_non_candidate_is_ignored() {
        // Ids 0..4: German (2) is the best overall but not a candidate.
        let probs = [0.1, 0.1, 0.6, 0.15, 0.05];
        let (index, p) = pick(&probs, &[0, 3]);
        assert_eq!(index, 1);
        assert!((p - 0.15 / 0.25).abs() < 1e-6, "{p}");
    }

    #[test]
    fn a_tie_keeps_the_first_candidate() {
        assert_eq!(pick(&[0.3, 0.3, 0.4], &[1, 0]), (0, 0.5));
    }

    #[test]
    fn all_zero_gives_the_first_candidate_with_no_confidence() {
        assert_eq!(pick(&[0.0, 0.0, 1.0], &[0, 1]), (0, 0.0));
        assert_eq!(pick(&[], &[0]), (0, 0.0));
        assert_eq!(pick(&[0.5], &[]), (0, 0.0));
    }

    #[test]
    fn an_id_past_the_vector_counts_as_zero() {
        assert_eq!(pick(&[0.2, 0.4], &[7, 1]), (1, 1.0));
        assert_eq!(pick(&[0.2, 0.4], &[-1, 0]), (1, 1.0));
        assert_eq!(pick(&[0.2], &[7, 9]), (0, 0.0));
    }

    #[test]
    fn a_nan_is_no_probability() {
        assert_eq!(pick(&[f32::NAN, 0.2], &[0, 1]), (1, 1.0));
    }

    const LONG: usize = LOCK_MIN_SPEECH_MS;

    #[test]
    fn a_short_first_final_does_not_lock() {
        let mut picker = LangPicker::new(2, 0);
        assert!(picker.needs_detect());
        assert!(!picker.finished(1, 0.99, LONG - 1, true));
        assert!(picker.needs_detect(), "still detecting");
        assert_eq!(picker.current(), 1, "but partials follow the last pick");
    }

    #[test]
    fn an_unsure_final_does_not_lock() {
        let mut picker = LangPicker::new(2, 0);
        assert!(!picker.finished(1, LOCK_MIN_P - 0.01, LONG, true));
        assert!(picker.needs_detect());
    }

    #[test]
    fn a_long_confident_kept_final_locks_once_and_later_finals_do_not_detect() {
        let mut picker = LangPicker::new(3, 0);
        assert!(picker.finished(2, LOCK_MIN_P, LONG, true), "this final locked");
        assert!(!picker.needs_detect());
        assert_eq!(picker.current(), 2);
        assert!(!picker.finished(2, 1.0, LONG * 2, true), "reported once");
        assert!(!picker.finished(0, 1.0, LONG * 2, true), "a lock is a lock");
        assert_eq!(picker.current(), 2);
    }

    #[test]
    fn a_filtered_final_neither_locks_nor_is_remembered() {
        let mut picker = LangPicker::new(2, 0);
        assert!(!picker.finished(1, 0.99, LONG * 2, false));
        assert!(picker.needs_detect());
        assert_eq!(picker.current(), 0, "the start language: the pick was not kept");
        assert!(picker.finished(1, 0.99, LONG, true));
    }

    #[test]
    fn before_any_pick_the_start_language_runs_and_a_bad_start_means_the_first() {
        assert_eq!(LangPicker::new(3, 2).current(), 2);
        assert_eq!(LangPicker::new(3, 9).current(), 0);
    }

    #[test]
    fn one_candidate_is_locked_from_the_start_and_announced_with_its_first_kept_final() {
        let mut picker = LangPicker::new(1, 0);
        assert!(!picker.needs_detect());
        assert_eq!(picker.current(), 0);
        assert!(!picker.finished(0, 0.0, 100, false), "a filtered final announces nothing");
        assert!(picker.finished(0, 0.0, 100, true), "however short and unsure");
        assert!(!picker.finished(0, 0.0, 100, true));
    }

    #[test]
    fn a_failed_detection_is_a_final_with_no_confidence() {
        let mut picker = LangPicker::new(2, 1);
        assert_eq!(picker.current(), 1);
        assert!(!picker.finished(picker.current(), 0.0, LONG * 2, true));
        assert!(picker.needs_detect());
    }
}
