import { describe, it, expect } from "vitest";
import {
  internalViewerFor,
  disabledViewers,
  isDeferredOfficeFile,
  type FileEntry,
  type InternalViewer,
} from "../../lib/viewers/fileUtils";

function file(name: string, extension: string | null): FileEntry {
  return { name, path: `/p/${name}`, is_dir: false, size: 1, extension, mime: null };
}

describe("internalViewerFor", () => {
  it("maps PDFs to the pdf viewer", () => {
    expect(internalViewerFor(file("doc.pdf", ".pdf"))).toBe("pdf");
  });

  it("maps markdown extensions to the markdown viewer", () => {
    expect(internalViewerFor(file("README.md", ".md"))).toBe("markdown");
    expect(internalViewerFor(file("notes.markdown", ".markdown"))).toBe("markdown");
  });

  it("maps common text/code extensions to the text viewer", () => {
    expect(internalViewerFor(file("main.rs", ".rs"))).toBe("text");
    expect(internalViewerFor(file("notes.txt", ".txt"))).toBe("text");
    expect(internalViewerFor(file("Cargo.toml", ".toml"))).toBe("text");
  });

  it("maps YAML and JSON to the structure tree (#yaml)", () => {
    // JSON is YAML's flow syntax, so both open in the same tree — with Source as
    // the same code editor they used to open in.
    expect(internalViewerFor(file("config.yaml", ".yaml"))).toBe("yaml");
    expect(internalViewerFor(file("config.yml", ".yml"))).toBe("yaml");
    expect(internalViewerFor(file("data.json", ".json"))).toBe("yaml");
  });

  it("falls back to the plain editor when the tree is opted out (#48)", () => {
    // Turning off the tree is a vote against the tree, not against editing YAML
    // in Tabtivity — so it drops back to the code editor, not to an external app.
    expect(internalViewerFor(file("data.json", ".json"), new Set(["yaml"] as const))).toBe("text");
    expect(internalViewerFor(file("c.yaml", ".yaml"), new Set(["yaml", "text"] as const))).toBeNull();
  });

  it("maps well-known extensionless filenames to the text viewer", () => {
    expect(internalViewerFor(file("Dockerfile", null))).toBe("text");
    expect(internalViewerFor(file("LICENSE", null))).toBe("text");
  });

  it("maps raster images to the image viewer", () => {
    expect(internalViewerFor(file("photo.png", ".png"))).toBe("image");
    expect(internalViewerFor(file("photo.jpg", ".jpg"))).toBe("image");
    expect(internalViewerFor(file("photo.jpeg", ".jpeg"))).toBe("image");
  });

  it("maps .gif to the animated-GIF viewer (wins over the generic image viewer)", () => {
    expect(internalViewerFor(file("anim.gif", ".gif"))).toBe("gif");
    // Opting the transport out (#48) degrades to the image viewer — the webview
    // still animates <img> GIFs natively, it just loses frame control.
    expect(internalViewerFor(file("anim.gif", ".gif"), new Set(["gif"] as const))).toBe("image");
    expect(
      internalViewerFor(file("anim.gif", ".gif"), new Set(["gif", "image"] as const)),
    ).toBeNull();
    const disabled = disabledViewers({ gif: { enabled: false } });
    expect(disabled.has("gif")).toBe(true);
    expect(internalViewerFor(file("anim.gif", ".gif"), disabled)).toBe("image");
  });

  it("maps .html/.htm/.svg to the rendered-preview viewer (wins over text)", () => {
    expect(internalViewerFor(file("page.html", ".html"))).toBe("html");
    expect(internalViewerFor(file("page.htm", ".htm"))).toBe("html");
    expect(internalViewerFor(file("icon.svg", ".svg"))).toBe("html");
    // Opting the viewer out (#48) falls through (SVG XML stays openable
    // externally rather than as the in-app preview).
    expect(internalViewerFor(file("icon.svg", ".svg"), new Set(["html"]))).toBeNull();
  });

  it("maps audio/video to the media player", () => {
    expect(internalViewerFor(file("song.mp3", ".mp3"))).toBe("media");
    expect(internalViewerFor(file("clip.mp4", ".mp4"))).toBe("media");
    expect(internalViewerFor(file("clip.webm", ".webm"))).toBe("media");
  });

  it("maps SQLite databases to the sqlite browser", () => {
    expect(internalViewerFor(file("app.db", ".db"))).toBe("sqlite");
    expect(internalViewerFor(file("app.sqlite", ".sqlite"))).toBe("sqlite");
    expect(internalViewerFor(file("app.sqlite3", ".sqlite3"))).toBe("sqlite");
  });

  it("maps spreadsheets to the table viewer (no longer deferred)", () => {
    expect(internalViewerFor(file("book.xlsx", ".xlsx"))).toBe("table");
    expect(internalViewerFor(file("book.xls", ".xls"))).toBe("table");
  });

  it("maps .tex to the dedicated LaTeX viewer", () => {
    expect(internalViewerFor(file("paper.tex", ".tex"))).toBe("tex");
  });

  it('never auto-selects "texworkspace" by extension (it is chosen at the open site)', () => {
    // The workspace is a distinct InternalViewer value, but extension routing
    // still resolves a `.tex` to the standalone "tex" viewer — the upgrade to a
    // workspace happens in `openTexWorkspace`, never here. This keeps the
    // standalone path (and its tests) byte-for-byte intact.
    const v: InternalViewer = "texworkspace"; // compiles ⇒ it is a valid member
    expect(v).toBe("texworkspace");
    expect(internalViewerFor(file("paper.tex", ".tex"))).not.toBe("texworkspace");
    // Opting `tex` out is unrelated to the workspace value and just falls through.
    expect(internalViewerFor(file("paper.tex", ".tex"), new Set(["tex"] as const))).not.toBe(
      "texworkspace",
    );
  });

  it("maps .bib to the bibliography card view (wins over generic text)", () => {
    expect(internalViewerFor(file("refs.bib", ".bib"))).toBe("bib");
    expect(internalViewerFor(file("refs.bibtex", ".bibtex"))).toBe("bib");
    // Opting the cards out lands on the plain code editor — where a `.bib` opened
    // before the card view existed — not on the external app.
    expect(internalViewerFor(file("refs.bib", ".bib"), new Set(["bib"] as const))).toBe("text");
    expect(
      internalViewerFor(file("refs.bib", ".bib"), new Set(["bib", "text"] as const)),
    ).toBeNull();
  });

  it("maps .csv/.tsv to the table viewer (wins over generic text)", () => {
    expect(internalViewerFor(file("data.csv", ".csv"))).toBe("table");
    expect(internalViewerFor(file("data.tsv", ".tsv"))).toBe("table");
  });

  it("maps .ipynb to the notebook viewer", () => {
    expect(internalViewerFor(file("nb.ipynb", ".ipynb"))).toBe("notebook");
  });

  it("maps .diff/.patch to the diff viewer (wins over generic text)", () => {
    expect(internalViewerFor(file("change.diff", ".diff"))).toBe("diff");
    expect(internalViewerFor(file("change.patch", ".patch"))).toBe("diff");
  });

  it("returns null for non-viewable binaries and directories", () => {
    expect(internalViewerFor(file("app.bin", ".bin"))).toBeNull();
    expect(internalViewerFor(file("lib.so", ".so"))).toBeNull();
    expect(internalViewerFor({ ...file("src", null), is_dir: true })).toBeNull();
  });

  it("maps .odt to the OpenDocument Text viewer (#51 lightweight)", () => {
    expect(internalViewerFor(file("report.odt", ".odt"))).toBe("odt");
    // Opting the viewer out (#48) falls through to the external-app path.
    expect(internalViewerFor(file("report.odt", ".odt"), new Set(["odt"]))).toBeNull();
  });

  it("DEFERRED (#51): remaining word-processing/presentation formats open externally", () => {
    // DECISION B: .docx/.pptx/.ods/.odp rendering is still deferred; these resolve
    // to null so they fall through to the external-app path.
    expect(internalViewerFor(file("doc.docx", ".docx"))).toBeNull();
    expect(internalViewerFor(file("slides.pptx", ".pptx"))).toBeNull();
    expect(internalViewerFor(file("sheet.ods", ".ods"))).toBeNull();
    // …and they are recognised as deferred office files, not generic binaries.
    expect(isDeferredOfficeFile(file("doc.docx", ".docx"))).toBe(true);
    expect(isDeferredOfficeFile(file("sheet.ods", ".ods"))).toBe(true);
    expect(isDeferredOfficeFile(file("main.rs", ".rs"))).toBe(false);
  });
});

