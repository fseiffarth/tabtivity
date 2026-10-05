"""edit.py: apply exact replacements. Spec file is python: EDITS = {file: [(old, new[, count])]}.
count: expected number of occurrences (default 1); 0 = any>=1."""
import sys, runpy, os
spec = runpy.run_path(sys.argv[1])
root = spec.get('ROOT', '.')
bad = 0
for f, edits in spec['EDITS'].items():
    p = os.path.join(root, f)
    s = open(p).read()
    for e in edits:
        old, new = e[0], e[1]
        cnt = e[2] if len(e) > 2 else 1
        n = s.count(old)
        if n == 0 or (cnt and n != cnt):
            print(f'!! {f}: expected {cnt} got {n}: {old[:80]!r}'); bad += 1; continue
        s = s.replace(old, new)
    open(p, 'w').write(s)
print('done, problems:', bad)
