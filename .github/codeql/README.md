# Reviewed CodeQL findings

`reviewed.json` records the false positives reviewed for PR #42. Each entry
names one rule, source line and SHA-256 of the **entire** file, with a reason.
Any edit to that file expires its reviews: the findings are reported again
until their assumptions, locations and hashes are reviewed anew. Never update
a hash without checking the reason against the new code and its callers.

`scripts/codeql_reviewed.py` applies these entries between analysis and upload.
It leaves every other result intact, including findings from the same rule in
other locations. The original reviewed results and their reasons are retained
in `reviewed-results.json`, uploaded as the `codeql-reviewed-<language>` CI
artifact for 30 days, and logged by rule and location. No source files or
queries are excluded from analysis.

The reviewed cases are the app's startup-selected state directory (not a phone
request path), the public HKDF domain label for file tokens (key material is
the random host key), and MD5 required by the PDF revision-2 **test fixture**.
Changing the token label would invalidate existing tokens; replacing MD5
would stop the fixture being a valid encrypted PDF. Neither is a password
storage mechanism.

The registry test checks the review format; the filter tests verify that
edits and unmatched findings are reported. Run them:

```sh
python3 -m unittest discover -s scripts -p test_codeql_reviewed.py
```
