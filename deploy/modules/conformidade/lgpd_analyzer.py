"""Sinais estáticos de tratamento e reconhecimento de PII sem exportar valores."""

from bisect import bisect_right
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


def valid_cpf(value):
    digits = [int(character) for character in value if character in "0123456789"]
    if len(digits) != 11 or len(set(digits)) == 1:
        return False
    for size in (9, 10):
        check = sum(digit * weight for digit, weight in zip(digits[:size], range(size + 1, 1, -1)))
        if (check * 10 % 11) % 10 != digits[size]:
            return False
    return True


def inspect_fields(text, file, report):
    sources = observations = 0
    for number, line in enumerate(text.splitlines(), 1):
        if not FIELD.search(line):
            continue
        sources += 1
        destinations = [kind for kind, sink in SINKS if sink.search(line)]
        for kind in destinations:
            observations += 1
            report.find(
                "lgpd-static", "PII_POSSIBLE_" + kind, file, number, "media",
                "Possível tratamento de dado pessoal; confirmar a origem e o destino.",
                f"Identificador de dado pessoal e chamada da categoria {kind} na mesma linha.",
            )
        if not destinations:
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
    from presidio_analyzer.predefined_recognizers import EmailRecognizer

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
    analyzer = AnalyzerEngine(nlp_engine=engine, supported_languages=list(models))
    analyzer.registry.remove_recognizer("EmailRecognizer", language="en")
    analyzer.registry.add_recognizer(OfflineEmailRecognizer())
    for language in models:
        analyzer.registry.add_recognizer(CPFRecognizer(
            name="ChecksumBrazilCPF", supported_entity="BR_CPF", supported_language=language,
            patterns=[Pattern("CPF de 11 dígitos", CPF_PATTERN, 0.8)],
        ))
    return analyzer


def inspect_entities(analyzer, text, file, version, report):
    starts = [0] + [match.end() for match in re.finditer(r"\n", text)]
    entities = {}
    for language, requested in (("pt", ["BR_CPF", "PERSON"]), ("en", ["EMAIL_ADDRESS", "PHONE_NUMBER", "PERSON"])):
        for entity in analyzer.analyze(text=text, language=language, entities=requested, score_threshold=0.6):
            line = bisect_right(starts, entity.start)
            entities.setdefault((line, entity.entity_type), set()).add((entity.start, entity.end))
    for (line, kind), matches in sorted(entities.items()):
        report.find(
            "presidio-analyzer", "PII_" + kind, file, line, "media" if kind == "BR_CPF" else "baixa",
            "Possível dado pessoal presente no texto.",
            f"Entidade {kind}; ocorrências distintas na linha: {len(matches)}. Valor suprimido.",
        )
    report.cover("presidio-analyzer:file", version, "ok", f"{file} | português e inglês; tipos por linha={len(entities)}")
