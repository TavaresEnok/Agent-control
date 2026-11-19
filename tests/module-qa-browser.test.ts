import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  assertBrowserFixture, changedPng, hostRenderer, referenceMetadata, referencePng, stageBrowserFixture, type BrowserOutput,
} from './fixtures/module-qa-browser.ts';

const qaDir = fileURLToPath(new URL('../deploy/modules/qa/', import.meta.url));
const tools = ['axe-core', 'jsdom', 'parse5', 'playwright-core', 'pngjs'];
const toolOptions = {
  skip: tools.every(tool => existsSync(join(qaDir, 'node_modules', tool, 'package.json')))
    ? false : 'instale os pacotes fixados em deploy/modules/qa',
};

function collect(directory: string, browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH): BrowserOutput {
  const env = {...process.env, QA_HOST_TEST_MODE: '1', QA_REPO_DIR: directory};
  const result = spawnSync('/bin/sh', [join(qaDir, 'entrypoint.sh')], {
    encoding: 'utf8', timeout: 45000, env: browsersPath === undefined ? env : {...env, PLAYWRIGHT_BROWSERS_PATH: browsersPath},
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const report = JSON.parse(result.stdout) as BrowserOutput;
  assert.deepEqual(report.coverage.filter(row => row.status === 'failed'), []);
  return report;
}

function row(report: BrowserOutput, tool: string) {
  const result = report.coverage.find(item => item.tool === tool);
  assert.ok(result, tool);
  return result;
}

test('comparação RGBA exige viewport, perfil e PNG dentro dos limites', toolOptions, async () => {
  const {compareVisualPng, compatibleReference, staticPngSize} = await import(
    new URL('../deploy/modules/qa/visual-reference.mjs', import.meta.url).href
  );
  const viewport = {width: 800, height: 600};
  assert.deepEqual(compareVisualPng(referencePng, referencePng, viewport), {changed: 0, total: 480000, bounds: null});
  assert.deepEqual(compareVisualPng(referencePng, changedPng, viewport), {changed: 200, total: 480000, bounds: '30,40–39,59'});
  assert.throws(() => compareVisualPng(referencePng, changedPng, {...viewport, height: 601}), /QA_VISUAL_PNG_INCOMPATIBLE/);
  const tooWide = Buffer.from(referencePng);
  tooWide.writeUInt32BE(1601, 16);
  assert.equal(staticPngSize(tooWide), undefined);
  assert.equal(staticPngSize(referencePng.subarray(0, -1)), undefined);
  const metadata = referenceMetadata(hostRenderer);
  assert.equal(compatibleReference(metadata, metadata), true);
  for (const [key, value] of Object.entries({width: 799, deviceScaleFactor: 2, chromium: '0.0.0', renderer: 'outro', presentation: 'outro'})) {
    assert.equal(compatibleReference({...metadata, [key]: value}, metadata), false, key);
  }
});

test('coletor no host preserva o axe estático e declara o Chromium ausente', toolOptions, () => {
  const directory = stageBrowserFixture(hostRenderer);
  const emptyCache = mkdtempSync(join(tmpdir(), 'qa-sem-chromium-'));
  try {
    const report = collect(directory, emptyCache);
    assert.equal(row(report, 'axe-core').status, 'ok');
    assert.equal(row(report, 'qa-navegador').status, 'skipped');
    assert.match(row(report, 'qa-navegador').detail, /Chromium 159\.0\.8154\.6 indisponível/);
    assert.match(row(report, 'qa-contraste:public/defeito.html').detail, /indisponível/);
    assert.match(row(report, 'qa-regressao-visual:public/defeito.html').detail, /sem referência versionada/);
    assert.match(row(report, 'qa-regressao-visual:public/visual-defeito.html').detail, /renderização indisponível/);
    assert.ok(report.findings.every(finding => !/QA-AXE-COLOR-CONTRAST|QA-REGRESSAO-VISUAL/.test(finding.rule)));
  } finally {
    rmSync(directory, {recursive: true, force: true});
    rmSync(emptyCache, {recursive: true, force: true});
  }
});

test('coletor renderiza HTML e CSS locais, localiza contraste e compara pixels da fixture fixa', toolOptions, t => {
  const directory = stageBrowserFixture(hostRenderer);
  const publicDir = join(directory, 'public');
  const html = (extraHead: string, body: string) =>
    `<!doctype html><html lang="pt-BR"><head><title>Controle</title>${extraHead}</head><body><main>${body}</main></body></html>`;
  const reference = (file: string, metadata = referenceMetadata(hostRenderer)) => {
    writeFileSync(join(publicDir, `${file}.qa-visual.png`), referencePng);
    writeFileSync(join(publicDir, `${file}.qa-visual.json`), JSON.stringify(metadata));
  };
  try {
    writeFileSync(join(publicDir, 'incompativel.html'), html('', '<p>Controle de viewport</p>'));
    reference('incompativel.html', {...referenceMetadata(hostRenderer), width: 640});
    writeFileSync(join(publicDir, 'sem-estilo.html'), html('<link rel="stylesheet" href="ausente.css">', '<p>Controle</p>'));
    reference('sem-estilo.html');
    writeFileSync(join(publicDir, 'recurso-externo.html'), html(
      '<link rel="stylesheet" href="https://fora-do-snapshot.invalid/tema.css">', '<p>Controle</p>',
    ));
    writeFileSync(join(publicDir, 'local.png'), referencePng);
    writeFileSync(join(publicDir, 'recurso-local.html'), html('', '<p>Controle</p><img src="local.png" alt="Amostra de cor">'));
    writeFileSync(join(publicDir, 'muitos-recursos.html'), html(Array.from({length: 50}, (_, i) =>
      `<link rel="stylesheet" href="../styles/base.css?v=${i}">`).join(''), '<p>Controle de limite</p>'));

    const report = collect(directory);
    if (/Chromium .*indisponível/.test(row(report, 'qa-navegador').detail)) {
      t.skip(row(report, 'qa-navegador').detail);
      return;
    }
    assertBrowserFixture(report);
    assert.equal(row(report, 'qa-navegador:public/recurso-local.html').status, 'ok');
    assert.equal(row(report, 'qa-regressao-visual:public/incompativel.html').status, 'skipped');
    assert.match(row(report, 'qa-regressao-visual:public/incompativel.html').detail, /incompatíveis/);
    assert.match(row(report, 'qa-regressao-visual:public/sem-estilo.html').detail, /renderização parcial/);
    for (const file of ['sem-estilo.html', 'recurso-externo.html', 'muitos-recursos.html']) {
      assert.equal(row(report, `qa-navegador:public/${file}`).status, 'skipped');
      assert.match(row(report, `qa-navegador:public/${file}`).detail, /renderização parcial: [1-9]\d* bloqueios/);
      assert.equal(row(report, `qa-contraste:public/${file}`).status, 'skipped');
    }
    assert.deepEqual(readFileSync(join(publicDir, 'visual-defeito.html.qa-visual.png')), referencePng);
    assert.deepEqual(JSON.parse(readFileSync(join(publicDir, 'visual-defeito.html.qa-visual.json'), 'utf8')), referenceMetadata(hostRenderer));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
