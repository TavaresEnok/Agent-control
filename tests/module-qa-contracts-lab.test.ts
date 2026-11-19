import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {moduleCollectorArguments} from '../src/verification-modules.ts';

const fixture = fileURLToPath(new URL('./fixtures/module-qa-contratos/', import.meta.url));
const pinFile = new URL('../deploy/modules/qa/digest.txt', import.meta.url);

function collect(repo: string) {
  const [runtime, ...args] = moduleCollectorArguments({image: readFileSync(pinFile, 'utf8').trim(), repository: repo});
  const result = spawnSync(process.env.AC_CONTAINER_RUNTIME_BIN ?? runtime!, args, {
    encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return JSON.parse(result.stdout) as {
    coverage: {tool: string; version: string; status: string; detail: string}[];
    findings: {rule: string; file: string; evidence: string}[];
  };
}

test('imagem fixada mede OpenAPI e Pact na homologação offline', {skip: process.env.AC_MODULE_LAB !== '1'}, () => {
  const repo = mkdtempSync(join(tmpdir(), 'qa-contract-lab-'));
  try {
    cpSync(fixture, repo, {recursive: true});
    chmodSync(repo, 0o755);
    const control = collect(repo);
    assert.ok(control.coverage.some(row => row.tool === 'swagger-parser' && row.status === 'ok'));
    assert.ok(control.coverage.some(row => row.tool === 'qa-openapi-exemplos' && row.status === 'ok' &&
      /4\/4.*0 divergentes/.test(row.detail)));
    assert.ok(control.coverage.some(row => row.tool === 'qa-pact-interacoes' && row.status === 'ok' &&
      /2\/2.*0 divergentes/.test(row.detail)));
    assert.ok(control.coverage.some(row => /esperado 404, recebido 404.*conforme/.test(row.detail)));
    assert.ok(control.findings.every(finding => !/^QA-(?:PACT|OPENAPI)-/.test(finding.rule)));

    const provider = join(repo, 'provider.mjs');
    const source = readFileSync(provider, 'utf8');
    const defect = source.replace("404, {erro: 'produto-ausente'}", "500, {erro: 'FALHA-SINTETICA'}")
      .replace('total: a + b', 'total: a - b');
    assert.notEqual(defect, source);
    writeFileSync(provider, defect);
    const measured = collect(repo);
    assert.ok(measured.findings.some(finding => finding.rule === 'QA-OPENAPI-EXEMPLO-DIVERGENTE' &&
      finding.file === 'openapi.json' && /esperado 404, recebido 500/.test(finding.evidence)));
    assert.ok(measured.findings.some(finding => finding.rule === 'QA-PACT-RESPOSTA-DIVERGENTE' &&
      finding.file === 'pacts/catalogo.pact.json' && /interação 2.*recebido 200/.test(finding.evidence)));
    assert.doesNotMatch(JSON.stringify([control, measured]), /MARCA-SINTETICA|FALHA-SINTETICA|Consumidor Sintético|Provedor Sintético/);
  } finally {
    rmSync(repo, {recursive: true, force: true});
  }
});
