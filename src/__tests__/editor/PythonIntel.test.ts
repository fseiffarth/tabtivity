import { describe, it, expect } from "vitest";
import {
  findDef,
  findPythonDefs,
  isExecutableLine,
  isPythonMainScript,
  isPythonPath,
  modulePathCandidates,
  parsePythonImports,
  pythonImportLinks,
  pythonLibRoots,
  pythonLinkRanges,
  pythonRefAt,
  pythonTokens,
  remapBreakpoints,
  resolvePythonDefinition,
  snapBreakpointLine,
} from "../../lib/viewers/python";

describe("isPythonPath", () => {
  it("accepts python sources and rejects everything else", () => {
    expect(isPythonPath("/a/b/main.py")).toBe(true);
    expect(isPythonPath("/a/b/stub.pyi")).toBe(true);
    expect(isPythonPath("/a/b/MAIN.PY")).toBe(true);
    expect(isPythonPath("/a/b/notes.md")).toBe(false);
    expect(isPythonPath("/a/pyproject.toml")).toBe(false);
  });
});

describe("isPythonMainScript", () => {
  it("accepts the standard module-level guard, either quote style", () => {
    expect(isPythonMainScript('if __name__ == "__main__":\n    main()\n')).toBe(true);
    expect(isPythonMainScript("if __name__ == '__main__':\n    main()\n")).toBe(true);
  });

  it("tolerates extra spacing around the guard", () => {
    expect(isPythonMainScript('if __name__   ==   "__main__" :\n    main()\n')).toBe(true);
  });

  it("rejects a plain module with no entrypoint guard", () => {
    expect(isPythonMainScript("def helper():\n    return 1\n")).toBe(false);
  });

  it("rejects an indented guard (inside a function/class, not module level)", () => {
    expect(isPythonMainScript('def f():\n    if __name__ == "__main__":\n        pass\n')).toBe(false);
  });

  it("rejects mismatched quotes", () => {
    expect(isPythonMainScript("if __name__ == \"__main__':\n    main()\n")).toBe(false);
  });
});

// ── Breakpoints ──────────────────────────────────────────────────────────────

describe("isExecutableLine", () => {
  it("rejects the lines pdb refuses to break on", () => {
    expect(isExecutableLine("x = 1")).toBe(true);
    expect(isExecutableLine("    return x")).toBe(true);
    expect(isExecutableLine("")).toBe(false);
    expect(isExecutableLine("   ")).toBe(false);
    expect(isExecutableLine("# a comment")).toBe(false);
    // A decorator runs at definition time, not at the call — breaking there
    // fires on import, which is never what the click meant.
    expect(isExecutableLine("@lru_cache")).toBe(false);
  });
});

describe("snapBreakpointLine", () => {
  const src = ["# header", "", "import os", "", "", "def f():", "    return 1"].join("\n");

  it("keeps an already-executable line", () => {
    expect(snapBreakpointLine(src, 3)).toBe(3);
    expect(snapBreakpointLine(src, 7)).toBe(7);
  });

  it("snaps a blank or comment line down to the next executable one", () => {
    expect(snapBreakpointLine(src, 1)).toBe(3); // comment → import
    expect(snapBreakpointLine(src, 4)).toBe(6); // blank → def
  });

  it("returns null when nothing below is executable", () => {
    expect(snapBreakpointLine("x = 1\n\n\n", 2)).toBeNull();
  });
});

describe("remapBreakpoints", () => {
  const src = ["import os", "", "def f():", "    return 1", "", "def g():", "    return 2"].join(
    "\n",
  );

  it("is a no-op when the text is unchanged", () => {
    expect(remapBreakpoints(src, src, [4, 7])).toEqual([4, 7]);
  });

  it("shifts breakpoints below an insertion", () => {
    const next = ["import os", "import sys", "", "def f():", "    return 1", "", "def g():", "    return 2"].join("\n");
    // Both defs moved down one line; the dots must follow them.
    expect(remapBreakpoints(src, next, [4, 7])).toEqual([5, 8]);
  });

  it("shifts breakpoints up when lines above are deleted", () => {
    const next = ["def f():", "    return 1", "", "def g():", "    return 2"].join("\n");
    expect(remapBreakpoints(src, next, [4, 7])).toEqual([2, 5]);
  });

  it("leaves breakpoints above an edit alone", () => {
    const next = src.replace("    return 2", "    return 99");
    expect(remapBreakpoints(src, next, [4])).toEqual([4]);
  });

  it("drops a breakpoint whose own line was replaced", () => {
    // Line 4 (`return 1`) is the edited span — the statement it named is gone,
    // so the dot goes with it rather than silently pointing at something else.
    const next = src.replace("    return 1", "    return 1 + 1\n    print('x')");
    expect(remapBreakpoints(src, next, [4, 7])).toEqual([8]);
  });

  it("keeps the result sorted and deduplicated", () => {
    const next = ["def f():", "    return 1", "", "def g():", "    return 2"].join("\n");
    expect(remapBreakpoints(src, next, [7, 4])).toEqual([2, 5]);
  });
});

