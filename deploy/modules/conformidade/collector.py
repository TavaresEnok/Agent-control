"""Coleta offline de licenças e sinais de tratamento de dados pessoais."""

import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory

import lgpd_analyzer as lgpd
import license_policy
import ort_inventory

HERE = Path(__file__).resolve().parent
SCANCODE = "scancode-toolkit"
PRESIDIO = "presidio-analyzer"
SAFE_PATH = re.compile(r"[A-Za-z0-9._@+/\-]{1,400}", re.ASCII)
SAFE_EXPRESSION = re.compile(r"[A-Za-z0-9.+:()\- ]{1,512}", re.ASCII)
EXCLUDED = {".git", ".github", ".ai", "node_modules", ".venv", "__pycache__"}
EXCLUDED_LOWER = {".mcp.json", ".claude", ".husky", ".codex", ".grok"}
MAX_FILES = 1500
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_COVERAGE = 4999
MAX_FINDINGS = 999


class Report:
    def __init__(self):
        self.coverage = []
        self.dropped_coverage = 0
        self.has_errors = False
        self.findings = {level: [] for level in ("alta", "media", "baixa", "informativa")}
        self.finding_count = 0

    def cover(self, tool, version, status, detail):
        self.has_errors |= status == "failed"
        if len(self.coverage) == MAX_COVERAGE:
            self.dropped_coverage += 1
            return
        self.coverage.append(dict(tool=tool, version=version, status=status, detail=detail))

    def find(self, tool, rule, file, line, severity, message, evidence):
        self.finding_count += 1
        bucket = self.findings[severity]
        if len(bucket) < MAX_FINDINGS:
            bucket.append(dict(tool=tool, rule=rule, file=file, line=line, severity=severity,
                               message=message, evidence=evidence))

    def output(self):
        findings = [item for bucket in self.findings.values() for item in bucket][:MAX_FINDINGS]
        coverage = list(self.coverage)
        if self.dropped_coverage or self.finding_count > len(findings):
            self.has_errors = True
            coverage.append(dict(tool="conformidade:output", version="1", status="failed", detail=(
                f"Limite de saída: {self.dropped_coverage} linhas de cobertura e "
                f"{self.finding_count - len(findings)} achados omitidos."
            )))
        return dict(coverage=coverage, findings=findings)


def excluded(name):
    return name in EXCLUDED or name.startswith(".env") or name.lower() in EXCLUDED_LOWER


def snapshot(root, staging, report):
    selected = {}
    total = 0
    omitted = 0

    def walk_error(_error):
        report.cover("conformidade:snapshot", "1", "failed", "Diretório do repositório inacessível.")

    root_stat = root.lstat()
    if not stat.S_ISDIR(root_stat.st_mode):
        raise OSError("raiz inválida")
    for parent, directories, files in os.walk(root, onerror=walk_error):
        for name in sorted(directories):
            path = Path(parent, name)
            file = path.relative_to(root).as_posix()
            if excluded(name) or path.is_symlink() or not SAFE_PATH.fullmatch(file):
                directories.remove(name)
                reason = "diretório excluído, link ou caminho incompatível"
                report.cover("conformidade:file", "1", "skipped", f"{file} | {reason}" if SAFE_PATH.fullmatch(file) else reason)
        directories.sort()
        for name in sorted(files):
            source = Path(parent, name)
            file = source.relative_to(root).as_posix()
            if not SAFE_PATH.fullmatch(file) or excluded(name):
                report.cover("conformidade:file", "1", "skipped", "Arquivo excluído ou com caminho incompatível.")
                continue
            if len(selected) >= MAX_FILES:
                omitted += 1
                continue
            try:
                info = source.lstat()
                if not stat.S_ISREG(info.st_mode):
                    report.cover("conformidade:file", "1", "skipped", f"{file} | entrada não regular")
                    continue
                limit = min(MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES - total)
                if info.st_size > limit:
                    report.cover("conformidade:file", "1", "skipped", f"{file} | limite de bytes do recorte")
                    continue
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                with os.fdopen(os.open(source, flags), "rb") as stream:
                    if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                        raise OSError("entrada alterada")
                    data = stream.read(limit + 1)
                if len(data) > limit:
                    report.cover("conformidade:file", "1", "skipped", f"{file} | limite de bytes do recorte")
                    continue
                target = staging / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                selected[file] = target
                total += len(data)
            except OSError:
                report.cover("conformidade:file", "1", "failed", f"{file} | leitura ou cópia falhou")
    if omitted:
        report.cover("conformidade:snapshot", "1", "skipped", f"{omitted} arquivos fora do limite de {MAX_FILES}.")
    report.cover("conformidade:snapshot", "1", "ok" if selected else "skipped",
                 f"{len(selected)} arquivos regulares copiados para /tmp; {total} bytes.")
    return selected


