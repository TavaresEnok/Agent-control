"""Inventário passivo de licenças e triagem de obrigações em lockfiles npm."""

from bisect import bisect_right
from functools import cache
from itertools import combinations, islice
import json
import re

TOOL = "npm-license-policy"
VERSION = "1"
MAX_LICENSE_PAIRS = 256
PERMISSIVE = {"MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"}
STRONG = re.compile(r"(?:A?GPL-[123]\.[01](?:-only|-or-later)?|SSPL-1\.0)")
DEPENDENCY = re.compile(r"(?:node_modules/(?:@[-\w.]+/)?[-\w.]+/)*node_modules/(?:@[-\w.]+/)?[-\w.]+", re.ASCII)
JSON_SPACE = re.compile(r"[ \t\r\n]*")


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


def object_locations(text, start=0):
    """Offsets of immediate JSON object members, after syntax validation."""
    decode = json.JSONDecoder().raw_decode

    def skip_space(offset):
        return JSON_SPACE.match(text, offset).end()

    key_start = skip_space(skip_space(start) + 1)
    locations = {}
    while text[key_start] != "}":
        key, key_end = decode(text, key_start)
        value_start = skip_space(skip_space(key_end) + 1)
        _, value_end = decode(text, value_start)
        locations[key] = (key_start, value_start)
        separator = skip_space(value_end)
        if text[separator] != ",":
            break
        key_start = skip_space(separator + 1)
    return locations


def source_line(text, offset):
    return 1 + text.count("\n", 0, offset)


def inspect_lock(text, project_license, file, report, project_origin=None):
    lock = json.loads(text)
    if not isinstance(lock, dict):
        raise ValueError("lock")
    entries = lock.get("packages")
    if lock.get("lockfileVersion") not in (2, 3) or not isinstance(entries, dict):
        report.cover(TOOL + ":file", VERSION, "skipped", f"{file} | formato npm fora de v2/v3")
        return None
    if any(not isinstance(entry, dict) for entry in entries.values()):
        raise ValueError("packages")

    _, packages_start = object_locations(text)["packages"]
    locations = object_locations(text, packages_start)
    if project_license is None:
        project_license = entries.get("", {}).get("license")
        if project_license is not None:
            _, root_start = locations[""]
            license_start, _ = object_locations(text, root_start)["license"]
            project_origin = (file, source_line(text, license_start))
    project_category, project_expression = classify(project_license)
    counts = {"classificadas": 0, "sem licença reconhecida": 0, "fora do escopo": 0}
    declared = []
    newlines = [match.start() for match in re.finditer(r"\n", text)]
    pair_locations = {}
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
        line = bisect_right(newlines, locations[name][0]) + 1
        if expression != "UNLICENSED":
            declared.append((name, expression, line))
        report.find(
            TOOL, "LICENSE_DEPENDENCY_DECLARED", file, line, "informativa",
            "Licença de dependência declarada no lockfile.",
            f"Declaração em packages: {expression}.",
        )
        if (category == "copyleft forte" and project_category in {"permissiva", "proprietária"}) or (
            category == "proprietária" and project_category == "permissiva"
        ):
            origin = f" em {project_origin[0]} linha {project_origin[1]}" if project_origin else ""
            report.find(
                TOOL, "LICENSE_OBLIGATION_REVIEW", file, line, "media",
                "Triagem das condições de distribuição entre projeto e dependência.",
                f"Dependência declara {expression}. Projeto declara {project_expression}{origin}.",
            )
        if category in {"copyleft forte", "proprietária"}:
            pair_locations.setdefault(expression, line)

    classes = sorted(pair_locations)
    total_pairs = len(classes) * (len(classes) - 1) // 2
    for left, right in islice(combinations(classes, 2), MAX_LICENSE_PAIRS):
        (at, other), (line, expression) = sorted(((pair_locations[left], left), (pair_locations[right], right)))
        report.find(
            TOOL, "LICENSE_DEPENDENCY_OBLIGATION_REVIEW", file, line, "media",
            "Triagem das condições de distribuição entre dependências do lockfile.",
            f"Dependência declara {expression}. Outra dependência declara {other} neste lockfile, linha {at}.",
        )
    project = project_expression or "desconhecida"
    totals = ", ".join(f"{key}={count}" for key, count in counts.items())
    omitted = max(0, total_pairs - MAX_LICENSE_PAIRS)
    report.cover(TOOL + ":file", VERSION, "failed" if omitted else "ok",
                 f"{file} | projeto={project}; {totals}; pares fora do limite={omitted}")
    return declared
