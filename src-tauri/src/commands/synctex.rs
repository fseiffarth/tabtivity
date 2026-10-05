//! Native SyncTeX reverse search: a point on a PDF page → the source line that
//! produced it, read straight out of the `.synctex(.gz)` the compile emitted.
//!
//! `synctex edit` (the CLI) answers the same question, and `commands::tex`
//! still falls back to it. But the CLI is wrong often enough to be the thing
//! users notice, and wrong in a way that hurts: it opens the **wrong `.tex`
//! file**.
//!
//! Why: pdfTeX tags each line's hbox with whatever input file was being read at
//! the moment `\par` finally fired — and for a paragraph that ends at the end of
//! an `\input`ed fragment, that is the *next* file, or the parent. So a line of
//! `intro.tex` routinely sits in a box labelled `second.tex`:
//!
//! ```text
//! ( tag6 L1  x=133.77 y=201.49 w=343.71   <- hbox says second.tex:1
//!   h tag5 L4  x=133.77                   <- the actual material: intro.tex:4
//!   x tag5 L4  x=157.84
//!   …
//!   k tag6 L1  x=477.48                   <- line-filling glue, box's own tag
//! ```
//!
//! The glyph/kern/glue **leaf** records carry the truth; the enclosing box's tag
//! is the artefact. The CLI hands back the box tag whenever the click does not
//! land squarely on a leaf — i.e. in the left margin, in a paragraph indent, or
//! in the slack after a short line — which is exactly where people click when
//! they mean "the start of this line". Measured on a three-file document, every
//! click left of the text block or right of the last word resolved to a
//! different file than the one that wrote the line.
//!
//! So this resolver distrusts the box tag and reads the leaves:
//!
//! * pick the innermost hbox for the click's **vertical** band (a click in the
//!   margin still belongs to the line beside it — horizontal distance only
//!   breaks ties between nested boxes);
//! * drop the **line fill**, the glue/kern stretched out to the right margin: it
//!   is nearer to a click in a short line's trailing slack than the last real
//!   word is, and it carries the box's tag ({@link trim_line_fill});
//! * answer with the nearest leaf that *disagrees* with the box's own
//!   `(tag, line)` **and with every enclosing box's** — a leaf merely repeating
//!   one of those is the artefact rather than material — falling back to the
//!   plain nearest leaf when every leaf agrees, which is the ordinary
//!   single-file line and resolves exactly as the CLI resolves it.
//!
//! The *enclosing* boxes matter because of a second artefact class, LuaTeX's.
//! `luaotfload` rebuilds glyph runs in a callback (kerning, ligatures, feature
//! substitution), and a node created there carries the input position at the
//! moment the callback ran — not the line that wrote the text. Under beamer
//! that moment is `\end{frame}`: the frame is boxed and its paragraphs are
//! finished when the environment closes, so a slide `\input` from another file
//! gets glyph runs tagged `main.tex:<\end{frame}>` spliced between its own
//! correctly-tagged runs, on *every* line:
//!
//! ```text
//! [ tag1 L33 …                            <- the page's vbox: main.tex, \end{frame}
//!   ( tag295 L1 x=28.35 y=55.5 w=396.9    <- block title: interpolation.tex:1 (right)
//!     x tag295 L1 x=37.5                  <- "In continuous"
//!     …
//!     k tag1  L33 x=146.1                 <- a kern from the font callback
//!     x tag1  L33 x=180.5                 <- "domains: interpolate", retagged
//!     g tag295 L1 x=311.7
//! ```
//!
//! Here the box tag is *right* and the foreign leaves are the artefact — the
//! inverse of the pdfTeX case — so "prefer the leaf that disagrees with the box"
//! chose exactly the wrong record and sent every click on that title to the
//! `\end{frame}` line of the main file. What both classes share is that the
//! artefact's `(tag, line)` is the position of some box that was being closed:
//! the line box for pdfTeX's paragraph break, an outer box (the frame, the page)
//! for a callback that ran when *it* closed. Treating every ancestor's tag as
//! an artefact tag catches both; a genuine line of material never repeats the
//! tag of a box that encloses it, because that box's line is an environment or
//! paragraph boundary, not text.
//!
//! Measured against `synctex edit` on the documents above: identical on 133 of
//! 138 clicks landing on glyphs (the five differences are all cases where the
//! CLI names the wrong file or the wrong line), and 0 wrong files against the
//! CLI's 12 on an 84-point sweep through the margins and inter-word gaps. On a
//! 55-page LuaLaTeX beamer talk, the ancestor rule changes the candidate set of
//! 207 of 10 005 line boxes, and every dropped record is a `main.tex`
//! `\end{frame}` line.
//!
//! SyncTeX records no column, so the column is always 0 (as with the CLI, which
//! reports `Column:-1` for every record pdfTeX writes).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// Scaled points per TeX point.
const SP_PER_PT: f64 = 65536.0;
/// TeX points → big points (PostScript points, 1/72 in), the unit both the
/// SyncTeX CLI and the PDF viewer speak.
const PT_PER_BP: f64 = 72.0 / 72.27;

/// One parsed SyncTeX record: a box or a leaf (glyph run, kern, glue, rule).
/// `x`/`y` are the record's origin in big points from the page's top-left — for
/// a box that is the baseline's left end, so the box spans `x..x+w` horizontally
/// and `y-h..y+d` vertically. Leaves carry only a point (`w`/`h`/`d` are 0).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Rec {
    tag: u32,
    line: u32,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    d: f64,
    /// True for a glue (`g`) or kern (`k`) record — the only two that can be the
    /// *line fill*, the stretch TeX inserts to justify a short line out to the
    /// margin. See {@link trim_line_fill}.
    elastic: bool,
}

/// A record's position may differ from a box edge by this much (big points) and
/// still count as sitting on it. Justification arithmetic is exact in scaled
/// points, so this only absorbs the rounding of the conversion.
const EDGE_EPSILON: f64 = 0.5;

/// An hbox on the page plus the leaves (and nested boxes) directly inside it.
/// Only hboxes are resolution targets: they are the *lines*, and a line is the
/// granularity reverse search answers at.
#[derive(Debug, Clone)]
struct HBox {
    rec: Rec,
    /// Nesting depth, so a nested box (a section number, a math atom) outranks
    /// the line box that contains it when both cover the click.
    depth: usize,
    /// The `(tag, line)` of every box enclosing this one, outermost first. A
    /// leaf repeating one of these is a node minted when that box closed (a
    /// LuaTeX font callback at `\end{frame}`, say) rather than material — see
    /// the module doc and {@link resolve_in_hbox}.
    ancestors: Vec<(u32, u32)>,
    /// Direct children, in emission order (left to right).
    leaves: Vec<Rec>,
}

/// The `Input:<tag>:<path>` map plus the coordinate transform from the preamble.
#[derive(Debug, Default)]
struct Preamble {
    inputs: HashMap<u32, String>,
    /// `Unit:` — a scale applied to every raw coordinate. pdfTeX writes 1.
    unit: f64,
    /// `X Offset:` / `Y Offset:`, in scaled points, added after the unit scale.
    x_offset: f64,
    y_offset: f64,
}

