"""Sinais estáticos de tratamento e reconhecimento de PII sem exportar valores."""

from bisect import bisect_right
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
SINKS = [
    ("LOG", re.compile(r"\b(?:console|logger|logging|log)\.(?:log|info|warn|error|debug|exception)\s*\(|\bprint\s*\(")),
    ("NETWORK", re.compile(r"\b(?:fetch\s*\(|(?:axios|requests|httpx|httpxClient)\.(?:post|put|patch|request)\s*\()")),
    ("STORAGE", re.compile(r"\b(?:localStorage\.setItem\s*\(|INSERT\s+INTO\b|UPDATE\s+\w+\s+SET\b)", re.IGNORECASE)),
]
JS_SUFFIXES = (".js", ".jsx", ".mjs", ".ts", ".tsx")
JS_TRIVIA = re.compile(r'''//[^\n]*|/\*[\s\S]*?(?:\*/|\Z)|(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1''')
JS_ASSIGNMENT = r"(?<![\w$.])(?P<binding>[A-Za-z_$][\w$]*)[ \t]*=(?![=>])"
JS_EVENTS = re.compile(
    "|".join([JS_ASSIGNMENT, r"(?P<block>[{}])"] +
             [f"(?P<{kind}>(?{'i' if sink.flags & re.IGNORECASE else ''}:{sink.pattern}))"
              for kind, sink in SINKS]),
)
JS_DELIMITERS = re.compile(r"[(){}\[\],;\n]")
JS_REFERENCE = re.compile(r"\.\s*[\w$]+|(?<![\w$])(?P<name>[A-Za-z_$][\w$]*)(?![\w$]|\s*:)")
JS_EXPRESSION_LIMIT = 4096
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


def js_expression(code, start, closing=None):
    end = min(len(code), start + JS_EXPRESSION_LIMIT)
    stack = [closing] if closing else []
    for match in JS_DELIMITERS.finditer(code, start, end):
        token = match.group()
        if not stack and token in (",", ";", "\n", "}", ")", "]"):
            return code[start:match.start()]
        if token in "({[":
            stack.append({"(": ")", "{": "}", "[": "]"}[token])
        elif stack and token in ")}]":
            if token != stack.pop():
                return ""
            if closing and not stack:
                return code[start:match.start()]
    return code[start:end] if not stack and end == len(code) else ""


def js_destinations(text):
    # Keep offsets while ignoring comments and literals in the cross-line heuristic.
    def mask(match):
        blank = re.sub(r"[^\n]", " ", match.group())
        return "0" + blank[1:] if match.group(1) else blank

    code = JS_TRIVIA.sub(mask, text)
    newlines = [match.start() for match in re.finditer("\n", code)]
    blocks = [{}]

    def source(expression, start):
        field = FIELD.search(expression)
        if field:
            return bisect_right(newlines, start + field.start()) + 1
        for reference in JS_REFERENCE.finditer(expression):
            line = blocks[-1].get(reference.group("name"))
            if line is not None:
                return line
        return None

    for match in JS_EVENTS.finditer(code):
        kind = match.lastgroup
        if kind == "block":
            if match.group() == "{":
                blocks.append({})
            elif len(blocks) > 1:
                blocks.pop()
        elif kind == "binding":
            start = match.end()
            while start < len(code) and code[start].isspace():
                start += 1
            blocks[-1][match.group("binding")] = source(js_expression(code, start), start)
        elif match.group().endswith("("):
            start = match.end()
            line = source(js_expression(code, start, closing=")"), start)
            if line is not None:
                yield bisect_right(newlines, match.start()) + 1, kind, line


def inspect_fields(text, file, report):
    sources = observations = 0
    cross_line = {}
    if file.lower().endswith(JS_SUFFIXES):
        for number, kind, line in js_destinations(text):
            cross_line.setdefault(number, {}).setdefault(kind, line)
    for number, line in enumerate(text.splitlines(), 1):
        has_field = bool(FIELD.search(line))
        sources += has_field
        destinations = {kind: number for kind, sink in SINKS if has_field and sink.search(line)}
        destinations.update(cross_line.get(number, {}))
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
                "Identificador associado a dado pessoal; inspecionar origem e uso.",
            )
    report.cover("lgpd-static:file", "1", "ok", f"{file} | linhas com campos={sources}, indícios de destino={observations}")


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
