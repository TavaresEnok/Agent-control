import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {Refusal} from '../src/contracts.ts';
import {designBenchWorker} from '../src/design-bench.ts';
import {type DesignCaptureDriver} from '../src/design-capture.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import {DESIGN_PLANTED_RULES, type DesignWorker} from '../src/design-types.ts';

const labRoot = fileURLToPath(new URL('./fixtures/design-lab/', import.meta.url));

const planted: {relative: string; rule: string}[] = [
  {relative: 'html/contraste.html', rule: DESIGN_PLANTED_RULES.contrast},
  {relative: 'html/botao.html', rule: DESIGN_PLANTED_RULES.unlabeledButton},
  {relative: 'css/foco.css', rule: DESIGN_PLANTED_RULES.invisibleFocus},
  {relative: 'css/cinzas.css', rule: DESIGN_PLANTED_RULES.grays},
  {relative: 'css/espaco.css', rule: DESIGN_PLANTED_RULES.spacing},
  {relative: 'src/Itens.tsx', rule: DESIGN_PLANTED_RULES.empty},
  {relative: 'css/estreito.css', rule: DESIGN_PLANTED_RULES.narrow},
  {relative: 'css/cortado.css', rule: DESIGN_PLANTED_RULES.truncated},
];

const clean = [
  'html/boa-inicio.html',
  'html/boa-detalhe.html',
  'css/boa.css',
  'src/BoaInicio.tsx',
  'src/BoaDetalhe.tsx',
];

function labFiles(): {path: string; text: string}[] {
  const out: {path: string; text: string}[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else out.push({path, text: readFileSync(path, 'utf8')});
    }
  };
  walk(labRoot);
  return out;
}

function harness(sameProvider = false): Pick<DesignModuleInput, 'worker' | 'reserve' | 'release'> {
  const bench = designBenchWorker();
  const specialist = {provider: 'claude', model: 'especialista', accountId: randomUUID(), profileId: randomUUID()};
  const reviewer = {
    provider: sameProvider ? 'claude' : 'grok',
    model: 'revisor',
    accountId: randomUUID(),
    profileId: randomUUID(),
  };
  const worker: DesignWorker = {async run(call) { return bench.run(call); }};
  return {
    worker,
    reserve: async role => {
      const base = role === 'reviewer' ? reviewer : specialist;
      return {...base, grantId: randomUUID()};
    },
    release: async () => {},
  };
}

function request(dataDirectory: string, extra: Partial<DesignModuleInput> = {}): DesignModuleInput {
  return {
    activation: 'personal',
    projectId: randomUUID(),
    repo: labRoot,
    targetUrl: 'http://127.0.0.1:4173',
    dataDirectory,
    intentId: randomUUID(),
    runId: randomUUID(),
    createdAt: new Date('2026-11-17T03:04:05.000Z'),
    commit: 'abc123',
    files: labFiles(),
    ...harness(),
    ...extra,
  };
}