def add_scancode_results(data, selected, version, report):
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        raise ValueError("estrutura de saída ScanCode")
    measured = set()
    scan_errors = False
    for row in data["files"]:
        if row.get("type") != "file":
            continue
        file = row.get("path")
        if file not in selected or file in measured:
            raise ValueError("arquivo inesperado na saída ScanCode")
        measured.add(file)
        if row.get("scan_errors"):
            scan_errors = True
            report.cover(SCANCODE + ":file", version, "failed", f"{file} | erro no exame")
            continue
        detections = row.get("license_detections", [])
        packages = row.get("package_data", [])
        report.cover(SCANCODE + ":file", version, "ok",
                     f"{file} | detecções de licença={len(detections)}, metadados de pacote={len(packages)}")
        for detection in detections:
            expression = detection.get("license_expression_spdx")
            if not isinstance(expression, str) or not SAFE_EXPRESSION.fullmatch(expression):
                continue
            lines = {match["start_line"] for match in detection.get("matches", [])
                     if type(match.get("start_line")) is int and 1 <= match["start_line"] <= 10_000_000}
            for line in sorted(lines):
                report.find(SCANCODE, "LICENSE_DETECTED", file, line, "informativa",
                            "Identificador de licença reconhecido no arquivo.", f"Expressão SPDX: {expression}.")
        for package in packages:
            expression = package.get("declared_license_expression_spdx")
            if isinstance(expression, str) and SAFE_EXPRESSION.fullmatch(expression):
                report.find(SCANCODE, "LICENSE_DECLARED", file, 1, "informativa",
                            "Licença declarada em metadados de pacote.", f"Expressão SPDX: {expression}.")
    for file in sorted(selected.keys() - measured):
        report.cover(SCANCODE + ":file", version, "skipped", f"{file} | sem registro de arquivo na saída")
    return len(measured), scan_errors or any(header.get("errors") for header in data.get("headers", []))


def scan_licenses(staging, selected, version, report):
    if not selected:
        report.cover(SCANCODE, version, "skipped", "Nenhum arquivo elegível.")
        return
    result_file = staging.parent / "scancode.json"
    command = [str(Path(sys.executable).parent / "scancode"), "--license", "--package",
               "--no-check-version", "--strip-root", "--processes", "1", "--timeout", "20", "--quiet",
               "--json-pp", str(result_file), str(staging)]
    result = subprocess.run(command, cwd=staging.parent, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL, timeout=300, check=False)
    if not result_file.is_file():
        report.cover(SCANCODE, version, "failed", f"Sem saída JSON ScanCode; código {result.returncode}.")
        return
    with result_file.open(encoding="utf-8") as stream:
        measured, errors = add_scancode_results(json.load(stream), selected, version, report)
    status = "failed" if result.returncode or errors or not measured else "ok"
    report.cover(SCANCODE, version, status, f"Licenças e pacotes: {measured}/{len(selected)} registros de arquivo; código {result.returncode}.")


