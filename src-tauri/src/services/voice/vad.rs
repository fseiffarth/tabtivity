//! Splits 16 kHz mono speech into segments: an energy detector over an
//! adaptive noise floor, with hysteresis. Pure and streaming — the session
//! feeds it whatever the capture delivers and acts on the events it returns.
//!
//! Energy rather than Silero for the live start/end decision: whisper-rs'
//! Silero takes a whole buffer, not a stream, and needs a model CI does not
//! have. Silero, when installed, only confirms a finished segment
//! (`stt::confirm_speech`).

/// The sample rate everything after the capture works in (whisper's).
pub const RATE: u32 = 16_000;
/// One analysis frame: 20 ms.
const FRAME: usize = (RATE / 50) as usize;
const FRAME_MS: u32 = 20;
/// A frame is speech this far above the noise floor…
const START_OVER_FLOOR_DB: f32 = 12.0;
/// …and an open segment stays open while frames are this far above it.
const KEEP_OVER_FLOOR_DB: f32 = 7.0;
/// Below this nothing is speech, however quiet the room (digital silence
/// would otherwise drag the floor to −∞ and make breath a "segment").
const ABS_MIN_DB: f32 = -55.0;
/// The floor is clamped to this range; a floor above it means the room is
/// louder than speech and the detector stays honest by refusing to adapt
/// past it.
const FLOOR_MIN_DB: f32 = -75.0;
const FLOOR_MAX_DB: f32 = -30.0;
/// Audio kept from before a segment opens, so its first syllable is not
/// cut (on top of the speech that opened it).
const PRE_ROLL_MS: u32 = 200;

/// How a listening session segments speech.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VadConfig {
    /// Speech needed before a segment opens. At least 250 ms, so the send
    /// guard's chime or a click never opens one.
    pub min_speech_ms: u32,
    /// Silence that ends a segment: 700 ms for dictation, the hands-free
    /// pause for hands-free.
    pub end_silence_ms: u32,
    /// Longest segment: whisper's 30 s window.
    pub max_segment_ms: u32,
}

impl VadConfig {
    pub const DICTATE_END_SILENCE_MS: u32 = 700;

    pub fn new(end_silence_ms: u32) -> Self {
        Self {
            min_speech_ms: 260,
            end_silence_ms,
            max_segment_ms: 30_000,
        }
    }
}

/// What one push of samples did to the current segment.
#[derive(Debug, PartialEq)]
pub enum VadEvent {
    /// A segment opened (its speech already counted towards `min_speech_ms`).
    Start,
    /// The open segment ended; its audio, pre-roll included.
    End(Vec<f32>),
}

pub struct Vad {
    cfg: VadConfig,
    /// Samples not yet a whole frame.
    pending: Vec<f32>,
    floor_db: f32,
    /// Frames of the run of speech that may open a segment, with their
    /// audio; and the pre-roll before it.
    candidate: Vec<f32>,
    candidate_frames: u32,
    pre_roll: Vec<f32>,
    /// The open segment's audio, and the silent frames at its end.
    open: Option<Vec<f32>>,
    silent_frames: u32,
}

/// RMS of `frame` in dBFS.
pub fn rms_db(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return f32::NEG_INFINITY;
    }
    let sum: f32 = frame.iter().map(|s| s * s).sum();
    10.0 * (sum / frame.len() as f32).max(1e-12).log10()
}

