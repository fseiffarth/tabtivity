import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from codeql_reviewed import filter_report


class ReviewedFindingsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        (self.root / "source.rs").write_text("// trusted startup directory\nread(state_dir)\n")
        self.review = {
            "path": "source.rs", "rule": "rust/path-injection", "line": 2,
            "source": "read(state_dir)", "reason": "startup configuration, never request data",
            "sha256": hashlib.sha256((self.root / "source.rs").read_bytes()).hexdigest(),
        }
        self.result = {
            "ruleId": "rust/path-injection",
            "locations": [{"physicalLocation": {
                "artifactLocation": {"uri": "source.rs"},
                "region": {"startLine": 2, "endLine": 2},
            }}],
            "message": {"text": "a path"},
        }

    def run_filter(self, result=None, reviews=None):
        report = {"runs": [{"tool": {"driver": {"name": "CodeQL"}},
                            "results": [copy.deepcopy(result or self.result)]}]}
        return filter_report(report, [self.review] if reviews is None else reviews, self.root)

    def test_exact_match_is_removed_and_preserved_in_audit(self):
        report, audit = self.run_filter()
        self.assertEqual(report["runs"][0]["results"], [])
        self.assertEqual(audit, [{"review": self.review, "result": self.result}])
        self.assertEqual(report["runs"][0]["tool"]["driver"]["name"], "CodeQL")

    def test_any_source_edit_expires_the_review(self):
        with (self.root / "source.rs").open("a") as source:
            source.write("read(request.path)\n")
        report, audit = self.run_filter()
        self.assertEqual(report["runs"][0]["results"], [self.result])
        self.assertEqual(audit, [])

    def test_different_rules_files_and_lines_still_report(self):
        for field, value in [("rule", "rust/other"), ("path", "other.rs"), ("line", 1),
                             ("source", "wrong source")]:
            with self.subTest(field=field):
                review = {**self.review, field: value}
                report, audit = self.run_filter(reviews=[review])
                self.assertEqual(report["runs"][0]["results"], [self.result])
                self.assertEqual(audit, [])

    def test_missing_or_multiple_locations_and_spanning_regions_still_report(self):
        variants = [[], [*self.result["locations"], *self.result["locations"]]]
        for locations in variants:
            result = {**self.result, "locations": locations}
            report, audit = self.run_filter(result)
            self.assertEqual(report["runs"][0]["results"], [result])
            self.assertEqual(audit, [])
        result = copy.deepcopy(self.result)
        result["locations"][0]["physicalLocation"]["region"]["endLine"] = 3
        report, audit = self.run_filter(result)
        self.assertEqual(report["runs"][0]["results"], [result])
        self.assertEqual(audit, [])

    def test_unreviewed_result_alongside_reviewed_result_survives(self):
        other = {**self.result, "ruleId": "rust/another-rule"}
        report = {"runs": [{"results": [self.result, other]}]}
        filtered, audit = filter_report(report, [self.review], self.root)
        self.assertEqual(filtered["runs"][0]["results"], [other])
        self.assertEqual(len(audit), 1)

    def test_empty_justification_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_filter(reviews=[{**self.review, "reason": " "}])

    def test_repository_reviews_are_explicit_and_well_formed(self):
        import json
        root = Path(__file__).resolve().parent.parent
        reviews = json.loads((root / ".github/codeql/reviewed.json").read_text())
        identities = set()
        for review in reviews:
            with self.subTest(path=review["path"], line=review["line"]):
                self.assertRegex(review["sha256"], r"^[0-9a-f]{64}$")
                self.assertGreater(review["line"], 0)
                self.assertTrue((root / review["path"]).resolve().is_relative_to(root))
                self.assertTrue(review["source"].strip())
                self.assertTrue(review["reason"].strip())
                identity = (review["rule"], review["path"], review["line"])
                self.assertNotIn(identity, identities)
                identities.add(identity)
        # A stale hash is allowed: it must leave findings in the upload rather
        # than fail this test and prevent the new analysis being published.


if __name__ == "__main__":
    unittest.main()
