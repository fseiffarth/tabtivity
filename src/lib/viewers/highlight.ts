/**
 * Dependency-free syntax highlighter for the built-in code viewer (TODO Group K
 * #40). It turns a file's source into safe HTML where tokens are wrapped in
 * `<span class="tok-*">` elements; the code viewer renders that behind a
 * transparent <textarea> so the file stays editable while showing colour.
 *
 * Like the sibling `markdown.ts`, this is intentionally a focused, hand-written
 * subset rather than a full grammar per language: it recognises comments,
 * strings, numbers, and keyword/type/function identifiers, which is what carries
 * most of the visual signal. It is driven by a tiny per-language `LangSpec`
 * (comment markers + keyword/type tables) plus a dedicated markup tokenizer for
 * HTML/XML/SVG.
 *
 * SECURITY: the input is an arbitrary file's contents, so every run of text —
 * token or plain — is HTML-escaped before it enters the output. We only ever
 * emit our own `<span>` tags with fixed class names; nothing from the source is
 * interpreted as markup. Keep this invariant if extending.
 */

import { overlaySpecAt } from "./tex/beamer";

export type Lang =
  | "js"
  | "jsx"
  | "ts"
  | "tsx"
  | "rust"
  | "python"
  | "go"
  | "c"
  | "cpp"
  | "java"
  | "csharp"
  | "kotlin"
  | "swift"
  // The rest of the C-like family (Dart, Scala, Groovy, Objective-C, …): one
  // pragmatic shared table rather than a spec each.
  | "clike"
  | "php"
  | "ruby"
  | "lua"
  | "perl"
  | "r"
  | "haskell"
  | "elixir"
  | "shell"
  | "json"
  | "yaml"
  | "toml"
  | "css"
  | "sql"
  | "tex"
  | "markup"
  | "markdown"
  | "plain";

