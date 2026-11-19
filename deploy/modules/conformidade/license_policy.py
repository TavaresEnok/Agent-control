"""Inventário passivo de licenças e triagem de obrigações em lockfiles npm."""

from bisect import bisect_right
from functools import cache
import json
import re

TOOL = "npm-license-policy"
VERSION = "1"
PERMISSIVE = {"MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"}
STRONG = re.compile(r"(?:A?GPL-[123]\.[01](?:-only|-or-later)?|SSPL-1\.0)")
DEPENDENCY = re.compile(r"(?:node_modules/(?:@[-\w.]+/)?[-\w.]+/)*node_modules/(?:@[-\w.]+/)?[-\w.]+", re.ASCII)


def classify(value):
    # The expression library and its SPDX dictionary are installed from the wheel lock.
    from license_expression import AND, OR, ExpressionError

    if not isinstance(value, str) or len(value) > 512:
        return "desconhecida", None
    if value in {"NONE", "NOASSERTION"}:
        return "desconhecida", None
    if value == "UNLICENSED":
        return "proprietária", value
    try:
        expression = get_spdx_parser().parse(value, validate=True)
    except ExpressionError:
        return "desconhecida", None
    if expression is None:
        return "desconhecida", None

    def category(node):
        if isinstance(node, (AND, OR)):
            categories = [category(child) for child in node.args]
            if isinstance(node, AND) and "copyleft forte" in categories:
                return "copyleft forte"
            if all(item == "copyleft forte" for item in categories):
                return "copyleft forte"
            if (isinstance(node, OR) and "permissiva" in categories) or all(
                item == "permissiva" for item in categories
            ):
                return "permissiva"
            return "revisão"
        key = getattr(node, "key", "")
        if key in PERMISSIVE:
            return "permissiva"
        return "copyleft forte" if STRONG.fullmatch(key) else "revisão"

    return category(expression), str(expression)


@cache
def get_spdx_parser():
    from license_expression import get_spdx_licensing

    return get_spdx_licensing()


def inspect_lock(text, project_license, file, report):
    lock = json.loads(text)
    if not isinstance(lock, dict):
        raise ValueError("lock")
    entries = lock.get("packages")
    if lock.get("lockfileVersion") not in (2, 3) or not isinstance(entries, dict):
        report.cover(TOOL + ":file", VERSION, "skipped", f"{file} | formato npm fora de v2/v3")
        return None
    if any(not isinstance(entry, dict) for entry in entries.values()):
        raise ValueError("packages")

    if project_license is None:
        project_license = entries.get("", {}).get("license")
    project_category, project_expression = classify(project_license)
    counts = {"classificadas": 0, "sem licença reconhecida": 0, "fora do escopo": 0}
    declared = []
    newlines = [match.start() for match in re.finditer(r"\n", text)]
    entry_lines = {}
    for match in re.finditer(r'^([ \t]*"([^"\\]+)"\s*:\s*\{)', text, re.MULTILINE):
        name = match.group(2)
        if len(name) <= 400 and DEPENDENCY.fullmatch(name):
            entry_lines.setdefault(name, bisect_right(newlines, match.start(1)) + 1)
    for name, entry in entries.items():
        if name == "":
            continue
        if len(name) > 400 or not DEPENDENCY.fullmatch(name) or entry.get("link") is True:
            counts["fora do escopo"] += 1
            continue
        category, expression = classify(entry.get("license"))
        if expression is None:
            counts["sem licença reconhecida"] += 1
            continue
        counts["classificadas"] += 1
        line = entry_lines.get(name, 1)
        if expression != "UNLICENSED":
            declared.append((name, expression, line))
        release = entry.get("version")
        at_release = f" versão {release}" if isinstance(release, str) and re.fullmatch(r"[0-9A-Za-z.+-]{1,80}", release) else ""
        report.find(
            TOOL, "LICENSE_DEPENDENCY_DECLARED", file, line, "informativa",
            "Licença de dependência declarada no lockfile.",
            f"packages[{name}]{at_release} declara {expression}.",
        )
        if category in {"copyleft forte", "proprietária"} and project_category == "permissiva":
            report.find(
                TOOL, "LICENSE_OBLIGATION_REVIEW", file, line, "media",
                "Licença de dependência requer revisão das condições de distribuição.",
                f"packages[{name}] declara {expression}; projeto declara {project_expression}.",
            )
    project = project_expression or "desconhecida"
    totals = ", ".join(f"{key}={count}" for key, count in counts.items())
    report.cover(TOOL + ":file", VERSION, "ok", f"{file} | projeto={project}; {totals}")
    return declared