/// Raw scaled points → big points from the page's top-left.
fn to_bp(v: f64, unit: f64, offset: f64) -> f64 {
    (v * unit + offset) / SP_PER_PT * PT_PER_BP
}

/// Parse the input-file table and the coordinate transform.
///
/// The transform is header-only, so reading it stops at `Content:`. The input
/// table is **not**: pdfTeX writes an `Input:` record wherever a file is first
/// opened, so a chapter that starts on page 2 is declared in the middle of the
/// body. Stopping at `Content:` left every such tag unknown and reverse search
/// answering nothing at all from that page on — which looked exactly like "the
/// feature is dead here" rather than like a parse bug.
fn parse_preamble(text: &str) -> Preamble {
    let mut p = Preamble {
        unit: 1.0,
        ..Default::default()
    };
    let mut in_header = true;
    for raw in text.lines() {
        let l = raw.trim_end();
        if in_header && l.starts_with("Content:") {
            in_header = false;
        }
        if let Some(rest) = l.strip_prefix("Input:") {
            let mut it = rest.splitn(2, ':');
            let Some(tag) = it.next().and_then(|t| t.trim().parse::<u32>().ok()) else {
                continue;
            };
            let path = it.next().unwrap_or("").trim();
            if !path.is_empty() {
                p.inputs.insert(tag, path.to_string());
            }
        } else if in_header {
            // A content record can begin with any of these letters, so the
            // transform fields are only believed while still in the header.
            if let Some(v) = l.strip_prefix("Unit:") {
                if let Ok(u) = v.trim().parse::<f64>() {
                    // A zero/negative unit would collapse every coordinate to
                    // the page origin; SyncTeX's own scanner treats it as 1.
                    if u > 0.0 {
                        p.unit = u;
                    }
                }
            } else if let Some(v) = l.strip_prefix("X Offset:") {
                p.x_offset = v.trim().parse::<f64>().unwrap_or(0.0);
            } else if let Some(v) = l.strip_prefix("Y Offset:") {
                p.y_offset = v.trim().parse::<f64>().unwrap_or(0.0);
            }
        }
    }
    p
}

/// Parse one record body (everything after the leading type character):
/// `tag,line[,column]:x,y[:w,h,d]`, or `:w` for a kern. Returns None for
/// anything not shaped like a record, which is how the postamble's `Count:`
/// lines and the `!<offset>` anchors are skipped without enumerating them.
fn parse_record(body: &str, p: &Preamble, elastic: bool) -> Option<Rec> {
    let mut fields = body.split(':');
    let head = fields.next()?;
    let mut ids = head.split(',');
    let tag = ids.next()?.trim().parse::<u32>().ok()?;
    let line = ids.next()?.trim().parse::<u32>().ok()?;

    let mut pos = fields.next()?.split(',');
    let x = pos.next()?.trim().parse::<f64>().ok()?;
    let y = pos.next()?.trim().parse::<f64>().ok()?;

    // Geometry is `w,h,d` for a box/rule and a bare `w` for a kern; absent on
    // glyph/glue records.
    let (mut w, mut h, mut d) = (0.0, 0.0, 0.0);
    if let Some(geom) = fields.next() {
        let mut g = geom.split(',');
        w = g
            .next()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(0.0);
        h = g
            .next()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(0.0);
        d = g
            .next()
            .and_then(|v| v.trim().parse::<f64>().ok())
            .unwrap_or(0.0);
    }

    let scale = |v: f64| v * p.unit / SP_PER_PT * PT_PER_BP;
    Some(Rec {
        tag,
        line,
        x: to_bp(x, p.unit, p.x_offset),
        y: to_bp(y, p.unit, p.y_offset),
        w: scale(w),
        h: scale(h),
        d: scale(d),
        elastic,
    })
}

/// Collect hboxes with their direct children, each tagged with the page it sits
/// on. `only_page` restricts the walk to a single page (reverse search, which is
/// answering one click) — records on other pages are skipped and the walk returns
/// the moment that page closes, exactly as the original single-page walk did.
/// `None` collects every page (forward search, which must find where a source
/// line landed regardless of page).
///
/// Boxes nest, so this walks with a stack: `[`/`(` open, `]`/`)` close. A closed
/// box is also appended to its parent's child list, so a line box's children
/// include nested boxes (a section number, an `\hbox`) at the right position —
/// otherwise a click in the leading margin of such a line would see no leaf at
/// all. `[` (vbox) is tracked for nesting but never becomes a target: vboxes
/// span whole paragraphs and answering with one would defeat the point.
fn walk_hboxes(text: &str, p: &Preamble, only: Option<&BTreeSet<u32>>) -> Vec<(u32, HBox)> {
    let mut out: Vec<(u32, HBox)> = Vec::new();
    // (record, is_hbox, own children)
    let mut stack: Vec<(Rec, bool, Vec<Rec>)> = Vec::new();
    let mut page: u32 = 0;

    for raw in text.lines() {
        let l = raw.trim_end();
        let Some(c) = l.chars().next() else { continue };
        match c {
            '{' => {
                page = l[1..].trim().parse::<u32>().unwrap_or(0);
                stack.clear();
            }
            '}' => {
                stack.clear();
                // Reverse search wants only its pages; once the last closes there
                // is nothing left to find, so stop rather than scan the whole file.
                if only.is_some_and(|pages| pages.last() == Some(&page)) {
                    return out;
                }
            }
            // Skip record parsing entirely for a page reverse search doesn't want,
            // and for anything before the first `{` (the preamble/postamble).
            _ if only.is_some_and(|pages| !pages.contains(&page)) || page == 0 => {}
            '[' | '(' => {
                let is_h = c == '(';
                match parse_record(&l[1..], p, false) {
                    Some(rec) => stack.push((rec, is_h, Vec::new())),
                    // An unparseable opener would desynchronise the stack against
                    // its closer, so push a placeholder to keep them paired.
                    None => stack.push((
                        Rec {
                            tag: 0,
                            line: 0,
                            x: 0.0,
                            y: 0.0,
                            w: 0.0,
                            h: 0.0,
                            d: 0.0,
                            elastic: false,
                        },
                        is_h,
                        Vec::new(),
                    )),
                }
            }
            ']' | ')' => {
                let Some((rec, is_h, leaves)) = stack.pop() else {
                    continue;
                };
                if let Some(parent) = stack.last_mut() {
                    parent.2.push(rec);
                }
                if is_h && rec.line > 0 {
                    out.push((
                        page,
                        HBox {
                            rec,
                            depth: stack.len(),
                            ancestors: stack.iter().map(|(r, _, _)| (r.tag, r.line)).collect(),
                            leaves,
                        },
                    ));
                }
            }
            // Leaves: glyph run, kern, glue, math, rule, and the void boxes.
            'x' | 'k' | 'g' | '$' | 'r' | 'h' | 'v' => {
                let elastic = c == 'k' || c == 'g';
                if let (Some(rec), Some(parent)) =
                    (parse_record(&l[1..], p, elastic), stack.last_mut())
                {
                    parent.2.push(rec);
                }
            }
            _ => {}
        }
    }
    out
}

