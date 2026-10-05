/**
 * Tests for the starter-LaTeX generator (`lib/viewers/deck/template`).
 *
 * The generator exists so that making a presentation does not require knowing
 * TeX, which means the one thing it must never do is emit something that fails
 * to compile — a broken starter is worse than no starter, because the user has
 * no way to tell whether the deck or their machine is at fault. Hence the escape
 * tests: a project called `R&D 100%` is an ordinary folder name and a LaTeX
 * syntax error.
 */

import { describe, it, expect } from "vitest";
import {
  starterTex,
  starterTexFigure,
  texEscape,
  texPathForDeck,
  titleFromPath,
} from "../../lib/viewers/deck/template";
import { BRAND } from "../../lib/brand";

describe("texEscape", () => {
  it("escapes the characters that would otherwise be LaTeX syntax", () => {
    expect(texEscape("R&D")).toBe("R\\&D");
    expect(texEscape("100%")).toBe("100\\%");
    expect(texEscape("a_b")).toBe("a\\_b");
    expect(texEscape("{x}")).toBe("\\{x\\}");
    expect(texEscape("$5")).toBe("\\$5");
    expect(texEscape("#1")).toBe("\\#1");
  });

  it("escapes backslashes FIRST, so its own escapes are not re-escaped", () => {
    // Getting this order wrong turns `\&` into `\textbackslash{}&` — a classic.
    expect(texEscape("a\\b")).toBe("a\\textbackslash{}b");
    expect(texEscape("&")).toBe("\\&");
  });

  it("handles the two that need a command rather than a backslash", () => {
    expect(texEscape("~")).toBe("\\textasciitilde{}");
    expect(texEscape("^")).toBe("\\textasciicircum{}");
  });

  it("leaves ordinary text completely alone", () => {
    expect(texEscape("A perfectly normal title")).toBe("A perfectly normal title");
  });
});

describe("starterTex", () => {
  it("is a complete, balanced document", () => {
    const tex = starterTex({ title: "Talk" });
    expect(tex).toContain("\\documentclass[aspectratio=169]{beamer}");
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("\\end{document}");
    // Every environment it opens, it closes.
    const opens = (tex.match(/\\begin\{frame\}/g) ?? []).length;
    const closes = (tex.match(/\\end\{frame\}/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThan(1);
  });

  it("routes the title and author through the escaper", () => {
    const tex = starterTex({ title: "R&D: 100% of it", author: "A_B" });
    expect(tex).toContain("\\title{R\\&D: 100\\% of it}");
    expect(tex).toContain("\\author{A\\_B}");
  });

  it("comments out the author line when there is none, rather than emitting an empty one", () => {
    const tex = starterTex({ title: "Talk" });
    expect(tex).not.toMatch(/^\\author\{\}$/m);
    expect(tex).toContain("% \\author{Your name}");
  });

  it("defaults the first section instead of emitting an empty heading", () => {
    expect(starterTex({ title: "T" })).toContain("\\section{Introduction}");
    expect(starterTex({ title: "T", section: "  " })).toContain("\\section{Introduction}");
    expect(starterTex({ title: "T", section: "Method" })).toContain("\\section{Method}");
  });

  it(`says in the file itself that ${BRAND.display} will not write to it again`, () => {
    // The promise this whole path rests on; worth pinning so a later edit to the
    // template cannot quietly drop it.
    expect(starterTex({ title: "T" })).toMatch(/never writes back/i);
  });
});

describe("starterTexFigure", () => {
  it("is a complete, balanced standalone document", () => {
    const tex = starterTexFigure();
    expect(tex).toContain("\\documentclass[border=4pt]{standalone}");
    expect(tex).toContain("\\begin{document}");
    expect(tex).toContain("\\end{document}");
  });

  it(`says ${BRAND.display} will keep the slide's raster in sync on recompile`, () => {
    expect(starterTexFigure()).toMatch(/updates it/i);
  });
});

describe("titleFromPath", () => {
  it("turns a filename into something presentable", () => {
    expect(titleFromPath("/p/my-great-talk.eldeck.json")).toBe("My great talk");
    expect(titleFromPath("/p/my_great_talk.tex")).toBe("My great talk");
    expect(titleFromPath("/p/results.pdf")).toBe("Results");
  });

  it("falls back rather than producing an empty title", () => {
    expect(titleFromPath("/p/.eldeck.json")).toBe("Presentation");
    expect(titleFromPath("")).toBe("Presentation");
  });
});

describe("texPathForDeck", () => {
  it("names the source beside the deck", () => {
    expect(texPathForDeck("/p/talk.eldeck.json")).toBe("/p/talk.tex");
  });
});
