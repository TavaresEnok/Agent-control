"""Coleta offline de licenças e sinais de tratamento de dados pessoais."""

import argparse
from contextlib import redirect_stderr, redirect_stdout
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
from license_policy import (
    EXCLUDED_DIRS_AND_FILES as EXCLUDED,
    EXCLUDED_LOWER,
    SAFE_PATH,
    is_protected_component,
    is_redacted_text,
    is_sensitive_path,
    sanitize_report_text,
)
import ort_inventory

HERE = Path(__file__).resolve().parent
SCANCODE = "scancode-toolkit"
PRESIDIO = "presidio-analyzer"
SAFE_EXPRESSION = re.compile(r"[A-Za-z0-9.+:()\- ]{1,512}", re.ASCII)
MAX_FILES = 1500
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
MAX_COVERAGE = 4999
MAX_FILE_COVERAGE = MAX_COVERAGE - 49
MAX_FINDINGS = 999


class Report:
    def __init__(self):
        self.coverage = []
        self._evidence_rows = {}
        self._enforce_tool_coverage = False
        self.dropped_coverage = 0
        self.has_errors = False
        self.findings = {level: [] for level in ("alta", "media", "baixa", "informativa")}
        self.finding_count = 0

    def cover(self, tool, version, status, detail, files=None, require_findings=False):
        self.has_errors |= status == "failed"
        limit = MAX_FILE_COVERAGE if tool.endswith(":file") else MAX_COVERAGE
        if len(self.coverage) >= limit:
            self.dropped_coverage += 1
            self.has_errors = True
            return
        row = dict(tool=tool, version=version, status=status, detail=sanitize_report_text(detail))
        if files is not None:
            row["files"] = sorted(dict.fromkeys(file for file in files if not is_sensitive_path(file)))
        if require_findings:
            self._evidence_rows[len(self.coverage)] = row["detail"]
        self.coverage.append(row)

    def find(self, tool, rule, file, line, severity, message, evidence):
        if is_sensitive_path(file):
            self.cover(f"{tool}:file", "1", "skipped", "Arquivo excluído, protegido ou com caminho incompatível.")
            return
        self.finding_count += 1
        if self.finding_count > MAX_FINDINGS:
            self.has_errors = True
        bucket = self.findings[severity]
        if len(bucket) < MAX_FINDINGS:
            bucket.append(dict(
                tool=tool,
                rule=rule,
                file=file,
                line=line,
                severity=severity,
                message=sanitize_report_text(message),
                evidence=sanitize_report_text(evidence),
            ))

    def output(self):
        tools_with_rows = {row["tool"] for row in self.coverage}
        covered_all_tools = {row["tool"] for row in self.coverage if row["status"] == "ok" and "files" not in row}
        covered_pairs = {
            (row["tool"], file)
            for row in self.coverage
            if row["status"] == "ok" and "files" in row
            for file in row["files"]
        }
        enforce_all = bool(self.dropped_coverage or self._enforce_tool_coverage)

        def is_covered(item):
            tool = item["tool"]
            if not enforce_all and tool not in tools_with_rows:
                return True
            return tool in covered_all_tools or (tool, item["file"]) in covered_pairs

        candidates = [item for bucket in self.findings.values() for item in bucket]
        eligible = [item for item in candidates if is_covered(item)]
        if len(eligible) < len(candidates):
            self.has_errors = True
        findings = eligible[:MAX_FINDINGS]
        published_files = {(item["tool"], item["file"]) for item in findings}
        coverage = []
        for index, row in enumerate(self.coverage):
            template = self._evidence_rows.get(index)
            if template is not None:
                kept = [file for file in row.get("files", ()) if (row["tool"], file) in published_files]
                if not kept:
                    continue
                coverage.append({**row, "detail": template.replace("{count}", str(len(kept))), "files": kept})
            else:
                coverage.append(row)
        if self.dropped_coverage or self.finding_count > len(findings):
            self.has_errors = True
            coverage.append(dict(tool="conformidade:output", version="1", status="failed", detail=(
                f"Limite de saída: {self.dropped_coverage} linhas de cobertura e "
                f"{self.finding_count - len(findings)} achados omitidos."
            )))
        return dict(coverage=coverage, findings=findings)


