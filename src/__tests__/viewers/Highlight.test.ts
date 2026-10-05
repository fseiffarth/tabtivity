import { describe, expect, it } from "vitest";
import { HIGHLIGHT_MAX_CHARS, escapeHtml, highlight, languageForPath, type Lang } from "../../lib/viewers/highlight";
import { BRAND } from "../../lib/brand";

describe("languageForPath", () => {
  it("maps extensions to languages", () => {
    expect(languageForPath("/a/b/main.rs")).toBe("rust");
    expect(languageForPath("script.py")).toBe("python");
    expect(languageForPath("app.tsx")).toBe("tsx");
    expect(languageForPath("app.ts")).toBe("ts");
    expect(languageForPath("lib.mts")).toBe("ts");
    expect(languageForPath("app.jsx")).toBe("jsx");
    expect(languageForPath("main.cpp")).toBe("cpp");
    expect(languageForPath("kernel.cu")).toBe("cpp");
    expect(languageForPath("main.c")).toBe("c");
    expect(languageForPath("App.java")).toBe("java");
    expect(languageForPath("Program.cs")).toBe("csharp");
    expect(languageForPath("build.gradle.kts")).toBe("kotlin");
    expect(languageForPath("app.rb")).toBe("ruby");
    expect(languageForPath("init.lua")).toBe("lua");
    expect(languageForPath("Main.hs")).toBe("haskell");
    expect(languageForPath("data.json")).toBe("json");
    expect(languageForPath("page.html")).toBe("markup");
    expect(languageForPath("icon.svg")).toBe("markup");
    expect(languageForPath("style.scss")).toBe("css");
    expect(languageForPath("paper.tex")).toBe("tex");
    expect(languageForPath("macros.sty")).toBe("tex");
    expect(languageForPath("README.md")).toBe("markdown");
    expect(languageForPath("notes.markdown")).toBe("markdown");
  });

  it("maps well-known extensionless filenames", () => {
    expect(languageForPath("/proj/Dockerfile")).toBe("shell");
    expect(languageForPath(".gitignore")).toBe("shell");
    expect(languageForPath("/proj/Makefile")).toBe("shell");
    expect(languageForPath("/proj/Gemfile")).toBe("ruby");
  });

  it("returns plain for unknown or binary-ish names", () => {
    expect(languageForPath("notes")).toBe("plain");
    expect(languageForPath("archive.bin")).toBe("plain");
  });
});

