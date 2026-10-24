//! SyncTeX, read natively out of the `.synctex(.gz)` the compile emitted (every
//! compile passes `-synctex=1`): reverse search (a point on a PDF page → the
//! source line that produced it), forward search (a source line → the boxes it
//! produced), the deck's page → source-line anchors, and the map's freshness.
//! These are the `synctex_*` commands.
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
use std::sync::Mutex;
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
    /// 1-based source line.
    pub line: u32,
    /// Always 0: SyncTeX records no column (the CLI printed `Column:-1` for
    /// every record pdfTeX writes). Kept so the payload's shape is stable.
    pub column: u32,
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
                            is_box: false,
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
                    parent.2.push(Rec { is_box: true, ..rec });
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

/// `p` cleaned of `.` and `..` without touching the disk.
fn lexical_clean(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
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
            return crate::commands::fs::display_path(&abs);
        };
        for (spelled, root) in &self.roots {
            if let Ok(rest) = canonical.strip_prefix(root) {
                let respelled = if rest.as_os_str().is_empty() {
                    spelled.clone()
                } else {
                    spelled.join(rest)
                };
                return crate::commands::fs::display_path(&respelled);
            }
        }
        crate::commands::fs::display_path(&canonical)
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
                .is_ok_and(|rest| abs.starts_with(canonical.join(rest)))
        })
    }
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
/// `-synctex=1`, simply has no SyncTeX.
fn map_path(pdf: &Path) -> Option<PathBuf> {
    if is_network_path(&pdf.to_string_lossy()) {
        return None;
    }
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
            let pdf_dir = pdf.parent().unwrap_or_else(|| Path::new("."));
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
fn read_map(path: &Path, cap: u64) -> Option<Map> {
    use std::io::Read;
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
    let pre = parse_preamble(&text);
    Some(Map { text, pre })
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

    let map = std::sync::Arc::new(read_map(&path, MAX_MAP_BYTES)?);
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((path, mtime, map.clone()));
    }
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
    let spelling = Spelling::new(pdf.parent().unwrap_or_else(|| Path::new(".")));
    resolve_point(&map, &spelling, &boxes, x, y)
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
    let spelling = Spelling::new(pdf.parent().unwrap_or_else(|| Path::new(".")));
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
    let spelling = Spelling::new(pdf.parent().unwrap_or_else(|| Path::new(".")));
    view_in(&map.text, &map.pre, &spelling, input, line)
}

/// The pure core of {@link view}, separated from the on-disk map load so it can be
/// unit-tested against a SyncTeX fixture without a real PDF.
///
/// Runs {@link find_boxes} without page chrome first, and only when that finds
/// nothing with it: a header or footer must not outrank the text of the line
/// whose position it happens to carry, but a beamer frame, all of whose boxes
/// look like chrome, must still be found. Where one hit contains another on the
/// same page only the outer one is kept: a section number inside its heading's
/// line, the identical wrappers beamer nests a block title in.
fn view_in(text: &str, pre: &Preamble, spelling: &Spelling, input: &str, line: u32) -> Vec<SyncRect> {
    let tags = input_tags(pre, input, spelling);
    if tags.is_empty() {
        return Vec::new();
    }
    let walked = walk_hboxes(text, pre, None);
    for with_chrome in [false, true] {
        let boxes: Vec<(&HBox, Vec<(u32, u32)>)> =
            walked.iter().map(|(_, bx)| (bx, material(bx, with_chrome))).collect();
        let hits = find_boxes(&boxes, &tags, line, with_chrome);
        if hits.is_empty() {
            continue;
        }
        let rects = hits
            .iter()
            .map(|&i| {
                let (page, bx) = &walked[i];
                // The box spans `y - h` (top) to `y + d` (bottom).
                SyncRect {
                    page: *page,
                    x: bx.rec.x,
                    y: bx.rec.y - bx.rec.h,
                    w: bx.rec.w,
                    h: bx.rec.h + bx.rec.d,
                }
            })
            .collect();
        return outermost(rects);
    }
    Vec::new()
}

