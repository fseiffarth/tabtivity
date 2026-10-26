use super::*;

/// A build stopped at its ceiling keeps the log it wrote until then (the
/// log says where it stuck), with the stop note after it.
#[cfg(unix)]
#[test]
fn a_stuck_build_keeps_its_partial_log() {
    let dir = tempfile::tempdir().unwrap();
    let args = ["-c", "echo '! partial log line'; sleep 30"];
    let started = std::time::Instant::now();
    let run = run_in_within(dir.path(), "sh", &args, std::time::Duration::from_secs(1)).expect("ran");
    assert!(started.elapsed() < std::time::Duration::from_secs(20), "not stopped at the ceiling");
    assert!(!run.ok);
    assert!(run.text.contains("! partial log line"), "partial log lost: {:?}", run.text);
    assert!(run.text.contains("appears to be stuck"), "no stop note: {:?}", run.text);
}

#[test]
fn a_preview_wrapper_keeps_the_authors_preamble_and_crops_to_the_snippet() {
    let doc = preview_document(
        "\\documentclass{article}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\nbody\n\\end{document}\n",
        "$x \\in \\R$",
    );
    // The author's macro survives; the document body does not (a whole file
    // handed in by mistake must not become two \begin{document}s).
    assert!(doc.contains("\\newcommand{\\R}"));
    assert_eq!(doc.matches("\\begin{document}").count(), 1);
    assert!(!doc.contains("\nbody\n"));
    // Cropping is the whole point of the wrapper.
    assert!(doc.contains("\\usepackage[active,tightpage]{preview}"));
    assert!(doc.contains("\\begin{preview}\n$x \\in \\R$\n\\end{preview}"));
}

#[test]
fn a_preamble_less_fragment_still_gets_a_class() {
    // A child `.tex` (`\input`ed by the main file) has no preamble at all.
    let doc = preview_document("\\newcommand{\\R}{\\mathbb{R}}\n", "$\\R$");
    assert!(doc.contains("\\documentclass"));
    assert!(doc.contains("\\newcommand{\\R}"));
}

#[test]
fn a_preamble_that_already_loads_preview_is_not_made_to_clash() {
    // Loading `preview` twice with different options is an option clash —
    // i.e. the preview would fail for exactly the documents most prepared
    // for previewing.
    let doc = preview_document("\\documentclass{article}\n\\usepackage{preview}\n", "$x$");
    assert_eq!(doc.matches("\\usepackage").count(), 1);
    assert!(!doc.contains("[active,tightpage]"));
}

#[test]
fn a_float_is_previewed_through_previews_own_float_option() {
    // Measured, not assumed: `\begin{figure}` demands outer par mode, so a
    // float wrapped in `\begin{preview}` dies with "Not in outer par mode"
    // and writes no PDF. `floats` makes the environment itself the preview.
    let doc = preview_document(
        "\\documentclass{article}\n\\usepackage{graphicx}\n",
        "\\begin{figure}\n\\includegraphics{fig/a}\n\\caption{A}\n\\end{figure}",
    );
    assert!(doc.contains("\\usepackage[active,tightpage,floats]{preview}"));
    assert!(!doc.contains("\\begin{preview}"));
    assert!(doc.contains("\\begin{figure}"));
}

#[test]
fn only_the_four_float_names_preview_takes_are_treated_as_floats() {
    for body in [
        "\\begin{figure}x\\end{figure}",
        "  \\begin{figure*}x\\end{figure*}",
        "\\begin{table}x\\end{table}",
        "\\begin{table*}x\\end{table*}",
    ] {
        assert!(body_is_float(body), "{body}");
    }
    // A `wrapfigure` is not a `\@float` (it previews to no pages at all) and a
    // `float`-package custom float — which `algorithm` is — redefines
    // `\end@float` past what the option patches ("Extra }, or forgotten
    // \endgroup"). Both were tried against a real engine; neither is offered,
    // so neither may be wrapped as though it worked.
    for body in [
        "\\begin{wrapfigure}{r}{2cm}x\\end{wrapfigure}",
        "\\begin{algorithm}x\\end{algorithm}",
        "$x$",
        "\\begin{align}x\\end{align}",
    ] {
        assert!(!body_is_float(body), "{body}");
    }
}

#[test]
fn a_floats_fallback_is_an_article_rather_than_standalone() {
    // `standalone` cannot host a float for the same reason `\begin{preview}`
    // cannot, so the float fallback has to be a class that has floats at all.
    let doc = fallback_preview_document("\\begin{table}x\\end{table}");
    assert!(doc.contains("{article}"));
    assert!(doc.contains("[active,tightpage,floats]{preview}"));
    assert!(!doc.contains("standalone"));
}

#[test]
fn a_float_that_could_not_get_the_option_falls_back() {
    // The one case the option cannot be set: the document's own preamble
    // already loaded `preview`, and options cannot be added to a loaded
    // package. That is a preamble failure, so it earns the second pass.
    assert!(preview_needs_fallback("! LaTeX Error: Not in outer par mode."));
}

#[test]
fn the_fallback_carries_no_preamble_of_the_authors() {
    let doc = fallback_preview_document("$x$");
    assert!(doc.contains("{standalone}"));
    assert!(doc.contains("amsmath"));
    assert!(doc.contains("$x$"));
}

#[test]
fn only_a_preamble_failure_earns_the_second_pass() {
    // A missing style file / class, or a `preview.sty` this install lacks:
    // retry without the author's preamble.
    assert!(preview_needs_fallback(
        "! LaTeX Error: File `preview.sty' not found."
    ));
    assert!(preview_needs_fallback(
        "! LaTeX Error: File `mystyle.sty' not found."
    ));
    assert!(preview_needs_fallback("! LaTeX Error: Option clash for package preview."));
    // A typo in the fragment is the fragment's problem: fail once, report it,
    // and don't pay for a second engine run on every hover.
    assert!(!preview_needs_fallback(
        "! Missing } inserted.\nl.5 $\\frac{1}{"
    ));
    assert!(!preview_needs_fallback("! Undefined control sequence."));
}