/// Every hbox on `page` with its direct children — reverse search's per-page view.
fn page_hboxes(text: &str, page: u32, p: &Preamble) -> Vec<HBox> {
    walk_hboxes(text, p, Some(&BTreeSet::from([page])))
        .into_iter()
        .filter(|(pg, _)| *pg == page)
        .map(|(_, b)| b)
        .collect()
}

/// Distance from `v` to the closed interval `lo..hi` (0 when inside).
fn interval_distance(v: f64, lo: f64, hi: f64) -> f64 {
    if v < lo {
        lo - v
    } else if v > hi {
        v - hi
    } else {
        0.0
    }
}

/// The hbox a click at `(cx, cy)` belongs to.
///
/// Ranked by **vertical** distance first: a click in the left margin, in the
/// gutter, or past the end of a short line still means "this line" — that is the
/// whole reason the CLI's answer is wrong there. Depth breaks the tie so a
/// nested box (a section number) wins over the line box enclosing it, and
/// horizontal distance breaks what remains.
fn pick_hbox(boxes: &[HBox], cx: f64, cy: f64) -> Option<&HBox> {
    boxes.iter().min_by(|a, b| {
        let key = |bx: &HBox| {
            let v = interval_distance(cy, bx.rec.y - bx.rec.h, bx.rec.y + bx.rec.d);
            let h = interval_distance(cx, bx.rec.x, bx.rec.x + bx.rec.w);
            (v, bx.depth, h)
        };
        let (av, ad, ah) = key(a);
        let (bv, bd, bh) = key(b);
        av.total_cmp(&bv)
            .then(bd.cmp(&ad)) // deeper (more specific) box wins
            .then(ah.total_cmp(&bh))
    })
}

/// Drop the *line fill* from either end of a box's children: the glue/kern TeX
/// stretches to push a short line out to the margin.
///
/// It is not material — nobody wrote it — yet it is a record like any other, it
/// carries the box's own (unreliable) tag, and it sits at the box's outer edge.
/// That last part is what makes it harmful: on a line ending halfway across the
/// measure, the fill is *nearer* to a click in the trailing slack than the last
/// real word is, so a plain nearest-record answer sends the whole right half of
/// the line to the wrong file. Only `g`/`k` records qualify, and only in a run at
/// an edge, so ordinary interword glue between words is untouched.
fn trim_line_fill<'a>(bx: &HBox, leaves: &[&'a Rec]) -> Vec<&'a Rec> {
    let right = bx.rec.x + bx.rec.w;
    let is_fill = |r: &Rec| {
        r.elastic
            && r.tag == bx.rec.tag
            && r.line == bx.rec.line
            && (r.x >= right - EDGE_EPSILON || r.x <= bx.rec.x + EDGE_EPSILON)
    };
    let Some(start) = leaves.iter().position(|r| !is_fill(r)) else {
        // Nothing but fill: keep it rather than answering with an empty box.
        return leaves.to_vec();
    };
    let end = leaves.iter().rposition(|r| !is_fill(r)).unwrap_or(start);
    leaves[start..=end].to_vec()
}

/// The source location for a click at `cx` inside `bx`: the nearest leaf that
/// says something neither the box's own tag nor any enclosing box's does.
///
/// A leaf repeating the box's exact `(tag, line)` is nearly always the artefact
/// rather than material — the line fill, or the record TeX stamps with the
/// position where `\par` fired. Preferring the leaves that *disagree* is what
/// makes a click in the margin, in a paragraph indent, or in the slack after a
/// short line resolve to the line's real author instead of to whatever file was
/// being read when the paragraph was finally broken.
///
/// The same holds one level up: a leaf repeating an *ancestor* box's tag was
/// minted when that box closed — LuaTeX's font callback re-tagging glyph runs
/// with beamer's `\end{frame}` line is the measured case — and is the artefact
/// even though it disagrees with the line box. Without this, a line whose own
/// tag is right and whose foreign leaves are the artefact resolved to the
/// artefact every time, because those were the only leaves that "disagreed".
///
/// When every leaf agrees with the box the distinction is empty and the plain
/// nearest-leaf answer stands — the ordinary single-file line, resolved exactly
/// as `synctex edit` resolves it.
fn resolve_in_hbox(bx: &HBox, cx: f64) -> (u32, u32) {
    let with_line: Vec<&Rec> = bx.leaves.iter().filter(|r| r.line > 0).collect();
    let usable = trim_line_fill(bx, &with_line);
    if usable.is_empty() {
        return (bx.rec.tag, bx.rec.line);
    }
    let is_own = |r: &Rec| r.tag == bx.rec.tag && r.line == bx.rec.line;
    // A line box is routinely wrapped in hboxes carrying its own tag (beamer's
    // block layout nests four deep), so the box's own tag is excluded here or
    // the middle layer below would never hold anything.
    let is_ancestor = |r: &Rec| {
        !is_own(r) && bx.ancestors.iter().any(|&(t, l)| r.tag == t && r.line == l)
    };
    // Layered: leaves that disagree with everything, then the box's own leaves
    // (a line whose tag is right and whose only foreign records are callback
    // artefacts — the beamer block title), then whatever is there. The middle
    // layer is what keeps the title from falling back onto the artefact once the
    // first layer is empty.
    let informative: Vec<&Rec> = usable
        .iter()
        .copied()
        .filter(|r| !is_own(r) && !is_ancestor(r))
        .collect();
    let own_only: Vec<&Rec> = usable
        .iter()
        .copied()
        .filter(|r| !is_ancestor(r))
        .collect();
    let pool = if !informative.is_empty() {
        &informative
    } else if !own_only.is_empty() {
        &own_only
    } else {
        &usable
    };

    // Nearest by horizontal distance; ties keep the earlier (left) record,
    // matching reading order.
    let chosen = pool
        .iter()
        .copied()
        .min_by(|a, b| (a.x - cx).abs().total_cmp(&(b.x - cx).abs()))
        .expect("pool is non-empty");
    (chosen.tag, chosen.line)
}

/// Absolutise (and canonicalise) an `Input:` path against the PDF's directory.
/// pdfTeX usually writes an absolute path already, but with a `./` segment in
/// the middle — which must be normalised or the result will not match the path
/// an already-open editor tab was opened under.
fn absolutise(input: &str, base: &Path) -> String {
    let p = Path::new(input);
    let abs: PathBuf = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    };
    std::fs::canonicalize(&abs)
        .unwrap_or(abs)
        .to_string_lossy()
        .into_owned()
}

/// The largest map read, compressed or inflated. A 600-page thesis writes
/// well under a tenth of this.
const MAX_MAP_BYTES: u64 = 512 * 1024 * 1024;

