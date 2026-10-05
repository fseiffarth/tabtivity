"""Minimal Rust lexer: yields (kind, start, end) for comment/string/char/code spans."""
import re, sys
def lex(src):
    i, n = 0, len(src); out = []
    code_start = 0
    def flush(j):
        nonlocal code_start
        if j > code_start: out.append(('code', code_start, j))
    while i < n:
        c = src[i]
        if c == '/' and i+1 < n and src[i+1] == '/':
            j = src.find('\n', i); j = n if j < 0 else j
            flush(i); out.append(('comment', i, j)); i = j; code_start = i; continue
        if c == '/' and i+1 < n and src[i+1] == '*':
            depth = 1; j = i+2
            while j < n and depth:
                if src.startswith('/*', j): depth += 1; j += 2
                elif src.startswith('*/', j): depth -= 1; j += 2
                else: j += 1
            flush(i); out.append(('comment', i, j)); i = j; code_start = i; continue
        # raw strings r"", r#""#, br, cr
        m = re.compile(r'(?:b|c)?r(#*)"').match(src, i)
        if m and (i == 0 or not (src[i-1].isalnum() or src[i-1] == '_')):
            hashes = m.group(1); close = '"' + hashes
            j = src.find(close, m.end()); j = n if j < 0 else j + len(close)
            flush(i); out.append(('rawstr', i, j)); i = j; code_start = i; continue
        if c == '"' or (c in 'bc' and i+1 < n and src[i+1] == '"' and not (i and (src[i-1].isalnum() or src[i-1]=='_'))):
            s = i
            j = i + (2 if c != '"' else 1)
            while j < n and src[j] != '"':
                j += 2 if src[j] == '\\' else 1
            j += 1
            flush(s); out.append(('str', s, j)); i = j; code_start = i; continue
        if c == "'":
            # char literal or lifetime
            m = re.compile(r"'(?:\\(?:x[0-9a-fA-F]{2}|u\{[0-9a-fA-F_]+\}|.)|[^\\'\n])'").match(src, i)
            if m:
                flush(i); out.append(('char', i, m.end())); i = m.end(); code_start = i; continue
        i += 1
    flush(n)
    return out
if __name__ == '__main__':
    import collections, subprocess
    files = subprocess.check_output(['git','ls-files','src-tauri/*.rs'], text=True).split()
    tot = collections.Counter(); per = []
    for f in files:
        src = open(f).read()
        tpos = src.find('#[cfg(test)]\nmod ')
        if tpos < 0: tpos = len(src)
        istest = '/tests/' in f or '/examples/' in f or f.endswith('_tests.rs') or f.endswith('/tests.rs')
        c = collections.Counter()
        for kind, a, b in lex(src):
            k = len(re.findall('eldrun', src[a:b], re.I))
            if not k: continue
            region = 'test' if (istest or a >= tpos) else 'prod'
            kk = 'str' if kind in ('str','rawstr') else kind
            c[(region, kk)] += k
        if c:
            tot.update(c); per.append((f, c))
    print(dict(tot))
    for f, c in sorted(per, key=lambda x: -(x[1][('prod','str')]+x[1][('prod','code')])):
        print(f, {f"{r}.{k}": v for (r,k), v in c.items() if k != 'comment'})
