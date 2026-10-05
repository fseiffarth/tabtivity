import re, sys, subprocess
sys.path.insert(0, sys.path[0])
from rslex import lex
mode = sys.argv[1]  # prod|test
files = sys.argv[2:] or subprocess.check_output(['git','ls-files','src-tauri/*.rs'], text=True).split()
for f in files:
    src = open(f).read()
    tpos = src.find('#[cfg(test)]\nmod ')
    if tpos < 0: tpos = len(src)
    istest = '/tests/' in f or '/examples/' in f
    lines = set()
    for kind, a, b in lex(src):
        if kind == 'comment': continue
        region = 'test' if (istest or a >= tpos) else 'prod'
        if region != mode: continue
        for m in re.finditer('eldrun', src[a:b], re.I):
            lines.add(src.count('\n', 0, a + m.start()) + 1)
    if lines:
        sl = src.split('\n')
        print('##', f)
        for l in sorted(lines):
            print(f'{l}: {sl[l-1].strip()[:170]}')