const HTML_SPECIAL = /[&<>"']/;
const HTML_SPECIAL_ALL = /[&<>"']/g;

function escapeHtmlChar(c: string): string {
  switch (c) {
    case "&": return "&amp;";
    case "<": return "&lt;";
    case ">": return "&gt;";
    case '"': return "&quot;";
    case "'": return "&#39;";
    default: return c;
  }
}

/**
 * HTML-escape `s` (`& < > " '`). One pass, and no pass at all for the common
 * case of nothing to escape: the scanners below call this once per token — and,
 * for a run of prose, once per character — on every keystroke of the whole
 * document, and the old five chained `replace` calls were most of what
 * highlighting a large `.tex` file cost.
 */
export function escapeHtml(s: string): string {
  if (s.length === 1) return escapeHtmlChar(s);
  if (!HTML_SPECIAL.test(s)) return s;
  return s.replace(HTML_SPECIAL_ALL, escapeHtmlChar);
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

const set = (...words: string[]) => new Set(words);

interface LangSpec {
  /** Line-comment markers, longest-first if they share a prefix. */
  line: string[];
  /** Block-comment delimiters, if the language has them. */
  block?: [string, string];
  /** String delimiters. ` allows newlines; ' and " are single-line. */
  strings: string[];
  /** Python-style triple-quoted strings (multiline). */
  triple?: boolean;
  /** Shell/Perl-style `$name` variable interpolation. */
  sigil?: string;
  keywords: Set<string>;
  /** Constant literals coloured like keywords (true/false/null/…). */
  literals: Set<string>;
  types: Set<string>;
  /** Treat a string immediately followed by `:` as a key (JSON/YAML look). */
  keyStrings?: boolean;
  /** Keywords match case-insensitively (SQL), and a capitalised word is not
   *  thereby a type. */
  caseInsensitive?: boolean;
  /** `@name` decorators/annotations — and Ruby/Perl/Elixir `@ivar`/`@array`/
   *  `@attr`, which read the same way — coloured as attributes. */
  annotations?: boolean;
  /** C-family preprocessor: a `#word` opening its line is a keyword, and the
   *  `<header>` of an `#include`/`#import` reads as a string. */
  preproc?: boolean;
  /** Rust's own syntax: `#[attr]`/`#![attr]` attributes, `name!` macro calls,
   *  `'c'` char literals told apart from `'a` lifetimes, `r#"…"#` raw strings,
   *  and `"…"` strings that may span lines. */
  rust?: boolean;
  /** Interpolation inside the strings opened by `quotes`: `open` … `}` is
   *  re-scanned as code, and with `vars` a bare `$name` is marked too. */
  interp?: { quotes: string; open?: string; vars?: boolean };
  /** JS-family `/regex/flags` literals where an expression may start — without
   *  it a quote inside a regex opens a "string" that colours the rest of the line. */
  regex?: boolean;
  /** JSX elements where an expression may start (.jsx/.tsx). */
  jsx?: boolean;
  /** Ruby/Elixir `:symbol`s. */
  symbols?: boolean;
}

// Control/declaration keywords, per language. TypeScript's table is JavaScript's
// plus its own contextual words, so a `type` or `is` variable in a plain .js
// file is not coloured as a keyword.
const JS_KW = set(
  "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "finally", "for", "from", "function", "get", "if", "import", "in",
  "instanceof", "let", "new", "of", "return", "set", "static", "super",
  "switch", "this", "throw", "try", "typeof", "var", "void", "while", "with",
  "yield",
);
const TS_KW = set(
  ...JS_KW, "abstract", "accessor", "asserts", "declare", "implements", "infer",
  "interface", "is", "keyof", "namespace", "override", "private", "protected",
  "public", "readonly", "satisfies", "type", "unique", "using",
);
const JS_LITERALS = set("true", "false", "null", "undefined", "NaN", "Infinity");
// Lowercase primitives only: a capitalised name (Promise, Record, …) already
// reads as a type.
const TS_TYPES = set(
  "any", "boolean", "number", "object", "string", "symbol", "unknown", "never",
  "bigint",
);

const RUST_KW = set(
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else",
  "enum", "extern", "fn", "for", "if", "impl", "in", "let", "loop", "match",
  "mod", "move", "mut", "pub", "ref", "return", "self", "Self", "static",
  "struct", "super", "trait", "type", "union", "unsafe", "use", "where", "while",
);
const RUST_TYPES = set(
  "bool", "char", "str", "String", "i8", "i16", "i32", "i64", "i128", "isize",
  "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "Vec", "Option",
  "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "Cow",
);

const PY_KW = set(
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
  "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield", "match", "case",
);
const PY_TYPES = set(
  "int", "float", "str", "bool", "bytes", "list", "dict", "set", "tuple",
  "object", "type", "None",
);

const GO_KW = set(
  "break", "case", "chan", "const", "continue", "default", "defer", "else",
  "fallthrough", "for", "func", "go", "goto", "if", "import", "interface",
  "map", "package", "range", "return", "select", "struct", "switch", "type", "var",
);
const GO_TYPES = set(
  "bool", "byte", "complex64", "complex128", "error", "float32", "float64",
  "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8",
  "uint16", "uint32", "uint64", "uintptr",
);

const C_KW = set(
  "auto", "break", "case", "const", "continue", "default", "do", "else", "enum",
  "extern", "for", "goto", "if", "inline", "register", "restrict", "return",
  "sizeof", "static", "struct", "switch", "typedef", "typeof", "union",
  "volatile", "while", "_Alignas", "_Alignof", "_Atomic", "_Bool", "_Generic",
  "_Noreturn", "_Static_assert", "_Thread_local", "alignas", "alignof",
  "static_assert", "thread_local",
);
const C_TYPES = set(
  "bool", "char", "double", "float", "int", "long", "short", "signed",
  "unsigned", "void", "size_t", "ssize_t", "ptrdiff_t", "wchar_t", "int8_t",
  "int16_t", "int32_t", "int64_t", "uint8_t", "uint16_t", "uint32_t",
  "uint64_t", "intptr_t", "uintptr_t",
);
const C_LITERALS = set("true", "false", "NULL", "nullptr");

const CPP_KW = set(
  ...C_KW, "catch", "class", "co_await", "co_return", "co_yield", "concept",
  "consteval", "constexpr", "constinit", "const_cast", "decltype", "delete",
  "dynamic_cast", "explicit", "export", "final", "friend", "mutable",
  "namespace", "new", "noexcept", "operator", "override", "private",
  "protected", "public", "reinterpret_cast", "requires", "static_cast",
  "template", "this", "throw", "try", "typeid", "typename", "using", "virtual",
);
const CPP_TYPES = set(
  ...C_TYPES, "char8_t", "char16_t", "char32_t", "string", "string_view",
  "vector", "map", "set", "unordered_map", "unordered_set", "array", "pair",
  "tuple", "optional", "variant", "unique_ptr", "shared_ptr", "weak_ptr",
);

const JAVA_KW = set(
  "abstract", "assert", "break", "case", "catch", "class", "const", "continue",
  "default", "do", "else", "enum", "extends", "final", "finally", "for", "goto",
  "if", "implements", "import", "instanceof", "interface", "native", "new",
  "package", "permits", "private", "protected", "public", "record", "return",
  "sealed", "static", "strictfp", "super", "switch", "synchronized", "this",
  "throw", "throws", "transient", "try", "var", "void", "volatile", "while",
  "yield",
);
const JAVA_TYPES = set(
  "boolean", "byte", "char", "double", "float", "int", "long", "short",
);

const CSHARP_KW = set(
  "abstract", "as", "async", "await", "base", "break", "case", "catch",
  "checked", "class", "const", "continue", "default", "delegate", "do", "else",
  "enum", "event", "explicit", "extern", "finally", "fixed", "for", "foreach",
  "get", "goto", "if", "implicit", "in", "init", "interface", "internal", "is",
  "lock", "nameof", "namespace", "new", "operator", "out", "override", "params",
  "partial", "private", "protected", "public", "readonly", "record", "ref",
  "required", "return", "sealed", "set", "sizeof", "stackalloc", "static",
  "struct", "switch", "this", "throw", "try", "typeof", "unchecked", "unsafe",
  "using", "var", "virtual", "volatile", "when", "where", "while", "with",
  "yield",
);
const CSHARP_TYPES = set(
  "bool", "byte", "char", "decimal", "double", "dynamic", "float", "int",
  "long", "nint", "nuint", "object", "sbyte", "short", "string", "uint",
  "ulong", "ushort", "void",
);

const KOTLIN_KW = set(
  "abstract", "actual", "annotation", "as", "break", "by", "catch", "class",
  "companion", "const", "constructor", "continue", "crossinline", "data", "do",
  "else", "enum", "expect", "external", "final", "finally", "for", "fun", "get",
  "if", "import", "in", "infix", "init", "inline", "inner", "interface",
  "internal", "is", "lateinit", "noinline", "object", "open", "operator", "out",
  "override", "package", "private", "protected", "public", "reified", "return",
  "sealed", "set", "super", "suspend", "tailrec", "this", "throw", "try",
  "typealias", "val", "value", "var", "vararg", "when", "where", "while",
);

const SWIFT_KW = set(
  "actor", "any", "associatedtype", "async", "await", "break", "case", "catch",
  "class", "continue", "convenience", "default", "defer", "deinit", "didSet",
  "do", "dynamic", "else", "enum", "extension", "fallthrough", "fileprivate",
  "final", "for", "func", "get", "guard", "if", "import", "in", "indirect",
  "infix", "init", "inout", "internal", "is", "lazy", "let", "mutating",
  "nonisolated", "open", "operator", "optional", "override", "postfix",
  "prefix", "private", "protocol", "public", "repeat", "required", "rethrows",
  "return", "self", "Self", "set", "some", "static", "struct", "subscript",
  "super", "switch", "throw", "throws", "try", "typealias", "unowned", "var",
  "weak", "where", "while", "willSet",
);

// The shared table for the rest of the C-like family (Dart/Scala/Groovy/
// Objective-C/…), where a spec each would buy little.
const CLIKE_KW = set(
  "auto", "break", "case", "catch", "class", "const", "continue", "default",
  "delete", "do", "else", "enum", "extends", "extern", "final", "finally",
  "for", "goto", "if", "implements", "import", "inline", "instanceof",
  "interface", "namespace", "new", "operator", "override", "package", "private",
  "protected", "public", "register", "return", "sizeof", "static", "struct",
  "super", "switch", "template", "this", "throw", "throws", "try", "typedef",
  "typename", "union", "using", "virtual", "volatile", "while",
);
const CLIKE_TYPES = set(
  "bool", "char", "double", "float", "int", "long", "short", "signed",
  "unsigned", "void", "wchar_t", "size_t", "string", "String", "var", "let",
  "fun", "val",
);

const PHP_KW = set(
  "abstract", "and", "as", "break", "case", "catch", "class", "clone", "const",
  "continue", "declare", "default", "do", "echo", "else", "elseif", "empty",
  "enddeclare", "endfor", "endforeach", "endif", "endswitch", "endwhile",
  "enum", "extends", "final", "finally", "fn", "for", "foreach", "function",
  "global", "goto", "if", "implements", "include", "include_once",
  "instanceof", "insteadof", "interface", "isset", "list", "match",
  "namespace", "new", "or", "print", "private", "protected", "public",
  "readonly", "require", "require_once", "return", "static", "switch", "throw",
  "trait", "try", "unset", "use", "var", "while", "xor", "yield",
);
const PHP_TYPES = set(
  "array", "bool", "callable", "float", "int", "iterable", "mixed", "never",
  "object", "parent", "self", "string", "void",
);

const RUBY_KW = set(
  "BEGIN", "END", "alias", "and", "begin", "break", "case", "class", "def",
  "defined", "do", "else", "elsif", "end", "ensure", "for", "if", "in",
  "module", "next", "not", "or", "redo", "rescue", "retry", "return", "self",
  "super", "then", "undef", "unless", "until", "when", "while", "yield",
  "require", "require_relative", "include", "extend", "attr_accessor",
  "attr_reader", "attr_writer", "private", "protected", "public", "raise",
  "lambda", "proc",
);

const LUA_KW = set(
  "and", "break", "do", "else", "elseif", "end", "for", "function", "goto",
  "if", "in", "local", "not", "or", "repeat", "return", "then", "until", "while",
);

const PERL_KW = set(
  "my", "our", "local", "sub", "if", "elsif", "else", "unless", "while",
  "until", "for", "foreach", "do", "last", "next", "redo", "return", "use",
  "no", "package", "require", "BEGIN", "END", "eq", "ne", "lt", "gt", "le",
  "ge", "and", "or", "not", "cmp", "print", "say", "die", "warn", "defined",
  "undef", "qw", "ref", "bless", "shift",
);

const R_KW = set(
  "if", "else", "repeat", "while", "function", "for", "in", "next", "break",
  "return", "library", "require", "switch",
);

const HASKELL_KW = set(
  "as", "case", "class", "data", "default", "deriving", "do", "else", "family",
  "forall", "foreign", "hiding", "if", "import", "in", "infix", "infixl",
  "infixr", "instance", "let", "module", "newtype", "of", "qualified", "then",
  "type", "where",
);

const ELIXIR_KW = set(
  "after", "alias", "and", "case", "catch", "cond", "def", "defdelegate",
  "defexception", "defguard", "defimpl", "defmacro", "defmacrop", "defmodule",
  "defp", "defprotocol", "defstruct", "do", "else", "end", "fn", "for", "if",
  "import", "in", "not", "or", "quote", "raise", "receive", "require",
  "rescue", "try", "unless", "unquote", "use", "when", "with",
);

const SHELL_KW = set(
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done",
  "case", "esac", "in", "function", "select", "time", "return", "export",
  "local", "readonly", "declare", "set", "unset", "source",
);

const SQL_KW = set(
  "select", "from", "where", "and", "or", "not", "insert", "into", "values",
  "update", "set", "delete", "create", "table", "drop", "alter", "add", "column",
  "primary", "key", "foreign", "references", "join", "left", "right", "inner",
  "outer", "on", "as", "group", "by", "order", "having", "limit", "offset",
  "distinct", "union", "all", "index", "view", "trigger", "default", "null",
  "is", "in", "like", "between", "exists", "case", "when", "then", "else", "end",
);

const TOML_KW = set("true", "false");

const C_FAMILY = { line: ["//"], block: ["/*", "*/"] as [string, string] };
const JS_BASE = { ...C_FAMILY, strings: ['"', "'", "`"], literals: JS_LITERALS, annotations: true, regex: true, interp: { quotes: "`", open: "${" } };

const SPECS: Record<Exclude<Lang, "markup" | "tex" | "markdown" | "plain">, LangSpec> = {
  js: { ...JS_BASE, keywords: JS_KW, types: set() },
  jsx: { ...JS_BASE, keywords: JS_KW, types: set(), jsx: true },
  ts: { ...JS_BASE, keywords: TS_KW, types: TS_TYPES },
  tsx: { ...JS_BASE, keywords: TS_KW, types: TS_TYPES, jsx: true },
  rust: { ...C_FAMILY, strings: ['"'], keywords: RUST_KW, literals: set("true", "false", "None", "Some", "Ok", "Err"), types: RUST_TYPES, rust: true },
  python: { line: ["#"], strings: ['"', "'"], triple: true, keywords: PY_KW, literals: set("True", "False", "None", "self", "cls"), types: PY_TYPES, annotations: true },
  go: { ...C_FAMILY, strings: ['"', "`"], keywords: GO_KW, literals: set("true", "false", "nil", "iota"), types: GO_TYPES },
  c: { ...C_FAMILY, strings: ['"', "'"], keywords: C_KW, literals: C_LITERALS, types: C_TYPES, preproc: true },
  cpp: { ...C_FAMILY, strings: ['"', "'"], keywords: CPP_KW, literals: C_LITERALS, types: CPP_TYPES, preproc: true },
  java: { ...C_FAMILY, strings: ['"', "'"], triple: true, keywords: JAVA_KW, literals: set("true", "false", "null"), types: JAVA_TYPES, annotations: true },
  csharp: { ...C_FAMILY, strings: ['"', "'"], keywords: CSHARP_KW, literals: set("true", "false", "null"), types: CSHARP_TYPES, preproc: true },
  kotlin: { ...C_FAMILY, strings: ['"', "'"], triple: true, keywords: KOTLIN_KW, literals: set("true", "false", "null"), types: set(), annotations: true, interp: { quotes: '"', open: "${", vars: true } },
  swift: { ...C_FAMILY, strings: ['"'], triple: true, keywords: SWIFT_KW, literals: set("true", "false", "nil"), types: set(), annotations: true, preproc: true },
  clike: { ...C_FAMILY, strings: ['"', "'"], keywords: CLIKE_KW, literals: set("true", "false", "null", "nullptr", "NULL", "nil"), types: CLIKE_TYPES, annotations: true, preproc: true },
  php: { line: ["//", "#"], block: ["/*", "*/"], strings: ['"', "'"], sigil: "$", keywords: PHP_KW, literals: set("true", "false", "null", "TRUE", "FALSE", "NULL"), types: PHP_TYPES, interp: { quotes: '"', vars: true } },
  ruby: { line: ["#"], strings: ['"', "'"], keywords: RUBY_KW, literals: set("true", "false", "nil"), types: set(), annotations: true, symbols: true, interp: { quotes: '"', open: "#{" } },
  // `--[[ … ]]` must be tried before the `--` line comment it starts with —
  // `scanCode` checks block comments first.
  lua: { line: ["--"], block: ["--[[", "]]"], strings: ['"', "'"], keywords: LUA_KW, literals: set("true", "false", "nil"), types: set() },
  perl: { line: ["#"], strings: ['"', "'"], sigil: "$", keywords: PERL_KW, literals: set(), types: set(), annotations: true, interp: { quotes: '"', vars: true } },
  r: { line: ["#"], strings: ['"', "'"], keywords: R_KW, literals: set("TRUE", "FALSE", "NULL", "NA", "Inf", "NaN"), types: set() },
  // `'` is part of Haskell identifiers (`x'`), so only `"` opens a string.
  haskell: { line: ["--"], block: ["{-", "-}"], strings: ['"'], keywords: HASKELL_KW, literals: set("True", "False"), types: set() },
  elixir: { line: ["#"], strings: ['"', "'"], triple: true, keywords: ELIXIR_KW, literals: set("true", "false", "nil"), types: set(), annotations: true, symbols: true, interp: { quotes: '"', open: "#{" } },
  shell: { line: ["#"], strings: ['"', "'"], sigil: "$", keywords: SHELL_KW, literals: set("true", "false"), types: set(), interp: { quotes: '"', open: "${", vars: true } },
  json: { line: [], strings: ['"'], keywords: set(), literals: set("true", "false", "null"), types: set(), keyStrings: true },
  yaml: { line: ["#"], strings: ['"', "'"], keywords: set(), literals: set("true", "false", "null", "yes", "no", "on", "off"), types: set(), keyStrings: true },
  toml: { line: ["#", ";"], strings: ['"', "'"], keywords: set(), literals: TOML_KW, types: set(), keyStrings: true },
  css: { ...C_FAMILY, strings: ['"', "'"], keywords: set(), literals: set(), types: set() },
  sql: { line: ["--"], block: ["/*", "*/"], strings: ["'", '"'], keywords: SQL_KW, literals: set("true", "false", "null"), types: set(), caseInsensitive: true },
};

const EXT_LANG: Record<string, Lang> = {
  ".js": "js", ".mjs": "js", ".cjs": "js", ".jsx": "jsx",
  ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx",
  ".vue": "js", ".svelte": "js", ".astro": "js",
  ".rs": "rust",
  ".py": "python", ".pyi": "python", ".pyw": "python",
  ".go": "go",
  ".c": "c",
  // A `.h` may be C, C++ or Objective-C; C++'s table is C's plus more, so it
  // colours all three honestly.
  ".h": "cpp", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp",
  ".hh": "cpp", ".hxx": "cpp", ".ipp": "cpp", ".inl": "cpp", ".ino": "cpp",
  ".cu": "cpp", ".cuh": "cpp",
  ".java": "java", ".cs": "csharp", ".kt": "kotlin", ".kts": "kotlin",
  ".swift": "swift",
  ".m": "clike", ".mm": "clike", ".scala": "clike", ".dart": "clike",
  ".groovy": "clike", ".gradle": "clike", ".proto": "clike",
  ".php": "php",
  ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby",
  ".lua": "lua",
  ".pl": "perl", ".pm": "perl",
  ".r": "r",
  ".hs": "haskell", ".elm": "haskell",
  ".ex": "elixir", ".exs": "elixir",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell", ".fish": "shell",
  ".ps1": "shell", ".bat": "shell",
  ".json": "json", ".jsonc": "json", ".json5": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml", ".ini": "toml", ".cfg": "toml", ".conf": "toml",
  ".env": "toml", ".properties": "toml",
  ".css": "css", ".scss": "css", ".sass": "css", ".less": "css",
  ".sql": "sql",
  ".tex": "tex", ".sty": "tex", ".cls": "tex", ".ltx": "tex",
  ".html": "markup", ".htm": "markup", ".xml": "markup", ".svg": "markup",
  ".md": "markdown", ".markdown": "markdown", ".mdown": "markdown",
  ".mkd": "markdown", ".mdx": "markdown",
};

const FILENAME_LANG: Record<string, Lang> = {
  dockerfile: "shell",
  makefile: "shell",
  gnumakefile: "shell",
  ".gitignore": "shell",
  ".bashrc": "shell",
  ".zshrc": "shell",
  ".profile": "shell",
  gemfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  ".env": "toml",
  ".npmrc": "toml",
  ".editorconfig": "toml",
};

/** The highlighter language for a path, or "plain" when none applies (the viewer
 *  then shows the file uncoloured). Matched by extension first, then by a few
 *  well-known extensionless filenames. */
export function languageForPath(path: string): Lang {
  const name = (path.split(/[/\\]/).filter(Boolean).pop() ?? path).toLowerCase();
  const dot = name.lastIndexOf(".");
  // A leading-dot name (".gitignore") has no extension; only a dot past index 0
  // separates a real extension.
  const ext = dot > 0 ? name.slice(dot) : "";
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext];
  if (FILENAME_LANG[name]) return FILENAME_LANG[name];
  return "plain";
}

/**
 * The marker that comments out one whole line in `lang`, or `null` when the
 * language has none (JSON, markdown, plain text) or comments only in blocks
 * (HTML/XML — a linewise toggle would have to wrap every line in `<!-- -->`,
 * which is not the same gesture). Drives the editor's Ctrl+Shift+C toggle, so it
 * deliberately reports the *first* of a language's markers: the one written back
 * when commenting, while uncommenting only has to recognise what is there.
 */
export function lineCommentMarker(lang: Lang): string | null {
  if (lang === "tex") return "%";
  if (lang === "markup" || lang === "markdown" || lang === "plain") return null;
  return SPECS[lang].line[0] ?? null;
}

const isIdentStart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || c === "$";
const isIdentPart = (c: string) => isIdentStart(c) || (c >= "0" && c <= "9");
const isDigit = (c: string) => c >= "0" && c <= "9";

/** Read a string literal starting at `i` (on the opening delimiter). Returns the
 *  raw slice (including delimiters) and the index past it. Honours backslash
 *  escapes; single-line unless `multiline`. */
function readString(code: string, i: number, quote: string, multiline: boolean): [string, number] {
  const start = i;
  i += 1;
  while (i < code.length) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) { i += 1; break; }
    if (c === "\n" && !multiline) break;
    i += 1;
  }
  return [code.slice(start, i), i];
}