#[test]
fn a_preview_never_enables_shell_escape() {
    // Same invariant as the full compile, asserted separately because the
    // preview builds its own argument list rather than going through
    // `compile_tex` (see `compile_args_never_enable_shell_escape`).
    let args = engine_args(concat!("/scratch/", crate::app_slug!(), "-preview.tex"), Some("/scratch"), &[]);
    assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
    // …and turns it off outright, whatever the distribution's default (#867).
    assert!(args.iter().any(|a| a == NO_SHELL_ESCAPE), "{args:?}");
    let env = preview_env(Path::new("/scratch"));
    assert!(env.iter().any(|(k, v)| k == "openout_any" && v == "p"));
    // Gap 36: no reads by absolute path or `../` either, and the one
    // absolute place it may read is its own scratch dir.
    assert!(env.iter().any(|(k, v)| k == "openin_any" && v == "p"));
    assert!(env.iter().any(|(k, v)| k == "TEXMFOUTPUT" && v == "/scratch"));
    assert_eq!(OPENOUT_PARANOID, ("openout_any", "p"));
}

#[test]
fn a_hover_preview_never_runs_luatex() {
    let all: Vec<String> = ENGINES.iter().map(|e| e.to_string()).collect();
    let only = |names: &[&str]| -> Vec<String> { names.iter().map(|e| e.to_string()).collect() };
    let never = || -> Option<EngineHint> { panic!("hint read although the request serves") };
    let pre = |e: &str| Ok(PreviewPlan::Preamble(e.to_string()));
    let body = |e: &str| Ok(PreviewPlan::BodyOnly(e.to_string()));
    // An explicit non-Lua engine is used as is, without reading the preamble.
    assert_eq!(preview_engine(Some("xelatex".into()), never, &all), pre("xelatex"));
    assert_eq!(preview_engine(Some("pdflatex".into()), never, &all), pre("pdflatex"));
    // A preamble that asks for LuaTeX previews the body alone under
    // pdfLaTeX, whatever was requested; without pdfLaTeX another non-Lua
    // engine.
    for req in [None, Some("lualatex".to_string())] {
        for hint in [EngineHint::Lua, EngineHint::Named("lualatex")] {
            assert_eq!(preview_engine(req.clone(), || Some(hint), &all), body("pdflatex"));
            assert_eq!(
                preview_engine(req.clone(), || Some(hint), &only(&["xelatex", "lualatex"])),
                body("xelatex")
            );
            assert_eq!(
                preview_engine(req.clone(), || Some(hint), &only(&["lualatex"])),
                Err(PREVIEW_NO_LUATEX.to_string())
            );
        }
    }
    // LuaLaTeX chosen in the engine menu, or a fontspec preamble that a
    // Build would give LuaLaTeX: XeLaTeX where installed, else another one.
    assert_eq!(preview_engine(Some("lualatex".into()), || None, &all), pre("pdflatex"));
    assert_eq!(preview_engine(None, || Some(EngineHint::Unicode), &all), pre("xelatex"));
    assert_eq!(preview_engine(Some("lualatex".into()), || Some(EngineHint::Unicode), &all), pre("xelatex"));
    assert_eq!(
        preview_engine(None, || Some(EngineHint::Unicode), &only(&["pdflatex", "lualatex"])),
        pre("pdflatex")
    );
    // Only LuaLaTeX installed: no preview at all; nothing installed: as before.
    assert_eq!(preview_engine(None, || None, &only(&["lualatex"])), Err(PREVIEW_NO_LUATEX.to_string()));
    assert_eq!(preview_engine(None, || None, &[]), Err("no TeX engine found on PATH".to_string()));
    assert_eq!(preview_engine(None, || Some(EngineHint::Lua), &[]), Err("no TeX engine found on PATH".to_string()));
    // A Build still follows the document to LuaLaTeX.
    assert_eq!(engine_for_hint(Some(EngineHint::Lua), &all).as_deref(), Some("lualatex"));
}

/// #867 end to end, where a TeX engine is installed: `shell_escape=t` in the
/// environment stands in for a distribution that enables it in `texmf.cnf`.
/// A preamble's `\write18` must not run on hover, nor its `\openout` escape
/// the scratch dir.
#[cfg(unix)]
#[test]
fn a_hover_preview_runs_no_shell_command_even_where_the_default_allows_it() {
    // Previews never run LuaTeX ({@link preview_engine}).
    let Some(eng) = ["pdflatex", "xelatex"]
        .into_iter()
        .find(|e| crate::paths::resolve_executable(e).is_some())
    else {
        eprintln!("no TeX engine on PATH — skipping");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let doc = tmp.path().canonicalize().unwrap().join("doc");
    let out = tmp.path().canonicalize().unwrap().join("out");
    fs::create_dir_all(&doc).unwrap();
    fs::create_dir_all(&out).unwrap();
    let pwned = tmp.path().join("pwned");
    let escaped = tmp.path().join("escaped.tex");
    let tex = out.join("p.tex");
    fs::write(
        &tex,
        format!(
            "\\documentclass{{article}}\\immediate\\write18{{touch {}}}\n\
                 \\begin{{document}}x\\end{{document}}\n",
            pwned.display()
        ),
    )
    .unwrap();
    let args = engine_args(&preview_main_file(&tex), Some(&out.to_string_lossy()), &[]);
    let mut envs = preview_env(&out);
    envs.push(("shell_escape".to_string(), "t".to_string()));
    // Without the flag the plant must fire, or this test proves nothing.
    let bare: Vec<&String> = args.iter().filter(|a| *a != NO_SHELL_ESCAPE).collect();
    let _ = run_in_within_env(&doc, eng, &bare, PREVIEW_TIMEOUT, &envs);
    if !pwned.exists() {
        eprintln!("{eng} ignores shell_escape=t here — skipping");
        return;
    }
    fs::remove_file(&pwned).unwrap();
    let _ = fs::remove_file(out.join("p.pdf"));
    let run = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &envs).expect("engine ran");
    assert!(out.join("p.pdf").is_file(), "the preview itself must still typeset: {}", run.text);
    assert!(!pwned.exists(), "\\write18 ran through a preview");

    // An `\openout` aimed outside the scratch dir is refused (TeX makes that
    // fatal, so this preview fails — the right answer for such a preamble).
    fs::write(
        &tex,
        format!(
            "\\documentclass{{article}}\\immediate\\openout5={}\n\
                 \\immediate\\write5{{x}}\\immediate\\closeout5\n\
                 \\begin{{document}}x\\end{{document}}\n",
            escaped.display()
        ),
    )
    .unwrap();
    let _ = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &preview_env(&out));
    assert!(!escaped.exists(), "\\openout wrote outside the preview's output dir");
}

