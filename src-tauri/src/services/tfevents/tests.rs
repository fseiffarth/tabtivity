//! Event files built byte by byte: a small protobuf/TFRecord encoder stands in
//! for PyTorch and TensorFlow, so no binary fixture is committed.

use super::*;

// ── A tiny encoder ───────────────────────────────────────────────────────

fn varint(mut v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return out;
        }
        out.push(b | 0x80);
    }
}

fn len_field(number: u32, payload: &[u8]) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3 | 2);
    out.extend(varint(payload.len() as u64));
    out.extend_from_slice(payload);
    out
}

fn varint_field(number: u32, v: u64) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3);
    out.extend(varint(v));
    out
}

fn fixed32_field(number: u32, v: u32) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3 | 5);
    out.extend(v.to_le_bytes());
    out
}

fn fixed64_field(number: u32, v: u64) -> Vec<u8> {
    let mut out = varint(u64::from(number) << 3 | 1);
    out.extend(v.to_le_bytes());
    out
}

/// `Summary.Value` with `simple_value` (PyTorch, tensorboardX, Lightning).
fn simple(tag: &str, v: f32) -> Vec<u8> {
    let mut out = len_field(1, tag.as_bytes());
    out.extend(fixed32_field(2, v.to_bits()));
    out
}

fn metadata(plugin: &str) -> Vec<u8> {
    len_field(1, &len_field(1, plugin.as_bytes()))
}

/// A scalar `TensorProto` shape: no dims.
fn tensor_float_val(v: f32, packed: bool) -> Vec<u8> {
    let mut out = varint_field(1, 1);
    out.extend(len_field(2, &[]));
    if packed {
        out.extend(len_field(5, &v.to_le_bytes()));
    } else {
        out.extend(fixed32_field(5, v.to_bits()));
    }
    out
}

fn tensor_double_val(v: f64) -> Vec<u8> {
    let mut out = varint_field(1, 2);
    out.extend(len_field(2, &[]));
    out.extend(len_field(6, &v.to_le_bytes()));
    out
}

fn tensor_content(dtype: u64, content: &[u8]) -> Vec<u8> {
    let mut out = varint_field(1, dtype);
    out.extend(len_field(2, &[]));
    out.extend(len_field(4, content));
    out
}

/// `Summary.Value` carrying a tensor (TF2 `tf.summary.scalar`, Keras).
fn tensor_value(tag: &str, tensor: &[u8], plugin: Option<&str>) -> Vec<u8> {
    let mut out = len_field(1, tag.as_bytes());
    if let Some(p) = plugin {
        out.extend(len_field(9, &metadata(p)));
    }
    out.extend(len_field(8, tensor));
    out
}

fn event(wall: f64, step: i64, values: &[Vec<u8>]) -> Vec<u8> {
    let mut out = fixed64_field(1, wall.to_bits());
    out.extend(varint_field(2, step as u64));
    if !values.is_empty() {
        let mut summary = Vec::new();
        for v in values {
            summary.extend(len_field(1, v));
        }
        out.extend(len_field(5, &summary));
    }
    out
}

fn version_event() -> Vec<u8> {
    let mut out = fixed64_field(1, 1.5f64.to_bits());
    out.extend(len_field(3, b"brain.Event:2"));
    out
}

fn record(data: &[u8]) -> Vec<u8> {
    let len = (data.len() as u64).to_le_bytes();
    let mut out = len.to_vec();
    out.extend(masked_crc32c(&len).to_le_bytes());
    out.extend_from_slice(data);
    out.extend(masked_crc32c(data).to_le_bytes());
    out
}

fn file(events: &[Vec<u8>]) -> Vec<u8> {
    events.iter().flat_map(|e| record(e)).collect()
}

fn series<'a>(s: &'a Scan, tag: &str) -> &'a [Point] {
    s.scalars.get(tag).map(Vec::as_slice).unwrap_or(&[])
}

// ── Checksums ────────────────────────────────────────────────────────────

#[test]
fn crc32c_matches_the_published_vectors() {
    // RFC 3720 appendix B.4, and the classic check string.
    assert_eq!(crc32c(b"123456789"), 0xE306_9283);
    assert_eq!(crc32c(&[0u8; 32]), 0x8A91_36AA);
    assert_eq!(crc32c(&[0xFFu8; 32]), 0x62A8_AB43);
    let ascending: Vec<u8> = (0..32).collect();
    assert_eq!(crc32c(&ascending), 0x46DD_794E);
    assert_eq!(crc32c(&[]), 0);
}

