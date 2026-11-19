"""Sinais estáticos de tratamento e reconhecimento de PII sem exportar valores."""

from bisect import bisect_right
from collections import Counter
from contextlib import contextmanager
import logging
import re

TEXT_SUFFIXES = {
    ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".csv", ".env", ".go", ".graphql",
    ".h", ".html", ".ini", ".java", ".js", ".json", ".jsonl", ".jsx", ".kt", ".log",
    ".md", ".mjs", ".php", ".properties", ".py", ".rb", ".rs", ".sh", ".sql", ".svelte",
    ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
}
CODE_SUFFIXES = TEXT_SUFFIXES - {".csv", ".log", ".md", ".txt"}
MAX_TEXT_BYTES = 128 * 1024
CPF_PATTERN = r"(?<![\w.])(?:[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|[0-9]{11})(?![\w.-])"
FIELD = re.compile(
    r"(?:\b|(?<=[a-z]))(?:cpf|e[-_]?mail|telefone|phone(?:Number)?|dataNascimento|"
    r"birthDate|dateOfBirth|nomeCompleto|fullName|endereco|postalAddress)\b",
    re.IGNORECASE,
)
SQL_WRITE = re.compile(r"\b(?:INSERT\s+INTO\b|UPDATE\s+[\w.\"\x60\[\]-]+\s+SET\b)", re.IGNORECASE)
SINKS = [
    ("LOG", re.compile(r"\b(?:console|logger|logging|log)\.(?:log|info|warn|error|debug|exception)\s*\(|\bprint\s*\(")),
    ("NETWORK", re.compile(r"\b(?:fetch\s*\(|(?:axios|requests|httpx|httpxClient)\.(?:post|put|patch|request)\s*\()")),
    ("STORAGE", re.compile(r"\blocalStorage\.setItem\s*\(|" + SQL_WRITE.pattern, re.IGNORECASE)),
]
JS_SUFFIXES = (".js", ".jsx", ".mjs", ".ts", ".tsx")
JS_IDENTIFIER = r"[A-Za-z_$][\w$]*"
JS_COMMENT = r"//[^\n]*|/\*[\s\S]*?(?:\*/|\Z)"
JS_TOKEN = re.compile(
    rf"(?P<comment>{JS_COMMENT})|"
    r'''(?P<string>"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*')|'''
    rf"{JS_IDENTIFIER}|\d[\w.]*|\?\.|=>|\.\.\.|\+\+|--|[^\s]",
)
JS_GAP = re.compile(rf"(?:\s+|{JS_COMMENT})*")
JS_REGEX = re.compile(r"/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/\[\\\r\n])+/[a-zA-Z]*")
JS_REGEX_AFTER = {
    "", "(", "[", "{", ";", ",", ":", "=", "?", "!", "~", "+", "-", "*", "/", "%", "&", "|",
    "^", ">", "=>", "return", "throw", "case", "yield", "await", "void", "typeof", "delete",
    "in", "of", "instanceof", "else", "do",
}
JS_CONTROL_HEADERS = {"if", "while", "for", "with", "switch", "catch"}
JS_BEFORE_ARRAY = JS_REGEX_AFTER | JS_CONTROL_HEADERS | {"const", "let", "var", "export"}
JS_TEMPLATE = re.compile(r"\\[\s\S]|`|\$\{")
JS_OBJECT_KEY = re.compile(r"\s*:")
JS_SPACE = re.compile(r"\s*")
JS_EQUALS = r"=(?![=>])"
JS_INITIALIZER = re.compile(JS_EQUALS)
JS_DECLARATION = rf"(?<![\w$.])(?:const|let|var)\s+(?:(?P<name>{JS_IDENTIFIER})|(?=[{{\[]))"
JS_DECLARATOR_NAME = re.compile(JS_IDENTIFIER)
JS_ASSIGNMENT = rf"(?<![\w$.])(?P<target>{JS_IDENTIFIER})\s*{JS_EQUALS}"
JS_EVENTS = re.compile(
    "|".join([f"(?P<declaration>{JS_DECLARATION})", f"(?P<assignment>{JS_ASSIGNMENT})",
              r"(?P<block>[{}])", r"(?P<comma>,)", r"(?P<sql>\.\s*(?:query|execute)\s*\()"] +
             [f"(?P<{kind}>(?{'i' if sink.flags & re.IGNORECASE else ''}:{sink.pattern}))"
              for kind, sink in SINKS]),
)
JS_DELIMITERS = re.compile(r"[(){}\[\],;\n]")
JS_TYPE_DELIMITERS = re.compile(r"=>|[<>(){}\[\],;=\n]")
JS_REFERENCE = re.compile(rf"(?<!\.)\.\s*[\w$]+|(?<![\w$])(?P<name>{JS_IDENTIFIER})")
JS_IDENTIFIER_CHAR = re.compile(r"[\w$]")
JS_EXPRESSION_LIMIT = 4096
JS_INCOMPLETE_EXPRESSION = "leituras de expressão incompletas (limite ou delimitadores)"
JS_INCOMPLETE_LITERAL = "literais ou comentários incompletos"
JS_UNMEASURED_DECLARATION = "declaradores fora do rastreamento"
JS_UNMEASURED_SQL = "chamadas SQL sem comando literal analisável"
PRESIDIO_LOG = logging.getLogger("presidio-analyzer")
PRESIDIO_TIMEOUT = "Regex pattern '%s' timed out after %s seconds, skipping."