impl Vad {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            pending: Vec::with_capacity(FRAME),
            floor_db: -60.0,
            candidate: Vec::new(),
            candidate_frames: 0,
            pre_roll: Vec::new(),
            open: None,
            silent_frames: 0,
        }
    }

    /// Whether a segment is open.
    pub fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// The open segment's audio so far (for a partial transcription).
    pub fn open_audio(&self) -> Option<&[f32]> {
        self.open.as_deref()
    }

    /// Forget everything but the noise floor: after a pause, or while the
    /// voice speaks. An open segment is dropped, not ended.
    pub fn reset(&mut self) {
        self.pending.clear();
        self.candidate.clear();
        self.candidate_frames = 0;
        self.pre_roll.clear();
        self.open = None;
        self.silent_frames = 0;
    }

    /// End the open segment now, if any (the session stops).
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        self.silent_frames = 0;
        self.open.take()
    }

    pub fn push(&mut self, samples: &[f32]) -> Vec<VadEvent> {
        let mut events = Vec::new();
        let mut rest = samples;
        while !rest.is_empty() {
            let take = (FRAME - self.pending.len()).min(rest.len());
            self.pending.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
            if self.pending.len() == FRAME {
                let frame = std::mem::take(&mut self.pending);
                self.frame(&frame, &mut events);
                self.pending = frame;
                self.pending.clear();
            }
        }
        events
    }

    fn frame(&mut self, frame: &[f32], events: &mut Vec<VadEvent>) {
        let db = rms_db(frame);
        let frames = |ms: u32| ms.div_ceil(FRAME_MS);
        if let Some(open) = self.open.as_mut() {
            open.extend_from_slice(frame);
            let keep = db > (self.floor_db + KEEP_OVER_FLOOR_DB).max(ABS_MIN_DB);
            self.silent_frames = if keep { 0 } else { self.silent_frames + 1 };
            let too_long = open.len() as u64 * 1000 >= self.cfg.max_segment_ms as u64 * RATE as u64;
            if self.silent_frames >= frames(self.cfg.end_silence_ms) || too_long {
                let mut audio = self.open.take().unwrap_or_default();
                // The trailing silence is no use to whisper; keep 200 ms of it.
                let trailing = (self.silent_frames as usize).saturating_sub(frames(200) as usize) * FRAME;
                audio.truncate(audio.len().saturating_sub(trailing));
                self.silent_frames = 0;
                events.push(VadEvent::End(audio));
            }
            return;
        }
        let speech = db > (self.floor_db + START_OVER_FLOOR_DB).max(ABS_MIN_DB);
        if speech {
            self.candidate.extend_from_slice(frame);
            self.candidate_frames += 1;
            if self.candidate_frames >= frames(self.cfg.min_speech_ms) {
                let mut audio = std::mem::take(&mut self.pre_roll);
                audio.append(&mut self.candidate);
                self.candidate_frames = 0;
                self.silent_frames = 0;
                self.open = Some(audio);
                events.push(VadEvent::Start);
            }
            return;
        }
        // Not speech: a short burst that never reached the minimum was a
        // click or the chime. It joins the pre-roll, and the floor learns
        // from the quiet frame.
        if self.candidate_frames > 0 {
            let burst = std::mem::take(&mut self.candidate);
            self.candidate_frames = 0;
            self.pre_roll.extend_from_slice(&burst);
        }
        self.pre_roll.extend_from_slice(frame);
        let max = (PRE_ROLL_MS / FRAME_MS) as usize * FRAME;
        if self.pre_roll.len() > max {
            let cut = self.pre_roll.len() - max;
            self.pre_roll.drain(..cut);
        }
        // Falls quickly to a quieter room, rises slowly to a louder one.
        let rate = if db < self.floor_db { 0.2 } else { 0.01 };
        self.floor_db = (self.floor_db + (db - self.floor_db) * rate).clamp(FLOOR_MIN_DB, FLOOR_MAX_DB);
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// `ms` of a sine at `freq` with peak `amp`.
    pub(crate) fn tone(ms: u32, freq: f32, amp: f32) -> Vec<f32> {
        let n = (RATE * ms / 1000) as usize;
        (0..n)
            .map(|i| amp * (2.0 * std::f32::consts::PI * freq * i as f32 / RATE as f32).sin())
            .collect()
    }

    /// `ms` of low noise (a deterministic LCG, about −65 dBFS).
    pub(crate) fn hiss(ms: u32) -> Vec<f32> {
        let mut x: u32 = 12345;
        (0..(RATE * ms / 1000) as usize)
            .map(|_| {
                x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
                ((x >> 16) as f32 / 32768.0 - 1.0) * 0.001
            })
            .collect()
    }

    fn run(vad: &mut Vad, audio: &[f32]) -> Vec<VadEvent> {
        // Feed it in capture-sized, frame-misaligned pieces.
        audio.chunks(357).flat_map(|c| vad.push(c)).collect()
    }

    #[test]
    fn speech_between_silences_is_one_segment() {
        let mut vad = Vad::new(VadConfig::new(700));
        let mut audio = hiss(1000);
        audio.extend(tone(1500, 220.0, 0.2));
        audio.extend(hiss(1000));
        let events = run(&mut vad, &audio);
        assert_eq!(events.len(), 2, "{events:?}");
        assert_eq!(events[0], VadEvent::Start);
        let VadEvent::End(segment) = &events[1] else { panic!("{events:?}") };
        // The tone, its pre-roll and at most 200 ms of the end silence.
        let ms = segment.len() as u32 * 1000 / RATE;
        assert!((1500..=1950).contains(&ms), "{ms} ms");
        assert!(!vad.is_open());
    }

    #[test]
    fn a_short_burst_opens_no_segment() {
        let mut vad = Vad::new(VadConfig::new(700));
        let mut audio = hiss(800);
        // A 150 ms chime, well under the 250 ms minimum.
        audio.extend(tone(150, 880.0, 0.3));
        audio.extend(hiss(1500));
        assert!(run(&mut vad, &audio).is_empty());
    }

    #[test]
    fn a_short_pause_inside_speech_does_not_end_it() {
        let mut vad = Vad::new(VadConfig::new(700));
        let mut audio = hiss(500);
        audio.extend(tone(800, 220.0, 0.2));
        audio.extend(hiss(400));
        audio.extend(tone(800, 300.0, 0.2));
        audio.extend(hiss(1200));
        let events = run(&mut vad, &audio);
        assert_eq!(events.iter().filter(|e| **e == VadEvent::Start).count(), 1, "{events:?}");
        assert_eq!(events.iter().filter(|e| matches!(e, VadEvent::End(_))).count(), 1);
    }

    #[test]
    fn the_hands_free_pause_waits_longer() {
        let mut vad = Vad::new(VadConfig::new(1500));
        let mut audio = hiss(500);
        audio.extend(tone(800, 220.0, 0.2));
        audio.extend(hiss(1000));
        let events = run(&mut vad, &audio);
        assert_eq!(events, vec![VadEvent::Start]);
        assert!(vad.is_open());
        assert!(matches!(run(&mut vad, &hiss(600))[..], [VadEvent::End(_)]));
    }

    #[test]
    fn a_segment_ends_at_whispers_window() {
        let mut vad = Vad::new(VadConfig::new(700));
        let events = run(&mut vad, &tone(31_000, 220.0, 0.2));
        let VadEvent::End(segment) = &events[1] else { panic!("{events:?}") };
        assert!(segment.len() as u32 <= 30 * RATE + FRAME as u32);
    }

    #[test]
    fn digital_silence_never_opens_a_segment() {
        let mut vad = Vad::new(VadConfig::new(700));
        let mut audio = vec![0.0; RATE as usize * 2];
        // −60 dBFS: above a floor dragged down by zeros, below the absolute minimum.
        audio.extend(tone(1000, 220.0, 0.0014));
        assert!(run(&mut vad, &audio).is_empty());
    }

    #[test]
    fn reset_drops_an_open_segment() {
        let mut vad = Vad::new(VadConfig::new(700));
        let mut audio = hiss(500);
        audio.extend(tone(600, 220.0, 0.2));
        assert_eq!(run(&mut vad, &audio), vec![VadEvent::Start]);
        vad.reset();
        assert!(!vad.is_open());
        assert!(run(&mut vad, &hiss(1500)).is_empty());
    }
}