#[test]
fn the_masked_crc_matches_independently_computed_vectors() {
    assert_eq!(masked_crc32c(b"123456789"), 0xC78A_B0E5);
    assert_eq!(masked_crc32c(&[0u8; 32]), 0x0FD7_FFFA);
    assert_eq!(masked_crc32c(&[0xFFu8; 32]), 0xF909_B029);
    assert_eq!(masked_crc32c(&[0u8; 8]), 0x0798_0329);
}

// ── Scalars ──────────────────────────────────────────────────────────────

#[test]
fn a_pytorch_style_file_yields_its_simple_values() {
    let bytes = file(&[
        version_event(),
        event(10.0, 0, &[simple("loss", 2.5), simple("train/acc", 0.25)]),
        event(11.0, 1, &[simple("loss", 1.5)]),
    ]);
    let s = scan(&bytes, 0);
    assert_eq!(s.next_offset, bytes.len() as u64);
    assert_eq!(s.file_version.as_deref(), Some("brain.Event:2"));
    assert_eq!(series(&s, "loss"), &[Point(0, 10.0, 2.5), Point(1, 11.0, 1.5)]);
    assert_eq!(series(&s, "train/acc"), &[Point(0, 10.0, 0.25)]);
    assert_eq!(s.skipped, Skipped::default());
}

#[test]
fn tf2_tensor_scalars_read_float_val_double_val_and_tensor_content() {
    let bytes = file(&[
        event(1.0, 5, &[
            tensor_value("epoch_loss", &tensor_float_val(0.5, true), Some("scalars")),
            tensor_value("unpacked", &tensor_float_val(0.75, false), Some("scalars")),
            tensor_value("dbl", &tensor_double_val(0.125), Some("scalars")),
            tensor_value("content_f32", &tensor_content(1, &2.0f32.to_le_bytes()), Some("scalars")),
            tensor_value("content_f64", &tensor_content(2, &4.0f64.to_le_bytes()), Some("scalars")),
            tensor_value("content_i64", &tensor_content(9, &(-3i64).to_le_bytes()), Some("scalars")),
            // No metadata: a one-element float tensor still reads as a scalar.
            tensor_value("bare", &tensor_float_val(9.0, true), None),
        ]),
    ]);
    let s = scan(&bytes, 0);
    for (tag, want) in [
        ("epoch_loss", 0.5),
        ("unpacked", 0.75),
        ("dbl", 0.125),
        ("content_f32", 2.0),
        ("content_f64", 4.0),
        ("content_i64", -3.0),
        ("bare", 9.0),
    ] {
        assert_eq!(series(&s, tag), &[Point(5, 1.0, want)], "{tag}");
    }
}

#[test]
fn images_histograms_and_other_plugins_are_counted_by_series_not_drawn() {
    let image = {
        let mut v = len_field(1, b"samples");
        v.extend(len_field(4, b"\x89PNG"));
        v
    };
    let histo = {
        let mut v = len_field(1, b"weights");
        v.extend(len_field(5, &[]));
        v
    };
    let tf2_image = tensor_value("tf2img", &tensor_content(7, b"x"), Some("images"));
    let text = tensor_value("notes", &tensor_content(7, b"x"), Some("text"));
    let vector = {
        // A 2-element tensor under the scalars plugin is not a scalar.
        let mut t = varint_field(1, 1);
        t.extend(len_field(2, &len_field(2, &varint_field(1, 2))));
        t.extend(len_field(4, &[0; 8]));
        tensor_value("vec", &t, Some("scalars"))
    };
    let bytes = file(&[
        event(1.0, 0, &[image.clone(), histo, tf2_image, text, vector, simple("loss", 1.0)]),
        event(2.0, 1, &[image]),
    ]);
    let s = scan(&bytes, 0);
    assert_eq!(s.scalars.keys().collect::<Vec<_>>(), ["loss"]);
    let counts: BTreeMap<_, _> = s.skipped.series.iter().map(|(k, v)| (k.as_str(), v.len())).collect();
    // `samples` (v1 image, at two steps) and `tf2img` (TF2 images plugin):
    // two series, however many steps each has.
    assert_eq!(counts["image"], 2);
    assert_eq!(counts["histogram"], 1);
    assert_eq!(counts["text"], 1);
    assert_eq!(counts["scalar"], 1);
}