def excluded(name):
    return is_protected_component(name)


def snapshot(root, staging, report):
    report._enforce_tool_coverage = True
    selected = {}
    total = 0
    omitted = 0
    omitted_protected = 0

    def walk_error(_error):
        report.cover("conformidade:snapshot", "1", "failed", "Diretório do repositório inacessível.")

    root_stat = root.lstat()
    if not stat.S_ISDIR(root_stat.st_mode):
        raise OSError("raiz inválida")
    for parent, directories, files in os.walk(root, onerror=walk_error):
        for name in sorted(directories):
            path = Path(parent, name)
            file = path.relative_to(root).as_posix()
            sensitive = is_protected_component(name) or is_sensitive_path(file)
            if sensitive or path.is_symlink() or not SAFE_PATH.fullmatch(file):
                directories.remove(name)
                omitted_protected += 1
        directories.sort()
        for name in sorted(files):
            source = Path(parent, name)
            file = source.relative_to(root).as_posix()
            if not SAFE_PATH.fullmatch(file) or is_protected_component(name) or is_sensitive_path(file):
                omitted_protected += 1
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
    if omitted_protected:
        report.cover("conformidade:file", "1", "skipped", f"{omitted_protected} entradas excluídas ou protegidas omitidas.")
    snapshot_detail = f"{len(selected)} arquivos regulares copiados para /tmp; {total} bytes."
    if omitted_protected:
        snapshot_detail += f" {omitted_protected} entradas excluídas ou protegidas omitidas."
    report.cover("conformidade:snapshot", "1", "ok" if selected else "skipped", snapshot_detail)
    return selected


def add_scancode_results(data, selected, version, report, ok_files=None):
    if not isinstance(data, dict) or not isinstance(data.get("files"), list):
        raise ValueError("estrutura de saída ScanCode")
    measured = set()
    for row in data["files"]:
        if row.get("type") != "file":
            continue
        file = row.get("path")
        if file not in selected or file in measured:
            raise ValueError("arquivo inesperado na saída ScanCode")
        measured.add(file)
    scan_errors = False
    suppressed = 0
    for row in data["files"]:
        if row.get("type") != "file":
            continue
        file = row.get("path")
        if is_sensitive_path(file):
            report.cover(SCANCODE + ":file", version, "skipped", "Arquivo excluído, protegido ou com caminho incompatível.")
            continue
        if row.get("scan_errors"):
            scan_errors = True
            report.cover(SCANCODE + ":file", version, "failed", f"{file} | erro no exame")
            continue
        if ok_files is not None:
            ok_files.append(file)
        detections = row.get("license_detections", [])
        packages = row.get("package_data", [])
        report.cover(SCANCODE + ":file", version, "ok",
                     f"{file} | detecções de licença={len(detections)}, metadados de pacote={len(packages)}")
        for detection in detections:
            expression = detection.get("license_expression_spdx")
            if not isinstance(expression, str) or not SAFE_EXPRESSION.fullmatch(expression) or is_redacted_text(expression):
                suppressed += 1
                continue
            lines = {match["start_line"] for match in detection.get("matches", [])
                     if type(match.get("start_line")) is int and 1 <= match["start_line"] <= 10_000_000}
            for line in sorted(lines):
                report.find(SCANCODE, "LICENSE_DETECTED", file, line, "informativa",
                            "Identificador de licença reconhecido no arquivo.", f"Expressão SPDX: {expression}.")
        for package in packages:
            expression = package.get("declared_license_expression_spdx")
            if isinstance(expression, str) and SAFE_EXPRESSION.fullmatch(expression) and not is_redacted_text(expression):
                report.find(SCANCODE, "LICENSE_DECLARED", file, 1, "informativa",
                            "Licença declarada em metadados de pacote.", f"Expressão SPDX: {expression}.")
            elif expression is not None:
                suppressed += 1
    for file in sorted(selected.keys() - measured):
        if is_sensitive_path(file):
            report.cover(SCANCODE + ":file", version, "skipped", "Arquivo excluído, protegido ou com caminho incompatível.")
        else:
            report.cover(SCANCODE + ":file", version, "skipped", f"{file} | sem registro de arquivo na saída")
    if suppressed:
        report.cover(SCANCODE, version, "skipped", f"{suppressed} expressões de licença omitidas por segurança ou formato.")
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
    ok_files = []
    with result_file.open(encoding="utf-8") as stream:
        measured, errors = add_scancode_results(json.load(stream), selected, version, report, ok_files=ok_files)
    status = "failed" if result.returncode or errors or not measured else "ok"
    detail = f"Licenças e pacotes: {measured}/{len(selected)} registros de arquivo; código {result.returncode}."
    if status == "ok":
        report.cover(SCANCODE, version, "ok", detail, files=ok_files)
    else:
        report.cover(SCANCODE, version, "failed", detail)
        if ok_files:
            report.cover(
                SCANCODE, version, "ok",
                f"Licenças e pacotes medidos sem erro de exame em {len(ok_files)}/{len(selected)} arquivo(s); falhas e omissões permanecem registradas.",
                files=ok_files,
            )