/// The indices of the boxes in `boxes` (each with its material) that file `tags`,
/// line `line` produced. The first rule that finds anything wins:
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
fn find_boxes(boxes: &[(&HBox, Vec<(u32, u32)>)], tags: &BTreeSet<u32>, line: u32, with_chrome: bool) -> Vec<usize> {
    let of_file = |tl: &(u32, u32)| tags.contains(&tl.0);
    // Tagged with the file, and neither page chrome nor another file's lines.
    let eligible_by_tag = |bx: &HBox, m: &[(u32, u32)]| {
        tags.contains(&bx.rec.tag)
            && (with_chrome || !is_chrome(bx) || !m.is_empty())
            && (m.is_empty() || m.iter().any(of_file))
    };
    // A box tagged `(F, l)` that holds other lines of `F` is only the
    // paragraph `l`'s `\par` closed: it stands in for `l` when no box holds
    // `l` itself — `\item` closes the item before it, whose box must not come
    // back beside the item's own.
    let hits_at = |l: u32| -> Vec<usize> {
        let tagged = |bx: &HBox, m: &[(u32, u32)]| bx.rec.line == l && eligible_by_tag(bx, m);
        let own: Vec<usize> = boxes
            .iter()
            .enumerate()
            .filter(|(_, (bx, m))| {
                m.iter().any(|tl| of_file(tl) && tl.1 == l) || (m.is_empty() && tagged(bx, m))
            })
            .map(|(i, _)| i)
            .collect();
        if !own.is_empty() {
            return own;
        }
        boxes
            .iter()
            .enumerate()
            .filter(|(_, (bx, m))| tagged(bx, m))
            .map(|(i, _)| i)
            .collect()
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
        .flat_map(|(_, m)| m.iter().filter(|tl| of_file(tl)).map(|tl| tl.1))
        .collect();
    if let Some(l) = nearest(lines) {
        return hits_at(l);
    }
    let lines: BTreeSet<u32> = boxes
        .iter()
        .filter(|(bx, m)| eligible_by_tag(bx, m))
        .map(|(bx, _)| bx.rec.line)
        .collect();
    let Some(l) = nearest(lines) else {
        return Vec::new();
    };
    boxes
        .iter()
        .enumerate()
        .filter(|(_, (bx, m))| bx.rec.line == l && eligible_by_tag(bx, m))
        .map(|(i, _)| i)
        .collect()
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
fn page_lines(pdf: &Path, cap: u64) -> Vec<PageLines> {
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

// ── Commands ─────────────────────────────────────────────────────────────────

/// Read the SyncTeX map beside `pdf` and report the source lines behind each page.
///
/// Returns an empty vector — never an error — when there is no map, or none
/// readable within the cap: a deck whose plate was imported, or compiled by
/// something that did not emit one, is an ordinary case that falls back to
/// content fingerprinting.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_page_lines(pdf: String) -> Result<Vec<PageLines>, String> {
    app_core::rt::blocking("synctex", move || page_lines(Path::new(&pdf), MAX_MAP_BYTES)).await
}

/// Reverse search: which source line produced the point `(x, y)` (big points
/// from the page top-left) on `page` of `pdf`. `Ok(None)` when there is no map
/// or it has no answer, so the UI can degrade silently. The column is always 0
/// (see {@link SyncSource}).
///
/// Async so the read + gunzip runs off the main thread: a sync `#[tauri::command]`
/// is called on it, and a large document's map is megabytes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_edit(pdf: String, page: u32, x: f64, y: f64) -> Result<Option<SyncSource>, String> {
    app_core::rt::blocking("synctex", move || {
        resolve(Path::new(&pdf), page, x, y).map(|(input, line)| SyncSource {
            input,
            line,
            column: 0,
        })
    })
    .await
}

/// Why a SyncTeX jump did nothing, or landed on the wrong line: whether a map
/// exists beside `pdf`, whether the PDF outgrew it, and which local sources were
/// saved after it ({@link MapStatus}). The viewer asks after a miss — and after
/// a hit, to warn that the line it just jumped to belongs to the build before
/// the edit — and words a "recompile" notice from the answer. Off the main
/// thread for the same reason as `synctex_edit`: the first call after a compile
/// inflates the map.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_status(pdf: String) -> Result<MapStatus, String> {
    app_core::rt::blocking("synctex", move || status(Path::new(&pdf))).await
}