#[test]
fn non_finite_values_are_counted_not_drawn() {
    let bytes = file(&[event(1.0, 0, &[simple("a", f32::NAN), simple("a", f32::INFINITY), simple("a", 1.0)])]);
    let s = scan(&bytes, 0);
    assert_eq!(series(&s, "a"), &[Point(0, 1.0, 1.0)]);
    assert_eq!(s.skipped.non_finite, 2);
}

#[test]
fn unknown_fields_are_ignored() {
    let mut ev = event(1.0, 3, &[simple("loss", 1.0)]);
    ev.extend(varint_field(99, 7));
    ev.extend(len_field(98, b"future"));
    ev.extend(fixed64_field(97, 1));
    let s = scan(&file(&[ev]), 0);
    assert_eq!(series(&s, "loss"), &[Point(3, 1.0, 1.0)]);
    assert_eq!(s.skipped.malformed, 0);
}

// ── Hostile and half-written input ───────────────────────────────────────

#[test]
fn a_torn_last_record_leaves_the_offset_in_front_of_it() {
    let whole = file(&[event(1.0, 0, &[simple("loss", 1.0)]), event(2.0, 1, &[simple("loss", 0.5)])]);
    let first_len = record(&event(1.0, 0, &[simple("loss", 1.0)])).len();
    // Cut at every byte inside the second record.
    for cut in first_len + 1..whole.len() {
        let s = scan(&whole[..cut], 0);
        assert_eq!(s.next_offset, first_len as u64, "cut at {cut}");
        assert_eq!(series(&s, "loss").len(), 1);
        assert!(!s.skipped.bad_crc, "a torn tail is not corruption (cut {cut})");
    }
    // The writer finishes: resuming from the cursor takes only the rest.
    let rest = scan(&whole[first_len..], first_len as u64);
    assert_eq!(series(&rest, "loss"), &[Point(1, 2.0, 0.5)]);
    assert_eq!(rest.next_offset, whole.len() as u64);
}

#[test]
fn the_offset_is_absolute_when_resuming() {
    let bytes = file(&[event(1.0, 0, &[simple("x", 1.0)])]);
    let s = scan(&bytes, 1000);
    assert_eq!(s.next_offset, 1000 + bytes.len() as u64);
}

#[test]
fn a_bad_data_crc_stops_the_scan_at_that_record() {
    let a = record(&event(1.0, 0, &[simple("loss", 1.0)]));
    let mut b = record(&event(2.0, 1, &[simple("loss", 0.5)]));
    let n = b.len();
    b[n - 1] ^= 0xFF;
    let c = record(&event(3.0, 2, &[simple("loss", 0.25)]));
    let bytes = [a.clone(), b, c].concat();
    let s = scan(&bytes, 0);
    assert!(s.skipped.bad_crc);
    assert_eq!(s.next_offset, a.len() as u64);
    assert_eq!(series(&s, "loss").len(), 1);
}

#[test]
fn a_bad_length_crc_stops_the_scan() {
    let mut bytes = record(&event(1.0, 0, &[simple("loss", 1.0)]));
    bytes[9] ^= 0x01;
    let s = scan(&bytes, 0);
    assert!(s.skipped.bad_crc);
    assert_eq!(s.next_offset, 0);
    assert!(s.scalars.is_empty());
}

#[test]
fn an_oversized_record_is_stepped_over_by_its_length() {
    let len = MAX_RECORD + 1;
    let mut big = len.to_le_bytes().to_vec();
    big.extend(masked_crc32c(&len.to_le_bytes()).to_le_bytes());
    big.resize(12 + len as usize + 4, 0);
    let after = record(&event(1.0, 7, &[simple("loss", 1.0)]));
    let bytes = [big.clone(), after].concat();
    let s = scan(&bytes, 0);
    assert_eq!(s.skipped.oversized, 1);
    assert_eq!(series(&s, "loss"), &[Point(7, 1.0, 1.0)]);
    assert_eq!(s.next_offset, bytes.len() as u64);
}

