//! SyncTeX, read natively out of the `.synctex(.gz)` the compile emitted (every
//! compile passes `-synctex=1`): reverse search (a point on a PDF page → the
//! source line that produced it), forward search (a source line → the boxes it
//! produced), the deck's page → source-line anchors, and the map's freshness.
//! The `synctex_*` commands (`commands::synctex`) are thin wrappers over
//! this engine, moved down from there (S5).
//!
//! The `synctex` CLI is not used in either direction. It answers both
//! questions, but it is wrong often enough to be the thing users notice, and
//! wrong in a way that hurts: it opens the **wrong `.tex` file**.
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
//! Forward search reads the same leaves the other way round ({@link view_in}):
//! a line is found by the boxes whose *material* came from it, never by a box's
//! own tag, and a line that set nothing (a comment, a blank line, the preamble)
//! takes the nearest line of the same file that did. It never answers with a
//! box whose material belongs to another file.
//!
//! SyncTeX records no column, so reverse search answers with a line only.
//!
//! Paths come back in the caller's spelling: the engine records its physical
//! working directory, so on a symlinked project the map names the resolved
//! tree, and a path from it would not match the tab already open on the
//! project's own spelling ({@link Spelling}).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

use serde::Serialize;

/// Scaled points per TeX point.
const SP_PER_PT: f64 = 65536.0;
/// TeX points → big points (PostScript points, 1/72 in), the unit the PDF
/// viewer speaks.
const PT_PER_BP: f64 = 72.0 / 72.27;

/// A source location returned by reverse search (`synctex_edit`): the input
/// `.tex` file and the 1-based line that produced a clicked PDF point.
#[derive(Debug, Clone, Serialize)]
pub struct SyncSource {
    /// Absolute path to the source file, spelled through the caller's
    /// spelling of the PDF's folder or an ancestor of it ({@link Spelling}).
    pub input: String,
    /// 1-based source line. There is no column: SyncTeX records none.
    pub line: u32,
}

/// A PDF rectangle returned by forward search (`synctex_view`): the page and a
/// box (big points, 72 dpi, origin at the page's top-left) the viewer can
/// scroll to and highlight.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct SyncRect {
    /// 1-based PDF page.
    pub page: u32,
    /// Left edge in big points from the page's top-left.
    pub x: f64,
    /// Top edge in big points from the page's top-left.
    pub y: f64,
    /// Box width in big points.
    pub w: f64,
    /// Box height in big points.
    pub h: f64,
}

