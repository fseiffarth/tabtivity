// TS/TSX brand codemod. usage: node tsmod.mjs [--dry] [--neutral-dash] files...
/* global process, console */
/* eslint-disable no-control-regex */
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
const ROOT = process.cwd();
const BRAND_FILE = path.join(ROOT, 'src/lib/brand.ts');
const K = ts.SyntaxKind;
const dry = process.argv.includes('--dry');
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
const ANY = /eldrun/i;

const DOM_EVENTS = new Set(['open-settings','close-settings','open-shortcut-help','start-tour','open-lessons','reveal-side-panel','open-how-to-start','theme-changed','steering-prompt','settings-changed','screenshot-capture','project-jump','open-stats','open-project-dialog','language-changed','appearance-changed','agent-registry-changed','new-tab-slots','new-tab-shortcut']);
const DASH_STORAGE = new Set(['theme','accent','theme-vars','corners','dev-react-scan','lang','show-untested-tags','markup-pen']);
// code-only names: plain neutral rename (value -> value)
const NEUTRAL = new Map(Object.entries({
  'eldrun-icon':'app-icon','eldrun-agent-zoom':'app-agent-zoom','eldrun-dev-perf-layer':'app-dev-perf-layer',
  'eldrun-print-options':'app-print-options','eldrun-print-hidden':'app-print-hidden','eldrun-rot-90':'app-rot-90',
  'eldrun-rot-180':'app-rot-180','eldrun-rot-270':'app-rot-270','eldrun-copy-break':'app-copy-break',
  'eldrun-scrollbar-layer':'app-scrollbar-layer','eldrun-scrollbar-dragging':'app-scrollbar-dragging',
  'data-eldrun-scrollbar':'data-app-scrollbar','__eldrunCustomScrollbars':'__appCustomScrollbars','--eldrun-scrollbar':'--app-scrollbar',
  'fileTree.eldrunNativeGroup':'fileTree.appNativeGroup','vpnIndicator.startsWithEldrun':'vpnIndicator.startsWithApp',
  'vpn.startsWithEldrun':'vpn.startsWithApp','stats.metricEldrunOpen':'stats.metricAppOpen','intro.page.askEldrun':'intro.page.askApp',
  'askEldrun':'askApp','desktop.intro.askEldrun':'desktop.intro.askApp',
  // mobile + vite configs: build-time placeholders and plugin names
  'eldrun-mobile-theme-colors':'app-mobile-theme-colors','eldrun-stamp-sw':'app-stamp-sw','eldrun-pdf-frame-page':'app-pdf-frame-page',
  '__ELDRUN_BUILD__':'__APP_BUILD__','__ELDRUN_ASSETS__':'__APP_ASSETS__',
}));
// whole value -> expression
const EXACT = new Map(Object.entries({
  'x-eldrun-path':'NAMES.filePathHeader','x-eldrun-project':'NAMES.fileProjectHeader',
  'eldrun-mobile-desktop-request':'NAMES.mobileDesktopEvent','eldrun-trust-required:':'NAMES.trustRequiredPrefix',
  'eldrun-native-print-unsupported':'NAMES.nativePrintUnsupported','eldrunproj':'NAMES.exportExtension',
  '.eldrun/worktrees':'NAMES.worktreesDir','.eldrun/inbox':'NAMES.inboxDir','.eldrun/outbox':'NAMES.outboxDir','.eldrun':'NAMES.projectDir',
  'eldrun-screenshots':'NAMES.screenshotsDir','eldrun-emails':'NAMES.emailsDir','eldrun-':'NAMES.tmuxPrefix',
  '__eldrun__':'NAMES.appTimerId','eldrun:file-drag-ended':'NAMES.fileDragEndedEvent','eldrun-send':'NAMES.sendCli',
  'eldrun-help':'NAMES.mcpHelpServer','eldrun-terminal.v1':'NAMES.terminalProtocol','eldrun':'BRAND.slug','Eldrun':'BRAND.display','ELDRUN':'BRAND.upper',
  'eldrun_mobile_host':'MOBILE_HOST_KEY','eldrun_mobile_access':'MOBILE_ACCESS_KEY','ELDRUN_':'BRAND.envPrefix',
  'eldrun-mobile-auth':'NAMES.mobileAuthDb','eldrun-mobile-markup':'NAMES.mobileMarkupDb','eldrun-open':'NAMES.mobileOpenMessage',
}));
function exactExpr(v, neutralDash) {
  if (NEUTRAL.has(v)) return JSON.stringify(NEUTRAL.get(v));
  if (EXACT.has(v)) return EXACT.get(v);
  let m;
  if ((m = /^eldrun:([a-z-]+)$/.exec(v))) {
    if (DOM_EVENTS.has(m[1])) return JSON.stringify(`app:${m[1]}`);
    return `storageColonKey(${JSON.stringify(m[1])})`;
  }
  if ((m = /^__eldrun_([a-z_]+?)__$/.exec(v))) return `tabCommand(${JSON.stringify(m[1])})`;
  if ((m = /^eldrun\.([A-Za-z0-9_.-]+)$/.exec(v))) return `storageKey(${JSON.stringify(m[1])})`;
  if ((m = /^eldrun-([a-z-]+)$/.exec(v)) && DASH_STORAGE.has(m[1])) return `storageDashKey(${JSON.stringify(m[1])})`;
  if ((m = /^ELDRUN_([A-Z0-9_]+)$/.exec(v))) return `envName(${JSON.stringify(m[1])})`;
  if (neutralDash && /^[.#]?eldrun-[a-z0-9-]+$/.test(v)) return JSON.stringify(v.replace('eldrun-', 'app-'));
  return null;
}
// substring rules -> template pieces
const SUBS = [
  [/refs\/eldrun\/backup/g, '${NAMES.gitRefBackup}'], [/refs\/eldrun\/peer/g, '${NAMES.gitRefPeer}'], [/refs\/eldrun\/incoming/g, '${NAMES.gitRefIncoming}'],
  [/\.eldrun\/inbox/g, '${NAMES.inboxDir}'], [/\.eldrun\/outbox/g, '${NAMES.outboxDir}'], [/\.eldrun\/worktrees/g, '${NAMES.worktreesDir}'],
  [/\.eldrun(?![A-Za-z0-9_-])/g, '${NAMES.projectDir}'], [/eldrunproj/g, '${NAMES.exportExtension}'],
  [/eldrun-send/g, '${NAMES.sendCli}'], [/eldrun-screenshots/g, '${NAMES.screenshotsDir}'], [/eldrun-emails/g, '${NAMES.emailsDir}'],
  [/eldrun_mobile_host/g, '${MOBILE_HOST_KEY}'], [/eldrun_mobile_access/g, '${MOBILE_ACCESS_KEY}'],
  [/__eldrun_([a-z_]+?)__/g, (_, v) => '${tabCommand("' + v + '")}'], [/eldrun-terminal\.v1/g, '${NAMES.terminalProtocol}'],
  [/ELDRUN_/g, '${BRAND.envPrefix}'], [/ELDRUN/g, '${BRAND.upper}'], [/Eldrun/g, '${BRAND.display}'], [/eldrun/g, '${BRAND.slug}'],
];
const NEUTRAL_SUB = /(--|data-)?eldrun-(icon|print-hidden|print-options|rot-|copy-break|scrollbar|dev-perf-layer|agent-zoom)/g;
function subst(raw, neutralDash) {
  // raw: template-literal raw text (already escaped for a template)
  let out = raw.replace(NEUTRAL_SUB, (_, pre, name) => `${pre || ''}app-${name}`).replace(/__eldrunCustomScrollbars/g, '__appCustomScrollbars');
  if (neutralDash) out = out.replace(/eldrun-/g, 'app-').replace(/--eldrun/g, '--app');
  // protect inserted ${...} from later rules by tokenizing
  const hold = [];
  for (const [re, rep] of SUBS) {
    out = out.replace(re, (...a) => { const r = typeof rep === 'function' ? rep(...a) : rep; hold.push(r); return `\u0000${hold.length - 1}\u0000`; });
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => hold[+i]);
}
const IDENTS = ['BRAND','NAMES','LEGACY_NAMES','LEGACY_BRAND','MOBILE_HOST_KEY','MOBILE_ACCESS_KEY','storageKey','storageDashKey','storageColonKey','envName','tabCommand'];
function used(code) { return IDENTS.filter(n => new RegExp(`(?<![A-Za-z0-9_.$])${n}\\b`).test(code)); }
function renameIdent(w) { return w.replace(/Eldrun/g, 'App').replace(/eldrun/g, 'app').replace(/ELDRUN/g, 'APP'); }
const report = [];
for (const file of files) {
  const abs = path.resolve(ROOT, file);
  if (abs === BRAND_FILE) continue;
  const text = fs.readFileSync(abs, 'utf8');
  if (!ANY.test(text)) continue;
  const neutralDash = /lib\/viewers\/print\.ts$|lib\/theme\/customScrollbar\.ts$|icons\/Icon\.tsx$/.test(file) || process.argv.includes('--neutral-dash');
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = []; const need = new Set();
  const inHoisted = (pos) => hoisted.some(([a, b]) => pos >= a && pos < b);
  const hoisted = [];
  (function find(n) { if (n.kind === K.CallExpression && /^vi\.(mock|doMock|hoisted)$/.test(n.expression.getText(sf))) hoisted.push([n.getStart(sf), n.getEnd()]); n.forEachChild(find); })(sf);
  const rep = (s, e, code) => {
    if (inHoisted(s) && used(code).length) { report.push(`${file}:${sf.getLineAndCharacterOfPosition(s).line + 1}: in vi.mock/hoisted, left: ${text.slice(s, e).slice(0, 90)}`); return; }
    edits.push([s, e, code]); for (const n of used(code)) need.add(n);
  };
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n) => {
    const t = n.kind;
    if (t === K.StringLiteral || t === K.NoSubstitutionTemplateLiteral) {
      const src = n.getText(sf);
      if (ANY.test(src)) {
        const p = n.parent;
        const isSpecifier = (p.kind === K.ImportDeclaration || p.kind === K.ExportDeclaration || (p.kind === K.CallExpression && p.expression.kind === K.ImportKeyword) || p.kind === K.ExternalModuleReference);
        const isViMock = p.kind === K.CallExpression && /^(vi\.(mock|doMock|unmock|importActual|importMock)|import)$/.test(p.expression.getText(sf)) && p.arguments[0] === n;
        if (isSpecifier || isViMock) {
          rep(n.getStart(sf), n.getEnd(), renameIdent(src));
        } else if (p.kind === K.LiteralType) {
          const ex = exactExpr(n.text, neutralDash);
          if (ex && ex.startsWith('"')) rep(n.getStart(sf), n.getEnd(), ex);
          else if (n.text === 'eldrun' ) rep(n.getStart(sf), n.getEnd(), '"app"');
          else report.push(`${file}:${line(n)}: literal TYPE left: ${src.slice(0, 80)}`);
        } else if (t === K.NoSubstitutionTemplateLiteral && p.kind === K.TaggedTemplateExpression) {
          report.push(`${file}:${line(n)}: tagged template left: ${src.slice(0, 80)}`);
        } else {
          let code = exactExpr(n.text, neutralDash);
          if (code == null) {
            let raw;
            if (t === K.StringLiteral) {
              raw = src.slice(1, -1);
              raw = raw.replace(/\\(['"])/g, '$1').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
              if (/\\[0-7]/.test(raw)) { report.push(`${file}:${line(n)}: octal escape, left: ${src.slice(0, 60)}`); return; }
            } else raw = src.slice(1, -1);
            const body = subst(raw, neutralDash);
            const one = /^\$\{([^{}]+)\}$/.exec(body);
            code = one ? one[1] : (body.includes('${') ? '`' + body + '`' : JSON.stringify(n.text.replace(/eldrun-/g, 'app-').replace(/--eldrun/g, '--app')));
          }
          const isExpr = !code.startsWith('"');
          if (p.kind === K.JsxAttribute && isExpr) code = `{${code}}`;
          else if ((p.kind === K.PropertyAssignment || p.kind === K.PropertySignature || p.kind === K.MethodDeclaration || p.kind === K.BindingElement && p.propertyName === n) && p.name === n || (p.kind === K.BindingElement && p.propertyName === n)) { if (isExpr) code = `[${code}]`; }
          else if (p.kind === K.EnumMember) { report.push(`${file}:${line(n)}: enum member left`); return; }
          rep(n.getStart(sf), n.getEnd(), code);
        }
      }
    } else if (t === K.TemplateHead || t === K.TemplateMiddle || t === K.TemplateTail) {
      const src = n.getText(sf);
      if (ANY.test(src)) {
        if (n.parent.parent && n.parent.parent.kind === K.TaggedTemplateExpression || (n.parent.kind === K.TemplateExpression && n.parent.parent.kind === K.TaggedTemplateExpression)) report.push(`${file}:${line(n)}: tagged template piece changed: ${src.slice(0, 60)}`);
        rep(n.getStart(sf), n.getEnd(), subst(src, neutralDash));
      }
    } else if (t === K.JsxText) {
      const src = n.getText(sf);
      if (ANY.test(src)) rep(n.getStart(sf), n.getEnd(), src.replace(/ELDRUN/g, '{BRAND.display.toUpperCase()}').replace(/Eldrun/g, '{BRAND.display}').replace(/eldrun_session_start/g, '{NAMES.sessionHookSh.replace(/\\.sh$/, "")}').replace(/eldrun/g, '{BRAND.slug}'));
    } else if (t === K.RegularExpressionLiteral) {
      const src = n.getText(sf);
      if (ANY.test(src)) {
        const end = src.lastIndexOf('/'); const body = src.slice(1, end); const flags = src.slice(end + 1);
        if (/--eldrun-scrollbar/.test(body)) rep(n.getStart(sf), n.getEnd(), src.replace(/--eldrun-/g, '--app-'));
        else if (body.includes('`') || body.includes('${')) report.push(`${file}:${line(n)}: REGEX left: ${src.slice(0, 80)}`);
        else rep(n.getStart(sf), n.getEnd(), 'new RegExp(String.raw`' + subst(body, false) + '`' + (flags ? `, "${flags}"` : '') + ')');
      }
    } else if (t === K.Identifier || t === K.PrivateIdentifier) {
      const w = n.getText(sf);
      if (ANY.test(w)) {
        const p = n.parent;
        const keyExpr = w === 'eldrun_mobile_host' ? 'MOBILE_HOST_KEY' : w === 'eldrun_mobile_access' ? 'MOBILE_ACCESS_KEY' : /^ELDRUN_[A-Z0-9_]+$/.test(w) ? `envName("${w.slice(7)}")` : null;
        const isPropName = (p.kind === K.PropertyAccessExpression && p.name === n) || ((p.kind === K.PropertyAssignment || p.kind === K.PropertySignature || p.kind === K.PropertyDeclaration) && p.name === n) || (p.kind === K.BindingElement && p.propertyName === n);
        if (keyExpr && (w.startsWith('eldrun_mobile') || isPropName)) {
          if (p.kind === K.PropertyAccessExpression && p.name === n) {
            // replace the dot (or ?.) too
            const dotStart = p.expression.getEnd();
            const between = text.slice(dotStart, n.getStart(sf));
            rep(dotStart, n.getEnd(), (between.includes('?.') ? '?.' : '') + `[${keyExpr}]`);
          } else if (isPropName) rep(n.getStart(sf), n.getEnd(), `[${keyExpr}]`);
          else if (p.kind === K.ShorthandPropertyAssignment) { report.push(`${file}:${line(n)}: shorthand ${w} left`); }
          else if (p.kind === K.BindingElement && p.name === n && !p.propertyName) rep(n.getStart(sf), n.getEnd(), `[${keyExpr}]: ${renameIdent(w)}`);
          else rep(n.getStart(sf), n.getEnd(), renameIdent(w));
        } else rep(n.getStart(sf), n.getEnd(), renameIdent(w));
      }
    }
    n.forEachChild(visit);
  };
  visit(sf);
  if (!edits.length) continue;
  edits.sort((a, b) => a[0] - b[0]);
  let out = ''; let i = 0;
  for (const [s, e, c] of edits) { if (s < i) { report.push(`${file}: overlapping edit at ${s}`); continue; } out += text.slice(i, s) + c; i = e; }
  out += text.slice(i);
  // imports
  if (need.size) {
    let relp = path.relative(path.dirname(abs), BRAND_FILE).replace(/\.ts$/, '');
    if (!relp.startsWith('.')) relp = './' + relp;
    const impRe = /import \{([^}]*)\} from "((?:\.\.?\/)+(?:src\/)?(?:lib\/)?brand)";\n/;
    const m = impRe.exec(out);
    if (m) {
      const have = new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
      for (const n of need) have.add(n);
      out = out.replace(impRe, `import { ${[...have].sort().join(', ')} } from "${m[2]}";\n`);
    } else {
      const imp = `import { ${[...need].sort().join(', ')} } from "${relp}";\n`;
      // after the last top-level import statement
      const sf2 = ts.createSourceFile(abs, out, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      let pos = 0; let first = null;
      for (const st of sf2.statements) { if (st.kind === K.ImportDeclaration) { if (first == null) first = st.getFullStart(); pos = st.getEnd(); } }
      if (pos) { const nl = out.indexOf('\n', pos); out = out.slice(0, nl + 1) + imp + out.slice(nl + 1); }
      else { const st = sf2.statements[0]; const at = st ? st.getStart(sf2) : 0; out = out.slice(0, at) + imp + '\n' + out.slice(at); }
    }
  }
  if (!dry) fs.writeFileSync(abs, out);
}
console.log(report.join('\n'));