/// Decompressed SyncTeX text, cached against the file's path and mtime so a
/// burst of clicks on one PDF re-reads (and re-inflates) nothing. Single-entry:
/// reverse search is driven by one focused PDF at a time, and a stale megabyte
/// of a document nobody is looking at is not worth holding.
static CACHE: Mutex<Option<(PathBuf, SystemTime, std::sync::Arc<Map>)>> = Mutex::new(None);

/// A loaded map: the decompressed text plus its already-parsed header. The
/// header parse is a full scan (the input table runs into the body — see
/// {@link parse_preamble}), so it is done once per file rather than per click.
struct Map {
    text: String,
    pre: Preamble,
}

/// The SyncTeX map beside `pdf`, preferring the compressed form the engines
/// write. None when there is none — an imported PDF, or one built without
/// `-synctex=1`, simply has no reverse search.
fn map_path(pdf: &Path) -> Option<PathBuf> {
    let stem = pdf.file_stem()?.to_str()?;
    let dir = pdf.parent().unwrap_or_else(|| Path::new("."));
    let gz = dir.join(format!("{stem}.synctex.gz"));
    let plain = dir.join(format!("{stem}.synctex"));
    if gz.exists() {
        Some(gz)
    } else if plain.exists() {
        Some(plain)
    } else {
        None
    }
}

/// What reverse search can promise for a PDF right now — the answer to "why did
/// my click do nothing, or land on the wrong line", asked by the viewer before
/// it words a notice. Every field is a reason to recompile.
#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize)]
pub struct MapStatus {
    /// A `.synctex(.gz)` sits beside the PDF at all.
    pub has_map: bool,
    /// The PDF was written measurably after the map: rebuilt without
    /// `-synctex=1`, or by a tool that emits none. The map describes an earlier
    /// build and its positions no longer belong to these pages.
    pub pdf_newer_than_map: bool,
    /// Local sources the map names — the `.tex`/`.sty`/`.cls` files under the
    /// main document's directory — saved after the map was written. The lines
    /// reverse search answers with are those of the build *before* that edit.
    pub newer_sources: Vec<String>,
}

/// Two files closed by the same compile can land in either order within a
/// second; only a gap wider than this is read as "written afterwards".
const STALE_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// Extensions of inputs a person edits. The map also names every `.aux`, `.nav`
/// and `.out` the run read back, and those are rewritten *by* the compile — a
/// build that never touched a source would otherwise report itself stale.
const SOURCE_EXTS: [&str; 5] = ["tex", "sty", "cls", "ltx", "tikz"];

/// The inputs under `root` (the main document's directory) with a source
/// extension whose `mtime_of` is later than `map_mtime` by more than the grace.
/// Sorted for a stable readout. Pure over `mtime_of` so the rule is testable
/// without touching a clock.
fn stale_inputs(
    inputs: &HashMap<u32, String>,
    root: &Path,
    map_mtime: SystemTime,
    mtime_of: impl Fn(&Path) -> Option<SystemTime>,
) -> Vec<String> {
    let threshold = map_mtime + STALE_GRACE;
    let mut out: Vec<String> = inputs
        .values()
        .map(|p| absolutise(p, root))
        .filter(|abs| {
            let path = Path::new(abs);
            path.starts_with(root)
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| SOURCE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        })
        .filter(|abs| mtime_of(Path::new(abs)).is_some_and(|m| m > threshold))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Probe the map beside `pdf` ({@link MapStatus}). The map is loaded through the
/// same cache reverse search uses, so a status check after a click costs a few
/// `stat`s and no second gunzip.
pub fn status(pdf: &Path) -> MapStatus {
    let Some(path) = map_path(pdf) else {
        return MapStatus::default();
    };
    let mtime = |p: &Path| std::fs::metadata(p).ok().and_then(|m| m.modified().ok());
    let Some(map_mtime) = mtime(&path) else {
        return MapStatus {
            has_map: true,
            ..Default::default()
        };
    };
    let pdf_newer_than_map = mtime(pdf).is_some_and(|m| m > map_mtime + STALE_GRACE);
    let newer_sources = match load_map(pdf) {
        Some(map) => {
            let pdf_dir = pdf.parent().unwrap_or_else(|| Path::new("."));
            // The main document is the lowest-numbered input; its directory is
            // the tree the person edits (an out-dir build puts the PDF elsewhere).
            let root = map
                .pre
                .inputs
                .iter()
                .min_by_key(|(tag, _)| **tag)
                .map(|(_, p)| PathBuf::from(absolutise(p, pdf_dir)))
                .and_then(|main| main.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| pdf_dir.to_path_buf());
            let root = std::fs::canonicalize(&root).unwrap_or(root);
            stale_inputs(&map.pre.inputs, &root, map_mtime, mtime)
        }
        None => Vec::new(),
    };
    MapStatus {
        has_map: true,
        pdf_newer_than_map,
        newer_sources,
    }
}

/// Read the SyncTeX map beside `pdf` ({@link map_path}), through the cache.
fn load_map(pdf: &Path) -> Option<std::sync::Arc<Map>> {
    let path = map_path(pdf)?;

    let mtime = std::fs::metadata(&path).ok()?.modified().ok()?;
    if let Ok(guard) = CACHE.lock() {
        if let Some((p, m, map)) = guard.as_ref() {
            if *p == path && *m == mtime {
                return Some(map.clone());
            }
        }
    }

    // Bounded both ways: the map sits in a project folder, so a small `.gz`
    // could inflate to gigabytes. A map past the cap has no reverse search.
    use std::io::Read;
    let mut text = String::new();
    let read = if path.extension().is_some_and(|e| e == "gz") {
        let file = std::fs::File::open(&path).ok()?;
        flate2::read::GzDecoder::new(file.take(MAX_MAP_BYTES))
            .take(MAX_MAP_BYTES + 1)
            .read_to_string(&mut text)
    } else {
        std::fs::File::open(&path).ok()?.take(MAX_MAP_BYTES + 1).read_to_string(&mut text)
    };
    if read.is_err() || text.len() as u64 > MAX_MAP_BYTES {
        return None;
    }

    let pre = parse_preamble(&text);
    let map = std::sync::Arc::new(Map { text, pre });
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((path, mtime, map.clone()));
    }
    Some(map)
}

/// Reverse search `(page, x, y)` (big points from the page's top-left) in the
/// SyncTeX map beside `pdf`, as `(source path, line)`.
///
/// Returns None when there is no map, the page holds no boxes, or the winning
/// record names an input the map never declared — every one of which the caller
/// answers by falling back to the `synctex` CLI.
pub fn resolve(pdf: &Path, page: u32, x: f64, y: f64) -> Option<(String, u32)> {
    let map = load_map(pdf)?;
    let boxes = page_hboxes(&map.text, page, &map.pre);
    let bx = pick_hbox(&boxes, x, y)?;
    let (tag, line) = resolve_in_hbox(bx, x);
    if line == 0 {
        return None;
    }
    let input = map.pre.inputs.get(&tag)?;
    let dir = pdf.parent().unwrap_or_else(|| Path::new("."));
    Some((absolutise(input, dir), line))
}

