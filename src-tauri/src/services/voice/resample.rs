//! The capture's device rate (44.1 or 48 kHz, any channel count) to whisper's
//! 16 kHz mono: a downmix, a windowed-sinc low-pass below the new Nyquist,
//! then linear interpolation at the fractional step. Pure and streaming, so a
//! callback-sized buffer at a time gives the same output as the whole signal.
//! Speech needs nothing finer; a resampler crate would be a dependency for it.

use super::vad::RATE;

/// Low-pass cutoff: under 8 kHz (16 kHz's Nyquist) with room for the filter's
/// transition band.
const CUTOFF_HZ: f32 = 7_000.0;
const TAPS: usize = 63;

pub struct Resampler {
    channels: usize,
    /// Input samples per output sample.
    step: f64,
    taps: Vec<f32>,
    /// The last `TAPS - 1` mono input samples, for the filter's history.
    history: Vec<f32>,
    /// Filtered samples not yet consumed, and the read position in them.
    filtered: Vec<f32>,
    pos: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, channels: u16) -> Self {
        let in_rate = in_rate.max(1);
        let taps = if in_rate > RATE { low_pass(CUTOFF_HZ / in_rate as f32) } else { vec![1.0] };
        Self {
            channels: channels.max(1) as usize,
            step: in_rate as f64 / RATE as f64,
            history: vec![0.0; taps.len() - 1],
            taps,
            filtered: Vec::new(),
            pos: 0.0,
        }
    }

    /// Interleaved device samples in, 16 kHz mono out.
    pub fn push(&mut self, interleaved: &[f32]) -> Vec<f32> {
        let n = self.taps.len();
        for frame in interleaved.chunks(self.channels) {
            let mono = frame.iter().sum::<f32>() / frame.len() as f32;
            self.history.push(mono);
            let window = &self.history[self.history.len() - n..];
            let y = window.iter().zip(self.taps.iter().rev()).map(|(x, h)| x * h).sum();
            self.filtered.push(y);
            if self.history.len() > 4 * n {
                let cut = self.history.len() - (n - 1);
                self.history.drain(..cut);
            }
        }
        let mut out = Vec::with_capacity((self.filtered.len() as f64 / self.step) as usize + 1);
        while self.pos + 1.0 < self.filtered.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.filtered[i] * (1.0 - frac) + self.filtered[i + 1] * frac);
            self.pos += self.step;
        }
        let used = self.pos as usize;
        self.filtered.drain(..used.min(self.filtered.len()));
        self.pos -= used as f64;
        out
    }
}

/// A Blackman-windowed sinc low-pass at `cutoff` (a fraction of the input
/// rate), normalised to unity gain at DC.
fn low_pass(cutoff: f32) -> Vec<f32> {
    let mid = (TAPS - 1) as f32 / 2.0;
    let pi = std::f32::consts::PI;
    let mut taps: Vec<f32> = (0..TAPS)
        .map(|i| {
            let x = i as f32 - mid;
            let sinc = if x == 0.0 { 2.0 * cutoff } else { (2.0 * pi * cutoff * x).sin() / (pi * x) };
            let t = i as f32 / (TAPS - 1) as f32;
            let window = 0.42 - 0.5 * (2.0 * pi * t).cos() + 0.08 * (4.0 * pi * t).cos();
            sinc * window
        })
        .collect();
    let sum: f32 = taps.iter().sum();
    taps.iter_mut().for_each(|t| *t /= sum);
    taps
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(rate: u32, ms: u32, freq: f32, channels: usize) -> Vec<f32> {
        let n = (rate * ms / 1000) as usize;
        (0..n)
            .flat_map(|i| {
                let s = 0.5 * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin();
                std::iter::repeat_n(s, channels)
            })
            .collect()
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len() as f32).sqrt()
    }

    /// Sign changes per second: twice the frequency of a clean sine.
    fn crossings_per_s(x: &[f32]) -> f32 {
        let changes = x.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count();
        changes as f32 * RATE as f32 / x.len() as f32
    }

    fn resample(rate: u32, channels: u16, input: &[f32]) -> Vec<f32> {
        let mut r = Resampler::new(rate, channels);
        // Callback-sized pieces, as cpal delivers them.
        input.chunks(441 * channels as usize).flat_map(|c| r.push(c)).collect()
    }

    #[test]
    fn keeps_speech_band_tones_at_48k_stereo() {
        let out = resample(48_000, 2, &sine(48_000, 1000, 1000.0, 2));
        assert!((15_900..=16_000).contains(&out.len()), "{}", out.len());
        let steady = &out[200..];
        assert!((rms(steady) - 0.5 / 2f32.sqrt()).abs() < 0.02, "{}", rms(steady));
        assert!((crossings_per_s(steady) - 2000.0).abs() < 20.0, "{}", crossings_per_s(steady));
    }

    #[test]
    fn keeps_speech_band_tones_at_44k1_mono() {
        let out = resample(44_100, 1, &sine(44_100, 1000, 440.0, 1));
        assert!((15_900..=16_000).contains(&out.len()), "{}", out.len());
        assert!((crossings_per_s(&out[200..]) - 880.0).abs() < 15.0);
    }

    #[test]
    fn removes_what_16k_cannot_hold() {
        // 12 kHz would alias to 4 kHz without the low-pass.
        let out = resample(48_000, 1, &sine(48_000, 500, 12_000.0, 1));
        assert!(rms(&out[200..]) < 0.01, "{}", rms(&out[200..]));
    }

    #[test]
    fn passes_16k_through() {
        let input = sine(16_000, 100, 300.0, 1);
        let out = resample(16_000, 1, &input);
        assert!(out.len() >= input.len() - 1);
        assert!(out.iter().zip(&input).all(|(a, b)| (a - b).abs() < 1e-6));
    }
}