def inspect_npm(selected, declarations, report):
    eligible = 0
    errors = 0
    eligible_files = []
    for file, path in selected.items():
        if path.name not in {"package-lock.json", "npm-shrinkwrap.json"}:
            continue
        if is_sensitive_path(file):
            report.cover(license_policy.TOOL + ":file", license_policy.VERSION, "skipped",
                         "Arquivo excluído, protegido ou com caminho incompatível.")
            continue
        try:
            project_license = None
            project_origin = None
            manifest = path.with_name("package.json")
            if manifest.is_file() and not manifest.is_symlink():
                manifest_text = manifest.read_text(encoding="utf-8-sig")
                metadata = json.loads(manifest_text)
                if not isinstance(metadata, dict):
                    raise ValueError("manifesto")
                project_license = metadata.get("license")
                if project_license is not None:
                    offset, _ = license_policy.object_locations(manifest_text)["license"]
                    origin_file = Path(file).with_name("package.json").as_posix()
                    if not is_sensitive_path(origin_file):
                        project_origin = (origin_file, license_policy.source_line(manifest_text, offset))
            found = license_policy.inspect_lock(path.read_text(encoding="utf-8-sig"), project_license, file, report,
                                                project_origin=project_origin)
            if found is not None:
                eligible += 1
                eligible_files.append(file)
                declarations.append((file, found))
        except (ValueError, OSError, RecursionError):
            errors += 1
            report.cover(license_policy.TOOL + ":file", license_policy.VERSION, "failed", f"{file} | metadados inválidos ou inacessíveis")
    status = "failed" if errors else ("ok" if eligible else "skipped")
    detail = f"Lockfiles npm v2/v3 classificados: {eligible}; erros: {errors}. Licenças ausentes permanecem desconhecidas."
    if status == "ok":
        report.cover(license_policy.TOOL, license_policy.VERSION, "ok", detail, files=eligible_files)
    else:
        report.cover(license_policy.TOOL, license_policy.VERSION, status, detail)
        if errors and eligible_files:
            report.cover(
                license_policy.TOOL, license_policy.VERSION, "ok",
                f"Lockfiles npm v2/v3 classificados em {len(eligible_files)} arquivo(s); falhas de leitura ou formato permanecem registradas.",
                files=eligible_files,
            )