/// Gap 36, where pdfLaTeX or XeLaTeX is installed: under the preview's
/// environment an `\input` of an absolute path outside the scratch dir or
/// of `../` is refused, while one relative to the document's folder still
/// resolves and the wrapper itself (named by file name, found in the
/// scratch `-output-directory`) opens.
#[cfg(unix)]
#[test]
fn a_hover_preview_reads_only_below_the_document() {
    let Some(eng) = ["pdflatex", "xelatex"]
        .into_iter()
        .find(|e| crate::paths::resolve_executable(e).is_some())
    else {
        eprintln!("no TeX engine on PATH — skipping");
        return;
    };
    let tmp = tempfile::tempdir().unwrap();
    let doc = tmp.path().canonicalize().unwrap().join("doc");
    let out = tmp.path().canonicalize().unwrap().join("out");
    fs::create_dir_all(&doc).unwrap();
    fs::create_dir_all(&out).unwrap();
    let tex = out.join("p.tex");
    let args = engine_args(&preview_main_file(&tex), Some(&out.to_string_lossy()), &[]);
    let secret = tmp.path().canonicalize().unwrap().join("secret.tex");
    fs::write(&secret, "\\def\\secretmacro{SECRETMARKER}").unwrap();
    fs::write(doc.join("macros.tex"), "\\def\\localmacro{ok}").unwrap();
    // A same-named file in the document's folder never stands in for the
    // wrapper: the engine looks in `-output-directory` first. (`tmp` sits
    // below a dot directory, `/tmp/.tmpXXXX`, as the state dir does on
    // Linux — the reason the wrapper goes by name.)
    fs::write(doc.join("p.tex"), "\\errmessage{decoy}\\end\n").unwrap();
    let body = |input: &str| {
        format!("\\documentclass{{article}}\\input{{macros}}\\input{{{input}}}\n\\begin{{document}}\\localmacro\\end{{document}}\n")
    };
    let _ = fs::remove_file(out.join("p.pdf"));
    fs::write(&tex, body(&secret.to_string_lossy())).unwrap();
    let run = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &preview_env(&out)).expect("engine ran");
    assert!(!out.join("p.pdf").exists(), "an absolute \\input was read: {}", run.text);
    assert!(run.text.contains("secret.tex"), "refused for another reason: {}", run.text);
    assert!(!run.text.contains("SECRETMARKER"), "{}", run.text);
    // The same read without the paranoid input mode goes through, so the
    // refusal above is the mode's doing.
    let open: Vec<(String, String)> = vec![("openin_any".to_string(), "a".to_string())];
    let run = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &open).expect("engine ran");
    assert!(out.join("p.pdf").is_file(), "control run failed: {}", run.text);
    let _ = fs::remove_file(out.join("p.pdf"));
    // A relative `../` is refused too.
    fs::write(&tex, body("../secret")).unwrap();
    let _ = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &preview_env(&out));
    assert!(!out.join("p.pdf").exists(), "a ../ \\input was read");
    // And a preamble that reads only below the document's folder typesets.
    fs::write(&tex, "\\documentclass{article}\\usepackage{amsmath}\\input{macros}\n\\begin{document}\\localmacro\\end{document}\n").unwrap();
    let run = run_in_within_env(&doc, eng, &args, PREVIEW_TIMEOUT, &preview_env(&out)).expect("engine ran");
    assert!(out.join("p.pdf").is_file(), "a relative \\input must still work: {}", run.text);
}

/// Gap 36, where LuaLaTeX is installed: a Build's `io.open` for writing an
/// absolute path or `../` is refused even when the environment (standing in
/// for a user's `texmf.cnf`) says `openout_any=a`, because every engine run
/// sets {@link OPENOUT_PARANOID} after the inherited environment.
#[cfg(unix)]
#[test]
fn a_build_engine_run_confines_luatex_writes() {
    if crate::paths::resolve_executable("lualatex").is_none() {
        eprintln!("lualatex not on PATH — skipping");
        return;
    }
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let doc = root.join("doc");
    let out = root.join("out");
    fs::create_dir_all(&doc).unwrap();
    fs::create_dir_all(&out).unwrap();
    let abs = root.join("abs.txt");
    fs::write(
        doc.join("t.tex"),
        format!(
            "\\documentclass{{article}}\\begin{{document}}\\directlua{{\n\
                 local f = io.open(\"{}\", \"w\") if f then f:write(\"x\") f:close() end\n\
                 local g = io.open(\"../parent.txt\", \"w\") if g then g:write(\"x\") g:close() end\n\
                 }}x\\end{{document}}\n",
            abs.display()
        ),
    )
    .unwrap();
    let args = engine_args("t.tex", Some(&out.to_string_lossy()), &[]);
    // The control: with `a` actually reaching the engine the writes land.
    let mut cmd = crate::paths::command_no_window("lualatex");
    cmd.args(&args).current_dir(&doc).env("openout_any", "a");
    let _ = cmd.output();
    if !abs.exists() {
        eprintln!("lualatex refuses the write even with openout_any=a — skipping");
        return;
    }
    fs::remove_file(&abs).unwrap();
    let _ = fs::remove_file(root.join("parent.txt"));
    // The same run through `run_in_within_env`: its own `openout_any=p`
    // replaces any inherited value (`Command::env`), as it would a user's.
    let run = run_in_within_env(&doc, "lualatex", &args, RUN_TIMEOUT, &[]).expect("engine ran");
    assert!(out.join("t.pdf").is_file(), "the build itself must still typeset: {}", run.text);
    assert!(!abs.exists(), "a Build's io.open wrote an absolute path");
    assert!(!root.join("parent.txt").exists(), "a Build's io.open wrote ../");
}

#[test]
fn an_oversized_snippet_is_refused_rather_than_typeset() {
    let big = "x".repeat(MAX_PREVIEW_BODY + 1);
    let err = preview_snippet_blocking(".".into(), String::new(), big, None).unwrap_err();
    assert!(err.contains("too large"), "{err}");
    let err = preview_snippet_blocking(".".into(), String::new(), "  \n ".into(), None)
        .unwrap_err();
    assert!(err.contains("empty"), "{err}");
}