describe("highlight", () => {
  it("returns null for oversized input, plain text included", () => {
    expect(highlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "js")).toBeNull();
    expect(highlight("x".repeat(HIGHLIGHT_MAX_CHARS + 1), "plain")).toBeNull();
  });

  it("leaves prose in plain text untouched but escaped", () => {
    expect(highlight("just <words> here", "plain")).toBe("just &lt;words&gt; here");
  });

  it("marks plain-text structure: headings, rules, bullets, keys", () => {
    const html = highlight("Title\n=====\n# Notes\n- item 3\nname: Ada", "plain")!;
    expect(html).toContain('<span class="tok-txt-heading">Title</span>');
    expect(html).toContain('<span class="tok-txt-rule">=====</span>');
    expect(html).toContain('<span class="tok-txt-heading"># Notes</span>');
    expect(html).toContain('<span class="tok-txt-list">-</span> item <span class="tok-txt-num">3</span>');
    expect(html).toContain('<span class="tok-txt-key">name</span>: Ada');
  });

  it("marks plain-text inline tokens: urls, dates, quotes, levels, numbers", () => {
    const html = highlight(
      'ERROR 2024-05-01 12:30 see https://x.org/a "quoted" TODO 42% WARN ada@example.com',
      "plain",
    )!;
    expect(html).toContain('<span class="tok-txt-bad">ERROR</span>');
    expect(html).toContain('<span class="tok-txt-date">2024-05-01 12:30</span>');
    expect(html).toContain('<span class="tok-txt-url">https://x.org/a</span>');
    expect(html).toContain('<span class="tok-txt-string">&quot;quoted&quot;</span>');
    expect(html).toContain('<span class="tok-txt-marker">TODO</span>');
    expect(html).toContain('<span class="tok-txt-num">42%</span>');
    expect(html).toContain('<span class="tok-txt-warn">WARN</span>');
    expect(html).toContain('<span class="tok-txt-url">ada@example.com</span>');
  });

  it("does not colour digits inside a word", () => {
    expect(highlight("v1.2 abc123", "plain")).toBe("v1.2 abc123");
  });

  it("stays fast on one huge line with unclosed quotes and at-less words", () => {
    const line = ('"' + "a".repeat(50)).repeat(3000);
    const t0 = performance.now();
    expect(highlight(line, "plain")).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it("wraps keywords, strings, comments, and numbers in token spans", () => {
    const html = highlight('const x = 42; // hi\nconst s = "hello";', "js")!;
    expect(html).toContain('<span class="tok-keyword">const</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    expect(html).toContain('<span class="tok-comment">// hi</span>');
    expect(html).toContain('<span class="tok-string">&quot;hello&quot;</span>');
  });

  it("colours function calls and capitalised types", () => {
    const html = highlight("foo(Bar)", "js")!;
    expect(html).toContain('<span class="tok-func">foo</span>');
    expect(html).toContain('<span class="tok-type">Bar</span>');
  });

  it("treats JSON object keys as props, not strings", () => {
    const html = highlight(`{ "name": "${BRAND.slug}" }`, "json")!;
    expect(html).toContain('<span class="tok-prop">&quot;name&quot;</span>');
    expect(html).toContain(`<span class="tok-string">&quot;${BRAND.slug}&quot;</span>`);
  });

  it("escapes HTML so source can never inject markup", () => {
    const html = highlight("x = '<img src=x onerror=alert(1)>'", "js")!;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("highlights markup tags, attributes, and comments", () => {
    const html = highlight('<!-- c --><a href="x">t</a>', "markup")!;
    expect(html).toContain('<span class="tok-comment">&lt;!-- c --&gt;</span>');
    expect(html).toContain('<span class="tok-tag">a</span>');
    expect(html).toContain('<span class="tok-attr">href</span>');
    expect(html).toContain('<span class="tok-string">&quot;x&quot;</span>');
  });

  it("highlights TeX commands, comments, and environment names", () => {
    const html = highlight("\\section{Intro} % note\n\\begin{itemize}", "tex")!;
    expect(html).toContain('<span class="tok-keyword tok-section">\\section</span>');
    expect(html).toContain('<span class="tok-comment">% note</span>');
    expect(html).toContain('<span class="tok-keyword">\\begin</span>');
    expect(html).toContain('<span class="tok-type">itemize</span>');
  });

  it("greys a whole \\begin{comment} block, delimiters included", () => {
    const html = highlight(
      "\\begin{comment}\n\\section{Dropped}\n\\end{comment}\n\\section{Kept}",
      "tex",
    )!;
    expect(html).toContain(
      '<span class="tok-comment">\\begin{comment}\n\\section{Dropped}\n\\end{comment}</span>',
    );
    // Nothing inside is tokenized; the section AFTER the block still is.
    expect(html).not.toContain('<span class="tok-arg">Dropped</span>');
    expect(html).toContain('<span class="tok-arg">Kept</span>');
  });

  it("greys an unclosed comment block to the end of the file", () => {
    const html = highlight("a\n\\begin{comment}\n\\section{x}", "tex")!;
    expect(html).toBe('a\n<span class="tok-comment">\\begin{comment}\n\\section{x}</span>');
  });

  it("colours other environments as before — only `comment` greys out", () => {
    const html = highlight("\\begin{itemize}\n\\item a\n\\end{itemize}", "tex")!;
    expect(html).toContain('<span class="tok-type">itemize</span>');
    expect(html).not.toContain("tok-comment");
  });

  it("colours a beamer overlay spec glued to a command as its own token", () => {
    const html = highlight("\\only<2->{x} \\item<3> y \\begin{frame}<1->", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\only</span><span class="tok-overlay">&lt;2-&gt;</span>');
    expect(html).toContain('<span class="tok-keyword">\\item</span><span class="tok-overlay">&lt;3&gt;</span>');
    expect(html).toContain('<span class="tok-type">frame</span>}<span class="tok-overlay">&lt;1-&gt;</span>');
    // The argument after the spec still highlights as one.
    expect(html).toContain('<span class="tok-arg">x</span>');
  });

  it("leaves a `<` that is prose or math alone", () => {
    const html = highlight("$a<b$ \\vec<a> and \\only <2>", "tex")!;
    expect(html).not.toContain("tok-overlay");
  });

  it("treats an escaped percent as a command, not a comment", () => {
    const html = highlight("50\\% done", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\%</span>');
    expect(html).not.toContain('tok-comment');
  });

  it("renders a TeX command's brace argument italic, braces excluded", () => {
    const html = highlight("\\emph{Intro}", "tex")!;
    expect(html).toBe(
      '<span class="tok-keyword">\\emph</span>{<span class="tok-arg">Intro</span>}',
    );
  });

  it("tags a sectioning command so its title can read as a heading", () => {
    const html = highlight("\\section{Intro}", "tex")!;
    expect(html).toBe(
      '<span class="tok-keyword tok-section">\\section</span>{<span class="tok-arg">Intro</span>}',
    );
  });

  it("wraps TeX math in one token and keeps tokenizing inside it", () => {
    const html = highlight("a $\\frac{1}{2}$ b", "tex")!;
    expect(html).toContain('<span class="tok-math">$<span class="tok-keyword">\\frac</span>');
    expect(html).toContain('<span class="tok-num">1</span>');
    expect(html).toContain("$</span> b");
    expect(highlight("$$x$$", "tex")).toBe('<span class="tok-math">$$x$$</span>');
    expect(highlight("\\[x\\]", "tex")).toBe('<span class="tok-math">\\[x\\]</span>');
    expect(highlight("\\(x\\)", "tex")).toBe('<span class="tok-math">\\(x\\)</span>');
  });

  it("leaves an unclosed or paragraph-spanning dollar plain", () => {
    expect(highlight("costs $5\n\nlater $x", "tex")).not.toContain("tok-math");
    expect(highlight("\\$5 and \\$6", "tex")).not.toContain("tok-math");
    expect(highlight("$a % $ in a comment\nb$", "tex")).toContain(
      '<span class="tok-comment">% $ in a comment</span>',
    );
  });

  it("takes every argument of a multi-argument command, and past an optional one", () => {
    const frac = highlight("\\frac{a}{b}", "tex")!;
    expect(frac).toContain('<span class="tok-arg">a</span>');
    expect(frac).toContain('<span class="tok-arg">b</span>');
    const graphic = highlight("\\includegraphics[width=2cm]{fig.png}", "tex")!;
    expect(graphic).toContain("[width=2cm]");
    expect(graphic).toContain('<span class="tok-arg">fig.png</span>');
  });

  it("keeps tokenizing inside an argument, so a nested command still colours", () => {
    const html = highlight("\\textbf{see \\ref{fig:x} and 42}", "tex")!;
    expect(html).toContain('<span class="tok-keyword">\\ref</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
    // The nested \ref's own argument is italic in its own right (nesting spans).
    expect(html).toContain('<span class="tok-arg">fig:x</span>');
  });

  it("leaves the environment name as a type and a single-char sequence argumentless", () => {
    const env = highlight("\\begin{itemize}", "tex")!;
    expect(env).toContain('<span class="tok-type">itemize</span>');
    expect(env).not.toContain("tok-arg");
    // `\{` is a literal brace; what follows it is text, not its argument.
    expect(highlight("\\{x}", "tex")!).not.toContain("tok-arg");
  });

  it("leaves an unbalanced argument alone", () => {
    const html = highlight("\\emph{unclosed", "tex")!;
    expect(html).not.toContain("tok-arg");
    expect(html).toContain('<span class="tok-keyword">\\emph</span>');
  });

  it("handles Python triple-quoted strings across newlines", () => {
    const html = highlight('x = """line1\nline2"""', "python")!;
    expect(html).toContain('<span class="tok-string">&quot;&quot;&quot;line1\nline2&quot;&quot;&quot;</span>');
  });

  it("highlights markdown headings, emphasis, code, and links", () => {
    const src = "# Title\n**bold** and *em* with `code`\n[text](http://x)";
    const html = highlight(src, "markdown")!;
    expect(html).toContain('<span class="tok-md-heading"># Title</span>');
    expect(html).toContain('<span class="tok-md-strong">**bold**</span>');
    expect(html).toContain('<span class="tok-md-em">*em*</span>');
    expect(html).toContain('<span class="tok-md-code">`code`</span>');
    expect(html).toContain('<span class="tok-md-link">text</span>');
    expect(html).toContain('<span class="tok-md-url">http://x</span>');
  });

  it("highlights markdown fences, blockquotes, and list markers", () => {
    const html = highlight("> quote\n- item\n```\nraw *not em*\n```", "markdown")!;
    expect(html).toContain('<span class="tok-md-quote">&gt; </span>');
    expect(html).toContain('<span class="tok-md-list">-</span>');
    expect(html).toContain('<span class="tok-md-code">```</span>');
    // Content inside a fence is verbatim, not inline-tokenized.
    expect(html).toContain('<span class="tok-md-code">raw *not em*</span>');
  });

  it("does not treat intra-word underscores or spaced asterisks as emphasis", () => {
    const html = highlight("some_var_name and 2 * 3 * 4", "markdown")!;
    expect(html).not.toContain("tok-md-em");
    expect(html).not.toContain("tok-md-strong");
  });
});

describe("escapeHtml", () => {
  it("escapes all five specials in one pass, never double-escaping its own output", () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;",
    );
    for (const [c, e] of [["&", "&amp;"], ["<", "&lt;"], [">", "&gt;"], ['"', "&quot;"], ["'", "&#39;"]]) {
      expect(escapeHtml(c)).toBe(e);
    }
  });

  it("hands back text with nothing to escape unchanged", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("x")).toBe("x");
    expect(escapeHtml("plain prose, no specials")).toBe("plain prose, no specials");
  });

  it("escapes a run the same as its characters one by one", () => {
    const s = `if (a < b && c > "d") return 'e';`;
    expect(escapeHtml(s)).toBe([...s].map(escapeHtml).join(""));
  });
});

describe("highlight — prose runs", () => {
  // The TeX and markdown scanners take a run of plain text in one piece; the
  // run must stop at exactly the characters that can open a token, and still
  // escape what it carries.
  it("ends a TeX prose run at a command, a comment, math and a number", () => {
    const html = highlight(`a < b & "c" \\emph{x} d 12 e $y$ f % g`, "tex")!;
    expect(html).toBe(
      "a &lt; b &amp; &quot;c&quot; " +
        '<span class="tok-keyword">\\emph</span>{<span class="tok-arg">x</span>}' +
        ' d <span class="tok-num">12</span> e ' +
        '<span class="tok-math">$y$</span> f <span class="tok-comment">% g</span>',
    );
  });

  it("ends a markdown prose run at every inline opener", () => {
    const html = highlight("a<b `c` d [e](f) g *h* i_j k", "markdown")!;
    expect(html).toBe(
      'a&lt;b <span class="tok-md-code">`c`</span> d [<span class="tok-md-link">e</span>](' +
        '<span class="tok-md-url">f</span>) g <span class="tok-md-em">*h*</span> i_j k',
    );
  });

  it("passes whitespace runs through code untouched", () => {
    expect(highlight("let  x\t=\n\n  1;", "js")).toBe(
      '<span class="tok-keyword">let</span>  x\t=\n\n  <span class="tok-num">1</span>;',
    );
  });
});

/** The text a highlighted HTML string displays: tags dropped, entities undone.
 *  The editor lays this over its <textarea>, so it must equal the source. */
function shownText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// The samples below are source code in other languages, so `${…}` inside a plain
// string is the point, not a mistyped template literal.
/* eslint-disable no-template-curly-in-string */
describe("per-language code highlighting", () => {
  const SAMPLES: [Lang, string][] = [
    ["ts", 'type A = { n: number };\n@Component({ a: 1 })\nclass B implements A { readonly n = 1 / 2; }\nconst r = /["\\/]+/g.test(`x ${f({ y: "}" })} z`);'],
    ["tsx", 'const App = () => (<div className="a" onClick={() => go(<b/>)}>Hi {name}<Foo.Bar x={1} /></div>);\nconst id = <T,>(x: T) => x;\nif (a < b && c > d) {}'],
    ["jsx", "return <>{items.map((i) => <li key={i}>{i}</li>)}</>;"],
    ["cpp", '#include <vector>\n#define N 3\ntemplate <typename T> constexpr auto f(std::vector<T> v) { return nullptr; }'],
    ["c", '#include "x.h"\n  #ifdef X\nint main(void) { return sizeof(int); }'],
    ["java", '@Override\npublic final class A extends B { int x = 0; String s = """\ntext""""; }'],
    ["kotlin", 'val s = "hi $name and ${user.id}"\n@JvmStatic fun f() = 1'],
    ["ruby", 'def hi(name)\n  @count += 1\n  puts "Hi #{name}" if x == :ok\nend'],
    ["lua", "--[[ block\ncomment ]] local x = 1 -- line\nprint(x)"],
    ["haskell", "{- block -}\nmain :: IO ()\nmain = putStrLn \"hi\" -- line\nf x' = x'"],
    ["rust", '#[derive(Debug)]\nfn main<\'a>(x: &\'a str) { println!("{}", \'"\'); let r = br##"a"#b"##; }'],
    ["shell", 'echo "home is $HOME and ${PWD}" $1'],
    ["sql", "SELECT name FROM users WHERE id = 1"],
  ];

  it("keeps the shown text identical to the source for every sample", () => {
    for (const [lang, code] of SAMPLES) {
      expect(shownText(highlight(code, lang)!), lang).toBe(code);
    }
  });

  it("splits TypeScript keywords from JavaScript ones", () => {
    expect(highlight("type", "ts")).toBe('<span class="tok-keyword">type</span>');
    expect(highlight("type", "js")).toBe("type");
    expect(highlight("let n: number", "ts")).toContain('<span class="tok-type">number</span>');
    expect(highlight("let number = 1", "js")).not.toContain("tok-type");
  });

  it("colours decorators, and template interpolation as code", () => {
    const html = highlight("@Input() x = `a ${b + 1} c`;", "ts")!;
    expect(html).toContain('<span class="tok-attr">@Input</span>');
    expect(html).toContain('<span class="tok-string">`a </span><span class="tok-keyword">${</span>b + <span class="tok-num">1</span><span class="tok-keyword">}</span><span class="tok-string"> c`</span>');
  });

  it("reads a regex literal as one token, so a quote inside it opens no string", () => {
    const html = highlight('const r = /"/; const s = 1;', "ts")!;
    expect(html).toContain('<span class="tok-string">/&quot;/</span>');
    expect(html).toContain('<span class="tok-keyword">const</span> s');
    // Division stays division.
    expect(highlight("a / b / c", "js")).toBe("a / b / c");
  });

  it("highlights JSX tags, components and attributes in .tsx, not TS generics", () => {
    const html = highlight('const x = <div id="a"><Btn on={f} /></div>;', "tsx")!;
    expect(html).toContain('<span class="tok-tag">div</span>');
    expect(html).toContain('<span class="tok-type">Btn</span>');
    expect(html).toContain('<span class="tok-attr">on</span>');
    expect(highlight("const f = <T,>(x: T) => x;", "tsx")).not.toContain("tok-tag");
    expect(highlight("a < b", "tsx")).toBe("a &lt; b");
    // Plain .ts never reads `<` as JSX.
    expect(highlight("const x = <div/>;", "ts")).not.toContain("tok-tag");
  });

  it("marks C preprocessor lines and included headers", () => {
    const html = highlight("#include <stdio.h>\nint x = a #b;", "c")!;
    expect(html).toContain('<span class="tok-keyword">#include</span> <span class="tok-string">&lt;stdio.h&gt;</span>');
    expect(html).toContain('<span class="tok-type">int</span>');
  });

  it("gives C++ its own keywords and C only C's", () => {
    expect(highlight("template", "cpp")).toBe('<span class="tok-keyword">template</span>');
    expect(highlight("template", "c")).toBe("template");
  });

  it("matches SQL keywords in any case without calling them types", () => {
    expect(highlight("SELECT a", "sql")).toBe('<span class="tok-keyword">SELECT</span> a');
  });

  it("tries Lua's block comment before its line comment", () => {
    expect(highlight("--[[ a\nb ]]x", "lua")).toBe('<span class="tok-comment">--[[ a\nb ]]</span>x');
  });

  it("marks Ruby symbols, instance variables and interpolation", () => {
    const html = highlight('@n = :ok; "a #{b}"', "ruby")!;
    expect(html).toContain('<span class="tok-attr">@n</span>');
    expect(html).toContain('<span class="tok-prop">:ok</span>');
    expect(html).toContain('<span class="tok-keyword">#{</span>b<span class="tok-keyword">}</span>');
  });

  it("marks Rust attributes and macro calls", () => {
    const html = highlight('#[derive(Debug)] println!("x")', "rust")!;
    expect(html).toContain('<span class="tok-attr">#[derive(Debug)]</span>');
    expect(html).toContain('<span class="tok-func">println</span>!');
  });

  it("tells Rust char literals from lifetimes, so a quote char opens no string", () => {
    const html = highlight("fn f<'a>(s: &'a str) -> char { if s == \"\" { '\"' } else { '\\n' } }", "rust")!;
    expect(html).toContain('<span class="tok-type">&#39;a</span>');
    expect(html).toContain('<span class="tok-string">&#39;&quot;&#39;</span>');
    expect(html).toContain('<span class="tok-string">&#39;\\n&#39;</span>');
    expect(html).toContain("<span class=\"tok-keyword\">else</span>");
    expect(highlight("'outer: loop {}", "rust")).toContain('<span class="tok-type">&#39;outer</span>');
  });

  it("reads Rust raw strings whole, and plain strings across lines", () => {
    expect(highlight('r#"say "hi" \\"#; x', "rust")).toBe('<span class="tok-string">r#&quot;say &quot;hi&quot; \\&quot;#</span>; x');
    expect(highlight('"a\nb" x', "rust")).toBe('<span class="tok-string">&quot;a\nb&quot;</span> x');
  });

  it("marks macro_rules! and vec! as macros but not a != comparison", () => {
    expect(highlight("macro_rules! m", "rust")).toContain('<span class="tok-func">macro_rules</span>!');
    expect(highlight("vec![1]", "rust")).toContain('<span class="tok-func">vec</span>!');
    expect(highlight("a!=b", "rust")).toBe("a!=b");
  });

  it("survives deeply nested template interpolation", () => {
    const code = "`${".repeat(200) + "x" + "}`".repeat(200);
    expect(shownText(highlight(code, "ts")!)).toBe(code);
  });
});
/* eslint-enable no-template-curly-in-string */
