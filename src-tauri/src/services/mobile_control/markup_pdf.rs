//! Bakes the phone's markup layer into a copy of a PDF (`markup.rs`).
//!
//! The marks become real annotations — `/Ink` for pen strokes, `/Highlight`
//! for boxes, `/FreeText` for typed notes — each with its own appearance
//! stream, so every viewer (and an agent looking at the rendered page) sees
//! them the same. They are written as an **incremental update**: the
//! original bytes stay verbatim at the front of the copy, followed by the new
//! annotation objects, a new version of each marked page with the
//! annotations added to its `/Annots`, and a cross-reference section whose
//! `/Prev` points back at the file's own. Nothing of the source is rewritten.
//!
//! The reader is deliberately small: it understands what an update has to
//! touch — the cross-reference chain (classic tables, cross-reference streams
//! and hybrids), object streams, the page tree with its inherited boxes and
//! `/Rotate` — and refuses everything else, an encrypted file included. The
//! bytes come from a project folder, which is attacker-controlled by policy:
//! every read is bounds-checked, nesting is capped, decompression is capped,
//! and a step budget with a deadline bounds the work, so a hostile file ends
//! in a [`BakeError`], never a panic or a hang. A failed bake costs the agent
//! only the marked copy — the layer pictures and notes still carry the marks.
//!
//! Marks arrive in the page's *displayed* space (`markup.rs`): units of the
//! page as the phone showed it — after its `/Rotate`, origin top left. One
//! affine map per page takes them to PDF user space; the appearance streams
//! draw in the phone's own units under that map, so a rotated page and a
//! phone that measured the page slightly differently both come out right.

use std::{
    cell::Cell,
    collections::{HashMap, HashSet},
    io::Read,
    time::{Duration, Instant},
};

use super::markup::{ink_width, Color, Mark, MarkupPage};

/// How long one bake may take before it gives up.
pub const BAKE_DEADLINE: Duration = Duration::from_secs(20);
/// Objects one bake may parse — a page tree of a few thousand pages and its
/// object streams fit many times over.
const MAX_STEPS: u32 = 400_000;
/// Nesting of arrays and dictionaries the parser follows.
const MAX_DEPTH: usize = 48;
/// The most a single decompressed stream (a cross-reference or object
/// stream) may grow to.
const MAX_INFLATED: u64 = 64 * 1024 * 1024;
/// Page-tree depth and size the walk follows.
const MAX_TREE_DEPTH: usize = 64;
const MAX_PAGES: usize = 100_000;
/// The `/Prev` chain the reader follows.
const MAX_SECTIONS: usize = 4_096;
/// PDF values one bake may parse, all together — what bounds the memory a
/// hostile file can make the parser build (a real page tree needs a few
/// thousand per hundred pages).
const MAX_OBJECTS: u32 = 2_000_000;
/// Decompressed bytes one bake may produce, all streams together.
const MAX_TOTAL_INFLATED: u64 = 128 * 1024 * 1024;
/// Entries one dictionary may hold.
const MAX_DICT: usize = 65_536;
/// Cross-reference entries the reader keeps, and the highest object number
/// it accepts (`/Size`) — the spec's own implementation limit.
const MAX_XREF: usize = 4_194_304;
const MAX_SIZE: i64 = 8_388_607;

/// What the bake running on this thread may still spend. A thread-local so
/// the lexer, the decoder and the predictor all answer to one deadline
/// without threading it through every call; outside a bake it is unlimited.
#[derive(Clone, Copy)]
struct Allowance {
    deadline: Option<Instant>,
    objects: u32,
    inflated: u64,
}

const UNLIMITED: Allowance = Allowance { deadline: None, objects: u32::MAX, inflated: u64::MAX };

thread_local! {
    static ALLOWANCE: Cell<Allowance> = const { Cell::new(UNLIMITED) };
}

/// Sets this thread's allowance for one bake; dropping it lifts it again.
struct AllowanceGuard;

impl AllowanceGuard {
    fn start(deadline: Instant) -> Self {
        ALLOWANCE.with(|a| a.set(Allowance { deadline: Some(deadline), objects: MAX_OBJECTS, inflated: MAX_TOTAL_INFLATED }));
        AllowanceGuard
    }
}

impl Drop for AllowanceGuard {
    fn drop(&mut self) {
        ALLOWANCE.with(|a| a.set(UNLIMITED));
    }
}

fn on_time() -> Fail<()> {
    match ALLOWANCE.with(Cell::get).deadline {
        Some(deadline) if Instant::now() > deadline => Err(BakeError::TooComplex),
        _ => Ok(()),
    }
}

/// One parsed value; the clock is read every few thousand.
fn charge_object() -> Fail<()> {
    let left = ALLOWANCE.with(|a| {
        let mut now = a.get();
        now.objects = now.objects.checked_sub(1)?;
        a.set(now);
        Some(now.objects)
    });
    match left {
        None => Err(BakeError::TooComplex),
        Some(left) if left.is_multiple_of(4_096) => on_time(),
        Some(_) => Ok(()),
    }
}

fn charge_inflated(bytes: u64) -> Fail<()> {
    ALLOWANCE.with(|a| {
        let mut now = a.get();
        now.inflated = now.inflated.checked_sub(bytes).ok_or(BakeError::TooComplex)?;
        a.set(now);
        Ok(())
    })?;
    on_time()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BakeError {
    /// The file carries an `/Encrypt` dictionary.
    Encrypted,
    /// The file could not be read as a PDF this reader understands.
    Unreadable,
    /// A marked page number is past the document's last page.
    PageMissing,
    /// The step budget or the deadline ran out.
    TooComplex,
}

impl BakeError {
    /// The line the agent's prompt carries when there is no marked copy.
    pub fn reason(&self) -> &'static str {
        match self {
            BakeError::Encrypted => "the PDF is encrypted",
            BakeError::Unreadable => "the PDF could not be read",
            BakeError::PageMissing => "a marked page is not in the PDF any more",
            BakeError::TooComplex => "the PDF took too long to read",
        }
    }
}

type Fail<T> = Result<T, BakeError>;

/// One PDF object, as far as an incremental update needs to know it.
#[derive(Debug, Clone, PartialEq)]
pub enum Obj {
    Null,
    Bool(bool),
    Int(i64),
    Real(f64),
    Name(Vec<u8>),
    /// A string's decoded bytes; written back as a hex string.
    Str(Vec<u8>),
    Array(Vec<Obj>),
    Dict(Dict),
    Ref(u32, u16),
}

pub type Dict = Vec<(Vec<u8>, Obj)>;

fn get<'d>(dict: &'d Dict, key: &[u8]) -> Option<&'d Obj> {
    dict.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn set(dict: &mut Dict, key: &[u8], value: Obj) {
    match dict.iter_mut().find(|(k, _)| k == key) {
        Some(entry) => entry.1 = value,
        None => dict.push((key.to_vec(), value)),
    }
}