#[test]
fn stale_scratch_dirs_are_swept_and_fresh_ones_kept() {
    let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-prevsweep-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("run-1")).unwrap();
    fs::write(root.join("stray.txt"), b"x").unwrap();

    // "Now" as of creation: nothing is old enough to sweep.
    sweep_preview_scratch(&root, std::time::SystemTime::now());
    assert!(root.join("run-1").exists());

    // An hour and a bit later, the same dir is a leftover from a crashed run.
    let later = std::time::SystemTime::now()
        + PREVIEW_SCRATCH_MAX_AGE
        + std::time::Duration::from_secs(60);
    sweep_preview_scratch(&root, later);
    assert!(!root.join("run-1").exists());
    // Only directories are ours to remove.
    assert!(root.join("stray.txt").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_scratch_sweep_spares_the_format_cache() {
    let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fmtspare-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("fmt")).unwrap();
    fs::write(root.join("fmt").join("k.fmt"), b"x").unwrap();
    // Way past the scratch age: a run dir this old would be swept, but the
    // format cache is supposed to outlive the run that built it.
    let later = std::time::SystemTime::now()
        + PREVIEW_SCRATCH_MAX_AGE
        + std::time::Duration::from_secs(60);
    sweep_preview_scratch(&root, later);
    assert!(root.join("fmt").join("k.fmt").exists());
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_format_key_names_the_dumped_head_and_nothing_else() {
    let a = preview_document("\\documentclass{article}\n\\usepackage{amsmath}", "$x$");
    let b = preview_document("\\documentclass{article}\n\\usepackage{amsmath}", "$y+z$");
    // Two snippets under one preamble share a format…
    assert_eq!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &b));
    // …a changed preamble does not, and neither does a changed engine.
    let c = preview_document("\\documentclass{article}\n\\usepackage{amssymb}", "$x$");
    assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &c));
    assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("xelatex", &a));
    // A float's wrapper head carries the `floats` preview option, so it gets
    // its own format rather than sharing (and mis-loading) the formula one.
    let f = preview_document(
        "\\documentclass{article}\n\\usepackage{amsmath}",
        "\\begin{figure}x\\end{figure}",
    );
    assert_ne!(preview_fmt_key("pdflatex", &a), preview_fmt_key("pdflatex", &f));
}

#[test]
fn a_dead_format_is_told_apart_from_a_broken_snippet() {
    // The two shapes pdfTeX actually prints for a bad dump…
    assert!(preview_log_is_format_error("(Fatal format file error; I'm stymied)"));
    assert!(preview_log_is_format_error(
        "---! /x/k.fmt was made by different (pdf)tex version"
    ));
    // …and a snippet's own failure, which must NOT trigger a second run.
    assert!(!preview_log_is_format_error(
        "! File ended while scanning use of \\frac.\n!  ==> Fatal error occurred, no output PDF file produced!"
    ));
}

