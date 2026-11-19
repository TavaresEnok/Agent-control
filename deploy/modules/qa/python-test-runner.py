"""Execute unittest and measure project code with the coverage.py pinned in the image."""

import importlib
import inspect
import json
import os
from pathlib import Path
import sys
import unittest

sys.path.append("/opt/qa-coverage")
from coverage import Coverage
from coverage.exceptions import CoverageException


class Result(unittest.TestResult):
    def __init__(self, files):
        super().__init__()
        self.files = files
        self.cases = {}
        self.unavailable = 0
        self.errors = 0
        self.fixture_skips = 0
        self.unsupported = 0

    def record(self, test, status):
        test = getattr(test, "test_case", test)
        cls = type(test)
        file = self.files.get(cls.__module__)
        if file is None:
            return False
        name = f"{cls.__qualname__}.{test._testMethodName}"
        key = (file, name)
        if self.cases.get(key) != "failed":
            self.cases[key] = status
        return True

    def addSuccess(self, test):
        self.record(test, "passed")

    def addFailure(self, test, err):
        self.record(test, "failed")

    def addError(self, test, err):
        if not self.record(test, "failed"):
            self.errors += 1

    def addSkip(self, test, reason):
        if not self.record(test, "skipped"):
            # unittest uses a synthetic holder for skipped module/class fixtures.
            self.fixture_skips += 1

    def addExpectedFailure(self, test, err):
        self.record(test, "skipped")

    def addUnexpectedSuccess(self, test):
        self.record(test, "failed")

    def addSubTest(self, test, subtest, err):
        if err:
            self.addError(test, err)


def measure(cov, sources, report_path, max_profile_bytes):
    if not sources:
        return None
    try:
        cov.json_report(morfs=sources, outfile=str(report_path), ignore_errors=True)
        with report_path.open("rb") as data:
            raw = data.read(max_profile_bytes + 1)
        if len(raw) > max_profile_bytes:
            return None
        report = json.loads(raw)
    except (CoverageException, OSError, ValueError):
        return None
    if not report["meta"]["branch_coverage"]:
        return None
    totals = report["totals"]
    return {
        "files": len(report["files"]),
        "statements": [totals["covered_lines"], totals["num_statements"]],
        "branches": [totals["covered_branches"], totals["num_branches"]],
    }


def discovery_dependency(error, root):
    if not error.name:
        return False
    package = error.name.partition(".")[0]
    return package not in sys.stdlib_module_names and not any(
        (base / package).is_dir() or (base / f"{package}.py").is_file()
        for base in (root, root / "src")
    )


def has_pytest_cases(module):
    for name, value in vars(module).items():
        if name.startswith("test") and inspect.isfunction(value) and value.__module__ == module.__name__:
            return True
        if (name.startswith("Test") and inspect.isclass(value) and value.__module__ == module.__name__
                and not issubclass(value, unittest.TestCase)
                and any(method.startswith("test") and (inspect.isfunction(function)
                                                        or isinstance(function, (staticmethod, classmethod)))
                        for base in value.__mro__ for method, function in vars(base).items())):
            return True
    return False


def run(plan, report_path):
    root = Path.cwd()
    sys.path.extend([str(root), str(root / "src")])
    result = Result({})
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    test_count = 0
    cov = Coverage(branch=True, config_file=False, data_file=None, source=[str(root)])
    with cov.collect():
        for file in plan["files"]:
            try:
                name = ".".join(Path(file).with_suffix("").parts)
                module = importlib.import_module(name)
                origin = getattr(module, "__file__", None)
                if origin is None or Path(origin).resolve() != root / file:
                    result.errors += 1
                    continue
                result.files[name] = file
                if has_pytest_cases(module):
                    result.unsupported += 1
                # Select TestCase classes directly. unittest discovery would call load_tests.
                for cls in vars(module).values():
                    if isinstance(cls, type) and issubclass(cls, unittest.TestCase) and cls.__module__ == name:
                        tests = loader.loadTestsFromTestCase(cls)
                        test_count += tests.countTestCases()
                        if test_count > plan["maxTests"]:
                            return {"limited": True}
                        suite.addTests(tests)
            except unittest.SkipTest:
                test_count += 1
                if test_count > plan["maxTests"]:
                    return {"limited": True}
                result.cases[file, "módulo"] = "skipped"
            except ModuleNotFoundError as error:
                if discovery_dependency(error, root):
                    result.unavailable += 1
                else:
                    result.errors += 1
            except Exception:
                result.errors += 1
        suite.run(result)
    return {
        "tests": [{"file": file, "name": name, "status": status} for (file, name), status in result.cases.items()],
        "fixtureSkips": result.fixture_skips,
        "unavailable": result.unavailable,
        "unsupported": result.unsupported,
        "errors": result.errors,
        "coverage": measure(cov, plan["sourceFiles"], report_path, plan["maxProfileBytes"])
        if {"passed", "failed"}.intersection(result.cases.values()) else None,
    }


def main():
    plan_path, report_path = map(Path, sys.argv[1:])
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    # Preserve a separate pipe for the structured report while counting project output on stderr.
    with os.fdopen(os.dup(1), "w", encoding="utf-8") as output:
        sys.stdout.flush()
        os.dup2(2, 1)
        output.write(json.dumps(run(plan, report_path)))


if __name__ == "__main__":
    main()
