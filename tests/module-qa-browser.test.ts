import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  assertBrowserFixture, changedPng, hostRenderer, imageRenderer, referenceMetadata, referencePng, stageBrowserFixture, type BrowserOutput,
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

function addPageLimitFixtures(directory: string, count: number) {
  for (let i = 1; i <= count; i++) {
    writeFileSync(join(directory, 'public', `zz-${i}.html`), '<!doctype html><html lang="pt-BR"><title>Limite</title><p>Amostra</p></html>');
  }
}

function assertPageBeyondLimit(report: BrowserOutput, file: string) {
  for (const tool of ['qa-navegador', 'qa-contraste', 'qa-regressao-visual']) {
    const coverage = row(report, `${tool}:public/${file}`);
    assert.equal(coverage.status, 'skipped');
    assert.match(coverage.detail, /fora do limite de 12 páginas/);
  }
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
  const metadata = referenceMetadata(imageRenderer);
  assert.equal(compatibleReference(metadata, metadata), true);
  for (const [key, value] of Object.entries({width: 799, deviceScaleFactor: 2, chromium: '0.0.0',
    renderer: hostRenderer, presentation: 'chromium-headless-css-light-reduced-motion-pt-BR-UTC-v1'})) {
    assert.equal(compatibleReference({...metadata, [key]: value}, metadata), false, key);
  }
});

test('coletor no host preserva o axe estático e declara o Chromium ausente', toolOptions, () => {
  const directory = stageBrowserFixture(hostRenderer);
  const emptyCache = mkdtempSync(join(tmpdir(), 'qa-sem-chromium-'));
  try {
    addPageLimitFixtures(directory, 9);
    const report = collect(directory, emptyCache);
    assert.equal(row(report, 'axe-core').status, 'ok');
    assert.equal(row(report, 'qa-navegador').status, 'skipped');
    assert.match(row(report, 'qa-navegador').detail, /Chromium 159\.0\.8154\.6 indisponível.*0\/13.*1 fora do limite de 12/);
    assert.match(row(report, 'qa-navegador:public/zz-8.html').detail, /indisponível/);
    assertPageBeyondLimit(report, 'zz-9.html');
    assert.match(row(report, 'qa-contraste:public/defeito.html').detail, /indisponível/);
    assert.match(row(report, 'qa-regressao-visual:public/defeito.html').detail, /sem referência versionada/);
    assert.match(row(report, 'qa-regressao-visual:public/visual-defeito.html').detail, /renderização indisponível/);
    assert.ok(report.findings.every(finding => !/QA-AXE-COLOR-CONTRAST|QA-REGRESSAO-VISUAL/.test(finding.rule)));
  } finally {
    rmSync(directory, {recursive: true, force: true});
    rmSync(emptyCache, {recursive: true, force: true});
  }
});

