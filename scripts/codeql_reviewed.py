#!/usr/bin/env python3
"""Remove only reviewed CodeQL false positives from the report uploaded to GitHub.

An exception matches one rule, file, line, and SHA-256 of the entire source file.
Any source edit expires it. Removed results stay in a separate JSON audit report.
GitHub does not honor SARIF suppressions; Rust also lacks inline suppression.
"""

import hashlib
import json
from pathlib import Path
import sys
from urllib.parse import unquote


def filter_report(report, reviews, root):
    """Return the report and an audit trail; unmatched results remain intact."""
    accepted = {}
    for review in reviews:
        path = (root / review["path"]).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            continue
        source = path.read_bytes()
        if hashlib.sha256(source).hexdigest() != review["sha256"]:
            continue
        lines = source.decode("utf-8").splitlines()
        line = review["line"]
        if line < 1 or line > len(lines) or lines[line - 1].strip() != review["source"]:
            continue
        if not review["reason"].strip():
            raise ValueError("a reviewed finding needs a reason")
        accepted[(review["rule"], review["path"], line)] = review

    removed = []
    for run in report.get("runs", []):
        kept = []
        for result in run.get("results", []):
            # Only a result with one exact primary location may be reviewed.
            locations = result.get("locations", [])
            review = None
            if len(locations) == 1:
                physical = locations[0].get("physicalLocation", {})
                uri = unquote(physical.get("artifactLocation", {}).get("uri", ""))
                region = physical.get("region", {})
                line = region.get("startLine")
                if region.get("endLine", line) == line:
                    review = accepted.get((result.get("ruleId"), uri, line))
            if review is None:
                kept.append(result)
            else:
                removed.append({"review": review, "result": result})
        run["results"] = kept
    return report, removed


def main():
    root = Path(__file__).resolve().parent.parent
    reviews = json.loads((root / ".github/codeql/reviewed.json").read_text())
    reports = sorted(Path(sys.argv[1]).glob("*.sarif"))
    if not reports:
        raise SystemExit("No CodeQL SARIF reports found; refusing to upload an empty result")
    audit = []
    for path in reports:
        report, removed = filter_report(json.loads(path.read_text()), reviews, root)
        path.write_text(json.dumps(report))
        audit.extend({"report": path.name, **entry} for entry in removed)
        print(f"{path.name}: {len(removed)} reviewed false positives; all other findings retained")
        for entry in removed:
            review = entry["review"]
            print(f"  {review['rule']} {review['path']}:{review['line']}: {review['reason']}")
    # Keep the complete findings and reasons in the runner's output directory.
    # upload-sarif reads only *.sarif, so this audit is never a second analysis.
    (Path(sys.argv[1]) / "reviewed-results.json").write_text(json.dumps(audit, indent=2) + "\n")


if __name__ == "__main__":
    main()