def inspect_privacy(selected, version, report):
    texts = []
    static_count = static_errors = 0
    for file, path in selected.items():
        if is_sensitive_path(file):
            report.cover("lgpd:file", "1", "skipped", "Arquivo excluído, protegido ou com caminho incompatível.")
            continue
        if path.suffix.lower() not in lgpd.TEXT_SUFFIXES:
            report.cover("lgpd:file", "1", "skipped", f"{file} | extensão fora do recorte de privacidade")
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
        except OSError:
            report.cover("lgpd:file", "1", "failed", f"{file} | leitura do texto falhou")
            continue
        texts.append((file, text))
    parsed = lgpd.javascript_destinations(texts)
    static_ok_files = []
    static_partial_finding_files = []
    for file, text in texts:
        suffix = Path(file).suffix.lower()
        if suffix in lgpd.CODE_SUFFIXES:
            before_findings = report.finding_count
            ok = lgpd.inspect_fields(text, file, report, parsed.get(file))
            static_errors += not ok
            static_count += suffix in lgpd.AST_SUFFIXES
            if suffix in lgpd.AST_SUFFIXES and ok:
                static_ok_files.append(file)
            elif report.finding_count > before_findings:
                static_partial_finding_files.append(file)
        else:
            report.cover("lgpd-static:file", "1", "skipped", f"{file} | texto fora do recorte estático de código/config")
    static_status = "failed" if static_errors else ("ok" if static_count else "skipped")
    static_detail = (
        f"{static_count} arquivos JS/TS/Python examinados, {static_errors} com cobertura parcial. "
        "AST: vínculos simples, sem fluxo entre funções, análise de ramos ou chaves dinâmicas. "
        "SQL: parâmetros vinculados a valores de INSERT/UPDATE literal no recorte. "
        "Outras extensões de código/config: inventário textual de campos."
    )
    if static_status == "ok":
        report.cover("lgpd-static", "1", "ok", static_detail, files=static_ok_files)
    else:
        report.cover("lgpd-static", "1", static_status, static_detail)
        if static_ok_files:
            report.cover(
                "lgpd-static", "1", "ok",
                f"Análise estática AST e inventário textual concluídos sem lacunas em {len(static_ok_files)} arquivo(s).",
                files=static_ok_files,
            )
    if static_partial_finding_files:
        report.cover(
            "lgpd-static", "1", "ok",
            "Evidências locais (vínculos AST comprovados ou inventário textual de campos) confirmadas em {count} arquivo(s) com escopo parcial; trechos sem vínculo ou sem parser permanecem em falha ou pulados.",
            files=static_partial_finding_files,
            require_findings=True,
        )

    if not texts:
        report.cover(PRESIDIO, version, "skipped", "Nenhum texto com extensão, codificação e tamanho elegíveis.")
        return
    errors = 0
    presidio_ok_files = []
    presidio_partial_finding_files = []
    with lgpd.presidio_diagnostics() as diagnostics:
        try:
            analyzer = lgpd.create_presidio()
        except Exception:
            for file, _ in texts:
                report.cover(PRESIDIO + ":file", version, "failed", f"{file} | analisador indisponível")
            report.cover(PRESIDIO, version, "failed", "Falha ao inicializar o analisador.")
            return
        for file, text in texts:
            before_findings = report.finding_count
            try:
                ok = lgpd.inspect_entities(analyzer, text, file, version, report, diagnostics)
                errors += not ok
                if ok:
                    presidio_ok_files.append(file)
                elif report.finding_count > before_findings:
                    presidio_partial_finding_files.append(file)
            except Exception:
                errors += 1
                report.cover(PRESIDIO + ":file", version, "failed", f"{file} | exame interrompido")
    summary_detail = f"{len(texts) - errors}/{len(texts)} textos examinados (CPF, e-mail, telefone, pessoa)."
    if not errors:
        report.cover(PRESIDIO, version, "ok", summary_detail, files=presidio_ok_files)
    else:
        report.cover(PRESIDIO, version, "failed", summary_detail)
        if presidio_ok_files:
            report.cover(
                PRESIDIO, version, "ok",
                f"Exame completo de entidades (CPF, e-mail, telefone, pessoa) em {len(presidio_ok_files)}/{len(texts)} texto(s).",
                files=presidio_ok_files,
            )
        if presidio_partial_finding_files:
            report.cover(
                PRESIDIO, version, "ok",
                "Entidades reconhecidas em {count} texto(s) com tempo limite parcial em outro padrão; o padrão interrompido permanece em falha.",
                files=presidio_partial_finding_files,
                require_findings=True,
            )


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
    # Libraries can include source text in warnings and tracebacks.
    with open(os.devnull, "w") as sink, redirect_stdout(sink), redirect_stderr(sink):
        attempt(report, "conformidade", "1", collect, args.repo, report)
    print(json.dumps(report.output(), ensure_ascii=True))
    return int(report.has_errors)


if __name__ == "__main__":
    sys.exit(main())