#[test]
fn an_oversized_header_without_its_body_waits_beyond_the_bytes() {
    let len = 1u64 << 40;
    let mut head = len.to_le_bytes().to_vec();
    head.extend(masked_crc32c(&len.to_le_bytes()).to_le_bytes());
    let s = scan(&head, 0);
    assert_eq!(s.skipped.oversized, 1);
    assert_eq!(s.next_offset, len + 16);
    // A length that would overflow the offset arithmetic must not panic.
    let len = u64::MAX;
    let mut head = len.to_le_bytes().to_vec();
    head.extend(masked_crc32c(&len.to_le_bytes()).to_le_bytes());
    let s = scan(&head, 0);
    assert!(s.skipped.bad_crc);
}

#[test]
fn garbage_empty_and_tiny_inputs_never_panic() {
    assert_eq!(scan(&[], 0).next_offset, 0);
    assert_eq!(scan(&[1, 2, 3], 5).next_offset, 5);
    let junk: Vec<u8> = (0..4096u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
    let s = scan(&junk, 0);
    assert!(s.scalars.is_empty());
    assert_eq!(s.next_offset, 0);
    // A record whose CRCs are right but whose body is not a protobuf.
    let s = scan(&record(&[0xFF; 40]), 0);
    assert_eq!(s.skipped.malformed, 1);
    assert_eq!(s.next_offset, record(&[0xFF; 40]).len() as u64);
}

#[test]
fn every_prefix_and_byte_flip_of_a_real_file_is_survived() {
    let bytes = file(&[
        version_event(),
        event(1.0, 0, &[simple("a", 1.0), tensor_value("b", &tensor_float_val(2.0, true), Some("scalars"))]),
    ]);
    for cut in 0..=bytes.len() {
        let _ = scan(&bytes[..cut], 0);
    }
    for i in 0..bytes.len() {
        let mut m = bytes.clone();
        m[i] ^= 0xA5;
        let _ = scan(&m, 0);
    }
}

#[test]
fn deeply_nested_and_huge_fields_are_bounded() {
    // A length field claiming more bytes than exist.
    let mut ev = varint(5 << 3 | 2);
    ev.extend(varint(u64::MAX));
    assert_eq!(scan(&record(&ev), 0).skipped.malformed, 1);
    // A varint with no terminator.
    assert_eq!(scan(&record(&[0x08, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]), 0).skipped.malformed, 1);
}

#[test]
fn points_and_tags_are_capped() {
    let many: Vec<Vec<u8>> = (0..(MAX_TAGS as i64 + 5)).map(|i| simple(&format!("t{i}"), 1.0)).collect();
    let s = scan(&file(&[event(1.0, 0, &many)]), 0);
    assert_eq!(s.scalars.len(), MAX_TAGS);
    assert_eq!(s.skipped.dropped, 5);
    let long = "x".repeat(10_000);
    let s = scan(&file(&[event(1.0, 0, &[simple(&long, 1.0)])]), 0);
    assert_eq!(s.scalars.keys().next().map(String::len), Some(MAX_NAME));
}

// ── Downsampling ─────────────────────────────────────────────────────────

fn ramp(n: usize) -> Vec<Point> {
    (0..n).map(|i| Point(i as i64, i as f64, (i % 17) as f64)).collect()
}

#[test]
fn downsample_leaves_a_short_series_alone() {
    let p = ramp(10);
    assert_eq!(downsample(p.clone(), 10), p);
    assert_eq!(downsample(vec![], 10), vec![]);
}

#[test]
fn downsample_keeps_the_ends_the_bound_and_the_spike() {
    let mut p = ramp(100_000);
    p[54_321].2 = 1.0e6;
    p[77_777].2 = -1.0e6;
    let d = downsample(p.clone(), 1_500);
    assert!(d.len() <= 1_500, "{} points", d.len());
    assert_eq!(d.first(), p.first());
    assert_eq!(d.last(), p.last());
    assert!(d.iter().any(|x| x.2 == 1.0e6), "the spike survived");
    assert!(d.iter().any(|x| x.2 == -1.0e6), "the dip survived");
    assert!(d.windows(2).all(|w| w[0].0 < w[1].0), "still in step order");
}

#[test]
fn downsample_handles_tiny_maxima() {
    let d = downsample(ramp(50), 0);
    assert!(d.len() <= 4 && d.len() >= 2);
    assert_eq!(d.first().map(Point::step), Some(0));
    assert_eq!(d.last().map(Point::step), Some(49));
}