// ── Lexing ───────────────────────────────────────────────────────────────────

describe("pythonTokens", () => {
  it("skips comments and string bodies", () => {
    const names = pythonTokens(`x = "import os"  # import sys\ny = 1`).map((t) => t.name);
    expect(names).toEqual(["x", "y"]);
  });

  it("skips triple-quoted docstrings", () => {
    const src = `"""\nmodule docstring mentioning helper\n"""\nimport helper`;
    const names = pythonTokens(src).map((t) => t.name);
    expect(names).toEqual(["import", "helper"]);
  });

  it("treats an f-string prefix as part of the literal", () => {
    const names = pythonTokens(`msg = f"hello {name}"`).map((t) => t.name);
    // `f` is a prefix, not a name; the literal body (incl. the interpolation) is
    // skipped wholesale.
    expect(names).toEqual(["msg"]);
  });

  it("records the qualifier of a dotted access", () => {
    const toks = pythonTokens("os.path.join(a)");
    expect(toks.map((t) => [t.name, t.qualifier])).toEqual([
      ["os", null],
      ["path", "os"],
      ["join", "path"],
      ["a", null],
    ]);
  });

  it("does not carry a qualifier across an unrelated token", () => {
    const toks = pythonTokens("foo(bar)");
    expect(toks.find((t) => t.name === "bar")?.qualifier).toBeNull();
  });
});

describe("pythonRefAt", () => {
  const src = "import os\nos.getcwd()\n";
  it("finds the name under the caret with its qualifier", () => {
    const ref = pythonRefAt(src, src.indexOf("getcwd") + 2);
    expect(ref?.name).toBe("getcwd");
    expect(ref?.qualifier).toBe("os");
  });
  it("matches a caret resting just after a name", () => {
    expect(pythonRefAt("x = 1", 1)?.name).toBe("x");
  });
  it("returns null off a name", () => {
    expect(pythonRefAt("x = 1", 3)).toBeNull(); // in the whitespace after `=`
    expect(pythonRefAt("     ", 3)).toBeNull();
  });
});

// ── Definitions ──────────────────────────────────────────────────────────────

describe("findPythonDefs", () => {
  it("finds defs, async defs, classes and module-level bindings", () => {
    const src = [
      "TIMEOUT = 30",
      "class Client:",
      "    def send(self):",
      "        pass",
      "async def fetch(url):",
      "    pass",
    ].join("\n");
    expect(findPythonDefs(src)).toEqual([
      { name: "TIMEOUT", line: 1, column: 0, kind: "var" },
      { name: "Client", line: 2, column: 6, kind: "class" },
      { name: "send", line: 3, column: 8, kind: "def" },
      { name: "fetch", line: 5, column: 10, kind: "def" },
    ]);
  });

  it("does not mistake an equality test for a binding", () => {
    expect(findPythonDefs("x == 1")).toEqual([]);
  });

  it("prefers a def over a bare assignment of the same name", () => {
    const src = "def f():\n    pass\nf = None";
    expect(findDef(src, "f")).toMatchObject({ line: 1, kind: "def" });
  });
});

// ── Imports ──────────────────────────────────────────────────────────────────

describe("parsePythonImports", () => {
  it("parses plain imports, including dotted and aliased", () => {
    expect(parsePythonImports("import os")).toEqual([
      { local: "os", module: "os", level: 0, symbol: "" },
    ]);
    // `import a.b` binds the ROOT name `a`, not `b`.
    expect(parsePythonImports("import pkg.sub")).toEqual([
      { local: "pkg", module: "pkg.sub", level: 0, symbol: "" },
    ]);
    expect(parsePythonImports("import numpy as np")).toEqual([
      { local: "np", module: "numpy", level: 0, symbol: "" },
    ]);
  });

  it("parses from-imports, relative levels and aliases", () => {
    expect(parsePythonImports("from .util import helper")).toEqual([
      { local: "helper", module: "util", level: 1, symbol: "helper" },
    ]);
    expect(parsePythonImports("from ..pkg.mod import a, b as c")).toEqual([
      { local: "a", module: "pkg.mod", level: 2, symbol: "a" },
      { local: "c", module: "pkg.mod", level: 2, symbol: "b" },
    ]);
    expect(parsePythonImports("from . import sibling")).toEqual([
      { local: "sibling", module: "", level: 1, symbol: "sibling" },
    ]);
  });

  it("folds a parenthesised multi-line import list", () => {
    const src = "from .models import (\n    User,\n    Order as Purchase,\n)";
    expect(parsePythonImports(src)).toEqual([
      { local: "User", module: "models", level: 1, symbol: "User" },
      { local: "Purchase", module: "models", level: 1, symbol: "Order" },
    ]);
  });

  it("ignores the word 'import' inside a docstring or comment", () => {
    expect(parsePythonImports(`"""\nfrom fake import nothing\n"""`)).toEqual([]);
    expect(parsePythonImports("# from fake import nothing")).toEqual([]);
  });

  it("skips a star import rather than binding a bogus name", () => {
    expect(parsePythonImports("from os import *")).toEqual([]);
  });
});

