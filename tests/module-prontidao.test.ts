import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {auditRepositoryReadiness, collectRepoFiles, parseComposeServices, redactEvidence} from '../deploy/modules/prontidao/audit-readiness.mjs';
import {
  parseGitleaksJson,
  parseHadolintJson,
  parseTestsslJson,
  parseTrivyConfigJson,
  runCollector,
  validateTargetUrl,
} from '../deploy/modules/prontidao/run-collector.mjs';

const moduleDir = fileURLToPath(new URL('../deploy/modules/prontidao/', import.meta.url));
const defectiveDir = fileURLToPath(new URL('./fixtures/module-prontidao/defective', import.meta.url));
const cleanDir = fileURLToPath(new URL('./fixtures/module-prontidao/clean', import.meta.url));

const VALID_SEVERITIES = new Set(['alta', 'media', 'baixa', 'informativa']);
const VALID_STATUSES = new Set(['ok', 'failed', 'skipped']);

test('tools.lock.json e Dockerfile fixam versões, digests e usuário sem privilégio', () => {
  const lock = JSON.parse(readFileSync(join(moduleDir, 'tools.lock.json'), 'utf8')) as {
    baseImage: {digest: string; platformDigest: string};
    tools: {name: string; version: string; license: string; url: string; sha256: string}[];
  };
  assert.match(lock.baseImage.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(lock.baseImage.platformDigest, /^sha256:[a-f0-9]{64}$/);
  const names = new Set(lock.tools.map(t => t.name));
  for (const required of ['testssl.sh', 'gitleaks', 'hadolint', 'trivy']) {
    assert.equal(names.has(required), true, `ferramenta ausente no lockfile: ${required}`);
  }
  for (const tool of lock.tools) {
    assert.ok(tool.version.length > 0);
    assert.ok(tool.license.length > 0);
    assert.match(tool.url, /^https:\/\//);
    assert.match(tool.sha256, /^[a-f0-9]{64}$/);
  }

  const dockerfile = readFileSync(join(moduleDir, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM\s+(?:--platform=linux\/amd64\s+)?node@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(dockerfile, /:latest\b/);
  assert.match(dockerfile, /USER\s+65532:65532/);
  assert.match(dockerfile, /ENTRYPOINT\s+\["\/usr\/local\/bin\/prontidao-entrypoint\.sh"\]/);

  const entrypoint = readFileSync(join(moduleDir, 'entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /unset\s+"\$name"/);
  assert.match(entrypoint, /\*\.\.\*/);
  assert.match(entrypoint, /\*\.sock\*/);
  assert.match(entrypoint, /PRONTIDAO_SOCKET_FORBIDDEN/);
  assert.match(entrypoint, /export HOME=\/tmp/);
});

test('auditRepositoryReadiness detecta todos os defeitos plantados e mascara segredos', () => {
  const res = auditRepositoryReadiness(defectiveDir);
  assert.ok(res.filesAnalyzed >= 6);
  const rules = new Set(res.findings.map(f => f.rule));
  for (const expected of [
    'PRONTIDAO-TLS-DESATIVADO',
    'PRONTIDAO-CABECALHO-HSTS-AUSENTE',
    'PRONTIDAO-TLS-VERIFICACAO-DESABILITADA',
    'PRONTIDAO-BACKUP-AUSENTE',
    'PRONTIDAO-PROVA-RESTAURACAO-AUSENTE',
    'PRONTIDAO-LOG-SEM-ROTACAO',
    'PRONTIDAO-ALERTA-AUSENTE',
    'PRONTIDAO-REINICIO-AUTOMATICO-AUSENTE',
    'PRONTIDAO-HEALTHCHECK-COMPOSE-AUSENTE',
    'PRONTIDAO-SYSTEMD-REINICIO-AUSENTE',
    'PRONTIDAO-LIMITE-MEMORIA-AUSENTE',
    'PRONTIDAO-LIMITE-PIDS-AUSENTE',
    'PRONTIDAO-SYSTEMD-MEMORIA-AUSENTE',
    'PRONTIDAO-DISCO-SEM-MONITORAMENTO',
    'PRONTIDAO-SEGREDO-ARQUIVO-ENV',
    'PRONTIDAO-SEGREDO-COMPOSE-INLINE',
    'PRONTIDAO-SEGREDO-SYSTEMD-INLINE',
  ]) {
    assert.equal(rules.has(expected), true, `regra ausente nos achados: ${expected}`);
  }

  const serialized = JSON.stringify(res);
  for (const secret of [
    'lab-defective-db-pass-98765',
    'lab-defective-systemd-secret-12345',
    'synthetic-lab-key-9f8e7d6c5b4a3210fedcba9876543210',
    'synthetic_db_pass_987654321',
  ]) {
    assert.equal(serialized.includes(secret), false, 'segredo bruto vazou na saída');
  }

  for (const f of res.findings) {
    assert.equal(VALID_SEVERITIES.has(f.severity), true);
    assert.equal(Number.isInteger(f.line) && f.line >= 1, true);
    assert.equal(f.file.startsWith('/') || f.file.includes('..'), false);
  }
  assert.ok(res.coverage.some(c => c.tool === 'prontidao-audit' && c.status === 'ok'));
  assert.equal(res.coverage.filter(c => c.tool.startsWith('prontidao:requisito:')).length, 6);
  assert.ok(res.coverage.some(c => c.tool === 'prontidao:arquivo'));
});

test('auditRepositoryReadiness não acusa defeitos no controle limpo', () => {
  const res = auditRepositoryReadiness(cleanDir);
  assert.deepEqual(res.findings, []);
  assert.ok(res.filesAnalyzed >= 10);
  const reqRows = res.coverage.filter(c => c.tool.startsWith('prontidao:requisito:'));
  assert.equal(reqRows.length, 6);
  for (const row of reqRows) {
    assert.equal(row.status, 'ok');
    assert.match(row.detail, /0 achado\(s\)/);
  }
});

test('collectRepoFiles ignora symlinks e parseComposeServices preserva linhas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-symlink-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'ok.ts'), 'export const ok = true;\n');
    symlinkSync('/etc/passwd', join(dir, 'src', 'leak.txt'));
    const files = collectRepoFiles(dir);
    assert.deepEqual(files.map(f => f.rel), ['src/ok.ts']);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }

  const services = parseComposeServices(
    'services:\n  api:\n    image: node:22\n    restart: unless-stopped\n    mem_limit: 512m\n    pids_limit: 64\n    healthcheck:\n      test: ["CMD", "true"]\n    logging:\n      driver: json-file\n      options:\n        max-size: "10m"\n        max-file: "3"\n',
  );
  assert.equal(services.length, 1);
  assert.equal(services[0]?.line, 2);
  assert.equal(services[0]?.hasMemLimit, true);
  assert.equal(services[0]?.hasPidsLimit, true);
  assert.equal(services[0]?.hasHealthcheck, true);
  assert.equal(services[0]?.hasLogMaxSize, true);
  assert.equal(services[0]?.hasLogMaxFile, true);
  assert.equal(redactEvidence('DATABASE_URL=postgres://app:segredo123@db.local:5432/app').includes('segredo123'), false);
});

test('normalizadores e runCollector reportam cobertura, achados, skipped offline e falha de ferramenta', () => {
  assert.throws(() => validateTargetUrl('https://user:pass@example.com'));
  assert.throws(() => validateTargetUrl('ftp://example.com'));
  assert.throws(() => validateTargetUrl('http://localhost/var/run/docker.sock'));
  assert.equal(validateTargetUrl('https://app.example.com')?.origin, 'https://app.example.com');

  const gl = parseGitleaksJson(JSON.stringify([{
    RuleID: 'generic-api-key',
    Description: 'Detected API key',
    StartLine: 3,
    File: '/repo/.env',
    Secret: 'my-secret-value-12345',
  }]), '/repo', 'package.json');
  assert.equal(gl.length, 1);
  assert.equal(gl[0]?.file, '.env');
  assert.equal(gl[0]?.line, 3);
  assert.equal(JSON.stringify(gl).includes('my-secret-value-12345'), false);

  const hl = parseHadolintJson(JSON.stringify([{
    line: 4,
    code: 'DL3002',
    message: 'Last USER should not be root',
    file: '/repo/Dockerfile',
    level: 'warning',
  }]), '/repo', 'package.json');
  assert.equal(hl[0]?.file, 'Dockerfile');
  assert.equal(hl[0]?.severity, 'media');

  const tr = parseTrivyConfigJson(JSON.stringify({
    Results: [{
      Target: 'Dockerfile',
      Misconfigurations: [{
        ID: 'DS026',
        AVDID: 'AVD-DS-0026',
        Title: 'No HEALTHCHECK defined',
        Severity: 'LOW',
        Status: 'FAIL',
        CauseMetadata: {StartLine: 1},
      }],
    }],
  }), '/repo', 'package.json');
  assert.equal(tr.findings.length, 1);
  assert.equal(tr.findings[0]?.severity, 'baixa');
  assert.equal(tr.findings[0]?.line, 1);

  const ts = parseTestsslJson(JSON.stringify([
    {id: 'TLS1', ip: '127.0.0.1', port: '443', severity: 'HIGH', finding: 'TLS 1.0 offered'},
    {id: 'TLS1_3', ip: '127.0.0.1', port: '443', severity: 'OK', finding: 'offered'},
    {id: 'HSTS', ip: '127.0.0.1', port: '443', severity: 'MEDIUM', finding: 'No HSTS header'},
  ]), cleanDir, 'deploy/caddy/site.caddy');
  assert.equal(ts.length, 2);
  assert.equal(ts[0]?.severity, 'alta');
  assert.equal(ts[1]?.severity, 'media');

  // Simula execução completa com stubs determinísticos (e uma ferramenta falhando)
  const out = runCollector({
    repoRoot: defectiveDir,
    hasExternalNetwork: false,
    targetUrl: 'https://prod.example.com',
    runBin(bin, args) {
      if (args[0] === 'version') return {status: 0, stdout: '8.30.1\n', stderr: ''};
      if (args[0] === '--version') {
        if (bin === 'hadolint') return {status: 0, stdout: 'Haskell Dockerfile Linter 2.15.1\n', stderr: ''};
        if (bin === 'trivy') return {status: 0, stdout: 'Version: 0.76.2\n', stderr: ''};
        if (bin === 'testssl.sh') return {status: 0, stdout: 'testssl.sh version 3.2.5\n', stderr: ''};
      }
      if (bin === 'gitleaks') {
        const reportPath = args[args.indexOf('--report-path') + 1]!;
        writeFileSync(reportPath, '[]\n');
        return {status: 0, stdout: '', stderr: ''};
      }
      if (bin === 'hadolint') {
        return {status: 0, stdout: JSON.stringify([{line: 4, code: 'DL3002', message: 'Last USER should not be root', file: join(defectiveDir, 'Dockerfile'), level: 'warning'}]), stderr: ''};
      }
      if (bin === 'trivy') {
        return {status: 1, stdout: '', stderr: 'trivy crash simulated'};
      }
      return {status: 0, stdout: '', stderr: ''};
    },
  });

  for (const row of out.coverage) {
    assert.equal(VALID_STATUSES.has(row.status), true);
    assert.ok(row.version.length > 0);
    assert.ok(row.detail.length > 0);
  }
  const trivyRow = out.coverage.find(c => c.tool === 'trivy');
  assert.equal(trivyRow?.status, 'failed');
  const testsslRow = out.coverage.find(c => c.tool === 'testssl.sh');
  assert.equal(testsslRow?.status, 'skipped');
  assert.ok(out.coverage.some(c => c.tool === 'gitleaks' && c.status === 'ok'));
  assert.ok(out.coverage.some(c => c.tool === 'hadolint' && c.status === 'ok'));
});

test('nginx com TLS legado e backup em /tmp são detectados sem executar scripts do repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prontidao-nginx-'));
  try {
    mkdirSync(join(dir, 'deploy', 'nginx'), {recursive: true});
    mkdirSync(join(dir, 'scripts'), {recursive: true});
    writeFileSync(join(dir, 'package.json'), '{"name":"ngx","version":"1.0.0"}\n');
    writeFileSync(
      join(dir, 'deploy', 'nginx', 'site.conf'),
      'server {\n  listen 443 ssl;\n  ssl_protocols TLSv1 TLSv1.1 TLSv1.2;\n}\n',
    );
    writeFileSync(
      join(dir, 'scripts', 'backup.sh'),
      '#!/bin/sh\npg_dump -Fc -f /tmp/backup.dump "$DATABASE_URL"\n',
    );
    const res = auditRepositoryReadiness(dir);
    const rules = new Set(res.findings.map(f => f.rule));
    assert.equal(rules.has('PRONTIDAO-TLS-PROTOCOLO-FRACO'), true);
    assert.equal(rules.has('PRONTIDAO-CABECALHO-HSTS-AUSENTE'), true);
    assert.equal(rules.has('PRONTIDAO-BACKUP-DESTINO-INSEGURO'), true);
    assert.equal(rules.has('PRONTIDAO-PROVA-RESTAURACAO-AUSENTE'), true);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