def valid_cpf(value):
    digits = [int(character) for character in value if character in "0123456789"]
    if len(digits) != 11 or len(set(digits)) == 1:
        return False
    for size in (9, 10):
        check = sum(digit * weight for digit, weight in zip(digits[:size], range(size + 1, 1, -1)))
        if (check * 10 % 11) % 10 != digits[size]:
            return False
    return True


def js_previous(code, position, start=0):
    while position > start:
        position -= 1
        if not code[position].isspace():
            return code[position]
    return ""


def js_code(text, gaps):
    """Mask trivia and literal bodies, retaining offsets and template substitutions."""
    code = list(text)
    literals = {}
    templates = []  # (uninterpolated literal start, brace depth); None depth means template text.
    headers = []
    previous = ""
    subscript = False
    position = 0
    while position < len(text):
        if templates and templates[-1][1] is None:
            literal_start, _ = templates[-1]
            for token in JS_TEMPLATE.finditer(text, position):
                if token.group() not in ("${", "`"):
                    continue
                end = token.end()
                code[position:end] = " " * (end - position - 1) + (")" if token.group() == "`" else "(")
                if token.group() == "`":
                    if literal_start is not None:
                        literals[literal_start] = end
                    templates.pop()
                    previous = "value"
                else:
                    templates[-1] = (None, 0)
                    previous = "("
                break
            else:
                code[position:] = " " * (len(text) - position)
                break
            position = end
            continue

        token = JS_TOKEN.search(text, position)
        if token is None:
            break
        position = token.end()
        value = token.group()
        start = token.start()
        if token.lastgroup == "comment":
            if value.startswith("/*") and not value.endswith("*/", 2):
                gaps[JS_INCOMPLETE_LITERAL] += 1
            code[start:position] = re.sub(r"[^\n]", " ", value)
            continue
        if token.lastgroup == "string":
            literals[start] = position
            key = FIELD.fullmatch(value[1:-1])
            next_token = JS_GAP.match(text, position).end() if key else position
            following = text[next_token:next_token + 1]
            if key and ((previous == "[" and subscript and following == "]") or
                        (previous in ("{", ",") and following == ":")):
                code[start:position] = " " + key.group() + " "
            else:
                code[start:position] = "0" + " " * (len(value) - 1)
            value = "value"
        elif value == "/" and previous in JS_REGEX_AFTER:
            literal = JS_REGEX.match(text, start)
            if literal is None:
                gaps[JS_INCOMPLETE_LITERAL] += 1
                position = text.find("\n", start)
                if position == -1:
                    position = len(text)
            else:
                position = literal.end()
            code[start:position] = "0" + " " * (position - start - 1)
            value = "value"
        elif value in ('"', "'"):
            gaps[JS_INCOMPLETE_LITERAL] += 1
            position = text.find("\n", start)
            if position == -1:
                position = len(text)
            code[start:position] = "0" + " " * (position - start - 1)
            value = "value"
        elif value == "`":
            templates.append((start, None))
            code[start] = "("
        elif value == "{" and templates:
            _, depth = templates[-1]
            templates[-1] = (None, depth + 1)
        elif value == "}" and templates:
            _, depth = templates[-1]
            if depth == 0:
                templates[-1] = (None, None)
                code[start] = ")"
            else:
                templates[-1] = (None, depth - 1)
        elif value == "(":
            headers.append(previous in JS_CONTROL_HEADERS)
        elif value == ")" and headers:
            if headers.pop():
                value = ";"  # A control header can be followed by a regex expression statement.
        elif value == "[":
            subscript = (
                previous in ("value", ")", "]", "?.") or
                (previous not in JS_BEFORE_ARRAY and
                 JS_DECLARATOR_NAME.fullmatch(previous) is not None)
            )
        elif previous in (".", "?.") and JS_DECLARATOR_NAME.fullmatch(value):
            value = "value"
        previous = value
    if templates:
        gaps[JS_INCOMPLETE_LITERAL] += len(templates)
    return "".join(code), literals