#[test]
fn old_and_surplus_formats_are_swept_oldest_first() {
    let root = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fmtsweep-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let now = std::time::SystemTime::now();
    // One over the cap, with strictly increasing mtimes so "oldest" is
    // well-defined even on a coarse-mtime filesystem.
    for i in 0..=PREVIEW_FMT_MAX {
        let p = root.join(format!("k{i}.fmt"));
        fs::write(&p, b"x").unwrap();
        let f = fs::File::options().append(true).open(&p).unwrap();
        f.set_modified(now - std::time::Duration::from_secs(600 - i as u64))
            .unwrap();
    }
    sweep_preview_fmts(&root, now);
    assert!(!root.join("k0.fmt").exists(), "the oldest goes");
    assert!(root.join(format!("k{PREVIEW_FMT_MAX}.fmt")).exists());
    assert_eq!(fs::read_dir(&root).unwrap().count(), PREVIEW_FMT_MAX);

    // Past the age bound everything goes, `.bad` markers included — that is
    // what re-arms a preamble whose build failed transiently.
    fs::write(root.join("k1.bad"), b"").unwrap();
    let later = now + PREVIEW_FMT_MAX_AGE + std::time::Duration::from_secs(60);
    sweep_preview_fmts(&root, later);
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn font_names_are_readable_in_a_picker() {
    assert_eq!(
        font_display_name("LiberationSerif-BoldItalic"),
        "Liberation Serif Bold Italic"
    );
    assert_eq!(font_display_name("DejaVuSans"), "Deja Vu Sans");
    assert_eq!(font_display_name("lmroman10-regular"), "lmroman10 regular");
    // A run of capitals is an acronym, not words: don't shatter it.
    assert_eq!(font_display_name("NIMBUSSans"), "NIMBUSSans");
    assert_eq!(font_display_name("Some__Font  Name"), "Some Font Name");
}

#[test]
fn only_embeddable_font_formats_are_offered() {
    // A format fontkit cannot embed must not reach the picker: offering it
    // and failing at export is the worst of both.
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-fonts-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("nested")).unwrap();
    for name in ["Good.ttf", "Also.OTF", "Bitmap.pcf", "Notes.txt"] {
        fs::write(dir.join(name), b"x").unwrap();
    }
    fs::write(dir.join("nested/Deep.woff2"), b"x").unwrap();

    let mut out = Vec::new();
    collect_fonts(&dir, 0, &mut out);
    let mut names: Vec<&str> = out.iter().map(|f| f.name.as_str()).collect();
    names.sort_unstable();
    assert_eq!(names, vec!["Also", "Deep", "Good"]);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_font_directory_is_not_an_error() {
    let mut out = Vec::new();
    collect_fonts(Path::new("/definitely/not/here"), 0, &mut out);
    assert!(out.is_empty());
}

// A latexmk failure whose cause is configuration, not the document: no `!`
// line, no `file:line:` location — only latexmk's own complaint.
const CONFIG_FAILURE_LOG: &str = concat!(
    "This is pdfTeX, Version 3.141592653\n",
    "Latexmk: applying rule 'pdflatex'...\n",
    "Output written on main.pdf (12 pages, 214830 bytes).\n",
    "Latexmk: Summary of warnings from last run of *latex:\n",
    "  Latex failed to resolve 2 reference(s)\n",
    "Latexmk: Some warnings have been treated as errors.\n",
    "Collected error summary (may duplicate other messages):\n",
    "  pdflatex: Warnings treated as errors\n",
    "      Refer to 'main.log' for details\n",
    "Latexmk: Use the -f option to force complete processing,\n",
    " unless error was exceeding maximum runs, or warnings treated as errors.\n",
);

#[test]
fn config_failure_is_not_a_tex_error() {
    assert!(
        !log_has_tex_error(CONFIG_FAILURE_LOG),
        "a latexmk config complaint must not read as an engine error",
    );
}

#[test]
fn document_errors_are_tex_errors() {
    assert!(log_has_tex_error("./main.tex:12: Undefined control sequence.\n"));
    assert!(log_has_tex_error("! LaTeX Error: File `foo.sty' not found.\n"));
    assert!(log_has_tex_error("! Emergency stop.\n"));
    // Progress chatter must not trip it: no `:<digits>: ` run anywhere.
    assert!(!log_has_tex_error("Latexmk: Run number 1 of rule 'pdflatex'\n"));
    assert!(!log_has_tex_error("Output written on main.pdf (12 pages).\n"));
}

#[test]
fn latexmk_summary_names_the_cause_not_the_advisory() {
    let note = latexmk_summary(CONFIG_FAILURE_LOG).expect("a summary");
    assert!(
        note.contains("Warnings treated as errors"),
        "the collected summary must survive: {note}",
    );
    assert!(
        !note.contains("Use the -f option"),
        "the trailing advisory is not a reason: {note}",
    );
    assert!(
        !note.contains("Refer to "),
        "the log pointer is not a reason: {note}",
    );
    assert!(
        !note.contains("applying rule"),
        "progress chatter is not a reason: {note}",
    );
}

#[test]
fn a_clean_exit_is_judged_by_the_pdf_alone() {
    // An up-to-date no-op writes nothing and is still a success.
    assert!(build_succeeded(true, true, false, false));
    // A clean exit with no PDF at all is not.
    assert!(!build_succeeded(true, false, false, false));
}

#[test]
fn a_failed_exit_needs_a_fresh_pdf_and_no_engine_error() {
    // The forgiven case: latexmk unhappy, engine silent, PDF newly written.
    assert!(build_succeeded(false, true, true, false));
    // An earlier build's PDF must never be passed off as this build's.
    assert!(!build_succeeded(false, true, false, false));
    // A document that genuinely failed to typeset stays a failure, however
    // much of a PDF the engine managed to emit.
    assert!(!build_succeeded(false, true, true, true));
}

#[test]
fn latexmk_summary_is_none_without_a_complaint() {
    let clean = concat!(
        "Latexmk: This is Latexmk, John Collins\n",
        "Latexmk: Nothing to do for 'main.tex'.\n",
        "Latexmk: All targets (main.pdf) are up-to-date\n",
    );
    assert_eq!(latexmk_summary(clean), None);
}

#[test]
fn latexmk_flag_maps_engines() {
    assert_eq!(latexmk_flag(Some("lualatex")), "-pdflua");
    assert_eq!(latexmk_flag(Some("xelatex")), "-pdfxe");
    assert_eq!(latexmk_flag(Some("pdflatex")), "-pdf");
    assert_eq!(latexmk_flag(None), "-pdf");
}

fn hint(src: &str) -> Option<EngineHint> {
    detect_engine_hint(src, Path::new("/nonexistent-tex-dir"))
}

#[test]
fn engine_hint_reads_magic_comments() {
    assert_eq!(hint("% !TEX program = lualatex\n\\documentclass{article}"), Some(EngineHint::Named("lualatex")));
    assert_eq!(hint("%!TeX TS-program = xelatex\n"), Some(EngineHint::Named("xelatex")));
    assert_eq!(hint("% !TEX TS-program: pdflatex\n\\usepackage{fontspec}"), Some(EngineHint::Named("pdflatex")));
    assert_eq!(hint("% arara: xelatex: { shell: false }\n"), Some(EngineHint::Named("xelatex")));
    // `!TEX root` is the build root, not an engine; an unknown program is no hint.
    assert_eq!(hint("% !TEX root = main.tex\n"), None);
    assert_eq!(hint("% !TEX program = context\n"), None);
}

#[test]
fn engine_hint_reads_packages_and_primitives() {
    let doc = |pre: &str| format!("\\documentclass{{article}}\n{pre}\n\\begin{{document}}x\\end{{document}}\n");
    assert_eq!(hint(&doc("\\usepackage{amsmath}")), None);
    assert_eq!(hint(&doc("\\usepackage{fontspec}\n\\setmainfont{Libertinus Serif}")), Some(EngineHint::Unicode));
    assert_eq!(hint(&doc("\\usepackage[math-style=ISO]{unicode-math}")), Some(EngineHint::Unicode));
    assert_eq!(hint(&doc("\\setmainfont{TeX Gyre Pagella}")), Some(EngineHint::Unicode));
    assert_eq!(hint(&doc("\\usepackage{amsmath, luacode}")), Some(EngineHint::Lua));
    assert_eq!(hint(&doc("\\usepackage{fontspec}\n\\directlua{tex.print(1)}")), Some(EngineHint::Lua));
    assert_eq!(hint("\\documentclass{ltjsarticle}\n"), Some(EngineHint::Lua));
    assert_eq!(hint(&doc("\\usepackage{xeCJK}\n\\usepackage{fontspec}")), Some(EngineHint::Xe));
    assert_eq!(hint(&doc("\\XeTeXinputencoding \"utf8\"")), Some(EngineHint::Xe));
    // metalogo's `\XeTeX` logo and the engine-agnostic luatex85 shim ask for nothing.
    assert_eq!(hint(&doc("\\usepackage{metalogo}\\XeTeX{} and \\LuaTeX")), None);
    assert_eq!(hint(&doc("\\usepackage{luatex85}")), None);
    // A commented-out package is no request; an escaped percent is not a comment.
    assert_eq!(hint(&doc("%\\usepackage{fontspec}\n50\\% \\usepackage{luacode}")), Some(EngineHint::Lua));
    assert_eq!(hint(&doc("% \\usepackage{fontspec}")), None);
}

#[test]
fn engine_hint_follows_local_preamble_files() {
    let tmp = tempfile::tempdir().unwrap();
    fs::write(tmp.path().join("preamble.tex"), "\\usepackage{mystyle}\n").unwrap();
    fs::write(tmp.path().join("mystyle.sty"), "\\RequirePackage{fontspec}\n").unwrap();
    let main = "\\documentclass{article}\n\\input{preamble}\n\\begin{document}\\end{document}\n";
    assert_eq!(detect_engine_hint(main, tmp.path()), Some(EngineHint::Unicode));
}

#[test]
fn engine_for_hint_picks_an_installed_engine() {
    let all: Vec<String> = ENGINES.iter().map(|e| e.to_string()).collect();
    let only = |e: &[&str]| e.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(engine_for_hint(None, &all), None);
    assert_eq!(engine_for_hint(Some(EngineHint::Unicode), &all).as_deref(), Some("lualatex"));
    assert_eq!(engine_for_hint(Some(EngineHint::Unicode), &only(&["pdflatex", "xelatex"])).as_deref(), Some("xelatex"));
    assert_eq!(engine_for_hint(Some(EngineHint::Xe), &all).as_deref(), Some("xelatex"));
    // An engine-only document never lands on the other Unicode engine.
    assert_eq!(engine_for_hint(Some(EngineHint::Xe), &only(&["pdflatex", "lualatex"])), None);
    assert_eq!(engine_for_hint(Some(EngineHint::Named("lualatex")), &only(&["pdflatex"])), None);
}

#[test]
fn auto_engine_falls_back_to_the_first_installed() {
    let tmp = tempfile::tempdir().unwrap();
    let plain = tmp.path().join("plain.tex");
    let lua = tmp.path().join("lua.tex");
    fs::write(&plain, "\\documentclass{article}\n").unwrap();
    fs::write(&lua, "\\documentclass{article}\n\\usepackage{fontspec}\n").unwrap();
    let installed: Vec<String> = ENGINES.iter().map(|e| e.to_string()).collect();
    assert_eq!(auto_engine(&plain, &installed).as_deref(), Some("pdflatex"));
    assert_eq!(auto_engine(&lua, &installed).as_deref(), Some("lualatex"));
    assert_eq!(auto_engine(&lua, &[]), None);
}

#[test]
fn compile_args_never_enable_shell_escape() {
    // Compiling an untrusted `.tex` must never run the engine with
    // shell-escape / write18 enabled — that would let document macros
    // execute arbitrary shell commands. Guard the actual arg builders used
    // by `compile_tex` (its single source of truth) across every engine.
    let no_extra: Vec<String> = vec![];
    for engine in [None, Some("pdflatex"), Some("lualatex"), Some("xelatex")] {
        for fmt in [None, Some("doc-pdflatex-0a-12")] {
            let args = latexmk_args(engine, "doc.tex", None, &no_extra, fmt);
            assert!(
                !args.iter().any(|a| flag_enables_shell_escape(a)),
                "latexmk args for {engine:?} enable shell-escape: {args:?}",
            );
        }
    }

    let direct = engine_args("doc.tex", None, &no_extra);
    assert!(
        !direct.iter().any(|a| flag_enables_shell_escape(a)),
        "direct engine args enable shell-escape: {direct:?}",
    );

    // #867: both builders turn it off outright rather than trust the
    // distribution's default — last, after the user's (filtered) flags,
    // and with the file name still the final argument.
    let extra = vec!["-synctex=0".to_string()];
    let mk = latexmk_args(None, "doc.tex", Some("build"), &extra, Some("doc-pdflatex-0a-12"));
    let direct = engine_args("doc.tex", Some("build"), &extra);
    for args in [&mk, &direct] {
        assert_eq!(args[args.len() - 2..], [NO_SHELL_ESCAPE, "doc.tex"], "{args:?}");
    }
    assert!(!flag_enables_shell_escape("-no-shell-escape"));
    assert!(!flag_enables_shell_escape("--disable-write18"));
}

#[test]
fn filter_extra_flags_strips_shell_escape() {
    // User-supplied extra flags must never smuggle in shell-escape, in any
    // of its spellings. Benign flags pass through unchanged.
    let input: Vec<String> = vec![
        "-shell-escape".into(),
        "--shell-escape".into(),
        "-enable-write18".into(),
        "-shell-escape=1".into(),
        "-synctex=1".into(),
        "-file-line-error".into(),
    ];
    let kept = filter_extra_flags(&input);
    assert!(
        !kept.iter().any(|f| flag_enables_shell_escape(f)),
        "filtered flags still enable shell-escape: {kept:?}",
    );
    assert!(kept.contains(&"-synctex=1".to_string()));
    assert!(kept.contains(&"-file-line-error".to_string()));
    assert_eq!(kept.len(), 2, "only the two benign flags survive: {kept:?}");

    // And the filtered flags, when fed into the arg builders, keep the
    // shell-escape invariant — even alongside the benign ones.
    let args = latexmk_args(None, "doc.tex", Some("build"), &kept, None);
    assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
}

#[test]
fn out_dir_maps_to_correct_engine_args() {
    let no_extra: Vec<String> = vec![];
    // latexmk uses -outdir; the engine uses -output-directory.
    let mk = latexmk_args(None, "doc.tex", Some("/tmp/out"), &no_extra, None);
    assert!(
        mk.iter().any(|a| a == "-outdir=/tmp/out"),
        "latexmk should set -outdir: {mk:?}",
    );
    let eng = engine_args("doc.tex", Some("/tmp/out"), &no_extra);
    assert!(
        eng.iter().any(|a| a == "-output-directory=/tmp/out"),
        "engine should set -output-directory: {eng:?}",
    );
    // No out_dir → neither flag appears.
    let mk2 = latexmk_args(None, "doc.tex", None, &no_extra, None);
    assert!(!mk2.iter().any(|a| a.contains("outdir")));
}

#[test]
fn log_shows_shell_escape_distinguishes_restricted() {
    // The safe default (restricted) must NOT trip the warning.
    assert!(!log_shows_shell_escape(
        "This is pdfTeX...\n restricted \\write18 enabled.\n"
    ));
    // Unrestricted enablement trips it.
    assert!(log_shows_shell_escape(
        "This is pdfTeX...\n \\write18 enabled.\n"
    ));
    // An actually-executed external command trips it.
    assert!(log_shows_shell_escape(
        "runsystem(rm -rf /tmp/x)...executed.\n"
    ));
    // A clean build does not.
    assert!(!log_shows_shell_escape(
        "Output written on doc.pdf (1 page).\n"
    ));
}

#[test]
fn aux_needs_bibtex_detects_citations() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-{}"), std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let aux = dir.join("doc.aux");

    fs::write(&aux, "\\relax\n\\citation{knuth}\n").unwrap();
    assert!(aux_needs_bibtex(&aux));

    fs::write(&aux, "\\relax\n").unwrap();
    assert!(!aux_needs_bibtex(&aux));

    // Missing aux → no bibtex pass.
    assert!(!aux_needs_bibtex(&dir.join("missing.aux")));

    let _ = fs::remove_dir_all(&dir);
}