describe("internalViewerFor opt-out (#48)", () => {
  it("returns null for a type the user disabled so it opens externally", () => {
    const disabled = new Set(["pdf" as const]);
    expect(internalViewerFor(file("doc.pdf", ".pdf"), disabled)).toBeNull();
    // other types are unaffected by a pdf-only opt-out
    expect(internalViewerFor(file("main.rs", ".rs"), disabled)).toBe("text");
  });

  it("renders normally when the disabled set is empty or omitted", () => {
    expect(internalViewerFor(file("doc.pdf", ".pdf"), new Set())).toBe("pdf");
    expect(internalViewerFor(file("doc.pdf", ".pdf"))).toBe("pdf");
  });
});

describe("disabledViewers (#48)", () => {
  it("treats absent/true prefs as enabled and false as disabled", () => {
    expect(disabledViewers(undefined).size).toBe(0);
    expect(disabledViewers({}).size).toBe(0);
    expect(disabledViewers({ pdf: {} }).size).toBe(0);
    expect(disabledViewers({ pdf: { enabled: true } }).size).toBe(0);
    const off = disabledViewers({ pdf: { enabled: false }, tex: { enabled: false } });
    expect(off.has("pdf")).toBe(true);
    expect(off.has("tex")).toBe(true);
    expect(off.has("text")).toBe(false);
  });

  it("supports opting out the new table/notebook/diff viewers", () => {
    // A disabled type returns null so the file opens externally instead.
    const disabled = disabledViewers({
      table: { enabled: false },
      notebook: { enabled: false },
      diff: { enabled: false },
    });
    expect(disabled.has("table")).toBe(true);
    expect(disabled.has("notebook")).toBe(true);
    expect(disabled.has("diff")).toBe(true);
    expect(internalViewerFor(file("data.csv", ".csv"), disabled)).toBeNull();
    // .ipynb is not in TEXT_EXTS, so opting the notebook viewer out opens it
    // externally rather than falling back to raw text.
    expect(internalViewerFor(file("nb.ipynb", ".ipynb"), disabled)).toBeNull();
    expect(internalViewerFor(file("change.diff", ".diff"), disabled)).toBeNull();
  });
});
