"""Rust brand codemod. Value-preserving for strings; neutral renames for identifiers."""
import re, sys, subprocess, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rslex import lex

FMT = {'format':0,'print':0,'println':0,'eprint':0,'eprintln':0,'panic':0,'unreachable':0,'todo':0,
       'unimplemented':0,'format_args':0,'anyhow':0,'bail':0,'write':1,'writeln':1,'assert':1,
       'debug_assert':1,'assert_eq':2,'assert_ne':2,'debug_assert_eq':2,'debug_assert_ne':2,
       'ensure':1,'info':0,'warn':0,'error':0,'debug':0,'trace':0}
SKIPMAC = {'include_bytes','include_str','include'}
TOK = re.compile(r'[A-Za-z_][A-Za-z0-9_]*|::|[(){}\[\],!#<>]|\S')
BRAND = re.compile(r'fseiffarth/ProjectEldrun|Eldrun|eldrun|ELDRUN')
ANY = re.compile('eldrun', re.I)
CAPT = re.compile(r'(?<!\{)\{[A-Za-z_][A-Za-z0-9_]*(?::[^{}]*)?\}')
MAC = {'Eldrun':'app_name','eldrun':'app_slug','ELDRUN':'app_upper','fseiffarth/ProjectEldrun':'app_repo'}
CAP = {'Eldrun':'DISPLAY','eldrun':'SLUG','ELDRUN':'UPPER','fseiffarth/ProjectEldrun':'REPO'}
KEEP_IDENT = set()

def rename_ident(w):
    return w.replace('Eldrun','App').replace('eldrun','app').replace('ELDRUN','APP')

