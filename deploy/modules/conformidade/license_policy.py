"""Inventário passivo de licenças e triagem de obrigações em lockfiles npm."""

from bisect import bisect_right
from collections import Counter
from functools import cache
from itertools import combinations, islice
import json
import math
import re

TOOL = "npm-license-policy"
VERSION = "1"
MAX_LICENSE_PAIRS = 256
PERMISSIVE = {"MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Unlicense"}
STRONG = re.compile(r"(?:A?GPL-[123]\.[01](?:-only|-or-later)?|SSPL-1\.0)")
DEPENDENCY = re.compile(r"(?:node_modules/(?:@[-\w.]+/)?[-\w.]+/)*node_modules/(?:@[-\w.]+/)?[-\w.]+", re.ASCII)
JSON_SPACE = re.compile(r"[ \t\r\n]*")
SAFE_PATH = re.compile(r"[A-Za-z0-9._@+/\-]{1,400}", re.ASCII)
EXCLUDED_DIRS_AND_FILES = {".git", ".github", ".ai", "node_modules", ".venv", "__pycache__"}
EXCLUDED_LOWER = {
    ".mcp.json", ".claude", ".husky", ".codex", ".grok",
    ".aws", ".ssh", ".config", ".pypirc",
    ".docker", ".git-credentials", ".gnupg", ".kube",
    ".npmrc", ".netrc", ".pgpass",
}
SECRET_COMPONENT_RE = re.compile(
    r"(?:^|[._-])(?:secrets?|credentials?|password|senha)(?:[._-]|$)",
    re.IGNORECASE,
)
_NOT_A_MASK = r"(?![^\s\u2026]*\u2026)"
_SECRET_VALUE = r'(?:"[^"\r\n]*"|\'[^\'\r\n]*\'|\S+)'
_ASSIGN_NAME = r"pass|passwd|password|secret|token|(?<![A-Za-z])key(?!board)|auth|credential"
_UNKNOWN_PATTERNS = (
    re.compile(r"-----BEGIN(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----[\s\S]*?-----END(?: [A-Za-z0-9][A-Za-z0-9 -]{0,80})?-----"),
    re.compile(r"(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])"),
    re.compile(r"(?<![A-Z0-9])ASIA[0-9A-Z]{16}(?![A-Z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{20,400}(?![A-Za-z0-9_])"),
    re.compile(r"(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])ghs_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])gho_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])sk-[A-Za-z0-9_-]{20,400}(?![A-Za-z0-9_-])"),
    re.compile(r"(?<![A-Za-z0-9])xox[a-z]-[A-Za-z0-9-]{10,400}(?![A-Za-z0-9-])"),
    re.compile(r"(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\s/:@\u2026]{1,200}:[^\s/@\u2026]{1,200}@"),
    re.compile(r"(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,255}(?![A-Za-z0-9_-])"),
    re.compile(r"(?<![A-Za-z0-9_])sk_live_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])rk_live_[A-Za-z0-9]{20,255}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9_])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])"),
    re.compile(r"(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])"),
    re.compile(rf"(?<![A-Za-z0-9_])authorization[ \t]*:[ \t]*(?:bearer|basic)[ \t]+{_NOT_A_MASK}{_SECRET_VALUE}", re.IGNORECASE),
    re.compile(r"(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]{0,39}[G-Zg-z+/])[A-Za-z0-9+/]{40}(?![A-Za-z0-9+/])"),
    re.compile(r"(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}(?![A-Za-z0-9_-])"),
    re.compile(rf"(?<![A-Za-z0-9_])--(?:{_ASSIGN_NAME})\w*(?:[\"']?\s*[:=]\s*|[ \t]+){_NOT_A_MASK}(?!(?:null|true|false)\b){_SECRET_VALUE}", re.IGNORECASE),
    re.compile(rf"(?:{_ASSIGN_NAME})\w*[\"']?\s*[:=]\s*{_NOT_A_MASK}(?!(?:null|true|false)\b){_SECRET_VALUE}", re.IGNORECASE),
)
_BASE64_SECRET = re.compile(r"[A-Za-z0-9+]{40,}={0,2}")
_SHORT_FILE_EXTENSION = re.compile(r"\.[A-Za-z0-9]{1,5}$")
_MASK_TOKEN = re.compile(r"^\(sha256:[a-f0-9]{64}\)$")


def _shannon_entropy(value):
    total = len(value)
    if not total:
        return 0.0
    counts = Counter(value)
    return -sum((count / total) * math.log2(count / total) for count in counts.values())


def _secret_segment(segment):
    return bool(_BASE64_SECRET.search(segment) or (len(segment) >= 32 and _shannon_entropy(segment) >= 3.5))


def is_secret_token(token):
    if not token or _MASK_TOKEN.fullmatch(token):
        return False
    return any(
        segment
        and _secret_segment(segment)
        for segment in token.split("/")
    )


def has_known_secret(text):
    return isinstance(text, str) and any(pattern.search(text) for pattern in _UNKNOWN_PATTERNS)


def is_redacted_text(text):
    if not isinstance(text, str):
        return True
    if has_known_secret(text):
        return True
    return any(is_secret_token(token) for token in text.split())


def sanitize_report_text(text):
    if not isinstance(text, str):
        return ""
    out = text
    for pattern in _UNKNOWN_PATTERNS:
        out = pattern.sub("[trecho omitido]", out)
    return re.sub(
        r"\S+",
        lambda m: "[removido: alta entropia]"
        if is_secret_token(m.group(0))
        else m.group(0),
        out,
    )


def is_protected_component(part):
    if not isinstance(part, str) or not part or part in {".", ".."} or part != part.strip():
        return True
    if part in EXCLUDED_DIRS_AND_FILES:
        return True
    lower = part.lower()
    if lower in EXCLUDED_LOWER:
        return True
    if lower == ".env" or lower.startswith(".env"):
        return True
    if lower.endswith((".pem", ".key", ".p12", ".pfx", ".jks", ".tfstate", ".tfvars")):
        return True
    if lower.startswith(("id_", "credentials")):
        return True
    if lower.startswith("service-account") and lower.endswith(".json"):
        return True
    if "kubeconfig" in lower:
        return True
    if SECRET_COMPONENT_RE.search(part):
        return True
    return False


def is_sensitive_path(file):
    if not isinstance(file, str) or not file or not SAFE_PATH.fullmatch(file):
        return True
    parts = file.split("/")
    if any(is_protected_component(part) for part in parts):
        return True
    if has_known_secret(file) or any(has_known_secret(part) for part in parts):
        return True
    if any(is_secret_token(_SHORT_FILE_EXTENSION.sub("", part)) for part in parts):
        return True
    return False


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

    normalized = str(expression)
    if is_redacted_text(normalized):
        return "desconhecida", None
    return category(expression), normalized


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
    if is_sensitive_path(file):
        report.cover(TOOL + ":file", VERSION, "skipped", "Arquivo excluído, protegido ou com caminho incompatível.")
        return None
    if project_origin is not None and is_sensitive_path(project_origin[0]):
        project_origin = None
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
