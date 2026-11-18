import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {designBenchWorker} from '../src/design-bench.ts';
import {readRebuildImagePin} from '../src/design-image-run.ts';
import {runDesignModule, type DesignModuleInput} from '../src/design-module.ts';
import type {DesignWorker} from '../src/design-types.ts';

const enabled = process.env.AC_DESIGN_LAB === '1';

function harness(): Pick<DesignModuleInput, 'worker' | 'reserve' | 'release'> {
  const bench = designBenchWorker();
  const worker: DesignWorker = {async run(call) { return bench.run(call); }};
  return {
    worker,
    reserve: async role => ({
      provider: 'claude',
      model: role,
      accountId: randomUUID(),
      profileId: randomUUID(),
      grantId: randomUUID(),
    }),
    release: async () => {},
  };
}

function docker(args: readonly string[]): void {
  const result = spawnSync('docker', args, {encoding: 'utf8', timeout: 120_000});
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'docker falhou');
}

test('--servir entrega três HTML e o exame lê design-servir.local', {skip: !enabled}, async () => {
  const pin = readRebuildImagePin(await readFile(new URL('../deploy/design-image-digest.txt', import.meta.url), 'utf8'));
  const root = await mkdtemp(join(tmpdir(), 'design-servir-'));
  const name = `ac-design-servir-${randomUUID().slice(0, 8)}`;
  const pages = [
    {path: 'index.html', route: '/', text: 'Pagina inicial do servir'},
    {path: 'painel.html', route: '/painel.html', text: 'Painel estatico do servir'},
    {path: 'item/detalhe.html', route: '/item/detalhe.html', text: 'Detalhe estatico do servir'},
  ];
  try {
    await mkdir(join(root, 'item'), {mode: 0o755});
    await mkdir(join(root, 'node_modules'), {mode: 0o755});
    await chmod(root, 0o755);
    for (const page of pages) {
      const path = join(root, page.path);
      await writeFile(path, `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><title>${page.text}</title><style>body{margin:0}</style></head><body><h1>${page.text}</h1></body></html>\n`, {mode: 0o644});
      await chmod(path, 0o644);
    }
    await writeFile(join(root, 'node_modules', 'skip.html'), '<!DOCTYPE html><p>nao examinar</p>\n', {mode: 0o644});
    docker(['rm', '-f', name]);
    docker([
      'run', '-d', '--name', name,
      '--network', 'design-homologation',
      '--network-alias', 'design-servir.local',
      '--user', '65532:65532',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '64',
      '--memory', '256m',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
      '--env', 'HOME=/tmp',
      '--env', 'TMPDIR=/tmp',
      '--env', 'DESIGN_STATIC_ROOT=/srv',
      '--entrypoint', 'node',
      '--pull', 'never',
      '--mount', `type=bind,source=${root},destination=/srv,readonly`,
      pin,
      '/opt/design-tools/serve-static.mjs',
    ]);
    const probe = spawnSync('docker', [
      'run', '--rm', '--pull', 'never', '--network', 'design-homologation', '--entrypoint', 'node', pin,
      '-e', `const pages=${JSON.stringify(pages.map(page => ({route: page.route, text: page.text})))};
        (async () => {
          const out = [];
          for (const page of pages) {
            const response = await fetch('http://design-servir.local:8080' + page.route);
            const body = await response.text();
            if (!response.ok || !body.includes(page.text)) throw new Error(page.route + ' ' + response.status);
            out.push(response.status + ' ' + page.route);
          }
          const post = await fetch('http://design-servir.local:8080/', {method: 'POST'});
          const head = await fetch('http://design-servir.local:8080/painel.html', {method: 'HEAD'});
          const escape = await fetch('http://design-servir.local:8080/%2e%2e/secret');
          if (post.status !== 405) throw new Error('post ' + post.status);
          if (head.status !== 200) throw new Error('head ' + head.status);
          if (escape.status !== 404) throw new Error('escape ' + escape.status);
          console.log(out.join('\\n'));
        })().catch(error => { console.error(error); process.exit(1); });`,
    ], {encoding: 'utf8', timeout: 60_000});
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.match(probe.stdout, /Pagina inicial|200 \//);
    const files = pages.map(page => ({path: page.path, text: page.text}));
    const data = await mkdtemp(join(tmpdir(), 'design-servir-exam-'));
    try {
      const result = await runDesignModule({
        activation: 'personal',
        projectId: randomUUID(),
        repo: root,
        targetUrl: 'http://design-servir.local:8080',
        dataDirectory: data,
        intentId: randomUUID(),
        runId: randomUUID(),
        createdAt: new Date('2026-11-18T19:00:00.000Z'),
        commit: 'servir',
        files,
        ...harness(),
        image: {pinnedImage: pin, timeoutMs: 1_800_000},
        scoreVisual: false,
        recordStates: false,
        routes: pages.map(page => ({route: page.route})),
      });
      const coverage = await readFile(join(result.directory, 'cobertura-ferramentas.md'), 'utf8');
      const image = JSON.parse(await readFile(join(result.directory, 'imagem-achados-brutos.json'), 'utf8')) as {
        screenshots?: {route?: string}[];
        notes?: string[];
      };
      const shots = image.screenshots ?? [];
      for (const page of pages) assert.equal(shots.some(item => item.route === page.route), true, coverage);
      assert.equal(shots.some(item => String(item.route).includes('skip.html')), false);
      assert.match(coverage, /0 arquivos do repositório, \d+ blocos de página/);
      assert.match(coverage, /design-servir|axe-core/);
      console.log(JSON.stringify({coverage, routes: [...new Set(shots.map(item => item.route))]}));
    } finally {
      await rm(data, {recursive: true, force: true});
    }
  } finally {
    spawnSync('docker', ['rm', '-f', name], {encoding: 'utf8', timeout: 30_000});
    await rm(root, {recursive: true, force: true});
  }
});