// ── Module resolution ────────────────────────────────────────────────────────

describe("modulePathCandidates", () => {
  it("anchors a relative import at the importing file's directory", () => {
    expect(
      modulePathCandidates({ module: "util", level: 1 }, "/proj/pkg/main.py", "/proj"),
    ).toEqual(["/proj/pkg/util.py", "/proj/pkg/util/__init__.py"]);
  });

  it("climbs one directory per extra dot", () => {
    expect(
      modulePathCandidates({ module: "shared", level: 2 }, "/proj/pkg/sub/main.py", "/proj"),
    ).toEqual(["/proj/pkg/shared.py", "/proj/pkg/shared/__init__.py"]);
  });

  it("probes project root, src-layout and the file's own dir for an absolute import", () => {
    expect(
      modulePathCandidates({ module: "pkg.mod", level: 0 }, "/proj/app/main.py", "/proj"),
    ).toEqual([
      "/proj/pkg/mod.py",
      "/proj/pkg/mod/__init__.py",
      "/proj/src/pkg/mod.py",
      "/proj/src/pkg/mod/__init__.py",
      "/proj/app/pkg/mod.py",
      "/proj/app/pkg/mod/__init__.py",
    ]);
  });

  it("names the package directory itself for a bare `from . import x`", () => {
    expect(modulePathCandidates({ module: "", level: 1 }, "/proj/pkg/main.py", "/proj")).toEqual([
      "/proj/pkg/__init__.py",
    ]);
  });
});

// ── Go-to-definition ─────────────────────────────────────────────────────────

/** A fake project tree: the injected reader is the only filesystem the resolver
 *  ever sees, which is what keeps it testable without a host. */
function reader(files: Record<string, string>) {
  return async (p: string) => files[p] ?? null;
}

