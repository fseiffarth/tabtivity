//! Whether this CPU can run the whisper.cpp we ship (user decision
//! 2026-10-23: AVX2/FMA required). `GGML_NATIVE=OFF` builds x86_64 ggml with
//! `-mavx -mavx2 -mfma -mf16c -mbmi2`, so on a CPU without one of them the
//! first whisper call dies with an illegal instruction. Checked before any
//! whisper-rs call; read-aloud does not need it.

/// The x86_64 features `GGML_NATIVE=OFF` compiles in.
pub const REQUIRED: [&str; 5] = ["avx", "avx2", "fma", "f16c", "bmi2"];

/// The required features this CPU lacks, given a probe for each. Pure, so the
/// decision is tested without the CPU at hand.
pub fn missing(has: impl Fn(&str) -> bool) -> Vec<&'static str> {
    REQUIRED.iter().copied().filter(|f| !has(f)).collect()
}

/// Whether speech recognition can run here. Other architectures build ggml
/// for their own baseline (NEON on aarch64), so only x86_64 is checked.
pub fn supported() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        missing(|f| match f {
            "avx" => std::arch::is_x86_feature_detected!("avx"),
            "avx2" => std::arch::is_x86_feature_detected!("avx2"),
            "fma" => std::arch::is_x86_feature_detected!("fma"),
            "f16c" => std::arch::is_x86_feature_detected!("f16c"),
            "bmi2" => std::arch::is_x86_feature_detected!("bmi2"),
            _ => false,
        })
        .is_empty()
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_haswell_class_cpu_has_everything() {
        assert!(missing(|_| true).is_empty());
    }

    #[test]
    fn a_cpu_without_avx2_is_refused_by_name() {
        assert_eq!(missing(|f| f != "avx2" && f != "fma"), vec!["avx2", "fma"]);
        assert_eq!(missing(|_| false), REQUIRED.to_vec());
    }
}