/// The compile environment must keep TeX from hard-wrapping its log at 79
/// columns. That wrapping breaks a source path across two lines, and the
/// `(file … )` nesting is the ONLY thing that says which file a *warning*
/// came from (`-file-line-error` covers errors and nothing else) — so
/// dropping these silently makes every warning in a multi-file document
/// unplaceable in the viewer, with nothing failing. A tripwire over this
/// file's own source, the shape `mail.rs`'s path check already uses.
#[test]
fn compile_env_disables_log_line_wrapping() {
    let src = include_str!("../tex.rs");
    for var in ["max_print_line", "error_line", "half_error_line"] {
        assert!(
            src.contains(&format!("\"{var}\"")),
            "run_in must set {var} so the log's (file …) nesting stays readable",
        );
    }
}

#[test]
fn tail_truncates_to_char_boundary() {
    let short = "ok";
    assert_eq!(tail(short), short);

    let long = "é".repeat(10_000); // multi-byte, > MAX
    let out = tail(&long);
    assert!(out.starts_with("…\n"));
    // The truncated remainder must itself be valid UTF-8 (no split char).
    assert!(out.is_char_boundary(out.len()));
}

#[test]
fn a_deck_figure_compiles_only_from_its_own_unlinked_folder() {
    let dir = tempfile::tempdir().unwrap();
    let figures = dir.path().join("talk.tex-figures");
    std::fs::create_dir(&figures).unwrap();
    let tex = figures.join("f1.tex");
    std::fs::write(&tex, "x").unwrap();
    assert_eq!(own_folder_unlinked_check(&tex), Ok(()));
    assert!(own_folder_unlinked_check(&figures.join("EVIL~1.TEX")).unwrap_err().contains('~'));
    assert!(own_folder_unlinked_check(&figures.join("missing.tex")).is_err());
    #[cfg(unix)]
    {
        // The figure folder pointed at a sibling project: refused, even
        // though the sibling holds a `.tex` of that name.
        let sibling = dir.path().join("sibling");
        std::fs::create_dir(&sibling).unwrap();
        std::fs::write(sibling.join("paper.tex"), "x").unwrap();
        let linked = dir.path().join("other.tex-figures");
        std::os::unix::fs::symlink(&sibling, &linked).unwrap();
        assert!(own_folder_unlinked_check(&linked.join("paper.tex")).unwrap_err().contains("is a link"));
        // A linked leaf in a real folder: refused too.
        std::os::unix::fs::symlink(sibling.join("paper.tex"), figures.join("paper.tex")).unwrap();
        assert!(own_folder_unlinked_check(&figures.join("paper.tex")).is_err());
    }
}

