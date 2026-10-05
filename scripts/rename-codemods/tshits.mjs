// usage: node tshits.mjs [--tokens] files...   lists non-comment brand hits in TS/TSX
/* global process, console */
import ts from 'typescript';
import fs from 'node:fs';
const K = ts.SyntaxKind;
const kinds = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText, K.Identifier, K.RegularExpressionLiteral, K.PrivateIdentifier]);
const tokensMode = process.argv.includes('--tokens');
const counts = new Map();
export function hits(file) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const visit = (n) => {
    if (kinds.has(n.kind)) {
      const t = n.getText(sf);
      if (/eldrun/i.test(t)) out.push({ kind: K[n.kind], start: n.getStart(sf), end: n.getEnd(), text: t, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2).filter(a => !a.startsWith('--'))) {
    const hs = hits(f);
    if (!hs.length) continue;
    if (tokensMode) { for (const h of hs) for (const m of h.text.matchAll(/[A-Za-z0-9_.:/~$-]*eldrun[A-Za-z0-9_.:/-]*/gi)) { const k = (h.kind === 'Identifier' ? 'id:' : '') + m[0]; counts.set(k, (counts.get(k) || 0) + 1); } }
    else { console.log('## ' + f); for (const h of hs) console.log(`${h.line}: [${h.kind.replace('Literal','')}] ${h.text.replace(/\s+/g,' ').slice(0, 150)}`); }
  }
  if (tokensMode) console.log([...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  '));
}
