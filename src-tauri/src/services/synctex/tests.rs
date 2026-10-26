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
    assert_eq!(st.newer_sources, vec![crate::paths::display_path(&slide)]);
    assert!(!st.pdf_newer_than_map);

    // The PDF rebuilt without a map: the map is the older build's.
    set(&pdf, t0 + Duration::from_secs(120));
    assert!(status(&pdf).pdf_newer_than_map);
}

#[cfg(windows)]
#[test]
fn a_verbatim_drive_compares_as_the_plain_one() {
    assert_eq!(lexical_clean(Path::new(r"\\?\C:\a\..\b")), PathBuf::from(r"C:\b"));
    let spelling = Spelling::new(Path::new(r"\\?\C:\proj"));
    assert!(spelling.lexically_within(r"\\?\C:\proj\a.tex", Path::new(r"C:\proj")));
    assert!(spelling.lexically_within(r"C:\proj\a.tex", Path::new(r"\\?\C:\proj")));
    assert!(!spelling.lexically_within(r"\\?\C:\other\a.tex", Path::new(r"C:\proj")));
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
