"""Importa declarações npm no ORT com uma entrada SPDX gerada e limitada."""

from collections import Counter
from hashlib import sha256
import json
import os
import subprocess

from license_policy import classify

TOOL = "ort"
ORT_BIN = "/opt/ort/bin/ort"
MAX_PACKAGES = 500


def write_documents(locks, input_dir, version, report):
    picked = {}
    for document_number, (file, declared) in enumerate(locks, 1):
        capacity = MAX_PACKAGES - len(picked)
        if len(declared) > capacity:
            report.cover(TOOL + ":file", version, "skipped",
                         f"{file} | {len(declared) - capacity} declarações além do limite ORT.")
        entries = declared[:capacity]
        if not entries:
            continue
        packages = []
        relationships = []
        root = f"lock-{document_number}"

        def package(name, expression):
            return {
                "SPDXID": f"SPDXRef-{name}", "name": name, "versionInfo": "1",
                "downloadLocation": "NOASSERTION", "filesAnalyzed": False,
                "licenseDeclared": expression, "licenseConcluded": "NOASSERTION",
                "copyrightText": "NOASSERTION",
            }

        packages.append(package(root, "NOASSERTION"))
        for number, (_, expression, line) in enumerate(entries, 1):
            component = f"component-{document_number}-{number}"
            packages.append(package(component, expression))
            relationships.append({
                "spdxElementId": f"SPDXRef-{root}", "relationshipType": "DEPENDS_ON",
                "relatedSpdxElement": f"SPDXRef-{component}",
            })
            picked[f"SpdxDocumentFile::{component}:1"] = (file, line)
        document = {
            "SPDXID": "SPDXRef-DOCUMENT", "spdxVersion": "SPDX-2.3",
            "creationInfo": {"created": "2024-01-01T00:00:00Z", "creators": ["Tool: conformidade"]},
            "name": root, "dataLicense": "CC0-1.0",
            "documentNamespace": "https://example.invalid/c9/" + sha256(file.encode()).hexdigest(),
            "documentDescribes": [f"SPDXRef-{root}"],
            "packages": packages, "relationships": relationships,
        }
        (input_dir / (root + ".spdx.json")).write_text(json.dumps(document), encoding="utf-8")
    return picked


def read_results(result, picked, version, report, measured_files=None):
    observed = Counter(file for file, _ in picked.values())
    classified = Counter()
    seen = set()
    for package in result["packages"]:
        coordinate = package["id"]
        if coordinate not in picked or coordinate in seen:
            raise ValueError("pacote inesperado na saída ORT")
        seen.add(coordinate)
    finding_files = set()
    for package in result["packages"]:
        file, line = picked[package["id"]]
        expression = (package.get("declared_licenses_processed") or {}).get("spdx_expression")
        category, normalized = classify(expression)
        if not normalized:
            continue
        classified[file] += 1
        if category == "copyleft forte":
            finding_files.add(file)
            report.find(
                TOOL, "ORT_STRONG_COPYLEFT_DECLARED", file, line, "informativa",
                "ORT classificou declaração SPDX de copyleft forte no inventário.",
                f"ORT processou a declaração em packages como {normalized}.",
            )
    for file, count in observed.items():
        report.cover(TOOL + ":file", version, "ok" if classified[file] == count else "failed",
                     f"{file} | {classified[file]}/{count} declarações SPDX processadas no ORT.")
    if measured_files is not None:
        for file, count in observed.items():
            if classified[file] == count or (classified[file] > 0 and file in finding_files):
                measured_files.append(file)
    return len(seen), sum(classified.values())


def scan(locks, scratch, version, report):
    input_dir = scratch / "ort-input"
    input_dir.mkdir()
    picked = write_documents(locks, input_dir, version, report)
    if not picked:
        report.cover(TOOL, version, "skipped", "Nenhuma declaração SPDX elegível em lockfile npm.")
        return
    config = scratch / "ort-config.yml"
    config.write_text(
        "ort:\n  enableRepositoryPackageCurations: false\n  packageCurationProviders: []\n"
        "  analyzer:\n    enabledPackageManagers: [SpdxDocumentFile]\n",
        encoding="utf-8",
    )
    output = scratch / "ort-output"
    data = scratch / "ort-data"
    data.mkdir()
    env = {**os.environ, "JAVA_HOME": "/opt/java/openjdk", "ORT_DATA_DIR": str(data),
           "JAVA_OPTS": "-Xmx768m -XX:ActiveProcessorCount=2 -Djava.io.tmpdir=/tmp"}
    command = [ORT_BIN, "--config", str(config), "analyze",
               "--input-dir", str(input_dir), "--output-dir", str(output), "--output-formats", "JSON"]
    process = subprocess.run(command, env=env, cwd=scratch, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, timeout=180, check=False)
    result_file = output / "analyzer-result.json"
    if not result_file.is_file():
        report.cover(TOOL, version, "failed", f"Sem saída JSON ORT; código {process.returncode}.")
        return
    result = json.loads(result_file.read_text(encoding="utf-8"))["analyzer"]["result"]
    measured_files = []
    seen, classified = read_results(result, picked, version, report, measured_files=measured_files)
    status = "failed" if process.returncode or classified != len(picked) else "ok"
    detail = (
        f"{seen} pacotes importados; {classified}/{len(picked)} licenças processadas; "
        f"código {process.returncode}. Inventário SPDX gerado dos lockfiles, sem resolução de dependências."
    )
    if status == "ok":
        report.cover(TOOL, version, "ok", detail, files=measured_files)
    else:
        report.cover(TOOL, version, "failed", detail)
        if measured_files:
            report.cover(
                TOOL, version, "ok",
                f"Declarações SPDX processadas pelo ORT em {len(measured_files)}/{len({file for file, _ in picked.values()})} lockfile(s); falhas ou declarações não processadas permanecem registradas.",
                files=measured_files,
            )