/// {@link resolve} for many points on many pages, walking the map once: what a
/// markup Submit asks for every mark it sends
/// (`services::mobile_control::markup`). One answer per point, in order.
pub fn resolve_pages(pdf: &Path, points: &BTreeMap<u32, Vec<(f64, f64)>>) -> BTreeMap<u32, Vec<Option<(String, u32)>>> {
    let unanswered = || points.iter().map(|(page, list)| (*page, vec![None; list.len()])).collect();
    let Some(map) = load_map(pdf) else {
        return unanswered();
    };
    let wanted: BTreeSet<u32> = points.keys().copied().collect();
    let mut by_page: BTreeMap<u32, Vec<HBox>> = BTreeMap::new();
    for (page, bx) in walk_hboxes(&map.text, &map.pre, Some(&wanted)) {
        by_page.entry(page).or_default().push(bx);
    }
    let dir = pdf.parent().unwrap_or_else(|| Path::new("."));
    points
        .iter()
        .map(|(page, list)| {
            let boxes = by_page.get(page).map(Vec::as_slice).unwrap_or_default();
            let answers = list
                .iter()
                .map(|&(x, y)| {
                    let bx = pick_hbox(boxes, x, y)?;
                    let (tag, line) = resolve_in_hbox(bx, x);
                    if line == 0 {
                        return None;
                    }
                    Some((absolutise(map.pre.inputs.get(&tag)?, dir), line))
                })
                .collect();
            (*page, answers)
        })
        .collect()
}

/// The `Input:` tag for source file `input`, matched by **canonicalised path**
/// against the recorded table (with a basename fallback).
///
/// This is the whole reason forward search is done natively rather than by
/// shelling to `synctex view -i`: that CLI matches the `-i` argument against the
/// path string SyncTeX happened to record, so an absolute path, a `./`-prefixed
/// one, a basename or a symlinked spelling that does not match it *character for
/// character* returns nothing — which looks exactly like "SyncTeX can't find the
/// cursor" even when the caret is squarely on body text. Canonicalising both
/// sides removes that entire failure class.
fn input_tag(pre: &Preamble, input: &str, dir: &Path) -> Option<u32> {
    let target = absolutise(input, dir);
    let target_base = Path::new(input).file_name();
    let mut base_hit: Option<u32> = None;
    for (tag, path) in &pre.inputs {
        if absolutise(path, dir) == target {
            return Some(*tag); // exact canonical match — the strong signal
        }
        if target_base.is_some() && Path::new(path).file_name() == target_base {
            base_hit = Some(*tag); // last-resort: same file name in the table
        }
    }
    base_hit
}

/// Forward search: the boxes any page's `input:line` produced, as
/// `(page, x, y, w, h)` in big points from the page top-left — the same unit and
/// rect shape the CLI's `synctex view` yields, so the frontend picks the box for
/// the clicked column and narrows to the word exactly as before.
///
/// Matches the source file by canonicalised path ({@link input_tag}) and the line
/// by the **leaf** records inside each box, never the box's own `(tag, line)`:
/// that tag is the paragraph-break artefact reverse search exists to work around,
/// so a line whose material sits in a box tagged for another file (an `\input`ed
/// fragment) is found by its leaves where matching the box tag would miss it.
/// Empty when there is no map, the file is not in it, or the line produced nothing
/// — the caller then falls back to the CLI.
pub fn view(pdf: &Path, input: &str, line: u32) -> Vec<(u32, f64, f64, f64, f64)> {
    let Some(map) = load_map(pdf) else {
        return Vec::new();
    };
    let dir = pdf.parent().unwrap_or_else(|| Path::new("."));
    view_in(&map.text, &map.pre, dir, input, line)
}