/// One parsed SyncTeX record: a box or a leaf (glyph run, kern, glue, rule).
/// `x`/`y` are the record's origin in big points from the page's top-left — for
/// a box that is the baseline's left end, so the box spans `x..x+w` horizontally
/// and `y-h..y+d` vertically. Leaves carry only a point (`w`/`h`/`d` are 0).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
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
    /// True for a nested box's own record in its parent's child list. Reverse
    /// search keeps it there (a click in the margin beside a section number must
    /// see something); forward search does not count it as the parent's
    /// material, since the nested box is matched on its own.
    is_box: bool,
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
    /// Byte offset of each page's `{N` line in the text this was parsed from
    /// (the first, should a number repeat), so reverse search starts at its page
    /// instead of reading every earlier one — see {@link each_hbox}.
    pages: BTreeMap<u32, usize>,
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
    let mut at = 0usize;
    // Every line, with its own terminator, so `at` is its byte offset in `text`
    // without a second scan. `trim_end` drops the terminator again.
    for raw in text.split_inclusive('\n') {
        let line_at = at;
        at += raw.len();
        let l = raw.trim_end();
        if in_header && l.starts_with("Content:") {
            in_header = false;
        }
        if let Some(page) = l.strip_prefix('{').and_then(|n| n.trim().parse::<u32>().ok()) {
            p.pages.entry(page).or_insert(line_at);
        } else if let Some(rest) = l.strip_prefix("Input:") {
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
    let mut geom = fields
        .next()
        .into_iter()
        .flat_map(|g| g.split(','))
        .map(|v| v.trim().parse::<f64>().unwrap_or(0.0));
    let mut size = || to_bp(geom.next().unwrap_or(0.0), p.unit, 0.0);
    let (w, h, d) = (size(), size(), size());

    Some(Rec {
        tag,
        line,
        x: to_bp(x, p.unit, p.x_offset),
        y: to_bp(y, p.unit, p.y_offset),
        w,
        h,
        d,
        elastic,
        is_box: false,
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
    each_hbox(text, p, only, |page, bx| out.push((page, bx)));
    out
}

/// {@link walk_hboxes}, handing each box to `emit` as it closes instead of
/// collecting them: forward search keeps a digest of every box of the document
/// ({@link LineBox}) and has no use for all of them at once.
fn each_hbox(text: &str, p: &Preamble, only: Option<&BTreeSet<u32>>, mut emit: impl FnMut(u32, HBox)) {
    // (record, is_hbox, own children)
    let mut stack: Vec<(Rec, bool, Vec<Rec>)> = Vec::new();
    let mut page: u32 = 0;

    // Reverse search starts where its first page opens: on a long document the
    // pages before it are most of the map, and every line of them would only be
    // read to be skipped. Nothing else about the walk changes, since each page
    // opens with a `{` that resets the state.
    let from = only.and_then(|pages| walk_start(text, p, pages)).unwrap_or(0);
    for raw in text[from..].lines() {
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
                    return;
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
                    None => stack.push((Rec::default(), is_h, Vec::new())),
                }
            }
            ']' | ')' => {
                let Some((rec, is_h, leaves)) = stack.pop() else {
                    continue;
                };
                if let Some(parent) = stack.last_mut() {
                    parent.2.push(Rec { is_box: true, ..rec });
                }
                if is_h && rec.line > 0 {
                    emit(
                        page,
                        HBox {
                            rec,
                            depth: stack.len(),
                            ancestors: stack.iter().map(|(r, _, _)| (r.tag, r.line)).collect(),
                            leaves,
                        },
                    );
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
}

/// Where `each_hbox` may begin for `pages`: the earliest of their page-open lines,
/// or None to walk from the top. Each recorded offset is checked against `text`
/// (a line start, holding that very `{N`), because a {@link Preamble} and a text
/// are not always from the same read; one page without a usable offset means the
/// old whole-file walk rather than a guess.
fn walk_start(text: &str, p: &Preamble, pages: &BTreeSet<u32>) -> Option<usize> {
    let mut start: Option<usize> = None;
    for page in pages {
        let at = *p.pages.get(page)?;
        let rest = text.get(at..)?;
        let opens = (at == 0 || text.as_bytes()[at - 1] == b'\n')
            && rest
                .lines()
                .next()
                .and_then(|l| l.trim_end().strip_prefix('{'))
                .is_some_and(|n| n.trim().parse::<u32>() == Ok(*page));
        if !opens {
            return None;
        }
        start = Some(start.map_or(at, |s| s.min(at)));
    }
    start
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

/// True when the vertical span `outer` (top, bottom) holds two of `inner` that
/// do not overlap each other vertically: a block of lines, not a line.
fn spans_lines(outer: (f64, f64), inner: impl Iterator<Item = (f64, f64)>) -> bool {
    let mut lowest_bottom = f64::INFINITY;
    let mut highest_top = f64::NEG_INFINITY;
    for (top, bottom) in inner {
        if top >= outer.0 - EDGE_EPSILON && bottom <= outer.1 + EDGE_EPSILON {
            lowest_bottom = lowest_bottom.min(bottom);
            highest_top = highest_top.max(top);
        }
    }
    lowest_bottom < highest_top - EDGE_EPSILON
}

/// `boxes` without the page backgrounds a beamer theme lays under a frame:
/// full-height boxes nested deeper than the text, which win {@link pick_hbox}
/// for any click on the page (vertical distance 0, more depth) and answer
/// `\end{frame}`. A background is page chrome ({@link is_chrome}) with nothing
/// but its own tag in it, spanning several lines ({@link spans_lines}). Kept
/// when nothing else is left — a frame whose every record is `\end{frame}`'s.
fn drop_backgrounds(boxes: Vec<HBox>) -> Vec<HBox> {
    let span = |bx: &HBox| (bx.rec.y - bx.rec.h, bx.rec.y + bx.rec.d);
    let background: Vec<bool> = boxes
        .iter()
        .enumerate()
        .map(|(i, bx)| {
            let own = (bx.rec.tag, bx.rec.line);
            is_chrome(bx)
                && material(bx, true).iter().all(|tl| *tl == own)
                && spans_lines(
                    span(bx),
                    boxes.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, o)| span(o)),
                )
        })
        .collect();
    if background.iter().all(|b| *b) {
        return boxes;
    }
    boxes
        .into_iter()
        .zip(background)
        .filter(|(_, b)| !b)
        .map(|(bx, _)| bx)
        .collect()
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

/// True when `r` repeats the `(tag, line)` of a box enclosing `bx` (and not
/// `bx`'s own): a node minted when that box closed, not material.
fn is_ancestor_artefact(bx: &HBox, r: &Rec) -> bool {
    let own = r.tag == bx.rec.tag && r.line == bx.rec.line;
    !own && bx.ancestors.iter().any(|&(t, l)| r.tag == t && r.line == l)
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
    let is_ancestor = |r: &Rec| is_ancestor_artefact(bx, r);
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

/// The caller's spelling of a directory (the PDF's) and of each of its
/// ancestors, next to their canonical forms.
///
/// The engine records the path of every input under its *physical* working
/// directory, so on a project reached through a symlink the map names the
/// resolved tree. Canonicalising alone would hand that resolved spelling to the
/// frontend, where it matches neither the open editor tab (a duplicate tab
/// opens) nor the project root the markup prompt strips. So a recorded path is
/// canonicalised and then *re-rooted*: under the deepest ancestor whose
/// canonical form prefixes it, it is spelled through that ancestor as the
/// caller spelled it. A lexical cleanup would not do, since the `./` pdfTeX
/// writes is the least of it.
struct Spelling {
    base: PathBuf,
    /// `(as spelled, canonical)`, deepest first.
    roots: Vec<(PathBuf, PathBuf)>,
}

/// A path that names another machine: two leading separators of either kind
/// (`\\server\share`, `//server/share`, `\\.\` devices, `\\?\UNC\`). A
/// verbatim *local* path (`\\?\C:\…`) is not one. Lexical on purpose: the
/// map is project content, and resolving a hostile path it names would
/// contact that host on Windows with the user's sign-in (gap 53).
fn is_network_path(s: &str) -> bool {
    let b = s.as_bytes();
    let sep = |c: u8| c == b'\\' || c == b'/';
    if b.len() < 2 || !sep(b[0]) || !sep(b[1]) {
        return false;
    }
    // `\\?\C:\…` / `//?/C:/…`: a drive, not a host.
    let verbatim_drive = b.len() >= 6
        && b[2] == b'?'
        && sep(b[3])
        && b[4].is_ascii_alphabetic()
        && b[5] == b':';
    !verbatim_drive
}

/// `p` cleaned of `.` and `..` without touching the disk, and of Windows'
/// verbatim drive prefix (`\\?\C:` is spelled `C:`), so a canonical path and
/// a plain one compare component by component.
fn lexical_clean(p: &Path) -> PathBuf {
    use std::path::{Component, Prefix};
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => out.push(format!("{}:", char::from(drive))),
                _ => out.push(c.as_os_str()),
            },
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

impl Spelling {
    fn new(base: &Path) -> Self {
        let roots = base
            .ancestors()
            .filter(|a| !is_network_path(&a.to_string_lossy()))
            .filter_map(|a| std::fs::canonicalize(a).ok().map(|c| (a.to_path_buf(), c)))
            .collect();
        Spelling {
            base: base.to_path_buf(),
            roots,
        }
    }

    /// Absolutise (against the base) and canonicalise an `Input:` path, then
    /// re-spell it under the caller's spelling of the base where it lies there.
    /// A path that does not exist (a moved tree) comes back absolutised only.
    /// Never carries Windows' `\\?\` verbatim prefix.
    fn absolutise(&self, input: &str) -> String {
        if is_network_path(input) {
            return input.to_string();
        }
        let p = Path::new(input);
        let abs: PathBuf = if p.is_absolute() {
            p.to_path_buf()
        } else {
            self.base.join(p)
        };
        let Ok(canonical) = std::fs::canonicalize(&abs) else {
            return crate::paths::display_path(&abs);
        };
        for (spelled, root) in &self.roots {
            if let Ok(rest) = canonical.strip_prefix(root) {
                let respelled = if rest.as_os_str().is_empty() {
                    spelled.clone()
                } else {
                    spelled.join(rest)
                };
                return crate::paths::display_path(&respelled);
            }
        }
        crate::paths::display_path(&canonical)
    }

    /// Whether an `Input:` path lies under `root` by its *spelling* alone, no
    /// disk access: the recorded physical spelling or the caller's, whichever
    /// `root` is in. Run before [`Self::absolutise`], so a path outside the
    /// document's tree (or on another machine) is never resolved.
    fn lexically_within(&self, input: &str, root: &Path) -> bool {
        if is_network_path(input) || is_network_path(&root.to_string_lossy()) {
            return false;
        }
        let p = Path::new(input);
        let abs = lexical_clean(&if p.is_absolute() { p.to_path_buf() } else { self.base.join(p) });
        let root = lexical_clean(root);
        if abs.starts_with(&root) {
            return true;
        }
        self.roots.iter().any(|(spelled, canonical)| {
            root.strip_prefix(spelled)
                .is_ok_and(|rest| abs.starts_with(lexical_clean(&canonical.join(rest))))
        })
    }
}

/// The largest map read, compressed or inflated. A 600-page thesis writes
/// well under a tenth of this.
pub(crate) const MAX_MAP_BYTES: u64 = 512 * 1024 * 1024;

/// Decompressed SyncTeX text, cached against the file's path, mtime and size so
/// a burst of clicks on one PDF re-reads (and re-inflates) nothing. The size is
/// there for a rebuild inside one tick of a coarse-mtime filesystem.
/// Single-entry: SyncTeX is driven by one focused PDF at a time, and a stale
/// megabyte of a document nobody is looking at is not worth holding.
static CACHE: Mutex<Option<Cached>> = Mutex::new(None);

/// The cached map and the file it was read from.
struct Cached {
    path: PathBuf,
    /// The file's mtime and size when it was read.
    stamp: (SystemTime, u64),
    map: Arc<Map>,
}

/// A loaded map: the decompressed text plus its already-parsed header. The
/// header parse is a full scan (the input table runs into the body — see
/// {@link parse_preamble}), so it is done once per file rather than per click.
struct Map {
    text: String,
    pre: Preamble,
    /// Forward search's digest of every box, made on the first search of this
    /// map and kept with it: walking a thesis' map parses every record of every
    /// page, and a forward search used to pay that on each Ctrl+click.
    line_boxes: OnceLock<Vec<LineBox>>,
}

impl Map {
    fn new(text: String) -> Self {
        let pre = parse_preamble(&text);
        Self {
            text,
            pre,
            line_boxes: OnceLock::new(),
        }
    }

    fn line_boxes(&self) -> &[LineBox] {
        self.line_boxes.get_or_init(|| line_boxes(&self.text, &self.pre))
    }
}

/// The folder `pdf` sits in, as the caller spelled it.
fn pdf_dir(pdf: &Path) -> &Path {
    pdf.parent().unwrap_or_else(|| Path::new("."))
}

/// Where the map of `pdf` may sit, the compressed form the engines write
/// first. The one spelling of those names: what is read here is what
/// `commands::synctex` confines to the project.
pub(crate) fn map_candidates(pdf: &Path) -> Option<[PathBuf; 2]> {
    let stem = pdf.file_stem()?.to_str()?;
    let dir = pdf_dir(pdf);
    Some([dir.join(format!("{stem}.synctex.gz")), dir.join(format!("{stem}.synctex"))])
}

/// The SyncTeX map beside `pdf`, preferring the compressed form the engines
/// write. None when there is none — an imported PDF, or one built without
/// `-synctex=1`, simply has no SyncTeX.
fn map_path(pdf: &Path) -> Option<PathBuf> {
    if is_network_path(&pdf.to_string_lossy()) {
        return None;
    }
    map_candidates(pdf)?.into_iter().find(|map| map.exists())
}

/// What SyncTeX can promise for a PDF right now — the answer to "why did my
/// click do nothing, or land on the wrong line", asked by the viewer before it
/// words a notice. Every field is a reason to recompile.
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
    /// SyncTeX answers with are those of the build *before* that edit.
    pub newer_sources: Vec<String>,
}

impl MapStatus {
    /// A map exists and the PDF has not outgrown it: its pages are this PDF's.
    pub fn is_current(&self) -> bool {
        self.has_map && !self.pdf_newer_than_map
    }

    /// `input` (spelled as the map spells it) was saved after the build, so the
    /// map's line numbers for it are those of the text before that edit.
    pub fn is_edited(&self, input: &str) -> bool {
        self.newer_sources.iter().any(|s| s == input)
    }
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
    spelling: &Spelling,
    root: &Path,
    map_mtime: SystemTime,
    mtime_of: impl Fn(&Path) -> Option<SystemTime>,
) -> Vec<String> {
    let threshold = map_mtime + STALE_GRACE;
    let mut out: Vec<String> = inputs
        .values()
        // By extension first: only the few sources are worth resolving.
        .filter(|p| {
            Path::new(p)
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| SOURCE_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        })
        .filter(|p| spelling.lexically_within(p, root))
        .map(|p| spelling.absolutise(p))
        .filter(|abs| Path::new(abs).starts_with(root))
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
            let pdf_dir = pdf_dir(pdf);
            let spelling = Spelling::new(pdf_dir);
            // The main document is the lowest-numbered input; its directory is
            // the tree the person edits (an out-dir build puts the PDF elsewhere).
            let root = map
                .pre
                .inputs
                .iter()
                .min_by_key(|(tag, _)| **tag)
                .filter(|(_, p)| !is_network_path(p))
                .map(|(_, p)| PathBuf::from(spelling.absolutise(p)))
                .and_then(|main| main.parent().map(Path::to_path_buf))
                .unwrap_or_else(|| pdf_dir.to_path_buf());
            stale_inputs(&map.pre.inputs, &spelling, &root, map_mtime, mtime)
        }
        None => Vec::new(),
    };
    MapStatus {
        has_map: true,
        pdf_newer_than_map,
        newer_sources,
    }
}

/// Read and parse the map at `path`, bounded both ways at `cap` bytes: the map
/// sits in a project folder, so a small `.gz` could inflate to gigabytes. None
/// for a map that cannot be read or is past the cap — no SyncTeX for it.
/// Only a regular file is opened: a FIFO planted under the map's name would
/// hold the reading thread forever.
fn read_map(path: &Path, cap: u64) -> Option<Map> {
    use std::io::Read;
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    let read = if path.extension().is_some_and(|e| e == "gz") {
        let file = std::fs::File::open(path).ok()?;
        flate2::read::GzDecoder::new(file.take(cap))
            .take(cap + 1)
            .read_to_string(&mut text)
    } else {
        std::fs::File::open(path).ok()?.take(cap + 1).read_to_string(&mut text)
    };
    if read.is_err() || text.len() as u64 > cap {
        return None;
    }
    Some(Map::new(text))
}

/// Read the SyncTeX map beside `pdf` ({@link map_path}), through the cache.
///
/// The cache stays locked across the read: a second caller for the same map
/// (the status probe behind a click, a forward search behind a compile) waits
/// for this parse instead of inflating a copy of its own beside it.
fn load_map(pdf: &Path) -> Option<Arc<Map>> {
    let path = map_path(pdf)?;
    let meta = std::fs::metadata(&path).ok()?;
    let stamp = (meta.modified().ok()?, meta.len());
    let mut cache = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(hit) = cache.as_ref().filter(|c| c.path == path && c.stamp == stamp) {
        return Some(hit.map.clone());
    }
    let map = Arc::new(read_map(&path, MAX_MAP_BYTES)?);
    *cache = Some(Cached {
        path,
        stamp,
        map: map.clone(),
    });
    Some(map)
}

/// The source line for one click among one page's boxes, in the caller's
/// spelling. None when the page holds no boxes or the winning record names an
/// input the map never declared.
fn resolve_point(map: &Map, spelling: &Spelling, boxes: &[HBox], x: f64, y: f64) -> Option<(String, u32)> {
    let bx = pick_hbox(boxes, x, y)?;
    let (tag, line) = resolve_in_hbox(bx, x);
    if line == 0 {
        return None;
    }
    let input = map.pre.inputs.get(&tag)?;
    if is_network_path(input) {
        return None;
    }
    Some((spelling.absolutise(input), line))
}

/// Reverse search `(page, x, y)` (big points from the page's top-left) in the
/// SyncTeX map beside `pdf`, as `(source path, line)`.
///
/// Returns None when there is no map, the page holds no boxes, or the winning
/// record names an input the map never declared.
pub fn resolve(pdf: &Path, page: u32, x: f64, y: f64) -> Option<(String, u32)> {
    let map = load_map(pdf)?;
    let boxes = drop_backgrounds(page_hboxes(&map.text, page, &map.pre));
    resolve_point(&map, &Spelling::new(pdf_dir(pdf)), &boxes, x, y)
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
    let by_page: BTreeMap<u32, Vec<HBox>> =
        by_page.into_iter().map(|(page, boxes)| (page, drop_backgrounds(boxes))).collect();
    let spelling = Spelling::new(pdf_dir(pdf));
    points
        .iter()
        .map(|(page, list)| {
            let boxes = by_page.get(page).map(Vec::as_slice).unwrap_or_default();
            let answers = list
                .iter()
                .map(|&(x, y)| resolve_point(&map, &spelling, boxes, x, y))
                .collect();
            (*page, answers)
        })
        .collect()
}

/// The `Input:` tags for source file `input`, matched by **canonicalised path**
/// against the recorded table — a set, since a file `\input` twice is declared
/// twice.
///
/// Matching by path rather than by the recorded string is why forward search is
/// native: the CLI's `synctex view -i` needs the path *character for character*
/// as SyncTeX happened to record it, so an absolute path, a `./`-prefixed one, a
/// basename or a symlinked spelling returned nothing.
///
/// Only when no recorded path is the file does the basename count, and only for
/// a tree that moved since the build: the one recorded path with that name no
/// longer exists. Two recorded files sharing the name is an honest miss — never
/// the other file's line.
fn input_tags(pre: &Preamble, input: &str, spelling: &Spelling) -> BTreeSet<u32> {
    if is_network_path(input) {
        return BTreeSet::new();
    }
    // Compared as paths, component by component, so `/` and `\` agree.
    let target = PathBuf::from(spelling.absolutise(input));
    let Some(name) = target.file_name() else {
        return BTreeSet::new();
    };
    // Only same-named inputs can match, so only those are resolved: the table
    // runs to hundreds of TeX tree files, each a `canonicalize` per call.
    let recorded: Vec<(u32, PathBuf)> = pre
        .inputs
        .iter()
        .filter(|(_, path)| Path::new(path).file_name() == Some(name))
        .filter(|(_, path)| !is_network_path(path))
        .map(|(tag, path)| (*tag, PathBuf::from(spelling.absolutise(path))))
        .collect();
    let exact: BTreeSet<u32> = recorded
        .iter()
        .filter(|(_, path)| *path == target)
        .map(|(tag, _)| *tag)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    let named: BTreeSet<&Path> = recorded
        .iter()
        .filter(|(_, path)| path.file_name() == Some(name))
        .map(|(_, path)| path.as_path())
        .collect();
    match named.into_iter().collect::<Vec<_>>().as_slice() {
        [only] if !only.exists() => recorded
            .iter()
            .filter(|(_, path)| path == only)
            .map(|(tag, _)| *tag)
            .collect(),
        _ => BTreeSet::new(),
    }
}

/// The `(tag, line)`s an hbox's own leaves were written by — its *material* —
/// for forward search. Nested boxes are matched on their own and are not their
/// parent's material.
///
/// A leaf survives when it is not line fill ({@link trim_line_fill}), not an
/// elastic record parked at the right edge (a zero-width kern or the
/// `\rightskip` at a line break carries the *next* line's tag), and not an
/// ancestor artefact ({@link is_ancestor_artefact}). Of the survivors, a leaf
/// repeating the box's own tag is the paragraph-break artefact whenever the box
/// holds anything else (pdfTeX stamps each line's first glyph run with the box's
/// tag) — so the box's own tag counts only for a box with nothing else in it, a
/// heading or a beamer block title.
///
/// Such a box is page chrome-shaped when its tag is also the page's
/// ({@link is_chrome}); its material counts only `with_chrome`.
fn material(bx: &HBox, with_chrome: bool) -> Vec<(u32, u32)> {
    let right = bx.rec.x + bx.rec.w;
    let leaves: Vec<&Rec> = bx.leaves.iter().filter(|r| r.line > 0 && !r.is_box).collect();
    let surviving: Vec<&Rec> = trim_line_fill(bx, &leaves)
        .into_iter()
        .filter(|r| !(r.elastic && r.x >= right - EDGE_EPSILON))
        .filter(|r| !is_ancestor_artefact(bx, r))
        .collect();
    let own = (bx.rec.tag, bx.rec.line);
    let foreign: Vec<(u32, u32)> = surviving
        .iter()
        .map(|r| (r.tag, r.line))
        .filter(|tl| *tl != own)
        .collect();
    if !foreign.is_empty() {
        return foreign;
    }
    if is_chrome(bx) && !with_chrome {
        return Vec::new();
    }
    surviving.iter().map(|r| (r.tag, r.line)).collect()
}

/// A box tagged like its page (the outermost box around it, or itself at the
/// page's root). With nothing but its own tag in it, that is how a header or a
/// footer looks: the output routine set it when the page shipped, tagged with
/// wherever the input happened to be — `\end{document}`, or the middle of a
/// paragraph on the *next* page. It is also how every box of a beamer frame
/// looks, since beamer reads the whole frame as an argument and re-reads it at
/// `\end{frame}`; hence chrome is only ever a second pass ({@link view_in}).
fn is_chrome(bx: &HBox) -> bool {
    let own = (bx.rec.tag, bx.rec.line);
    bx.ancestors.first().is_none_or(|page| *page == own)
}

/// What forward search keeps of one hbox: where it is, how it is tagged and what
/// its leaves say — the box itself, with every leaf of every line of the
/// document, is not held.
struct LineBox {
    page: u32,
    rec: Rec,
    /// {@link is_chrome}.
    chrome: bool,
    /// {@link material} with chrome, each `(tag, line)` once: the matching rules
    /// only ever ask whether a line is among them.
    material: Vec<(u32, u32)>,
}

impl LineBox {
    fn new(page: u32, bx: &HBox) -> Self {
        let mut material = material(bx, true);
        let mut seen = BTreeSet::new();
        material.retain(|tl| seen.insert(*tl));
        Self {
            page,
            rec: bx.rec,
            chrome: is_chrome(bx),
            material,
        }
    }

    /// {@link material} for one pass. Chrome-shaped material — nothing but the
    /// box's own tag, in a box tagged like its page — counts only `with_chrome`.
    fn material(&self, with_chrome: bool) -> &[(u32, u32)] {
        let own = (self.rec.tag, self.rec.line);
        if !with_chrome && self.chrome && self.material.iter().all(|tl| *tl == own) {
            &[]
        } else {
            &self.material
        }
    }
}

/// The {@link LineBox} of every hbox in the map, in the order the boxes close.
fn line_boxes(text: &str, pre: &Preamble) -> Vec<LineBox> {
    let mut out = Vec::new();
    each_hbox(text, pre, None, |page, bx| out.push(LineBox::new(page, &bx)));
    out
}

/// Forward search: the boxes `input:line` produced, on any page, as rects in big
/// points from the page's top-left.
///
/// Matches the source file by canonicalised path ({@link input_tags}) and the
/// line by each box's material ({@link material}), never by the box's own tag
/// alone: that tag is the paragraph-break artefact reverse search exists to work
/// around. Empty when there is no map or the file is not in it.
pub fn view(pdf: &Path, input: &str, line: u32) -> Vec<SyncRect> {
    let Some(map) = load_map(pdf) else {
        return Vec::new();
    };
    view_among(map.line_boxes(), &map.pre, &Spelling::new(pdf_dir(pdf)), input, line)
}

/// {@link view} over a map's text, for a unit test against a SyncTeX fixture
/// without a real PDF.
#[cfg(test)]
fn view_in(text: &str, pre: &Preamble, spelling: &Spelling, input: &str, line: u32) -> Vec<SyncRect> {
    view_among(&line_boxes(text, pre), pre, spelling, input, line)
}

/// The core of {@link view}, over the map's boxes.
///
/// Runs {@link find_boxes} without page chrome first, and only when that finds
/// nothing with it: a header or footer must not outrank the text of the line
/// whose position it happens to carry, but a beamer frame, all of whose boxes
/// look like chrome, must still be found. Where one hit contains another on the
/// same page only the outer one is kept: a section number inside its heading's
/// line, the identical wrappers beamer nests a block title in.
fn view_among(boxes: &[LineBox], pre: &Preamble, spelling: &Spelling, input: &str, line: u32) -> Vec<SyncRect> {
    let tags = input_tags(pre, input, spelling);
    if tags.is_empty() {
        return Vec::new();
    }
    for with_chrome in [false, true] {
        let hits = find_boxes(boxes, &tags, line, with_chrome);
        if hits.is_empty() {
            continue;
        }
        let rects = hits
            .iter()
            .map(|&i| {
                let LineBox { page, rec, .. } = &boxes[i];
                // The box spans `y - h` (top) to `y + d` (bottom).
                SyncRect {
                    page: *page,
                    x: rec.x,
                    y: rec.y - rec.h,
                    w: rec.w,
                    h: rec.h + rec.d,
                }
            })
            .collect();
        return outermost(rects);
    }
    Vec::new()
}

/// The indices of the boxes in `boxes` that file `tags`, line `line` produced,
/// by each box's material for this pass ({@link LineBox::material}). The first
/// rule that finds anything wins:
/// 1. the boxes with material at `(F, L)`, plus the boxes *tagged* `(F, L)`
///    with no material (an outer line box with nothing but a nested box in it:
///    XeTeX's section heading); failing those, the boxes tagged `(F, L)` whose
///    material is `F`'s — a blank line after a paragraph, or the paragraph's
///    `\par`, is that paragraph, as with the CLI;
/// 2. the nearest line of `F` that has material — the smallest after `L`, else
///    the largest before it (a comment, the preamble, past `\end{document}`) —
///    by rule 1;
/// 3. a box tagged with `F` whose material is `F`'s or empty, nearest line
///    first.
///
/// Never a box whose material is only another file's, nor, unless
/// `with_chrome`, page chrome ({@link is_chrome}).
fn find_boxes(boxes: &[LineBox], tags: &BTreeSet<u32>, line: u32, with_chrome: bool) -> Vec<usize> {
    let of_file = |tl: &(u32, u32)| tags.contains(&tl.0);
    // Tagged with the file, and neither page chrome nor another file's lines.
    let eligible_by_tag = |bx: &LineBox| {
        let m = bx.material(with_chrome);
        tags.contains(&bx.rec.tag)
            && (with_chrome || !bx.chrome || !m.is_empty())
            && (m.is_empty() || m.iter().any(of_file))
    };
    let indices = |keep: &dyn Fn(&LineBox) -> bool| -> Vec<usize> {
        boxes.iter().enumerate().filter(|(_, bx)| keep(bx)).map(|(i, _)| i).collect()
    };
    // A box tagged `(F, l)` that holds other lines of `F` is only the
    // paragraph `l`'s `\par` closed: it stands in for `l` when no box holds
    // `l` itself — `\item` closes the item before it, whose box must not come
    // back beside the item's own.
    let hits_at = |l: u32| -> Vec<usize> {
        let tagged = |bx: &LineBox| bx.rec.line == l && eligible_by_tag(bx);
        let own = indices(&|bx| {
            let m = bx.material(with_chrome);
            m.iter().any(|tl| of_file(tl) && tl.1 == l) || (m.is_empty() && tagged(bx))
        });
        if own.is_empty() {
            indices(&tagged)
        } else {
            own
        }
    };
    let nearest = |lines: BTreeSet<u32>| {
        lines
            .range(line..)
            .next()
            .or_else(|| lines.range(..line).next_back())
            .copied()
    };

    let hits = hits_at(line);
    if !hits.is_empty() {
        return hits;
    }
    let lines: BTreeSet<u32> = boxes
        .iter()
        .flat_map(|bx| bx.material(with_chrome).iter().filter(|tl| of_file(tl)).map(|tl| tl.1))
        .collect();
    if let Some(l) = nearest(lines) {
        return hits_at(l);
    }
    let lines: BTreeSet<u32> = boxes.iter().filter(|bx| eligible_by_tag(bx)).map(|bx| bx.rec.line).collect();
    match nearest(lines) {
        Some(l) => indices(&|bx| bx.rec.line == l && eligible_by_tag(bx)),
        None => Vec::new(),
    }
}

/// Drop every rect that another one on the same page contains (of identical
/// rects, keep the first), and every rect with no area when one has some: a
/// void box or a zero-width wrapper locates nothing a highlight could show.
/// But first drop a rect whose height holds two hits on different lines: that
/// is a block — a beamer frame's page-sized background — not the line that was
/// asked for.
fn outermost(rects: Vec<SyncRect>) -> Vec<SyncRect> {
    let has_area = |r: &SyncRect| r.w > 0.0 && r.h > 0.0;
    let rects: Vec<SyncRect> = if rects.iter().any(has_area) {
        rects.into_iter().filter(has_area).collect()
    } else {
        rects
    };
    let contains = |a: &SyncRect, b: &SyncRect| {
        a.page == b.page
            && a.x <= b.x + EDGE_EPSILON
            && a.y <= b.y + EDGE_EPSILON
            && a.x + a.w >= b.x + b.w - EDGE_EPSILON
            && a.y + a.h >= b.y + b.h - EDGE_EPSILON
    };
    let rects: Vec<SyncRect> = rects
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            // Vertically only: a background need not cover a line's width.
            let held = rects
                .iter()
                .enumerate()
                .filter(|(j, o)| j != i && o.page == r.page)
                .map(|(_, o)| (o.y, o.y + o.h));
            !spans_lines((r.y, r.y + r.h), held)
        })
        .map(|(_, r)| *r)
        .collect();
    rects
        .iter()
        .enumerate()
        .filter(|(i, r)| {
            !rects
                .iter()
                .enumerate()
                .any(|(j, o)| j != *i && contains(o, r) && !(contains(r, o) && *i < j))
        })
        .map(|(_, r)| *r)
        .collect()
}