impl Obj {
    fn as_int(&self) -> Option<i64> {
        match self {
            Obj::Int(v) => Some(*v),
            _ => None,
        }
    }
    fn as_num(&self) -> Option<f64> {
        match self {
            Obj::Int(v) => Some(*v as f64),
            Obj::Real(v) => Some(*v),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Lexing and parsing

fn is_white(b: u8) -> bool {
    matches!(b, b'\0' | b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn is_delim(b: u8) -> bool {
    matches!(b, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

fn is_regular(b: u8) -> bool {
    !is_white(b) && !is_delim(b)
}

struct Lexer<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Lexer<'a> {
    fn new(data: &'a [u8], pos: usize) -> Self {
        Lexer { data, pos }
    }

    fn peek(&self) -> Option<u8> {
        self.data.get(self.pos).copied()
    }

    fn skip_ws(&mut self) {
        while let Some(b) = self.peek() {
            if is_white(b) {
                self.pos += 1;
            } else if b == b'%' {
                while let Some(c) = self.peek() {
                    if c == b'\n' || c == b'\r' {
                        break;
                    }
                    self.pos += 1;
                }
            } else {
                break;
            }
        }
    }

    /// A run of regular characters — a number, a keyword.
    fn word(&mut self) -> &'a [u8] {
        let start = self.pos;
        while self.peek().is_some_and(is_regular) {
            self.pos += 1;
        }
        &self.data[start..self.pos]
    }

    fn keyword(&mut self, expected: &[u8]) -> bool {
        self.skip_ws();
        let save = self.pos;
        if self.word() == expected {
            true
        } else {
            self.pos = save;
            false
        }
    }

    fn unsigned(&mut self) -> Option<u64> {
        self.skip_ws();
        let save = self.pos;
        let word = self.word();
        if word.is_empty() || word.len() > 19 || !word.iter().all(u8::is_ascii_digit) {
            self.pos = save;
            return None;
        }
        std::str::from_utf8(word).ok()?.parse().ok()
    }

    fn object(&mut self, depth: usize) -> Fail<Obj> {
        if depth > MAX_DEPTH {
            return Err(BakeError::Unreadable);
        }
        charge_object()?;
        self.skip_ws();
        let Some(b) = self.peek() else {
            return Err(BakeError::Unreadable);
        };
        match b {
            b'<' if self.data.get(self.pos + 1) == Some(&b'<') => {
                self.pos += 2;
                let mut dict = Dict::new();
                let mut keys = HashSet::new();
                loop {
                    self.skip_ws();
                    match self.peek() {
                        Some(b'>') if self.data.get(self.pos + 1) == Some(&b'>') => {
                            self.pos += 2;
                            return Ok(Obj::Dict(dict));
                        }
                        Some(b'/') => {
                            let Obj::Name(key) = self.object(depth + 1)? else {
                                return Err(BakeError::Unreadable);
                            };
                            let value = self.object(depth + 1)?;
                            // A repeated key: the first one is what readers use.
                            if keys.insert(key.clone()) {
                                if dict.len() >= MAX_DICT {
                                    return Err(BakeError::TooComplex);
                                }
                                dict.push((key, value));
                            }
                        }
                        _ => return Err(BakeError::Unreadable),
                    }
                }
            }
            b'<' => {
                self.pos += 1;
                let mut bytes = Vec::new();
                let mut high: Option<u8> = None;
                loop {
                    let Some(c) = self.peek() else {
                        return Err(BakeError::Unreadable);
                    };
                    self.pos += 1;
                    if c == b'>' {
                        break;
                    }
                    if is_white(c) {
                        continue;
                    }
                    let nibble = (c as char).to_digit(16).ok_or(BakeError::Unreadable)? as u8;
                    match high.take() {
                        Some(h) => bytes.push(h << 4 | nibble),
                        None => high = Some(nibble),
                    }
                }
                if let Some(h) = high {
                    bytes.push(h << 4);
                }
                Ok(Obj::Str(bytes))
            }
            b'(' => {
                self.pos += 1;
                let mut bytes = Vec::new();
                let mut nesting = 0usize;
                loop {
                    let Some(c) = self.peek() else {
                        return Err(BakeError::Unreadable);
                    };
                    self.pos += 1;
                    match c {
                        b'(' => {
                            nesting += 1;
                            bytes.push(c);
                        }
                        b')' if nesting == 0 => break,
                        b')' => {
                            nesting -= 1;
                            bytes.push(c);
                        }
                        b'\\' => {
                            let Some(e) = self.peek() else {
                                return Err(BakeError::Unreadable);
                            };
                            self.pos += 1;
                            match e {
                                b'n' => bytes.push(b'\n'),
                                b'r' => bytes.push(b'\r'),
                                b't' => bytes.push(b'\t'),
                                b'b' => bytes.push(8),
                                b'f' => bytes.push(12),
                                b'\r' => {
                                    if self.peek() == Some(b'\n') {
                                        self.pos += 1;
                                    }
                                }
                                b'\n' => {}
                                b'0'..=b'7' => {
                                    let mut value = u32::from(e - b'0');
                                    for _ in 0..2 {
                                        match self.peek() {
                                            Some(d @ b'0'..=b'7') => {
                                                value = value * 8 + u32::from(d - b'0');
                                                self.pos += 1;
                                            }
                                            _ => break,
                                        }
                                    }
                                    bytes.push((value & 0xff) as u8);
                                }
                                other => bytes.push(other),
                            }
                        }
                        other => bytes.push(other),
                    }
                }
                Ok(Obj::Str(bytes))
            }
            b'[' => {
                self.pos += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_ws();
                    if self.peek() == Some(b']') {
                        self.pos += 1;
                        return Ok(Obj::Array(items));
                    }
                    items.push(self.object(depth + 1)?);
                }
            }
            b'/' => {
                self.pos += 1;
                let raw = self.word();
                let mut name = Vec::with_capacity(raw.len());
                let mut i = 0;
                while i < raw.len() {
                    if raw[i] == b'#' {
                        let hex = raw.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
                        if let Some(value) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                            name.push(value);
                            i += 3;
                            continue;
                        }
                    }
                    name.push(raw[i]);
                    i += 1;
                }
                Ok(Obj::Name(name))
            }
            _ => {
                let start = self.pos;
                let word = self.word();
                match word {
                    b"true" => return Ok(Obj::Bool(true)),
                    b"false" => return Ok(Obj::Bool(false)),
                    b"null" => return Ok(Obj::Null),
                    _ => {}
                }
                let text = std::str::from_utf8(word).map_err(|_| BakeError::Unreadable)?;
                if !text.is_empty() && text.bytes().all(|c| c.is_ascii_digit()) {
                    // `n g R` is a reference; anything else leaves the
                    // number alone and the lexer where it was.
                    let after = self.pos;
                    if let Some(generation) = self.unsigned() {
                        if self.keyword(b"R") {
                            let number = text.parse::<u32>().map_err(|_| BakeError::Unreadable)?;
                            let generation = u16::try_from(generation).map_err(|_| BakeError::Unreadable)?;
                            return Ok(Obj::Ref(number, generation));
                        }
                    }
                    self.pos = after;
                }
                if let Ok(value) = text.parse::<i64>() {
                    return Ok(Obj::Int(value));
                }
                // PDF reals have no exponent, but `-.5` and `4.` are fine;
                // Rust's parser takes both.
                if !text.is_empty() && text.bytes().all(|c| c.is_ascii_digit() || matches!(c, b'.' | b'-' | b'+')) {
                    if let Ok(value) = text.parse::<f64>() {
                        if value.is_finite() {
                            return Ok(Obj::Real(value));
                        }
                    }
                }
                self.pos = start;
                Err(BakeError::Unreadable)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Streams

fn png_unpredict(data: &[u8], columns: usize, bpp: usize) -> Fail<Vec<u8>> {
    let row = columns.checked_mul(bpp).ok_or(BakeError::Unreadable)?;
    if row == 0 {
        return Err(BakeError::Unreadable);
    }
    let mut out = Vec::with_capacity(data.len());
    let mut previous = vec![0u8; row];
    for (index, chunk) in data.chunks(row + 1).enumerate() {
        if index % 4_096 == 4_095 {
            on_time()?;
        }
        let (&filter, raw) = chunk.split_first().ok_or(BakeError::Unreadable)?;
        let mut current = vec![0u8; row];
        current[..raw.len()].copy_from_slice(raw);
        for i in 0..row {
            let left = if i >= bpp { current[i - bpp] } else { 0 };
            let up = previous[i];
            let up_left = if i >= bpp { previous[i - bpp] } else { 0 };
            let add = match filter {
                0 => 0,
                1 => left,
                2 => up,
                3 => ((u16::from(left) + u16::from(up)) / 2) as u8,
                4 => {
                    let p = i16::from(left) + i16::from(up) - i16::from(up_left);
                    let (pa, pb, pc) = (
                        (p - i16::from(left)).abs(),
                        (p - i16::from(up)).abs(),
                        (p - i16::from(up_left)).abs(),
                    );
                    if pa <= pb && pa <= pc {
                        left
                    } else if pb <= pc {
                        up
                    } else {
                        up_left
                    }
                }
                _ => return Err(BakeError::Unreadable),
            };
            current[i] = current[i].wrapping_add(add);
        }
        out.extend_from_slice(&current[..raw.len()]);
        previous = current;
    }
    Ok(out)
}

/// A stream's decoded bytes — Flate (with or without a PNG predictor) or no
/// filter at all; the only encodings cross-reference and object streams use
/// in practice.
fn decode(dict: &Dict, raw: &[u8]) -> Fail<Vec<u8>> {
    let filter = match get(dict, b"Filter") {
        None => None,
        Some(Obj::Name(name)) => Some(name.clone()),
        Some(Obj::Array(items)) if items.is_empty() => None,
        Some(Obj::Array(items)) if items.len() == 1 => match &items[0] {
            Obj::Name(name) => Some(name.clone()),
            _ => return Err(BakeError::Unreadable),
        },
        _ => return Err(BakeError::Unreadable),
    };
    let Some(filter) = filter else {
        return Ok(raw.to_vec());
    };
    if filter != b"FlateDecode" {
        return Err(BakeError::Unreadable);
    }
    let mut inflated = Vec::new();
    flate2::read::ZlibDecoder::new(raw)
        .take(MAX_INFLATED + 1)
        .read_to_end(&mut inflated)
        .map_err(|_| BakeError::Unreadable)?;
    if inflated.len() as u64 > MAX_INFLATED {
        return Err(BakeError::Unreadable);
    }
    charge_inflated(inflated.len() as u64)?;
    let parms = match get(dict, b"DecodeParms") {
        Some(Obj::Dict(parms)) => Some(parms),
        Some(Obj::Array(items)) => match items.first() {
            Some(Obj::Dict(parms)) => Some(parms),
            _ => None,
        },
        _ => None,
    };
    let Some(parms) = parms else {
        return Ok(inflated);
    };
    let predictor = get(parms, b"Predictor").and_then(Obj::as_int).unwrap_or(1);
    if predictor <= 1 {
        return Ok(inflated);
    }
    if predictor < 10 {
        return Err(BakeError::Unreadable);
    }
    let field = |key: &[u8], default: i64| -> Fail<usize> {
        let value = get(parms, key).and_then(Obj::as_int).unwrap_or(default);
        usize::try_from(value).ok().filter(|v| (1..=65_536).contains(v)).ok_or(BakeError::Unreadable)
    };
    let columns = field(b"Columns", 1)?;
    let colors = field(b"Colors", 1)?;
    let bits = field(b"BitsPerComponent", 8)?;
    // A cross-reference or object stream's rows are a few bytes wide; a
    // row of gigabytes is an attack on the allocator, not a PDF.
    if bits != 8 || colors > 32 || columns * colors > 65_536 {
        return Err(BakeError::Unreadable);
    }
    png_unpredict(&inflated, columns, colors)
}

// ---------------------------------------------------------------------------
// The document

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Entry {
    Free,
    /// Byte offset from the `%PDF-` header.
    Plain(usize),
    /// Index in an object stream.
    Packed(u32, u32),
}

struct Budget {
    steps: u32,
    deadline: Instant,
}

impl Budget {
    fn spend(&mut self) -> Fail<()> {
        self.steps = self.steps.checked_sub(1).ok_or(BakeError::TooComplex)?;
        // A single step can be a whole stream's worth of work: the clock is
        // read every time.
        if Instant::now() > self.deadline {
            return Err(BakeError::TooComplex);
        }
        Ok(())
    }
}

/// One page as the tree hands it down.
struct Page {
    number: u32,
    generation: u16,
    dict: Dict,
    /// The displayed box — CropBox clipped to MediaBox — `[x0, y0, x1, y1]`.
    view: [f64; 4],
    /// Clockwise quarter turns, `0..4`.
    quarter_turns: u8,
}

/// A decoded object stream and its `(object number, offset)` table.
type ObjectStream = (Vec<u8>, Vec<(u32, usize)>);

struct Doc<'a> {
    /// The file from its `%PDF-` header on; every offset is relative to it.
    body: &'a [u8],
    xref: HashMap<u32, Entry>,
    /// The newest trailer (or cross-reference stream dictionary).
    trailer: Dict,
    /// One past the highest object number any section declares.
    size: u32,
    /// Where the newest cross-reference section starts.
    last_xref: usize,
    /// Whether that section is a stream — an update answers in kind.
    last_is_stream: bool,
    object_streams: HashMap<u32, ObjectStream>,
    budget: Budget,
    /// The page numbers whose dictionaries the walk keeps — the marked ones;
    /// every other page is kept as its place and box only. `None` keeps all.
    keep: Option<HashSet<u32>>,
}

/// Where `startxref` says the newest section is.
fn find_startxref(body: &[u8]) -> Fail<usize> {
    let tail_start = body.len().saturating_sub(2048);
    let tail = &body[tail_start..];
    let at = tail
        .windows(9)
        .rposition(|w| w == b"startxref")
        .ok_or(BakeError::Unreadable)?;
    let mut lexer = Lexer::new(body, tail_start + at + 9);
    let offset = lexer.unsigned().ok_or(BakeError::Unreadable)?;
    usize::try_from(offset).ok().filter(|&o| o < body.len()).ok_or(BakeError::Unreadable)
}

impl<'a> Doc<'a> {
    fn open(file: &'a [u8], deadline: Instant) -> Fail<Self> {
        let header = file
            .get(..file.len().min(1024))
            .and_then(|head| head.windows(5).position(|w| w == b"%PDF-"))
            .ok_or(BakeError::Unreadable)?;
        let body = &file[header..];
        let mut doc = Doc {
            body,
            xref: HashMap::new(),
            trailer: Dict::new(),
            size: 0,
            last_xref: 0,
            last_is_stream: false,
            object_streams: HashMap::new(),
            budget: Budget { steps: MAX_STEPS, deadline },
            keep: None,
        };
        let start = find_startxref(body)?;
        doc.last_xref = start;
        let mut next = Some(start);
        let mut seen = HashSet::new();
        let mut first = true;
        while let Some(offset) = next {
            if !seen.insert(offset) || seen.len() > MAX_SECTIONS {
                break;
            }
            doc.budget.spend()?;
            let (trailer, is_stream) = doc.read_section(offset)?;
            if first {
                doc.last_is_stream = is_stream;
                doc.trailer = trailer.clone();
                first = false;
            }
            if let Some(size) = get(&trailer, b"Size").and_then(Obj::as_int) {
                // Past the spec's limit there would be no number left to
                // give the annotations.
                if !(0..=MAX_SIZE).contains(&size) {
                    return Err(BakeError::Unreadable);
                }
                doc.size = doc.size.max(size as u32);
            }
            next = get(&trailer, b"Prev")
                .and_then(Obj::as_int)
                .and_then(|prev| usize::try_from(prev).ok());
        }
        if get(&doc.trailer, b"Encrypt").is_some() {
            return Err(BakeError::Encrypted);
        }
        if let Some(&highest) = doc.xref.keys().max() {
            if i64::from(highest) >= MAX_SIZE {
                return Err(BakeError::Unreadable);
            }
            doc.size = doc.size.max(highest + 1);
        }
        Ok(doc)
    }

    /// Reads the section at `offset` into the map (entries already there are
    /// newer and win) and returns its trailer.
    fn read_section(&mut self, offset: usize) -> Fail<(Dict, bool)> {
        let mut lexer = Lexer::new(self.body, offset);
        if lexer.keyword(b"xref") {
            let mut entries = Vec::new();
            loop {
                if lexer.keyword(b"trailer") {
                    break;
                }
                let first = lexer.unsigned().ok_or(BakeError::Unreadable)?;
                let count = lexer.unsigned().ok_or(BakeError::Unreadable)?;
                if count > MAX_XREF as u64 || entries.len() + count as usize > MAX_XREF {
                    return Err(BakeError::TooComplex);
                }
                for i in 0..count {
                    let position = lexer.unsigned().ok_or(BakeError::Unreadable)?;
                    let _generation = lexer.unsigned().ok_or(BakeError::Unreadable)?;
                    lexer.skip_ws();
                    let kind = lexer.word();
                    let number = u32::try_from(first + i).map_err(|_| BakeError::Unreadable)?;
                    let entry = match kind {
                        b"n" => Entry::Plain(usize::try_from(position).map_err(|_| BakeError::Unreadable)?),
                        b"f" => Entry::Free,
                        _ => return Err(BakeError::Unreadable),
                    };
                    entries.push((number, entry));
                }
            }
            let Obj::Dict(trailer) = lexer.object(0)? else {
                return Err(BakeError::Unreadable);
            };
            // A hybrid file keeps its compressed objects in a stream the
            // table names, and marks them free in the table: an object the
            // table has in use is the table's, any other the stream's.
            let mut merged: HashMap<u32, Entry> = HashMap::new();
            if let Some(stream_at) = get(&trailer, b"XRefStm").and_then(Obj::as_int) {
                let stream_at = usize::try_from(stream_at).map_err(|_| BakeError::Unreadable)?;
                let (_, packed) = self.read_xref_stream(stream_at)?;
                for (number, entry) in packed {
                    merged.entry(number).or_insert(entry);
                }
            }
            for (number, entry) in entries {
                if entry != Entry::Free || !merged.contains_key(&number) {
                    merged.insert(number, entry);
                }
            }
            for (number, entry) in merged {
                self.xref.entry(number).or_insert(entry);
            }
            if self.xref.len() > MAX_XREF {
                return Err(BakeError::TooComplex);
            }
            Ok((trailer, false))
        } else {
            let (trailer, entries) = self.read_xref_stream(offset)?;
            for (number, entry) in entries {
                self.xref.entry(number).or_insert(entry);
            }
            if self.xref.len() > MAX_XREF {
                return Err(BakeError::TooComplex);
            }
            Ok((trailer, true))
        }
    }

    /// A cross-reference stream's dictionary and entries, in its order.
    fn read_xref_stream(&mut self, offset: usize) -> Fail<(Dict, Vec<(u32, Entry)>)> {
        let (_, _, Obj::Dict(dict), Some(raw)) = self.indirect_at(offset)? else {
            return Err(BakeError::Unreadable);
        };
        if get(&dict, b"Type") != Some(&Obj::Name(b"XRef".to_vec())) {
            return Err(BakeError::Unreadable);
        }
        let data = decode(&dict, raw)?;
        let widths: Vec<usize> = match get(&dict, b"W") {
            Some(Obj::Array(items)) if items.len() == 3 => items
                .iter()
                .map(|w| w.as_int().and_then(|w| usize::try_from(w).ok()).filter(|w| *w <= 8))
                .collect::<Option<_>>()
                .ok_or(BakeError::Unreadable)?,
            _ => return Err(BakeError::Unreadable),
        };
        let size = get(&dict, b"Size").and_then(Obj::as_int).ok_or(BakeError::Unreadable)?;
        let index: Vec<i64> = match get(&dict, b"Index") {
            Some(Obj::Array(items)) => items.iter().map(Obj::as_int).collect::<Option<_>>().ok_or(BakeError::Unreadable)?,
            None => vec![0, size],
            _ => return Err(BakeError::Unreadable),
        };
        let row = widths.iter().sum::<usize>();
        if row == 0 || !index.len().is_multiple_of(2) {
            return Err(BakeError::Unreadable);
        }
        let field = |bytes: &[u8]| bytes.iter().fold(0u64, |acc, b| acc << 8 | u64::from(*b));
        let mut entries = Vec::new();
        let mut at = 0usize;
        for pair in index.chunks(2) {
            let first = u32::try_from(pair[0]).map_err(|_| BakeError::Unreadable)?;
            let count = u32::try_from(pair[1]).map_err(|_| BakeError::Unreadable)?;
            for i in 0..count {
                let Some(bytes) = data.get(at..at + row) else {
                    return Err(BakeError::Unreadable);
                };
                at += row;
                let (a, rest) = bytes.split_at(widths[0]);
                let (b, c) = rest.split_at(widths[1]);
                let kind = if widths[0] == 0 { 1 } else { field(a) };
                let entry = match kind {
                    0 => Entry::Free,
                    1 => Entry::Plain(usize::try_from(field(b)).map_err(|_| BakeError::Unreadable)?),
                    2 => Entry::Packed(
                        u32::try_from(field(b)).map_err(|_| BakeError::Unreadable)?,
                        u32::try_from(field(c)).map_err(|_| BakeError::Unreadable)?,
                    ),
                    // Reserved types read as null objects.
                    _ => Entry::Free,
                };
                let number = first.checked_add(i).ok_or(BakeError::Unreadable)?;
                if entries.len() >= MAX_XREF {
                    return Err(BakeError::TooComplex);
                }
                entries.push((number, entry));
            }
        }
        Ok((dict, entries))
    }

    /// `n g obj … endobj` at `offset`: its number, generation, value and —
    /// for a stream — the raw stream bytes.
    fn indirect_at(&mut self, offset: usize) -> Fail<(u32, u16, Obj, Option<&'a [u8]>)> {
        self.budget.spend()?;
        let body = self.body;
        let mut lexer = Lexer::new(body, offset);
        let number = lexer.unsigned().and_then(|n| u32::try_from(n).ok()).ok_or(BakeError::Unreadable)?;
        let generation = lexer.unsigned().and_then(|g| u16::try_from(g).ok()).ok_or(BakeError::Unreadable)?;
        if !lexer.keyword(b"obj") {
            return Err(BakeError::Unreadable);
        }
        let value = lexer.object(0)?;
        let Obj::Dict(dict) = &value else {
            return Ok((number, generation, value, None));
        };
        if !lexer.keyword(b"stream") {
            return Ok((number, generation, value, None));
        }
        // The keyword is followed by CRLF or LF (a lone CR is tolerated).
        let mut start = lexer.pos;
        if body.get(start) == Some(&b'\r') {
            start += 1;
        }
        if body.get(start) == Some(&b'\n') {
            start += 1;
        }
        let declared = match get(dict, b"Length") {
            Some(Obj::Int(length)) => usize::try_from(*length).ok(),
            // Read as a plain value only: a length that is itself a stream
            // with a referenced length must not recurse.
            Some(Obj::Ref(n, _)) => match self.xref.get(n).copied() {
                Some(Entry::Plain(at)) => self.plain_value_at(*n, at).ok().and_then(|l| l.as_int()).and_then(|l| usize::try_from(l).ok()),
                _ => None,
            },
            _ => None,
        };
        let fits = |length: usize| {
            let end = start.checked_add(length)?;
            let mut after = Lexer::new(body, end);
            after.keyword(b"endstream").then_some(end)
        };
        let end = match declared.and_then(fits) {
            Some(end) => end,
            // A wrong `/Length` is common enough: fall back to the keyword.
            None => {
                let rest = body.get(start..).ok_or(BakeError::Unreadable)?;
                let at = rest.windows(9).position(|w| w == b"endstream").ok_or(BakeError::Unreadable)?;
                let mut end = start + at;
                if end > start && body[end - 1] == b'\n' {
                    end -= 1;
                }
                if end > start && body[end - 1] == b'\r' {
                    end -= 1;
                }
                end
            }
        };
        Ok((number, generation, value, Some(&body[start..end])))
    }

    /// `n g obj <value>` at `offset`, without looking for a stream after it.
    fn plain_value_at(&mut self, number: u32, offset: usize) -> Fail<Obj> {
        self.budget.spend()?;
        let mut lexer = Lexer::new(self.body, offset);
        let found = lexer.unsigned().and_then(|n| u32::try_from(n).ok());
        if found != Some(number) || lexer.unsigned().is_none() || !lexer.keyword(b"obj") {
            return Err(BakeError::Unreadable);
        }
        lexer.object(0)
    }

    fn resolve_ref(&mut self, number: u32) -> Fail<Obj> {
        match self.xref.get(&number).copied() {
            None | Some(Entry::Free) => Ok(Obj::Null),
            Some(Entry::Plain(offset)) => {
                let (found, _, value, _) = self.indirect_at(offset)?;
                if found != number {
                    return Err(BakeError::Unreadable);
                }
                Ok(value)
            }
            Some(Entry::Packed(stream, index)) => self.packed(stream, index, number),
        }
    }

    fn packed(&mut self, stream: u32, index: u32, number: u32) -> Fail<Obj> {
        if !self.object_streams.contains_key(&stream) {
            let Some(Entry::Plain(offset)) = self.xref.get(&stream).copied() else {
                return Err(BakeError::Unreadable);
            };
            let (_, _, Obj::Dict(dict), Some(raw)) = self.indirect_at(offset)? else {
                return Err(BakeError::Unreadable);
            };
            let data = decode(&dict, raw)?;
            let count = get(&dict, b"N").and_then(Obj::as_int).and_then(|n| usize::try_from(n).ok()).ok_or(BakeError::Unreadable)?;
            let first = get(&dict, b"First").and_then(Obj::as_int).and_then(|n| usize::try_from(n).ok()).ok_or(BakeError::Unreadable)?;
            let mut lexer = Lexer::new(&data, 0);
            if count > data.len() / 2 + 1 {
                return Err(BakeError::Unreadable);
            }
            let mut table: Vec<(u32, usize)> = Vec::with_capacity(count.min(100_000));
            for _ in 0..count {
                let n = lexer.unsigned().and_then(|n| u32::try_from(n).ok()).ok_or(BakeError::Unreadable)?;
                let at = lexer.unsigned().and_then(|a| usize::try_from(a).ok()).ok_or(BakeError::Unreadable)?;
                let at = first.checked_add(at).ok_or(BakeError::Unreadable)?;
                // Strictly increasing: many numbers naming one huge object
                // would have it parsed again for each.
                if table.last().is_some_and(|&(_, before)| at <= before) {
                    return Err(BakeError::Unreadable);
                }
                table.push((n, at));
            }
            self.object_streams.insert(stream, (data, table));
        }
        self.budget.spend()?;
        let (data, table) = &self.object_streams[&stream];
        let index = usize::try_from(index).map_err(|_| BakeError::Unreadable)?;
        let &(found, at) = table.get(index).ok_or(BakeError::Unreadable)?;
        if found != number || at >= data.len() {
            return Err(BakeError::Unreadable);
        }
        Lexer::new(data, at).object(0)
    }

    /// `value`, or what it refers to.
    fn deref(&mut self, value: &Obj) -> Fail<Obj> {
        match value {
            Obj::Ref(number, _) => self.resolve_ref(*number),
            other => Ok(other.clone()),
        }
    }

    fn rect(&mut self, value: Option<&Obj>) -> Fail<Option<[f64; 4]>> {
        let Some(value) = value else {
            return Ok(None);
        };
        let Obj::Array(items) = self.deref(value)? else {
            return Ok(None);
        };
        if items.len() != 4 {
            return Ok(None);
        }
        let mut numbers = [0.0; 4];
        for (slot, item) in numbers.iter_mut().zip(&items) {
            match self.deref(item)?.as_num() {
                Some(v) if v.is_finite() => *slot = v,
                _ => return Ok(None),
            }
        }
        Ok(Some([
            numbers[0].min(numbers[2]),
            numbers[1].min(numbers[3]),
            numbers[0].max(numbers[2]),
            numbers[1].max(numbers[3]),
        ]))
    }

    /// Every page, in order, with what it inherits.
    fn pages(&mut self) -> Fail<Vec<Page>> {
        let root = get(&self.trailer, b"Root").cloned().ok_or(BakeError::Unreadable)?;
        let Obj::Dict(catalog) = self.deref(&root)? else {
            return Err(BakeError::Unreadable);
        };
        let Some(Obj::Ref(number, _)) = get(&catalog, b"Pages").cloned() else {
            return Err(BakeError::Unreadable);
        };
        let mut pages = Vec::new();
        let mut visited = HashSet::new();
        self.walk(number, Inherited::default(), 0, &mut visited, &mut pages)?;
        Ok(pages)
    }

    fn walk(
        &mut self,
        number: u32,
        inherited: Inherited,
        depth: usize,
        visited: &mut HashSet<u32>,
        pages: &mut Vec<Page>,
    ) -> Fail<()> {
        if depth > MAX_TREE_DEPTH || pages.len() >= MAX_PAGES || !visited.insert(number) {
            return Err(BakeError::Unreadable);
        }
        let (generation, node) = match self.xref.get(&number).copied() {
            Some(Entry::Plain(offset)) => {
                let (found, generation, value, _) = self.indirect_at(offset)?;
                if found != number {
                    return Err(BakeError::Unreadable);
                }
                (generation, value)
            }
            // Packed objects always have generation 0.
            _ => (0, self.resolve_ref(number)?),
        };
        let Obj::Dict(node) = node else {
            return Err(BakeError::Unreadable);
        };
        let mut here = inherited;
        if let Some(media) = self.rect(get(&node, b"MediaBox"))? {
            here.media = Some(media);
        }
        if let Some(crop) = self.rect(get(&node, b"CropBox"))? {
            here.crop = Some(crop);
        }
        if let Some(rotate) = get(&node, b"Rotate").cloned() {
            if let Some(turn) = self.deref(&rotate)?.as_int() {
                here.rotate = turn;
            }
        }
        let kids = match get(&node, b"Kids").cloned() {
            Some(kids) => Some(self.deref(&kids)?),
            None => None,
        };
        let is_tree = get(&node, b"Type") == Some(&Obj::Name(b"Pages".to_vec()));
        match kids {
            Some(Obj::Array(kids)) if is_tree || get(&node, b"Type").is_none() => {
                for kid in kids {
                    let Obj::Ref(kid, _) = kid else {
                        return Err(BakeError::Unreadable);
                    };
                    self.walk(kid, here, depth + 1, visited, pages)?;
                }
            }
            _ => {
                let media = here.media.unwrap_or([0.0, 0.0, 612.0, 792.0]);
                let view = match here.crop {
                    Some(crop) => {
                        let clipped = [
                            crop[0].max(media[0]),
                            crop[1].max(media[1]),
                            crop[2].min(media[2]),
                            crop[3].min(media[3]),
                        ];
                        if clipped[2] > clipped[0] && clipped[3] > clipped[1] { clipped } else { media }
                    }
                    None => media,
                };
                if view[2] - view[0] <= 0.0 || view[3] - view[1] <= 0.0 {
                    return Err(BakeError::Unreadable);
                }
                let turn = here.rotate.rem_euclid(360);
                pages.push(Page {
                    number,
                    generation,
                    dict: match &self.keep {
                        Some(keep) if !keep.contains(&(pages.len() as u32 + 1)) => Dict::new(),
                        _ => node,
                    },
                    view,
                    quarter_turns: if turn % 90 == 0 { (turn / 90) as u8 } else { 0 },
                });
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct Inherited {
    media: Option<[f64; 4]>,
    crop: Option<[f64; 4]>,
    rotate: i64,
}

// ---------------------------------------------------------------------------
// Writing

fn num(value: f64) -> String {
    if !value.is_finite() {
        return "0".into();
    }
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" || text.is_empty() { "0".into() } else { text.to_string() }
}

fn write_name(out: &mut Vec<u8>, name: &[u8]) {
    out.push(b'/');
    for &b in name {
        if (0x21..=0x7e).contains(&b) && !is_delim(b) && b != b'#' {
            out.push(b);
        } else {
            out.extend_from_slice(format!("#{b:02X}").as_bytes());
        }
    }
}

fn write_obj(out: &mut Vec<u8>, value: &Obj) {
    match value {
        Obj::Null => out.extend_from_slice(b"null"),
        Obj::Bool(v) => out.extend_from_slice(if *v { b"true" } else { b"false" }),
        Obj::Int(v) => out.extend_from_slice(v.to_string().as_bytes()),
        Obj::Real(v) => out.extend_from_slice(num(*v).as_bytes()),
        Obj::Name(name) => write_name(out, name),
        Obj::Str(bytes) => {
            out.push(b'<');
            for b in bytes {
                out.extend_from_slice(format!("{b:02X}").as_bytes());
            }
            out.push(b'>');
        }
        Obj::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b' ');
                }
                write_obj(out, item);
            }
            out.push(b']');
        }
        Obj::Dict(dict) => {
            out.extend_from_slice(b"<<");
            for (key, item) in dict {
                write_name(out, key);
                out.push(b' ');
                write_obj(out, item);
            }
            out.extend_from_slice(b">>");
        }
        Obj::Ref(n, g) => out.extend_from_slice(format!("{n} {g} R").as_bytes()),
    }
}

fn name(text: &str) -> Obj {
    Obj::Name(text.as_bytes().to_vec())
}

fn reals(values: &[f64]) -> Obj {
    Obj::Array(values.iter().map(|v| Obj::Real(*v)).collect())
}

/// UTF-16BE with its byte-order mark — how a PDF text string carries any text.
fn text_string(text: &str) -> Obj {
    let mut bytes = vec![0xfe, 0xff];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Obj::Str(bytes)
}

/// The note's characters in WinAnsiEncoding — what the appearance stream's
/// standard Helvetica can draw. Anything else is a `?` there; the full text
/// stays in the annotation's `/Contents`.
fn win_ansi(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| match c {
            ' '..='~' => c as u8,
            '\u{a0}'..='\u{ff}' => c as u32 as u8,
            '€' => 0x80,
            '‚' => 0x82,
            '„' => 0x84,
            '…' => 0x85,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '•' => 0x95,
            '–' => 0x96,
            '—' => 0x97,
            '™' => 0x99,
            _ => b'?',
        })
        .collect()
}

fn rgb(color: Color) -> [f64; 3] {
    match color {
        Color::Red => [0.86, 0.15, 0.15],
        Color::Blue => [0.15, 0.39, 0.92],
        Color::Black => [0.07, 0.07, 0.07],
        Color::Yellow => [1.0, 0.85, 0.1],
    }
}

/// Phone units → PDF user space for one page: `[a b c d e f]`, so that
/// `x' = a·x + c·y + e`, `y' = b·x + d·y + f`.
#[derive(Clone, Copy, Debug)]
struct Map([f64; 6]);

impl Map {
    fn for_page(page: &Page, phone: [f64; 2]) -> Self {
        let [x0, y0, x1, y1] = page.view;
        let (width, height) = (x1 - x0, y1 - y0);
        let turned = page.quarter_turns % 2 == 1;
        let (shown_w, shown_h) = if turned { (height, width) } else { (width, height) };
        let sx = shown_w / phone[0];
        let sy = shown_h / phone[1];
        // Displayed (dx, dy), top-left origin, to the unrotated page's own
        // top-left frame (ux, uy), then to user space.
        let to_user = |dx: f64, dy: f64| -> (f64, f64) {
            let (dx, dy) = (dx * sx, dy * sy);
            let (ux, uy) = match page.quarter_turns {
                1 => (dy, height - dx),
                2 => (width - dx, height - dy),
                3 => (width - dy, dx),
                _ => (dx, dy),
            };
            (x0 + ux, y1 - uy)
        };
        let (e, f) = to_user(0.0, 0.0);
        let (ax, ay) = to_user(1.0, 0.0);
        let (cx, cy) = to_user(0.0, 1.0);
        Map([ax - e, ay - f, cx - e, cy - f, e, f])
    }

    fn apply(&self, x: f64, y: f64) -> (f64, f64) {
        let [a, b, c, d, e, f] = self.0;
        (a * x + c * y + e, b * x + d * y + f)
    }

    /// The scale a length in phone units takes on.
    fn scale(&self) -> f64 {
        let [a, b, c, d, _, _] = self.0;
        ((a * d - b * c).abs()).sqrt()
    }

    fn cm(&self) -> String {
        self.0.iter().map(|v| num(*v)).collect::<Vec<_>>().join(" ") + " cm"
    }

    /// The user-space bounding box of a phone-space box.
    fn bounds(&self, x0: f64, y0: f64, x1: f64, y1: f64) -> [f64; 4] {
        let corners = [self.apply(x0, y0), self.apply(x1, y0), self.apply(x0, y1), self.apply(x1, y1)];
        let mut out = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
        for (x, y) in corners {
            out[0] = out[0].min(x);
            out[1] = out[1].min(y);
            out[2] = out[2].max(x);
            out[3] = out[3].max(y);
        }
        out
    }
}

/// One annotation ready to write: its dictionary (without `/AP` and `/P`),
/// its appearance's resources and content.
struct Annotation {
    dict: Dict,
    rect: [f64; 4],
    resources: Option<Obj>,
    content: String,
}

/// Text notes' line height, and how wide the bounding box assumes a
/// character is, both in multiples of the font size.
const LEADING: f64 = 1.2;
const CHAR_WIDTH: f64 = 0.72;

fn annotation(mark: &Mark, map: &Map) -> Annotation {
    match mark {
        Mark::Ink { color, width, points } => {
            let [r, g, b] = rgb(*color);
            let widest = points.iter().map(|p| ink_width(*width, p[2])).fold(0.0, f64::max);
            let pad = widest / 2.0 + 1.0;
            let (mut x0, mut y0, mut x1, mut y1) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in points {
                x0 = x0.min(p[0]);
                y0 = y0.min(p[1]);
                x1 = x1.max(p[0]);
                y1 = y1.max(p[1]);
            }
            let rect = map.bounds(x0 - pad, y0 - pad, x1 + pad, y1 + pad);
            let mut content = format!("q {} 1 J 1 j {} {} {} RG\n", map.cm(), num(r), num(g), num(b));
            for segment in ink_segments(points) {
                content.push_str(&format!("{} w {}\n", num(ink_width(*width, segment.pressure)), segment.path));
            }
            content.push_str("Q\n");
            let mut list = Vec::with_capacity(points.len() * 2);
            for p in points {
                let (x, y) = map.apply(p[0], p[1]);
                list.push(Obj::Real(x));
                list.push(Obj::Real(y));
            }
            let dict = vec![
                (b"Subtype".to_vec(), name("Ink")),
                (b"InkList".to_vec(), Obj::Array(vec![Obj::Array(list)])),
                (b"C".to_vec(), reals(&[r, g, b])),
                (
                    b"BS".to_vec(),
                    Obj::Dict(vec![(b"W".to_vec(), Obj::Real(ink_width(*width, 0.5) * map.scale()))]),
                ),
            ];
            Annotation { dict, rect, resources: None, content }
        }
        Mark::Box { color, rect: [x, y, w, h] } => {
            let [r, g, b] = rgb(*color);
            let rect = map.bounds(*x, *y, x + w, y + h);
            let content = format!(
                "q {} /G0 gs {} {} {} rg {} {} {} {} re f Q\n",
                map.cm(),
                num(r),
                num(g),
                num(b),
                num(*x),
                num(*y),
                num(*w),
                num(*h)
            );
            let corner = |cx: f64, cy: f64| {
                let (px, py) = map.apply(cx, cy);
                [Obj::Real(px), Obj::Real(py)]
            };
            let mut quad = Vec::with_capacity(8);
            for (cx, cy) in [(*x, *y), (x + w, *y), (*x, y + h), (x + w, y + h)] {
                quad.extend(corner(cx, cy));
            }
            let dict = vec![
                (b"Subtype".to_vec(), name("Highlight")),
                (b"QuadPoints".to_vec(), Obj::Array(quad)),
                (b"C".to_vec(), reals(&[r, g, b])),
            ];
            let resources = Obj::Dict(vec![(
                b"ExtGState".to_vec(),
                Obj::Dict(vec![(
                    b"G0".to_vec(),
                    Obj::Dict(vec![
                        (b"Type".to_vec(), name("ExtGState")),
                        (b"ca".to_vec(), Obj::Real(0.4)),
                        (b"BM".to_vec(), name("Multiply")),
                    ]),
                )]),
            )]);
            Annotation { dict, rect, resources: Some(resources), content }
        }
        Mark::Text { color, at: [x, y], size, text } => {
            let [r, g, b] = rgb(*color);
            let lines: Vec<&str> = text.lines().collect();
            let widest = lines.iter().map(|l| l.chars().count()).max().unwrap_or(1) as f64;
            let height = lines.len().max(1) as f64 * size * LEADING;
            let rect = map.bounds(*x, *y, x + widest * size * CHAR_WIDTH, y + height);
            let mut content = format!(
                "q {} BT /Helv {} Tf {} {} {} rg\n",
                map.cm(),
                num(*size),
                num(r),
                num(g),
                num(b)
            );
            for (i, line) in lines.iter().enumerate() {
                let baseline = y + size * (0.9 + LEADING * i as f64);
                let mut hex = String::new();
                for byte in win_ansi(line) {
                    hex.push_str(&format!("{byte:02X}"));
                }
                // The map runs y down; a flipped text matrix stands the
                // letters back up.
                content.push_str(&format!("1 0 0 -1 {} {} Tm <{hex}> Tj\n", num(*x), num(baseline)));
            }
            content.push_str("ET Q\n");
            let dict = vec![
                (b"Subtype".to_vec(), name("FreeText")),
                (b"Contents".to_vec(), text_string(text)),
                (
                    b"DA".to_vec(),
                    Obj::Str(format!("/Helv {} Tf {} {} {} rg", num(size * map.scale()), num(r), num(g), num(b)).into_bytes()),
                ),
                (b"C".to_vec(), reals(&[r, g, b])),
            ];
            let resources = Obj::Dict(vec![(
                b"Font".to_vec(),
                Obj::Dict(vec![(
                    b"Helv".to_vec(),
                    Obj::Dict(vec![
                        (b"Type".to_vec(), name("Font")),
                        (b"Subtype".to_vec(), name("Type1")),
                        (b"BaseFont".to_vec(), name("Helvetica")),
                        (b"Encoding".to_vec(), name("WinAnsiEncoding")),
                    ]),
                )]),
            )]);
            Annotation { dict, rect, resources: Some(resources), content }
        }
    }
}

/// One piece of a smoothed stroke and the pressure it is drawn at.
struct Segment {
    path: String,
    pressure: f64,
}

/// A stroke as quadratic curves through the midpoints of its samples (the
/// phone draws it the same way, `rasterize.ts`), one piece per sample so each
/// takes that sample's width.
fn ink_segments(points: &[[f64; 3]]) -> Vec<Segment> {
    let p = |i: usize| (points[i][0], points[i][1]);
    let mid = |a: (f64, f64), b: (f64, f64)| ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    let line = |a: (f64, f64), b: (f64, f64)| format!("{} {} m {} {} l S", num(a.0), num(a.1), num(b.0), num(b.1));
    match points.len() {
        0 => Vec::new(),
        1 => vec![Segment { path: line(p(0), p(0)), pressure: points[0][2] }],
        2 => vec![Segment { path: line(p(0), p(1)), pressure: (points[0][2] + points[1][2]) / 2.0 }],
        n => {
            let mut out = Vec::with_capacity(n);
            out.push(Segment { path: line(p(0), mid(p(0), p(1))), pressure: points[0][2] });
            for window in points.windows(3) {
                let [before, here, after] = [window[0], window[1], window[2]].map(|q| (q[0], q[1]));
                let start = mid(before, here);
                let control = here;
                let end = mid(here, after);
                // The quadratic's cubic twin.
                let c1 = (start.0 + 2.0 / 3.0 * (control.0 - start.0), start.1 + 2.0 / 3.0 * (control.1 - start.1));
                let c2 = (end.0 + 2.0 / 3.0 * (control.0 - end.0), end.1 + 2.0 / 3.0 * (control.1 - end.1));
                out.push(Segment {
                    path: format!(
                        "{} {} m {} {} {} {} {} {} c S",
                        num(start.0),
                        num(start.1),
                        num(c1.0),
                        num(c1.1),
                        num(c2.0),
                        num(c2.1),
                        num(end.0),
                        num(end.1)
                    ),
                    pressure: window[1][2],
                });
            }
            out.push(Segment { path: line(mid(p(n - 2), p(n - 1)), p(n - 1)), pressure: points[n - 1][2] });
            out
        }
    }
}

struct Writer {
    out: Vec<u8>,
    /// Where the source's body starts in `out` — offsets are relative to it.
    base: usize,
    written: Vec<(u32, u16, usize)>,
}

impl Writer {
    fn begin(&mut self, number: u32, generation: u16) {
        self.written.push((number, generation, self.out.len() - self.base));
        self.out.extend_from_slice(format!("{number} {generation} obj\n").as_bytes());
    }

    fn object(&mut self, number: u32, generation: u16, value: &Obj) {
        self.begin(number, generation);
        write_obj(&mut self.out, value);
        self.out.extend_from_slice(b"\nendobj\n");
    }

    fn stream(&mut self, number: u32, mut dict: Dict, data: &[u8]) {
        self.begin(number, 0);
        set(&mut dict, b"Length", Obj::Int(data.len() as i64));
        write_obj(&mut self.out, &Obj::Dict(dict));
        self.out.extend_from_slice(b"\nstream\n");
        self.out.extend_from_slice(data);
        self.out.extend_from_slice(b"\nendstream\nendobj\n");
    }
}

/// The source with every marked page's annotations appended as an
/// incremental update. Pages are 1-based; `pages` must hold at least one
/// mark each (`markup::validate`).
pub fn bake(source: &[u8], pages: &[MarkupPage]) -> Result<Vec<u8>, BakeError> {
    bake_by(source, pages, Instant::now() + BAKE_DEADLINE)
}

fn bake_by(source: &[u8], pages: &[MarkupPage], deadline: Instant) -> Result<Vec<u8>, BakeError> {
    let _allowance = AllowanceGuard::start(deadline);
    let mut doc = Doc::open(source, deadline)?;
    doc.keep = Some(pages.iter().map(|page| page.n).collect());
    let tree = doc.pages()?;
    let base = source.len() - doc.body.len();
    let mut writer = Writer { out: source.to_vec(), base, written: Vec::new() };
    if !writer.out.ends_with(b"\n") && !writer.out.ends_with(b"\r") {
        writer.out.push(b'\n');
    }
    let mut next = doc.size.max(1);
    let mut allocate = || {
        let n = next;
        next = next.saturating_add(1);
        n
    };
    for marked in pages {
        let index = usize::try_from(marked.n).ok().and_then(|n| n.checked_sub(1)).ok_or(BakeError::PageMissing)?;
        let page = tree.get(index).ok_or(BakeError::PageMissing)?;
        let map = Map::for_page(page, marked.size);
        let page_ref = Obj::Ref(page.number, page.generation);
        let mut added = Vec::with_capacity(marked.marks.len());
        for mark in &marked.marks {
            let built = annotation(mark, &map);
            let appearance = allocate();
            let annot = allocate();
            let mut form = vec![
                (b"Type".to_vec(), name("XObject")),
                (b"Subtype".to_vec(), name("Form")),
                (b"BBox".to_vec(), reals(&built.rect)),
            ];
            if let Some(resources) = built.resources {
                form.push((b"Resources".to_vec(), resources));
            }
            writer.stream(appearance, form, built.content.as_bytes());
            let mut dict = vec![(b"Type".to_vec(), name("Annot"))];
            dict.extend(built.dict);
            dict.extend([
                (b"Rect".to_vec(), reals(&built.rect)),
                (b"F".to_vec(), Obj::Int(4)),
                (b"T".to_vec(), text_string(concat!(crate::app_name!(), " Mobile"))),
                (b"P".to_vec(), page_ref.clone()),
                (b"AP".to_vec(), Obj::Dict(vec![(b"N".to_vec(), Obj::Ref(appearance, 0))])),
            ]);
            writer.object(annot, 0, &Obj::Dict(dict));
            added.push(Obj::Ref(annot, 0));
        }
        let mut annots = match get(&page.dict, b"Annots").cloned() {
            Some(existing) => match doc.deref(&existing)? {
                Obj::Array(items) => items,
                _ => Vec::new(),
            },
            None => Vec::new(),
        };
        annots.extend(added);
        let mut dict = page.dict.clone();
        set(&mut dict, b"Annots", Obj::Array(annots));
        writer.object(page.number, page.generation, &Obj::Dict(dict));
    }
    let mut trailer = Dict::new();
    for key in [&b"Root"[..], b"Info", b"ID"] {
        if let Some(value) = get(&doc.trailer, key) {
            trailer.push((key.to_vec(), value.clone()));
        }
    }
    trailer.push((b"Prev".to_vec(), Obj::Int(doc.last_xref as i64)));
    if doc.last_is_stream {
        let own = allocate();
        let start = writer.out.len() - base;
        let mut rows: Vec<(u32, u16, usize)> = writer.written.clone();
        rows.push((own, 0, start));
        rows.sort_by_key(|row| row.0);
        let mut index = Vec::with_capacity(rows.len() * 2);
        let mut data = Vec::with_capacity(rows.len() * 7);
        for &(number, generation, offset) in &rows {
            index.push(Obj::Int(i64::from(number)));
            index.push(Obj::Int(1));
            data.push(1u8);
            data.extend_from_slice(&u32::try_from(offset).map_err(|_| BakeError::TooComplex)?.to_be_bytes());
            data.extend_from_slice(&generation.to_be_bytes());
        }
        let size = rows.iter().map(|r| r.0).max().unwrap_or(own).max(doc.size.saturating_sub(1)) + 1;
        let mut dict = vec![
            (b"Type".to_vec(), name("XRef")),
            (b"Size".to_vec(), Obj::Int(i64::from(size))),
            (b"W".to_vec(), Obj::Array(vec![Obj::Int(1), Obj::Int(4), Obj::Int(2)])),
            (b"Index".to_vec(), Obj::Array(index)),
        ];
        dict.extend(trailer);
        writer.stream(own, dict, &data);
        writer.out.extend_from_slice(format!("startxref\n{start}\n%%EOF\n").as_bytes());
    } else {
        let start = writer.out.len() - base;
        let mut rows = writer.written.clone();
        rows.sort_by_key(|row| row.0);
        let mut table = String::from("xref\n");
        for &(number, generation, offset) in &rows {
            table.push_str(&format!("{number} 1\n{offset:010} {generation:05} n\r\n"));
        }
        let size = rows.iter().map(|r| r.0).max().unwrap_or(0).max(doc.size.saturating_sub(1)) + 1;
        trailer.insert(0, (b"Size".to_vec(), Obj::Int(i64::from(size))));
        writer.out.extend_from_slice(table.as_bytes());
        writer.out.extend_from_slice(b"trailer\n");
        write_obj(&mut writer.out, &Obj::Dict(trailer));
        writer.out.extend_from_slice(format!("\nstartxref\n{start}\n%%EOF\n").as_bytes());
    }
    Ok(writer.out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// A minimal classic-xref PDF: `pages` pages of `size`, each with the
    /// given `/Rotate`; page 1 optionally already carrying an annotation.
    pub(crate) fn classic_pdf(rotations: &[i64], existing_annot: bool) -> Vec<u8> {
        let mut out = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let mut offsets = Vec::new();
        let page_count = rotations.len();
        let first_page = 3;
        let annot_number = first_page + page_count as u32;
        let mut objects: Vec<String> = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".into(),
            format!(
                "<< /Type /Pages /Kids [{}] /Count {page_count} /MediaBox [0 0 600 800] >>",
                (0..page_count).map(|i| format!("{} 0 R", first_page as usize + i)).collect::<Vec<_>>().join(" ")
            ),
        ];
        for (i, rotate) in rotations.iter().enumerate() {
            let annots = if i == 0 && existing_annot { format!(" /Annots [{annot_number} 0 R]") } else { String::new() };
            objects.push(format!("<< /Type /Page /Parent 2 0 R /Rotate {rotate}{annots} >>"));
        }
        if existing_annot {
            objects.push("<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (old) >>".into());
        }
        for (i, body) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n0000000000 65535 f\r\n", objects.len() + 1).as_bytes());
        for offset in offsets {
            out.extend_from_slice(format!("{offset:010} 00000 n\r\n").as_bytes());
        }
        out.extend_from_slice(
            format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1).as_bytes(),
        );
        out
    }

    /// A PDF 1.5 file with its page objects packed in a compressed object
    /// stream and a predicted, compressed cross-reference stream.
    pub(crate) fn stream_pdf() -> Vec<u8> {
        let mut out = b"%PDF-1.5\n".to_vec();
        let catalog_at = out.len();
        out.extend_from_slice(b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
        let packed = ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] >>"];
        let mut header = String::new();
        let mut body = String::new();
        for (i, object) in packed.iter().enumerate() {
            header.push_str(&format!("{} {} ", i + 2, body.len()));
            body.push_str(object);
            body.push('\n');
        }
        let raw = format!("{header}{body}");
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(raw.as_bytes()).unwrap();
        let compressed = encoder.finish().unwrap();
        let stream_at = out.len();
        out.extend_from_slice(
            format!("4 0 obj\n<< /Type /ObjStm /N 2 /First {} /Filter /FlateDecode /Length {} >>\nstream\n", header.len(), compressed.len())
                .as_bytes(),
        );
        out.extend_from_slice(&compressed);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        let xref_at = out.len();
        // Rows: type(1) field2(2) field3(1), PNG "Up" predicted.
        let rows: Vec<[u8; 4]> = vec![
            [0, 0, 0, 0],
            [1, (catalog_at >> 8) as u8, catalog_at as u8, 0],
            [2, 0, 4, 0],
            [2, 0, 4, 1],
            [1, (stream_at >> 8) as u8, stream_at as u8, 0],
            [1, (xref_at >> 8) as u8, xref_at as u8, 0],
        ];
        let mut predicted = Vec::new();
        let mut previous = [0u8; 4];
        for row in &rows {
            predicted.push(2u8);
            for i in 0..4 {
                predicted.push(row[i].wrapping_sub(previous[i]));
            }
            previous = *row;
        }
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&predicted).unwrap();
        let compressed = encoder.finish().unwrap();
        out.extend_from_slice(
            format!(
                "5 0 obj\n<< /Type /XRef /Size 6 /W [1 2 1] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >> /Length {} >>\nstream\n",
                compressed.len()
            )
            .as_bytes(),
        );
        out.extend_from_slice(&compressed);
        out.extend_from_slice(format!("\nendstream\nendobj\nstartxref\n{xref_at}\n%%EOF\n").as_bytes());
        out
    }

    fn page(n: u32, size: [f64; 2], marks: Vec<Mark>) -> MarkupPage {
        MarkupPage { n, size, marks, layer: String::new(), composed: false, anchors: vec![] }
    }

    fn ink() -> Mark {
        Mark::Ink { color: Color::Red, width: 2.0, points: vec![[10.0, 10.0, 0.5], [20.0, 30.0, 0.7], [40.0, 35.0, 0.6]] }
    }

    fn reread(bytes: &[u8]) -> (Doc<'_>, Vec<Page>) {
        let mut doc = Doc::open(bytes, Instant::now() + BAKE_DEADLINE).expect("the copy reads back");
        let pages = doc.pages().expect("its page tree reads back");
        (doc, pages)
    }

    fn annots(doc: &mut Doc<'_>, page: &Page) -> Vec<Dict> {
        let Some(Obj::Array(items)) = get(&page.dict, b"Annots").cloned() else {
            return Vec::new();
        };
        items
            .iter()
            .map(|item| match doc.deref(item).unwrap() {
                Obj::Dict(dict) => dict,
                other => panic!("annotation is not a dict: {other:?}"),
            })
            .collect()
    }

    #[test]
    fn a_classic_file_gets_annotations_appended_and_keeps_its_bytes() {
        let source = classic_pdf(&[0, 0, 0], false);
        let text = Mark::Text { color: Color::Blue, at: [50.0, 60.0], size: 12.0, text: "use 2024\nnumbers".into() };
        let boxed = Mark::Box { color: Color::Yellow, rect: [100.0, 100.0, 200.0, 20.0] };
        let baked = bake(&source, &[page(2, [600.0, 800.0], vec![ink(), boxed, text])]).unwrap();
        assert!(baked.starts_with(&source), "the original bytes stay verbatim at the front");
        let (mut doc, pages) = reread(&baked);
        assert_eq!(pages.len(), 3);
        assert!(annots(&mut doc, &pages[0]).is_empty());
        assert!(annots(&mut doc, &pages[2]).is_empty());
        let marked = annots(&mut doc, &pages[1]);
        let kinds: Vec<_> = marked.iter().map(|a| get(a, b"Subtype").cloned()).collect();
        assert_eq!(kinds, vec![Some(name("Ink")), Some(name("Highlight")), Some(name("FreeText"))]);
        for annotation in &marked {
            let Some(Obj::Dict(ap)) = get(annotation, b"AP") else { panic!("no /AP") };
            let Some(Obj::Ref(n, _)) = get(ap, b"N") else { panic!("no /N") };
            let Some(Entry::Plain(offset)) = doc.xref.get(n).copied() else { panic!("appearance not in the xref") };
            let (_, _, Obj::Dict(form), Some(content)) = doc.indirect_at(offset).unwrap() else { panic!("appearance is not a stream") };
            assert_eq!(get(&form, b"Subtype"), Some(&name("Form")));
            assert!(!content.is_empty());
            assert_eq!(get(annotation, b"P"), Some(&Obj::Ref(pages[1].number, 0)));
        }
        let Some(Obj::Str(contents)) = get(&marked[2], b"Contents") else { panic!("no /Contents") };
        assert_eq!(&contents[..2], &[0xfe, 0xff]);
    }

    #[test]
    fn existing_annotations_are_kept() {
        let source = classic_pdf(&[0], true);
        let baked = bake(&source, &[page(1, [600.0, 800.0], vec![ink()])]).unwrap();
        let (mut doc, pages) = reread(&baked);
        let all = annots(&mut doc, &pages[0]);
        assert_eq!(all.len(), 2);
        assert_eq!(get(&all[0], b"Subtype"), Some(&name("Text")));
        assert_eq!(get(&all[1], b"Subtype"), Some(&name("Ink")));
    }

    #[test]
    fn the_phone_space_maps_through_rotate() {
        let pdf = classic_pdf(&[0, 90, 180, 270], false);
        let mut doc = Doc::open(&pdf, Instant::now() + BAKE_DEADLINE).unwrap();
        let pages = doc.pages().unwrap();
        // Unrotated 600×800: the phone's top-left is the page's top-left.
        let flat = Map::for_page(&pages[0], [600.0, 800.0]);
        assert_eq!(flat.apply(0.0, 0.0), (0.0, 800.0));
        assert_eq!(flat.apply(600.0, 800.0), (600.0, 0.0));
        // Turned a quarter clockwise the page shows 800×600; its displayed
        // top-left is the page's bottom-left corner.
        let quarter = Map::for_page(&pages[1], [800.0, 600.0]);
        assert_eq!(quarter.apply(0.0, 0.0), (0.0, 0.0));
        assert_eq!(quarter.apply(800.0, 0.0), (0.0, 800.0));
        assert_eq!(quarter.apply(0.0, 600.0), (600.0, 0.0));
        let half = Map::for_page(&pages[2], [600.0, 800.0]);
        assert_eq!(half.apply(0.0, 0.0), (600.0, 0.0));
        let three = Map::for_page(&pages[3], [800.0, 600.0]);
        assert_eq!(three.apply(0.0, 0.0), (600.0, 800.0));
        assert_eq!(three.apply(800.0, 0.0), (600.0, 0.0));
        // A phone that measured the page at half size lands on the same spot.
        let half_size = Map::for_page(&pages[0], [300.0, 400.0]);
        assert_eq!(half_size.apply(150.0, 200.0), (300.0, 400.0));
    }

    #[test]
    fn a_stream_xref_file_with_packed_pages_is_updated_in_kind() {
        let source = stream_pdf();
        let baked = bake(&source, &[page(1, [300.0, 400.0], vec![ink()])]).unwrap();
        assert!(baked.starts_with(&source));
        let tail = String::from_utf8_lossy(&baked[source.len()..]).to_string();
        assert!(tail.contains("/Type /XRef"), "{tail}");
        assert!(!tail.contains("\nxref\n"));
        let (mut doc, pages) = reread(&baked);
        assert_eq!(pages.len(), 1);
        assert_eq!(pages[0].view, [0.0, 0.0, 300.0, 400.0]);
        assert_eq!(annots(&mut doc, &pages[0]).len(), 1);
    }

    #[test]
    fn a_marked_page_past_the_end_is_refused() {
        let source = classic_pdf(&[0], false);
        assert_eq!(bake(&source, &[page(2, [600.0, 800.0], vec![ink()])]), Err(BakeError::PageMissing));
    }

    #[test]
    fn an_encrypted_file_is_refused() {
        let mut source = classic_pdf(&[0], false);
        let at = source.windows(10).rposition(|w| w == b"/Root 1 0 ").unwrap();
        source.splice(at..at, b"/Encrypt << /Filter /Standard >> ".iter().copied());
        // The trailer moved; startxref still names the table.
        assert_eq!(bake(&source, &[page(1, [600.0, 800.0], vec![ink()])]), Err(BakeError::Encrypted));
    }

    #[test]
    fn garbage_and_truncations_fail_without_panicking() {
        let marks = [page(1, [600.0, 800.0], vec![ink()])];
        assert!(bake(b"", &marks).is_err());
        assert!(bake(b"not a pdf at all", &marks).is_err());
        assert!(bake(b"%PDF-1.4\nstartxref\n999999\n%%EOF", &marks).is_err());
        let source = classic_pdf(&[0, 90], false);
        for cut in (0..source.len()).step_by(7) {
            let _ = bake(&source[..cut], &marks);
        }
        let mut corrupted = source.clone();
        for i in (0..corrupted.len()).step_by(11) {
            corrupted[i] = corrupted[i].wrapping_add(37);
            let _ = bake(&corrupted, &marks);
        }
        let stream = stream_pdf();
        for cut in (0..stream.len()).step_by(5) {
            let _ = bake(&stream[..cut], &marks);
        }
    }

    #[test]
    fn a_self_referencing_page_tree_is_refused() {
        let mut pdf = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R] /Count 1 >>\nendobj\n".to_vec();
        let second = pdf.windows(7).position(|w| w == b"2 0 obj").unwrap();
        let xref = pdf.len();
        pdf.extend_from_slice(format!("xref\n0 3\n0000000000 65535 f\r\n{:010} 00000 n\r\n{second:010} 00000 n\r\ntrailer\n<< /Size 3 /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", 9).as_bytes());
        let mut doc = Doc::open(&pdf, Instant::now() + BAKE_DEADLINE).unwrap();
        assert_eq!(doc.pages().err(), Some(BakeError::Unreadable));
        assert!(bake(&pdf, &[page(1, [600.0, 800.0], vec![ink()])]).is_err());
    }

    #[test]
    fn a_spent_deadline_gives_up() {
        let source = classic_pdf(&[0], false);
        let past = Instant::now() - Duration::from_secs(1);
        let result = bake_by(&source, &[page(1, [600.0, 800.0], vec![ink()])], past);
        // A tiny file may finish inside the 256-step check window; either way
        // nothing panics and nothing hangs.
        assert!(matches!(result, Ok(_) | Err(BakeError::TooComplex)));
    }

    #[test]
    fn a_hostile_predictor_row_is_refused_before_it_is_allocated() {
        let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&[2, 0, 0, 0]).unwrap();
        let data = encoder.finish().unwrap();
        let parms = Obj::Dict(vec![
            (b"Predictor".to_vec(), Obj::Int(12)),
            (b"Columns".to_vec(), Obj::Int(65_536)),
            (b"Colors".to_vec(), Obj::Int(65_536)),
        ]);
        let dict = vec![(b"Filter".to_vec(), name("FlateDecode")), (b"DecodeParms".to_vec(), parms)];
        assert_eq!(decode(&dict, &data), Err(BakeError::Unreadable));
    }

    #[test]
    fn a_dictionary_bomb_runs_out_of_allowance_quickly() {
        let mut bomb = b"<<".to_vec();
        for i in 0..200_000 {
            bomb.extend_from_slice(format!("/k{i} 0 ").as_bytes());
        }
        bomb.extend_from_slice(b">>");
        let started = Instant::now();
        let _guard = AllowanceGuard::start(Instant::now() + BAKE_DEADLINE);
        assert_eq!(Lexer::new(&bomb, 0).object(0), Err(BakeError::TooComplex));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        drop(_guard);
        // A passed deadline stops the parse too.
        let _late = AllowanceGuard::start(Instant::now() - Duration::from_secs(1));
        let list = format!("[{}]", "0 ".repeat(10_000));
        assert_eq!(Lexer::new(list.as_bytes(), 0).object(0), Err(BakeError::TooComplex));
    }

    #[test]
    fn an_impossible_object_count_is_refused() {
        let mut source = classic_pdf(&[0], false);
        // The trailer comes after the table, so no offset moves.
        let at = source.windows(8).rposition(|w| w == b"/Size 4 ").unwrap();
        source.splice(at..at + 8, b"/Size 4294967295 ".iter().copied());
        assert_eq!(bake(&source, &[page(1, [600.0, 800.0], vec![ink()])]), Err(BakeError::Unreadable));
    }

    #[test]
    fn names_and_strings_round_trip() {
        let value = Obj::Dict(vec![
            (b"A#B".to_vec(), Obj::Str(b"(x)\\".to_vec())),
            (b"N".to_vec(), Obj::Array(vec![Obj::Real(1.5), Obj::Int(-3), Obj::Ref(4, 0), Obj::Null, Obj::Bool(true)])),
        ]);
        let mut out = Vec::new();
        write_obj(&mut out, &value);
        assert_eq!(Lexer::new(&out, 0).object(0).unwrap(), value);
        let parsed = Lexer::new(b"(a\\(b\\)\\101\\\nc)", 0).object(0).unwrap();
        assert_eq!(parsed, Obj::Str(b"a(b)Ac".to_vec()));
    }

    #[test]
    fn text_outside_win_ansi_is_a_question_mark_in_the_appearance_only() {
        assert_eq!(win_ansi("Grüße €"), vec![b'G', b'r', 0xfc, 0xdf, b'e', b' ', 0x80]);
        assert_eq!(win_ansi("日本"), b"??".to_vec());
    }
}