/// The pure core of {@link view}, separated from the on-disk map load so it can be
/// unit-tested against a SyncTeX fixture without a real PDF.
fn view_in(
    text: &str,
    pre: &Preamble,
    dir: &Path,
    input: &str,
    line: u32,
) -> Vec<(u32, f64, f64, f64, f64)> {
    let Some(tag) = input_tag(pre, input, dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (page, bx) in walk_hboxes(text, pre, None) {
        let hit = (bx.rec.tag == tag && bx.rec.line == line)
            || bx.leaves.iter().any(|r| r.tag == tag && r.line == line);
        if hit {
            // The box spans `y - h` (top) to `y + d` (bottom); the CLI rect is the
            // top edge plus the full height.
            out.push((
                page,
                bx.rec.x,
                bx.rec.y - bx.rec.h,
                bx.rec.w,
                bx.rec.h + bx.rec.d,
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A three-file document (`main.tex` \input-ing `intro.tex` and
    /// `second.tex`), trimmed from a real `pdflatex -synctex=1` run. Note the
    /// box tags: the line of `main.tex` sits in a box labelled tag 5
    /// (`intro.tex`) and the line of `intro.tex` in a box labelled tag 6
    /// (`second.tex`) — the paragraph-breaking artefact this module exists for.
    const DOC: &str = "\
SyncTeX Version:1
Input:1:/proj/main.tex
Input:5:/proj/chapters/intro.tex
Input:6:/proj/chapters/second.tex
Output:pdf
Magnification:1000
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,7:4736286,46220574:26673152,41484288,0
(5,1:8799518,8865054:22609920,455111,0
h1,3:8799518,8865054
x1,3:11218261,8865054
g1,3:11436714,8865054
x1,3:15048556,8865054
k5,1:31409438,8865054:16251655
g5,1:31409438,8865054
)
(6,1:8799518,13224414:22609920,455111,0
h5,4:8799518,13224414
x5,4:10346127,13224414
g5,4:11167905,13224414
x5,4:15218556,13224414
k6,1:31409438,13224414:16081655
g6,1:31409438,13224414
)
}1
Postamble:
";

    /// Big points for a raw sp coordinate, so the tests read in the same unit
    /// the resolver takes.
    fn bp(sp: f64) -> f64 {
        sp / SP_PER_PT * PT_PER_BP
    }

    fn resolve_at(cx: f64, cy: f64) -> (u32, u32) {
        let pre = parse_preamble(DOC);
        let boxes = page_hboxes(DOC, 1, &pre);
        let bx = pick_hbox(&boxes, cx, cy).expect("an hbox");
        resolve_in_hbox(bx, cx)
    }

    #[test]
    fn preamble_reads_the_input_table_and_transform() {
        let p = parse_preamble(DOC);
        assert_eq!(p.inputs.get(&1).map(String::as_str), Some("/proj/main.tex"));
        assert_eq!(
            p.inputs.get(&5).map(String::as_str),
            Some("/proj/chapters/intro.tex")
        );
        assert_eq!(p.unit, 1.0);
        assert_eq!((p.x_offset, p.y_offset), (0.0, 0.0));
    }

    #[test]
    fn records_convert_scaled_points_to_big_points() {
        let p = parse_preamble(DOC);
        let r = parse_record("5,1:8799518,8865054:22609920,455111,0", &p, false).expect("a record");
        assert_eq!((r.tag, r.line), (5, 1));
        // The text block starts one inch + margin in: 133.77bp, as pdftotext
        // reports it for the same document.
        assert!((r.x - 133.77).abs() < 0.01, "x = {}", r.x);
        assert!((r.y - 134.76).abs() < 0.01, "y = {}", r.y);
        assert!((r.w - 343.71).abs() < 0.01, "w = {}", r.w);
    }

    #[test]
    fn page_walk_collects_only_hboxes_with_their_children() {
        let p = parse_preamble(DOC);
        let boxes = page_hboxes(DOC, 1, &p);
        // The two line boxes — the enclosing vbox is not a target.
        assert_eq!(boxes.len(), 2);
        assert_eq!(boxes[0].leaves.len(), 6, "h, x, g, x, k, g");
        assert_eq!((boxes[0].rec.tag, boxes[0].rec.line), (5, 1));
    }

    #[test]
    fn an_input_declared_inside_the_content_is_still_known() {
        // pdfTeX writes `Input:` where a file is first *opened*, so a chapter
        // starting on page 2 is declared in the middle of the body. Missing it
        // left every tag from that page on unresolvable — reverse search
        // answering nothing at all from page 2 onwards.
        const LATE: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,3:8799518,8865054:22609920,455111,0
x1,3:11218261,8865054
)
}1
Input:6:/proj/ch/b.tex
{2
(1,4:8799518,8865054:22609920,455111,0
x6,2:11218261,8865054
)
}2
";
        let p = parse_preamble(LATE);
        assert_eq!(p.inputs.get(&6).map(String::as_str), Some("/proj/ch/b.tex"));
        let boxes = page_hboxes(LATE, 2, &p);
        let bx = pick_hbox(&boxes, bp(11218261.0), bp(8865054.0)).expect("an hbox");
        assert_eq!(resolve_in_hbox(bx, bp(11218261.0)), (6, 2));
    }

    #[test]
    fn a_content_record_cannot_be_read_as_a_transform_field() {
        // `x`/`v`/`k` records live in the body and none of them may be mistaken
        // for a header field, whatever they happen to start with.
        const BODY: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,3:8799518,8865054:22609920,455111,0
x1,3:11218261,8865054
)
}1
";
        let p = parse_preamble(BODY);
        assert_eq!(p.unit, 1.0);
        assert_eq!((p.x_offset, p.y_offset), (0.0, 0.0));
    }

    #[test]
    fn other_pages_are_not_searched() {
        let p = parse_preamble(DOC);
        assert!(page_hboxes(DOC, 2, &p).is_empty());
    }

    #[test]
    fn a_click_on_the_text_resolves_to_the_line_that_wrote_it() {
        // Mid-line, on the glyph records: tag 1 = main.tex, line 3.
        assert_eq!(resolve_at(bp(11436714.0), bp(8865054.0)), (1, 3));
        // The second line's material is intro.tex line 4.
        assert_eq!(resolve_at(bp(11167905.0), bp(13224414.0)), (5, 4));
    }

    #[test]
    fn a_click_in_the_left_margin_keeps_the_lines_own_file() {
        // Left of the text block entirely — where `synctex edit` hands back the
        // box tag and sends the jump into the wrong file.
        assert_eq!(resolve_at(20.0, bp(8865054.0)), (1, 3), "main.tex's line");
        assert_eq!(resolve_at(20.0, bp(13224414.0)), (5, 4), "intro.tex's line");
    }

    #[test]
    fn a_click_past_the_last_word_keeps_the_lines_own_file() {
        // Right of the last glyph, over the line-filling glue that carries the
        // box's own (wrong) tag.
        assert_eq!(resolve_at(500.0, bp(8865054.0)), (1, 3));
        assert_eq!(resolve_at(500.0, bp(13224414.0)), (5, 4));
    }

    #[test]
    fn the_line_fill_never_wins_on_distance() {
        // The trailing k/g pair sits at the box's right edge (477.48bp) carrying
        // the box's own tag, while the last real word ends near 229bp. A click in
        // between is *closer* to the fill — taking it would resolve the whole
        // right half of every short line to the wrong file.
        let p = parse_preamble(DOC);
        let boxes = page_hboxes(DOC, 1, &p);
        let bx = &boxes[0];
        let trimmed = trim_line_fill(bx, &bx.leaves.iter().collect::<Vec<_>>());
        assert_eq!(
            trimmed.len(),
            4,
            "the k/g fill is dropped, the four glyph records stay"
        );
        assert!(trimmed.iter().all(|r| r.tag == 1));
        assert_eq!(resolve_at(400.0, bp(8865054.0)), (1, 3));
    }

    #[test]
    fn interword_glue_inside_a_line_survives_the_trim() {
        // Only a run at an *edge* is fill; the glue between words sits mid-line
        // and is ordinary material.
        let p = parse_preamble(DOC);
        let boxes = page_hboxes(DOC, 1, &p);
        let trimmed = trim_line_fill(&boxes[0], &boxes[0].leaves.iter().collect::<Vec<_>>());
        assert!(
            trimmed.iter().any(|r| r.elastic),
            "the interword glue is still there"
        );
    }

    #[test]
    fn a_click_between_the_lines_takes_the_nearer_one() {
        let first = bp(8865054.0);
        let second = bp(13224414.0);
        let gap = (first + second) / 2.0;
        assert_eq!(resolve_at(bp(11436714.0), first + (gap - first) * 0.4).0, 1);
        assert_eq!(
            resolve_at(bp(11436714.0), second - (second - gap) * 0.4).0,
            5
        );
    }

    #[test]
    fn a_box_whose_tag_matches_every_leaf_still_answers() {
        // No leaf disagrees with the box, so the skip finds nothing and the
        // nearest-leaf answer stands rather than yielding nothing.
        const UNIFORM: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,9:8799518,8865054:22609920,455111,0
x1,9:11218261,8865054
g1,9:11436714,8865054
)
}1
";
        let p = parse_preamble(UNIFORM);
        let boxes = page_hboxes(UNIFORM, 1, &p);
        let bx = pick_hbox(&boxes, 20.0, bp(8865054.0)).expect("an hbox");
        assert_eq!(resolve_in_hbox(bx, 20.0), (1, 9));
        assert_eq!(resolve_in_hbox(bx, 500.0), (1, 9));
    }

    #[test]
    fn an_empty_box_falls_back_to_its_own_tag() {
        let bx = HBox {
            rec: Rec {
                tag: 3,
                line: 12,
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 10.0,
                d: 0.0,
                elastic: false,
            },
            depth: 1,
            ancestors: Vec::new(),
            leaves: Vec::new(),
        };
        assert_eq!(resolve_in_hbox(&bx, 50.0), (3, 12));
    }

    #[test]
    fn a_nested_box_outranks_the_line_that_holds_it() {
        // A section number set in its own hbox inside the line box: a click on
        // the number must answer with the number's record, not the line's.
        const NESTED: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,20:8799518,8865054:22609920,455111,0
(1,21:8799518,8865054:1592523,455111,0
g1,21:8799518,8865054
)
x1,20:15048556,8865054
)
}1
";
        let p = parse_preamble(NESTED);
        let boxes = page_hboxes(NESTED, 1, &p);
        assert_eq!(boxes.len(), 2);
        let bx = pick_hbox(&boxes, bp(9000000.0), bp(8865054.0)).expect("an hbox");
        assert_eq!(
            bx.rec.line, 21,
            "the inner box wins where it covers the click"
        );
    }

    #[test]
    fn malformed_records_do_not_desynchronise_the_box_stack() {
        const BROKEN: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(nonsense
)
(1,4:8799518,8865054:22609920,455111,0
x1,4:11218261,8865054
)
}1
";
        let p = parse_preamble(BROKEN);
        let boxes = page_hboxes(BROKEN, 1, &p);
        assert_eq!(boxes.len(), 1);
        assert_eq!(boxes[0].rec.line, 4);
    }

    #[test]
    fn forward_matches_the_input_file_by_path_not_by_spelling() {
        // The whole point of native forward search: `input_tag` finds the file
        // whatever spelling the caller passes, where the CLI's `-i` would need a
        // character-for-character match against the recorded string.
        let p = parse_preamble(DOC);
        let dir = Path::new("/proj");
        // Exact recorded spelling.
        assert_eq!(input_tag(&p, "/proj/main.tex", dir), Some(1));
        // A relative spelling resolved against the PDF dir → same file.
        assert_eq!(input_tag(&p, "chapters/intro.tex", dir), Some(5));
        // A bare basename still resolves via the fallback.
        assert_eq!(input_tag(&p, "second.tex", dir), Some(6));
        // A file the document never included is not invented.
        assert_eq!(input_tag(&p, "/proj/nope.tex", dir), None);
    }

    #[test]
    fn forward_finds_a_lines_boxes_by_its_leaves_not_the_box_tag() {
        // main.tex (tag 1) line 3's material sits in a box the paragraph break
        // labelled tag 5 — matching the box tag would miss it, matching the leaves
        // finds it. This is the exact failure reverse search documents, applied to
        // the forward direction.
        let p = parse_preamble(DOC);
        let dir = Path::new("/proj");
        let rects = view_in(DOC, &p, dir, "/proj/main.tex", 3);
        assert_eq!(rects.len(), 1, "one box on one page: {rects:?}");
        let (page, x, _y, w, _h) = rects[0];
        assert_eq!(page, 1);
        // The enclosing line box's own geometry (left edge 133.77bp, width 343.71).
        assert!((x - 133.77).abs() < 0.01, "x = {x}");
        assert!((w - 343.71).abs() < 0.01, "w = {w}");

        // intro.tex (tag 5) line 4 is in the SECOND line box (tag 6).
        let intro = view_in(DOC, &p, dir, "/proj/chapters/intro.tex", 4);
        assert_eq!(intro.len(), 1, "{intro:?}");
        assert_eq!(intro[0].0, 1);

        // A line the document never set produces nothing (→ caller keeps the PDF
        // where it is, no false jump).
        assert!(view_in(DOC, &p, dir, "/proj/main.tex", 999).is_empty());
        // An unknown file produces nothing rather than a wrong box.
        assert!(view_in(DOC, &p, dir, "/proj/ghost.tex", 3).is_empty());
    }

    #[test]
    fn forward_spans_every_page_a_line_landed_on() {
        // A source line can produce boxes on more than one page (an overlay, a line
        // that reflows across a page break); forward search must return them all,
        // which is why it walks every page rather than stopping at the first.
        const TWO_PAGE: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
(1,5:8799518,8865054:22609920,455111,0
x1,5:11218261,8865054
)
}1
{2
(1,5:8799518,8865054:22609920,455111,0
x1,5:11218261,8865054
)
}2
";
        let p = parse_preamble(TWO_PAGE);
        let dir = Path::new("/proj");
        let rects = view_in(TWO_PAGE, &p, dir, "/proj/main.tex", 5);
        assert_eq!(rects.len(), 2, "one box per page: {rects:?}");
        assert_eq!(rects[0].0, 1);
        assert_eq!(rects[1].0, 2);
    }

    /// One slide of a LuaLaTeX beamer talk, trimmed from a real run: `main.tex`
    /// (tag 1) `\input`s `slides/interpolation.tex` (tag 295) inside a frame that
    /// closes on line 33. The page vbox carries `(1, 33)`; the line boxes carry
    /// the slide's own file, and among their correctly-tagged glyph runs sit
    /// kern + glyph records tagged `(1, 33)` — nodes luaotfload minted when the
    /// frame closed. The first line's box tag is right (line 1); the second's is
    /// the paragraph-break artefact (line 3 for line 2's text), so both artefact
    /// classes are on one page.
    const LUATEX: &str = "\
SyncTeX Version:1
Input:1:/proj/main.tex
Input:295:/proj/slides/interpolation.tex
Output:pdf
Unit:1
X Offset:0
Y Offset:0
Content:
{7
[1,33:4718592,4718592:23146168,12000000,0
[295,16:1857863,2831155:26011770,6277000,0
(295,1:1857863,3637000:26011770,544000,150000
[295,1:1857863,3093000:26011770,544000,150000
(295,1:1857863,3637000:26011770,544000,150000
h295,1:1857863,3637000
x295,1:2457000,3637000
g295,1:2713000,3637000
x295,1:3834000,3637000
x295,1:4686000,3637000
k1,33:9573000,3637000:19660
x1,33:11829000,3637000
x1,33:12989000,3637000
g295,1:20428000,3637000
g295,1:27869633,3637000
)
]
)
(295,3:1857863,4673000:26011770,458000,137000
h295,2:1857863,4673000
x295,2:2477000,4673000
k1,33:1857863,4673000:-19660
x1,33:3244000,4673000
g295,2:3460000,4673000
x295,2:4326000,4673000
g295,2:4542000,4673000
x295,2:6620000,4673000
k1,33:4542000,4673000:19660
x1,33:8645000,4673000
x1,33:8881000,4673000
x1,33:9307000,4673000
g295,2:10422000,4673000
x295,2:10658000,4673000
g295,3:25950000,4673000
g295,3:27869633,4673000
)
]
]
}7
";

    fn resolve_luatex(cx: f64, cy: f64) -> (u32, u32) {
        let pre = parse_preamble(LUATEX);
        let boxes = page_hboxes(LUATEX, 7, &pre);
        let bx = pick_hbox(&boxes, cx, cy).expect("an hbox");
        resolve_in_hbox(bx, cx)
    }

    #[test]
    fn ancestors_are_recorded_outermost_first() {
        let pre = parse_preamble(LUATEX);
        let boxes = page_hboxes(LUATEX, 7, &pre);
        assert_eq!(boxes.len(), 3, "the title's inner and wrapper hbox, the body line");
        // Innermost first in emission order (a box is pushed when it closes).
        assert_eq!(boxes[0].ancestors, vec![(1, 33), (295, 16), (295, 1), (295, 1)]);
        assert_eq!(boxes[1].ancestors, vec![(1, 33), (295, 16)]);
        // The pdfTeX fixture: both line boxes sit directly in the page vbox.
        let pre = parse_preamble(DOC);
        let boxes = page_hboxes(DOC, 1, &pre);
        assert_eq!(boxes[0].ancestors, vec![(1, 7)]);
    }

    #[test]
    fn a_leaf_retagged_by_the_font_callback_never_wins() {
        // The block title: the box is right (interpolation.tex:1) and the only
        // leaves that disagree with it are the `(1, 33)` artefacts — under the
        // box-only rule those were the *preferred* pool, so every click on the
        // title went to main.tex's `\end{frame}`. Sweep the whole line.
        let title = bp(3637000.0);
        for cx in [20.0, bp(2457000.0), bp(9573000.0), bp(11829000.0), bp(12989000.0), 300.0, 500.0]
        {
            assert_eq!(resolve_luatex(cx, title), (295, 1), "x = {cx}");
        }
        // The body line: box tag is the paragraph-break artefact (line 3), the
        // material is line 2, and the `(1, 33)` runs are spliced between its
        // words. A click on one of those runs used to be a coin flip.
        let body = bp(4673000.0);
        for cx in [20.0, bp(2477000.0), bp(3244000.0), bp(8645000.0), bp(9307000.0), 400.0, 500.0]
        {
            assert_eq!(resolve_luatex(cx, body), (295, 2), "x = {cx}");
        }
    }

    #[test]
    fn an_ancestor_tag_is_still_the_answer_when_it_is_all_there_is() {
        // Beamer's own chrome (a footline typeset by the template) has nothing
        // but the frame's own tag in it; dropping every leaf must not answer
        // nothing, it falls back to the plain nearest leaf.
        const CHROME: &str = "\
Input:1:/proj/main.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,33:0,0:23146168,12000000,0
(1,33:1857863,3637000:26011770,544000,150000
x1,33:2457000,3637000
x1,33:3834000,3637000
)
]
}1
";
        let pre = parse_preamble(CHROME);
        let boxes = page_hboxes(CHROME, 1, &pre);
        let bx = pick_hbox(&boxes, bp(3000000.0), bp(3637000.0)).expect("an hbox");
        assert_eq!(resolve_in_hbox(bx, bp(3000000.0)), (1, 33));
    }

    #[test]
    fn stale_inputs_reports_only_edited_local_sources() {
        use std::time::Duration;
        let t0 = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000);
        let mut inputs = HashMap::new();
        inputs.insert(1, "/proj/./main.tex".to_string());
        inputs.insert(2, "/usr/share/texmf/beamer.cls".to_string());
        inputs.insert(3, "/proj/slides/idea.tex".to_string());
        inputs.insert(4, "/proj/main.aux".to_string());
        inputs.insert(5, "/proj/theme.sty".to_string());
        let mtimes: HashMap<&str, SystemTime> = HashMap::from([
            ("/proj/main.tex", t0 + Duration::from_secs(1)), // within the grace: same build
            ("/usr/share/texmf/beamer.cls", t0 + Duration::from_secs(600)), // not local
            ("/proj/slides/idea.tex", t0 + Duration::from_secs(60)), // edited after
            ("/proj/main.aux", t0 + Duration::from_secs(60)), // generated, not a source
            ("/proj/theme.sty", t0 - Duration::from_secs(60)), // older: fine
        ]);
        let got = stale_inputs(&inputs, Path::new("/proj"), t0, |p| {
            mtimes.get(p.to_str().unwrap()).copied()
        });
        assert_eq!(got, vec!["/proj/slides/idea.tex".to_string()]);
        // A file the stat cannot see is not reported as stale.
        let got = stale_inputs(&inputs, Path::new("/proj"), t0, |_| None);
        assert!(got.is_empty());
    }

    #[test]
    fn status_reads_the_files_beside_the_pdf() {
        use std::fs::File;
        use std::io::Write;
        use std::time::Duration;
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let pdf = root.join("main.pdf");

        // No map at all: nothing can be promised.
        File::create(&pdf).expect("pdf");
        assert_eq!(status(&pdf), MapStatus::default());

        // A map naming a local source and a system class.
        std::fs::create_dir(root.join("slides")).expect("slides dir");
        let slide = root.join("slides/idea.tex");
        let main = root.join("main.tex");
        File::create(&slide).expect("slide");
        File::create(&main).expect("main");
        let map = root.join("main.synctex");
        writeln!(
            File::create(&map).expect("map"),
            "SyncTeX Version:1\nInput:1:{}\nInput:2:/usr/share/texmf/beamer.cls\nInput:3:{}\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{{1\n}}1\n",
            main.display(),
            slide.display()
        )
        .expect("write map");

        let t0 = SystemTime::now() - Duration::from_secs(3600);
        let set = |p: &Path, t: SystemTime| {
            File::options()
                .write(true)
                .open(p)
                .expect("open")
                .set_modified(t)
                .expect("set mtime")
        };
        set(&map, t0);
        set(&pdf, t0);
        set(&main, t0 - Duration::from_secs(10));
        set(&slide, t0 - Duration::from_secs(10));
        assert_eq!(
            status(&pdf),
            MapStatus {
                has_map: true,
                pdf_newer_than_map: false,
                newer_sources: vec![],
            }
        );

        // The slide is saved after the build: reported, by canonical path.
        set(&slide, t0 + Duration::from_secs(120));
        let st = status(&pdf);
        assert_eq!(st.newer_sources, vec![slide.to_string_lossy().into_owned()]);
        assert!(!st.pdf_newer_than_map);

        // The PDF rebuilt without a map: the map is the older build's.
        set(&pdf, t0 + Duration::from_secs(120));
        assert!(status(&pdf).pdf_newer_than_map);
    }

    #[test]
    fn unit_and_offset_shift_every_coordinate() {
        const SHIFTED: &str = "\
Input:1:/proj/main.tex
Unit:2
X Offset:65536
Y Offset:0
Content:
{1
(1,4:1000000,2000000:100000,10000,0
)
}1
";
        let p = parse_preamble(SHIFTED);
        assert_eq!(p.unit, 2.0);
        let r = parse_record("1,4:1000000,2000000:100000,10000,0", &p, false).expect("a record");
        assert!((r.x - to_bp(1000000.0, 2.0, 65536.0)).abs() < 1e-9);
        // The offset applies to the origin, never to a width.
        assert!((r.w - 100000.0 * 2.0 / SP_PER_PT * PT_PER_BP).abs() < 1e-9);
    }
}
