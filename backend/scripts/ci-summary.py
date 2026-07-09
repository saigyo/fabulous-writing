"""Render a markdown job summary from pytest's junit XML and coverage JSON.

CI appends the output to $GITHUB_STEP_SUMMARY so test counts, failures, and
the coverage total show up directly on the workflow run page.
"""

import json
import xml.etree.ElementTree as ET
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent


def main() -> None:
    print("## Backend test report\n")

    junit = BACKEND / "test-results.xml"
    if not junit.exists():
        print("⚠️ `test-results.xml` missing — the test run crashed before reporting.")
        return

    suite = ET.parse(junit).getroot().find("testsuite")
    if suite is None:
        print("⚠️ `test-results.xml` has no `<testsuite>` element.")
        return
    tests = int(suite.get("tests", 0))
    failures = int(suite.get("failures", 0))
    errors = int(suite.get("errors", 0))
    skipped = int(suite.get("skipped", 0))
    passed = tests - failures - errors - skipped
    time = float(suite.get("time", 0))

    coverage = "n/a"
    cov_file = BACKEND / "coverage.json"
    if cov_file.exists():
        pct = json.loads(cov_file.read_text())["totals"]["percent_covered"]
        coverage = f"{pct:.1f}%"

    print("| Tests | Passed | Failed | Errors | Skipped | Duration | Line coverage |")
    print("|--:|--:|--:|--:|--:|--:|--:|")
    print(
        f"| {tests} | {passed} | {failures} | {errors} | {skipped}"
        f" | {time:.1f}s | {coverage} |"
    )

    broken = []
    for case in suite.iter("testcase"):
        detail = case.find("failure")
        if detail is None:
            detail = case.find("error")
        if detail is not None:
            broken.append((case, detail))
    if broken:
        print("\n### Failures\n")
        for case, detail in broken:
            message = (detail.get("message") or "").splitlines()
            first_line = message[0][:200] if message else ""
            print(f"- `{case.get('classname')}::{case.get('name')}` — {first_line}")

    print("\nFull HTML coverage report: `backend-coverage-report` artifact below.")


if __name__ == "__main__":
    main()
