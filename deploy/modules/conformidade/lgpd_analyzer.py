"""Sinais estáticos de tratamento e reconhecimento de PII sem exportar valores."""

from bisect import bisect_right
from collections import Counter
from contextlib import contextmanager
import json
import logging
import os
from pathlib import Path
import re
from shutil import which
import subprocess

import lgpd_python
from lgpd_sql import sql_origin

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
JS_SUFFIXES = {".js", ".jsx", ".mjs", ".ts", ".tsx"}
AST_SUFFIXES = JS_SUFFIXES | {".py"}
JS_EXPRESSION_LIMIT = 4096
JS_BATCH_FILES = 128
JS_BATCH_BYTES = 1024 * 1024
JS_UNAVAILABLE = "parser JavaScript/TypeScript indisponível ou interrompido"
JS_WORKER = Path(__file__).resolve().with_name("lgpd_javascript.mjs")
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


def javascript_batch(batch):
    node = which("node")
    try:
        if node is None:
            raise FileNotFoundError
        payload = "".join(
            json.dumps((source, Path(file).suffix.lower(), FIELD.pattern, JS_EXPRESSION_LIMIT)) + "\n"
            for file, source in batch
        )
        process = subprocess.run(
            [node, "--max-old-space-size=192", str(JS_WORKER)],
            input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True,
            encoding="utf-8", env={"PATH": os.defpath, "LANG": "C.UTF-8"},
            cwd=JS_WORKER.parent, timeout=20,
        )
        results = [json.loads(line) for line in process.stdout.rstrip("\n").split("\n")]
        if len(results) != len(batch):
            raise ValueError
    except (OSError, subprocess.SubprocessError, ValueError):
        return {file: ({}, Counter({JS_UNAVAILABLE: 1})) for file, _ in batch}

    parsed = {}
    for (file, _), result in zip(batch, results):
        destinations = {}
        gaps = Counter(dict(result["gaps"]))
        for line, kind, source in result["hits"]:
            destinations.setdefault(line, {}).setdefault(kind, source)
        for line, command, parameters in result["sql"]:
            source = sql_origin(command, parameters, gaps)
            if source is not None:
                destinations.setdefault(line, {}).setdefault("STORAGE", source)
        parsed[file] = destinations, gaps
    return parsed


def javascript_destinations(texts):
    results = {}
    batch = []
    size = 0
    for file, source in texts:
        if Path(file).suffix.lower() not in JS_SUFFIXES:
            continue
        length = len(source.encode("utf-8"))
        if batch and (len(batch) >= JS_BATCH_FILES or size + length > JS_BATCH_BYTES):
            results.update(javascript_batch(batch))
            batch, size = [], 0
        batch.append((file, source))
        size += length
    if batch:
        results.update(javascript_batch(batch))
    return results


def inspect_fields(text, file, report, parsed=None):
    suffix = Path(file).suffix.lower()
    if suffix in JS_SUFFIXES:
        cross_line, gaps = parsed if parsed is not None else javascript_batch([(file, text)])[file]
        lines = re.split(r"\r\n|[\r\n\u2028\u2029]", text)
    elif suffix == ".py":
        cross_line, gaps = lgpd_python.destinations(text, FIELD)
        lines = text.split("\n")
    else:
        cross_line, gaps = {}, {}
        lines = text.splitlines()

    sources = observations = 0
    for number, line in enumerate(lines, 1):
        # Field inventory remains a textual signal, independent of destination attribution.
        has_field = bool(FIELD.search(line))
        sources += has_field
        destinations = cross_line.get(number, {})
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
    if suffix not in AST_SUFFIXES:
        report.cover("lgpd-static:file", "1", "skipped", detail + ". Sem parser de destinos para a extensão.")
    elif gaps:
        detail += ". Cobertura parcial: " + ", ".join(f"{count} {reason}" for reason, count in sorted(gaps.items())) + "."
        report.cover("lgpd-static:file", "1", "failed", detail)
    else:
        report.cover("lgpd-static:file", "1", "ok", detail)
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