/// Forward search: where in `pdf` the source line `input:line` landed, as every
/// box it produced ({@link view}); the frontend picks the one for the caret's
/// column. Empty when there is no map or no answer. Off the main thread like
/// `synctex_edit`.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn synctex_view(pdf: String, input: String, line: u32) -> Result<Vec<SyncRect>, String> {
    app_core::rt::blocking("synctex", move || view(Path::new(&pdf), &input, line)).await
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
                is_box: false,
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
        let dir = Spelling::new(Path::new("/proj"));
        let tags = |input: &str| input_tags(&p, input, &dir).into_iter().collect::<Vec<_>>();
        // Exact recorded spelling.
        assert_eq!(tags("/proj/main.tex"), vec![1]);
        // A relative spelling resolved against the PDF dir → same file.
        assert_eq!(tags("chapters/intro.tex"), vec![5]);
        // A bare basename resolves via the fallback: the fixture's recorded
        // paths do not exist, which is what a moved tree looks like.
        assert_eq!(tags("second.tex"), vec![6]);
        // A file the document never included is not invented.
        assert!(tags("/proj/nope.tex").is_empty());
    }

    #[test]
    fn forward_finds_a_lines_boxes_by_its_leaves_not_the_box_tag() {
        // main.tex (tag 1) line 3's material sits in a box the paragraph break
        // labelled tag 5 — matching the box tag would miss it, matching the leaves
        // finds it. This is the exact failure reverse search documents, applied to
        // the forward direction.
        let p = parse_preamble(DOC);
        let dir = Spelling::new(Path::new("/proj"));
        let rects = view_in(DOC, &p, &dir, "/proj/main.tex", 3);
        assert_eq!(rects.len(), 1, "one box on one page: {rects:?}");
        assert_eq!(rects[0].page, 1);
        // The enclosing line box's own geometry (left edge 133.77bp, width 343.71).
        assert!((rects[0].x - 133.77).abs() < 0.01, "x = {}", rects[0].x);
        assert!((rects[0].w - 343.71).abs() < 0.01, "w = {}", rects[0].w);

        // intro.tex (tag 5) line 4 is in the SECOND line box (tag 6).
        let intro = view_in(DOC, &p, &dir, "/proj/chapters/intro.tex", 4);
        assert_eq!(intro.len(), 1, "{intro:?}");
        assert_eq!(intro[0].page, 1);
        assert!(intro[0].y > rects[0].y, "the second line: {intro:?}");

        // A line past the last one the document set takes the last line, as the
        // CLI's nearest-line rule did.
        assert_eq!(view_in(DOC, &p, &dir, "/proj/main.tex", 999), rects);
        // An unknown file produces nothing rather than a wrong box.
        assert!(view_in(DOC, &p, &dir, "/proj/ghost.tex", 3).is_empty());
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
        let dir = Spelling::new(Path::new("/proj"));
        let rects = view_in(TWO_PAGE, &p, &dir, "/proj/main.tex", 5);
        assert_eq!(rects.len(), 2, "one box per page: {rects:?}");
        assert_eq!(rects[0].page, 1);
        assert_eq!(rects[1].page, 2);
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
    fn a_frame_background_never_wins_a_click() {
        // A theme's page-sized background, nested deeper than the body line and
        // full height, so its vertical distance is 0 for every click. It holds
        // nothing but the frame's own tag, so it is dropped from the candidates.
        let text = LUATEX.replace(
            "[1,33:4718592,4718592:23146168,12000000,0\n",
            "[1,33:4718592,4718592:23146168,12000000,0\n\
             (1,33:0,12000000:23146168,12000000,0\n(1,33:0,12000000:23146168,12000000,0\n\
             (1,33:0,12000000:23146168,12000000,0\nr1,33:0,12000000:23146168,12000000,0\n\
             g1,33:23146168,12000000\n)\n)\n)\n",
        );
        let pre = parse_preamble(&text);
        let boxes = drop_backgrounds(page_hboxes(&text, 7, &pre));
        assert_eq!(boxes.len(), 3, "the background boxes are gone");
        let at = |cx: f64, cy: f64| resolve_in_hbox(pick_hbox(&boxes, cx, cy).expect("an hbox"), cx);
        let (title, body) = (bp(3637000.0), bp(4673000.0));
        assert_eq!(at(20.0, body), (295, 2), "a margin click on the body line");
        assert_eq!(at(20.0, title), (295, 1));
        assert_eq!(at(bp(2457000.0), (title + body) / 2.0).0, 295, "between the lines");
        // A frame with nothing but its own tag still answers `\end{frame}`,
        // the one answer there is; and a background alone on its page stays.
        let chrome_only = "Input:1:/proj/main.tex\nContent:\n{1\n[1,33:0,0:100,100,0\n\
            (1,33:0,12000000:23146168,12000000,0\nr1,33:0,12000000:23146168,12000000,0\n)\n\
            (1,33:0,3000000:23146168,400000,0\nx1,33:10,3000000\n)\n\
            (1,33:0,5000000:23146168,400000,0\nx1,33:10,5000000\n)\n]\n}1\n";
        let pre = parse_preamble(chrome_only);
        let boxes = drop_backgrounds(page_hboxes(chrome_only, 1, &pre));
        let bx = pick_hbox(&boxes, 20.0, bp(4000000.0)).expect("an hbox");
        assert_eq!(resolve_in_hbox(bx, 20.0), (1, 33));
        let alone = page_hboxes(chrome_only, 1, &pre).into_iter().take(1).collect::<Vec<_>>();
        assert_eq!(drop_backgrounds(alone).len(), 1);
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
    fn network_paths_are_told_by_their_spelling() {
        for net in [
            r"\\server\share\a.tex",
            "//server/share/a.tex",
            r"\\?\UNC\server\share\a.tex",
            "//?/UNC/server/share/a.tex",
            r"\\.\pipe\x",
            r"\/server/share",
        ] {
            assert!(is_network_path(net), "{net}");
        }
        for local in [
            "/proj/a.tex",
            "a.tex",
            r"C:\proj\a.tex",
            r"\\?\C:\proj\a.tex",
            "//?/D:/proj/a.tex",
            r"\proj\a.tex",
            "",
            "/",
        ] {
            assert!(!is_network_path(local), "{local}");
        }
    }

    #[test]
    fn a_path_is_judged_under_the_root_without_touching_the_disk() {
        let spelling = Spelling::new(Path::new("/no/such/proj"));
        let root = Path::new("/no/such/proj");
        assert!(spelling.lexically_within("/no/such/proj/./a/b.tex", root));
        assert!(spelling.lexically_within("a/b.tex", root));
        assert!(!spelling.lexically_within("/no/such/proj/../other/b.tex", root));
        assert!(!spelling.lexically_within("../b.tex", root));
        assert!(!spelling.lexically_within("/usr/share/texmf/x.cls", root));
        assert!(!spelling.lexically_within(r"\\server\share\b.tex", root));
        assert!(!spelling.lexically_within("//server/share/no/such/proj/b.tex", root));
        assert!(!spelling.lexically_within("/no/such/proj/b.tex", Path::new("//server/share")));
    }

    #[test]
    fn a_network_input_is_neither_resolved_nor_reported() {
        let spelling = Spelling::new(Path::new("/no/such/proj"));
        for net in [r"\\192.0.2.1\share\evil.tex", r"\\?\UNC\192.0.2.1\share\evil.tex", "//192.0.2.1/share/evil.tex"] {
            // Spelled back as it came: no canonicalize, no stat.
            assert_eq!(spelling.absolutise(net), net);
            let mut inputs = HashMap::new();
            inputs.insert(1, "/no/such/proj/main.tex".to_string());
            inputs.insert(2, net.to_string());
            let got = stale_inputs(&inputs, &spelling, Path::new("/no/such/proj"), SystemTime::UNIX_EPOCH, |p| {
                assert!(!is_network_path(&p.to_string_lossy()), "stat of {}", p.display());
                None
            });
            assert!(got.is_empty());
            // Reverse search never answers with it, forward search never matches it.
            let pre = parse_preamble(&format!("Input:1:{net}\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n"));
            assert!(input_tags(&pre, net, &spelling).is_empty());
            assert!(input_tags(&pre, "/no/such/proj/evil.tex", &spelling).is_empty());
            let text = format!(
                "Input:1:{net}\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{{1\n[1,33:0,0:23146168,12000000,0\n\
                 (1,33:1857863,3637000:26011770,544000,150000\nx1,33:2457000,3637000\n)\n]\n}}1\n"
            );
            let pre = parse_preamble(&text);
            let boxes = page_hboxes(&text, 1, &pre);
            let map = Map { text, pre };
            assert_eq!(resolve_point(&map, &spelling, &boxes, bp(3000000.0), bp(3637000.0)), None);
        }
    }

    #[test]
    fn a_pdf_on_a_network_path_has_no_map_and_no_status() {
        for net in [r"\\192.0.2.1\share\main.pdf", "//192.0.2.1/share/main.pdf"] {
            assert_eq!(map_path(Path::new(net)), None);
            assert_eq!(status(Path::new(net)), MapStatus::default());
            assert!(resolve(Path::new(net), 1, 1.0, 1.0).is_none());
            assert!(view(Path::new(net), "a.tex", 1).is_empty());
            assert!(page_lines(Path::new(net), 1024).is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_unc_input_is_not_canonicalized_on_windows() {
        let dir = tempfile::tempdir().expect("tempdir");
        let spelling = Spelling::new(dir.path());
        let started = std::time::Instant::now();
        let unc = r"\\192.0.2.1\share\evil.tex";
        assert_eq!(spelling.absolutise(unc), unc);
        assert_eq!(spelling.absolutise(r"\\?\UNC\192.0.2.1\share\evil.tex"), r"\\?\UNC\192.0.2.1\share\evil.tex");
        assert!(started.elapsed() < std::time::Duration::from_secs(2), "a network host was contacted");
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
        let spelling = Spelling::new(Path::new("/proj"));
        let got = stale_inputs(&inputs, &spelling, Path::new("/proj"), t0, |p| {
            mtimes.get(p.to_str().unwrap()).copied()
        });
        assert_eq!(got, vec!["/proj/slides/idea.tex".to_string()]);
        // A file the stat cannot see is not reported as stale.
        let got = stale_inputs(&inputs, &spelling, Path::new("/proj"), t0, |_| None);
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
        let slide = root.join("slides").join("idea.tex");
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

        // The slide is saved after the build: reported, by canonical path,
        // without Windows' `\\?\` prefix (which `root` carries there).
        set(&slide, t0 + Duration::from_secs(120));
        let st = status(&pdf);
        assert_eq!(st.newer_sources, vec![crate::commands::fs::display_path(&slide)]);
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

    // ── Forward search ──────────────────────────────────────────────────────

    /// `view_in` against a fixture whose recorded paths sit under `/proj`.
    fn forward(text: &str, input: &str, line: u32) -> Vec<SyncRect> {
        view_in(text, &parse_preamble(text), &Spelling::new(Path::new("/proj")), input, line)
    }

    #[test]
    fn forward_never_answers_with_another_files_material() {
        // intro.tex:1 set nothing of its own (its only records are box (5,1)'s
        // fill), so the nearest line of intro.tex that did — line 4, in the
        // second box — answers; never box (5,1), whose material is main.tex:3.
        let main = forward(DOC, "/proj/main.tex", 3);
        let intro = forward(DOC, "/proj/chapters/intro.tex", 1);
        assert_eq!(intro, forward(DOC, "/proj/chapters/intro.tex", 4));
        assert_eq!(intro.len(), 1);
        assert!(intro[0].y > main[0].y, "the intro:4 line, not main:3's: {intro:?}");
        // second.tex:1 tags box (6,1), but that box holds intro.tex's line 4 and
        // nothing of second.tex's: an honest miss.
        assert!(forward(DOC, "/proj/chapters/second.tex", 1).is_empty());
    }

    #[test]
    fn forward_skips_luatex_callback_artefacts() {
        // The block title: its inner box and the identical wrapper around it
        // both carry interpolation.tex:1 — one rect, not two.
        let title = forward(LUATEX, "/proj/slides/interpolation.tex", 1);
        assert_eq!(title.len(), 1, "{title:?}");
        assert!((title[0].y - (bp(3637000.0) - bp(544000.0))).abs() < 0.01);
        // The body line's material is line 2, whatever its box says.
        let body = forward(LUATEX, "/proj/slides/interpolation.tex", 2);
        assert_eq!(body.len(), 1, "{body:?}");
        assert!(body[0].y > title[0].y);
        // main.tex:33 appears only in the font callback's records: no answer,
        // rather than the slide lines they were spliced into.
        assert!(forward(LUATEX, "/proj/main.tex", 33).is_empty());
    }

    /// A one-file article, trimmed from a real `pdflatex -synctex=1` run of
    /// ```text
    ///  1 \documentclass{article}       7 line three of the same paragraph.
    ///  2 \usepackage{lipsum}           8
    ///  3 \begin{document}              9 Second paragraph alone on one line.
    ///  4 \section{Heading}            10
    ///  5 First paragraph line one,    11 \end{document}
    ///  6 % a comment line             12 trailing junk after end
    /// ```
    /// Every box of the page — the empty header, the footer's page number —
    /// is tagged with line 11, where the page shipped; the first paragraph's
    /// box carries line 8 (its `\par`) and an `x1,8` first-word record.
    const SINGLE: &str = "\
Input:1:/proj/./doc.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,11:4736286,46220574:26673152,41484288,0
[1,11:8799518,46220574:22609920,40435712,0
[1,11:8799518,6571294:22609920,786432,0
(1,11:8799518,6571294:22609920,0,0
h1,11:8799518,6571294:22609920,0,0
)
]
[1,11:8799518,44254494:22609920,36044800,0
(1,4:8799518,8865054:22609920,655359,183500
(1,4:8799518,8865054:1592523,608173,0
g1,4:8799518,8865054
x1,4:9330359,8865054
g1,4:10392041,8865054
)
x1,4:14228077,8865054
k1,4:31409438,8865054:17181361
g1,4:31409438,8865054
)
(1,8:8799518,10300473:22609920,455111,127431
x1,8:10179418,10300473
g1,5:10397871,10300473
x1,5:13314231,10300473
g1,7:17392032,10300473
x1,7:18850210,10300473
k1,8:31409438,10300473:5725266
g1,8:31409438,10300473
)
(1,10:8799518,11086905:22609920,455111,127431
h1,9:8799518,11086905:983040,0,0
x1,9:11785051,11086905
g1,9:12003504,11086905
x1,9:14919864,11086905
k1,10:31409438,11086905:11246685
g1,10:31409438,11086905
)
]
(1,11:8799518,46220574:22609920,422343,0
(1,11:8799518,46220574:22609920,422343,0
k1,11:19940638,46220574:11141120
x1,11:20268319,46220574
k1,11:31409438,46220574:11141119
)
)
]
]
}1
";

    #[test]
    fn forward_takes_the_nearest_line_that_set_something() {
        let at = |line: u32| forward(SINGLE, "/proj/doc.tex", line);
        let heading = at(4);
        let first = at(5);
        let second = at(9);
        // The heading is its whole line, not the section number nested in it.
        assert_eq!(heading.len(), 1, "{heading:?}");
        assert!((heading[0].w - 343.71).abs() < 0.01, "{heading:?}");
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert!(first[0].y > heading[0].y && second[0].y > first[0].y);
        // A comment line inside the paragraph, and the blank line ending it.
        assert_eq!(at(6), first);
        assert_eq!(at(7), first);
        assert_eq!(at(8), first, "a blank line after a paragraph is that paragraph");
        assert_eq!(at(10), second);
        // The preamble: the first line that set anything.
        assert_eq!(at(2), heading);
        // `\end{document}` and what follows: the last line — not the header or
        // the page number, which carry line 11 only because the page shipped there.
        assert_eq!(at(11), second);
        assert_eq!(at(12), second);
    }

    #[test]
    fn a_footer_never_outranks_the_text_of_its_line() {
        // Page 1 shipped while TeX read line 50 (the blank line after the
        // paragraph that opens page 2), so its footer is tagged (1, 50) — as
        // is page 2's first line box, the paragraph line 50 ends.
        const PAGES: &str = "\
Input:1:/proj/doc.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,50:4736286,46220574:26673152,41484288,0
[1,50:8799518,44254494:22609920,36044800,0
(1,48:8799518,8865054:22609920,455111,127431
h1,47:8799518,8865054:983040,0,0
x1,47:10228568,8865054
k1,47:12999630,8865054:236997
x1,47:14000000,8865054
)
]
(1,50:8799518,46220574:22609920,422343,0
(1,50:8799518,46220574:22609920,422343,0
k1,50:19940638,46220574:11141120
x1,50:20268319,46220574
k1,50:31409438,46220574:11141119
)
)
]
}1
{2
[1,96:4736286,46220574:26673152,41484288,0
[1,96:8799518,44254494:22609920,36044800,0
(1,50:8799518,8865054:22609920,455111,127431
h1,49:8799518,8865054:983040,0,0
x1,49:10228568,8865054
k1,49:12999630,8865054:236997
x1,49:14000000,8865054
)
]
]
}2
";
        for line in [49, 50] {
            let rects = forward(PAGES, "/proj/doc.tex", line);
            assert_eq!(rects.len(), 1, "line {line}: {rects:?}");
            assert_eq!(rects[0].page, 2, "line {line}");
        }
        assert_eq!(forward(PAGES, "/proj/doc.tex", 47)[0].page, 1);
    }

    #[test]
    fn a_beamer_frame_is_found_although_every_box_looks_like_chrome() {
        // Beamer reads a frame as an argument and re-reads it at `\end{frame}`,
        // so every main.tex record of a frame carries that line — the page's
        // own tag, which is how a footer looks. The second pass still finds the
        // frame: main.tex:6 → frame 1 (ends on line 9), main.tex:12 → frame 2.
        const FRAMES: &str = "\
Input:1:/proj/main.tex
Input:152:/proj/chapters/intro.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,9:4736286,4736286:18414002,13164651,0
(1,9:0,17900937:23867907,17900937,0
(1,9:0,17900937:23867907,17900937,0
r1,9:23867907,17900937:23867907,17900937,-1073741824
)
)
(1,9:717619,17333526:-717619,17333526,0
)
(1,9:717619,3000000:22432669,498028,147830
x1,9:1288126,3000000
)
(1,9:717619,5000000:22432669,498028,147830
x1,9:1288126,5000000
g1,9:2383107,5000000
x1,9:3415761,5000000
)
(1,9:717619,9035217:22432669,498028,147830
h152,1:717619,9035217:0,0,0
x152,1:1288126,9035217
g152,1:2383107,9035217
k1,9:4927574,9035217:-20093
x1,9:6565898,9035217
g152,2:12050239,9035217
x152,2:13098681,9035217
g1,9:23150288,9035217
)
]
}1
{2
[1,14:4736286,4736286:18414002,13164651,0
(1,14:717619,5000000:22432669,498028,147830
x1,14:1288126,5000000
)
]
}2
";
        // The frame's own lines (its title, its text) — never the page-sized
        // backgrounds the theme lays under them, which carry the same tag.
        let six = forward(FRAMES, "/proj/main.tex", 6);
        assert_eq!(six.len(), 2, "{six:?}");
        assert!(six.iter().all(|r| r.page == 1 && r.h < 20.0), "no background: {six:?}");
        assert!((six[1].y - (bp(5000000.0) - bp(498028.0))).abs() < 0.01, "the frame's text line: {six:?}");
        assert_eq!(forward(FRAMES, "/proj/main.tex", 12)[0].page, 2);
        // The `\input` slide is found by its own material in the first pass.
        let intro = forward(FRAMES, "/proj/chapters/intro.tex", 2);
        assert_eq!(intro.len(), 1);
        assert!(intro[0].y > six[1].y);
    }

    #[test]
    fn forward_finds_a_xetex_document_made_only_of_glue() {
        // XeTeX writes no glyph records: a line holds only `g`/`k`, and a
        // section heading's line box only its number box and its fill.
        const XETEX: &str = "\
Input:1:/proj/doc.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,11:4736287,46220575:26673152,41484288,0
[1,11:8799519,44254495:22609920,36044800,0
(1,4:8799519,8865055:22609920,654940,189686
(1,4:8799519,8865055:1475031,619079,0
g1,4:8799519,8865055
g1,4:10274550,8865055
)
k1,4:31409439,8865055:17297731
g1,4:31409439,8865055
)
(1,8:8799519,10301145:22609920,462029,135003
g1,5:10397942,10301145
g1,5:13533840,10301145
g1,7:17393255,10301145
g1,7:19069666,10301145
k1,8:31409439,10301145:5723913
g1,8:31409439,10301145
)
]
]
}1
";
        let heading = forward(XETEX, "/proj/doc.tex", 4);
        assert_eq!(heading.len(), 1, "{heading:?}");
        assert!((heading[0].w - 343.71).abs() < 0.01, "the whole line: {heading:?}");
        let para = forward(XETEX, "/proj/doc.tex", 5);
        assert_eq!(para.len(), 1);
        assert!(para[0].y > heading[0].y);
        assert_eq!(forward(XETEX, "/proj/doc.tex", 6), para);
        assert_eq!(forward(XETEX, "/proj/doc.tex", 8), para);
    }

    #[test]
    fn a_file_input_twice_is_found_at_both_places() {
        // pdfTeX declares a file once per `\input`: tags 5 and 7 are one file.
        const TWICE: &str = "\
Input:1:/proj/main.tex
Input:5:/proj/./chapters/intro.tex
Input:7:/proj/./chapters/intro.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,8:8799518,44254494:22609920,36044800,0
(6,2:8799518,8865054:22609920,455111,127431
x1,3:11257122,8865054
k5,1:27586685,8865054:-18205
x5,1:29008455,8865054
)
(1,8:8799518,12010782:22609920,455111,127431
x1,8:9782560,12010782
k7,1:10015714,12010782:233154
x7,1:11626810,12010782
)
]
}1
";
        let p = parse_preamble(TWICE);
        let tags = input_tags(&p, "/proj/chapters/intro.tex", &Spelling::new(Path::new("/proj")));
        assert_eq!(tags, BTreeSet::from([5, 7]));
        let rects = forward(TWICE, "/proj/chapters/intro.tex", 1);
        assert_eq!(rects.len(), 2, "{rects:?}");
    }

    #[test]
    fn the_basename_counts_only_for_a_tree_that_moved() {
        let spelling = Spelling::new(Path::new("/proj"));
        let tags_of = |table: &str, input: &str| input_tags(&parse_preamble(table), input, &spelling);
        // Moved: the one recorded `intro.tex` is gone, the caller's is elsewhere.
        assert_eq!(
            tags_of("Input:5:/old/proj/chapters/intro.tex\n", "/new/proj/chapters/intro.tex"),
            BTreeSet::from([5])
        );
        // Two recorded files share the name: never guess which.
        assert!(tags_of(
            "Input:2:/old/a/intro.tex\nInput:3:/old/b/intro.tex\n",
            "/new/intro.tex"
        )
        .is_empty());

        // The recorded file still exists: it is another file, not this one moved.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        std::fs::create_dir_all(root.join("a")).expect("a");
        std::fs::write(root.join("a").join("intro.tex"), "x").expect("intro");
        let table = format!("Input:2:{}\n", root.join("a").join("intro.tex").display());
        let other = root.join("b").join("intro.tex");
        assert!(tags_of(&table, other.to_str().expect("utf-8")).is_empty());
    }

    /// A symlinked project: the engine records the physical tree, the caller
    /// spells the link. Every path SyncTeX hands back keeps the link.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_project_keeps_the_callers_spelling() {
        use std::time::Duration;
        let dir = tempfile::tempdir().expect("tempdir");
        let root = std::fs::canonicalize(dir.path()).expect("canonical");
        let real = root.join("real");
        let link = root.join("link");
        std::fs::create_dir_all(real.join("chapters")).expect("real");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        std::fs::write(real.join("main.tex"), "x").expect("main");
        std::fs::write(real.join("chapters").join("intro.tex"), "x").expect("intro");
        std::fs::write(real.join("main.pdf"), "").expect("pdf");
        // As pdfTeX writes it: the physical working directory plus `./`.
        let doc = DOC
            .replace("/proj/main.tex", &format!("{}/./main.tex", real.display()))
            .replace("/proj/chapters/", &format!("{}/./chapters/", real.display()));
        std::fs::write(real.join("main.synctex"), doc).expect("map");

        let pdf = link.join("main.pdf");
        let (input, line) = resolve(&pdf, 1, bp(11436714.0), bp(8865054.0)).expect("a hit");
        assert_eq!((Path::new(&input), line), (link.join("main.tex").as_path(), 3));
        let (input, _) = resolve(&pdf, 1, 20.0, bp(13224414.0)).expect("a hit");
        assert_eq!(Path::new(&input), link.join("chapters").join("intro.tex"));

        // Forward search takes either spelling of the source.
        assert_eq!(view(&pdf, link.join("main.tex").to_str().expect("utf-8"), 3).len(), 1);
        assert_eq!(view(&pdf, real.join("main.tex").to_str().expect("utf-8"), 3).len(), 1);

        // And a stale source is reported as the caller spells it.
        let t0 = SystemTime::now() - Duration::from_secs(3600);
        let set = |p: &Path, t: SystemTime| {
            std::fs::File::options().write(true).open(p).expect("open").set_modified(t).expect("mtime")
        };
        set(&real.join("main.synctex"), t0);
        set(&real.join("main.pdf"), t0);
        set(&real.join("chapters").join("intro.tex"), t0);
        set(&real.join("main.tex"), t0 + Duration::from_secs(120));
        assert_eq!(status(&pdf).newer_sources, vec![link.join("main.tex").to_string_lossy().into_owned()]);
    }

    // ── Page → source lines ─────────────────────────────────────────────────

    /// A SyncTeX body shaped like the real thing: a preamble of `Input:` files,
    /// then two pages, the second of which is a Beamer overlay of the first — the
    /// case the whole line anchor exists for, since both come from the same frame
    /// and are therefore attributed to the same source lines.
    const SYNCTEX: &str = "\
SyncTeX Version:1
Input:1:/talks/main.tex
Input:2:/usr/share/texmf/beamer.sty
Content:
{1
[1,12:0,0:100,50,0
(1,14:10,10:80,20,0
h1,15:10,10:80,10,0
)
x2,99:5,5
]
}1
{2
[1,12:0,0:100,50,0
h1,15:10,10:80,10,0
h1,18:10,30:80,10,0
]
}2
Input:3:/talks/main.aux
Postamble:
Count:2
";

    #[test]
    fn synctex_pages_harvest_the_main_file_s_lines() {
        let pre = parse_preamble(SYNCTEX);
        // The run's own `.aux` shares the stem; the main source is the lower tag.
        let tag = main_input_tag(&pre, "main");
        assert_eq!(tag, Some(1));
        let pages = parse_synctex_pages(SYNCTEX, &pre, 1);
        assert_eq!(
            pages,
            vec![
                PageLines {
                    page: 1,
                    lines: vec![12, 14, 15]
                },
                PageLines {
                    page: 2,
                    lines: vec![12, 15, 18]
                },
            ]
        );
        // The package's own tag is excluded: line numbers from two files are not
        // comparable, so mixing them would be an anchor that means nothing.
        assert!(!pages[0].lines.contains(&99));
    }

    #[test]
    fn overlay_pages_share_a_first_line() {
        // Both pages of the frame report 12 as their lowest line. That is not a
        // bug to fix here — it is the fact `reconcile` matches *within* the group
        // for, so the k-th slide on line L takes the k-th page L produced.
        let pages = parse_synctex_pages(SYNCTEX, &parse_preamble(SYNCTEX), 1);
        assert_eq!(pages[0].lines.first(), Some(&12));
        assert_eq!(pages[1].lines.first(), Some(&12));
    }

    #[test]
    fn a_map_with_no_matching_input_yields_no_lines() {
        // A deck whose frames live in an `\input`ed file records nothing rather
        // than an anchor built from another file's line numbering.
        let pre = parse_preamble(SYNCTEX);
        assert_eq!(main_input_tag(&pre, "chapter"), None);
        let pages = parse_synctex_pages(SYNCTEX, &pre, 7);
        assert_eq!(pages.len(), 2);
        assert!(pages.iter().all(|p| p.lines.is_empty()));
    }

    #[test]
    fn postamble_lines_are_not_mistaken_for_records() {
        // `Count:2` sits outside any page and must not become line data.
        let pages = parse_synctex_pages(SYNCTEX, &parse_preamble(SYNCTEX), 1);
        assert_eq!(pages.len(), 2);
        assert!(!pages.iter().any(|p| p.lines.contains(&2)), "{pages:?}");
    }

    #[test]
    fn page_lines_read_the_map_beside_the_pdf_within_the_cap() {
        use std::io::Write;
        let dir = tempfile::tempdir().expect("tempdir");
        let pdf = dir.path().join("main.pdf");
        assert!(page_lines(&pdf, MAX_MAP_BYTES).is_empty(), "no map, no lines");
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(SYNCTEX.as_bytes()).expect("gzip");
        std::fs::write(dir.path().join("main.synctex.gz"), gz.finish().expect("gzip")).expect("map");
        assert_eq!(page_lines(&pdf, MAX_MAP_BYTES).len(), 2);
        // A map inflating past the cap is not read at all.
        assert!(page_lines(&pdf, 64).is_empty());

        // A job named like none of its inputs has no main file: no lines,
        // rather than every file's numbering mixed into one anchor.
        std::fs::copy(dir.path().join("main.synctex.gz"), dir.path().join("talk.synctex.gz")).expect("copy");
        assert!(page_lines(&dir.path().join("talk.pdf"), MAX_MAP_BYTES).is_empty());
    }

    #[test]
    fn an_item_line_is_its_own_item_not_the_one_its_item_closed() {
        // Trimmed from a real pdflatex run of
        //   5 \item First item text      8 \end{itemize}
        //   6 here on six                 9 Paragraph text that
        //   7 \item Second item text    10 ends here\par
        // `\item` on line 7 closes item 1, so item 1's box is tagged (1, 7)
        // while holding lines 5–6; line 7's own text is in item 2's box.
        const ITEMS: &str = "\
Input:1:/proj/doc.tex
Unit:1
X Offset:0
Y Offset:0
Content:
{1
[1,11:4736286,46220574:26673152,41484288,0
[1,11:8799518,44254494:22609920,36044800,0
(1,7:10437920,8865054:20971518,455111,0
(1,5:10437920,8865054:0,286650,0
g1,5:10437920,8865054
g1,5:9127198,8865054
x1,5:10110240,8865054
)
x1,5:11817820,8865054
g1,5:12036273,8865054
x1,5:13310587,8865054
g1,6:16316144,8865054
x1,6:17007915,8865054
k1,7:31409438,8865054:13396636
g1,7:31409438,8865054
)
(1,8:10437920,10175774:20971518,455111,0
(1,7:10437920,10175774:0,286650,0
g1,7:10437920,10175774
g1,7:9127198,10175774
x1,7:10110240,10175774
)
x1,7:12440413,10175774
g1,7:12658866,10175774
x1,7:13933180,10175774
k1,8:31409438,10175774:16110922
g1,8:31409438,10175774
)
(1,10:8799518,11617566:22609920,455111,127431
x1,10:9245528,11617566
x1,9:11779593,11617566
g1,9:11998046,11617566
x1,9:13144929,11617566
g1,10:16279739,11617566
x1,10:17483054,11617566
k1,10:31409438,11617566:13926384
g1,10:31409438,11617566
)
]
]
}1
";
        let at = |line: u32| forward(ITEMS, "/proj/doc.tex", line);
        let second = at(7);
        assert_eq!(second.len(), 1, "item 2 only: {second:?}");
        assert!((second[0].y - (bp(10175774.0) - bp(455111.0))).abs() < 0.01, "{second:?}");
        let first = at(5);
        assert_eq!(first.len(), 1);
        assert!(first[0].y < second[0].y);
        // Line 10's own words hide behind the first-word record; the box its
        // `\par` closed still answers, by tag.
        let par = at(10);
        assert_eq!(par.len(), 1, "{par:?}");
        assert!((par[0].y - (bp(11617566.0) - bp(455111.0))).abs() < 0.01, "{par:?}");
        assert_eq!(at(9), par);
    }
}
