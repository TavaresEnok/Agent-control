"""Generate mutmut edits or run explicit pytest files in a disposable copy."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sys

sys.path.append(str(Path(__file__).resolve().with_name("python-deps")))

MAX_CANDIDATES = 512
MAX_TESTS = 200
MAX_EXAMPLES = 32
MAX_PROPERTY_CALLS = 256
ARITHMETIC = {"+", "-", "*", "/", "//", "%", "**"}


def probe(mode):
    names = ("pytest", "hypothesis")
    if mode == "plan":
        names += ("mutmut", "libcst")
    try:
        import hypothesis
        import pytest
        if mode == "plan":
            from mutmut.file_mutation import MutationVisitor
        return {name: importlib.metadata.version(name) for name in names}
    except (ImportError, OSError):
        return {}


def plan(files):
    import libcst as cst
    from libcst.metadata import MetadataWrapper, PositionProvider
    from mutmut.file_mutation import MutationVisitor, pragma_no_mutate_lines
    from mutmut.node_mutation import operator_swap_op

    edits, omitted = [], []
    for file in files:
        try:
            source = Path(file).read_bytes().decode("utf-8")
            wrapper = MetadataWrapper(cst.parse_module(source))
        except (OSError, UnicodeError, cst.ParserSyntaxError):
            omitted.append(file)
            continue
        visitor = MutationVisitor(
            [(cst.BinaryOperation, operator_swap_op)], pragma_no_mutate_lines(source)
        )
        wrapper.visit(visitor)
        positions = wrapper.resolve(PositionProvider)
        for mutation in visitor.mutations:
            original = mutation.original_node.operator
            before = wrapper.module.code_for_node(original).strip()
            after = wrapper.module.code_for_node(mutation.mutated_node.operator).strip()
            if before not in ARITHMETIC or after not in ARITHMETIC:
                continue
            if len(edits) == MAX_CANDIDATES:
                return {"edits": edits, "omitted": omitted, "truncated": True}
            start = positions[original].start
            edits.append({
                "file": file, "line": start.line, "column": start.column + 1,
                "before": before, "after": after,
            })
    return {"edits": edits, "omitted": omitted, "truncated": False}


def suite(mode, seed, files):
    import functools
    import random
    import hypothesis
    import pytest
    from hypothesis.errors import HypothesisException

    root = Path.cwd()
    allowed_files = set(files)
    settings = hypothesis.settings

    class PropertyLimit(Exception):
        pass

    def test_failure(error):
        if isinstance(error, (ImportError, HypothesisException, PropertyLimit, pytest.UsageError)):
            return False
        if isinstance(error, BaseExceptionGroup):
            return all(test_failure(child) for child in error.exceptions)
        return isinstance(error, (Exception, pytest.fail.Exception))

    class Report:
        def __init__(self):
            self.tests = {}
            self.limited = False
            self.unavailable = False

        @pytest.hookimpl(trylast=True)
        def pytest_collection_modifyitems(self, config, items):
            rejected = []
            selected = []
            for item in items:
                obj = getattr(item, "obj", None)
                property_test = hypothesis.is_hypothesis_test(obj)
                if mode == "properties" and not property_test:
                    rejected.append(item)
                else:
                    selected.append((item, property_test))
            if rejected:
                config.hook.pytest_deselected(items=rejected)
            if len(selected) > MAX_TESTS or len({item.nodeid for item, _ in selected}) != len(selected):
                self.limited = True
                items[:] = []
                return
            items[:] = [item for item, _ in selected]
            for item, property_test in selected:
                location, line, _ = item.location
                origin = (root / location).resolve()
                if line is None or not origin.is_relative_to(root):
                    raise pytest.UsageError("QA_PYTHON_TEST_OUTSIDE_SELECTION")
                file = origin.relative_to(root).as_posix()
                if file not in allowed_files:
                    raise pytest.UsageError("QA_PYTHON_TEST_OUTSIDE_SELECTION")
                self.tests[item.nodeid] = {
                    "id": hashlib.sha256(item.nodeid.encode()).hexdigest(),
                    "file": file, "line": line + 1,
                    "status": "pending", "property": property_test, "examples": 0,
                }

        @pytest.hookimpl(hookwrapper=True, trylast=True)
        def pytest_runtest_call(self, item):
            record = self.tests[item.nodeid]
            if not record["property"]:
                yield
                return

            obj = item.obj
            function = getattr(obj, "__func__", obj)
            current = getattr(function, "_hypothesis_internal_use_settings", settings.default)
            inner = function.hypothesis.inner_test
            original_seed = getattr(function, "_hypothesis_internal_use_seed", None)

            @functools.wraps(inner)
            def counted(*args, **kwargs):
                if record["examples"] >= MAX_PROPERTY_CALLS:
                    self.limited = True
                    raise PropertyLimit()
                record["examples"] += 1
                return inner(*args, **kwargs)

            function._hypothesis_internal_use_settings = settings(
                current, max_examples=min(current.max_examples, MAX_EXAMPLES),
                database=None, derandomize=False,
            )
            function._hypothesis_internal_use_seed = seed
            function.hypothesis.inner_test = counted
            try:
                yield
            finally:
                function.hypothesis.inner_test = inner
                function._hypothesis_internal_use_seed = original_seed
                function._hypothesis_internal_use_settings = current

        @pytest.hookimpl(hookwrapper=True)
        def pytest_runtest_makereport(self, item, call):
            report = (yield).get_result()
            record = self.tests[item.nodeid]
            if report.failed:
                observed_failure = (
                    report.when == "call" and call.excinfo
                    and (not record["property"] or record["examples"] > 0)
                    and test_failure(call.excinfo.value)
                )
                record["status"] = "failed" if observed_failure else "error"
            elif report.skipped and record["status"] in ("pending", "passed"):
                record["status"] = "skipped"
            elif report.when == "call" and report.passed:
                record["status"] = "error" if hasattr(report, "wasxfail") else "passed"

        def pytest_exception_interact(self, call):
            if call.excinfo and isinstance(call.excinfo.value, ModuleNotFoundError):
                self.unavailable = True

    # The tool dependencies come first. Load local conftest files within the copied root.
    sys.path.append(str(root))
    random.seed(seed)
    reporter = Report()
    args = [
        "-c", "/dev/null", "--rootdir=.", "--confcutdir=.", "--import-mode=importlib",
        "-p", "no:cacheprovider", "-p", "_hypothesis_pytestplugin",
        "--hypothesis-seed=" + str(seed), "-q", "-s", "--tb=no", "--",
        *("./" + file for file in files),
    ]
    result = pytest.main(args, plugins=[reporter])
    return {"exitCode": int(result), "tests": list(reporter.tests.values()),
            "limited": reporter.limited, "unavailable": reporter.unavailable}


def main():
    command, *args = sys.argv[1:]
    if command == "probe":
        result = probe(args[0])
    elif command == "plan":
        result = plan(args)
    elif command in ("suite", "properties"):
        # Reserve stdout for the protocol even when a test writes directly to fd 1.
        with os.fdopen(os.dup(1), "w", encoding="utf-8") as output:
            sys.stdout.flush()
            os.dup2(2, 1)
            output.write(json.dumps(suite(command, int(args[0]), args[1:])) + "\n")
        return
    else:
        raise SystemExit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
