//! TensorBoard event files (`events.out.tfevents.*`), read natively: the
//! TFRecord framing, the slice of the `Event` protobuf the scalars viewer
//! needs, and the bounded downsampler (`docs/tensorboard_viewer_plan.md`).
//!
//! **Pure and `AppHandle`-free.** [`scan`] takes bytes and an offset and
//! answers what it found; the command (`commands::tfevents`) owns the I/O.
//!
//! An event file sits in a project folder, so it is attacker-controlled input
//! (AGENTS.md, Invariants). The parser is therefore bounded and total: it never
//! panics, indexes only through checked slices, and gives up on a record
//! instead of trusting a length. No crate parses this: the protobuf reader is
//! the ~100 lines below and the CRC32C is a 256-entry table.
//!
//! The reader keeps no state between calls except the byte offset the caller
//! hands back: a record the writer has only half appended (the normal state of
//! a live run) leaves the offset in front of it, and the next call tries again.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

/// A record longer than this is skipped by its length, never buffered.
pub const MAX_RECORD: u64 = 16 * 1024 * 1024;
/// Nested protobuf messages deeper than this are dropped.
const MAX_DEPTH: u32 = 8;
/// Points kept per tag in one scan; the rest are counted, not kept.
pub const MAX_POINTS_PER_TAG: usize = 200_000;
/// Distinct tags kept per scan; further new tags are counted, not kept.
pub const MAX_TAGS: usize = 2_000;
/// The default per-tag size [`downsample`] reduces a scan's points to.
pub const DEFAULT_DOWNSAMPLE: usize = 1_500;
/// Longest tag / plugin name kept (a hostile file could carry megabytes).
const MAX_NAME: usize = 256;

/// One scalar sample. Serialized as `[step, wall, value]`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Point(pub i64, pub f64, pub f64);

impl Point {
    pub fn step(&self) -> i64 {
        self.0
    }
    pub fn value(&self) -> f64 {
        self.2
    }
}

/// What a scan met and did not draw. Counts are per scan; the viewer adds them.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    /// Series (tags) of other kinds: `image`, `histogram`, `audio`, `text`,
    /// `hparams`, … Distinct tag names, so "3 image series" is countable.
    pub series: BTreeMap<String, BTreeSet<String>>,
    /// Scalar samples whose value was NaN or infinite (not drawable).
    pub non_finite: u64,
    /// Records over [`MAX_RECORD`], skipped by their length.
    pub oversized: u64,
    /// Records whose CRC was fine but whose protobuf did not parse.
    pub malformed: u64,
    /// Samples beyond [`MAX_POINTS_PER_TAG`] / [`MAX_TAGS`].
    pub dropped: u64,
    /// The scan stopped at a record whose masked CRC is wrong (corrupt file).
    pub bad_crc: bool,
}

/// The result of reading a stretch of an event file.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Scan {
    /// Where the next read starts: the end of the last whole record taken. It
    /// can lie beyond the bytes given (a skipped oversized record), and equals
    /// the starting offset when nothing complete was there.
    pub next_offset: u64,
    pub scalars: BTreeMap<String, Vec<Point>>,
    pub skipped: Skipped,
    /// `file_version` of the first record (`brain.Event:2`), when seen.
    pub file_version: Option<String>,
}

// ── CRC32C ───────────────────────────────────────────────────────────────

const fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut crc = i as u32;
        let mut k = 0;
        while k < 8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0x82F6_3B78 } else { crc >> 1 };
            k += 1;
        }
        table[i] = crc;
        i += 1;
    }
    table
}

static CRC_TABLE: [u32; 256] = crc_table();