/** Read a number literal starting at `i`. Permissive: covers hex/binary/octal,
 *  floats, exponents, and digit separators (`_`). */
function readNumber(code: string, i: number): [string, number] {
  const start = i;
  i += 1;
  while (i < code.length) {
    const c = code[i];
    if (/[0-9a-fA-FxXoObB._]/.test(c)) { i += 1; continue; }
    if ((c === "+" || c === "-") && /[eE]/.test(code[i - 1])) { i += 1; continue; }
    break;
  }
  return [code.slice(start, i), i];
}

/** Maximum nesting `scanCode` recurses through for embedded code — a template
 *  literal's `${…}`, a JSX `{…}`. The source is arbitrary text and each level is
 *  a stack frame, so a pathological file must not overflow it; past the limit
 *  the embedded code is still emitted, just uncoloured. */
const CODE_NEST_MAX_DEPTH = 32;

/** The offset of the `}` closing the `{` at `open`, or `-1` when unbalanced (or,
 *  with `stopAtNewline`, when a line break comes first). Braces inside strings
 *  are counted too — a pragmatic miss, not a parse. */
function braceEnd(code: string, open: number, stopAtNewline: boolean): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "\n" && stopAtNewline) return -1;
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Embedded code (`${…}`, JSX `{…}`) re-scanned per `spec`, depth-limited. */
function nestedCode(code: string, spec: LangSpec, depth: number): string {
  return depth < CODE_NEST_MAX_DEPTH ? scanCode(code, spec, depth + 1) : escapeHtml(code);
}

