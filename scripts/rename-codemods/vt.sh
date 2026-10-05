#!/usr/bin/env bash
# run vitest quietly, print totals + failures only
cd "$(git rev-parse --show-toplevel)"
npx vitest run --reporter=json --outputFile=/tmp/rename-scratch/vt.json "$@" >/dev/null 2>&1
python3 - <<'PY'
import json
d=json.load(open('/tmp/rename-scratch/vt.json'))
print('files', d['numTotalTestSuites'], 'tests', d['numTotalTests'], 'failed', d['numFailedTests'], 'failedSuites', d['numFailedTestSuites'])
files=len(d['testResults']); print('test files', files)
for r in d['testResults']:
    if r['status']!='passed':
        print('FAIL', r['name'].split('/rename/')[-1], (r.get('message') or '')[:300])
        for a in r['assertionResults']:
            if a['status']=='failed':
                print('  -', a['fullName'][:150]); print('    ', ' '.join(a['failureMessages'])[:500].replace('\n',' '))
PY