#[test]
fn compile_tex_rejects_non_tex() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-nt-{}"), std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let txt = dir.join("notes.txt");
    fs::write(&txt, "hi").unwrap();
    // The blocking body, not the async command wrapper: the rejection is the
    // body's, and testing it here keeps this a plain synchronous test.
    let err =
        compile_tex_blocking(txt.to_string_lossy().into_owned(), None, None, None).unwrap_err();
    assert!(err.contains("not a .tex file"), "got: {err}");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn arg_builders_always_emit_synctex() {
    let no_extra: Vec<String> = vec![];
    let mk = latexmk_args(None, "doc.tex", None, &no_extra, None);
    assert!(mk.iter().any(|a| a == "-synctex=1"), "latexmk: {mk:?}");
    let eng = engine_args("doc.tex", None, &no_extra);
    assert!(eng.iter().any(|a| a == "-synctex=1"), "engine: {eng:?}");
}

#[test]
fn arg_builders_always_emit_file_line_error() {
    // `-file-line-error` makes the engine print `file:line: message`, which the
    // viewer parses for jump-to-error. Both build paths must request it.
    let no_extra: Vec<String> = vec![];
    let mk = latexmk_args(None, "doc.tex", None, &no_extra, None);
    assert!(
        mk.iter().any(|a| a == "-file-line-error"),
        "latexmk: {mk:?}"
    );
    let eng = engine_args("doc.tex", None, &no_extra);
    assert!(
        eng.iter().any(|a| a == "-file-line-error"),
        "engine: {eng:?}"
    );
}

#[test]
fn parse_includes_finds_tex_children() {
    let src = "\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\include{chapters/two.tex}\n\\includegraphics{fig.png}\n\\end{document}\n";
    let inc = parse_includes(src);
    assert_eq!(
        inc,
        vec!["intro.tex".to_string(), "chapters/two.tex".to_string()]
    );
}

#[test]
fn scan_tex_includes_recurses() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-scan-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("chapters")).unwrap();
    let root = dir.join("main.tex");
    fs::write(&root, "\\input{chapters/one}\n").unwrap();
    fs::write(dir.join("chapters/one.tex"), "\\input{../two}\n").unwrap();
    fs::write(dir.join("two.tex"), "no includes\n").unwrap();

    let found = scan_tex_includes(&root);
    let names: std::collections::HashSet<String> = found
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(names.contains("one.tex"), "got: {names:?}");
    assert!(names.contains("two.tex"), "got: {names:?}");
    let _ = fs::remove_dir_all(&dir);
}