test('coletor delimita a renderização local e restringe a regressão visual ao perfil de imagem', toolOptions, t => {
  const directory = stageBrowserFixture(imageRenderer);
  const publicDir = join(directory, 'public');
  const html = (extraHead: string, body: string) =>
    `<!doctype html><html lang="pt-BR"><head><title>Controle</title>${extraHead}</head><body><main>${body}</main></body></html>`;
  const reference = (file: string, metadata = referenceMetadata(imageRenderer)) => {
    writeFileSync(join(publicDir, `${file}.qa-visual.png`), referencePng);
    writeFileSync(join(publicDir, `${file}.qa-visual.json`), JSON.stringify(metadata));
  };
  try {
    writeFileSync(join(publicDir, 'incompativel.html'), html('', '<p>Controle de viewport</p>'));
    reference('incompativel.html', referenceMetadata(hostRenderer));
    writeFileSync(join(publicDir, 'sem-estilo.html'), html('<link rel="stylesheet" href="ausente.css">', '<p>Controle</p>'));
    reference('sem-estilo.html');
    writeFileSync(join(publicDir, 'recurso-externo.html'), html(
      '<link rel="stylesheet" href="https://fora-do-snapshot.invalid/tema.css">', '<p>Controle</p>',
    ));
    writeFileSync(join(publicDir, 'local.png'), referencePng);
    writeFileSync(join(publicDir, 'recurso-local.html'), html('', '<p>Controle</p><img src="local.png" alt="Amostra de cor">'));
    writeFileSync(join(publicDir, 'muitos-recursos.html'), html(Array.from({length: 50}, (_, i) =>
      `<link rel="stylesheet" href="../styles/base.css?v=${i}">`).join(''), '<p>Controle de limite</p>'));
    addPageLimitFixtures(directory, 4);

    const report = collect(directory);
    if (/Chromium .*indisponível/.test(row(report, 'qa-navegador').detail)) {
      t.skip(row(report, 'qa-navegador').detail);
      return;
    }
    assertBrowserFixture(report, {compareVisual: false});
    assert.equal(row(report, 'qa-navegador:public/recurso-local.html').status, 'ok');
    assert.equal(row(report, 'qa-regressao-visual:public/incompativel.html').status, 'skipped');
    assert.match(row(report, 'qa-regressao-visual:public/incompativel.html').detail, /exige o perfil da imagem OCI fixada/);
    assert.match(row(report, 'qa-regressao-visual:public/sem-estilo.html').detail, /renderização parcial/);
    for (const file of ['sem-estilo.html', 'recurso-externo.html', 'muitos-recursos.html']) {
      assert.equal(row(report, `qa-navegador:public/${file}`).status, 'skipped');
      assert.match(row(report, `qa-navegador:public/${file}`).detail, /renderização parcial: [1-9]\d* bloqueios/);
      assert.equal(row(report, `qa-contraste:public/${file}`).status, 'skipped');
    }
    assert.match(row(report, 'qa-navegador').detail, /9\/13.*3 parciais, 0 indisponíveis, 1 fora do limite de 12/);
    assert.equal(row(report, 'qa-navegador:public/zz-3.html').status, 'ok');
    assertPageBeyondLimit(report, 'zz-4.html');
    assert.deepEqual(readFileSync(join(publicDir, 'visual-defeito.html.qa-visual.png')), referencePng);
    assert.deepEqual(JSON.parse(readFileSync(join(publicDir, 'visual-defeito.html.qa-visual.json'), 'utf8')), referenceMetadata(imageRenderer));
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('Chromium preserva ordem, doctype e codificações, atribui Shadow DOM e registra PNG inválido em CSS', toolOptions, t => {
  const directory = mkdtempSync(join(tmpdir(), 'qa-browser-fidelidade-'));
  const page = (head: string, body: string, doctype = '<!doctype html>') =>
    `${doctype}\n<html lang="pt-BR"><head><title>Controle</title>${head}</head>\n<body>\n${body}\n</body></html>`;
  try {
    writeFileSync(join(directory, 'ordem.html'), page(
      '<meta charset="utf-8"><style>p { color:#aaa } main > p:first-child { color:#111 }</style>',
      '<main>\n<script type="application/json">{"controle":true}</script>\n<p id="ordem">Texto da amostra</p>\n</main>',
    ));
    // Em quirks mode, o seletor de classe é insensível a maiúsculas.
    writeFileSync(join(directory, 'doctype.html'), page(
      '<style>.AMOSTRA { color:#aaa }</style>', '<p class="amostra" id="quirks">Texto da amostra</p>',
      '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">',
    ));
    const legacy = page(
      '<meta http-equiv="content-type" content="text/html; charset=windows-1252"><link rel="stylesheet" href="legado.css">',
      '<p class="ação" id="legado" title="ação e café">Texto da amostra</p>',
    );
    writeFileSync(join(directory, 'legado.html'), Buffer.from(legacy, 'latin1'));
    writeFileSync(join(directory, 'legado.css'), Buffer.from('@charset "windows-1252"; .ação { color:#aaa }', 'latin1'));
    writeFileSync(join(directory, 'charset-css.html'), page(
      '<meta charset="utf-8"><link rel="stylesheet" href="legado.css">',
      '<p class="ação" id="charset-css">Texto da amostra</p>',
    ));
    const utf16 = page('<link rel="stylesheet" href="utf16.css">', '<p class="ação" id="utf16">Texto da amostra</p>');
    writeFileSync(join(directory, 'utf16.html'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16, 'utf16le')]));
    writeFileSync(join(directory, 'utf16.css'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('.ação { color:#aaa }', 'utf16le')]));
    writeFileSync(join(directory, 'shadow.html'), page('<meta charset="utf-8">', [
      '<main id="host">',
      '<template shadowrootmode="open">',
      '<style>p { color:#aaa }</style>',
      '<p id="shadow">Texto da amostra</p>',
      '<div id="interno"><template shadowrootmode="open">',
      '<p id="shadow-interno" style="color:#aaa">Texto da amostra interna</p>',
      '</template></div><slot></slot>',
      '</template>',
      '<p id="light" style="color:#aaa">Texto no DOM principal</p>',
      '</main>',
    ].join('\n')));
    const idat = referencePng.indexOf('IDAT') - 4;
    const idatEnd = idat + 12 + referencePng.readUInt32BE(idat);
    writeFileSync(join(directory, 'invalido.png'), Buffer.concat([referencePng.subarray(0, idat), referencePng.subarray(idatEnd)]));
    writeFileSync(join(directory, 'invalido.html'), page(
      '<style>body { background-image:url(invalido.png) }</style>', '<p>Texto da amostra</p>',
    ));
    writeFileSync(join(directory, 'valido.png'), referencePng);
    writeFileSync(join(directory, 'valido.html'), page(
      '<style>body { background-image:url(valido.png) }</style>', '<p>Texto da amostra</p>',
    ));
    writeFileSync(join(directory, 'refresh.html'), page(
      '<meta http-equiv="refresh" content="0;url=ordem.html">', '<p>Texto anterior ao redirecionamento</p>',
    ));

    const report = collect(directory);
    if (/Chromium .*indisponível/.test(row(report, 'qa-navegador').detail)) {
      t.skip(row(report, 'qa-navegador').detail);
      return;
    }
    for (const file of ['ordem', 'doctype', 'legado', 'charset-css', 'utf16', 'shadow']) {
      assert.equal(row(report, `qa-navegador:${file}.html`).status, 'ok');
      assert.equal(row(report, `qa-contraste:${file}.html`).status, 'ok');
    }
    const contrast = report.findings.filter(finding => finding.rule === 'QA-AXE-COLOR-CONTRAST');
    assert.deepEqual(contrast.map(({file, line}) => [file, line]), [
      ['charset-css.html', 4], ['doctype.html', 4], ['legado.html', 4], ['ordem.html', 6],
      ['shadow.html', 7], ['shadow.html', 9], ['shadow.html', 12], ['utf16.html', 4],
    ]);
    assert.match(contrast.find(finding => finding.file === 'legado.html')?.evidence ?? '', /title="ação e café"/);
    assert.equal(row(report, 'qa-navegador:invalido.html').status, 'skipped');
    assert.match(row(report, 'qa-navegador:invalido.html').detail, /renderização parcial: [1-9]\d* bloqueios/);
    assert.equal(row(report, 'qa-contraste:invalido.html').status, 'skipped');
    assert.equal(row(report, 'qa-navegador:valido.html').status, 'ok');
    assert.match(row(report, 'qa-navegador:refresh.html').detail, /meta refresh fora do escopo/);
    assert.equal(row(report, 'qa-contraste:refresh.html').status, 'skipped');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
