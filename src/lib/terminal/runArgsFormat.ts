/**
 * Display ⇄ storage forms of a Run button's argument string.
 *
 * The saved string is one command-line fragment, appended verbatim after the
 * script (`pythonRun.ts`'s `buildRunCommand`), so it must stay a single line —
 * a newline would end the shell command. The editors show it as a list
 * instead: each option starts its own line, its values beside it, so a long
 * `--config a.yml --config b.yml --num_threads 4` reads at a glance rather
 * than scrolling off a one-line field. Quotes and backslash escapes are
 * respected both ways; a newline inside quotes is the user's and survives.
 */

/** True for a token that opens an option: `-x`, `--name`, not `-0.5` or `-`. */
function isOption(token: string): boolean {
  return /^--?[A-Za-z_]/.test(token);
}

/** Splits on unquoted whitespace, keeping each token's original spelling. */
function tokens(args: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"' && i + 1 < args.length) cur += args[++i];
      else if (c === quote) quote = null;
    } else if (c === "\\" && i + 1 < args.length) {
      cur += c + args[++i];
    } else if (c === '"' || c === "'") {
      quote = c;
      cur += c;
    } else if (/\s/.test(c)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** The saved string as editor text: one option (with its values) per line. */
export function argsToLines(args: string): string {
  const lines: string[] = [];
  for (const tok of tokens(args)) {
    if (lines.length === 0 || isOption(tok)) lines.push(tok);
    else lines[lines.length - 1] += ` ${tok}`;
  }
  return lines.join("\n");
}

/** Editor text back to the one-line saved string. Unquoted line breaks (and a
 *  `\` continuation before one) become a single space. */
export function argsFromLines(text: string): string {
  let out = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      out += c;
      if (c === "\\" && quote === '"' && i + 1 < text.length) out += text[++i];
      else if (c === quote) quote = null;
    } else if (c === "\\" && (text[i + 1] === "\n" || (text[i + 1] === "\r" && text[i + 2] === "\n"))) {
      // A shell-style continuation: drop it with its break.
      continue;
    } else if (c === "\\" && i + 1 < text.length) {
      out += c + text[++i];
    } else if (c === "\n" || c === "\r") {
      out = out.replace(/[ \t]+$/, "");
      if (out && !out.endsWith(" ")) out += " ";
      while (i + 1 < text.length && /[ \t\r\n]/.test(text[i + 1])) i++;
    } else {
      if (c === '"' || c === "'") quote = c;
      out += c;
    }
  }
  return out.trim();
}
