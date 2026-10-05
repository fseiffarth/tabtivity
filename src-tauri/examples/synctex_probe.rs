//! Reverse-search probe: resolve points on a compiled PDF to source lines,
//! headlessly, so the answer can be checked against the document without a
//! window and without clicking.
//!
//! ```sh
//! cargo run --example synctex_probe -- <file.pdf> <page> <x> <y> [<x> <y> …]
//! ```
//!
//! Coordinates are big points from the page's **top-left** — the same unit the
//! PDF viewer sends and `synctex edit -o page:x:y:file` takes, so a probe here
//! and a `synctex edit` on the same numbers are directly comparable. That
//! comparison is the point: the CLI answers a click off the glyphs with the
//! enclosing box's tag, which pdfTeX labels with wherever `\par` fired, and this
//! is how the two were measured against each other on a real build.

use std::path::Path;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 4 || !(args.len() - 2).is_multiple_of(2) {
        eprintln!("usage: synctex_probe <file.pdf> <page> <x> <y> [<x> <y> …]");
        std::process::exit(2);
    }
    let pdf = Path::new(&args[0]);
    let page: u32 = args[1].parse().expect("page must be a number");

    for pair in args[2..].chunks(2) {
        let x: f64 = pair[0].parse().expect("x must be a number");
        let y: f64 = pair[1].parse().expect("y must be a number");
        match app_lib::commands::synctex::resolve(pdf, page, x, y) {
            Some((input, line)) => println!("{x:>8.2} {y:>8.2} -> {input}:{line}"),
            None => println!("{x:>8.2} {y:>8.2} -> (no answer)"),
        }
    }
}