const isWordPart = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_" || isDigit(c);

/** A string literal opened at `start` whose language interpolates into it
 *  (`spec.interp`): the literal text reads as a string, an `open` … `}` group as
 *  code, and (with `vars`) a bare `$name` as a variable. Same extent rules as
 *  `readString`. */
function scanInterpString(code: string, start: number, quote: string, multiline: boolean, spec: LangSpec, depth: number): [string, number] {
  const { open, vars } = spec.interp!;
  const n = code.length;
  let out = "";
  let seg = start;
  const flush = (to: number) => {
    if (to > seg) out += span("string", code.slice(seg, to));
    seg = to;
  };
  let i = start + 1;
  while (i < n) {
    const c = code[i];
    if (c === "\\") { i += 2; continue; }
    if (c === quote) { i += 1; break; }
    if (c === "\n" && !multiline) break;
    if (open && code.startsWith(open, i)) {
      const close = braceEnd(code, i + open.length - 1, !multiline);
      if (close !== -1) {
        flush(i);
        out += span("keyword", open) + nestedCode(code.slice(i + open.length, close), spec, depth) + span("keyword", "}");
        i = close + 1;
        seg = i;
        continue;
      }
    }
    if (vars && c === "$" && isIdentStart(code[i + 1] ?? "") && code[i + 1] !== "$") {
      let j = i + 2;
      while (j < n && isWordPart(code[j])) j += 1;
      flush(i);
      out += span("type", code.slice(i, j));
      i = j;
      seg = j;
      continue;
    }
    i += 1;
  }
  flush(Math.min(i, n));
  return [out, Math.min(i, n)];
}

/** The end of a `/regex/flags` literal opened at `i`, or `-1` when the line
 *  holds no closing `/` (then the `/` was a division after all). A `/` inside a
 *  `[…]` class does not close it. */