/// A root map that does not parse stays as it is instead of being replaced
/// by this one compile's entries; a readable one gains them.
#[test]
fn record_root_mappings_leaves_an_unreadable_map_alone() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("main.tex");
    fs::write(&root, "\\input{one}\n").unwrap();
    fs::write(tmp.path().join("one.tex"), "no includes\n").unwrap();
    let map_path = tmp.path().join("tex_roots.json");
    fs::write(&map_path, "{\"a\":").unwrap();
    record_root_mappings_in(&map_path, &root);
    assert_eq!(fs::read_to_string(&map_path).unwrap(), "{\"a\":");

    fs::write(&map_path, "{\"elsewhere.tex\":\"other.tex\"}").unwrap();
    record_root_mappings_in(&map_path, &root);
    let map: std::collections::HashMap<String, String> = crate::storage::read_json(&map_path).unwrap();
    assert_eq!(map.len(), 2, "{map:?}");
    assert_eq!(map["elsewhere.tex"], "other.tex");
}

#[test]
fn magic_root_reads_tex_root_comment() {
    let dir = std::env::temp_dir();
    let root = magic_root(
        "% !TEX root = ../main.tex\n\\section{x}\n",
        Path::new("/proj/chapters"),
    );
    assert!(root.is_some());
    assert!(root.unwrap().to_string_lossy().ends_with("main.tex"));
    // Case-insensitive and colon form.
    assert!(magic_root("%!tex root: book.tex\n", &dir).is_some());
    // No magic comment → None.
    assert!(magic_root("\\documentclass{article}\n", &dir).is_none());
}

#[test]
fn resolve_tex_root_prefers_magic_comment() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-tex-root-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let main = dir.join("main.tex");
    fs::write(&main, "\\input{child}\n").unwrap();
    let child = dir.join("child.tex");
    let main_disp = fs::canonicalize(&main).unwrap();
    fs::write(
        &child,
        format!("% !TEX root = {}\n\\section{{x}}\n", main_disp.display()),
    )
    .unwrap();

    let resolved = resolve_tex_root(child.to_string_lossy().into_owned()).unwrap();
    assert_eq!(resolved, main_disp.to_string_lossy());

    // A file that is its own root resolves to itself.
    let solo = resolve_tex_root(main.to_string_lossy().into_owned()).unwrap();
    assert_eq!(solo, main_disp.to_string_lossy());
    let _ = fs::remove_dir_all(&dir);
}

// ── Cached document preambles (full compiles) ───────────────────────────

#[test]
fn a_doc_head_needs_a_body_marker() {
    assert_eq!(
        doc_preamble_head("\\documentclass{a}\n\\begin{document}x\\end{document}"),
        Some("\\documentclass{a}\n")
    );
    // A fragment has nothing to split at, so nothing to dump.
    assert_eq!(doc_preamble_head("\\section{x}\n"), None);
}

#[test]
fn preamble_deps_name_local_candidates() {
    let head = "\\documentclass[12pt]{myclass}\n\
                    \\usepackage{amsmath, mystyle}\n\
                    \\usepackage[utf8]{inputenc}\n\
                    \\RequirePackage{other}\n\
                    \\input{macros}\n\
                    \\input{defs.tex}\n";
    let deps = preamble_local_dep_names(head);
    assert_eq!(
        deps,
        vec![
            "myclass.cls",
            "amsmath.sty",
            "mystyle.sty",
            "inputenc.sty",
            "other.sty",
            "macros.tex",
            "defs.tex",
        ]
    );
}

#[test]
fn a_doc_format_key_tracks_the_preamble_and_its_local_files() {
    let dir = std::env::temp_dir().join(format!(concat!(crate::app_slug!(), "-docfmt-{}"), std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("macros.tex"), "\\newcommand{\\R}{\\mathbb{R}}\n").unwrap();

    let head = "\\documentclass{article}\n\\input{macros}\n";
    let a = doc_fmt_key("pdflatex", head, &dir);
    // Stable while nothing changed.
    assert_eq!(a, doc_fmt_key("pdflatex", head, &dir));
    // A changed preamble mints a new key…
    assert_ne!(
        a,
        doc_fmt_key("pdflatex", "\\documentclass{book}\n\\input{macros}\n", &dir)
    );
    // …and so does editing a local file the preamble reads: a dump rendered
    // against stale macros would be a wrong PDF, not a wrong hover card.
    fs::write(dir.join("macros.tex"), "\\newcommand{\\R}{\\mathbb{C}}\n").unwrap();
    assert_ne!(a, doc_fmt_key("pdflatex", head, &dir));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn the_latexmk_fmt_override_keeps_every_invariant() {
    let no_extra: Vec<String> = vec![];
    let args = latexmk_args(None, "doc.tex", None, &no_extra, Some("doc-pdflatex-0a-12"));
    // The override names the key, never a path (latexmk re-splits this
    // string on whitespace; the directory travels via TEXFORMATS), and
    // stands before user extras so a user's own -pdflatex wins.
    assert!(args
        .iter()
        .any(|a| a == "-pdflatex=pdflatex -fmt=doc-pdflatex-0a-12 %O %S"));
    assert!(!args.iter().any(|a| flag_enables_shell_escape(a)));
    // Without a key the args are exactly the old ones.
    assert!(!latexmk_args(None, "doc.tex", None, &no_extra, None)
        .iter()
        .any(|a| a.starts_with("-pdflatex=")));
}

#[test]
fn a_compile_format_error_includes_the_not_found_shape() {
    // Everything the preview treats as a dead dump…
    assert!(compile_log_is_format_error(
        "(Fatal format file error; I'm stymied)"
    ));
    // …plus the shape only the full compile can hit: an engine that ignores
    // TEXFORMATS never finds the key at all.
    assert!(compile_log_is_format_error(
        "I can't find the format file `doc-pdflatex-0a-12.fmt'!"
    ));
    // A document's own error must NOT earn a second full run — that would
    // double every typo's feedback loop.
    assert!(!compile_log_is_format_error("! Undefined control sequence."));
}

#[test]
fn texformats_ends_with_the_default_slot() {
    // The trailing separator is kpathsea's "insert the default path here";
    // without it the engine would find OUR formats and nothing else.
    let sep = if cfg!(windows) { ';' } else { ':' };
    assert!(texformats_search_path().ends_with(sep));
}
