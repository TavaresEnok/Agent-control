import test from 'node:test';
import assert from 'node:assert/strict';
import {collectorMeasuredDetailFile, type ModuleToolCoverage} from '../src/verification-modules.js';
import {CoverageRow} from '../src/verify-types.js';

const row = (tool: string, detail: string, status: ModuleToolCoverage['status'] = 'ok'): ModuleToolCoverage => ({tool, detail, status, version: '1'});

test('contratos reais de coletores identificam somente evidência positiva por arquivo', () => {
  for (const [tool, detail, expected] of [
    ['ast-complexity:file', 'arquivo=src/app.ts; loc=30; funcoes=2', 'src/app.ts'],
    ['ast-grep', 'arquivo=src/app.ts; achados=0', 'src/app.ts'],
    ['typedoc:file', 'arquivo=src/app.ts; simbolos=1; documentados=1', 'src/app.ts'],
    ['dependency-cruiser:file', 'arquivo=src/app.ts; deps=0; dependentes=0', 'src/app.ts'],
    ['hadolint:arquivo', 'Dockerfile: 0 achado(s).', 'Dockerfile'],
    ['trivy:arquivo', 'infra/main.tf: 0 achado(s) de configuração.', 'infra/main.tf'],
  ]) assert.equal(collectorMeasuredDetailFile(row(tool!, detail!)), expected);
  for (const item of [
    row('ast-grep', 'arquivo=src/a.ts; achados=0', 'skipped'),
    row('ast-grep', 'arquivo=src/a.ts; erro=indisponível'),
    row('other', 'arquivo=src/a.ts; achados=0'),
    row('ast-grep', 'arquivo=../secret; achados=0'),
    row('ast-grep', '2 arquivos analisados em src/a.ts'),
    row('lighthouse-ci:rota:/', 'arquivo=src/app.ts; score=100/100'),
    row('sbom-lockfile', 'arquivo=package.json; lockfile=ausente; achados=1'),
  ]) assert.equal(collectorMeasuredDetailFile(item), null);
});

test('cobertura automática não exige perfil fictício e perfis reais continuam aceitos', () => {
  const base = {file: 'src/app.ts', examinerProvider: 'ferramenta', examinerModel: 'ast-grep@1', checklist: ['ast-grep']};
  assert.equal(CoverageRow.parse({...base, profileId: null}).profileId, null);
  assert.equal(CoverageRow.parse({...base, profileId: '00000000-0000-4000-8000-000000000001'}).profileId, '00000000-0000-4000-8000-000000000001');
});