def js_expression_end(code, start, closing=None, mode=None, limit=None):
    end = start + JS_EXPRESSION_LIMIT if limit is None else limit
    stack = [closing] if closing else []
    pairs = {"(": ")", "{": "}", "[": "]"}
    delimiters = JS_DELIMITERS
    if mode == "annotation":
        delimiters = JS_TYPE_DELIMITERS
        pairs["<"] = ">"
    for match in delimiters.finditer(code, start, end + 1):
        token = match.group()
        if stack and token == stack[-1]:
            stack.pop()
            if closing and not stack:
                return match.start(), False
        elif token in pairs:
            stack.append(pairs[token])
        elif token == "," and mode == "first_argument" and len(stack) == 1:
            return match.start(), False
        elif token == "\n" and not stack and mode in ("annotation", "declarator"):
            next_token = JS_SPACE.match(code, match.end()).end()
            following = code[next_token:next_token + 1]
            if mode == "annotation" and (following in ("|", "&", "=") or
                                         js_previous(code, match.start(), start) in ("|", "&")):
                continue
            if following == ",":
                continue
            return match.start(), False
        elif token in ("}", ")", "]") or (not stack and token in (",", ";", "\n", "=")):
            return match.start(), bool(stack)
    return min(end, len(code)), bool(stack) or end < len(code)


def js_declarator(code, position):
    position = JS_SPACE.match(code, position).end()
    incomplete = False
    if code[position:position + 1] == ":":
        type_start = JS_SPACE.match(code, position + 1).end()
        position, incomplete = js_expression_end(code, type_start, mode="annotation")
        position = JS_SPACE.match(code, position).end()
    expression = None
    end = position
    if not incomplete and JS_INITIALIZER.match(code, position):
        start = JS_SPACE.match(code, position + 1).end()
        end, incomplete = js_expression_end(code, start, mode="declarator")
        expression = (start, end)
    return position, end, expression, incomplete


def js_events(code, root):
    position = 0
    scopes = [root]
    # Revisit only top-level declarator commas, after handling events inside the initializer.
    next_declarators = set()
    while match := JS_EVENTS.search(code, position):
        position = match.end()
        kind = match.lastgroup
        if kind == "block":
            if match.group() == "{":
                scope = set()
                scopes.append(scope)
                yield kind, match.start(), scope, None
            elif len(scopes) > 1:
                yield kind, match.start(), scopes.pop(), None
        elif kind == "declaration" or (kind == "comma" and match.start() in next_declarators):
            if kind == "comma":
                next_declarators.remove(match.start())
                position = JS_SPACE.match(code, position).end()
                identifier = JS_DECLARATOR_NAME.match(code, position)
                name = identifier.group() if identifier else None
                if identifier:
                    position = identifier.end()
            else:
                name = match.group("name")
            if name is None:
                yield "gap", None, None, JS_UNMEASURED_DECLARATION
                closing = {"{": "}", "[": "]"}.get(code[position:position + 1])
                if closing is None:
                    continue
                pattern_end, incomplete = js_expression_end(code, position + 1, closing=closing)
                if incomplete:
                    continue
                position = pattern_end + 1
            else:
                scopes[-1].add(name)
            position, end, expression, incomplete = js_declarator(code, position)
            if not incomplete and code[end:end + 1] == ",":
                next_declarators.add(end)
            if name is not None:
                yield "declaration", expression, name, JS_INCOMPLETE_EXPRESSION if incomplete else None
        elif kind == "assignment":
            if js_previous(code, match.start()) != ".":
                start = JS_SPACE.match(code, position).end()
                end, incomplete = js_expression_end(code, start)
                yield kind, (start, end), match.group("target"), JS_INCOMPLETE_EXPRESSION if incomplete else None
        elif match.group().endswith("("):
            yield kind, position, match.start(), None