describe("resolvePythonDefinition", () => {
  const MAIN = "/proj/main.py";

  it("resolves a symbol imported from a sibling module", async () => {
    const main = "from .util import helper\n\nhelper()\n";
    const files = {
      "/proj/util.py": "import os\n\n\ndef helper(x):\n    return x\n",
    };
    const loc = await resolvePythonDefinition(
      main,
      main.lastIndexOf("helper") + 1,
      MAIN,
      "/proj",
      reader(files),
    );
    expect(loc).toEqual({ path: "/proj/util.py", line: 4, column: 4 });
  });

  it("resolves an attribute of an imported module", async () => {
    const main = "import util\n\nutil.helper()\n";
    const files = { "/proj/util.py": "def helper():\n    pass\n" };
    const loc = await resolvePythonDefinition(
      main,
      main.indexOf("util.helper") + 6,
      MAIN,
      "/proj",
      reader(files),
    );
    expect(loc).toEqual({ path: "/proj/util.py", line: 1, column: 4 });
  });

  it("resolves a name defined in the same file", async () => {
    const main = "def local():\n    pass\n\nlocal()\n";
    const loc = await resolvePythonDefinition(
      main,
      main.lastIndexOf("local") + 1,
      MAIN,
      "/proj",
      reader({}),
    );
    expect(loc).toEqual({ path: MAIN, line: 1, column: 4 });
  });

  it("resolves self.method to the method in this file", async () => {
    const main = ["class C:", "    def run(self):", "        self.step()", "    def step(self):", "        pass"].join("\n");
    const loc = await resolvePythonDefinition(
      main,
      main.indexOf("self.step") + 6,
      MAIN,
      "/proj",
      reader({}),
    );
    expect(loc).toEqual({ path: MAIN, line: 4, column: 8 });
  });

  it("follows a re-export through a package __init__", async () => {
    const main = "from .pkg import thing\n\nthing()\n";
    const files = {
      "/proj/pkg/__init__.py": "from .impl import thing\n",
      "/proj/pkg/impl.py": "\ndef thing():\n    pass\n",
    };
    const loc = await resolvePythonDefinition(
      main,
      main.lastIndexOf("thing") + 1,
      MAIN,
      "/proj",
      reader(files),
    );
    expect(loc).toEqual({ path: "/proj/pkg/impl.py", line: 2, column: 4 });
  });

  it("opens the module itself when the import names a submodule, not a symbol", async () => {
    const main = "from pkg import mod\n\nmod.f()\n";
    const files = { "/proj/pkg/mod.py": "def f():\n    pass\n" };
    // Clicking `mod` — it is not a def inside pkg, it IS pkg/mod.py.
    const loc = await resolvePythonDefinition(
      main,
      main.indexOf("import mod") + 8,
      MAIN,
      "/proj",
      reader(files),
    );
    expect(loc).toEqual({ path: "/proj/pkg/mod.py", line: 1, column: 0 });
  });

  it("returns null for an unresolvable name rather than guessing", async () => {
    const main = "import os\n\nos.getcwd()\nmystery()\n";
    expect(
      await resolvePythonDefinition(main, main.indexOf("mystery") + 1, MAIN, "/proj", reader({})),
    ).toBeNull();
    // A stdlib module that isn't in the project tree also has no local file.
    expect(
      await resolvePythonDefinition(main, main.indexOf("getcwd") + 1, MAIN, "/proj", reader({})),
    ).toBeNull();
  });

  it("terminates on a circular re-export instead of hanging", async () => {
    const main = "from .a import thing\n";
    const files = {
      // a re-exports from b, b re-exports back from a — legal, and it happens.
      "/proj/a.py": "from .b import thing\n",
      "/proj/b.py": "from .a import thing\n",
    };
    const loc = await resolvePythonDefinition(
      main,
      main.indexOf("thing") + 1,
      MAIN,
      "/proj",
      reader(files),
    );
    expect(loc).toBeNull();
  });
});

// ── Link ranges (what ctrl+click underlines) ─────────────────────────────────

describe("pythonLinkRanges", () => {
  const rangesOf = (src: string) =>
    pythonLinkRanges(src).map((r) => src.slice(r.start, r.end));

  it("underlines uses of imported names and local defs", () => {
    const src = "from .util import helper\n\ndef run():\n    helper()\n\nrun()\n";
    expect(rangesOf(src)).toEqual(["helper", "helper", "run"]);
  });

  it("underlines an attribute of an imported module, and the module itself", () => {
    const src = "import util\n\nutil.helper()\n";
    // `util` at the import site + at the use site, and the attribute.
    expect(rangesOf(src)).toEqual(["util", "util", "helper"]);
  });

  it("does not underline a definition site — jumping to it would be a no-op", () => {
    const src = "def solo():\n    pass\n";
    expect(rangesOf(src)).toEqual([]);
  });

  it("does not underline an unresolvable name, so the affordance never lies", () => {
    const src = "mystery()\nobj.method()\n";
    expect(rangesOf(src)).toEqual([]);
  });

  it("does not underline keywords or names inside strings", () => {
    const src = "from .util import helper\n\nreturn_value = 'helper'\n";
    expect(rangesOf(src)).toEqual(["helper"]);
  });

  it("underlines self.method only when the method exists in this file", () => {
    const src = ["class C:", "    def run(self):", "        self.step()", "        self.absent()", "    def step(self):", "        pass"].join("\n");
    expect(rangesOf(src)).toEqual(["step"]);
  });
});

// ── External libraries (an in-tree venv's site-packages) ─────────────────────

describe("pythonLibRoots", () => {
  const listing = (dirs: Record<string, string[]>) => async (d: string) => dirs[d] ?? null;

  it("finds an in-tree venv's site-packages from the relative interpreter", async () => {
    const roots = await pythonLibRoots(
      ".venv/bin/python",
      "/proj",
      listing({
        "/proj/.venv/lib": ["python3.12", "python3.9", "pkgconfig"],
        "/proj/.venv/lib/python3.12": ["site-packages"],
        "/proj/.venv/lib/python3.9": ["os.py"],
      }),
    );
    expect(roots).toEqual(["/proj/.venv/lib/python3.12/site-packages"]);
  });

  it("finds the Windows layout", async () => {
    const roots = await pythonLibRoots(
      "C:\\proj\\.venv\\Scripts\\python.exe",
      "C:\\proj",
      listing({ "C:\\proj\\.venv\\Lib": ["site-packages"] }),
    );
    expect(roots).toEqual(["C:\\proj\\.venv\\Lib\\site-packages"]);
  });

  it("names nothing for a bare command (the system fallback)", async () => {
    expect(await pythonLibRoots("python3", "/proj", listing({}))).toEqual([]);
  });
});