/// CRC-32C (Castagnoli), the checksum TFRecord is built on.
pub fn crc32c(data: &[u8]) -> u32 {
    let mut crc = !0u32;
    for &b in data {
        crc = CRC_TABLE[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    !crc
}

/// TFRecord's masked CRC: rotated right by 15 bits plus a constant.
pub fn masked_crc32c(data: &[u8]) -> u32 {
    let crc = crc32c(data);
    crc.rotate_right(15).wrapping_add(0xA282_EAD8)
}

// ── Protobuf reader ──────────────────────────────────────────────────────

/// A cursor over a message's bytes. Every read is checked; a failure is `None`.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

/// One field's value. Length-delimited payloads borrow from the message.
enum Field<'a> {
    Varint(u64),
    Fixed64(u64),
    Fixed32(u32),
    Bytes(&'a [u8]),
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn done(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn varint(&mut self) -> Option<u64> {
        let mut out = 0u64;
        for shift in (0..70).step_by(7) {
            let b = *self.buf.get(self.pos)?;
            self.pos += 1;
            if shift < 64 {
                out |= u64::from(b & 0x7F) << shift;
            }
            if b & 0x80 == 0 {
                return Some(out);
            }
        }
        None
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }

    /// The next `(field number, value)`, or `None` at the end or on garbage.
    /// Unknown fields come back like any other; the caller ignores them.
    fn next(&mut self) -> Option<(u32, Field<'a>)> {
        let key = self.varint()?;
        let number = u32::try_from(key >> 3).ok()?;
        let value = match key & 7 {
            0 => Field::Varint(self.varint()?),
            1 => Field::Fixed64(u64::from_le_bytes(self.take(8)?.try_into().ok()?)),
            2 => {
                let len = usize::try_from(self.varint()?).ok()?;
                Field::Bytes(self.take(len)?)
            }
            5 => Field::Fixed32(u32::from_le_bytes(self.take(4)?.try_into().ok()?)),
            _ => return None, // groups and unknown wire types: not data we read
        };
        Some((number, value))
    }
}

fn name_of(bytes: &[u8]) -> String {
    let cut = bytes.len().min(MAX_NAME);
    String::from_utf8_lossy(&bytes[..cut]).into_owned()
}

// ── Event → scalars ──────────────────────────────────────────────────────

/// What one `Summary.Value` turned out to be.
enum Sample {
    Scalar(f64),
    /// Another kind of series (`image`, `histogram`, a plugin's name).
    Other(String),
    /// Nothing drawable and nothing worth counting (an empty value).
    Nothing,
}

/// `TensorProto` dtype codes (`types.proto`) this reader turns into a scalar.
const DT_FLOAT: u64 = 1;
const DT_DOUBLE: u64 = 2;
const DT_INT32: u64 = 3;
const DT_INT64: u64 = 9;

/// The one number of a scalar `TensorProto`, or `None` if it is not one.
fn tensor_scalar(msg: &[u8], depth: u32) -> Option<f64> {
    if depth > MAX_DEPTH {
        return None;
    }
    let mut dtype = 0u64;
    let mut content: Option<&[u8]> = None;
    let mut float_val: Option<f32> = None;
    let mut double_val: Option<f64> = None;
    let mut int_val: Option<i64> = None;
    let mut elements = 1u64;
    let mut r = Reader::new(msg);
    while !r.done() {
        let (n, f) = r.next()?;
        match (n, f) {
            (1, Field::Varint(v)) => dtype = v,
            (2, Field::Bytes(shape)) => elements = shape_elements(shape)?,
            (4, Field::Bytes(b)) => content = Some(b),
            // `repeated float float_val = 5` is packed (length-delimited) from
            // proto3 writers; an unpacked writer sends one fixed32 per element.
            (5, Field::Bytes(b)) => float_val = b.get(..4).and_then(|s| s.try_into().ok()).map(f32::from_le_bytes),
            (5, Field::Fixed32(v)) => float_val = Some(f32::from_bits(v)),
            (6, Field::Bytes(b)) => double_val = b.get(..8).and_then(|s| s.try_into().ok()).map(f64::from_le_bytes),
            (6, Field::Fixed64(v)) => double_val = Some(f64::from_bits(v)),
            (7, Field::Bytes(b)) => int_val = Reader::new(b).varint().map(|v| i64::from(v as i32)),
            (7, Field::Varint(v)) => int_val = Some(i64::from(v as i32)),
            (10, Field::Bytes(b)) => int_val = Reader::new(b).varint().map(|v| v as i64),
            (10, Field::Varint(v)) => int_val = Some(v as i64),
            _ => {}
        }
    }
    // A scalar has one element; a bigger tensor is some other plugin's data.
    if elements != 1 {
        return None;
    }
    if let Some(c) = content {
        return match dtype {
            DT_FLOAT => c.get(..4).and_then(|s| s.try_into().ok()).map(|b| f64::from(f32::from_le_bytes(b))),
            DT_DOUBLE => c.get(..8).and_then(|s| s.try_into().ok()).map(f64::from_le_bytes),
            DT_INT32 => c.get(..4).and_then(|s| s.try_into().ok()).map(|b| f64::from(i32::from_le_bytes(b))),
            DT_INT64 => c.get(..8).and_then(|s| s.try_into().ok()).map(|b| i64::from_le_bytes(b) as f64),
            _ => None,
        };
    }
    match dtype {
        DT_FLOAT => float_val.map(f64::from),
        DT_DOUBLE => double_val,
        DT_INT32 | DT_INT64 => int_val.map(|v| v as f64),
        _ => None,
    }
}

/// Element count of a `TensorShapeProto` (the product of its dims; none = 1).
fn shape_elements(msg: &[u8]) -> Option<u64> {
    let mut count = 1u64;
    let mut r = Reader::new(msg);
    while !r.done() {
        let (n, f) = r.next()?;
        match (n, f) {
            (2, Field::Bytes(dim)) => {
                let mut d = Reader::new(dim);
                while !d.done() {
                    if let (1, Field::Varint(size)) = d.next()? {
                        count = count.saturating_mul(size);
                    }
                }
            }
            // `unknown_rank`: not a scalar we can read.
            (3, Field::Varint(1)) => return None,
            _ => {}
        }
    }
    Some(count)
}

/// The plugin name in a `SummaryMetadata`.
fn plugin_name(msg: &[u8]) -> Option<String> {
    let mut r = Reader::new(msg);
    while !r.done() {
        if let (1, Field::Bytes(plugin)) = r.next()? {
            let mut p = Reader::new(plugin);
            while !p.done() {
                if let (1, Field::Bytes(name)) = p.next()? {
                    return Some(name_of(name));
                }
            }
        }
    }
    None
}

/// Singular, user-facing kind for a TF2 plugin name.
fn kind_of_plugin(plugin: &str) -> String {
    match plugin {
        "images" => "image".into(),
        "histograms" => "histogram".into(),
        "scalars" => "scalar".into(),
        other => other.to_string(),
    }
}

/// Read one `Summary.Value`: its tag and what it carries.
fn read_value(msg: &[u8]) -> Option<(String, Sample)> {
    let mut tag = String::new();
    let mut simple: Option<f32> = None;
    let mut tensor: Option<&[u8]> = None;
    let mut plugin: Option<String> = None;
    let mut other: Option<&'static str> = None;
    let mut r = Reader::new(msg);
    while !r.done() {
        let (n, f) = r.next()?;
        match (n, f) {
            (1, Field::Bytes(b)) => tag = name_of(b),
            (2, Field::Fixed32(v)) => simple = Some(f32::from_bits(v)),
            (4, Field::Bytes(_)) => other = Some("image"),
            (5, Field::Bytes(_)) => other = Some("histogram"),
            (6, Field::Bytes(_)) => other = Some("audio"),
            (8, Field::Bytes(b)) => tensor = Some(b),
            (9, Field::Bytes(b)) => plugin = plugin_name(b),
            _ => {}
        }
    }
    let sample = if let Some(v) = simple {
        Sample::Scalar(f64::from(v))
    } else if let Some(kind) = other {
        Sample::Other(kind.to_string())
    } else if let Some(t) = tensor {
        match plugin.as_deref() {
            // No metadata (TF2 sends it on the first event of a tag, and a
            // writer may omit it): a one-element float tensor is a scalar.
            Some("scalars") | None => match tensor_scalar(t, 0) {
                Some(v) => Sample::Scalar(v),
                None if plugin.is_some() => Sample::Other("scalar".into()),
                None => Sample::Other("tensor".into()),
            },
            Some(p) => Sample::Other(kind_of_plugin(p)),
        }
    } else {
        Sample::Nothing
    };
    Some((tag, sample))
}

/// What one `Event` held.
struct EventData {
    wall: f64,
    step: i64,
    version: Option<String>,
    values: Vec<(String, Sample)>,
}

fn read_event(msg: &[u8]) -> Option<EventData> {
    let mut ev = EventData { wall: 0.0, step: 0, version: None, values: Vec::new() };
    let mut r = Reader::new(msg);
    while !r.done() {
        let (n, f) = r.next()?;
        match (n, f) {
            (1, Field::Fixed64(v)) => ev.wall = f64::from_bits(v),
            (2, Field::Varint(v)) => ev.step = v as i64,
            (3, Field::Bytes(b)) => ev.version = Some(name_of(b)),
            (5, Field::Bytes(summary)) => {
                let mut s = Reader::new(summary);
                while !s.done() {
                    if let (1, Field::Bytes(value)) = s.next()? {
                        // A value that does not parse costs that value only.
                        if let Some(v) = read_value(value) {
                            ev.values.push(v);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Some(ev)
}

// ── The scan ─────────────────────────────────────────────────────────────

/// Read whole records from `bytes`, which start at absolute file offset `from`.
///
/// Stops, leaving [`Scan::next_offset`] in front of the record, at: the end of
/// the bytes, a record that is not all here yet (the writer is mid-append: not
/// an error), or a record with a wrong CRC ([`Skipped::bad_crc`]). A record
/// over [`MAX_RECORD`] is stepped over by its length without being read.
pub fn scan(bytes: &[u8], from: u64) -> Scan {
    let mut out = Scan { next_offset: from, ..Scan::default() };
    let mut pos: usize = 0;
    loop {
        let rest = &bytes[pos.min(bytes.len())..];
        if rest.len() < 12 {
            break;
        }
        let len_bytes: [u8; 8] = rest[..8].try_into().unwrap_or([0; 8]);
        let len_crc = u32::from_le_bytes(rest[8..12].try_into().unwrap_or([0; 4]));
        if masked_crc32c(&len_bytes) != len_crc {
            out.skipped.bad_crc = true;
            break;
        }
        let len = u64::from_le_bytes(len_bytes);
        // 12-byte header + data + 4-byte data CRC.
        let total = match len.checked_add(16) {
            Some(t) => t,
            None => {
                out.skipped.bad_crc = true;
                break;
            }
        };
        if len > MAX_RECORD {
            out.skipped.oversized += 1;
            out.next_offset = out.next_offset.saturating_add(total);
            // The skip may run past what we hold: the next read starts there.
            match usize::try_from(total).ok().and_then(|t| pos.checked_add(t)) {
                Some(p) if p <= bytes.len() => {
                    pos = p;
                    continue;
                }
                _ => break,
            }
        }
        let len = len as usize; // <= MAX_RECORD
        if rest.len() < len + 16 {
            break; // torn tail: wait for the writer
        }
        let data = &rest[12..12 + len];
        let data_crc = u32::from_le_bytes(rest[12 + len..16 + len].try_into().unwrap_or([0; 4]));
        if masked_crc32c(data) != data_crc {
            out.skipped.bad_crc = true;
            break;
        }
        take_event(&mut out, data);
        pos += len + 16;
        out.next_offset += (len + 16) as u64;
    }
    out
}

fn take_event(out: &mut Scan, data: &[u8]) {
    let Some(ev) = read_event(data) else {
        out.skipped.malformed += 1;
        return;
    };
    if out.file_version.is_none() {
        out.file_version = ev.version;
    }
    for (tag, sample) in ev.values {
        match sample {
            Sample::Scalar(v) => {
                if !v.is_finite() {
                    out.skipped.non_finite += 1;
                    continue;
                }
                if !out.scalars.contains_key(&tag) && out.scalars.len() >= MAX_TAGS {
                    out.skipped.dropped += 1;
                    continue;
                }
                let series = out.scalars.entry(tag).or_default();
                if series.len() >= MAX_POINTS_PER_TAG {
                    out.skipped.dropped += 1;
                } else {
                    series.push(Point(ev.step, if ev.wall.is_finite() { ev.wall } else { 0.0 }, v));
                }
            }
            Sample::Other(kind) => {
                let tags = out.skipped.series.entry(kind).or_default();
                if tags.len() < MAX_TAGS {
                    tags.insert(tag);
                }
            }
            Sample::Nothing => {}
        }
    }
}

// ── Downsampling ─────────────────────────────────────────────────────────

/// Reduce `points` to at most `max` (min 4) keeping the shape: the first and
/// last point, and from every bucket in between its lowest and highest value,
/// in step order, so a spike survives where a plain stride would drop it.
pub fn downsample(points: Vec<Point>, max: usize) -> Vec<Point> {
    let max = max.max(4);
    if points.len() <= max {
        return points;
    }
    let interior = &points[1..points.len() - 1];
    let buckets = ((max - 2) / 2).max(1);
    let size = interior.len().div_ceil(buckets);
    let mut out = Vec::with_capacity(max);
    out.push(points[0]);
    for chunk in interior.chunks(size) {
        let mut lo = 0;
        let mut hi = 0;
        for (i, p) in chunk.iter().enumerate() {
            if p.value() < chunk[lo].value() {
                lo = i;
            }
            if p.value() > chunk[hi].value() {
                hi = i;
            }
        }
        if lo == hi {
            out.push(chunk[lo]);
        } else {
            out.push(chunk[lo.min(hi)]);
            out.push(chunk[lo.max(hi)]);
        }
    }
    out.push(points[points.len() - 1]);
    out
}

#[cfg(test)]
mod tests;