def js_destinations(text):
    gaps = Counter()
    code, literals = js_code(text, gaps)
    newlines = [match.start() for match in re.finditer("\n", text)]
    # Collect declarations before evaluating statements, so inner declarations shadow
    # throughout their blocks. Each name's active binding is the last entry in its stack.
    root = set()
    ordered = list(js_events(code, root))
    bindings = {name: [None] for name in root}
    destinations = {}

    def line_at(position):
        return bisect_right(newlines, position) + 1

    def source(start, end, incomplete):
        if incomplete and end < len(code) and JS_IDENTIFIER_CHAR.match(code, end):
            while end > start and JS_IDENTIFIER_CHAR.match(code, end - 1):
                end -= 1
        field = FIELD.search(code, start, end)
        if field:
            return line_at(field.start())
        for reference in JS_REFERENCE.finditer(code, start, end):
            binding = bindings.get(reference.group("name"))
            if not binding or binding[-1] is None:
                continue
            if JS_OBJECT_KEY.match(code, reference.end(), end) and js_previous(
                code, reference.start(), start
            ) in ("{", ","):
                continue
            return binding[-1]
        return None

    for kind, position, item, gap in ordered:
        if gap:
            gaps[gap] += 1
        if kind == "gap":
            continue
        if kind == "block":
            if code[position] == "{":
                for name in item:
                    bindings.setdefault(name, []).append(None)
            else:
                for name in item:
                    bindings[name].pop()
        elif kind in ("declaration", "assignment"):
            line = source(*position, bool(gap)) if position is not None else None
            binding = bindings.get(item)
            if not binding:
                binding = bindings[item] = [None]
            binding[-1] = line
        else:
            end, incomplete = js_expression_end(code, position, closing=")")
            if incomplete:
                gaps[JS_INCOMPLETE_EXPRESSION] += 1
            if kind == "sql":
                start = JS_SPACE.match(code, position, end).end()
                literal_end = literals.get(start)
                if literal_end is None:
                    gaps[JS_UNMEASURED_SQL] += 1
                    continue
                if literal_end > end:
                    continue
                separator = JS_SPACE.match(code, literal_end, end).end()
                if separator < end and code[separator] != ",":
                    gaps[JS_UNMEASURED_SQL] += 1
                    continue
                if separator == end or not SQL_WRITE.match(text[start + 1:literal_end - 1].lstrip()):
                    continue
                position = separator + 1
                # The second argument holds the bound values. Later arguments may be callbacks or options.
                end, incomplete = js_expression_end(code, position, closing=")", mode="first_argument", limit=end)
                kind = "STORAGE"
            line = source(position, end, incomplete)
            if line is not None:
                destinations.setdefault(line_at(item), {}).setdefault(kind, line)
    return destinations, gaps


def inspect_fields(text, file, report):
    sources = observations = 0
    javascript = file.lower().endswith(JS_SUFFIXES)
    cross_line, gaps = js_destinations(text) if javascript else ({}, {})
    for number, line in enumerate(text.splitlines(), 1):
        has_field = bool(FIELD.search(line))
        sources += has_field
        destinations = cross_line.get(number, {}) if javascript else {
            kind: number for kind, sink in SINKS if has_field and sink.search(line)
        }
        for kind, origin in destinations.items():
            observations += 1
            report.find(
                "lgpd-static", "PII_POSSIBLE_" + kind, file, number, "media",
                "Possível tratamento de dado pessoal; confirmar a origem e o destino.",
                f"Indício de campo de dado pessoal na linha {origin}. Chamada da categoria {kind}.",
            )
        if has_field and not destinations:
            report.find(
                "lgpd-static", "PII_FIELD", file, number, "informativa",
                "Referência a campo de dado pessoal.",
                "Termo associado a dado pessoal. Inspecionar origem e uso.",
            )
    detail = f"{file} | linhas com campos={sources}, indícios de destino={observations}"
    if gaps:
        detail += ". Cobertura parcial: " + ", ".join(f"{count} {reason}" for reason, count in sorted(gaps.items())) + "."
    report.cover("lgpd-static:file", "1", "failed" if gaps else "ok", detail)
    return not gaps