function regexEnd(code: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < code.length) {
    const c = code[j];
    if (c === "\n" || c === "\r") return -1;
    if (c === "\\") { j += 2; continue; }
    if (inClass) {
      if (c === "]") inClass = false;
    } else if (c === "[") {
      inClass = true;
    } else if (c === "/") {
      j += 1;
      while (j < code.length && isWordPart(code[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

/** A Rust char literal at the start of the text: one character or one escape
 *  (`\n`, `\'`, `\x7f`, `\u{1F600}`) between single quotes. */
const RUST_CHAR = /^'(?:\\(?:u\{[0-9a-fA-F_]{1,8}\}|x[0-9a-fA-F]{2}|.)|[^\\'\n\r])'/u;

const isJsxNamePart = (c: string) => isIdentPart(c) || c === "." || c === "-" || c === ":";

/** One JSX tag `<…>`, `</…>`, `<…/>` or fragment `<>`/`</>` at `i`, or `null`
 *  when what follows the `<` is not a tag after all — a TS generic such as
 *  `<T,>` or `<T extends U>`, or an unclosed one. */
function readJsxTag(code: string, i: number, spec: LangSpec, depth: number): { html: string; next: number; kind: "open" | "close" | "self" } | null {
  const n = code.length;
  let j = i + 1;
  let html = "&lt;";
  const closing = code[j] === "/";
  if (closing) { html += "/"; j += 1; }
  const nameStart = j;
  while (j < n && isJsxNamePart(code[j])) j += 1;
  const name = code.slice(nameStart, j);
  // An intrinsic element (`div`) reads as a tag, a component (`Button`) as a type.
  if (name) html += span(/^[a-z]/.test(name) ? "tag" : "type", name);
  else if (code[j] !== ">") return null;

  let firstAttr = true;
  while (j < n) {
    const c = code[j];
    if (c === ">") return { html: html + "&gt;", next: j + 1, kind: closing ? "close" : "open" };
    if (c === "/" && code[j + 1] === ">" && !closing) return { html: html + "/&gt;", next: j + 2, kind: "self" };
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { html += c; j += 1; continue; }
    if (closing) return null;
    if (c === "=") { html += "="; j += 1; continue; }
    if (c === '"' || c === "'") {
      const [str, next] = readString(code, j, c, true);
      if (next - 1 <= j || code[next - 1] !== c) return null;
      html += span("string", str);
      j = next;
      continue;
    }
    if (c === "{") {
      const close = braceEnd(code, j, false);
      if (close === -1) return null;
      html += "{" + nestedCode(code.slice(j + 1, close), spec, depth) + "}";
      j = close + 1;
      continue;
    }
    if (isIdentStart(c)) {
      let k = j + 1;
      while (k < n && isJsxNamePart(code[k])) k += 1;
      const attr = code.slice(j, k);
      if (firstAttr && attr === "extends") return null;
      firstAttr = false;
      html += span("attr", attr);
      j = k;
      continue;
    }
    return null;
  }
  return null;
}

/** A whole JSX element at `i` — its tags, `{…}` children as code, the text
 *  between as plain — or `null` when it is not one (the caller then treats the
 *  `<` as a less-than). */
function scanJsx(code: string, i: number, spec: LangSpec, depth: number): { html: string; next: number } | null {
  const first = readJsxTag(code, i, spec, depth);
  if (!first || first.kind === "close") return null;
  let html = first.html;
  let j = first.next;
  if (first.kind === "self") return { html, next: j };
  let open = 1;
  const n = code.length;
  while (j < n) {
    const c = code[j];
    if (c === "<") {
      const tag = readJsxTag(code, j, spec, depth);
      if (!tag) return null;
      html += tag.html;
      j = tag.next;
      if (tag.kind === "open") open += 1;
      else if (tag.kind === "close") {
        open -= 1;
        if (open === 0) return { html, next: j };
      }
      continue;
    }
    if (c === "{") {
      const close = braceEnd(code, j, false);
      if (close === -1) return null;
      html += "{" + nestedCode(code.slice(j + 1, close), spec, depth) + "}";
      j = close + 1;
      continue;
    }
    let k = j + 1;
    while (k < n && code[k] !== "<" && code[k] !== "{") k += 1;
    html += escapeHtml(code.slice(j, k));
    j = k;
  }
  return null;
}

// What precedes a `/` or `<` decides whether an expression starts there (a regex
// literal / a JSX element) or an operator does (division / less-than). `prev` in
// `scanCode` is "" at the start, "k" after a keyword, "v" after a value (name,
// number, string, literal), else the punctuation character itself.
const EXPR_AFTER = new Set(["", "k", "(", "[", "{", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "<", ">", "~", "^"]);

/** True when `i` is the first non-blank of its line. */
function atLineStart(code: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (code[j] === " " || code[j] === "\t")) j -= 1;
  return j < 0 || code[j] === "\n" || code[j] === "\r";
}

/** Tokenize generic code per `spec` into safe highlighted HTML. `depth` counts
 *  the embedded-code levels (`${…}`, JSX `{…}`) this call is nested in. */
function scanCode(code: string, spec: LangSpec, depth = 0): string {
  let out = "";
  let i = 0;
  const n = code.length;
  let prev = "";

  // The first characters of the line-comment markers: most positions start none,
  // and are told so without a search over the markers.
  const commentLeads = new Set(spec.line.map((m) => m[0]));
  const atLineComment = () =>
    commentLeads.has(code[i]) ? spec.line.find((m) => code.startsWith(m, i)) : undefined;

  while (i < n) {
    const c = code[i];

    // Block comment — before line comments, since Lua's `--[[` starts with `--`.
    if (spec.block && code.startsWith(spec.block[0], i)) {
      const close = code.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = close === -1 ? n : close + spec.block[1].length;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Line comment → to end of line.
    const lc = atLineComment();
    if (lc) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Strings (including Python triple-quoted).
    if (spec.strings.includes(c)) {
      prev = "v";
      if (spec.triple && code.startsWith(c.repeat(3), i)) {
        const close = code.indexOf(c.repeat(3), i + 3);
        const stop = close === -1 ? n : close + 3;
        out += span("string", code.slice(i, stop));
        i = stop;
        continue;
      }
      if (spec.interp?.quotes.includes(c)) {
        const [html, next] = scanInterpString(code, i, c, c === "`", spec, depth);
        out += html;
        i = next;
        continue;
      }
      const [str, next] = readString(code, i, c, c === "`" || !!spec.rust);
      // JSON/YAML look: a string that is the key of a mapping reads as a prop.
      if (spec.keyStrings) {
        let j = next;
        while (j < n && (code[j] === " " || code[j] === "\t")) j += 1;
        out += span(code[j] === ":" ? "prop" : "string", str);
      } else {
        out += span("string", str);
      }
      i = next;
      continue;
    }

    // Shell/Perl `$variable`.
    if (spec.sigil && c === spec.sigil) {
      let j = i + 1;
      if (code[j] === "{") { j = code.indexOf("}", j); j = j === -1 ? n : j + 1; }
      else while (j < n && isIdentPart(code[j])) j += 1;
      out += span("type", code.slice(i, j));
      prev = "v";
      i = j;
      continue;
    }

    // `@decorator` / `@Annotation` / Ruby `@ivar`.
    if (spec.annotations && c === "@" && isIdentStart(code[i + 1] ?? "")) {
      let j = i + 2;
      while (j < n && (isIdentPart(code[j]) || (code[j] === "." && isIdentStart(code[j + 1] ?? "")))) j += 1;
      out += span("attr", code.slice(i, j));
      prev = "v";
      i = j;
      continue;
    }

    // C-family `#include`, `#define`, `#if`, … at the start of a line.
    if (spec.preproc && c === "#" && isIdentStart(code[i + 1] ?? "") && atLineStart(code, i)) {
      let j = i + 2;
      while (j < n && isIdentPart(code[j])) j += 1;
      const directive = code.slice(i, j);
      out += span("keyword", directive);
      i = j;
      if (directive === "#include" || directive === "#import") {
        while (j < n && (code[j] === " " || code[j] === "\t")) j += 1;
        const close = code[j] === "<" ? code.indexOf(">", j) : -1;
        const eol = code.indexOf("\n", j);
        if (close !== -1 && (eol === -1 || close < eol)) {
          out += code.slice(i, j) + span("string", code.slice(j, close + 1));
          i = close + 1;
        }
      }
      continue;
    }

    // Rust `'c'` / `'\n'` / `'\u{1F600}'` char literals, else a `'a` lifetime or
    // `'outer:` label. Without this a `'"'` would open a string to end of line.
    if (spec.rust && c === "'") {
      const ch = RUST_CHAR.exec(code.slice(i, i + 12));
      if (ch) {
        out += span("string", ch[0]);
        prev = "v";
        i += ch[0].length;
        continue;
      }
      if (isIdentStart(code[i + 1] ?? "")) {
        let j = i + 2;
        while (j < n && isIdentPart(code[j])) j += 1;
        out += span("type", code.slice(i, j));
        prev = "v";
        i = j;
        continue;
      }
    }

    // Rust `#[derive(…)]` / `#![allow(…)]`.
    if (spec.rust && c === "#" && (code[i + 1] === "[" || (code[i + 1] === "!" && code[i + 2] === "["))) {
      const open = code.indexOf("[", i);
      let level = 0;
      let j = open;
      for (; j < n; j++) {
        if (code[j] === "[") level += 1;
        else if (code[j] === "]" && --level === 0) break;
      }
      if (j < n) {
        out += span("attr", code.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }

    // Ruby/Elixir `:symbol` (not `::`, not the `:` of a `key:` or a ternary's).
    if (spec.symbols && c === ":" && isIdentStart(code[i + 1] ?? "") && code[i - 1] !== ":" && !isIdentPart(code[i - 1] ?? "")) {
      let j = i + 2;
      while (j < n && isIdentPart(code[j])) j += 1;
      if (code[j] === "?" || code[j] === "!") j += 1;
      out += span("prop", code.slice(i, j));
      prev = "v";
      i = j;
      continue;
    }

    // Numbers (a leading digit, or a dot directly before one).
    if (isDigit(c) || (c === "." && isDigit(code[i + 1] ?? ""))) {
      const [num, next] = readNumber(code, i);
      out += span("num", num);
      prev = "v";
      i = next;
      continue;
    }

    // Identifiers / keywords / types / function calls.
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(code[j])) j += 1;
      const word = code.slice(i, j);
      // Rust raw strings `r"…"`, `r#"…"#`, `br##"…"##`: no escapes, and only a
      // `"` followed by as many `#` as opened them closes one.
      if (spec.rust && (word === "r" || word === "br" || word === "cr")) {
        let k = j;
        while (code[k] === "#") k += 1;
        if (code[k] === '"') {
          const close = code.indexOf('"' + "#".repeat(k - j), k + 1);
          const stop = close === -1 ? n : close + 1 + (k - j);
          out += span("string", code.slice(i, stop));
          prev = "v";
          i = stop;
          continue;
        }
      }
      const key = spec.caseInsensitive ? word.toLowerCase() : word;
      if (spec.keywords.has(key) || spec.literals.has(key)) {
        out += span("keyword", word);
        prev = spec.keywords.has(key) && word !== "this" && word !== "super" ? "k" : "v";
      } else if (spec.types.has(key) || (!spec.caseInsensitive && /^[A-Z]/.test(word))) {
        out += span("type", word);
        prev = "v";
      } else {
        // A name immediately followed by `(` is a call/definition; in Rust, a
        // `name!` not part of a `!=` is a macro call (`println!(`, `vec![`,
        // `macro_rules! name`).
        let k = j;
        while (k < n && (code[k] === " " || code[k] === "\t")) k += 1;
        const macro = spec.rust && code[j] === "!" && code[j + 1] !== "=";
        out += code[k] === "(" || macro ? span("func", word) : escapeHtml(word);
        prev = "v";
      }
      i = j;
      continue;
    }

    // Whitespace passes through as one run: no language's comment marker, string
    // delimiter or sigil starts with a blank, so each of these characters would
    // reach this point on its own — the run just skips re-testing every branch.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      let j = i + 1;
      while (j < n && (code[j] === " " || code[j] === "\t" || code[j] === "\n" || code[j] === "\r")) j += 1;
      out += code.slice(i, j);
      i = j;
      continue;
    }

    // `/regex/` where an expression starts (comments were matched above).
    if (spec.regex && c === "/" && EXPR_AFTER.has(prev)) {
      const end = regexEnd(code, i);
      if (end !== -1) {
        out += span("string", code.slice(i, end));
        prev = "v";
        i = end;
        continue;
      }
    }

    // A JSX element where an expression starts.
    if (spec.jsx && c === "<" && EXPR_AFTER.has(prev) && (isIdentStart(code[i + 1] ?? "") || code[i + 1] === ">")) {
      const el = scanJsx(code, i, spec, depth);
      if (el) {
        out += el.html;
        prev = "v";
        i = el.next;
        continue;
      }
    }

    // Anything else (punctuation) passes through, escaped.
    out += escapeHtml(c);
    prev = c;
    i += 1;
  }

  return out;
}

const MARKUP_COMMENT = ["<!--", "-->"] as const;

/** Tokenize HTML/XML/SVG: comments, tags + attributes, and quoted values, with
 *  the text between tags left plain. */
function scanMarkup(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    if (code.startsWith(MARKUP_COMMENT[0], i)) {
      const close = code.indexOf(MARKUP_COMMENT[1], i);
      const stop = close === -1 ? n : close + MARKUP_COMMENT[1].length;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    if (code[i] === "<") {
      const close = code.indexOf(">", i);
      const stop = close === -1 ? n : close + 1;
      out += scanTag(code.slice(i, stop));
      i = stop;
      continue;
    }

    const next = code.indexOf("<", i);
    const stop = next === -1 ? n : next;
    out += escapeHtml(code.slice(i, stop));
    i = stop;
  }

  return out;
}

/** Highlight a single `<...>` tag: the `<`/`</`/`>` punctuation, the tag name,
 *  attribute names, and quoted attribute values. */
function scanTag(tag: string): string {
  let out = "";
  let i = 0;
  const n = tag.length;

  // Opening punctuation and the tag name.
  out += escapeHtml(tag[i]); // '<'
  i += 1;
  if (tag[i] === "/") { out += "/"; i += 1; }
  let j = i;
  while (j < n && /[^\s/>]/.test(tag[j])) j += 1;
  if (j > i) out += span("tag", tag.slice(i, j));
  i = j;

  // Attributes and values until '>'.
  while (i < n) {
    const c = tag[i];
    if (c === '"' || c === "'") {
      const [str, next] = readString(tag, i, c, false);
      out += span("string", str);
      i = next;
    } else if (/[A-Za-z_:@-]/.test(c)) {
      let k = i + 1;
      while (k < n && /[^\s=/>]/.test(tag[k])) k += 1;
      out += span("attr", tag.slice(i, k));
      i = k;
    } else {
      out += escapeHtml(c);
      i += 1;
    }
  }

  return out;
}

/** The offset of the `}` closing the group opened at `open`, or `-1` when the
 *  source is unbalanced. Nesting counts; an escaped brace (`\{`, `\}`) is not a
 *  brace at all, which the "skip the character after a backslash" step covers —
 *  it also steps over `\\`, so a line break inside an argument is inert. */
function texGroupEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "\\") { i += 1; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Maximum brace nesting the argument scanner recurses through. A `.tex` file is
 *  arbitrary text, and this recursion is one stack frame per level, so a
 *  pathological (or corrupt) file must not be able to overflow it; past the
 *  limit an argument's content is still emitted, just without its own inner
 *  tokenizing. Real documents nest a handful of levels. */
const TEX_ARG_MAX_DEPTH = 32;

/**
 * The brace arguments directly following a control word — `\emph{…}`,
 * `\frac{a}{b}`, `\includegraphics[width=2cm]{fig}` — with each group's CONTENT
 * rendered italic (`tok-arg`); the braces themselves stay plain, so the source
 * still reads as source. The content is re-scanned recursively rather than
 * escaped flat, so a command nested in an argument keeps its own colour and the
 * span contributes only the slant (`font-style` inherits into the inner spans).
 *
 * Returns `null` when there is no group to take — no `{`, or an unbalanced one —
 * leaving those characters to the caller's main loop. A `[…]` optional argument
 * between the command and its braces is passed through plain and does not by
 * itself count as having taken an argument.
 */
function texArgGroups(code: string, from: number, depth: number): { html: string; next: number } | null {
  let i = from;
  let html = "";
  let took = false;
  for (;;) {
    // Only blanks may sit between a command and its argument: a newline there is
    // far more often the end of the command's line than a wrapped argument.
    let j = i;
    while (j < code.length && (code[j] === " " || code[j] === "\t")) j += 1;
    if (code[j] === "{") {
      const close = texGroupEnd(code, j);
      if (close === -1) break;
      const inner = code.slice(j + 1, close);
      // The wrapper is written out rather than built with `span`, which escapes
      // its text — here the content is already-tokenized HTML.
      html += escapeHtml(code.slice(i, j + 1));
      html += `<span class="tok-arg">${
        depth < TEX_ARG_MAX_DEPTH ? scanTex(inner, depth + 1) : escapeHtml(inner)
      }</span>`;
      html += escapeHtml("}");
      i = close + 1;
      took = true;
      continue;
    }
    if (code[j] === "[") {
      // `\includegraphics[width=2cm]{fig}`: step over the optional argument so the
      // brace group after it is still recognised. Never across a line.
      const close = code.indexOf("]", j + 1);
      const nl = code.indexOf("\n", j + 1);
      if (close === -1 || (nl !== -1 && nl < close)) break;
      html += escapeHtml(code.slice(i, close + 1));
      i = close + 1;
      continue;
    }
    break;
  }
  return took ? { html, next: i } : null;
}

/** Environments the compiler throws away wholesale — `comment`, from the
 *  `comment`/`verbatim` packages. Their body is not LaTeX at all, so the
 *  highlighter greys the whole block instead of tokenizing inside it. */
const TEX_COMMENT_ENVS = new Set(["comment"]);

/**
 * When the `\begin` ending at `afterCmd` opens a comment environment, the offset
 * just past its matching `\end{…}` — or the end of the file when it is never
 * closed, so an unterminated block greys out to the bottom instead of silently
 * reading as ordinary source (which is also what the compiler does with it).
 * `null` when this is any other environment, leaving the normal `\begin{env}`
 * path to colour it.
 */
function texCommentEnvEnd(code: string, afterCmd: number): number | null {
  if (code[afterCmd] !== "{") return null;
  const close = code.indexOf("}", afterCmd + 1);
  if (close === -1) return null;
  const name = code.slice(afterCmd + 1, close);
  if (!TEX_COMMENT_ENVS.has(name)) return null;
  const closer = `\\end{${name}}`;
  const end = code.indexOf(closer, close + 1);
  return end === -1 ? code.length : end + closer.length;
}

/** Sectioning commands: the command stays a keyword, but also carries
 *  `tok-section` so a theme can set the title argument after it apart as a
 *  heading (`.tok-section + .tok-arg`). */
const TEX_SECTION_CMDS = new Set([
  "\\part", "\\chapter", "\\section", "\\subsection", "\\subsubsection",
  "\\paragraph", "\\subparagraph", "\\frametitle", "\\title",
]);

/**
 * The offset of the math closer `close` (`$`, `$$`, `\)` or `\]`) at or after
 * `from`, or -1 when the math is never closed. An escaped character (`\$`) is
 * stepped over, a `%` comment is skipped to its line end (a `$` in it closes
 * nothing), and a blank line gives up — TeX ends the paragraph there, and a
 * stray `$` being typed must not paint the rest of the file as math.
 */
function texMathEnd(code: string, from: number, close: string): number {
  const n = code.length;
  for (let i = from; i < n; i++) {
    const c = code[i];
    if (c === "\\") {
      if (close.length === 2 && close[0] === "\\" && code[i + 1] === close[1]) return i;
      i += 1;
      continue;
    }
    if (c === "%") {
      const nl = code.indexOf("\n", i);
      if (nl === -1) return -1;
      i = nl - 1;
      continue;
    }
    if (c === "$" && close[0] === "$") {
      if (close === "$") return i;
      if (code[i + 1] === "$") return i;
    }
    if (c === "\n") {
      let j = i + 1;
      while (j < n && (code[j] === " " || code[j] === "\t")) j += 1;
      if (code[j] === "\n") return -1;
    }
  }
  return -1;
}

/** A closed math run as `tok-math`, delimiters included. The body is
 *  re-scanned like an argument, so `\frac` inside still colours as a command
 *  and a number as a number; the span only supplies the math colour around
 *  them. */
function texMathSpan(open: string, inner: string, close: string, depth: number): string {
  return `<span class="tok-math">${escapeHtml(open)}${
    depth < TEX_ARG_MAX_DEPTH ? scanTex(inner, depth + 1) : escapeHtml(inner)
  }${escapeHtml(close)}</span>`;
}

/** Tokenize LaTeX/TeX: `%` line comments and `\begin{comment}` blocks, `\control`
 *  sequences, the environment name inside `\begin{…}`/`\end{…}`, a command's
 *  brace arguments (italic), bare numbers, and math (`$…$`, `$$…$$`, `\(…\)`,
 *  `\[…\]`) as one `tok-math` run whose body is re-scanned, so commands inside
 *  (e.g. `\frac`) still colour as commands. `depth` is the brace-nesting level
 *  the argument scanner recurses at — callers outside this file always start
 *  at 0. */
function scanTex(code: string, depth = 0): string {
  let out = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const c = code[i];

    // Comment to end of line. A literal percent is written `\%`, which the
    // control-sequence branch consumes first, so any `%` reaching here opens one.
    if (c === "%") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }

    // Control sequence: `\` then either a run of letters (`\section`) or a single
    // non-letter (`\\`, `\%`, `\{`).
    if (c === "\\") {
      let j = i + 1;
      let word = false;
      if (j < n && /[A-Za-z]/.test(code[j])) {
        while (j < n && /[A-Za-z]/.test(code[j])) j += 1;
        word = true;
      } else {
        j = Math.min(j + 1, n);
      }
      const cmd = code.slice(i, j);

      // `\begin{comment}` … `\end{comment}`: the body is not typeset, so the
      // whole block — delimiters included — greys out as one comment, the way a
      // `%` line does. Checked before the keyword span so nothing inside is
      // tokenized.
      if (cmd === "\\begin") {
        const stop = texCommentEnvEnd(code, j);
        if (stop !== null) {
          out += span("comment", code.slice(i, stop));
          i = stop;
          continue;
        }
      }

      // `\(…\)` / `\[…\]`: math, the same as `$…$` / `$$…$$` below.
      if (cmd === "\\(" || cmd === "\\[") {
        const close = cmd === "\\(" ? "\\)" : "\\]";
        const end = texMathEnd(code, j, close);
        if (end !== -1) {
          out += texMathSpan(cmd, code.slice(j, end), close, depth);
          i = end + 2;
          continue;
        }
      }

      out += TEX_SECTION_CMDS.has(cmd)
        ? `<span class="tok-keyword tok-section">${escapeHtml(cmd)}</span>`
        : span("keyword", cmd);
      i = j;

      // `\begin{env}` / `\end{env}` → colour the environment name as a type. Not
      // an argument: the name names a structure rather than reading as text, and
      // it is the one brace group whose own colour would be lost to the slant.
      if ((cmd === "\\begin" || cmd === "\\end") && code[i] === "{") {
        const close = code.indexOf("}", i);
        if (close !== -1) {
          out += escapeHtml("{") + span("type", code.slice(i + 1, close)) + escapeHtml("}");
          i = close + 1;
          // `\begin{frame}<1->`: an overlay spec on the environment itself.
          const spec = overlaySpecAt(code, i);
          if (spec) {
            out += span("overlay", code.slice(i, spec.end));
            i = spec.end;
          }
        }
        continue;
      }

      // A beamer overlay specification glued to a control word — `\only<2->`,
      // `\item<3>`, `\alert<+->` (#tex-beamer) — is its own token, so the slide
      // numbers stand out from the prose around them. Only the strict spec
      // grammar qualifies (`overlaySpecAt`); a `<` that is prose or math stays
      // plain.
      if (word) {
        const spec = overlaySpecAt(code, i);
        if (spec) {
          out += span("overlay", code.slice(i, spec.end));
          i = spec.end;
        }
      }

      // Any other control WORD carries its brace arguments in italic. A single
      // non-letter sequence (`\%`, `\{`, `\\`) takes none — the `{` after one is
      // ordinary text, not its argument.
      if (word) {
        const args = texArgGroups(code, i, depth);
        if (args) {
          out += args.html;
          i = args.next;
        }
      }
      continue;
    }

    // Inline `$…$` or display `$$…$$` math. An unclosed opener stays plain —
    // both dollars of an unclosed `$$`, so the second is not retried as an
    // inline opener that would pair with some later `$`.
    if (c === "$") {
      const open = code[i + 1] === "$" ? "$$" : "$";
      const end = texMathEnd(code, i + open.length, open);
      if (end !== -1) {
        out += texMathSpan(open, code.slice(i + open.length, end), open, depth);
        i = end + open.length;
      } else {
        out += escapeHtml(open);
        i += open.length;
      }
      continue;
    }

    if (isDigit(c)) {
      const [num, next] = readNumber(code, i);
      out += span("num", num);
      i = next;
      continue;
    }

    // Plain text. Taken as the whole run up to the next character that could open
    // a token (exactly the ones the branches above test for), so prose is escaped
    // once per run rather than once per character — the same output, since every
    // character in the run would have fallen through to here on its own.
    let j = i + 1;
    while (j < n) {
      const d = code[j];
      if (d === "%" || d === "\\" || d === "$" || isDigit(d)) break;
      j += 1;
    }
    out += escapeHtml(code.slice(i, j));
    i = j;
  }

  return out;
}