def process(path, src, crate, skip_from=None, report=None):
    spans = lex(src)
    out = []           # list of (start,end,replacement)
    stack = []         # frames: dict(kind, macro, arg, attr, mod, body_start)
    prev = []          # last few code tokens
    needs = {}         # module body_start (0 = top) -> set of names
    mods = {0: {'parent': None, 'start': 0}}
    renamed = set()
    angle = 0
    def cur_mod():
        for f in reversed(stack):
            if f.get('mod') is not None: return f['body']
        return 0
    for kind, a, b in spans:
        text = src[a:b]
        if skip_from is not None and a >= skip_from:
            continue
        if kind == 'code':
            for m in TOK.finditer(text):
                t = m.group(0); pos = a + m.start()
                if angle:
                    if t == '<': angle += 1
                    elif t == '>': angle -= 1
                    prev.append(t); continue
                if t == '<' and prev and prev[-1] == '::':
                    angle = 1; prev.append(t); continue
                if t in '([{' and len(t) == 1:
                    fr = {'kind': t, 'macro': None, 'arg': 0, 'attr': False, 'mod': None}
                    if len(prev) >= 2 and prev[-1] == '!' and re.match(r'[A-Za-z_]', prev[-2]):
                        fr['macro'] = prev[-2]
                    if t == '[' and prev and (prev[-1] == '#' or (len(prev) >= 2 and prev[-1] == '!' and prev[-2] == '#')):
                        fr['attr'] = True
                    if t == '{' and len(prev) >= 2 and prev[-2] == 'mod':
                        fr['mod'] = prev[-1]; fr['body'] = pos + 1
                        mods[pos + 1] = {'parent': cur_mod(), 'start': pos + 1}
                    stack.append(fr)
                elif t in ')]}' and len(t) == 1:
                    if stack: stack.pop()
                elif t == ',':
                    if stack: stack[-1]['arg'] += 1
                elif re.match(r'[A-Za-z_]', t) and ANY.search(t) and t not in KEEP_IDENT:
                    new = rename_ident(t)
                    out.append((pos, pos + len(t), new)); renamed.add((t, new))
                prev.append(t)
                if len(prev) > 6: prev.pop(0)
            continue
        if kind == 'comment' or kind == 'char':
            continue
        # string literal
        prev.append('"lit"')
        if not ANY.search(text): continue
        line = src.count('\n', 0, a) + 1
        if any(f['attr'] for f in stack):
            report.append(f'{path}:{line}: ATTR literal skipped: {text[:80]}'); continue
        top = stack[-1] if stack else None
        if top and top['macro'] in SKIPMAC:
            report.append(f'{path}:{line}: include literal skipped: {text[:80]}'); continue
        if kind == 'rawstr':
            m = re.match(r'((?:b|c)?)r(#*)"', text); pre = m.group(1); h = m.group(2)
            body = text[m.end():len(text) - 1 - len(h)]
            wrap = lambda s: f'r{h}"{s}"{h}'
        else:
            pre = text[0] if text[0] in 'bc' else ''
            body = text[len(pre) + 1:-1]
            wrap = lambda s: f'"{s}"'
        if pre:
            report.append(f'{path}:{line}: byte/c literal skipped: {text[:80]}'); continue
        leftovers = [m.group(0) for m in ANY.finditer(BRAND.sub('', body))]
        if leftovers:
            report.append(f'{path}:{line}: odd casing skipped: {text[:80]}'); continue
        is_fmt = bool(top and top['macro'] in FMT and top['arg'] == FMT[top['macro']])
        if is_fmt and CAPT.search(body):
            names = set()
            def sub(m):
                names.add(CAP[m.group(0)]); return '{' + CAP[m.group(0)] + '}'
            out.append((a, b, wrap(BRAND.sub(sub, body))))
            needs.setdefault(cur_mod(), set()).update(names)
            continue
        m = re.fullmatch(r'ELDRUN_([A-Z0-9_]+)', body)
        if m:
            out.append((a, b, f'{crate}::app_env!("{m.group(1)}")')); continue
        m = re.fullmatch(r'__eldrun_([a-z_]+?)__', body)
        if m:
            out.append((a, b, f'{crate}::app_tab_command!("{m.group(1)}")')); continue
        parts = []; i = 0
        for m in BRAND.finditer(body):
            if m.start() > i: parts.append(wrap(body[i:m.start()]))
            parts.append(f'{crate}::{MAC[m.group(0)]}!()'); i = m.end()
        if i < len(body): parts.append(wrap(body[i:]))
        out.append((a, b, parts[0] if len(parts) == 1 else 'concat!(' + ', '.join(parts) + ')'))
    # imports
    inserts = []
    def provided(mod_start, name):
        info = mods[mod_start]
        if name in needs.get(mod_start, ()): return True
        if info['parent'] is None: return False
        # has `use super::*;` directly in this module?
        seg = src[mod_start:mod_start + 4000]
        if re.search(r'^\s*use super::\*;', seg, re.M):
            return provided(info['parent'], name)
        return False
    for mod_start, names in needs.items():
        info = mods[mod_start]
        need = sorted(n for n in names if not (info['parent'] is not None and re.search(r'^\s*use super::\*;', src[mod_start:mod_start+4000], re.M) and provided(info['parent'], n)))
        if not need: continue
        imp = f'use {crate}::brand::{{{", ".join(need)}}};' if len(need) > 1 else f'use {crate}::brand::{need[0]};'
        if mod_start == 0:
            lines = src.split('\n'); off = 0; pos = None; fallback = None
            for ln in lines:
                st = ln.strip()
                if pos is None and re.match(r'(pub(\([a-z]+\))? )?use ', ln): pos = off; break
                if fallback is None and st and not st.startswith('//!') and not st.startswith('#!['): fallback = off
                off += len(ln) + 1
            if pos is None: pos = fallback or 0
            inserts.append((pos, pos, imp + '\n'))
        else:
            nl = src.find('\n', mod_start)
            indent = re.match(r'\s*', src[nl + 1:]).group(0).replace('\n', '')
            inserts.append((nl + 1, nl + 1, indent + imp + '\n'))
    edits = sorted(out + inserts, key=lambda e: (e[0], e[1]))
    res = []; i = 0
    for s, e, r in edits:
        res.append(src[i:s]); res.append(r); i = e
    res.append(src[i:])
    return ''.join(res), renamed

if __name__ == '__main__':
    dry = '--dry' in sys.argv
    files = [f for f in sys.argv[1:] if not f.startswith('--')]
    report = []; allren = set()
    for f in files:
        if f.endswith('src/brand.rs'): continue
        src = open(f).read()
        ext = '/tests/' in f or '/examples/' in f or f.endswith('src/main.rs')
        crate = 'app_lib' if ext else 'crate'
        if f.endswith('build.rs'): crate = 'crate'
        skip = None
        if f.endswith('services/app_update.rs'):
            skip = src.find('#[cfg(test)]\nmod ')
        new, ren = process(f, src, crate, skip, report)
        allren |= ren
        if new != src and not dry: open(f, 'w').write(new)
    print('\n'.join(report))
    json.dump(sorted(allren), open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'renamed.json'), 'w'))
    print('renamed idents:', ' '.join(f'{a}->{b}' for a, b in sorted(allren)))