def create_presidio():
    import spacy
    from tldextract import TLDExtract
    from presidio_analyzer import AnalyzerEngine, Pattern, PatternRecognizer
    from presidio_analyzer.nlp_engine import NerModelConfiguration, SpacyNlpEngine
    from presidio_analyzer.predefined_recognizers import EmailRecognizer, PhoneRecognizer

    models = {"pt": "pt_core_news_sm", "en": "en_core_web_sm"}
    if any(not spacy.util.is_package(model) for model in models.values()):
        raise RuntimeError("modelos ausentes")

    class CPFRecognizer(PatternRecognizer):
        def validate_result(self, pattern_text):
            return valid_cpf(pattern_text)

    extract_domain = TLDExtract(suffix_list_urls=(), cache_dir=None)

    class OfflineEmailRecognizer(EmailRecognizer):
        def validate_result(self, pattern_text):
            return bool(extract_domain(pattern_text).fqdn)

    engine = SpacyNlpEngine(
        models=[{"lang_code": lang, "model_name": name} for lang, name in models.items()],
        ner_model_configuration=NerModelConfiguration(
            model_to_presidio_entity_mapping={"PER": "PERSON", "PERSON": "PERSON"},
        ),
    )
    analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=list(models), default_score_threshold=0.6)
    for recognizer in analyzer.get_recognizers(language="en"):
        if isinstance(recognizer, PhoneRecognizer):
            recognizer.score_thresholds = {"PHONE_NUMBER": PhoneRecognizer.SCORE}
    analyzer.registry.remove_recognizer("EmailRecognizer", language="en")
    analyzer.registry.add_recognizer(OfflineEmailRecognizer())
    for language in models:
        analyzer.registry.add_recognizer(CPFRecognizer(
            name="ChecksumBrazilCPF", supported_entity="BR_CPF", supported_language=language,
            patterns=[Pattern("CPF de 11 dígitos", CPF_PATTERN, 0.8)],
        ))
    return analyzer


class PresidioDiagnostics(logging.Handler):
    timed_out = False

    def emit(self, record):
        if record.msg == PRESIDIO_TIMEOUT:
            self.timed_out = True


@contextmanager
def presidio_diagnostics():
    # Presidio 2.2.366 reports swallowed timeouts through this shared logger.
    logger = PRESIDIO_LOG
    previous = logger.handlers, logger.level, logger.propagate, logger.disabled
    diagnostics = PresidioDiagnostics()
    logger.handlers, logger.propagate, logger.disabled = [diagnostics], False, False
    logger.setLevel(logging.WARNING)
    try:
        yield diagnostics
    finally:
        logger.handlers, level, logger.propagate, logger.disabled = previous
        logger.setLevel(level)
        diagnostics.close()


def inspect_entities(analyzer, text, file, version, report, diagnostics):
    starts = [0] + [match.end() for match in re.finditer(r"\n", text)]
    entities = {}
    diagnostics.timed_out = False
    for language, requested in (("pt", ["BR_CPF", "PERSON"]), ("en", ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON"])):
        for entity in analyzer.analyze(text=text, language=language, entities=requested):
            line = bisect_right(starts, entity.start)
            entities.setdefault((line, entity.entity_type), set()).add((entity.start, entity.end))
    for (line, kind), matches in sorted(entities.items()):
        report.find(
            "presidio-analyzer", "PII_" + kind, file, line, "media" if kind == "BR_CPF" else "baixa",
            "Possível dado pessoal presente no texto.",
            f"Entidade {kind}; ocorrências distintas na linha: {len(matches)}. Valor suprimido.",
        )
    status = "failed" if diagnostics.timed_out else "ok"
    detail = "tempo limite de padrão atingido. Resultados parciais" if diagnostics.timed_out else "português e inglês"
    report.cover("presidio-analyzer:file", version, status, f"{file} | {detail}. Tipos por linha={len(entities)}")
    return not diagnostics.timed_out
