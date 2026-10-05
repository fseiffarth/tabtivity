"""Unwrap concat!(...) that sits directly inside another concat!(...)."""
import sys, re, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rslex import lex
TOK = re.compile(r'[A-Za-z_][A-Za-z0-9_]*|[()\[\]{}!]|\S')
for f in sys.argv[1:]:
    src = open(f).read()
    if 'concat!(' not in src: continue
    stack = []; prev = []; dele = []
    for kind, a, b in lex(src):
        if kind != 'code':
            prev.append('lit'); continue
        for m in TOK.finditer(src[a:b]):
            t = m.group(0); pos = a + m.start()
            if t in '([{':
                mac = prev[-2] if len(prev) >= 2 and prev[-1] == '!' else None
                fr = {'mac': mac, 'open': pos, 'unwrap': False}
                if mac == 'concat' and stack and stack[-1]['mac'] == 'concat' and t == '(':
                    fr['unwrap'] = True
                stack.append(fr)
            elif t in ')]}':
                if stack:
                    fr = stack.pop()
                    if fr['unwrap']:
                        st = src.rfind('concat', 0, fr['open'])
                        dele.append((st, fr['open'] + 1)); dele.append((pos, pos + 1))
            prev.append(t)
            if len(prev) > 4: prev.pop(0)
    if dele:
        out = []; i = 0
        for s, e in sorted(dele):
            out.append(src[i:s]); i = e
        out.append(src[i:]); open(f, 'w').write(''.join(out)); print('flattened', f, len(dele)//2)