describe("resolvePythonDefinition into an external library", () => {
  const SITE = "/proj/.venv/lib/python3.12/site-packages";
  const MAIN = "/proj/hello.py";
  const main = [
    "from rdkit import Chem, rdBase",
    "from rdkit.Chem import Descriptors, Draw",
    "import numpy as np",
    "",
    "Chem.MolFromSmiles('C')",
    "Descriptors.MolWt(m)",
    "Draw.MolToFile(m, 'x.png')",
    "np.zeros(3)",
    "rdBase.rdkitVersion",
  ].join("\n");
  const files = {
    [`${SITE}/rdkit/__init__.py`]: "from rdkit import rdBase\n",
    [`${SITE}/rdkit/Chem/__init__.py`]: "from rdkit import rdBase\n",
    [`${SITE}/rdkit/Chem/Descriptors.py`]: "def MolWt(m):\n    pass\n",
    [`${SITE}/rdkit/Chem/Draw/__init__.py`]: "def MolToFile(m, f):\n    pass\n",
    [`${SITE}/rdkit-stubs/rdBase.pyi`]: "rdkitVersion: str\n",
    [`${SITE}/numpy/__init__.py`]: "from .core import zeros\n",
    [`${SITE}/numpy/core.py`]: "\n\ndef zeros(n):\n    pass\n",
  };
  const at = (needle: string) =>
    resolvePythonDefinition(main, main.lastIndexOf(needle) + 1, MAIN, "/proj", reader(files), [SITE]);

  it("opens a submodule imported by name", async () => {
    expect(await at("Chem.Mol")).toEqual({ path: `${SITE}/rdkit/Chem/__init__.py`, line: 1, column: 0 });
    expect(await at("Draw.Mol")).toEqual({ path: `${SITE}/rdkit/Chem/Draw/__init__.py`, line: 1, column: 0 });
  });

  it("follows an attribute of a library module, through a re-export", async () => {
    expect(await at("zeros")).toEqual({ path: `${SITE}/numpy/core.py`, line: 3, column: 4 });
  });

  it("falls back to a PEP 561 stubs package for a compiled module", async () => {
    expect(await at("rdBase.rdkit")).toEqual({ path: `${SITE}/rdkit-stubs/rdBase.pyi`, line: 1, column: 0 });
  });

  it("does not look in site-packages without the roots", async () => {
    const loc = await resolvePythonDefinition(main, main.lastIndexOf("Draw.Mol") + 1, MAIN, "/proj", reader(files));
    expect(loc).toBeNull();
  });

  it("lists library candidates after the project's own roots", () => {
    expect(modulePathCandidates({ module: "rdkit.Chem", level: 0 }, MAIN, "/proj", [SITE]).slice(4)).toEqual([
      `${SITE}/rdkit/Chem.py`,
      `${SITE}/rdkit/Chem/__init__.py`,
      `${SITE}/rdkit/Chem.pyi`,
      `${SITE}/rdkit/Chem/__init__.pyi`,
      `${SITE}/rdkit-stubs/Chem.pyi`,
      `${SITE}/rdkit-stubs/Chem/__init__.pyi`,
    ]);
  });
});

describe("underlining only names that resolve", () => {
  const src = [
    "import numpy as np",
    "from rdkit import Chem, rdBase",
    "",
    "def local():",
    "    pass",
    "",
    "np.zeros(3)",
    "np.zeros(4)",
    "Chem",
    "rdBase",
    "local()",
  ].join("\n");
  const words = (rs: { start: number; end: number }[]) => rs.map((r) => src.slice(r.start, r.end));

  it("lists each outgoing name once, at its first use", () => {
    expect(pythonImportLinks(src)).toEqual([
      { key: "np", caret: src.indexOf("np") },
      { key: "Chem", caret: src.indexOf("Chem") },
      { key: "rdBase", caret: src.indexOf("rdBase") },
      { key: "np.zeros", caret: src.indexOf("zeros") },
    ]);
  });

  it("drops an imported name the resolver could not follow, keeps local ones", () => {
    expect(words(pythonLinkRanges(src, new Set(["Chem", "np.zeros"])))).toEqual([
      "Chem",
      "zeros",
      "zeros",
      "Chem",
      "local",
    ]);
  });

  it("underlines no outgoing name before anything resolved", () => {
    expect(words(pythonLinkRanges(src, new Set()))).toEqual(["local"]);
  });
});