def inspect_npm(selected, declarations, report):
    eligible = 0
    errors = 0
    for file, path in selected.items():
        if path.name not in {"package-lock.json", "npm-shrinkwrap.json"}:
            continue
        try:
            project_license = None
            manifest = path.with_name("package.json")
            if manifest.is_file():
                metadata = json.loads(manifest.read_text(encoding="utf-8-sig"))
                if not isinstance(metadata, dict):
                    raise ValueError("manifesto")
                project_license = metadata.get("license")
            found = license_policy.inspect_lock(path.read_text(encoding="utf-8-sig"), project_license, file, report)
            if found is not None:
                eligible += 1
                declarations.append((file, found))
        except (ValueError, OSError, RecursionError):
            errors += 1
            report.cover(license_policy.TOOL + ":file", license_policy.VERSION, "failed", f"{file} | metadados inválidos ou inacessíveis")
    status = "failed" if errors else ("ok" if eligible else "skipped")
    report.cover(license_policy.TOOL, license_policy.VERSION, status,
                 f"Lockfiles npm v2/v3 classificados: {eligible}; erros: {errors}. Licenças ausentes permanecem desconhecidas.")


def inspect_privacy(selected, version, report):
    texts = []
    static_count = 0
    for file, path in selected.items():
        if path.suffix.lower() not in lgpd.TEXT_SUFFIXES:
            continue
        try:
            if path.stat().st_size > lgpd.MAX_TEXT_BYTES:
                report.cover("lgpd:file", "1", "skipped", f"{file} | acima do limite de texto")
                continue
            text = path.read_text(encoding="utf-8-sig")
            if "\0" in text:
                raise ValueError("NUL")
        except (UnicodeError, ValueError):
            report.cover("lgpd:file", "1", "skipped", f"{file} | conteúdo fora do recorte UTF-8")
            continue
        texts.append((file, text))
        if path.suffix.lower() in lgpd.CODE_SUFFIXES:
            lgpd.inspect_fields(text, file, report)
            static_count += 1
    report.cover("lgpd-static", "1", "ok" if static_count else "skipped",
                 f"{static_count} arquivos de código/config examinados por indícios sintáticos de origem e destino.")

    if not texts:
        report.cover(PRESIDIO, version, "skipped", "Nenhum texto com extensão, codificação e tamanho elegíveis.")
        return
    analyzer = lgpd.create_presidio()
    errors = 0
    for file, text in texts:
        try:
            lgpd.inspect_entities(analyzer, text, file, version, report)
        except Exception as error:
            errors += 1
            report.cover(PRESIDIO + ":file", version, "failed", f"{file} | exame falhou ({type(error).__name__})")
    report.cover(PRESIDIO, version, "failed" if errors else "ok",
                 f"{len(texts) - errors}/{len(texts)} textos examinados (CPF, e-mail, telefone, pessoa).")


def attempt(report, tool, version, operation, *args):
    try:
        operation(*args)
    except Exception as error:
        report.cover(tool, version, "failed", f"Coleta interrompida ({type(error).__name__}).")


def collect(root, report):
    versions = {item["name"]: item["version"] for item in json.loads(
        (HERE / "tools.lock.json").read_text(encoding="utf-8")
    )["tools"]}
    with TemporaryDirectory(prefix="conformidade-") as scratch:
        staging = Path(scratch) / "input"
        staging.mkdir()
        selected = snapshot(root, staging, report)
        attempt(report, SCANCODE, versions[SCANCODE], scan_licenses, staging, selected, versions[SCANCODE], report)
        declarations = []
        attempt(report, license_policy.TOOL, license_policy.VERSION, inspect_npm, selected, declarations, report)
        attempt(report, ort_inventory.TOOL, versions[ort_inventory.TOOL], ort_inventory.scan,
                declarations, staging.parent, versions[ort_inventory.TOOL], report)
        attempt(report, PRESIDIO, versions[PRESIDIO], inspect_privacy, selected, versions[PRESIDIO], report)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    args = parser.parse_args()
    report = Report()
    # All library and subprocess diagnostics stay off the JSON channel.
    with redirect_stdout(sys.stderr):
        attempt(report, "conformidade", "1", collect, args.repo, report)
    print(json.dumps(report.output(), ensure_ascii=True))
    return int(report.has_errors)


if __name__ == "__main__":
    sys.exit(main())