test('a régua confirmada entra no relatório e as telas corretas ficam sem alta', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-mod-'));
  try {
    const result = await runDesignModule(request(data));
    assert.equal(result.directoryName, '20261117-030405-design');
    assert.match(result.coverageMarkdown, /Cobertura/);
    for (const item of planted) {
      const hit = result.achados.find(achado => achado.reference === item.rule && achado.where.file.endsWith(item.relative));
      assert.ok(hit, item.relative);
      assert.equal(hit?.severity, 'alta');
      assert.equal(hit?.status, 'confirmado');
      assert.equal(hit?.verifier?.provider, 'grok');
    }
    for (const relative of clean) {
      const dirty = result.achados.some(achado => achado.where.file.endsWith(relative) && achado.severity === 'alta' && achado.status === 'confirmado');
      assert.equal(dirty, false, relative);
    }
    const rawContrast = result.findings.find(item => item.rule === DESIGN_PLANTED_RULES.contrast);
    assert.equal(rawContrast?.tool, 'axe');
    assert.equal(rawContrast?.cwe, null);
    assert.equal(rawContrast?.fingerprint.length, 64);
    const readme = readFileSync(join(result.directory, 'README.md'), 'utf8');
    assert.match(readme, /Nota de falha/);
    assert.equal(readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8').includes('design-achados-brutos-1'), true);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('ativação que não é personal e URL externa não gravam relatório', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-mod-'));
  try {
    await assert.rejects(runDesignModule(request(data, {activation: 'locked'})), (error: unknown) => error instanceof Refusal && error.code === 'PERSONAL_ACTIVATION_REQUIRED');
    await assert.rejects(runDesignModule(request(data, {targetUrl: 'https://example.com'})), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_EXTERNAL_TARGET');
    await assert.rejects(runDesignModule(request(data, {runId: 'nao-e-uuid'})), (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_MODULE_INVALID');
    assert.equal(readdirSync(data).length, 0);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('o mesmo provedor recusa e a senha de teste não entra no relatório', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-mod-'));
  const password = 'senha-efemera-da-regua';
  try {
    await assert.rejects(
      runDesignModule(request(data, harness(true))),
      (error: unknown) => error instanceof Refusal && error.code === 'DESIGN_PROVIDER_MUST_DIFFER',
    );
    const seen: string[] = [];
    const driver: DesignCaptureDriver = {
      async setViewport() {},
      async emulateMedia() {},
      async goto(url) { seen.push(url); },
      async screenshot() { return Buffer.from('png-falso'); },
      async content() { return '<p>ok</p>'; },
      async fill() {},
      async click() {},
    };
    const result = await runDesignModule(request(data, {
      login: {
        username: 'pessoa',
        password,
        usernameSelector: '#user',
        passwordSelector: '#pass',
        submitSelector: '#go',
      },
      driver,
    }));
    const dumped = readFileSync(join(result.directory, 'mapa.md'), 'utf8')
      + readFileSync(join(result.directory, 'bruto', 'achados-brutos.json'), 'utf8')
      + readFileSync(join(result.directory, 'README.md'), 'utf8');
    assert.equal(dumped.includes(password), false);
    assert.equal(seen.some(url => url.includes(password)), false);
    assert.ok(seen.length >= 3);
    assert.equal(existsSync(join(labRoot, '.design-captures')), false);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});

test('a captura fica no disco enquanto o worker corre e some depois', async () => {
  const data = await mkdtemp(join(tmpdir(), 'design-mod-'));
  const seen: {role: string; path: string; present: boolean; sha: string}[] = [];
  try {
    const kit = harness();
    await runDesignModule(request(data, {
      repo: data,
      driver: {
        async setViewport() {},
        async emulateMedia() {},
        async goto() {},
        async screenshot() { return Buffer.from('png-da-tela'); },
        async content() { return '<p>ok</p>'; },
      },
      worker: {
        async run(call) {
          const match = call.task.match(/arquivo=(\S+) viewport=\d+ tema=(?:claro|escuro) estado=\S+ sha256=([a-f0-9]{64})/);
          if (call.task.includes('Capturas:')) {
            assert.match(call.task, /\/work/);
            assert.match(call.task, /Abra o PNG no caminho e olhe a imagem/);
            assert.ok(match?.[1]);
            seen.push({role: call.role, path: match?.[1] ?? '', present: existsSync(match?.[1] ?? ''), sha: match?.[2] ?? ''});
            const file = call.task.match(/^Arquivos:\n- (.+)$/m)?.[1] ?? 'tela';
            if (call.role === 'reviewer') {
              return JSON.stringify({kind: 'confirmacao', status: 'descartado', reason: 'a imagem não sustenta o ponto', proof: 'png aberto'});
            }
            return JSON.stringify({
              kind: 'exame',
              filesRead: [file],
              checklist: ['DESIGN-NIELSEN-H1-ESTADO'],
              findings: [{
                title: 'Captura vista',
                severity: 'baixa',
                file,
                line: 1,
                scenario: 'A imagem foi aberta no caminho citado.',
                suggestion: 'Manter o texto legível.',
                cwe: null,
                reference: 'DESIGN-VISUAL',
                snippet: 'png',
              }],
            });
          }
          return kit.worker.run(call);
        },
      },
      reserve: kit.reserve,
      release: kit.release,
    }));
    const specialist = seen.find(item => item.role === 'specialist');
    const reviewer = seen.find(item => item.role === 'reviewer');
    assert.ok(specialist);
    assert.ok(reviewer);
    assert.equal(specialist.present, true);
    assert.equal(reviewer.present, true);
    assert.equal(reviewer.path, specialist.path);
    assert.equal(reviewer.sha, specialist.sha);
    assert.equal(specialist.sha.length, 64);
    assert.equal(existsSync(join(data, '.design-captures')), false);
  } finally {
    await rm(data, {recursive: true, force: true});
  }
});