/** One inline token of plain text, tried in order at each position: a URL or
 *  e-mail address, an ISO date/time or a clock time, a double-quoted run, a
 *  TODO-style marker, a log level, a number. Each alternative is its own group
 *  so the match says which it was (see `PLAIN_GROUP_CLASS`). The open-ended
 *  runs (an address's parts, a quote's body) are length-capped: a file can be
 *  one 200k-character line, and an uncapped run retried from every start
 *  position would scan it quadratically. */
const PLAIN_TOKEN = new RegExp(
  [
    /(https?:\/\/[^\s<>"'`)\]]+|\b[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8})/.source,
    /(\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{1,2}:\d{2}(?::\d{2})?\b)/.source,
    /("[^"\n]{0,200}"|\u201c[^\u201d\n]{0,200}\u201d)/.source,
    /\b(TODO|FIXME|XXX|HACK|NOTE)\b/.source,
    /\b(ERROR|FATAL|CRITICAL|FAIL(?:ED|URE)?)\b/.source,
    /\b(WARN(?:ING)?)\b/.source,
    /\b(INFO|OK|PASS(?:ED)?)\b/.source,
    /\b(DEBUG|TRACE)\b/.source,
    /(?<![\w.])(\d+(?:[.,]\d+)*%?)(?![\w.]\w)/.source,
  ].join("|"),
  "g",
);
const PLAIN_GROUP_CLASS = [
  "txt-url", "txt-date", "txt-string", "txt-marker",
  "txt-bad", "txt-warn", "txt-info", "txt-debug", "txt-num",
];

function scanPlainInline(text: string): string {
  let out = "";
  let last = 0;
  PLAIN_TOKEN.lastIndex = 0;
  for (let m = PLAIN_TOKEN.exec(text); m; m = PLAIN_TOKEN.exec(text)) {
    const g = m.findIndex((v, k) => k > 0 && v !== undefined);
    out += escapeHtml(text.slice(last, m.index)) + span(PLAIN_GROUP_CLASS[g - 1], m[0]);
    last = m.index + m[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

const PLAIN_RULE = /^\s*(?:={3,}|-{3,}|\*{3,}|_{3,})\s*$/;
const PLAIN_ATX = /^\s{0,3}#{1,6}\s+\S/;
const PLAIN_LIST = /^(\s*)([-*+\u2022]|\d{1,3}[.)])(\s+)/;
const PLAIN_KEY = /^(\s*)([A-Za-z_][\w.-]{0,40})(\s*[:=])(?=\s)/;

/**
 * Plain text (`.txt`, `.log`, anything unrecognised): no grammar to follow, so
 * only what reads unambiguously as structure is marked — a heading (`# Title`,
 * or a line underlined with `===`/`---`), the underline or a `***` rule itself,
 * a list bullet, a leading `key:`/`key =`, and the inline tokens above. The
 * classes (`tok-txt-*`) carry colour only in a theme that styles them, so
 * elsewhere a text file still reads as uncoloured.
 */
function scanPlain(code: string): string {
  const lines = code.split("\n");
  return lines
    .map((line, k) => {
      if (PLAIN_RULE.test(line)) return span("txt-rule", line);
      const next = lines[k + 1];
      const underlined =
        next !== undefined && /^\s*(?:={3,}|-{3,})\s*$/.test(next) && line.trim() !== "";
      if (underlined || PLAIN_ATX.test(line)) return span("txt-heading", line);
      const list = PLAIN_LIST.exec(line);
      if (list) {
        const head = list[0].length;
        return (
          escapeHtml(list[1]) + span("txt-list", list[2]) + escapeHtml(list[3]) +
          scanPlainInline(line.slice(head))
        );
      }
      const key = PLAIN_KEY.exec(line);
      if (key) {
        return (
          escapeHtml(key[1]) + span("txt-key", key[2]) + escapeHtml(key[3]) +
          scanPlainInline(line.slice(key[0].length))
        );
      }
      return scanPlainInline(line);
    })
    .join("\n");
}

const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9]/.test(c);

/** Highlight the inline span content of one markdown line: code spans, links/
 *  images, and `**strong**` / `*emphasis*` runs. Emphasis uses CommonMark-style
 *  flanking checks (no space just inside the markers, underscores not intra-word)
 *  so stray `*`/`_` in prose or `2 * 3` math don't get coloured. Everything not
 *  matched passes through HTML-escaped. */
function scanMarkdownInline(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Inline code: a run of N backticks closed by the same run.
    if (c === "`") {
      let ticks = 0;
      while (text[i + ticks] === "`") ticks += 1;
      const close = text.indexOf("`".repeat(ticks), i + ticks);
      if (close !== -1) {
        out += span("md-code", text.slice(i, close + ticks));
        i = close + ticks;
        continue;
      }
    }

    // Link `[text](url)` or image `![alt](url)`.
    if (c === "[" || (c === "!" && text[i + 1] === "[")) {
      const lb = c === "!" ? i + 1 : i;
      const rb = text.indexOf("]", lb + 1);
      if (rb !== -1 && text[rb + 1] === "(") {
        const rp = text.indexOf(")", rb + 2);
        if (rp !== -1) {
          if (c === "!") out += escapeHtml("!");
          out += escapeHtml("[") + span("md-link", text.slice(lb + 1, rb)) + escapeHtml("](");
          out += span("md-url", text.slice(rb + 2, rp)) + escapeHtml(")");
          i = rp + 1;
          continue;
        }
      }
    }

    // Strong: ** or __ (checked before emphasis so `**` wins over `*`).
    if (
      (c === "*" || c === "_") && text[i + 1] === c &&
      text[i + 2] !== undefined && text[i + 2] !== " " &&
      !(c === "_" && isWordChar(text[i - 1]))
    ) {
      const close = text.indexOf(c + c, i + 2);
      if (close !== -1 && text[close - 1] !== " " &&
          !(c === "_" && isWordChar(text[close + 2]))) {
        out += span("md-strong", text.slice(i, close + 2));
        i = close + 2;
        continue;
      }
    }

    // Emphasis: a single * or _.
    if (
      (c === "*" || c === "_") &&
      text[i + 1] !== undefined && text[i + 1] !== " " && text[i + 1] !== c &&
      !(c === "_" && isWordChar(text[i - 1]))
    ) {
      const close = text.indexOf(c, i + 1);
      if (close !== -1 && text[close - 1] !== " " &&
          !(c === "_" && isWordChar(text[close + 1]))) {
        out += span("md-em", text.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }

    // Plain text, as one run up to the next character a branch above could act
    // on (see `scanTex`): the same output, escaped once per run.
    let j = i + 1;
    while (j < n) {
      const d = text[j];
      if (d === "`" || d === "[" || d === "!" || d === "*" || d === "_") break;
      j += 1;
    }
    out += escapeHtml(text.slice(i, j));
    i = j;
  }

  return out;
}

/** Tokenize Markdown line-by-line: fenced code blocks, ATX headings, horizontal
 *  rules, blockquote/list line prefixes, plus the inline spans handled by
 *  {@link scanMarkdownInline}. A focused subset, like the other scanners. */
function scanMarkdown(code: string): string {
  const lines = code.split("\n");
  let out = "";
  let inFence = false;
  let fence = "";

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    const nl = li < lines.length - 1 ? "\n" : "";

    // Inside a fenced code block: paint verbatim until a matching close fence.
    if (inFence) {
      out += span("md-code", line) + nl;
      if (line.trimStart().startsWith(fence)) inFence = false;
      continue;
    }

    // Opening code fence (``` or ~~~, optionally with an info string).
    const open = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (open) {
      inFence = true;
      fence = open[1].slice(0, 3);
      out += span("md-code", line) + nl;
      continue;
    }

    // ATX heading (#…######).
    if (/^\s{0,3}#{1,6}(\s|$)/.test(line)) {
      out += span("md-heading", line) + nl;
      continue;
    }

    // Horizontal rule (three or more -, *, or _).
    if (/^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      out += span("md-hr", line) + nl;
      continue;
    }

    // Leading blockquote markers and/or a list marker, then inline content.
    let rest = line;
    let prefix = "";
    const bq = /^(\s{0,3}(?:>\s?)+)/.exec(rest);
    if (bq) {
      prefix += span("md-quote", bq[1]);
      rest = rest.slice(bq[1].length);
    }
    const list = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)/.exec(rest);
    if (list) {
      prefix += escapeHtml(list[1]) + span("md-list", list[2]) + escapeHtml(list[3]);
      rest = rest.slice(list[0].length);
    }

    out += prefix + scanMarkdownInline(rest) + nl;
  }

  return out;
}

/** Largest source we will highlight, in characters. Beyond this the viewer falls
 *  back to plain text so editing a huge file stays responsive (re-highlight runs
 *  on every keystroke). */
export const HIGHLIGHT_MAX_CHARS = 200_000;

/**
 * Highlight `code` for `lang`, returning safe HTML, or `null` when there is
 * nothing to do — a file over `HIGHLIGHT_MAX_CHARS` — so the caller can render
 * the raw text instead. `"plain"` gets the light prose tokenizer.
 */
export function highlight(code: string, lang: Lang): string | null {
  if (code.length > HIGHLIGHT_MAX_CHARS) return null;
  if (lang === "plain") return scanPlain(code);
  if (lang === "markup") return scanMarkup(code);
  if (lang === "tex") return scanTex(code);
  if (lang === "markdown") return scanMarkdown(code);
  return scanCode(code, SPECS[lang]);
}