// ── Page → source lines (the deck's slide anchors) ──────────────────────────
//
// This is the producer half of the deck's slide anchoring (`sidecar.ts`'s
// `reconcile`, TODO V #100). The sidecar has always documented a `line` anchor as
// "strictly better than any content heuristic" — it survives inserting, deleting
// and reordering frames exactly as well as the author's own mental model — and
// has always *consumed* one. Nothing ever wrote it, so the mechanism did not
// exist at runtime and every deck fell back to fingerprinting.
//
// It is answered by reading the `.synctex.gz` the compile already emits rather
// than by shelling out to `synctex edit` once per page: a 200-page plate would be
// 200 process spawns for one reconcile.

/// The source lines SyncTeX attributes to one page of a compiled PDF.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PageLines {
    /// 1-based, as the PDF numbers it.
    pub page: u32,
    /// Distinct contributing lines of the **main** input file, ascending.
    pub lines: Vec<u32>,
}

/// Parse a decompressed SyncTeX file into per-page line sets.
///
/// The format is one record per line. `{N` opens page N and `}N` closes it;
/// inside, a box/glyph/kern/glue record is `<type><tag>,<line>[,<column>]:<geometry>`
/// where `<tag>` names an input file declared as `Input:<tag>:<path>`. Closing
/// records (`]`, `)`) carry no tag.
///
/// `want_tag` restricts the harvest to one input file. That restriction is
/// load-bearing rather than an optimisation: line numbers from two different
/// files are not comparable, so mixing them would produce an anchor that silently
/// means nothing. A deck whose frames live in an `\input`ed file simply records no
/// line and falls back to the fingerprint, which is the honest outcome.
fn parse_synctex_pages(text: &str, pre: &Preamble, want_tag: u32) -> Vec<PageLines> {
    let mut out: Vec<PageLines> = Vec::new();
    let mut page: Option<u32> = None;
    let mut lines: BTreeSet<u32> = BTreeSet::new();

    let flush = |page: &mut Option<u32>, lines: &mut BTreeSet<u32>, out: &mut Vec<PageLines>| {
        if let Some(p) = page.take() {
            out.push(PageLines {
                page: p,
                lines: lines.iter().copied().collect(),
            });
            lines.clear();
        }
    };

    for raw in text.lines() {
        let l = raw.trim_end();
        let Some(c) = l.chars().next() else { continue };
        match c {
            '{' => {
                if let Ok(p) = l[1..].trim().parse::<u32>() {
                    flush(&mut page, &mut lines, &mut out);
                    page = Some(p);
                }
            }
            '}' => flush(&mut page, &mut lines, &mut out),
            // Box open/close-with-content, void boxes, and the glyph/kern/glue
            // records. `]` and `)` are the closers and carry no tag, so they are
            // not listed.
            '[' | '(' | 'v' | 'h' | 'x' | 'k' | 'g' | '$' | 'r' if page.is_some() => {
                if let Some(rec) = parse_record(&l[1..], pre, false) {
                    if rec.tag == want_tag && rec.line > 0 {
                        lines.insert(rec.line);
                    }
                }
            }
            _ => {}
        }
    }
    flush(&mut page, &mut lines, &mut out);
    out.sort_by_key(|p| p.page);
    out
}

/// The `Input:` tag whose path has file stem `stem` — the document's own main
/// source rather than one of its includes or a package. The lowest such tag:
/// the run's own `.aux` shares the stem and is declared later.
fn main_input_tag(pre: &Preamble, stem: &str) -> Option<u32> {
    pre.inputs
        .iter()
        .filter(|(_, path)| Path::new(path).file_stem().and_then(|s| s.to_str()) == Some(stem))
        .map(|(tag, _)| *tag)
        .min()
}

/// The source lines behind each page of the map beside `pdf`, read with the
/// same cap as the cached reader but **uncached**: a deck load must not evict
/// the map of the PDF someone is clicking in.
pub(crate) fn page_lines(pdf: &Path, cap: u64) -> Vec<PageLines> {
    let Some(stem) = pdf.file_stem().and_then(|s| s.to_str()) else {
        return Vec::new();
    };
    let Some(map) = map_path(pdf).and_then(|path| read_map(&path, cap)) else {
        return Vec::new();
    };
    // No input named like the job: no line of the main file to anchor to.
    match main_input_tag(&map.pre, stem) {
        Some(tag) => parse_synctex_pages(&map.text, &map.pre, tag),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests;
